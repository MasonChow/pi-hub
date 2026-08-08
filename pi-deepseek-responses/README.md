# @masonchow/pi-deepseek-responses

把 Pi 官方 `deepseek` provider 透明切到 DeepSeek Responses API，并默认启用 DeepSeek 官方 server-side `web_search`。

安装后继续正常选择原 provider/model：

```bash
pi install npm:@masonchow/pi-deepseek-responses
pi --provider deepseek --model deepseek-v4-flash
```

链路变成：

```text
Pi deepseek provider
  -> extension transport override
  -> Pi openai-responses adapter
  -> DeepSeek compatibility sanitizer
  -> POST https://api.deepseek.com/responses
     + Pi function tools
     + { "type": "web_search" }
```

## 为什么这样实现

Pi 当前内置 DeepSeek 使用 `openai-completions`。这个扩展通过 `registerProvider("deepseek", { streamSimple })` 覆盖 transport，同时继续复用 Pi 自带的：

- DeepSeek model catalog
- `DEEPSEEK_API_KEY` / `/login` 鉴权
- context window / max tokens / cost metadata
- `/model` 选择行为

扩展内部再调用 Pi 自带的 `openai-responses` adapter，所以不用维护第二份 DeepSeek 模型清单。

## Web Search

默认自动追加：

```json
{ "type": "web_search" }
```

Pi 原有 function tools 会原样保留，例如 `read`、`bash`、`edit` 和其他 extension tools。

关闭自动搜索注入：

```bash
export PI_DEEPSEEK_WEB_SEARCH=0
```

此时 DeepSeek 仍走 `/responses`，只是不再由本扩展追加 `web_search`。

## DeepSeek Responses 兼容层

Pi 的 OpenAI Responses adapter 会生成一些 DeepSeek 当前不支持的 OpenAI-specific 字段。扩展在发送前移除这些字段，例如：

- `store`
- `include`
- `prompt_cache_key`
- `prompt_cache_retention`
- `prompt_cache_options`
- `service_tier`
- `previous_response_id`
- `conversation`

`reasoning` 只保留 DeepSeek 当前有效的 `effort`。

DeepSeek 自己管理上下文缓存，因此扩展会把 Pi 的 Responses cache retention 设为 `none`，避免生成 OpenAI prompt-cache 参数。

## 当前模型支持

截至 2026-08-08，DeepSeek 官方 Responses 文档仍明确写明：

- `deepseek-v4-flash`：支持 Responses API
- `deepseek-v4-pro`：暂未支持

扩展会把官方 `deepseek` provider 的模型统一路由到 `/responses`，因此当前建议使用：

```text
deepseek/deepseek-v4-flash
```

当 DeepSeek 服务端开放其他模型的 Responses 支持后，无需为模型目录新增映射；扩展会自动沿用 Pi 的官方模型 catalog。

## 调试

```bash
export PI_DEEPSEEK_RESPONSES_DEBUG=1
```

输出类似：

```text
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-flash api=openai-responses web_search=enabled
[pi-deepseek-responses] request tools=function,function,web_search
```

不会打印 API key 或完整 prompt。

## 已知限制

Pi 当前 `openai-responses` parser 会忽略 provider-specific `web_search_call` transcript item。单轮搜索与最终文本输出可以正常工作；需要原样 replay `web_search_call` 来恢复完整搜索上下文的多轮场景，仍需要后续扩展 parser/session 持久化能力。

这个限制也是 Pi maintainer 暂不把 server-side tools 做成 core 通用抽象的主要原因之一。

## 本地开发

```bash
cd pi-deepseek-responses
npm install
npm test
npm run typecheck

pi -e ./src/index.ts --provider deepseek --model deepseek-v4-flash
```

真实 API smoke test：

```text
搜索今天 Pi coding agent 的最新版本变化，并给出来源
```

确认最终请求命中 `/responses`，同时 function tools 仍能正常调用。
