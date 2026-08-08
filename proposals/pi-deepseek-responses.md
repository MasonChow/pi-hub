# `@masonchow/pi-deepseek-responses` 需求迭代 / Coding Agent Prompt

> 状态：Proposal
>
> 目标仓库：`MasonChow/pi-hub`
>
> 目标包：`@masonchow/pi-deepseek-responses`

## 背景

Pi 当前官方 `deepseek` provider 使用 `openai-completions` / `/chat/completions`。DeepSeek 新增了 Responses API，并在 `deepseek-v4-flash` 上支持官方 server-side `web_search`。

Pi core 已具备 `openai-responses` transport，但它按照 OpenAI Responses 的能力构造请求；DeepSeek Responses 只兼容其中一部分字段。同时，Pi maintainer 已明确表示不计划在 core 中抽象各 provider 的 server-side tools，因为这些工具的 request / transcript item 无法跨 provider 通用。

因此这个能力应该作为 **DeepSeek-specific Pi extension** 存在：只修改官方 DeepSeek provider 的行为，其他 provider 保持原样。

相关 upstream：

- `earendil-works/pi#7559` — Add DeepSeek `/responses` API support
- `earendil-works/pi#7704` — server-side builtin tools proposal；maintainer 明确 `not planned`
- `earendil-works/pi#6365` — maintainer 说明 server tools 很难跨 provider 抽象

## 最终目标

安装扩展后，用户继续使用 Pi 原来的模型选择方式：

```bash
pi --provider deepseek --model deepseek-v4-flash
```

或 `/model` 选择：

```text
deepseek/deepseek-v4-flash
```

扩展透明把官方 DeepSeek 请求升级为：

```text
Pi
  ↓
deepseek provider
  ↓
DeepSeek-specific Responses compatibility layer
  ↓
POST https://api.deepseek.com/responses
  ├─ Pi function tools
  └─ DeepSeek native web_search
```

用户无需：

- 创建 `deepseek-responses` 新 provider
- 修改 `~/.pi/agent/models.json`
- 配置 Tavily / Exa / Serper
- 手动声明 `web_search`

## 核心设计原则

1. **只作用于官方 DeepSeek provider**。
2. **DeepSeek 始终走 Responses API**，不要静默 fallback 到 Chat Completions。
3. **Web Search 使用 DeepSeek 官方 server-side tool**，不要包装成 Pi 本地 function tool。
4. **复用 Pi `openai-responses` 能力，但增加 DeepSeek compat/sanitization 层**。
5. **跨 provider 切换时保证 transcript portable**，不要把 DeepSeek-only item 泄漏给 Claude/OpenAI/Gemini 等 provider。
6. **不修改 Pi core，不 fork Pi**。
7. **保持 Pi function tools 正常工作**。

---

# 给 Coding Agent 的实现任务

请在 `MasonChow/pi-hub` 中实现一个新的 Pi package：

```text
@masonchow/pi-deepseek-responses
```

开始编码前必须先阅读当前安装/最新版本 Pi 的真实源码和类型定义，确认 extension API。重点检查：

```text
packages/ai/src/api/openai-responses.ts
packages/ai/src/api/openai-responses-shared.ts
packages/ai/src/types.ts
packages/coding-agent/src/core/model-config.ts
registerProvider
before_provider_request / onPayload 等 request hook
provider/model registry
session transcript serialization / transform-messages
```

不要根据旧文档或猜测构造 Pi API。

## 1. 官方 DeepSeek 判断

实现单一判断函数：

```ts
function isOfficialDeepSeek(model: ModelLike): boolean
```

至少要求：

```text
deepseek/deepseek-v4-flash      -> true
openrouter/deepseek-v4-flash    -> false
fireworks/deepseek-v4-flash     -> false
其他第三方 DeepSeek 托管         -> false
```

主要判断 provider id：

```ts
model.provider === "deepseek"
```

必要时用 `https://api.deepseek.com` 作为额外校验。

不要仅用 model id 包含 `deepseek` 来判断。

## 2. 覆盖现有 `deepseek` provider transport

插件安装后，用户仍使用 provider id：

```text
deepseek
```

不要新增用户可见的：

```text
deepseek-responses
```

通过 Pi 官方 extension/provider 注册机制覆盖或重注册官方 DeepSeek provider，使支持的 DeepSeek model 使用：

```text
api: openai-responses
baseUrl: https://api.deepseek.com
```

最终请求必须实际命中：

