/**
 * Structured event log stream: low-frequency, high-information state
 * changes (session lifecycle, config changes, interventions, errors).
 *
 * Metadata-only by design: names, kinds, ids and counts — never prompt
 * text, tool arguments, or error messages.
 */
import {
	SeverityNumber,
	type LogAttributes,
	type Logger,
} from "@opentelemetry/api-logs";
import {
	ATTR_AI_MODEL,
	ATTR_COMPACTION_REASON,
	ATTR_ERROR_TYPE,
	ATTR_INTERVENTION_KIND,
	ATTR_REQUIREMENT_ID,
	ATTR_SESSION_ID,
	ATTR_SESSION_PARENT_ID,
	ATTR_SESSION_REASON,
	ATTR_THINKING_LEVEL,
	ATTR_TOOL_CALL_ID,
	ATTR_TOOL_NAME,
} from "./attrs.ts";
import { recordTelemetryError } from "./otel.ts";
import type { InterventionKind, InterventionSignal } from "./types.ts";

// Log-only attribute keys (no counterpart in the official schemas).
// The event name is duplicated into an attribute because most log
// backends index attributes, not the OTLP event_name field.
const ATTR_LOG_EVENT = "pi.event.name";
const ATTR_MODEL_PREVIOUS = "pi.ai.model.previous";
const ATTR_MODEL_SELECT_SOURCE = "pi.model_select.source";
const ATTR_THINKING_LEVEL_PREVIOUS = "pi.thinking_level.previous";
const ATTR_COMPACTION_TOKENS_BEFORE = "pi.compaction.tokens_before";
const ATTR_COMPACTION_TOKENS_AFTER = "pi.compaction.tokens_after";
const ATTR_INTERVENTION_SOURCE = "pi.intervention.source";

export interface EventLogger {
	sessionStart(info: {
		sessionId?: string;
		/** startup | reload | new | resume | fork */
		reason?: string;
		parentSessionId?: string;
		requirementId?: string;
	}): void;
	sessionShutdown(info?: { sessionId?: string }): void;
	/**
	 * One row per session with its totals (see `summary.ts`). Emitted at
	 * `session_shutdown`, before the final flush.
	 */
	sessionSummary(info: {
		sessionId?: string;
		totals: Record<string, string | number>;
	}): void;
	sessionCompact(info: {
		sessionId?: string;
		reason?: string;
		tokensBefore?: number;
		tokensAfter?: number;
	}): void;
	/** Fork lineage: this session was forked from `parentSessionId`. */
	sessionFork(info: { sessionId?: string; parentSessionId?: string }): void;
	modelSelect(info: {
		model: string;
		previousModel?: string;
		/** set | cycle | restore */
		source?: string;
	}): void;
	thinkingLevelSelect(info: { level: string; previousLevel?: string }): void;
	intervention(info: {
		kind: InterventionKind;
		source: InterventionSignal["source"];
	}): void;
	agentError(info: { errorType: string }): void;
	/** Records the tool name and error type only, never the arguments. */
	toolError(info: {
		toolName: string;
		toolCallId?: string;
		errorType?: string;
	}): void;
}

function pruned(
	attributes: Record<string, string | number | boolean | undefined>,
): LogAttributes {
	const out: LogAttributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * Create the event logger. `baseAttributes` (e.g. session identity) are
 * merged into every record; per-call attributes win on key conflicts.
 * Every emit is fail-open.
 */
export function createEventLogger(
	logger: Logger,
	baseAttributes?: Record<string, string>,
): EventLogger {
	const emit = (
		eventName: string,
		severityNumber: SeverityNumber,
		severityText: string,
		body: string,
		attributes: LogAttributes,
	): void => {
		try {
			logger.emit({
				eventName,
				timestamp: Date.now(),
				severityNumber,
				severityText,
				body,
				attributes: {
					[ATTR_LOG_EVENT]: eventName,
					...baseAttributes,
					...attributes,
				},
			});
		} catch (err) {
			recordTelemetryError(err);
		}
	};

	const info = (eventName: string, body: string, attributes: LogAttributes) =>
		emit(eventName, SeverityNumber.INFO, "INFO", body, attributes);

	return {
		sessionStart: (i) =>
			info(
				"pi.session.start",
				"session started",
				pruned({
					[ATTR_SESSION_ID]: i.sessionId,
					[ATTR_SESSION_REASON]: i.reason,
					[ATTR_SESSION_PARENT_ID]: i.parentSessionId,
					[ATTR_REQUIREMENT_ID]: i.requirementId,
				}),
			),
		sessionShutdown: (i) =>
			info(
				"pi.session.shutdown",
				"session shutdown",
				pruned({ [ATTR_SESSION_ID]: i?.sessionId }),
			),
		sessionSummary: (i) =>
			info(
				"pi.session.summary",
				"session summary",
				pruned({ [ATTR_SESSION_ID]: i.sessionId, ...i.totals }),
			),
		sessionCompact: (i) =>
			info(
				"pi.session.compact",
				"session compacted",
				pruned({
					[ATTR_SESSION_ID]: i.sessionId,
					[ATTR_COMPACTION_REASON]: i.reason,
					[ATTR_COMPACTION_TOKENS_BEFORE]: i.tokensBefore,
					[ATTR_COMPACTION_TOKENS_AFTER]: i.tokensAfter,
				}),
			),
		sessionFork: (i) =>
			info(
				"pi.session.fork",
				"session forked",
				pruned({
					[ATTR_SESSION_ID]: i.sessionId,
					[ATTR_SESSION_PARENT_ID]: i.parentSessionId,
				}),
			),
		modelSelect: (i) =>
			info(
				"pi.model.select",
				"model selected",
				pruned({
					[ATTR_AI_MODEL]: i.model,
					[ATTR_MODEL_PREVIOUS]: i.previousModel,
					[ATTR_MODEL_SELECT_SOURCE]: i.source,
				}),
			),
		thinkingLevelSelect: (i) =>
			info(
				"pi.thinking_level.select",
				"thinking level selected",
				pruned({
					[ATTR_THINKING_LEVEL]: i.level,
					[ATTR_THINKING_LEVEL_PREVIOUS]: i.previousLevel,
				}),
			),
		intervention: (i) =>
			info(
				"pi.intervention",
				"human intervention",
				pruned({
					[ATTR_INTERVENTION_KIND]: i.kind,
					[ATTR_INTERVENTION_SOURCE]: i.source,
				}),
			),
		agentError: (i) =>
			emit(
				"pi.agent.error",
				SeverityNumber.ERROR,
				"ERROR",
				"agent error",
				pruned({ [ATTR_ERROR_TYPE]: i.errorType }),
			),
		toolError: (i) =>
			emit(
				"pi.tool.error",
				SeverityNumber.WARN,
				"WARN",
				"tool error",
				pruned({
					[ATTR_TOOL_NAME]: i.toolName,
					[ATTR_TOOL_CALL_ID]: i.toolCallId,
					[ATTR_ERROR_TYPE]: i.errorType,
				}),
			),
	};
}
