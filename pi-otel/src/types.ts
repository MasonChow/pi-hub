/**
 * Public contracts for pi-otel and its extension plugins.
 *
 * Enterprise customization (requirement resolvers, org dimensions, custom
 * intervention rules, internal pricing) is done by shipping a thin package
 * that passes `PiOtelPlugin` objects to the core — never by forking it.
 */
import type { ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";

/** Why a human had to come back to the session. */
export type InterventionKind =
	| "steer"
	| "follow_up"
	| "interrupt"
	| "approval"
	| "question";

/**
 * User input arrived (pi `input` event). Extension-injected inputs
 * (`event.source === "extension"`) are excluded by the core before
 * classification.
 */
export interface InputInterventionSignal {
	source: "input";
	event: InputEvent;
	/** 1-based count of user inputs in this session, including this one. */
	inputIndex: number;
}

/**
 * The user aborted a streaming response: `message_end` delivered an
 * assistant message with `stopReason === "aborted"`.
 */
export interface AbortInterventionSignal {
	source: "abort";
	message: AssistantMessage;
}

/**
 * The agent settled and its final assistant message may be a question
 * waiting for the user.
 */
export interface QuestionInterventionSignal {
	source: "question";
	/** Plain-text content of the final assistant message at `agent_settled`. */
	lastAssistantText: string;
}

/**
 * A message published on the cross-extension event bus (`pi.events`).
 * pi core has no approval events, so approval-gate extensions surface
 * theirs through an agreed bus channel consumed here.
 */
export interface BusInterventionSignal {
	source: "bus";
	channel: string;
	data: unknown;
}

export type InterventionSignal =
	| InputInterventionSignal
	| AbortInterventionSignal
	| QuestionInterventionSignal
	| BusInterventionSignal;

/** USD per million tokens. Replaces pi's built-in pricing for a model id. */
export interface ModelCostOverride {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface PiOtelPlugin {
	/**
	 * Resolved once at `session_start`; the result is frozen and applied as
	 * resource attributes to every signal of the session. Must be stable
	 * within a session (no timestamps, no random values) — unstable values
	 * break aggregation and the session's identity.
	 */
	resolveAttributes?(
		ctx: ExtensionContext,
	): Promise<Record<string, string>> | Record<string, string>;

	/**
	 * Decide whether a signal counts as human intervention and of which kind.
	 * Plugins are asked in registration order: returning a kind adopts it,
	 * returning `null` vetoes the signal (the built-in classifier is NOT
	 * consulted), and returning `undefined` — or not having the hook —
	 * passes to the next plugin. Only when no plugin has an opinion do the
	 * built-in rules run.
	 */
	classifyIntervention?(
		signal: InterventionSignal,
	): InterventionKind | null | undefined;

	/**
	 * Per-model pricing override, keyed by model id. Only needed when an
	 * internal proxy bills differently from pi's built-in price table;
	 * otherwise the `usage.cost` computed by pi is reported as-is.
	 */
	costTable?: Record<string, ModelCostOverride>;

	/**
	 * Redact or drop attributes before export. Called with the attributes of
	 * each outgoing signal; return the (possibly modified) attributes.
	 */
	redact?(attrs: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Exporter injection seam, used by tests (in-memory exporters). Production
 * always uses the OTLP/HTTP exporters configured through `OTEL_*` env vars.
 */
export interface PiOtelExporterOverrides {
	metrics?: PushMetricExporter;
	traces?: SpanExporter;
	logs?: LogRecordExporter;
}

export interface PiOtelOptions {
	plugins?: PiOtelPlugin[];
	/** Resource `service.name`. Defaults to "pi". */
	serviceName?: string;
	/** Extra static resource attributes merged into every signal. */
	resourceAttributes?: Record<string, string>;
	/** Cross-session state file override (tests). Defaults to ~/.pi/pi-otel/state.json. */
	stateFilePath?: string;
	/** Exporter overrides (tests). */
	exporters?: PiOtelExporterOverrides;
}