```text
POST https://api.deepseek.com/responses
```

优先复用 Pi 自带 `openai-responses` stream/parser，不复制整套 OpenAI provider。

保留现有 DeepSeek：

- `DEEPSEEK_API_KEY`
- auth/login 行为（Pi 当前提供时）
- model id
- context window
- max tokens
- reasoning/thinking level metadata
- cost metadata
- `/model` 行为

## 3. DeepSeek Responses payload sanitization

这是本实现的关键部分。

Pi 当前 `openai-responses` adapter 会生成 OpenAI-specific 字段，例如：

```json
{
  "store": false,
  "prompt_cache_key": "...",
  "prompt_cache_retention": "...",
  "prompt_cache_options": {},
  "include": ["reasoning.encrypted_content"]
}
```

DeepSeek Responses 并不完整支持 OpenAI Responses 的所有字段。

实现：

```ts
function sanitizeDeepSeekResponsesPayload(payload): payload
```

以 **DeepSeek 最新官方 Responses API 文档** 为 source of truth。

至少重点检查并移除/转换 DeepSeek 不支持的字段：

```text
store
previous_response_id
conversation
include
prompt_cache_key
prompt_cache_retention
prompt_cache_options
```

不要机械照抄上面的 blacklist；编码时重新核对最新 DeepSeek 文档，根据真实支持情况实现。

原则：

- Pi 内部可以继续认为模型属于 `openai-responses` API family。
- 发到 `api.deepseek.com/responses` 的最终 payload 必须严格符合 DeepSeek Responses schema。
- 不要依赖“服务端可能静默忽略未知字段”。

## 4. 自动注入 DeepSeek 官方 `web_search`

对官方 DeepSeek Responses 请求自动追加：

```json
{
  "type": "web_search"
}
```

最终示例：

```json
{
  "model": "deepseek-v4-flash",
  "input": [],
  "tools": [
    {
      "type": "function",
      "name": "read"
    },
    {
      "type": "function",
      "name": "bash"
    },
    {
      "type": "web_search"
    }
  ]
}
```

必须保留 Pi 原有 function tools：

```text
read
write
edit
bash
grep
find
extension tools
MCP/function tools
```

`web_search` 只是额外的 server-side tool。

实现幂等：

```ts
function injectDeepSeekWebSearch(payload) {
  const tools = payload.tools ?? [];

  const exists = tools.some(
    (tool) =>
      tool?.type === "web_search" ||
      tool?.type === "web_search_2025_08_26"
  );

  if (exists) return payload;

  return {
    ...payload,
    tools: [...tools, { type: "web_search" }],
  };
}
```

默认让模型自行决定何时搜索。

若 payload 已有合法 `tool_choice`，保留原值。

## 5. Web Search 是 provider-native tool

不要：

```ts
pi.registerTool({ name: "web_search", ... })
```

不要由扩展自己请求搜索引擎。

不要调用：

```text
Tavily
Exa
Serper
Bing wrapper
curl search engine HTML
```

搜索执行者必须是：

```text
DeepSeek API server
```

也就是模型请求本身携带：

```json
{"type":"web_search"}
```

## 6. Streaming event compatibility

DeepSeek server-side search 会产生 Responses streaming event / item，例如：

```text
response.web_search_call.in_progress
response.web_search_call.searching
response.web_search_call.completed
response.output_item.added
response.output_item.done
```

其中 output item 可能是：

```text
web_search_call
```

检查 Pi 当前 `processResponsesStream` / `createSlot` 行为。

验收：

1. 遇到 `web_search_call` 不崩溃。
2. 搜索完成后 assistant text 正常流式输出。
3. 同一轮允许 function tool + server-side web search 共存。
4. usage 能正常生成。
5. reasoning 能正常生成。
6. abort/error stream 能正常收尾。

第一版不强制在 TUI 中增加专门的 “Searching web…” UI。

## 7. DeepSeek 多轮 Responses / transcript round-trip

DeepSeek Responses 是无状态调用模型时，需要把必要历史 item 重新发送。

重点验证以下流程：

```text
User
  ↓
DeepSeek web_search_call
  ↓
Assistant answer
  ↓
User follow-up
  ↓
继续基于上一轮搜索上下文回答
```

测试问题示例：

```text
第一轮：搜索 Pi 最近一周的重要更新，列出三条。
第二轮：你刚才第二条提到的问题具体影响什么场景？
```

