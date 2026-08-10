import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
	type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_AI_RESPONSE_STOP_REASON,
	ATTR_AI_STREAM_CHUNK_COUNT,
	ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS,
	ATTR_AI_STREAMING,
	ATTR_AI_USAGE_COST,
	ATTR_AI_USAGE_INPUT_TOKENS,
	ATTR_AI_USAGE_OUTPUT_TOKENS,
	ATTR_AI_USAGE_REASONING_TOKENS,
	ATTR_AI_USAGE_TOTAL_TOKENS,
	ATTR_GEN_AI_REQUEST_MODEL,
	ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
	ATTR_PROJECT_PATH,
	ATTR_REQUIREMENT_ID,
	ATTR_SESSION_ID,
	ATTR_SESSION_PARENT_ID,
	ATTR_SESSION_REASON,
	ATTR_TOOL_CALL_ID,
	ATTR_TOOL_IS_ERROR,
	ATTR_TOOL_NAME,
	ATTR_TURN_INDEX,
	SPAN_AI_REQUEST,
	SPAN_HARNESS_RUN,
	SPAN_HARNESS_TOOL,
	SPAN_HARNESS_TURN,
} from "../src/attrs.ts";
import {
	createSessionState,
	readStateFile,
	setLastTraceForRequirement,
} from "../src/state.ts";
import {
	ATTR_AI_STREAM_DURATION_MS,
	createTraceManager,
	SPAN_SESSION,
	type DroppedSpanKind,
	type TraceManager,
} from "../src/traces.ts";

interface Harness {
	manager: TraceManager;
	exporter: InMemorySpanExporter;
	dropped: DroppedSpanKind[];
	stateFile: string;
}

function setup(init?: { sessionId?: string; requirementId?: string }): Harness {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const dropped: DroppedSpanKind[] = [];
	const stateFile = join(mkdtempSync(join(tmpdir(), "pi-otel-traces-")), "state.json");
	const state = createSessionState({
		sessionId: "sess-1",
		requirementId: "REQ-1",
		resourceAttributes: {},
		...init,
	});
	const manager = createTraceManager(provider.getTracer("test"), state, {
		stateFilePath: stateFile,
		onDropped: (kind) => dropped.push(kind),
	});
	return { manager, exporter, dropped, stateFile };
}

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test-1",
		responseId: "resp-1",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			reasoning: 8,
			totalTokens: 165,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
	const found = spans.filter((s) => s.name === name);
	assert.equal(found.length, 1, `expected exactly one "${name}" span`);
	return found[0]!;
}

function parentSpanId(span: ReadableSpan): string | undefined {
	return span.parentSpanContext?.spanId;
}

test("full session -> agent -> turn -> llm -> tool span tree", () => {
	const { manager, exporter, dropped } = setup();
	const turnTimestamp = Date.now() - 1_000;

	manager.startSession({ reason: "startup", parentSessionId: "parent-sess", cwd: "/proj" });
	manager.startAgentRun();
	manager.startTurn(0, turnTimestamp);
	manager.startLlmRequest();
	manager.recordStreamChunk();
	manager.recordStreamChunk();
	manager.endLlmRequest(assistantMessage());
	manager.startTool("call-1", "bash");
	manager.endTool("call-1", false);
	manager.endTurn();
	manager.endAgentRun();
	manager.endSession();

	const spans = exporter.getFinishedSpans();
	assert.equal(spans.length, 5);
	assert.deepEqual(dropped, []);

	const session = byName(spans, SPAN_SESSION);
	const run = byName(spans, SPAN_HARNESS_RUN);
	const turn = byName(spans, SPAN_HARNESS_TURN);
	const llm = byName(spans, SPAN_AI_REQUEST);
	const tool = byName(spans, SPAN_HARNESS_TOOL);

	// One trace per session, parents forming session -> run -> turn -> {llm, tool}.
	for (const span of spans) {
		assert.equal(span.spanContext().traceId, session.spanContext().traceId);
	}
	assert.equal(parentSpanId(session), undefined);
	assert.equal(parentSpanId(run), session.spanContext().spanId);
	assert.equal(parentSpanId(turn), run.spanContext().spanId);
	assert.equal(parentSpanId(llm), turn.spanContext().spanId);
	assert.equal(parentSpanId(tool), turn.spanContext().spanId);

	assert.equal(session.attributes[ATTR_SESSION_ID], "sess-1");
	assert.equal(session.attributes[ATTR_REQUIREMENT_ID], "REQ-1");
	assert.equal(session.attributes[ATTR_SESSION_REASON], "startup");
	assert.equal(session.attributes[ATTR_SESSION_PARENT_ID], "parent-sess");
	assert.equal(session.attributes[ATTR_PROJECT_PATH], "/proj");

	assert.equal(turn.attributes[ATTR_TURN_INDEX], 0);
	assert.equal(turn.startTime[0], Math.floor(turnTimestamp / 1000));

	const ttft = llm.attributes[ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS];
	assert.equal(typeof ttft, "number");
	assert.ok((ttft as number) >= 0);
	assert.ok(llm.events.some((e) => e.name === "first_chunk"));
	assert.equal(llm.attributes[ATTR_AI_STREAM_CHUNK_COUNT], 2);
	assert.equal(llm.attributes[ATTR_AI_STREAMING], true);
	assert.equal(typeof llm.attributes[ATTR_AI_STREAM_DURATION_MS], "number");
	assert.equal(llm.attributes[ATTR_AI_USAGE_INPUT_TOKENS], 100);
	assert.equal(llm.attributes[ATTR_AI_USAGE_OUTPUT_TOKENS], 50);
	assert.equal(llm.attributes[ATTR_AI_USAGE_REASONING_TOKENS], 8);
	assert.equal(llm.attributes[ATTR_AI_USAGE_TOTAL_TOKENS], 165);
	assert.equal(llm.attributes[ATTR_AI_USAGE_COST], 0.33);
	assert.equal(llm.attributes[ATTR_AI_RESPONSE_STOP_REASON], "stop");
	assert.equal(llm.attributes[ATTR_GEN_AI_REQUEST_MODEL], "claude-test-1");
	assert.deepEqual(llm.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS], ["stop"]);

	assert.equal(tool.attributes[ATTR_TOOL_NAME], "bash");
	assert.equal(tool.attributes[ATTR_TOOL_CALL_ID], "call-1");
	assert.equal(tool.attributes[ATTR_TOOL_IS_ERROR], false);
	assert.equal(tool.status.code, SpanStatusCode.UNSET);
});

