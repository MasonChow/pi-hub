import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext, Type } from "@earendil-works/pi-ai";
import type { TranscriptContext, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import deepSeekResponsesExtension, {
  buildDeepSeekAnthropicStreamOptions,
  hasNativeWebSearchTool,
  prepareDeepSeekAnthropicPayload,
  streamDeepSeekTransport,
  supportsDeepSeekWebSearch,
  toAnthropicModel,
  type DeepSeekStreamAdapters,
} from "../src/index.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const emptyContext = normalizeContext({ messages: [] });
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search" };

function deepseekModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

function mockAdapters() {
  const calls: {
    anthropic: Array<{ model: Model<"anthropic-messages">; context: TranscriptContext; options?: SimpleStreamOptions }>;
    completions: Array<{ model: Model<"openai-completions">; context: TranscriptContext; options?: SimpleStreamOptions }>;
  } = { anthropic: [], completions: [] };

  const adapters = {
    streamAnthropic(model, context, options) {
      calls.anthropic.push({ model, context, options });
      return "anthropic-stream" as never;
    },
    streamOpenAICompletions(model, context, options) {
      calls.completions.push({ model, context, options });
      return "completions-stream" as never;
    },
  } satisfies DeepSeekStreamAdapters;

  return { adapters, calls };
}

test("web_search tool is appended without touching function tools", () => {
  const payload = prepareDeepSeekAnthropicPayload({
    model: "deepseek-flash",
    tools: [{ name: "bash", input_schema: {} }],
  }) as Record<string, unknown>;

  assert.deepEqual(payload.tools, [{ name: "bash", input_schema: {} }, WEB_SEARCH]);
  assert.equal(payload.model, "deepseek-flash");
});

test("web_search injection is idempotent", () => {
  const once = prepareDeepSeekAnthropicPayload({ tools: [] });
  const twice = prepareDeepSeekAnthropicPayload(once) as Record<string, unknown>;

  assert.deepEqual(twice.tools, [WEB_SEARCH]);
});

test("any web_search_* tool variant counts as native search", () => {
  assert.equal(hasNativeWebSearchTool([{ type: "web_search_20250305" }]), true);
  assert.equal(hasNativeWebSearchTool([{ type: "web_search" }]), true);
  assert.equal(hasNativeWebSearchTool([{ type: "web_search_20991231" }]), true);
  assert.equal(hasNativeWebSearchTool([{ name: "bash" }]), false);
  assert.equal(hasNativeWebSearchTool([]), false);
});

test("payload with no tools key still gets web_search", () => {
  const payload = prepareDeepSeekAnthropicPayload({ model: "deepseek-flash" }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(payload.tools, [WEB_SEARCH]);
});

test("non-object payload passes through", () => {
  assert.equal(prepareDeepSeekAnthropicPayload("hello"), "hello");
});

test("search capability is gated by official provider and flash/pro model pattern", () => {
  for (const id of [
    // 服务端 /models 当前返回的两个
    "deepseek-flash",
    "deepseek-v4-pro",
    // 未来代际自动覆盖，不用改代码
    "deepseek-v5-flash",
    "deepseek-pro",
  ]) {
    assert.equal(supportsDeepSeekWebSearch({ provider: "deepseek", id }), true, id);
  }

  for (const id of [
    // completions-only 旧模型
    "deepseek-chat",
    "deepseek-reasoner",
    "future-model",
    // 不能被前缀/子串误匹配
    "deepseek-v4-flash-vision-exp",
    "my-deepseek-flash",
  ]) {
    assert.equal(supportsDeepSeekWebSearch({ provider: "deepseek", id }), false, id);
  }

  assert.equal(
    supportsDeepSeekWebSearch({ provider: "openrouter", id: "deepseek-flash" }),
    false,
  );
});

test("toAnthropicModel swaps protocol and base URL but keeps catalog metadata", () => {
  const model = deepseekModel("deepseek-flash");
  const result = toAnthropicModel(model);

  assert.equal(result.api, "anthropic-messages");
  // server-side web search 只存在于 Anthropic 兼容端点
  assert.equal(result.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.id, model.id);
  assert.equal(result.contextWindow, model.contextWindow);
  assert.deepEqual(result.cost, model.cost);
  assert.deepEqual(result.input, ["text", "image"]);
});

test("extension overrides only the existing deepseek transport dispatcher", () => {
  let registration: { name: string; config: Record<string, unknown> } | undefined;
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>) {
      registration = { name, config };
    },
  } as unknown as ExtensionAPI;

  deepSeekResponsesExtension(pi);

  assert.ok(registration);
  assert.equal(registration.name, "deepseek");
  assert.equal(registration.config.api, "openai-completions");
  assert.equal(typeof registration.config.streamSimple, "function");
  assert.equal("models" in registration.config, false);
  assert.equal("baseUrl" in registration.config, false);
});

