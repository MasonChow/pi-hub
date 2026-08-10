/**
 * End-to-end replay: a fake ExtensionAPI drives the full extension entry
 * through a realistic session timeline, with in-memory exporters injected
 * through PiOtelOptions.exporters. Everything is asserted after
 * session_shutdown — the batch processors only deliver on that flush.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attributes } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	type MetricData,
	type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
	InMemorySpanExporter,
	type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import type { Usage } from "@earendil-works/pi-ai";
import {
	ATTR_AI_MODEL,
	ATTR_AI_RESPONSE_STOP_REASON,
	ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS,
	ATTR_INTERVENTION_KIND,
	ATTR_PROJECT_PATH,
	ATTR_REQUIREMENT_ID,
	ATTR_SESSION_ID,
	ATTR_TOKEN_TYPE,
	ATTR_TURN_INDEX,
	ATTR_TURN_PHASE,
	SPAN_AI_REQUEST,
	SPAN_HARNESS_RUN,
	SPAN_HARNESS_TOOL,
	SPAN_HARNESS_TURN,
} from "../src/attrs.ts";
import {
	METRIC_COST_USD,
	METRIC_HUMAN_INTERVENTIONS,
	METRIC_LLM_TTFT,
	METRIC_TOKENS,
	METRIC_TOOL_DURATION,
	METRIC_TURN_DURATION,
	METRIC_TURN_PHASE_DURATION,
	METRIC_TURNS,
} from "../src/metrics.ts";
import { SPAN_SESSION } from "../src/traces.ts";
import { readStateFile, setRequirementForCwd } from "../src/state.ts";
import {
	createPiOtel,
	INTERVENTION_BUS_CHANNEL,
	type PiOtelHost,
} from "../src/index.ts";

type StoredHandler = (event: unknown, ctx: unknown) => unknown;

interface FakeHost {
	host: PiOtelHost;
	handlers: Map<string, StoredHandler[]>;
	commands: string[];
}

function createHost(): FakeHost {
	const handlers = new Map<string, StoredHandler[]>();
	const busListeners = new Map<string, Array<(data: unknown) => void>>();
	const commands: string[] = [];
	const host: PiOtelHost = {
		on(event: string, handler: (event: never, ctx: never) => unknown): void {
			const list = handlers.get(event) ?? [];
			list.push(handler as StoredHandler);
			handlers.set(event, list);
		},
		registerCommand(name) {
			commands.push(name);
		},
		events: {
			emit(channel, data) {
				for (const listener of busListeners.get(channel) ?? []) listener(data);
			},
			on(channel, handler) {
				const list = busListeners.get(channel) ?? [];
				list.push(handler);
				busListeners.set(channel, list);
				return () => {};
			},
		},
	};
	return { host, handlers, commands };
}

/** Minimal ExtensionContext stand-in; --no-session shape (no file, no header). */
function createCtx(cwd: string): Record<string, unknown> {
	return {
		cwd,
		model: { id: "claude-test", provider: "anthropic" },
		thinkingLevel: "medium",
		sessionManager: {
			getSessionId: () => "sess-e2e",
			getSessionFile: () => undefined,
			getHeader: () => null,
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "All done." }],
					},
				},
			],
		},
		getContextUsage: () => ({ tokens: 8000, contextWindow: 200000, percent: 4 }),
	};
}

function assistantMessage(
	stopReason: string,
	usage: Usage,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text: "..." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason,
		usage,
		timestamp: Date.now(),
	};
}

const usage1: Usage = {
	input: 1000,
	output: 200,
	cacheRead: 300,
	cacheWrite: 50,
	reasoning: 40,
	totalTokens: 1550,
	cost: { input: 0.01, output: 0.006, cacheRead: 0.0009, cacheWrite: 0.0005, total: 0.0174 },
};
const usage2: Usage = {
	input: 500,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 520,
	cost: { input: 0.005, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0056 },
};
const compactionUsage: Usage = {
	input: 2000,
	output: 400,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2400,
	cost: { input: 0.02, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.032 },
};

