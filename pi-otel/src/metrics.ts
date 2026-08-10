/**
 * Metric instruments for pi-otel (DESIGN.md §4.1–§4.4).
 *
 * Pure factory: `createMetrics(meter)` builds every instrument and returns
 * typed record functions. No event subscriptions and no OTel globals here —
 * the integration layer wires pi events to these functions (through
 * `guard()`), so everything in this module may assume it is called
 * fail-open.
 */
import type {
	Attributes,
	Counter,
	Histogram,
	Meter,
	ObservableGauge,
} from "@opentelemetry/api";
import type { Usage } from "@earendil-works/pi-ai";
import {
	ATTR_COMPACTION_REASON,
	ATTR_ERROR_TYPE,
	ATTR_INTERVENTION_KIND,
	ATTR_TOKEN_TYPE,
	ATTR_TOOL_IS_ERROR,
	ATTR_TOOL_NAME,
} from "./attrs.ts";
import type { InterventionKind } from "./types.ts";

// --- metric names ---

export const METRIC_TOKENS = "pi.tokens";
export const METRIC_COST_USD = "pi.cost.usd";
export const METRIC_HUMAN_INTERVENTIONS = "pi.human.interventions";
export const METRIC_TURNS = "pi.turns";
export const METRIC_AGENT_DURATION = "pi.agent.duration";
export const METRIC_TURN_DURATION = "pi.turn.duration";
export const METRIC_LLM_DURATION = "pi.llm.duration";
export const METRIC_TOOL_DURATION = "pi.tool.duration";
export const METRIC_LLM_TTFT = "pi.llm.ttft";
export const METRIC_LLM_STREAMING_DURATION = "pi.llm.streaming.duration";
export const METRIC_CONTEXT_TOKENS = "pi.context.tokens";
export const METRIC_CONTEXT_USAGE_RATIO = "pi.context.usage_ratio";
export const METRIC_COMPACTION = "pi.compaction";
export const METRIC_ERRORS = "pi.errors";
export const METRIC_TELEMETRY_ERRORS = "pi.telemetry.errors";
export const METRIC_TELEMETRY_DROPPED = "pi.telemetry.dropped";

// --- attribute keys owned by this module (not in the official schemas) ---

/** Error counter dimension: llm | tool | agent | provider. */
export const ATTR_ERROR_SCOPE = "pi.error.scope";
/** Context token count of the compacted session before compaction ran. */
export const ATTR_COMPACTION_TOKENS_BEFORE = "pi.compaction.tokens_before";

/**
 * `pi.tokens` / `pi.cost.usd` dimension values. Two types are subsets of
 * others and must be excluded when totalling: `reasoning` ⊂ `output`,
 * `cache_write_1h` ⊂ `cache_write`.
 */
export type TokenType =
	| "input"
	| "output"
	| "cache_read"
	| "cache_write"
	| "cache_write_1h"
	| "reasoning";

export type ErrorScope = "llm" | "tool" | "agent" | "provider";

/**
 * Merge attribute records left to right, keeping only valid OTel metric
 * label values (string / boolean / finite number). `undefined`, `null`,
 * `NaN`, and non-primitive values are dropped; later parts win on key
 * conflicts. `undefined` parts are skipped entirely.
 */
export function mergeAttrs(
	...parts: ReadonlyArray<Record<string, unknown> | undefined>
): Attributes {
	const out: Attributes = {};
	for (const part of parts) {
		if (part === undefined) continue;
		for (const [key, value] of Object.entries(part)) {
			if (
				typeof value === "string" ||
				typeof value === "boolean" ||
				(typeof value === "number" && Number.isFinite(value))
			) {
				out[key] = value;
			}
		}
	}
	return out;
}

export interface PiMetricsInstruments {
	tokens: Counter;
	costUsd: Counter;
	interventions: Counter;
	turns: Counter;
	agentDuration: Histogram;
	turnDuration: Histogram;
	llmDuration: Histogram;
	toolDuration: Histogram;
	llmTtft: Histogram;
	llmStreamingDuration: Histogram;
	contextTokens: ObservableGauge;
	contextUsageRatio: ObservableGauge;
	compaction: Counter;
	errors: Counter;
	telemetryErrors: Counter;
	telemetryDropped: Counter;
}

