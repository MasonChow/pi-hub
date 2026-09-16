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
  streamSimpleAnthropic as defaultStreamAnthropic,
  streamSimpleOpenAICompletions as defaultStreamOpenAICompletions,
} from "@earendil-works/pi-ai/compat";

/**
 * DeepSeek 按「代际 + 档位」开放能力：`deepseek-flash`（V4.1 Flash）/
 * `deepseek-v4-pro`，外加指向最新代际的无版本别名。用模式匹配代替硬编码清单，
 * 新别名与新代际不用改代码。`deepseek-chat` / `deepseek-reasoner` 等旧模型不匹配。
 */
const DEEPSEEK_SEARCH_MODEL_PATTERN = /^deepseek-(?:v\d+-)?(?:flash|pro)$/;

/**
 * DeepSeek 的 server-side web search 只活在 Anthropic 兼容端点上。
 * OpenAI 兼容的 /responses 会解析 `{type:"web_search"}` 却不执行它
 * （官方兼容表把 web_search 等 built-in tools 标为 Ignored），所以走搜索
 * 必须换到这个 base URL。
 */
const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

/** Anthropic Messages 协议里 server-side 搜索的工具标识。 */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" } as const;

/** Stream adapters used by the transport dispatcher. Injectable for unit tests. */
export type DeepSeekStreamAdapters = {
  streamAnthropic: typeof defaultStreamAnthropic;
  streamOpenAICompletions: typeof defaultStreamOpenAICompletions;
};

const defaultStreamAdapters: DeepSeekStreamAdapters = {
  streamAnthropic: defaultStreamAnthropic,
  streamOpenAICompletions: defaultStreamOpenAICompletions,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envFlag(options: SimpleStreamOptions | undefined, name: string, fallback: boolean): boolean {
  const value = options?.env?.[name] ?? process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

/**
 * Gate the Anthropic-endpoint detour on models confirmed to serve DeepSeek's
 * server-side search, so installing the extension never breaks catalog models
 * that still require /chat/completions.
 */
export function supportsDeepSeekWebSearch(
  model: Pick<Model<Api>, "provider" | "id">,
): boolean {
  return model.provider === "deepseek" && DEEPSEEK_SEARCH_MODEL_PATTERN.test(model.id);
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
    return typeof tool.type === "string" && tool.type.startsWith("web_search");
  });
}

/**
 * Append DeepSeek's provider-managed web_search tool without touching Pi's
 * function tools. DeepSeek silently ignores the request fields it does not
 * support (top_k, service_tier, container, mcp_servers), so no field stripping
 * is needed here.
 */
export function prepareDeepSeekAnthropicPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  if (hasNativeWebSearchTool(tools)) return payload;

  tools.push({ ...WEB_SEARCH_TOOL });
  return { ...payload, tools };
}

/**
 * Reuse Pi's Anthropic Messages adapter while keeping the outer provider as
 * `deepseek`, so Pi's catalog/auth behavior is untouched and only the wire
 * protocol and base URL change.
 */
export function toAnthropicModel(model: Model<Api>): Model<"anthropic-messages"> {
  return {
    ...model,
    api: "anthropic-messages",
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    input: ["text", "image"],
  } as Model<"anthropic-messages">;
}

/**
 * Wrap onPayload so the web_search tool is re-appended after any upstream hook.
 * Exported for unit tests that assert final wire-payload behavior.
 */
export function buildDeepSeekAnthropicStreamOptions(
  options?: SimpleStreamOptions,
): SimpleStreamOptions {
  const debug = isDebugEnabled(options);
  const upstreamOnPayload = options?.onPayload;

  return {
    ...options,
    // DeepSeek manages prefix caching automatically and does not accept
    // Anthropic's cache_control breakpoints.
    cacheRetention: "none",
    onPayload: async (payload, requestModel) => {
      let next = prepareDeepSeekAnthropicPayload(payload);

      if (upstreamOnPayload) {
        const replacement = await upstreamOnPayload(next, requestModel);
        if (replacement !== undefined) next = replacement;
      }

      // Re-apply after other request hooks so web_search stays idempotent and
      // survives extensions that rewrite the tool list.
      next = prepareDeepSeekAnthropicPayload(next);

      if (debug && isRecord(next)) {
        const toolTypes = Array.isArray(next.tools)
          ? next.tools
              .map((tool) => (isRecord(tool) && typeof tool.type === "string" ? tool.type : "function"))
              .join(",")
          : "none";
        console.error(`[pi-deepseek-responses] request tools=${toolTypes}`);
      }

      return next;
    },
  };
}

export function streamDeepSeekAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  adapters: DeepSeekStreamAdapters = defaultStreamAdapters,
) {
  const anthropicModel = toAnthropicModel(model);

  if (isDebugEnabled(options)) {
    console.error(
      `[pi-deepseek-responses] provider=${model.provider} model=${model.id} api=anthropic-messages web_search=enabled`,
    );
  }

  return adapters.streamAnthropic(
    anthropicModel,
    context,
    buildDeepSeekAnthropicStreamOptions(options),
  );
}

/**
 * Route search-capable models through the Anthropic endpoint only while web
 * search is on. Everything else keeps Pi's original completions behavior —
 * the detour buys nothing without server-side search.
 */
export function streamDeepSeekTransport(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  adapters: DeepSeekStreamAdapters = defaultStreamAdapters,
) {
  const webSearch = isWebSearchEnabled(options);

  if (!webSearch || !supportsDeepSeekWebSearch(model)) {
    if (isDebugEnabled(options)) {
      const why = webSearch ? "model=unsupported" : "web_search=disabled";
      console.error(
        `[pi-deepseek-responses] provider=${model.provider} model=${model.id} api=openai-completions ${why}`,
      );
    }
    return adapters.streamOpenAICompletions(
      model as Model<"openai-completions">,
      context,
      options,
    );
  }

  return streamDeepSeekAnthropic(model, context, options, adapters);
}

export default function deepSeekResponsesExtension(pi: ExtensionAPI): void {
  // Keep Pi's built-in DeepSeek model catalog, base URL and authentication.
  // Matching the existing `openai-completions` API is intentional: provider
  // composition routes official DeepSeek models into this transport dispatcher,
  // which detours only search-capable models to the Anthropic endpoint and
  // delegates the rest back to Pi's original completions adapter.
  pi.registerProvider("deepseek", {
    api: "openai-completions",
    streamSimple: streamDeepSeekTransport,
  });
}
