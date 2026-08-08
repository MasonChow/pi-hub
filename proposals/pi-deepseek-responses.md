# `@masonchow/pi-deepseek-responses` 需求迭代 / Coding Agent Prompt

> 状态：MVP implemented in this branch
>
> 目标仓库：`MasonChow/pi-hub`
>
> 目标包：`@masonchow/pi-deepseek-responses`

## 背景

Pi 当前官方 `deepseek` provider 使用 `openai-completions` / `/chat/completions`。DeepSeek 新增了 Responses API，并在 `deepseek-v4-flash` 上支持官方 server-side `web_search`。

Pi core 已具备 `openai-responses` transport，但它按照 OpenAI Responses 的能力构造请求；DeepSeek Responses 只兼容其中一部分字段。同时，Pi maintainer 已明确表示不计划在 core 中抽象各 provider 的 server-side tools，因为这些工具的 request / transcript item 无法跨 provider 通用。

因此这个能力作为 **DeepSeek-specific Pi extension** 存在：只修改官方 DeepSeek provider 的行为，其他 provider 保持原样。

相关 upstream：

- `earendil-works/pi#7559` — Add DeepSeek `/responses` API support
- `earendil-works/pi#7704` — server-side builtin tools proposal；maintainer 明确 `not planned`
- `earendil-works/pi#6365` — maintainer 说明 server tools 很难跨 provider 抽象

## 已落地的实现决策

最终 MVP 采用 **transport dispatcher override**，不复制 DeepSeek model catalog：

```ts
pi.registerProvider("deepseek", {
  api: "openai-completions",
  streamSimple: streamDeepSeekTransport,
});
```

这里保留 `api: "openai-completions"` 是为了匹配 Pi 内置 DeepSeek model 的现有 API family，让 provider composer 把官方 DeepSeek model 路由到扩展 dispatcher。

Dispatcher 再按 DeepSeek 官方 Responses 支持范围分流：

```text
deepseek-v4-flash
  -> Pi openai-responses adapter
  -> DeepSeek compatibility sanitizer
  -> /responses + native web_search

unsupported / unknown DeepSeek model
  -> Pi openai-completions adapter
  -> 原有 Chat Completions 行为
```

这样既不维护第二份 model id / cost / context window / auth 数据，也不会因为安装扩展破坏尚未支持 Responses 的 DeepSeek catalog 模型。

## Payload compatibility

Responses 路径发送前移除 DeepSeek 当前不支持的 OpenAI Responses 参数：

```text
store
background
metadata
include
prompt
truncation
service_tier
safety_identifier
prompt_cache_key
prompt_cache_retention
prompt_cache_options
context_management
stream_options
previous_response_id
conversation
```

`reasoning` 只保留 `effort`。

DeepSeek 自己管理上下文缓存，因此调用 Pi Responses adapter 时强制：

```ts
cacheRetention: "none"
```

## Native Web Search

Responses 路径默认在最终 `tools` 中幂等追加：

```json
{ "type": "web_search" }
```

识别已有：

```text
web_search
web_search_2025_08_26
```

Pi function tools 原样保留。

可通过：

```bash
PI_DEEPSEEK_WEB_SEARCH=0
```

关闭本扩展的自动注入；Responses transport 继续生效。Completions fallback 路径完全保持 Pi 原行为。

## 当前模型范围与能力门控

截至 2026-08-08，DeepSeek 官方 Responses 文档仍明确：

```text
deepseek-v4-flash -> supported
deepseek-v4-pro   -> not yet supported
```

因此 MVP 使用显式 Responses capability allowlist：

```ts
const DEEPSEEK_RESPONSES_MODELS = new Set([
  "deepseek-v4-flash",
]);
```

规则：

- allowlist 内模型 → `/responses`
- allowlist 外官方 DeepSeek 模型 → 原 `/chat/completions`
- 第三方托管 DeepSeek 模型不受扩展影响

DeepSeek 官方新增 Responses 模型后，更新 allowlist 并发布新版扩展。这个显式门控优先保证安装扩展后的向后兼容性，避免对尚未支持 `/responses` 的模型产生回归。

## Transcript portability / 已知限制

Pi 当前 `openai-responses` parser 会忽略未知的 `web_search_call` output item。当前 MVP 能完成：

- DeepSeek `/responses` 请求
- function tools + `web_search` 共存
- 搜索状态事件不导致 parser 崩溃
- 最终文本正常进入 Pi transcript
- 未支持 Responses 的 DeepSeek 模型继续走原 completions transport

当前还不能持久化并在下一轮原样 replay DeepSeek `web_search_call`。因此依赖上一轮原始搜索结果、且答案文本没有包含足够信息的 follow-up，可能缺失完整搜索上下文。

后续迭代需要在不污染 Pi portable transcript 的前提下，为扩展增加 provider-private state / session entry 映射，再在 DeepSeek 请求序列化时恢复 `web_search_call`。

跨到 Claude/OpenAI/Gemini 时，当前 MVP 不会把 `web_search_call` 泄漏过去，因为 Pi parser 本身没有把它写入通用 AssistantMessage。

## 验收测试

已加入纯函数/注册层测试：

- unsupported payload field sanitization
- reasoning 只保留 effort
- function tools 保留
- web_search 幂等注入
- versioned web search type 识别
- web search disable
- Responses model projection
- Responses capability gate：V4 Flash true / V4 Pro false / unknown false / third-party false
- provider override 不替换 models/baseUrl

真实 API smoke test 应覆盖两条链路：

```bash
# Responses path
pi -e ./pi-deepseek-responses/src/index.ts --provider deepseek --model deepseek-v4-flash

# Completions fallback path
pi -e ./pi-deepseek-responses/src/index.ts --provider deepseek --model deepseek-v4-pro
```

Responses 测试 prompt：

```text
搜索今天 Pi coding agent 的最新版本变化，并给出来源
```

再测试 Pi 本地 tool：

```text
用 bash 输出当前目录，然后告诉我结果
```

V4 Pro fallback 需要确认请求继续使用原 Chat Completions transport。

## 调试

```bash
PI_DEEPSEEK_RESPONSES_DEBUG=1
```

Responses：

```text
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-flash api=openai-responses web_search=enabled
```

Fallback：

```text
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-pro api=openai-completions responses=unsupported
```

仅打印 provider/model/api/web_search 状态与最终 tool type，不打印 API key 或完整 prompt。

## 后续迭代优先级

1. 在有 `DEEPSEEK_API_KEY` 的环境完成真实 `/responses` + `web_search` smoke test。
2. 验证 `deepseek-v4-pro` fallback 仍使用 Pi 原 Chat Completions transport。
3. 验证 Pi 0.84.1 `openai-responses` parser 对 DeepSeek SSE 全事件集合的兼容性。
4. 设计 extension-private `web_search_call` 持久化/replay，实现完整多轮搜索上下文。
5. DeepSeek 官方开放新 Responses 模型后更新 capability allowlist 与 integration coverage。