export interface PiMetrics {
	instruments: PiMetricsInstruments;
	/**
	 * Record one assistant-message `usage` into `pi.tokens` and
	 * `pi.cost.usd`.
	 *
	 * - `pi.tokens{pi.token.type}`: `reasoning` is a subset of `output` and
	 *   `cache_write_1h` a subset of `cache_write` — both are recorded as
	 *   their own type without being deducted, so a naive sum over all types
	 *   double-counts them.
	 * - `pi.cost.usd{pi.token.type}`: the four `usage.cost` components
	 *   (computed by pi's price table, or recomputed by a `costTable` plugin
	 *   before this call) sum to `usage.cost.total`, so total spend is the
	 *   plain sum over all types.
	 *
	 * Zero and non-finite values are skipped to avoid empty series.
	 */
	recordUsage(usage: Usage, attrs?: Attributes): void;
	recordIntervention(kind: InterventionKind, attrs?: Attributes): void;
	recordTurn(attrs?: Attributes): void;
	recordAgentDuration(ms: number, attrs?: Attributes): void;
	recordTurnDuration(ms: number, attrs?: Attributes): void;
	recordLlmDuration(ms: number, attrs?: Attributes): void;
	recordToolDuration(
		ms: number,
		tool: { toolName: string; isError: boolean },
		attrs?: Attributes,
	): void;
	/** Time to first stream chunk (`before_provider_request` → first `message_update`). */
	recordTtft(ms: number, attrs?: Attributes): void;
	/** First stream chunk → last token. */
	recordStreamingDuration(ms: number, attrs?: Attributes): void;
	/**
	 * Store the latest context-window sample (`ctx.getContextUsage()`); the
	 * `pi.context.tokens` / `pi.context.usage_ratio` observable gauges report
	 * it on every collection until the next sample replaces it.
	 */
	recordContextSample(
		sample: { tokens: number; usageRatio: number },
		attrs?: Attributes,
	): void;
	/**
	 * Count one compaction (`session_compact`). When
	 * `compactionEntry.usage` is present, the compaction's own LLM
	 * consumption is folded into `pi.tokens` / `pi.cost.usd` — it does not
	 * flow through `message_end`, so skipping it here under-reports cost.
	 */
	recordCompaction(
		compaction: { tokensBefore?: number; reason?: string; usage?: Usage },
		attrs?: Attributes,
	): void;
	recordError(scope: ErrorScope, errorType?: string, attrs?: Attributes): void;
	/** Count signals pi-otel deliberately dropped (queue overflow, redact-to-null, …). */
	recordDropped(count?: number, attrs?: Attributes): void;
}

const TOKEN_FIELDS: ReadonlyArray<
	readonly [TokenType, (usage: Usage) => number | undefined]
> = [
	["input", (u) => u.input],
	["output", (u) => u.output],
	["cache_read", (u) => u.cacheRead],
	["cache_write", (u) => u.cacheWrite],
	["cache_write_1h", (u) => u.cacheWrite1h],
	["reasoning", (u) => u.reasoning],
];

const COST_FIELDS: ReadonlyArray<
	readonly [TokenType, (usage: Usage) => number]
> = [
	["input", (u) => u.cost.input],
	["output", (u) => u.cost.output],
	["cache_read", (u) => u.cost.cacheRead],
	["cache_write", (u) => u.cost.cacheWrite],
];

