/**
 * Span-tree management: one trace per session.
 *
 * Hierarchy: session root → agent run → turn → llm / tool. pi extension
 * events carry no timestamps (except `turn_start`), so timing is taken
 * with Date.now() at handler dispatch.
 *
 * Out-of-order tolerance: an end call with no matching open span is
 * silently discarded and reported through `onDropped` (the caller wires
 * it to the pi.telemetry.dropped counter). A start call arriving while
 * the previous span of the same slot is still open force-closes the
 * stale span and reports it the same way — its telemetry was lost
 * (e.g. compaction LLM calls, whose assistant message may skip
 * `message_end`).
 */
import {
	context,
	ROOT_CONTEXT,
	SpanStatusCode,
	trace,
	TraceFlags,
	type Link,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	ATTR_AI_API,
	ATTR_AI_ERROR_TYPE,
	ATTR_AI_MODEL,
	ATTR_AI_PROVIDER,
	ATTR_AI_RESPONSE_ID,
	ATTR_AI_RESPONSE_MODEL,
	ATTR_AI_RESPONSE_STOP_REASON,
	ATTR_AI_STREAM_CHUNK_COUNT,
	ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS,
	ATTR_AI_STREAMING,
	ATTR_AI_USAGE_CACHE_READ_TOKENS,
	ATTR_AI_USAGE_CACHE_WRITE_TOKENS,
	ATTR_AI_USAGE_COST,
	ATTR_AI_USAGE_INPUT_TOKENS,
	ATTR_AI_USAGE_OUTPUT_TOKENS,
	ATTR_AI_USAGE_REASONING_TOKENS,
	ATTR_AI_USAGE_TOTAL_TOKENS,
	ATTR_GEN_AI_REQUEST_MODEL,
	ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
	ATTR_GEN_AI_USAGE_INPUT_TOKENS,
	ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
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
} from "./attrs.ts";
import {
	getLastTraceForRequirement,
	setLastTraceForRequirement,
	type SessionState,
} from "./state.ts";

/** Session root span name — the official harness schema has no session-level span. */
export const SPAN_SESSION = "pi.session";
/** First chunk → message_end, ms. pi-otel extension of the official pi.ai.stream.* attrs. */
export const ATTR_AI_STREAM_DURATION_MS = "pi.ai.stream.duration_ms";

export type DroppedSpanKind = "session" | "agent_run" | "turn" | "llm" | "tool";

/** Fields of the `session_start` event surfaced on the root span. */
export interface SessionSpanInfo {
	reason?: string;
	/** Fork parent (session header `parentSession`). */
	parentSessionId?: string;
	cwd?: string;
}

export interface TraceManagerOptions {
	/** Requirement state file override (tests). */
	stateFilePath?: string;
	/** Bookkeeping anomaly: orphan end or force-closed stale span. */
	onDropped?: (kind: DroppedSpanKind) => void;
}

