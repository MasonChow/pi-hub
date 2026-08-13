/**
 * Attribute keys and span names used by pi-otel.
 *
 * Sources:
 * - "official": copied verbatim from `@earendil-works/pi-agent-core`
 *   `AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA` (harness/telemetry.d.ts).
 *   pi's CLI does not wire these schemas yet; matching them keeps our data
 *   mergeable if the official telemetry ever ships.
 * - "ours": pi-otel-defined keys under the same `pi.*` namespace, for
 *   dimensions the official schemas do not cover.
 * - "genai-semconv": OTel GenAI semantic-convention compatibility keys.
 */

// --- official: AI_TELEMETRY_SCHEMA (span "pi.ai.request") ---

export const ATTR_AI_OPERATION = "pi.ai.operation";
export const ATTR_AI_PROVIDER = "pi.ai.provider";
export const ATTR_AI_MODEL = "pi.ai.model";
export const ATTR_AI_API = "pi.ai.api";
export const ATTR_AI_STREAMING = "pi.ai.streaming";
export const ATTR_AI_DEFERRED = "pi.ai.deferred";
export const ATTR_AI_RESPONSE_MODEL = "pi.ai.response.model";
export const ATTR_AI_RESPONSE_ID = "pi.ai.response.id";
export const ATTR_AI_RESPONSE_STOP_REASON = "pi.ai.response.stop_reason";
export const ATTR_AI_HTTP_STATUS_CODE = "pi.ai.http.status_code";
export const ATTR_AI_USAGE_INPUT_TOKENS = "pi.ai.usage.input_tokens";
export const ATTR_AI_USAGE_OUTPUT_TOKENS = "pi.ai.usage.output_tokens";
export const ATTR_AI_USAGE_CACHE_READ_TOKENS = "pi.ai.usage.cache_read_tokens";
export const ATTR_AI_USAGE_CACHE_WRITE_TOKENS = "pi.ai.usage.cache_write_tokens";
export const ATTR_AI_USAGE_REASONING_TOKENS = "pi.ai.usage.reasoning_tokens";
export const ATTR_AI_USAGE_TOTAL_TOKENS = "pi.ai.usage.total_tokens";
export const ATTR_AI_USAGE_COST = "pi.ai.usage.cost";
export const ATTR_AI_STREAM_CHUNK_COUNT = "pi.ai.stream.chunk_count";
export const ATTR_AI_STREAM_TIME_TO_FIRST_CHUNK_MS =
	"pi.ai.stream.time_to_first_chunk_ms";
export const ATTR_AI_ERROR_TYPE = "pi.ai.error.type";

// --- official: HARNESS_TELEMETRY_SCHEMA ---

export const ATTR_SESSION_ID = "pi.session.id";
export const ATTR_LANE_NAME = "pi.lane.name";
export const ATTR_OPERATION_ID = "pi.operation.id";
export const ATTR_OPERATION_RECOVERY = "pi.operation.recovery";
export const ATTR_OPERATION_KIND = "pi.operation.kind";
export const ATTR_OPERATION_OUTCOME = "pi.operation.outcome";
export const ATTR_ERROR_CODE = "pi.error.code";
export const ATTR_ERROR_TYPE = "pi.error.type";
export const ATTR_CHECKPOINT_KIND = "pi.checkpoint.kind";
export const ATTR_TURN_ID = "pi.turn.id";
export const ATTR_STEP_KIND = "pi.step.kind";
export const ATTR_STEP_ATTEMPT = "pi.step.attempt";
export const ATTR_STEP_OUTCOME = "pi.step.outcome";
export const ATTR_COMPACTION_REASON = "pi.compaction.reason";
export const ATTR_TOOL_NAME = "pi.tool.name";
export const ATTR_TOOL_CALL_ID = "pi.tool.call_id";
export const ATTR_TOOL_REPLAY = "pi.tool.replay";
export const ATTR_TOOL_RECOVERY = "pi.tool.recovery";
export const ATTR_TOOL_IS_ERROR = "pi.tool.is_error";
export const ATTR_HOOK_NAME = "pi.hook.name";
export const ATTR_HOOK_REGISTRATION_ID = "pi.hook.registration_id";
export const ATTR_HOOK_OUTCOME = "pi.hook.outcome";
export const ATTR_SLEEP_DELAY_MS = "pi.sleep.delay_ms";
export const ATTR_SLEEP_OUTCOME = "pi.sleep.outcome";
export const ATTR_EVENT_TYPE = "pi.event.type";
export const ATTR_SESSION_MUTATION = "pi.session.mutation";
export const ATTR_SESSION_ITEM_TYPE = "pi.session.item_type";
export const ATTR_SESSION_SEQ = "pi.session.seq";

// --- official: span names (both schemas) ---

export const SPAN_AI_REQUEST = "pi.ai.request";
export const SPAN_HARNESS_RUN = "pi.harness.run";
export const SPAN_HARNESS_COMPACTION = "pi.harness.compaction";
export const SPAN_HARNESS_NAVIGATION = "pi.harness.navigation";
export const SPAN_HARNESS_CHECKPOINT = "pi.harness.checkpoint";
export const SPAN_HARNESS_TURN = "pi.harness.turn";
export const SPAN_HARNESS_STEP = "pi.harness.step";
export const SPAN_HARNESS_TOOL = "pi.harness.tool";
export const SPAN_HARNESS_HOOK = "pi.harness.hook";
export const SPAN_HARNESS_SLEEP = "pi.harness.sleep";
export const SPAN_HARNESS_EVENT_HANDLER = "pi.harness.event_handler";
export const SPAN_SESSION_WRITE = "pi.session.write";

// --- ours ---

/** Requirement (work item) the session is bound to; "unknown" when unresolved. */
export const ATTR_REQUIREMENT_ID = "pi.requirement.id";
/** Session id of the fork parent (session header `parentSession`). */
export const ATTR_SESSION_PARENT_ID = "pi.session.parent_id";
/** `session_start` reason: startup | reload | new | resume | fork. */
export const ATTR_SESSION_REASON = "pi.session.reason";
/** pi CLI version (VERSION export of @earendil-works/pi-coding-agent). */
export const ATTR_PI_VERSION = "pi.version";
/** Project working directory the session runs in. */
export const ATTR_PROJECT_PATH = "pi.project.path";
/** Zero-based turn index within an agent run. */
export const ATTR_TURN_INDEX = "pi.turn.index";
/** Thinking level: off | minimal | low | medium | high | xhigh | max. */
export const ATTR_THINKING_LEVEL = "pi.thinking_level";
/**
 * Token counter dimension: input | output | cache_read | cache_write |
 * cache_write_1h | reasoning. `reasoning` ⊂ `output` and `cache_write_1h`
 * ⊂ `cache_write` — exclude the subsets when totalling.
 */
export const ATTR_TOKEN_TYPE = "pi.token.type";
/** Intervention counter dimension (see InterventionKind). */
export const ATTR_INTERVENTION_KIND = "pi.intervention.kind";
/**
 * `pi.turn.phase.duration` dimension: ttft | streaming | tool | wait. The
 * four phases of one turn sum to that turn's `pi.turn.duration`.
 */
export const ATTR_TURN_PHASE = "pi.turn.phase";

// --- genai-semconv (compatibility subset on LLM spans) ---

export const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS =
	"gen_ai.response.finish_reasons";