function isPositiveFinite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Create all pi-otel instruments on `meter` and return typed recorders. */
export function createMetrics(meter: Meter): PiMetrics {
	const tokens = meter.createCounter(METRIC_TOKENS, {
		description:
			"LLM tokens by type; reasoning ⊂ output and cache_write_1h ⊂ cache_write (exclude subsets when totalling)",
		unit: "{token}",
	});
	const costUsd = meter.createCounter(METRIC_COST_USD, {
		description:
			"LLM spend by cost component; components sum to the usage total",
		unit: "USD",
	});
	const interventions = meter.createCounter(METRIC_HUMAN_INTERVENTIONS, {
		description: "Turns where a human had to come back to the session",
		unit: "{intervention}",
	});
	const turns = meter.createCounter(METRIC_TURNS, {
		description: "Agent turns",
		unit: "{turn}",
	});
	const agentDuration = meter.createHistogram(METRIC_AGENT_DURATION, {
		description: "agent_start → agent_settled busy time",
		unit: "ms",
	});
	const turnDuration = meter.createHistogram(METRIC_TURN_DURATION, {
		description: "Single turn duration",
		unit: "ms",
	});
	const llmDuration = meter.createHistogram(METRIC_LLM_DURATION, {
		description: "Single model request duration (message_start → message_end)",
		unit: "ms",
	});
	const toolDuration = meter.createHistogram(METRIC_TOOL_DURATION, {
		description:
			"Single tool execution duration (tool_execution_start → tool_execution_end)",
		unit: "ms",
	});
	const llmTtft = meter.createHistogram(METRIC_LLM_TTFT, {
		description: "Time to first stream chunk",
		unit: "ms",
	});
	const llmStreamingDuration = meter.createHistogram(
		METRIC_LLM_STREAMING_DURATION,
		{
			description: "First stream chunk → last token",
			unit: "ms",
		},
	);
	const contextTokens = meter.createObservableGauge(METRIC_CONTEXT_TOKENS, {
		description: "Context window tokens in use (last sample)",
		unit: "{token}",
	});
	const contextUsageRatio = meter.createObservableGauge(
		METRIC_CONTEXT_USAGE_RATIO,
		{
			description: "Context window fill ratio 0–1 (last sample)",
			unit: "1",
		},
	);
	const compaction = meter.createCounter(METRIC_COMPACTION, {
		description: "Context compactions",
		unit: "{compaction}",
	});
	const errors = meter.createCounter(METRIC_ERRORS, {
		description: "Agent-side errors by scope",
		unit: "{error}",
	});
	// Identity (name/type/unit/description) must stay byte-identical to the
	// counter armed in otel.ts so the SDK resolves both to one stream instead
	// of a duplicate-instrument conflict.
	const telemetryErrors = meter.createCounter(METRIC_TELEMETRY_ERRORS, {
		description: "Errors swallowed by the pi-otel fail-open guard",
	});
	const telemetryDropped = meter.createCounter(METRIC_TELEMETRY_DROPPED, {
		description: "Signals dropped by pi-otel itself",
		unit: "{signal}",
	});

	let lastContext:
		| { tokens: number; usageRatio: number; attrs: Attributes }
		| undefined;
	contextTokens.addCallback((result) => {
		if (lastContext) result.observe(lastContext.tokens, lastContext.attrs);
	});
	contextUsageRatio.addCallback((result) => {
		if (lastContext) result.observe(lastContext.usageRatio, lastContext.attrs);
	});

	const recordDurationTo = (
		histogram: Histogram,
		ms: number,
		attrs?: Attributes,
	): void => {
		if (!Number.isFinite(ms) || ms < 0) return;
		histogram.record(ms, attrs ?? {});
	};

	const recordUsage = (usage: Usage, attrs?: Attributes): void => {
		for (const [type, pick] of TOKEN_FIELDS) {
			const value = pick(usage);
			if (!isPositiveFinite(value)) continue;
			tokens.add(value, mergeAttrs(attrs, { [ATTR_TOKEN_TYPE]: type }));
		}
		for (const [type, pick] of COST_FIELDS) {
			const value = pick(usage);
			if (!isPositiveFinite(value)) continue;
			costUsd.add(value, mergeAttrs(attrs, { [ATTR_TOKEN_TYPE]: type }));
		}
	};

	return {
		instruments: {
			tokens,
			costUsd,
			interventions,
			turns,
			agentDuration,
			turnDuration,
			llmDuration,
			toolDuration,
			llmTtft,
			llmStreamingDuration,
			contextTokens,
			contextUsageRatio,
			compaction,
			errors,
			telemetryErrors,
			telemetryDropped,
		},
		recordUsage,
		recordIntervention(kind, attrs) {
			interventions.add(
				1,
				mergeAttrs(attrs, { [ATTR_INTERVENTION_KIND]: kind }),
			);
		},
		recordTurn(attrs) {
			turns.add(1, attrs ?? {});
		},
		recordAgentDuration(ms, attrs) {
			recordDurationTo(agentDuration, ms, attrs);
		},
		recordTurnDuration(ms, attrs) {
			recordDurationTo(turnDuration, ms, attrs);
		},
		recordLlmDuration(ms, attrs) {
			recordDurationTo(llmDuration, ms, attrs);
		},
		recordToolDuration(ms, tool, attrs) {
			recordDurationTo(
				toolDuration,
				ms,
				mergeAttrs(attrs, {
					[ATTR_TOOL_NAME]: tool.toolName,
					[ATTR_TOOL_IS_ERROR]: tool.isError,
				}),
			);
		},
		recordTtft(ms, attrs) {
			recordDurationTo(llmTtft, ms, attrs);
		},
		recordStreamingDuration(ms, attrs) {
			recordDurationTo(llmStreamingDuration, ms, attrs);
		},
		recordContextSample(sample, attrs) {
			if (
				!Number.isFinite(sample.tokens) ||
				!Number.isFinite(sample.usageRatio)
			) {
				return;
			}
			lastContext = {
				tokens: sample.tokens,
				usageRatio: sample.usageRatio,
				attrs: attrs ?? {},
			};
		},
		recordCompaction(info, attrs) {
			compaction.add(
				1,
				mergeAttrs(attrs, {
					[ATTR_COMPACTION_TOKENS_BEFORE]: info.tokensBefore,
					[ATTR_COMPACTION_REASON]: info.reason,
				}),
			);
			if (info.usage) recordUsage(info.usage, attrs);
		},
		recordError(scope, errorType, attrs) {
			errors.add(
				1,
				mergeAttrs(attrs, {
					[ATTR_ERROR_SCOPE]: scope,
					[ATTR_ERROR_TYPE]: errorType,
				}),
			);
		},
		recordDropped(count = 1, attrs) {
			if (!isPositiveFinite(count)) return;
			telemetryDropped.add(count, attrs ?? {});
		},
	};
}
