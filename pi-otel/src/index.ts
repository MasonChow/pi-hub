/**
 * pi-otel extension entry: wires pi extension events to the OTel pipeline
 * (metrics + traces + logs modules).
 *
 * Cache-neutral by construction: pure listener — no `before_agent_start`
 * subscription, no system-prompt or history writes, and every handler is
 * wrapped in `guard()` so it never throws and never returns a value.
 *
 * All per-session identity (session id, requirement id, resource
 * attributes) is resolved once at `session_start` and frozen; pi destroys
 * and recreates the extension instance on session changes, so this module
 * holds plain closure state.
 */
import type {
	AgentSettledEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	ATTR_AI_MODEL,
	ATTR_AI_PROVIDER,
	ATTR_PROJECT_PATH,
	ATTR_REQUIREMENT_ID,
	ATTR_SESSION_ID,
	ATTR_SESSION_PARENT_ID,
	ATTR_SESSION_REASON,
	ATTR_THINKING_LEVEL,
	ATTR_TOOL_NAME,
} from "./attrs.ts";
import {
	createInterventionClassifier,
	INTERVENTION_BUS_CHANNEL,
} from "./interventions.ts";
import { createEventLogger, type EventLogger } from "./logs.ts";
import { createMetrics, mergeAttrs, type PiMetrics } from "./metrics.ts";
import {
	buildResource,
	guard,
	initOtel,
	recordTelemetryError,
	type OtelHandles,
} from "./otel.ts";
import { registerReqCommand, resolveRequirement } from "./requirement.ts";
import {
	createSessionState,
	getRequirementForCwd,
	type SessionState,
} from "./state.ts";
import { createTraceManager, type TraceManager } from "./traces.ts";
import type {
	InterventionSignal,
	ModelCostOverride,
	PiOtelOptions,
	PiOtelPlugin,
} from "./types.ts";

export type {
	InterventionKind,
	InterventionSignal,
	ModelCostOverride,
	PiOtelExporterOverrides,
	PiOtelOptions,
	PiOtelPlugin,
} from "./types.ts";
export { INTERVENTION_BUS_CHANNEL } from "./interventions.ts";

/**
 * The slice of `ExtensionAPI` pi-otel consumes. pi always passes the full
 * API; tests pass a minimal fake.
 */
export type PiOtelHost = Pick<ExtensionAPI, "on" | "registerCommand" | "events">;

/** Reported when no resolver produced a requirement id (DESIGN §3.3). */
const UNKNOWN_REQUIREMENT = "unknown";

/** `model_select` fields consumed here (the event type is not exported by pi). */
interface ModelSelectLike {
	model: { id: string; provider: string };
	previousModel: { id: string } | undefined;
	source: "set" | "cycle" | "restore";
}

/** `thinking_level_select` fields consumed here (event type not exported by pi). */
interface ThinkingLevelSelectLike {
	level: string;
	previousLevel: string;
}