test("llm span status by stopReason", () => {
	const cases: Array<{ stopReason: string; status: SpanStatusCode }> = [
		{ stopReason: "stop", status: SpanStatusCode.UNSET },
		{ stopReason: "toolUse", status: SpanStatusCode.UNSET },
		{ stopReason: "aborted", status: SpanStatusCode.ERROR },
		{ stopReason: "error", status: SpanStatusCode.ERROR },
	];
	for (const { stopReason, status } of cases) {
		const { manager, exporter } = setup();
		manager.startSession();
		manager.startAgentRun();
		manager.startTurn(0);
		manager.startLlmRequest();
		manager.endLlmRequest(assistantMessage({ stopReason }));
		const llm = byName(exporter.getFinishedSpans(), SPAN_AI_REQUEST);
		assert.equal(llm.status.code, status, `stopReason=${stopReason}`);
	}
});

test("orphan end events are dropped, never throw", () => {
	const { manager, exporter, dropped } = setup();

	manager.endLlmRequest(assistantMessage());
	manager.endTool("no-such-call", true);
	manager.endTurn();
	manager.endAgentRun();
	manager.endSession();

	assert.deepEqual(dropped, ["llm", "tool", "turn", "agent_run", "session"]);
	assert.equal(exporter.getFinishedSpans().length, 0);
});

test("message_end for non-assistant roles is ignored", () => {
	const { manager, exporter, dropped } = setup();
	manager.startSession();
	manager.startAgentRun();
	manager.startTurn(0);
	manager.startLlmRequest();

	// message_end also fires for user and toolResult messages — not LLM span ends.
	manager.endLlmRequest({ role: "user", content: "hi", timestamp: Date.now() });
	manager.endLlmRequest({ role: "toolResult", toolCallId: "x", isError: false });
	assert.equal(exporter.getFinishedSpans().length, 0);

	manager.endLlmRequest(assistantMessage());
	assert.equal(
		exporter.getFinishedSpans().filter((s) => s.name === SPAN_AI_REQUEST).length,
		1,
	);
	assert.deepEqual(dropped, []);
});

test("session root links the requirement's previous trace and writes itself back", () => {
	const { manager, exporter, stateFile } = setup();
	const previous = {
		traceId: "0af7651916cd43dd8448eb211c80319c",
		spanId: "b7ad6b7169203331",
	};
	setLastTraceForRequirement("REQ-1", previous, stateFile);

	manager.startSession();
	manager.endSession();

	const session = byName(exporter.getFinishedSpans(), SPAN_SESSION);
	assert.equal(session.links.length, 1);
	assert.equal(session.links[0]!.context.traceId, previous.traceId);
	assert.equal(session.links[0]!.context.spanId, previous.spanId);

	const stored = readStateFile(stateFile).lastTraceByRequirement["REQ-1"];
	assert.deepEqual(stored, {
		traceId: session.spanContext().traceId,
		spanId: session.spanContext().spanId,
	});
});

test("no requirement id: no link, no state write", () => {
	const { manager, exporter, stateFile } = setup({ requirementId: undefined });
	manager.startSession();
	manager.endSession();

	const session = byName(exporter.getFinishedSpans(), SPAN_SESSION);
	assert.equal(session.links.length, 0);
	assert.deepEqual(readStateFile(stateFile).lastTraceByRequirement, {});
});

test("session_shutdown mid-run force-closes the whole tree", () => {
	const { manager, exporter, dropped } = setup();
	manager.startSession();
	manager.startAgentRun();
	manager.startTurn(1);
	manager.startLlmRequest();
	manager.startTool("call-1", "bash");

	manager.endSession();

	const spans = exporter.getFinishedSpans();
	assert.equal(spans.length, 5);
	// Forced closes at shutdown are not bookkeeping anomalies.
	assert.deepEqual(dropped, []);
});
