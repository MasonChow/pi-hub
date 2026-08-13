import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import deepSeekResponsesExtension, {
  buildDeepSeekResponsesStreamOptions,
  hasNativeWebSearchTool,
  prepareDeepSeekResponsesPayload,
  streamDeepSeekTransport,
  supportsDeepSeekResponses,
  toResponsesModel,
  type DeepSeekStreamAdapters,
} from "../src/index.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const emptyContext = { messages: [] } as Context;

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
    responses: Array<{ model: Model<"openai-responses">; options?: SimpleStreamOptions }>;
    completions: Array<{ model: Model<"openai-completions">; options?: SimpleStreamOptions }>;
  } = { responses: [], completions: [] };

  const adapters = {
    streamOpenAIResponses(model, _context, options) {
      calls.responses.push({ model, options });
      return "responses-stream" as never;
    },
    streamOpenAICompletions(model, _context, options) {
      calls.completions.push({ model, options });
      return "completions-stream" as never;
    },
  } satisfies DeepSeekStreamAdapters;

  return { adapters, calls };
}

test("prepareDeepSeekResponsesPayload removes unsupported OpenAI fields", () => {
  const payload = prepareDeepSeekResponsesPayload({
    model: "deepseek-v4-flash",
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "session",
    prompt_cache_retention: "24h",
    service_tier: "priority",
    tools: [{ type: "function", name: "bash" }],
    reasoning: { effort: "high", summary: "auto" },
  }) as Record<string, unknown>;

  assert.equal(payload.store, undefined);
  assert.equal(payload.include, undefined);
  assert.equal(payload.prompt_cache_key, undefined);
  assert.equal(payload.prompt_cache_retention, undefined);
  assert.equal(payload.service_tier, undefined);
  assert.deepEqual(payload.reasoning, { effort: "high" });
  assert.deepEqual(payload.tools, [
    { type: "function", name: "bash" },
    { type: "web_search" },
  ]);
});

test("web_search injection is idempotent", () => {
  const payload = prepareDeepSeekResponsesPayload({
    tools: [{ type: "web_search" }, { type: "function", name: "read" }],
  }) as Record<string, unknown>;

  const tools = payload.tools as unknown[];
  assert.equal(tools.length, 2);
  assert.ok(hasNativeWebSearchTool(tools));
});

test("versioned DeepSeek web search tool counts as native search", () => {
  assert.equal(hasNativeWebSearchTool([{ type: "web_search_2025_08_26" }]), true);
});

test("web search can be disabled without changing function tools", () => {
  const payload = prepareDeepSeekResponsesPayload(
    { tools: [{ type: "function", name: "read" }] },
    false,
  ) as Record<string, unknown>;

  assert.deepEqual(payload.tools, [{ type: "function", name: "read" }]);
});

test("non-object payload passes through", () => {
  assert.equal(prepareDeepSeekResponsesPayload("hello"), "hello");
});

test("Responses capability is explicitly gated by official provider and supported model", () => {
  assert.equal(
    supportsDeepSeekResponses({ provider: "deepseek", id: "deepseek-v4-flash" }),
    true,
  );
  assert.equal(
    supportsDeepSeekResponses({ provider: "deepseek", id: "deepseek-v4-pro" }),
    true,
  );
  assert.equal(
    supportsDeepSeekResponses({ provider: "openrouter", id: "deepseek-v4-flash" }),
    false,
  );
  assert.equal(
    supportsDeepSeekResponses({ provider: "deepseek", id: "future-model" }),
    false,
  );
});

test("toResponsesModel keeps provider/catalog metadata and changes only transport semantics", () => {
  const model = deepseekModel("deepseek-v4-flash");
  const result = toResponsesModel(model);
  assert.equal(result.api, "openai-responses");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.id, model.id);
  assert.equal(result.baseUrl, model.baseUrl);
  assert.equal(result.contextWindow, model.contextWindow);
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

test("streamDeepSeekTransport routes Responses-capable models to Responses and unknown models to Completions", () => {
  const { adapters, calls } = mockAdapters();

  const flashResult = streamDeepSeekTransport(
    deepseekModel("deepseek-v4-flash"),
    emptyContext,
    undefined,
    adapters,
  );
  const proResult = streamDeepSeekTransport(
    deepseekModel("deepseek-v4-pro"),
    emptyContext,
    undefined,
    adapters,
  );
  const unknownResult = streamDeepSeekTransport(
    deepseekModel("future-model"),
    emptyContext,
    undefined,
    adapters,
  );

  assert.equal(flashResult, "responses-stream");
  assert.equal(proResult, "responses-stream");
  assert.equal(unknownResult, "completions-stream");
  assert.equal(calls.responses.length, 2);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.responses[0]?.model.api, "openai-responses");
  assert.equal(calls.responses[0]?.model.id, "deepseek-v4-flash");
  assert.equal(calls.responses[1]?.model.api, "openai-responses");
  assert.equal(calls.responses[1]?.model.id, "deepseek-v4-pro");
  assert.equal(calls.completions[0]?.model.id, "future-model");
});

test("Responses path forces cacheRetention none and re-sanitizes after upstream onPayload", async () => {
  const { adapters, calls } = mockAdapters();
  const requestModel = toResponsesModel(deepseekModel("deepseek-v4-flash"));

  streamDeepSeekTransport(
    deepseekModel("deepseek-v4-flash"),
    emptyContext,
    {
      cacheRetention: "long",
      onPayload: async (payload) => {
        const dirty = {
          ...(payload as Record<string, unknown>),
          store: true,
          prompt_cache_key: "hook-injected",
          tools: [{ type: "function", name: "bash" }],
        };
        return dirty;
      },
    },
    adapters,
  );

  assert.equal(calls.responses.length, 1);
  const options = calls.responses[0]?.options;
  assert.ok(options);
  assert.equal(options.cacheRetention, "none");
  assert.equal(typeof options.onPayload, "function");

  const finalPayload = (await options.onPayload?.(
    {
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "read" }],
      reasoning: { effort: "high", summary: "auto" },
    },
    requestModel,
  )) as Record<string, unknown>;

  assert.equal(finalPayload.store, undefined);
  assert.equal(finalPayload.include, undefined);
  assert.equal(finalPayload.prompt_cache_key, undefined);
  assert.deepEqual(finalPayload.reasoning, { effort: "high" });
  assert.deepEqual(finalPayload.tools, [
    { type: "function", name: "bash" },
    { type: "web_search" },
  ]);
});

test("buildDeepSeekResponsesStreamOptions re-applies web_search after upstream removes it", async () => {
  const options = buildDeepSeekResponsesStreamOptions({
    onPayload: async () => ({
      tools: [{ type: "function", name: "read" }],
      store: true,
    }),
  });

  assert.equal(options.cacheRetention, "none");
  const finalPayload = (await options.onPayload?.(
    { tools: [{ type: "web_search" }] },
    toResponsesModel(deepseekModel("deepseek-v4-flash")),
  )) as Record<string, unknown>;

  assert.equal(finalPayload.store, undefined);
  assert.deepEqual(finalPayload.tools, [
    { type: "function", name: "read" },
    { type: "web_search" },
  ]);
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
