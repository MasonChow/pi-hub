import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import deepSeekResponsesExtension, {
  hasNativeWebSearchTool,
  prepareDeepSeekResponsesPayload,
  supportsDeepSeekResponses,
  toResponsesModel,
} from "../src/index.ts";

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
    false,
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
  const model = {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"openai-completions">;

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