function metricByName(batch: ResourceMetrics, name: string): MetricData {
	for (const scope of batch.scopeMetrics) {
		for (const metric of scope.metrics) {
			if (metric.descriptor.name === name) return metric;
		}
	}
	assert.fail(`metric not exported: ${name}`);
}

function sumPoints(
	metric: MetricData,
	predicate: (attrs: Attributes) => boolean = () => true,
): number {
	let sum = 0;
	for (const point of metric.dataPoints) {
		if (typeof point.value === "number" && predicate(point.attributes)) {
			sum += point.value;
		}
	}
	return sum;
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan[] {
	return spans.filter((span) => span.name === name);
}

function parentSpanId(span: ReadableSpan): string | undefined {
	return span.parentSpanContext?.spanId;
}

test("full session replay through the extension entry", async (t) => {
	delete process.env["PI_REQUIREMENT_ID"];
	delete process.env["PI_OTEL_REQUIREMENT_BRANCH_REGEX"];
	delete process.env["OTEL_SDK_DISABLED"];
	delete process.env["PI_OTEL_DISABLED"];

	const dir = mkdtempSync(join(tmpdir(), "pi-otel-e2e-"));
	const stateFile = join(dir, "state.json");
	const cwd = join(dir, "project");
	setRequirementForCwd(cwd, "REQ-E2E", stateFile);

	const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const spanExporter = new InMemorySpanExporter();
	const logExporter = new InMemoryLogRecordExporter();

	const { host, handlers, commands } = createHost();
	createPiOtel({
		stateFilePath: stateFile,
		exporters: { metrics: metricExporter, traces: spanExporter, logs: logExporter },
	})(host);

	const ctx = createCtx(cwd);
	const fire = async (event: string, payload: Record<string, unknown>): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	};

	// --- replay (research §2.7 ordering) ---
	await fire("session_start", { type: "session_start", reason: "startup" });
	// First input is the task prompt — not an intervention.
	await fire("input", { type: "input", text: "build the feature", source: "interactive" });
	await fire("agent_start", { type: "agent_start" });

	// Turn 0: streamed response with full usage, then a tool call.
	await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	await fire("before_provider_request", { type: "before_provider_request", payload: {} });
	const assistant1 = assistantMessage("toolUse", usage1);
	await fire("message_start", { type: "message_start", message: assistant1 });
	await fire("message_update", {
		type: "message_update",
		message: assistant1,
		assistantMessageEvent: { type: "text_delta" },
	});
	await fire("message_end", { type: "message_end", message: assistant1 });
	await fire("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: {},
	});
	await fire("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "bash",
		result: {},
		isError: false,
	});
	await fire("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: assistant1,
		toolResults: [],
	});

	// Turn 1: the user steers mid-stream, then aborts the response.
	await fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
	await fire("before_provider_request", { type: "before_provider_request", payload: {} });
	const assistant2 = assistantMessage("aborted", usage2);
	await fire("message_start", { type: "message_start", message: assistant2 });
	await fire("message_update", {
		type: "message_update",
		message: assistant2,
		assistantMessageEvent: { type: "text_delta" },
	});
	await fire("input", {
		type: "input",
		text: "no, stop that",
		source: "interactive",
		streamingBehavior: "steer",
	});
	await fire("message_end", { type: "message_end", message: assistant2 });
	await fire("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: assistant2,
		toolResults: [],
	});

	await fire("agent_end", { type: "agent_end", messages: [] });
	await fire("agent_settled", { type: "agent_settled" });

	// Enterprise approval extension reporting through the shared bus.
	host.events.emit(INTERVENTION_BUS_CHANNEL, { kind: "approval" });

	await fire("session_compact", {
		type: "session_compact",
		compactionEntry: {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "",
			summary: "",
			firstKeptEntryId: "e1",
			tokensBefore: 150000,
			usage: compactionUsage,
		},
		fromExtension: false,
		reason: "threshold",
		willRetry: false,
	});

	// Nothing may have been exported yet: batch processors hold everything
	// until the shutdown flush.
	assert.equal(metricExporter.getMetrics().length, 0);

	await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

	const batches = metricExporter.getMetrics();
	assert.ok(batches.length > 0, "shutdown flush exported metrics");
	const batch = batches[batches.length - 1];
	const spans = spanExporter.getFinishedSpans();
	const logRecords = logExporter.getFinishedLogRecords();

	await t.test("span tree is complete with correct parentage", () => {
		const [session] = byName(spans, SPAN_SESSION);
		const [run] = byName(spans, SPAN_HARNESS_RUN);
		const turns = byName(spans, SPAN_HARNESS_TURN);
		const llms = byName(spans, SPAN_AI_REQUEST);
		const [tool] = byName(spans, SPAN_HARNESS_TOOL);

		assert.ok(session !== undefined && run !== undefined && tool !== undefined);
		assert.equal(turns.length, 2);
		assert.equal(llms.length, 2);
		assert.equal(spans.length, 7);

		assert.equal(parentSpanId(session), undefined);
		assert.equal(parentSpanId(run), session.spanContext().spanId);
		const turn0 = turns.find((s) => s.attributes[ATTR_TURN_INDEX] === 0);
		const turn1 = turns.find((s) => s.attributes[ATTR_TURN_INDEX] === 1);
		assert.ok(turn0 !== undefined && turn1 !== undefined);
		assert.equal(parentSpanId(turn0), run.spanContext().spanId);
		assert.equal(parentSpanId(turn1), run.spanContext().spanId);
		assert.equal(parentSpanId(tool), turn0.spanContext().spanId);
		const llmParents = llms.map(parentSpanId).sort();
		assert.deepEqual(
			llmParents,
			[turn0.spanContext().spanId, turn1.spanContext().spanId].sort(),
		);

		assert.equal(session.attributes[ATTR_SESSION_ID], "sess-e2e");
		assert.equal(session.attributes[ATTR_REQUIREMENT_ID], "REQ-E2E");
	});

	await t.test("llm spans carry TTFT and abort status", () => {
		const llms = byName(spans, SPAN_AI_REQUEST);
		for (const llm of llms) {
			assert.equal(typeof llm.attributes[ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS], "number");
		}
		const aborted = llms.find(
			(s) => s.attributes[ATTR_AI_RESPONSE_STOP_REASON] === "aborted",
		);
		assert.ok(aborted !== undefined);
	});

	await t.test("resource attributes are stamped on every signal", () => {
		for (const span of spans) {
			assert.equal(span.resource.attributes[ATTR_REQUIREMENT_ID], "REQ-E2E");
			assert.equal(span.resource.attributes[ATTR_SESSION_ID], "sess-e2e");
		}
		assert.equal(batch.resource.attributes[ATTR_REQUIREMENT_ID], "REQ-E2E");
	});

	await t.test("token and cost counters add up across messages and compaction", () => {
		const cost = metricByName(batch, METRIC_COST_USD);
		const expectedCost =
			usage1.cost.total + usage2.cost.total + compactionUsage.cost.total;
		assert.ok(Math.abs(sumPoints(cost) - expectedCost) < 1e-9);

		const tokens = metricByName(batch, METRIC_TOKENS);
		const inputTokens = sumPoints(tokens, (attrs) => attrs[ATTR_TOKEN_TYPE] === "input");
		assert.equal(inputTokens, usage1.input + usage2.input + compactionUsage.input);
		const reasoningTokens = sumPoints(
			tokens,
			(attrs) => attrs[ATTR_TOKEN_TYPE] === "reasoning",
		);
		assert.equal(reasoningTokens, 40);
	});

	await t.test("interventions: steer, interrupt, and bus approval count once each", () => {
		const interventions = metricByName(batch, METRIC_HUMAN_INTERVENTIONS);
		const byKind = (kind: string): number =>
			sumPoints(interventions, (attrs) => attrs[ATTR_INTERVENTION_KIND] === kind);
		assert.equal(byKind("steer"), 1);
		assert.equal(byKind("interrupt"), 1);
		assert.equal(byKind("approval"), 1);
		assert.equal(sumPoints(interventions), 3);
	});

	await t.test("turn counter and TTFT histogram are recorded", () => {
		assert.equal(sumPoints(metricByName(batch, METRIC_TURNS)), 2);
		const ttft = metricByName(batch, METRIC_LLM_TTFT);
		let count = 0;
		for (const point of ttft.dataPoints) {
			if (typeof point.value === "object") count += point.value.count;
		}
		assert.equal(count, 2);
	});

	await t.test("turn phases are recorded once per turn and never exceed it", () => {
		const phases = metricByName(batch, METRIC_TURN_PHASE_DURATION);
		let phaseTotal = 0;
		for (const phase of ["ttft", "streaming", "tool", "wait"]) {
			const point = phases.dataPoints.find((p) => p.attributes[ATTR_TURN_PHASE] === phase);
			assert.ok(point !== undefined, `phase not recorded: ${phase}`);
			assert.ok(typeof point.value === "object");
			assert.equal(point.value.count, 2, `${phase} recorded once per turn`);
			phaseTotal += point.value.sum ?? 0;
		}
		const turnDurations = metricByName(batch, METRIC_TURN_DURATION);
		let turnTotal = 0;
		for (const point of turnDurations.dataPoints) {
			if (typeof point.value === "object") turnTotal += point.value.sum ?? 0;
		}
		assert.ok(
			phaseTotal <= turnTotal,
			`phases (${phaseTotal}ms) must decompose the turns (${turnTotal}ms)`,
		);
	});

	await t.test("metrics drop per-session resource attributes, traces keep them", () => {
		assert.equal(batch.resource.attributes[ATTR_SESSION_ID], undefined);
		assert.equal(batch.resource.attributes[ATTR_PROJECT_PATH], undefined);
		for (const span of spans) {
			assert.equal(span.resource.attributes[ATTR_SESSION_ID], "sess-e2e");
			assert.equal(span.resource.attributes[ATTR_PROJECT_PATH], cwd);
		}
	});

	await t.test("session summary record carries the session totals", () => {
		const record = logRecords.find(
			(r) => r.attributes["pi.event.name"] === "pi.session.summary",
		);
		assert.ok(record !== undefined, "pi.session.summary not emitted");
		const attrs = record.attributes;
		assert.equal(attrs[ATTR_SESSION_ID], "sess-e2e");
		assert.equal(attrs["pi.summary.turns"], 2);
		assert.equal(
			attrs["pi.summary.tokens.input"],
			usage1.input + usage2.input + compactionUsage.input,
		);
		assert.equal(attrs["pi.summary.interventions.total"], 3);
		assert.equal(attrs["pi.summary.interventions.steer"], 1);
		assert.equal(attrs["pi.summary.models"], "claude-test");
		const expectedCost =
			usage1.cost.total + usage2.cost.total + compactionUsage.cost.total;
		assert.ok(Math.abs(Number(attrs["pi.summary.cost.total_usd"]) - expectedCost) < 1e-6);
		assert.equal(typeof attrs["pi.summary.duration_ms"], "number");
		assert.equal(typeof attrs["pi.summary.agent_busy_ms"], "number");
	});

	await t.test("event log stream survives the shutdown flush", () => {
		const names = logRecords.map((record) => record.attributes["pi.event.name"]);
		assert.ok(names.includes("pi.session.start"));
		assert.ok(names.includes("pi.session.compact"));
		assert.ok(names.includes("pi.session.shutdown"));
		assert.equal(names.filter((name) => name === "pi.intervention").length, 3);
	});

	await t.test("/req command registered; requirement trace ref written back", () => {
		assert.ok(commands.includes("req"));
		const state = readStateFile(stateFile);
		assert.ok(state.lastTraceByRequirement["REQ-E2E"] !== undefined);
	});
});

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The two behaviors the phase/snapshot work exists for, which the replay
 * above cannot reach: it runs one tool at a time and never switches model
 * mid-request. Real elapsed time is used (with wide margins) because both
 * invariants are about wall-clock bookkeeping.
 */
