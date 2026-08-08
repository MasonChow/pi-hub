# @masonchow/pi-deepseek-responses

把 **已支持 Responses API 的 Pi 官方 DeepSeek 模型**透明切到 DeepSeek Responses API，并默认启用 DeepSeek 官方 server-side `web_search`。尚未支持 Responses 的 DeepSeek 模型继续使用 Pi 原来的 Chat Completions transport。

安装后继续正常选择原 provider/model：

```bash
pi install npm:@masonchow/pi-deepseek-responses
pi --provider deepseek --model deepseek-v4-flash
```

链路：

```text
Pi deepseek provider
  -> extension transport dispatcher
     ├─ Responses-capable model
     │   -> Pi openai-responses adapter
     │   -> DeepSeek compatibility sanitizer
     │   -> POST https://api.deepseek.com/responses
     │      + Pi function tools
     │      + { "type": "web_search" }
     └─ unsupported / unknown model
         -> Pi openai-completions adapter
         -> original Chat Completions behavior
```

## 为什么这样实现

Pi 当前内置 DeepSeek 使用 `openai-completions`。这个扩展通过 `registerProvider("deepseek", { streamSimple })` 覆盖 transport dispatcher，同时继续复用 Pi 自带的：

- DeepSeek model catalog
- `DEEPSEEK_API_KEY` / `/login` 鉴权
- context window / max tokens / cost metadata
- `/model` 选择行为

对已确认支持 Responses 的模型，扩展内部调用 Pi 自带的 `openai-responses` adapter；其他模型委托回 Pi 原 `openai-completions` adapter。这样无需维护第二份 DeepSeek 模型清单，也不会因为安装扩展破坏仍依赖 Chat Completions 的模型。

## Web Search

Responses-capable DeepSeek 模型默认自动追加：

```json
{ "type": "web_search" }
```

Pi 原有 function tools 会原样保留，例如 `read`、`bash`、`edit` 和其他 extension tools。

关闭自动搜索注入：

```bash
export PI_DEEPSEEK_WEB_SEARCH=0
```

此时 Responses-capable DeepSeek 模型仍走 `/responses`，只关闭本扩展追加的 `web_search`。未支持 Responses 的模型仍走原 Chat Completions transport。

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

截至 2026-08-08，DeepSeek 官方 Responses 文档明确写明：

- `deepseek-v4-flash`：支持 Responses API → 本扩展路由到 `/responses` + native `web_search`
- `deepseek-v4-pro`：暂未支持 Responses API → 本扩展保留 Pi 原 `/chat/completions`
- 其他未知 DeepSeek 模型：默认保留 Pi 原 Chat Completions transport

Responses 能力采用显式 allowlist，避免新/旧 catalog 模型因服务端尚未开放 `/responses` 而回归失败。DeepSeek 官方新增 Responses 模型后，需要把对应 model id 加入 `DEEPSEEK_RESPONSES_MODELS` 并发布新版扩展。

## 调试

```bash
export PI_DEEPSEEK_RESPONSES_DEBUG=1
```

Responses 路径：

```text
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-flash api=openai-responses web_search=enabled
[pi-deepseek-responses] request tools=function,function,web_search
```

Fallback 路径：

```text
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-pro api=openai-completions responses=unsupported
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

真实 API smoke test建议覆盖两条链路：

```text
# Responses + native search
使用 deepseek-v4-flash 搜索今天 Pi coding agent 的最新版本变化，并给出来源

# Chat Completions fallback
使用 deepseek-v4-pro 执行一个普通对话/工具调用，确认请求仍走原 transport
```
