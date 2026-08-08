import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";

const UNSUPPORTED_TOP_LEVEL_FIELDS = [
  "store",
  "background",
  "metadata",
  "include",
  "prompt",
  "truncation",
  "service_tier",
  "safety_identifier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
  "context_management",
  "stream_options",
  "previous_response_id",
  "conversation",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  return options?.env?.[name] ?? process.env[name];
}

function envFlag(options: SimpleStreamOptions | undefined, name: string, fallback: boolean): boolean {
  const value = envValue(options, name);
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export function isWebSearchEnabled(options?: SimpleStreamOptions): boolean {
  return envFlag(options, "PI_DEEPSEEK_WEB_SEARCH", true);
}

export function isDebugEnabled(options?: SimpleStreamOptions): boolean {
  return envFlag(options, "PI_DEEPSEEK_RESPONSES_DEBUG", false);
}

export function hasNativeWebSearchTool(tools: unknown[]): boolean {
  return tools.some((tool) => {
    if (!isRecord(tool)) return false;
    return tool.type === "web_search" || tool.type === "web_search_2025_08_26";
  });
}

/**
 * Keep the final wire payload inside DeepSeek's documented Responses subset and
 * append DeepSeek's provider-managed web_search tool without touching Pi's
 * function tools.
 */
export function prepareDeepSeekResponsesPayload(payload: unknown, webSearch = true): unknown {
  if (!isRecord(payload)) return payload;

  const next: Record<string, unknown> = { ...payload };
  for (const field of UNSUPPORTED_TOP_LEVEL_FIELDS) delete next[field];

  if (isRecord(next.reasoning)) {
    const effort = next.reasoning.effort;
    if (effort !== undefined) next.reasoning = { effort };
    else delete next.reasoning;
  }

  if (webSearch) {
    const tools = Array.isArray(next.tools) ? [...next.tools] : [];
    if (!hasNativeWebSearchTool(tools)) tools.push({ type: "web_search" });
    next.tools = tools;
  }

  return next;
}

/**
 * Reuse Pi's OpenAI Responses adapter while presenting the request as a
 * DeepSeek-compatible Responses model. The outer provider remains `deepseek`,
 * so Pi keeps its official catalog/auth behavior.
 */
export function toResponsesModel(model: Model<Api>): Model<"openai-responses"> {
  return {
    ...model,
    api: "openai-responses",
    compat: {
      supportsDeveloperRole: true,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsExplicitPromptCacheMode: false,
    },
  } as Model<"openai-responses">;
}

export function streamDeepSeekResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const responseModel = toResponsesModel(model);
  const webSearch = isWebSearchEnabled(options);
  const debug = isDebugEnabled(options);
  const upstreamOnPayload = options?.onPayload;

  if (debug) {
    console.error(
      `[pi-deepseek-responses] provider=${model.provider} model=${model.id} api=openai-responses web_search=${webSearch ? "enabled" : "disabled"}`,
    );
  }

  return streamOpenAIResponses(responseModel, context, {
    ...options,
    // DeepSeek manages prefix caching automatically and does not accept OpenAI's
    // prompt-cache request fields.
    cacheRetention: "none",
    onPayload: async (payload, requestModel) => {
      let next = prepareDeepSeekResponsesPayload(payload, webSearch);

      if (upstreamOnPayload) {
        const replacement = await upstreamOnPayload(next, requestModel);
        if (replacement !== undefined) next = replacement;
      }

      // Re-apply the compatibility layer after other request hooks so the final
      // payload sent to api.deepseek.com remains valid and web_search stays
      // idempotent.
      next = prepareDeepSeekResponsesPayload(next, webSearch);

      if (debug && isRecord(next)) {
        const toolTypes = Array.isArray(next.tools)
          ? next.tools
              .map((tool) => (isRecord(tool) && typeof tool.type === "string" ? tool.type : "unknown"))
              .join(",")
          : "none";
        console.error(`[pi-deepseek-responses] request tools=${toolTypes}`);
      }

      return next;
    },
  });
}

export default function deepSeekResponsesExtension(pi: ExtensionAPI): void {
  // Keep Pi's built-in DeepSeek model catalog, base URL and authentication.
  // Matching the existing `openai-completions` API is intentional: provider
  // composition then routes every built-in DeepSeek model into this custom
  // stream handler, where we internally call Pi's Responses adapter.
  pi.registerProvider("deepseek", {
    api: "openai-completions",
    streamSimple: streamDeepSeekResponses,
  });
}
