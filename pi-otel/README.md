# @masonchow/pi-otel

OpenTelemetry reporting for the [pi coding agent](https://github.com/earendil-works/pi): traces, metrics, and logs for everything pi does at runtime — sessions, agent runs, turns, LLM requests (tokens, cost, TTFT, streaming), tool executions, compaction, and human interventions — exported over OTLP/HTTP to any OpenTelemetry collector.

Design principles:

- **Passive listener.** Only subscribes to pi events. It never injects into the system prompt, never rewrites history, never returns values from handlers — so it is fully prompt-cache-neutral and cannot change agent behavior.
- **Fail-open.** Every handler is wrapped in a guard: telemetry errors are counted (`pi.telemetry.errors`) and dropped, never thrown into pi. No collector? pi works exactly as before.
- **Metadata only.** Names, counts, sizes, durations, statuses. No prompts, no completions, no tool arguments, no file contents.
- **Generic core.** Company-specific semantics (org dimensions, ticket systems, approval flows, internal pricing) plug in through [`PiOtelPlugin`](#enterprise-customization) — you write a thin package that depends on this one, you never fork it.

## Install

```bash
pi install npm:@masonchow/pi-otel
# or from a local checkout
pi install /absolute/path/to/pi-otel
```

Or add it to `~/.pi/agent/settings.json` (user) / `.pi/settings.json` (project) directly:

```json
{
  "packages": ["npm:@masonchow/pi-otel"]
}
```

Local-path form works there too: `"packages": ["/absolute/path/to/pi-otel"]`.

Point it at your collector and restart pi:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## Configuration

Everything OTLP-related uses the standard `OTEL_*` environment variables consumed by the OpenTelemetry exporters — pi-otel adds no exporter configuration of its own. Transport is OTLP over HTTP with **JSON** encoding. Gateways that only accept `http/protobuf` are served by passing the `-proto` exporters through [`PiOtelOptions.exporters`](#otlpprotobuf-gateways).

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; signals go to `/v1/traces`, `/v1/metrics`, `/v1/logs` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra headers, e.g. `Authorization=Bearer ...` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` etc. | Per-signal endpoint overrides (`TRACES` / `METRICS` / `LOGS`) |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export period in ms (default 60000) |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, `key=value,key=value` |
| `OTEL_SDK_DISABLED` | `true`/`1`: disable all reporting |
| `PI_OTEL_DISABLED` | `true`/`1`: disable pi-otel only (same effect, scoped name) |
| `PI_OTEL_DEBUG` | `1`: log swallowed telemetry errors to stderr (they are silent otherwise) |
| `PI_OTEL_METRICS_EXCLUDE_ATTRS` | Resource attributes to keep off **metrics**, comma-separated. Default `pi.session.id,pi.session.parent_id,pi.project.path`; set to an empty string to keep everything |
| `PI_REQUIREMENT_ID` | Force the requirement id for this process (CI / scripted runs) |
| `PI_OTEL_REQUIREMENT_BRANCH_REGEX` | Override the branch-name pattern used for requirement resolution |

The resource `service.name` defaults to `pi`; override it via `PiOtelOptions.serviceName` or `OTEL_RESOURCE_ATTRIBUTES`.

## Requirement correlation

A *requirement* is the work item (ticket, issue, task) a session contributes to. One requirement usually spans many sessions across days and machines, so pi-otel does **not** stretch a trace over them — each session is its own trace, and every signal of the session carries the resource attribute `pi.requirement.id`. Aggregation happens on that attribute.

Resolution runs once at session start, by priority:

1. `PI_REQUIREMENT_ID` environment variable
2. The directory binding written by `/req` (persisted in `~/.pi/pi-otel/state.json`, keyed by cwd)
3. The git branch name, matched against `PI_OTEL_REQUIREMENT_BRANCH_REGEX` or the default pattern `(?:^|\/)([A-Za-z][A-Za-z0-9]+-\d+)` — `feature/CC-1234-fix-login` resolves to `CC-1234`
4. Unresolved → reported as `unknown`, so the unlabeled share stays visible in dashboards

### The `/req` command

```text
/req CC-1234    bind the current directory to requirement CC-1234
/req            show the current binding and what this session reports
/req clear      remove the binding
```

Bindings take effect for **sessions started afterwards**: a session's requirement id is frozen at `session_start` (like all its resource attributes), so the running session keeps whatever it started with. The command's confirmation message spells this out.

As a convenience, each new session root span also gets a span link to the previous session of the same requirement, so you can walk a requirement's history hop by hop in your trace UI.

### Querying across sessions

TraceQL (Tempo) — all session traces of one requirement:

```traceql
{ resource.pi.requirement.id = "CC-1234" }
```

PromQL — total spend per requirement over 30 days (assumes your collector promotes the `pi_requirement_id` resource attribute to a metric label):

```promql
sum by (pi_requirement_id) (increase(pi_cost_usd_total[30d]))
```

## Signals reference

### Metrics

All metrics carry the session's resource attributes (`pi.requirement.id` plus anything your plugins add) — see [metric cardinality](#metric-cardinality) for the two attributes held back by default.

Every metric below additionally carries the **common dimensions** `pi.ai.model`, `pi.ai.provider`, and `pi.thinking_level`, so cost, latency and intervention rate all break down by model and by thinking level.

Which model a metric is labelled with follows what produced it, so the series of one turn can be joined:

- **Request-scoped** (`pi.tokens`, `pi.cost.usd`, `pi.llm.*`): the response's own model and provider, with the thinking level snapshotted when the request was sent.
- **Turn-scoped** (`pi.turns`, `pi.turn.duration`, `pi.turn.phase.duration`): the model of the turn's last request — the one that did the turn's work — so switching model mid-turn cannot label a turn with a model that produced none of it.
- **Everything else** (`pi.agent.duration`, interventions, context, compaction, errors): the session's current selection, since they are not tied to one request.

| Metric | Type | Extra dimensions | Meaning |
| --- | --- | --- | --- |
| `pi.tokens` | Counter | `pi.token.type` = `input` \| `output` \| `cache_read` \| `cache_write` \| `cache_write_1h` \| `reasoning` | Token consumption per LLM response |
| `pi.cost.usd` | Counter | `pi.token.type` = `input` \| `output` \| `cache_read` \| `cache_write` | Cost in USD per component, as computed by pi's price table; components sum to the total spend |
| `pi.turns` | Counter | — | Completed turns |
| `pi.human.interventions` | Counter | `pi.intervention.kind` = `steer` \| `follow_up` \| `interrupt` \| `approval` \| `question` | Times a human had to come back to the session |
| `pi.agent.duration` | Histogram | — | `agent_start → agent_settled`, real agent busy time |
| `pi.turn.duration` | Histogram | — | Single turn duration |
| `pi.turn.phase.duration` | Histogram | `pi.turn.phase` = `ttft` \| `streaming` \| `tool` \| `wait` | The same turn, split into four phases that sum to exactly `pi.turn.duration` — stack them for "where did the time go" |
| `pi.llm.duration` | Histogram | — | Single LLM request duration |
| `pi.llm.ttft` | Histogram | — | Time to first streamed chunk |
| `pi.llm.streaming.duration` | Histogram | — | First chunk → last token |
| `pi.tool.duration` | Histogram | `pi.tool.name`, `pi.tool.is_error` | Single tool execution; the `is_error` split gives per-tool failure rate |
| `pi.context.tokens` / `pi.context.usage_ratio` | Gauge | — | Context window usage, sampled per turn |
| `pi.compaction` | Counter | `pi.compaction.reason`, `pi.compaction.tokens_before` | Context compactions. The compaction's own LLM usage is folded into `pi.tokens` / `pi.cost.usd` (with `costTable` applied) and attributed to the session's current model — pi does not report which model compacted, so it is left out of `pi.summary.models` |
| `pi.errors` | Counter | `pi.error.scope` = `llm` \| `tool` \| `agent` \| `provider` | Runtime errors |
| `pi.telemetry.errors` | Counter | — | Errors swallowed by pi-otel's own fail-open guard |
| `pi.telemetry.dropped` | Counter | — | Signals pi-otel discarded itself (out-of-order span bookkeeping, …) |

Useful derived views: *autonomy rate* = `1 − interventions / turns`; per-requirement busy time = `sum by (pi_requirement_id) (pi_agent_duration_sum)`.

**Turn phases** are a strict decomposition, which costs a little precision at the edges:

- A tool still running when a turn ends keeps counting into the next turn, so its time stays `tool` instead of reappearing as `wait`.
- A response that never streams (deferred, non-streamed) counts as `ttft` — it was all time waiting on the model — but produces no `pi.llm.ttft` sample, since there was no first chunk to time.
- When work that began in an earlier turn hands a turn more measured time than the turn lasted, the measured phases are scaled to fit rather than overflowing. The four phases therefore always sum to the turn; individual phases of such a turn read low.

**Token accounting:** `reasoning` tokens are a **subset of `output`**, and `cache_write_1h` a subset of `cache_write` — sum `input + output + cache_read + cache_write` for totals and treat the subsets as drill-downs, or you will double-count. `pi.cost.usd` is pi's own cost computation; override pricing via a plugin `costTable` only if your proxy bills differently.

#### Metric cardinality

Many backends flatten resource attributes into metric labels, where a per-session id means a new time series per session. So `pi.session.id`, `pi.session.parent_id` (same per-session shape, on forks) and `pi.project.path` are **stripped from metrics only** — traces and logs keep the full attribute set, which is where per-session drill-down and the fork lineage link belong, and `pi.session.summary` (below) carries the same session's totals as one log row.

Change the list with `PI_OTEL_METRICS_EXCLUDE_ATTRS` (comma-separated; empty string keeps everything):

```bash
# keep the project path on metrics, still drop the per-session ids
export PI_OTEL_METRICS_EXCLUDE_ATTRS=pi.session.id,pi.session.parent_id
```

### Traces

One trace per session:

```text
session (trace root)          pi.session.id, pi.requirement.id, pi.session.reason,
│                             pi.session.parent_id (fork), link → previous session
└─ agent run                  one agent_start → agent_settled cycle
   └─ turn                    pi.turn.index
      ├─ LLM request          model/provider, stop reason, pi.ai.usage.*,
      │                       pi.ai.stream.time_to_first_chunk_ms, gen_ai.* compat
      └─ tool execution       pi.tool.name, pi.tool.call_id, pi.tool.is_error
```

### Logs

Low-frequency, high-information state changes go to the logs pipeline: session lifecycle (start/resume/fork/shutdown), model and thinking-level selection, compaction, errors, and intervention details (kind + metadata).

**`pi.session.summary`** is the one row per session: emitted at `session_shutdown` (before the final flush) with the whole session's totals. It answers the questions metrics cannot once per-session attributes are off the labels — per-session distributions (interventions per session, cost per intervention bucket) and joins against other systems by session id.

```jsonc
{
  "event.name": "pi.session.summary",
  "attributes": {
    "pi.session.id": "0198…",
    "pi.summary.duration_ms": 748000,
    "pi.summary.agent_busy_ms": 214000,
    "pi.summary.turns": 13,
    "pi.summary.tokens.input": 812000,       // one field per token type
    "pi.summary.tokens.output": 64000,
    "pi.summary.cost.input_usd": 1.21,       // one field per cost component
    "pi.summary.cost.total_usd": 1.62,
    "pi.summary.interventions.total": 2,
    "pi.summary.interventions.steer": 1,     // one field per kind
    "pi.summary.interventions.question": 1,
    "pi.summary.models": "claude-sonnet-5"   // comma-separated, sorted
  }
}
```

Token and cost fields follow the same subset rules as the counters, and only non-zero series appear. Session resource attributes (`pi.requirement.id`, `pi.project.path`, plugin dimensions) are attached by the pipeline as with every other record.

### Schema alignment

pi ships vendor-neutral telemetry schemas (`AI_TELEMETRY_SCHEMA` / `HARNESS_TELEMETRY_SCHEMA` in `@earendil-works/pi-agent-core`) that the CLI does not wire up yet. pi-otel uses those attribute keys **verbatim** where they exist — `pi.ai.usage.input_tokens`, `pi.ai.stream.time_to_first_chunk_ms`, `pi.session.id`, `pi.tool.name`, … — so the data merges cleanly if official telemetry ever ships. Keys the official schemas don't cover stay in the same `pi.*` namespace (`pi.requirement.id`, `pi.session.parent_id`, `pi.session.reason`, `pi.version`, `pi.turn.index`, …). LLM spans additionally carry a small OTel GenAI semantic-convention subset (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`) for GenAI-aware dashboards.

### Privacy

Default is metadata-only; there is no content capture. If even some metadata is too much for your policy (e.g. local paths), remove it with the `redact` plugin hook.

## Enterprise customization

The core knows nothing about Jira, org charts, or approval systems. Ship a thin internal package that depends on `@masonchow/pi-otel` and passes `PiOtelPlugin` objects through `PiOtelOptions.plugins`:

| Hook | Called | Use it for |
| --- | --- | --- |
| `resolveAttributes(ctx)` | Once per session, at `session_start`; result is frozen and applied as resource attributes to every signal | Org dimensions (`team`, `user`), ticket metadata. Must be stable within a session — no timestamps, no random values |
| `classifyIntervention(signal)` | For every candidate signal (user input, abort, settled question, bus message); plugins run in order — returning a kind adopts it, returning `null` vetoes the signal (built-in rules are skipped), no opinion passes to the next plugin, and the built-in classifier runs last | Your own definition of "a human had to step in" |
| `costTable` | On cost computation for every LLM call, including compaction, keyed by model id | Internal proxy pricing that differs from pi's public price table (USD per 1M tokens) |
| `redact(attrs)` | With the session's resource attributes at `session_start`, before they are frozen | Dropping or masking attributes (e.g. `pi.project.path`) per privacy policy |

A copy-paste skeleton with all four hooks lives in [`examples/enterprise-plugin.example.ts`](./examples/enterprise-plugin.example.ts).

### OTLP/protobuf gateways

The bundled exporters speak OTLP/HTTP with JSON encoding. If your gateway only accepts `http/protobuf`, depend on the `-proto` exporters in your enterprise package and pass them in — they read the same `OTEL_*` variables, so no other configuration changes:

```ts
import { createPiOtel } from "@masonchow/pi-otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";

export default createPiOtel({
  plugins: [myPlugin],
  exporters: {
    traces: new OTLPTraceExporter(),
    metrics: new OTLPMetricExporter(),
    logs: new OTLPLogExporter(),
  },
});
```

### Approval events over the pi event bus

pi's core has no permission/approval events — approval gates are themselves extensions. If your deployment has one, have it publish to the shared extension event bus on the channel **`pi-otel:intervention`**:

```ts
// inside your approval-gate extension, when a human confirms/denies a tool call
pi.events.emit("pi-otel:intervention", { kind: "approval", tool: "bash" });
```

pi-otel subscribes to that channel and forwards each message to `classifyIntervention` as `{ source: "bus", channel: "pi-otel:intervention", data }`. The built-in fallback counts messages whose `data.kind` is a valid intervention kind (`steer` | `follow_up` | `interrupt` | `approval` | `question`); a plugin can implement any richer contract on top of `data`.

## License

MIT