检查 Pi 是否会保存/序列化 `web_search_call` item。

如果 DeepSeek 要求在下一轮原样 replay 某类 search item，而 Pi 当前 transcript 模型无法表达，扩展需要提供 DeepSeek-specific replay/normalization。

不要通过以下 OpenAI stateful 特性假设解决：

```text
previous_response_id
conversation
store
```

只有 DeepSeek 官方当前明确支持时才能使用。

## 8. 跨 provider transcript portability

这是必须实现/验证的能力，也是 Pi maintainer 拒绝 core server-side tools abstraction 的主要原因。

场景：

```text
DeepSeek V4 Flash
  ↓
server-side web_search
  ↓
产生 DeepSeek-only transcript item
  ↓
用户 /model 切到 Claude / GPT / Gemini
  ↓
继续对话
```

目标：目标 provider 不能收到自己无法理解的 DeepSeek `web_search_call` 原始结构。

实现一个明确的 normalization boundary，例如：

```ts
function normalizeTranscriptForTargetProvider(messages, targetModel)
```

建议策略：

### DeepSeek -> DeepSeek

保留 DeepSeek 下一轮需要 replay 的 provider-native item。

### DeepSeek -> 非 DeepSeek

将 provider-native search item：

- 从目标 provider payload 中移除；或
- 转成 Pi 已经持久化的普通 assistant text / portable representation。

不得：

- 破坏用户已经看到的 assistant answer
- 把 DeepSeek internal item 当作普通 function call 发给其他 provider
- 导致跨模型恢复 400

实现前先研究 Pi 当前 `transformMessages` 的 provider switching 处理方式，并沿用现有 abstraction。

## 9. 支持模型策略

架构目标：

> 官方 DeepSeek provider 中，DeepSeek 官方 Responses API 已支持的模型走本扩展。

当前至少支持：

```text
deepseek-v4-flash
```

实现集中判断：

```ts
function supportsDeepSeekResponses(modelId: string): boolean
```

不要把 model 判断散落到多个 hook。

当用户选择尚未被 DeepSeek Responses 官方支持的官方 DeepSeek model：

- 返回清晰错误
- 显示 model id
- 说明该模型尚未支持 DeepSeek Responses
- 不静默退回 `/chat/completions`

后续 DeepSeek 增加模型后只改一处 allowlist/feature table。

## 10. 配置

默认零配置：

```ts
{
  webSearch: true
}
```

可支持：

```bash
PI_DEEPSEEK_WEB_SEARCH=0
```

关闭后：

```text
DeepSeek 仍然走 /responses
```

只停止注入：

```json
{"type":"web_search"}
```

增加 debug：

```bash
PI_DEEPSEEK_RESPONSES_DEBUG=1
```

输出：

```text
[pi-deepseek-responses] provider=deepseek
[pi-deepseek-responses] model=deepseek-v4-flash
[pi-deepseek-responses] endpoint=/responses
[pi-deepseek-responses] web_search=enabled
```

可选输出 sanitised payload keys。

严禁输出：

- API key
- Authorization header
- 完整敏感 prompt

## 11. Package 结构

遵循 `pi-hub` 现有 package 约定：

```text
pi-deepseek-responses/
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── provider.ts
│   ├── payload.ts
│   └── transcript.ts
└── tests/
    ├── detection.test.ts
    ├── payload.test.ts
    ├── transcript.test.ts
    └── integration.test.ts
```

如果实现足够小，可以合并文件；优先简单、可读、低侵入。

TypeScript 源码直接发布，保持与 `pi-hub` 其他 package 一致。

## 12. package.json

包名：

```json
{
  "name": "@masonchow/pi-deepseek-responses"
}
```

按照 Pi package 当前要求声明 extension entry。

目标安装：

```bash
pi install npm:@masonchow/pi-deepseek-responses
```

本地调试：

```bash
pi -e ./pi-deepseek-responses
```

## 13. 单元测试

至少覆盖：

### provider detection

```text
deepseek/deepseek-v4-flash      -> true
openrouter/deepseek-v4-flash    -> false
fireworks/deepseek-v4-flash     -> false
openai/gpt-*                     -> false
anthropic/claude-*               -> false
```

### payload sanitization

输入包含 OpenAI-only 字段时，最终 DeepSeek payload 不包含 DeepSeek 当前不支持的字段。

### web search injection

空 tools：

```json
{}
```

结果包含：

```json
{
  "tools": [{ "type": "web_search" }]
}
```

