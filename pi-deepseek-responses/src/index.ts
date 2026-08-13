import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's extension loader only virtualizes `@earendil-works/pi-ai` and
// `@earendil-works/pi-ai/compat` (not `/api/*` subpaths). Import the
// compat-exported stream helpers so both jiti extension loading and bare
// Node unit tests resolve the same entrypoint.
import {
  streamSimpleOpenAICompletions as defaultStreamOpenAICompletions,
  streamSimpleOpenAIResponses as defaultStreamOpenAIResponses,
} from "@earendil-works/pi-ai/compat";

const DEEPSEEK_RESPONSES_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

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

/** Stream adapters used by the transport dispatcher. Injectable for unit tests. */
export type DeepSeekStreamAdapters = {
  streamOpenAIResponses: typeof defaultStreamOpenAIResponses;
  streamOpenAICompletions: typeof defaultStreamOpenAICompletions;
};

const defaultStreamAdapters: DeepSeekStreamAdapters = {
  streamOpenAIResponses: defaultStreamOpenAIResponses,
  streamOpenAICompletions: defaultStreamOpenAICompletions,
};

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

/**
 * DeepSeek's Responses API is currently model-gated. Keep this explicit so
 * installing the extension never breaks catalog models that still require
 * /chat/completions.
 */
export function supportsDeepSeekResponses(
  model: Pick<Model<Api>, "provider" | "id">,
): boolean {
  return model.provider === "deepseek" && DEEPSEEK_RESPONSES_MODELS.has(model.id);
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

/**
 * Build SimpleStreamOptions for the Responses path: force cacheRetention off
 * and wrap onPayload so DeepSeek sanitization re-runs after any upstream hook.
 * Exported for unit tests that assert final wire-payload behavior.
 */
export function buildDeepSeekResponsesStreamOptions(
  options?: SimpleStreamOptions,
): SimpleStreamOptions {
  const webSearch = isWebSearchEnabled(options);
  const debug = isDebugEnabled(options);
  const upstreamOnPayload = options?.onPayload;

  return {
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
  };
}

export function streamDeepSeekResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  adapters: DeepSeekStreamAdapters = defaultStreamAdapters,
) {
  const responseModel = toResponsesModel(model);
  const webSearch = isWebSearchEnabled(options);
  const debug = isDebugEnabled(options);

  if (debug) {
    console.error(
      `[pi-deepseek-responses] provider=${model.provider} model=${model.id} api=openai-responses web_search=${webSearch ? "enabled" : "disabled"}`,
    );
  }

  return adapters.streamOpenAIResponses(
    responseModel,
    context,
    buildDeepSeekResponsesStreamOptions(options),
  );
}

/**
 * Route only models confirmed to support DeepSeek Responses through /responses.
 * All other official DeepSeek models retain Pi's original completions behavior.
 */
export function streamDeepSeekTransport(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  adapters: DeepSeekStreamAdapters = defaultStreamAdapters,
) {
  if (!supportsDeepSeekResponses(model)) {
    if (isDebugEnabled(options)) {
      console.error(
        `[pi-deepseek-responses] provider=${model.provider} model=${model.id} api=openai-completions responses=unsupported`,
      );
    }
    return adapters.streamOpenAICompletions(
      model as Model<"openai-completions">,
      context,
      options,
    );
  }

  return streamDeepSeekResponses(model, context, options, adapters);
}

export default function deepSeekResponsesExtension(pi: ExtensionAPI): void {
  // Keep Pi's built-in DeepSeek model catalog, base URL and authentication.
  // Matching the existing `openai-completions` API is intentional: provider
  // composition routes official DeepSeek models into this transport dispatcher,
  // which upgrades only Responses-capable models and delegates the rest back to
  // Pi's original completions adapter.
  pi.registerProvider("deepseek", {
    api: "openai-completions",
    streamSimple: streamDeepSeekTransport,
  });
}