export function createPiOtel(
	options: PiOtelOptions = {},
): (pi: PiOtelHost) => void {
	const plugins: readonly PiOtelPlugin[] = options.plugins ?? [];
	const classify = createInterventionClassifier(plugins);
	const stateFilePath = options.stateFilePath;

	return (pi: PiOtelHost): void => {
		let handles: OtelHandles | undefined;
		let metrics: PiMetrics | undefined;
		let traces: TraceManager | undefined;
		let logs: EventLogger | undefined;
		let sessionState: SessionState | undefined;
		/** Mutable metric dimensions (model / provider / thinking level). */
		let dims: Record<string, string> = {};
		let inputCount = 0;
		let busyStartedAt: number | undefined;
		let busyAccumMs = 0;
		let turnStartedAt: number | undefined;
		let llmT0: number | undefined;
		let llmFirstChunkAt: number | undefined;
		const toolStarts = new Map<string, { toolName: string; startedAt: number }>();

		function resetSession(): void {
			handles = undefined;
			metrics = undefined;
			traces = undefined;
			logs = undefined;
			sessionState = undefined;
			dims = {};
			inputCount = 0;
			busyStartedAt = undefined;
			busyAccumMs = 0;
			turnStartedAt = undefined;
			llmT0 = undefined;
			llmFirstChunkAt = undefined;
			toolStarts.clear();
		}

		function costOverrideFor(modelId: string): ModelCostOverride | undefined {
			for (const plugin of plugins) {
				const override = plugin.costTable?.[modelId];
				if (override !== undefined) return override;
			}
			return undefined;
		}

		/** Recompute `usage.cost` from a plugin cost table (USD per million tokens). */
		function withCostOverride(usage: Usage, modelId: string): Usage {
			const override = costOverrideFor(modelId);
			if (override === undefined) return usage;
			const input = (usage.input * override.input) / 1_000_000;
			const output = (usage.output * override.output) / 1_000_000;
			const cacheRead = (usage.cacheRead * override.cacheRead) / 1_000_000;
			const cacheWrite = (usage.cacheWrite * override.cacheWrite) / 1_000_000;
			return {
				...usage,
				cost: {
					input,
					output,
					cacheRead,
					cacheWrite,
					total: input + output + cacheRead + cacheWrite,
				},
			};
		}

		function handleSignal(signal: InterventionSignal): void {
			const kind = classify(signal);
			if (kind === null) return;
			metrics?.recordIntervention(kind, dims);
			logs?.intervention({ kind, source: signal.source });
		}

		function sampleContext(ctx: ExtensionContext): void {
			try {
				const usage = ctx.getContextUsage();
				if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) {
					return;
				}
				metrics?.recordContextSample(
					{ tokens: usage.tokens, usageRatio: usage.tokens / usage.contextWindow },
					dims,
				);
			} catch (err) {
				recordTelemetryError(err);
			}
		}

		/** Fail-open session identity: ephemeral (--no-session) may lack a header/file. */
		function readSessionIdentity(ctx: ExtensionContext): {
			sessionId?: string;
			parentSessionId?: string;
		} {
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const header = ctx.sessionManager.getHeader();
				return {
					sessionId: sessionId === "" ? undefined : sessionId,
					parentSessionId: header?.parentSession,
				};
			} catch (err) {
				recordTelemetryError(err);
				return {};
			}
		}

		/** Plain text of the final assistant message, for the question heuristic. */
		function lastAssistantText(ctx: ExtensionContext): string | undefined {
			try {
				const entries = ctx.sessionManager.getBranch();
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i];
					if (entry.type !== "message") continue;
					const message = entry.message;
					if (message.role !== "assistant") continue;
					const parts: string[] = [];
					for (const item of message.content) {
						if (item.type === "text") parts.push(item.text);
					}
					return parts.join("\n");
				}
			} catch (err) {
				recordTelemetryError(err);
			}
			return undefined;
		}

		/**
		 * Plugin redact chain, applied to the session resource attributes.
		 * (Per-signal redaction is not wired yet; resource attributes are
		 * where identity-sensitive values like the project path live.)
		 */
		function applyRedact(attrs: Record<string, string>): Record<string, string> {
			let current: Record<string, unknown> = attrs;
			for (const plugin of plugins) {
				if (plugin.redact === undefined) continue;
				try {
					current = plugin.redact(current);
				} catch (err) {
					recordTelemetryError(err);
				}
			}
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(current)) {
				if (typeof value === "string") out[key] = value;
			}
			return out;
		}

		pi.on(
			"session_start",
			guard(async (event: SessionStartEvent, ctx: ExtensionContext) => {
				resetSession();
				const identity = readSessionIdentity(ctx);
				const stored = getRequirementForCwd(ctx.cwd, stateFilePath);
				const requirementId = resolveRequirement(ctx.cwd, stored);

				let attrs: Record<string, string> = {
					[ATTR_SESSION_REASON]: event.reason,
					[ATTR_PROJECT_PATH]: ctx.cwd,
					[ATTR_REQUIREMENT_ID]: requirementId ?? UNKNOWN_REQUIREMENT,
				};
				if (identity.sessionId !== undefined) {
					attrs[ATTR_SESSION_ID] = identity.sessionId;
				}
				if (identity.parentSessionId !== undefined) {
					attrs[ATTR_SESSION_PARENT_ID] = identity.parentSessionId;
				}
				if (options.serviceName !== undefined) {
					attrs["service.name"] = options.serviceName;
				}
				Object.assign(attrs, options.resourceAttributes);
				for (const plugin of plugins) {
					if (plugin.resolveAttributes === undefined) continue;
					try {
						Object.assign(attrs, await plugin.resolveAttributes(ctx));
					} catch (err) {
						recordTelemetryError(err);
					}
				}
				attrs = applyRedact(attrs);

				sessionState = createSessionState({
					sessionId: identity.sessionId,
					requirementId,
					resourceAttributes: attrs,
				});
				handles = initOtel(await buildResource(attrs), options);
				metrics = createMetrics(handles.meter);
				const currentMetrics = metrics;
				traces = createTraceManager(handles.tracer, sessionState, {
					stateFilePath,
					onDropped: () => currentMetrics.recordDropped(),
				});
				logs = createEventLogger(handles.logger);

				if (ctx.model !== undefined) {
					dims[ATTR_AI_MODEL] = ctx.model.id;
					dims[ATTR_AI_PROVIDER] = ctx.model.provider;
				}
				if (ctx.thinkingLevel !== undefined) {
					dims[ATTR_THINKING_LEVEL] = ctx.thinkingLevel;
				}

				traces.startSession({
					reason: event.reason,
					parentSessionId: identity.parentSessionId,
					cwd: ctx.cwd,
				});
				logs.sessionStart({
					sessionId: identity.sessionId,
					reason: event.reason,
					parentSessionId: identity.parentSessionId,
					requirementId: requirementId ?? UNKNOWN_REQUIREMENT,
				});
				if (event.reason === "fork" && identity.parentSessionId !== undefined) {
					logs.sessionFork({
						sessionId: identity.sessionId,
						parentSessionId: identity.parentSessionId,
					});
				}
			}),
		);

		// The only reliable flush hook: quit/reload/new/resume/fork all pass
		// through here before the extension instance is destroyed.
		pi.on(
			"session_shutdown",
			guard(async (_event: SessionShutdownEvent) => {
				traces?.endSession();
				logs?.sessionShutdown({ sessionId: sessionState?.sessionId });
				await handles?.forceFlushAll();
			}),
		);

		// Compaction LLM usage does not reliably pass message_end, so its
		// cost is folded in here (research §7.2).
		pi.on(
			"session_compact",
			guard((event: SessionCompactEvent) => {
				const entry = event.compactionEntry;
				metrics?.recordCompaction(
					{ tokensBefore: entry.tokensBefore, reason: event.reason, usage: entry.usage },
					dims,
				);
				logs?.sessionCompact({
					sessionId: sessionState?.sessionId,
					reason: event.reason,
					tokensBefore: entry.tokensBefore,
				});
			}),
		);

		pi.on(
			"agent_start",
			guard(() => {
				traces?.startAgentRun();
				busyStartedAt ??= Date.now();
			}),
		);

		pi.on(
			"agent_end",
			guard(() => {
				traces?.endAgentRun();
				if (busyStartedAt !== undefined) {
					busyAccumMs += Date.now() - busyStartedAt;
					busyStartedAt = undefined;
				}
			}),
		);

		// Busy duration spans agent_start → agent_settled, accumulated over
		// the auto-retry / follow-up runs in between (research §7.3).
		pi.on(
			"agent_settled",
			guard((_event: AgentSettledEvent, ctx: ExtensionContext) => {
				if (busyStartedAt !== undefined) {
					busyAccumMs += Date.now() - busyStartedAt;
					busyStartedAt = undefined;
				}
				if (busyAccumMs > 0) {
					metrics?.recordAgentDuration(busyAccumMs, dims);
					busyAccumMs = 0;
				}
				const text = lastAssistantText(ctx);
				if (text !== undefined) {
					handleSignal({ source: "question", lastAssistantText: text });
				}
			}),
		);

		pi.on(
			"turn_start",
			guard((event: TurnStartEvent) => {
				turnStartedAt = event.timestamp;
				traces?.startTurn(event.turnIndex, event.timestamp);
			}),
		);

		pi.on(
			"turn_end",
			guard((_event: TurnEndEvent, ctx: ExtensionContext) => {
				metrics?.recordTurn(dims);
				if (turnStartedAt !== undefined) {
					metrics?.recordTurnDuration(Date.now() - turnStartedAt, dims);
					turnStartedAt = undefined;
				}
				traces?.endTurn();
				sampleContext(ctx);
			}),
		);

		// TTFT t0: payload assembled and about to be sent (research §3.3).
		pi.on(
			"before_provider_request",
			guard((_event: BeforeProviderRequestEvent) => {
				llmT0 = Date.now();
				llmFirstChunkAt = undefined;
				traces?.startLlmRequest();
			}),
		);

		pi.on(
			"message_start",
			guard((event: MessageStartEvent) => {
				if (event.message.role !== "assistant") return;
				// Fallback t0 when before_provider_request was not observed.
				llmT0 ??= Date.now();
			}),
		);

		pi.on(
			"message_update",
			guard((_event: MessageUpdateEvent) => {
				traces?.recordStreamChunk();
				if (llmFirstChunkAt === undefined) {
					llmFirstChunkAt = Date.now();
					if (llmT0 !== undefined) {
						metrics?.recordTtft(llmFirstChunkAt - llmT0, dims);
					}
				}
			}),
		);

		// message_end also fires for user/toolResult messages — assistant only.
		pi.on(
			"message_end",
			guard((event: MessageEndEvent) => {
				const message = event.message;
				if (message.role !== "assistant") return;
				const now = Date.now();
				const attrs = mergeAttrs(dims, {
					[ATTR_AI_MODEL]: message.model,
					[ATTR_AI_PROVIDER]: message.provider,
				});
				metrics?.recordUsage(withCostOverride(message.usage, message.model), attrs);
				if (llmT0 !== undefined) {
					metrics?.recordLlmDuration(now - llmT0, attrs);
				}
				if (llmFirstChunkAt !== undefined) {
					metrics?.recordStreamingDuration(now - llmFirstChunkAt, attrs);
				}
				llmT0 = undefined;
				llmFirstChunkAt = undefined;
				traces?.endLlmRequest(message);
				if (message.stopReason === "aborted") {
					handleSignal({ source: "abort", message });
				} else if (message.stopReason === "error") {
					// Provider failure (auto-retried by pi) — an error, not an intervention.
					metrics?.recordError("llm", message.stopReason, attrs);
					logs?.agentError({ errorType: "llm_error" });
				}
			}),
		);

		pi.on(
			"tool_execution_start",
			guard((event: ToolExecutionStartEvent) => {
				toolStarts.set(event.toolCallId, {
					toolName: event.toolName,
					startedAt: Date.now(),
				});
				traces?.startTool(event.toolCallId, event.toolName);
			}),
		);

		pi.on(
			"tool_execution_end",
			guard((event: ToolExecutionEndEvent) => {
				const started = toolStarts.get(event.toolCallId);
				toolStarts.delete(event.toolCallId);
				if (started !== undefined) {
					metrics?.recordToolDuration(
						Date.now() - started.startedAt,
						{ toolName: event.toolName, isError: event.isError },
						dims,
					);
				}
				traces?.endTool(event.toolCallId, event.isError);
				if (event.isError) {
					metrics?.recordError(
						"tool",
						undefined,
						mergeAttrs(dims, { [ATTR_TOOL_NAME]: event.toolName }),
					);
					logs?.toolError({
						toolName: event.toolName,
						toolCallId: event.toolCallId,
					});
				}
			}),
		);

		pi.on(
			"input",
			guard((event: InputEvent) => {
				// Extension-injected input is automation, not a human coming back.
				if (event.source === "extension") return;
				inputCount += 1;
				handleSignal({ source: "input", event, inputIndex: inputCount });
			}),
		);

		pi.on(
			"model_select",
			guard((event: ModelSelectLike) => {
				dims[ATTR_AI_MODEL] = event.model.id;
				dims[ATTR_AI_PROVIDER] = event.model.provider;
				logs?.modelSelect({
					model: event.model.id,
					previousModel: event.previousModel?.id,
					source: event.source,
				});
			}),
		);

		pi.on(
			"thinking_level_select",
			guard((event: ThinkingLevelSelectLike) => {
				dims[ATTR_THINKING_LEVEL] = event.level;
				logs?.thinkingLevelSelect({
					level: event.level,
					previousLevel: event.previousLevel,
				});
			}),
		);

		// Approval-gate extensions publish interventions on this bus channel
		// (pi core has no approval events, research §3.1).
		pi.events.on(
			INTERVENTION_BUS_CHANNEL,
			guard((data: unknown) => {
				handleSignal({
					source: "bus",
					channel: INTERVENTION_BUS_CHANNEL,
					data,
				});
			}),
		);

		registerReqCommand(pi, {
			getSessionState: () => sessionState,
			stateFilePath,
		});
	};
}

export default createPiOtel();