export interface TraceManager {
	/** `session_start`: opens the root span, linking the requirement's previous session trace. */
	startSession(info?: SessionSpanInfo): void;
	/** `session_shutdown`: force-closes anything still open, then the root. */
	endSession(): void;
	/** `agent_start`. One prompt may produce several runs (auto-retry, follow-up queue). */
	startAgentRun(): void;
	/** `agent_end`. */
	endAgentRun(): void;
	/** `turn_start`. `timestamp` is the event's own epoch-ms timestamp. */
	startTurn(turnIndex: number, timestamp?: number): void;
	/** `turn_end`. */
	endTurn(): void;
	/** `before_provider_request`: opens the LLM span and marks t0 for TTFT. */
	startLlmRequest(): void;
	/** Every assistant `message_update`; the first one stamps TTFT. */
	recordStreamChunk(): void;
	/**
	 * `message_end`. Accepts any message and ignores non-assistant roles
	 * (`message_end` also fires for user/toolResult messages).
	 */
	endLlmRequest(message: unknown): void;
	/** `tool_execution_start`. Parallel calls become sibling spans under the turn. */
	startTool(toolCallId: string, toolName: string): void;
	/** `tool_execution_end`. */
	endTool(toolCallId: string, isError: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return (
		isRecord(message) &&
		message["role"] === "assistant" &&
		typeof message["stopReason"] === "string" &&
		isRecord(message["usage"])
	);
}

interface LlmSlot {
	span: Span;
	/** Request send time (before_provider_request). */
	t0: number;
	firstChunkAt?: number;
	chunkCount: number;
}

export function createTraceManager(
	tracer: Tracer,
	state: SessionState,
	options: TraceManagerOptions = {},
): TraceManager {
	const stateFilePath = options.stateFilePath;
	const onDropped = options.onDropped ?? ((): void => undefined);

	let root: Span | undefined;
	let agentRun: Span | undefined;
	let turn: Span | undefined;
	let llm: LlmSlot | undefined;
	const tools = new Map<string, Span>();

	function childSpan(name: string, parent: Span, startTime?: number): Span {
		return tracer.startSpan(
			name,
			startTime === undefined ? {} : { startTime },
			trace.setSpan(context.active(), parent),
		);
	}

	function closeLlm(): void {
		if (llm !== undefined) {
			llm.span.end();
			llm = undefined;
		}
	}

	function closeTools(): void {
		for (const span of tools.values()) span.end();
		tools.clear();
	}

	function closeTurnTree(): void {
		closeLlm();
		closeTools();
		if (turn !== undefined) {
			turn.end();
			turn = undefined;
		}
	}

	function closeAgentTree(): void {
		closeTurnTree();
		if (agentRun !== undefined) {
			agentRun.end();
			agentRun = undefined;
		}
	}

	return {
		startSession(info = {}): void {
			if (root !== undefined) {
				onDropped("session");
				closeAgentTree();
				root.end();
				root = undefined;
			}
			const requirementId = state.requirementId;
			const links: Link[] = [];
			if (requirementId !== undefined) {
				const last = getLastTraceForRequirement(requirementId, stateFilePath);
				if (last !== undefined) {
					links.push({
						context: {
							traceId: last.traceId,
							spanId: last.spanId,
							traceFlags: TraceFlags.SAMPLED,
						},
					});
				}
			}
			const attributes: Record<string, string> = {};
			if (state.sessionId !== undefined) attributes[ATTR_SESSION_ID] = state.sessionId;
			if (requirementId !== undefined) attributes[ATTR_REQUIREMENT_ID] = requirementId;
			if (info.reason !== undefined) attributes[ATTR_SESSION_REASON] = info.reason;
			if (info.parentSessionId !== undefined) {
				attributes[ATTR_SESSION_PARENT_ID] = info.parentSessionId;
			}
			if (info.cwd !== undefined) attributes[ATTR_PROJECT_PATH] = info.cwd;

			root = tracer.startSpan(SPAN_SESSION, { links, attributes }, ROOT_CONTEXT);
			if (requirementId !== undefined) {
				const spanContext = root.spanContext();
				setLastTraceForRequirement(
					requirementId,
					{ traceId: spanContext.traceId, spanId: spanContext.spanId },
					stateFilePath,
				);
			}
		},

		endSession(): void {
			if (root === undefined) {
				onDropped("session");
				return;
			}
			closeAgentTree();
			root.end();
			root = undefined;
		},

		startAgentRun(): void {
			if (agentRun !== undefined) {
				onDropped("agent_run");
				closeAgentTree();
			}
			if (root === undefined) return;
			agentRun = childSpan(SPAN_HARNESS_RUN, root);
		},

		endAgentRun(): void {
			if (agentRun === undefined) {
				onDropped("agent_run");
				return;
			}
			closeAgentTree();
		},

		startTurn(turnIndex, timestamp): void {
			if (turn !== undefined) {
				onDropped("turn");
				closeTurnTree();
			}
			const parent = agentRun ?? root;
			if (parent === undefined) return;
			const span = childSpan(SPAN_HARNESS_TURN, parent, timestamp);
			span.setAttribute(ATTR_TURN_INDEX, turnIndex);
			turn = span;
		},

		endTurn(): void {
			if (turn === undefined) {
				onDropped("turn");
				return;
			}
			closeTurnTree();
		},

		startLlmRequest(): void {
			if (llm !== undefined) {
				onDropped("llm");
				closeLlm();
			}
			const parent = turn ?? agentRun ?? root;
			if (parent === undefined) return;
			llm = { span: childSpan(SPAN_AI_REQUEST, parent), t0: Date.now(), chunkCount: 0 };
		},

		recordStreamChunk(): void {
			if (llm === undefined) return;
			llm.chunkCount += 1;
			if (llm.firstChunkAt === undefined) {
				llm.firstChunkAt = Date.now();
				llm.span.setAttribute(
					ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS,
					llm.firstChunkAt - llm.t0,
				);
				llm.span.addEvent("first_chunk");
			}
		},

		endLlmRequest(message): void {
			if (!isAssistantMessage(message)) return;
			if (llm === undefined) {
				onDropped("llm");
				return;
			}
			const { span, firstChunkAt, chunkCount } = llm;
			const now = Date.now();

			span.setAttribute(ATTR_AI_PROVIDER, message.provider);
			span.setAttribute(ATTR_AI_MODEL, message.model);
			span.setAttribute(ATTR_AI_API, message.api);
			span.setAttribute(ATTR_AI_RESPONSE_STOP_REASON, message.stopReason);
			if (message.responseModel !== undefined) {
				span.setAttribute(ATTR_AI_RESPONSE_MODEL, message.responseModel);
			}
			if (message.responseId !== undefined) {
				span.setAttribute(ATTR_AI_RESPONSE_ID, message.responseId);
			}

			const usage = message.usage;
			span.setAttribute(ATTR_AI_USAGE_INPUT_TOKENS, usage.input);
			span.setAttribute(ATTR_AI_USAGE_OUTPUT_TOKENS, usage.output);
			span.setAttribute(ATTR_AI_USAGE_CACHE_READ_TOKENS, usage.cacheRead);
			span.setAttribute(ATTR_AI_USAGE_CACHE_WRITE_TOKENS, usage.cacheWrite);
			span.setAttribute(ATTR_AI_USAGE_TOTAL_TOKENS, usage.totalTokens);
			// reasoning is a subset of output — reported as its own attribute, never added.
			if (typeof usage.reasoning === "number") {
				span.setAttribute(ATTR_AI_USAGE_REASONING_TOKENS, usage.reasoning);
			}
			const costTotal = usage.cost?.total;
			if (typeof costTotal === "number") {
				span.setAttribute(ATTR_AI_USAGE_COST, costTotal);
			}

			span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, message.model);
			span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.input);
			span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.output);
			span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [message.stopReason]);

			span.setAttribute(ATTR_AI_STREAMING, chunkCount > 0);
			if (chunkCount > 0) span.setAttribute(ATTR_AI_STREAM_CHUNK_COUNT, chunkCount);
			if (firstChunkAt !== undefined) {
				span.setAttribute(ATTR_AI_STREAM_DURATION_MS, now - firstChunkAt);
			}

			if (message.stopReason === "aborted" || message.stopReason === "error") {
				span.setAttribute(ATTR_AI_ERROR_TYPE, message.stopReason);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: message.errorMessage ?? message.stopReason,
				});
			}

			span.end(now);
			llm = undefined;
		},

		startTool(toolCallId, toolName): void {
			const stale = tools.get(toolCallId);
			if (stale !== undefined) {
				onDropped("tool");
				stale.end();
				tools.delete(toolCallId);
			}
			const parent = turn ?? agentRun ?? root;
			if (parent === undefined) return;
			const span = childSpan(SPAN_HARNESS_TOOL, parent);
			span.setAttribute(ATTR_TOOL_NAME, toolName);
			span.setAttribute(ATTR_TOOL_CALL_ID, toolCallId);
			tools.set(toolCallId, span);
		},

		endTool(toolCallId, isError): void {
			const span = tools.get(toolCallId);
			if (span === undefined) {
				onDropped("tool");
				return;
			}
			span.setAttribute(ATTR_TOOL_IS_ERROR, isError);
			if (isError) span.setStatus({ code: SpanStatusCode.ERROR });
			span.end();
			tools.delete(toolCallId);
		},
	};
}