test("overlapping tools collapse into one busy window; a mid-flight model switch does not re-attribute the request", async (t) => {
	delete process.env["PI_REQUIREMENT_ID"];
	delete process.env["OTEL_SDK_DISABLED"];
	delete process.env["PI_OTEL_DISABLED"];

	const dir = mkdtempSync(join(tmpdir(), "pi-otel-phases-"));
	const stateFile = join(dir, "state.json");
	const cwd = join(dir, "project");

	const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const spanExporter = new InMemorySpanExporter();
	const logExporter = new InMemoryLogRecordExporter();

	const { host, handlers } = createHost();
	createPiOtel({
		stateFilePath: stateFile,
		exporters: { metrics: metricExporter, traces: spanExporter, logs: logExporter },
	})(host);

	const ctx = createCtx(cwd);
	const fire = async (event: string, payload: Record<string, unknown>): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	};

	await fire("session_start", { type: "session_start", reason: "startup" });
	await fire("agent_start", { type: "agent_start" });
	await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

	// Request goes out on claude-test; the user switches model while it is
	// still streaming.
	await fire("before_provider_request", { type: "before_provider_request", payload: {} });
	const assistant = assistantMessage("toolUse", usage1);
	await fire("message_start", { type: "message_start", message: assistant });
	await sleep(20);
	await fire("message_update", {
		type: "message_update",
		message: assistant,
		assistantMessageEvent: { type: "text_delta" },
	});
	await fire("model_select", {
		type: "model_select",
		model: { id: "claude-next", provider: "anthropic" },
		previousModel: { id: "claude-test" },
		source: "set",
	});
	await fire("message_end", { type: "message_end", message: assistant });

	// Two tools overlap: t0 start A, t40 start B, t80 end A, t120 end B.
	// Union window = ~120ms, sum of durations = ~160ms.
	const startTool = (id: string): Promise<void> =>
		fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "bash",
			args: {},
		});
	const endTool = (id: string): Promise<void> =>
		fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: {},
			isError: false,
		});

	await startTool("call-a");
	await sleep(40);
	await startTool("call-b");
	// A stray end for a tool that never started must not move the counter:
	// if it does, the window closes at call-a's end and call-b's remaining
	// time is lost.
	await endTool("call-unknown");
	await sleep(40);
	await endTool("call-a");
	await sleep(40);
	await endTool("call-b");

	await fire("turn_end", { type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] });
	await fire("agent_end", { type: "agent_end", messages: [] });
	await fire("agent_settled", { type: "agent_settled" });
	await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

	const batches = metricExporter.getMetrics();
	const batch = batches[batches.length - 1];

	await t.test("tool phase is the union of the overlap, not the sum", () => {
		const phases = metricByName(batch, METRIC_TURN_PHASE_DURATION);
		const toolPhase = phases.dataPoints.find(
			(p) => p.attributes[ATTR_TURN_PHASE] === "tool",
		);
		assert.ok(toolPhase !== undefined && typeof toolPhase.value === "object");
		const phaseMs = toolPhase.value.sum ?? 0;

		let durationSum = 0;
		for (const point of metricByName(batch, METRIC_TOOL_DURATION).dataPoints) {
			if (typeof point.value === "object") durationSum += point.value.sum ?? 0;
		}

		// Both tools ran ~80ms each; overlapping, they occupied ~120ms.
		assert.ok(durationSum >= 140, `expected both tool durations, got ${durationSum}ms`);
		assert.ok(phaseMs >= 100, `union window too short: ${phaseMs}ms`);
		assert.ok(
			phaseMs < durationSum - 20,
			`overlap not collapsed: phase ${phaseMs}ms vs sum ${durationSum}ms`,
		);
	});

	await t.test("in-flight request keeps the model it was sent with", () => {
		const ttft = metricByName(batch, METRIC_LLM_TTFT);
		const models = ttft.dataPoints.map((p) => p.attributes[ATTR_AI_MODEL]);
		assert.deepEqual(models, ["claude-test"]);

		const tokens = metricByName(batch, METRIC_TOKENS);
		for (const point of tokens.dataPoints) {
			assert.equal(point.attributes[ATTR_AI_MODEL], "claude-test");
		}
	});

	await t.test("the switch still applies to what comes after the request", () => {
		const turns = metricByName(batch, METRIC_TURNS);
		const models = turns.dataPoints.map((p) => p.attributes[ATTR_AI_MODEL]);
		assert.deepEqual(models, ["claude-next"]);
	});
});
