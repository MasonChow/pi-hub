# @masonchow/pi-deepseek-responses

把 **已支持 Responses API 的 Pi 官方 DeepSeek 模型**透明切到 DeepSeek Responses API，并默认启用 DeepSeek 官方 server-side `web_search`。上下文里出现图片时自动改投官方识图模型。尚未支持 Responses 的 DeepSeek 模型继续使用 Pi 原来的 Chat Completions transport。

安装后继续正常选择原 provider/model：

```bash
pi install npm:@masonchow/pi-deepseek-responses
pi --provider deepseek --model deepseek-v4-flash
```

链路：

```text
Pi deepseek provider
  -> extension transport dispatcher
     ├─ 上下文含图片 + 当前模型纯文本
     │   -> 换成 deepseek-v4-flash-vision-exp（input: text+image）
     │   -> 继续按下面的规则分流
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

## 识图自动切换

Pi 官方 DeepSeek catalog 里 `deepseek-v4-flash` / `deepseek-v4-pro` 的 `input` 都只有 `text`，Pi 的 adapter 会在发请求前把图片降级成 `(image omitted: ...)` 占位文本。本扩展在 transport 入口检查上下文，一旦发现图片就把模型换成官方识图模型：

- 触发条件：provider 为 `deepseek`、当前模型 `input` 不含 `image`、上下文任一 `user` 消息或 `toolResult` 含 `image` 内容
- 目标模型：`deepseek-v4-flash-vision-exp`（官方 pricing 页与 vision guide，2026-08-21）
- 继承当前模型的 provider / baseUrl / 鉴权 / context window / thinking level，只改 `id`、`input` 与计价
- 计价按官方 pricing 用识图模型自己的档位（与 flash 同档），避免从 `pro` 切过来时把成本按 pro 高估
- 识图模型同样在 Responses allowlist 里，所以照常走 `/responses` + native `web_search` + Pi function tools（已实测 200）

图片可以来自你贴进 prompt 的图，也可以来自 `read` 这类工具返回的 `toolResult`。切换是逐请求判断的：图片进上下文之后的每一轮都会用识图模型，纯文本会话完全不受影响。

关闭自动切换：

```bash
export PI_DEEPSEEK_VISION_AUTO=0
```

指定别的识图模型 id（官方换掉 `-exp` 后缀时不必等扩展发版）：

```bash
export PI_DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision
```

自定义 id 不在 Responses allowlist 里时会回落到 Chat Completions（识图模型两个端点都支持），计价沿用当前模型。

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

截至 2026-08-13，DeepSeek 官方 Responses 文档明确写明：

- `deepseek-v4-flash`：支持 Responses API → 本扩展路由到 `/responses` + native `web_search`
- `deepseek-v4-pro`：支持 Responses API（2026-08-13 起开放）→ 本扩展路由到 `/responses` + native `web_search`
- `deepseek-v4-flash-vision-exp`：官方识图模型，支持 Responses API + Tool Calls → 上下文含图片时自动切到它
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

识图切换：

```text
[pi-deepseek-responses] image input detected: deepseek-v4-flash -> deepseek-v4-flash-vision-exp
[pi-deepseek-responses] provider=deepseek model=deepseek-v4-flash-vision-exp api=openai-responses web_search=enabled
```

Fallback 路径（未知 / 尚未开放 Responses 的模型）：

```text
[pi-deepseek-responses] provider=deepseek model=future-model api=openai-completions responses=unsupported
```

不会打印 API key 或完整 prompt。

## 已知限制

Pi 当前 `openai-responses` parser 会忽略 provider-specific `web_search_call` transcript item。单轮搜索与最终文本输出可以正常工作；需要原样 replay `web_search_call` 来恢复完整搜索上下文的多轮场景，仍需要后续扩展 parser/session 持久化能力。

这个限制也是 Pi maintainer 暂不把 server-side tools 做成 core 通用抽象的主要原因之一。

Pi 的 `read` 工具在当前模型 `input` 不含 `image` 时，会在 `toolResult` 文本里附一句 `[Current model does not support images. The image will be omitted from this request.]`。本扩展随后会把请求改投识图模型、图片实际发得出去，所以这句提示是对 LLM 的误导性噪音。修掉它需要 Pi core 侧知道 transport 会换模型，扩展层改不了。

## 本地开发

```bash
cd pi-deepseek-responses
npm install
npm test
npm run typecheck

# 建议用本包 peer 对应的 Pi 版本（当前 0.84.1）
./node_modules/.bin/pi -e ./src/index.ts --provider deepseek --model deepseek-v4-flash
```

实现依赖 Pi extension loader 暴露的 `@earendil-works/pi-ai/compat` stream helpers（`streamSimpleOpenAIResponses` / `streamSimpleOpenAICompletions`）。**不要**从 `@earendil-works/pi-ai/api/*` 子路径导入——jiti 会把该路径错误拼到 `compat.js` 上导致扩展加载失败。

真实 API smoke（已在 Pi 0.84.1 + DeepSeek 账号验证）：

```bash
PI_DEEPSEEK_RESPONSES_DEBUG=1 \
  ./node_modules/.bin/pi -e ./src/index.ts --provider deepseek --model deepseek-v4-flash \
  -p --no-session --no-tools \
  "搜索今天 Pi coding agent 的最新版本变化，并给出来源"

PI_DEEPSEEK_RESPONSES_DEBUG=1 \
  ./node_modules/.bin/pi -e ./src/index.ts --provider deepseek --model deepseek-v4-pro \
  -p --no-session --no-tools \
  "搜索今天 Pi coding agent 的最新版本变化，并给出来源"

# 识图切换（需要 tools，让模型用 read 读图）
PI_DEEPSEEK_RESPONSES_DEBUG=1 \
  ./node_modules/.bin/pi -e ./src/index.ts --provider deepseek --model deepseek-v4-flash \
  -p --no-session \
  "只做一件事：用 read 工具读取 /tmp/some.png，然后回答图片内容。禁止使用 bash。"
```

期望 debug 行：

```text
# flash
api=openai-responses web_search=enabled
# pro
api=openai-responses web_search=enabled
# 识图
image input detected: deepseek-v4-flash -> deepseek-v4-flash-vision-exp
```

2026-08-21 已在 Pi 0.84.1 + DeepSeek 账号实测：`read` 返回图片后的下一轮自动切到 `deepseek-v4-flash-vision-exp` 并正确识图；同一天用 curl 验证 `/responses` + 识图模型 + `input_image` + function tools + `web_search` 均返回 200。