test("transport detours search-capable models to Anthropic, everything else to Completions", () => {
  const { adapters, calls } = mockAdapters();

  const flash = streamDeepSeekTransport(
    deepseekModel("deepseek-flash"),
    emptyContext,
    undefined,
    adapters,
  );
  const pro = streamDeepSeekTransport(
    deepseekModel("deepseek-v4-pro"),
    emptyContext,
    undefined,
    adapters,
  );
  const unknown = streamDeepSeekTransport(
    deepseekModel("future-model"),
    emptyContext,
    undefined,
    adapters,
  );

  assert.equal(flash, "anthropic-stream");
  assert.equal(pro, "anthropic-stream");
  assert.equal(unknown, "completions-stream");
  assert.equal(calls.anthropic.length, 2);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.anthropic[0]?.model.api, "anthropic-messages");
  assert.equal(calls.anthropic[0]?.model.id, "deepseek-flash");
  assert.equal(calls.anthropic[1]?.model.id, "deepseek-v4-pro");
  assert.equal(calls.completions[0]?.model.id, "future-model");
  // fallback 必须保留原始 catalog 的 baseUrl，不能被改成 /anthropic
  assert.equal(calls.completions[0]?.model.baseUrl, "https://api.deepseek.com");
});

test("PI_DEEPSEEK_WEB_SEARCH=0 keeps search-capable models on Pi's original completions", () => {
  const { adapters, calls } = mockAdapters();

  const result = streamDeepSeekTransport(
    deepseekModel("deepseek-flash"),
    emptyContext,
    { env: { PI_DEEPSEEK_WEB_SEARCH: "0" } } as SimpleStreamOptions,
    adapters,
  );

  assert.equal(result, "completions-stream");
  assert.equal(calls.anthropic.length, 0);
  assert.equal(calls.completions[0]?.model.api, "openai-completions");
});

test("both transports preserve Pi's normalized system prompt and tool declarations", () => {
  const context = normalizeContext({
    systemPrompt: "Keep the session instructions stable.",
    tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
    messages: [{ role: "user", content: "Read README.md", timestamp: 0 }],
  });

  for (const id of ["deepseek-flash", "future-model"]) {
    const { adapters, calls } = mockAdapters();
    streamDeepSeekTransport(deepseekModel(id), context, undefined, adapters);
    const received = calls.anthropic[0]?.context ?? calls.completions[0]?.context;
    assert.equal(received, context, id);
    assert.ok(received);
    assert.equal(getCurrentSystemPrompt(received.messages), "Keep the session instructions stable.");
    assert.deepEqual(getCurrentTools(received.messages).map((tool) => tool.name), ["read"]);
  }
});

test("Anthropic path forces cacheRetention none and re-appends web_search after upstream onPayload", async () => {
  const { adapters, calls } = mockAdapters();
  const requestModel = toAnthropicModel(deepseekModel("deepseek-flash"));

  streamDeepSeekTransport(
    deepseekModel("deepseek-flash"),
    emptyContext,
    {
      cacheRetention: "long",
      onPayload: async (payload) => ({
        ...(payload as Record<string, unknown>),
        // upstream hook 把工具列表整个换掉，web_search 必须被补回来
        tools: [{ name: "bash", input_schema: {} }],
      }),
    },
    adapters,
  );

  assert.equal(calls.anthropic.length, 1);
  const options = calls.anthropic[0]?.options;
  assert.ok(options);
  assert.equal(options.cacheRetention, "none");

  const finalPayload = (await options.onPayload?.(
    { tools: [{ name: "read", input_schema: {} }] },
    requestModel,
  )) as Record<string, unknown>;

  assert.deepEqual(finalPayload.tools, [{ name: "bash", input_schema: {} }, WEB_SEARCH]);
});

test("buildDeepSeekAnthropicStreamOptions re-applies web_search after upstream removes it", async () => {
  const options = buildDeepSeekAnthropicStreamOptions({
    onPayload: async () => ({ tools: [{ name: "read", input_schema: {} }] }),
  });

  assert.equal(options.cacheRetention, "none");
  const finalPayload = (await options.onPayload?.(
    { tools: [WEB_SEARCH] },
    toAnthropicModel(deepseekModel("deepseek-flash")),
  )) as Record<string, unknown>;

  assert.deepEqual(finalPayload.tools, [{ name: "read", input_schema: {} }, WEB_SEARCH]);
});

test("source keeps Pi-loader-safe pi-ai imports (no /api/* subpaths)", () => {
  const source = readFileSync(join(packageRoot, "src/index.ts"), "utf8");
  assert.equal(
    /@earendil-works\/pi-ai\/api\//.test(source),
    false,
    "must not import @earendil-works/pi-ai/api/* (jiti appends onto compat.js and breaks extension load)",
  );
  assert.match(
    source,
    /from ["']@earendil-works\/pi-ai\/compat["']/,
    "must import stream helpers from @earendil-works/pi-ai/compat",
  );

  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    pi?: { extensions?: string[] };
  };
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
});