已有 function tool 时保留 function 并追加 search。

已有 `web_search` 时只有一个实例。

非官方 DeepSeek payload 完全不修改。

### transcript

- DeepSeek -> DeepSeek：保留必要 provider-native replay data。
- DeepSeek -> Claude/OpenAI：移除/normalize DeepSeek-only search item。
- 用户可见 assistant text 必须保留。

## 14. Integration Test

使用真实 DeepSeek API 做 opt-in integration test。

### Case A：确认 endpoint

发送简单问题，确认请求实际走：

```text
POST /responses
```

### Case B：官方联网搜索

问题必须依赖实时信息，例如：

```text
搜索今天 Pi coding agent 仓库最新的 release / issue 动态，并给出来源。
```

确认请求 payload 含：

```json
{"type":"web_search"}
```

确认 stream 出现 `web_search_call` 相关事件，并最终输出正常文本。

### Case C：Pi function tools

```text
读取当前目录 package.json，然后告诉我 package name。
```

确认 Pi function tool 正常调用。

### Case D：同轮 function + web search

构造同时需要本地文件和互联网信息的问题，确认两类 tool 可共存。

### Case E：DeepSeek 多轮搜索

第一轮搜索实时信息，第二轮追问第一轮某个事实，确认上下文正常。

### Case F：跨 provider

```text
DeepSeek 搜索 -> /model 切 Claude/OpenAI -> 继续追问
```

确认目标 provider 不因 DeepSeek-only transcript item 报 400/schema error。

## 15. README 必须解释清楚

### Before

```text
Pi deepseek
  -> openai-completions
  -> /chat/completions
```

### After

```text
Pi deepseek
  -> DeepSeek Responses compatibility layer
  -> /responses
     ├─ Pi function tools
     └─ DeepSeek native web_search
```

README 需要链接 upstream issues，并解释为什么此能力放 extension：Pi maintainer 当前明确不计划在 core 中抽象 provider-specific server-side tools。

说明 DeepSeek 官方 Responses API 的支持模型限制，并标注该信息可能随 DeepSeek 更新变化。

## 16. Root README

完成包实现后，在 `pi-hub/README.md` 的包列表增加：

```text
@masonchow/pi-deepseek-responses
```

描述建议：

> 将 Pi 官方 DeepSeek provider 升级到 DeepSeek Responses API，并启用 DeepSeek 原生 Web Search，同时处理 Pi/OpenAI Responses 兼容字段与跨 provider transcript。

## 17. 明确 Out of Scope

第一版不做：

- 通用 server-side tools abstraction
- OpenRouter server tools
- xAI web/x_search
- Anthropic native web search
- Google grounding
- 第三方搜索 API
- Pi core patch/fork
- TUI 搜索进度专用组件

本包只解决：

```text
Official DeepSeek provider
+ DeepSeek Responses API
+ DeepSeek native web_search
+ DeepSeek-specific compatibility
```

## 18. 验收标准

必须全部满足：

- [ ] `deepseek/deepseek-v4-flash` 实际请求 `/responses`
- [ ] 用户无需新增 provider/models.json
- [ ] 自动注入官方 `web_search`
- [ ] Pi function tools 正常
- [ ] OpenAI-only request fields 被正确 sanitize
- [ ] reasoning 正常
- [ ] streaming web search 不崩
- [ ] DeepSeek -> DeepSeek 多轮搜索正常
- [ ] DeepSeek -> 其他 provider 切换正常
- [ ] 其他 provider 行为零变化
- [ ] 不依赖第三方搜索服务
- [ ] 不 fork / patch Pi core
- [ ] npm package 可独立安装/卸载
- [ ] unit tests + typecheck 通过
- [ ] 真实 DeepSeek integration test 有结果记录

## 19. 实现完成后的输出

Coding Agent 最终报告必须包含：

1. 实际采用的 Pi extension API
2. provider override 如何实现
3. 最终 DeepSeek Responses payload 示例
4. sanitize 的字段清单及对应 DeepSeek 文档依据
5. `web_search` 注入方式
6. `web_search_call` streaming 处理结果
7. transcript round-trip 实现
8. 跨 provider normalization 实现
9. 单测/typecheck 结果
10. 真实 DeepSeek API integration test 结果
11. 当前支持的 DeepSeek model
12. 已知限制

不要只提交 scaffold；必须证明 `/responses + web_search + function tools + 多轮 + provider switching` 真实可用。