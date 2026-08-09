/**
 * hud — Claude Code statusline 风格的 pi HUD（widget 渲染在输入框下方）
 *
 * 展示内容：
 * - 主 agent：provider/model + 认证形态
 *   - api_key：供应商余额（有查询 API 的才显示：deepseek / kimi / stepfun）+ 本 session 已消耗成本
 *   - oauth 订阅：剩余额度（openai-codex 走 GET .../backend-api/wham/usage，
 *     token 经 AuthStorage 带锁刷新，详见下方"订阅额度"小节的注释）
 *   - opencode-go：Go 订阅三窗口额度（5h / 周 / 月；官方 API 优先，否则 dashboard scrape）
 * - context 用量：进度条 + tokens / contextWindow（来自 ctx.getContextUsage()）
 * - agent 执行时间（累计活跃时长，运行中每秒刷新）+ token 输出速度（流式实时估算，
 *   message_end 后以真实 usage 校准）
 * - 缓存命中率：cacheRead / (input + cacheRead + cacheWrite)，参考 claude-hud 的口径
 * - subagent（pi-subagents 的 subagent 工具）：每个 agent 的模型 + tokens + 成本，
 *   按 runId 去重（管理类查询重复上报同一 run 时覆盖而非累加）
 *
 * cache 不变量（见仓库 CLAUDE.md）：本扩展只做 UI 渲染与只读统计，
 * 不注入 system prompt、不回写对话历史，天然 cache-neutral。
 *
 * 安装：pi install npm:@masonchow/pi-hud；会话内 /hud 开关。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyGoQuotaFetchResult,
	fetchOpencodeGoQuota,
	goQuotaWindowEntries,
	type GoQuota,
} from "./opencode-go.ts";

// 重导出，供测试与外部直接引用
export {
	applyGoQuotaFetchResult,
	classifyGoWindowName,
	formatGoQuotaStatusText,
	goQuotaWindowEntries,
	parseOpencodeGoDashboardHtml,
	parseOpencodeGoUsage,
	resolveOpencodeGoQuotaConfig,
	type GoQuota,
	type GoQuotaWindow,
} from "./opencode-go.ts";

// readStoredCredential 只在实际需要读 codex token 时动态 import：
// 顶层 import 会让 `node --test` 直接对该模块做 Node 原生 ESM 解析，而
// @earendil-works/pi-coding-agent 只有 pi 自己的 jiti loader 才认得，脱离 pi
// 跑测试会直接 ERR_MODULE_NOT_FOUND。dynamic import() 是惰性的，测试里从不
// 调用 maybeFetchCodexQuota，这条 import 就永远不会被求值。

// ---------------------------------------------------------------------------
// 纯函数（导出供测试）
// ---------------------------------------------------------------------------

export interface UsageAgg {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function emptyAgg(): UsageAgg {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** 从 AssistantMessage.usage（结构化守卫，不信任外部形状）累加到聚合 */
export function addUsage(agg: UsageAgg, usage: unknown): void {
	if (typeof usage !== "object" || usage === null) return;
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	agg.input += num(u.input);
	agg.output += num(u.output);
	agg.cacheRead += num(u.cacheRead);
	agg.cacheWrite += num(u.cacheWrite);
	// pi-ai 的 cost 是 { total }；pi-subagents 的 cost 是 number，两种都接
	const cost = u.cost;
	if (typeof cost === "number") agg.cost += num(cost);
	else if (typeof cost === "object" && cost !== null) agg.cost += num((cost as Record<string, unknown>).total);
}

/** 缓存命中率：prompt tokens 中来自缓存读取的占比；无 prompt tokens 时返回 null */
export function cacheHitRate(agg: UsageAgg): number | null {
	const prompt = agg.input + agg.cacheRead + agg.cacheWrite;
	if (prompt <= 0) return null;
	return (agg.cacheRead / prompt) * 100;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

export function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 > 0 ? `${s % 60}s` : ""}`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
	const d = Math.floor(h / 24);
	const parts = [`${d}d`, `${h % 24}h`];
	if (m % 60 > 0) parts.push(`${m % 60}m`);
	return parts.join(" ");
}

export function fmtCost(usd: number): string {
	if (usd === 0) return "$0";
	return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

export function fmtMoney(amount: number, currency: string): string {
	const symbol = currency === "CNY" || currency === "RMB" ? "¥" : currency === "USD" ? "$" : `${currency} `;
	return `${symbol}${amount.toFixed(2)}`;
}

/** 从原始 usage.cost 里取 USD 总价，形状同 addUsage 里对 cost 字段的兼容处理 */
function usdCostOf(usage: unknown): number {
	if (typeof usage !== "object" || usage === null) return 0;
	const cost = (usage as Record<string, unknown>).cost;
	if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
	if (typeof cost === "object" && cost !== null) {
		const total = (cost as Record<string, unknown>).total;
		return typeof total === "number" && Number.isFinite(total) ? total : 0;
	}
	return 0;
}

/**
 * “本次”一栏展示的钱数：cnyCost 是命中官方价目表精确算出的人民币部分，uncoveredUsd 是
 * 没查到官方价目表、只能沿用 pi-ai 的 USD 计价的部分。两者是不同币种，不做汇率换算/估算，
 * 各自原样显示（比如 "¥2.04 + $0.10"）；都没有(还没花钱)时返回 null，调用方应该整栏不展示，
 * 不然会跟旁边的余额币种并排显示两个不同货币符号，很怪。
 */
export function fmtSessionCost(cnyCost: number, uncoveredUsd: number): string | null {
	const parts: string[] = [];
	if (cnyCost > 0) parts.push(fmtMoney(cnyCost, "CNY"));
	if (uncoveredUsd > 0) parts.push(fmtCost(uncoveredUsd));
	return parts.length > 0 ? parts.join(" + ") : null;
}

interface CnyRate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * 官方人民币价目表（¥ / 百万 token），非 USD 换算得来，provider key 对应 BALANCE_APIS 的 key。
 * 只收录已核实的 provider/model；覆盖不到时 exactCnyCost 返回 null，fmtSessionCost 会把这部分原样按 USD 展示。
 * 三家均未公开 cacheWrite 单独计价，按 0 处理。
 *
 * 来源（2026-07-24 核对）：
 * - deepseek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * - kimi:     https://platform.kimi.com/docs/pricing/chat-k3.md（provider key 对应 models.json 里
 *             被注释掉的 "kimi" 自定义 provider，model id "kimi-k3"；留着以备重新启用）
 * - stepfun:  https://platform.stepfun.com/docs/zh/guides/pricing/details
 */
const CNY_RATES: Partial<Record<string, Record<string, CnyRate>>> = {
	deepseek: {
		"deepseek-v4-flash": { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
		"deepseek-v4-pro": { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0 },
	},
	kimi: {
		"kimi-k3": { input: 20, output: 100, cacheRead: 2, cacheWrite: 0 },
	},
	stepfun: {
		"step-3.7-flash": { input: 1.35, output: 8.1, cacheRead: 0.27, cacheWrite: 0 },
	},
};

/** 按官方 CNY 价目表算一条消息的真实成本；provider/model 不在表中时返回 null */
export function exactCnyCost(
	provider: string,
	model: string,
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number | null {
	const rate = CNY_RATES[provider]?.[model];
	if (!rate) return null;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return (
		(num(usage.input) * rate.input +
			num(usage.output) * rate.output +
			num(usage.cacheRead) * rate.cacheRead +
			num(usage.cacheWrite) * rate.cacheWrite) /
		1_000_000
	);
}

export function bar(percent: number, width: number): string {
	const p = Math.min(100, Math.max(0, percent));
	const filled = Math.round((p / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

// --- 订阅额度（openai-codex） -----------------------------------------------
//
// 配额不在响应头里（实测 after_provider_response 拿到的头只有 connection/
// content-type/date/set-cookie/vary/x-log-id，没有任何 x-codex-*），也不在
// pi 转发的 SSE body 事件里（pi-ai 当前不解析 token_count 事件）。真实来源是
// ChatGPT backend 一个独立的用量查询接口：
//   GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <access token>
//   chatgpt-account-id: <accountId>
// 已用真实账号验证：`readStoredCredential("openai-codex")`（来自
// @earendil-works/pi-coding-agent，同步只读 auth.json）返回的 `access` 直接
// 可用，`accountId` 同一条记录里已存。
//
// 这里刻意只读不刷新：pi 0.81 把 AuthStorage 从包主入口移除了（类还在
// dist/core/auth-storage.ts，但不再导出），带锁刷新的 getApiKey() 也一并没了
// —— 按包内注释，token 编排现在归 ModelRuntime / pi-ai Models。自己复刻那套
// oauth 编排会和 pi 内部强耦合，下次升级照样断，所以 HUD 退成只读跟随：pi 主
// 流程每发一次请求都会刷新并落盘 auth.json，正常使用下 access 一直是新鲜的；
// 真赶上过期窗口就显示 ✗，下一轮 TTL 到期自动恢复。响应形如：
//   { rate_limit: { primary_window: { used_percent, limit_window_seconds,
//   reset_after_seconds } | null, secondary_window: 同结构 | null } }
// window 是 5h 还是 7d（甚至只有一个窗口，如 Plus 订阅只见过 primary=7d、
// secondary=null）随 plan_type 变化，不能假设固定档位，一律按
// limit_window_seconds 现算展示文案。

export interface QuotaWindow {
	usedPercent: number;
	windowSeconds?: number;
	resetsInSeconds?: number;
}

export interface CodexQuota {
	primary?: QuotaWindow;
	secondary?: QuotaWindow;
}

function parseWindow(json: unknown): QuotaWindow | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const w = json as Record<string, unknown>;
	const used = Number(w.used_percent);
	if (!Number.isFinite(used)) return undefined;
	const windowSeconds = Number(w.limit_window_seconds);
	const resetsInSeconds = Number(w.reset_after_seconds);
	return {
		usedPercent: used,
		windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : undefined,
		resetsInSeconds: Number.isFinite(resetsInSeconds) ? resetsInSeconds : undefined,
	};
}

/** 解析 GET .../backend-api/wham/usage 的响应体 */
export function parseCodexUsage(json: unknown): CodexQuota | null {
	if (typeof json !== "object" || json === null) return null;
	const rateLimit = (json as Record<string, unknown>).rate_limit;
	if (typeof rateLimit !== "object" || rateLimit === null) return null;
	const r = rateLimit as Record<string, unknown>;
	const primary = parseWindow(r.primary_window);
	const secondary = parseWindow(r.secondary_window);
	if (!primary && !secondary) return null;
	return { primary, secondary };
}

/** 604800 → "7d"，18000 → "5h"，未知窗口长度 → "窗口" */
export function fmtWindowLabel(seconds: number | undefined): string {
	if (seconds === undefined || seconds <= 0) return "窗口";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 3600 * 48) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}

// --- API key 余额 -----------------------------------------------------------

export interface Balance {
	amount: number;
	currency: string;
}

/** deepseek GET /user/balance → { balance_infos: [{ currency, total_balance }] } */
export function parseDeepseekBalance(json: unknown): Balance | null {
	if (typeof json !== "object" || json === null) return null;
	const infos = (json as Record<string, unknown>).balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) return null;
	const first = infos[0] as Record<string, unknown>;
	const amount = Number(first.total_balance);
	if (!Number.isFinite(amount)) return null;
	return { amount, currency: typeof first.currency === "string" ? first.currency : "CNY" };
}

/** moonshot/kimi GET /v1/users/me/balance → { data: { available_balance } }，币种固定 CNY */
export function parseMoonshotBalance(json: unknown): Balance | null {
	if (typeof json !== "object" || json === null) return null;
	const data = (json as Record<string, unknown>).data;
	if (typeof data !== "object" || data === null) return null;
	const amount = Number((data as Record<string, unknown>).available_balance);
	if (!Number.isFinite(amount)) return null;
	return { amount, currency: "CNY" };
}

/** stepfun GET /v1/accounts → { balance, total_cash_balance, total_voucher_balance }，balance 为可用余额（现金+代金券），CNY */
export function parseStepfunBalance(json: unknown): Balance | null {
	if (typeof json !== "object" || json === null) return null;
	const amount = Number((json as Record<string, unknown>).balance);
	if (!Number.isFinite(amount)) return null;
	return { amount, currency: "CNY" };
}

interface BalanceApi {
	url: string;
	parse: (json: unknown) => Balance | null;
}

/** 有官方余额查询 API 的供应商；新增供应商 = 加一行 */
export const BALANCE_APIS: Record<string, BalanceApi> = {
	deepseek: { url: "https://api.deepseek.com/user/balance", parse: parseDeepseekBalance },
	kimi: { url: "https://api.moonshot.cn/v1/users/me/balance", parse: parseMoonshotBalance },
	moonshot: { url: "https://api.moonshot.cn/v1/users/me/balance", parse: parseMoonshotBalance },
	stepfun: { url: "https://api.stepfun.com/v1/accounts", parse: parseStepfunBalance },
};

// --- auth.json --------------------------------------------------------------

export type AuthKind = "oauth" | "api_key" | "none";

export interface AuthInfo {
	kind: AuthKind;
	apiKey?: string;
}

/** 读 ~/.pi/agent/auth.json 中指定 provider 的认证形态；缺失/异常 → none */
export function readAuthInfo(authPath: string, provider: string): AuthInfo {
	try {
		const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
		const entry = raw[provider];
		if (typeof entry !== "object" || entry === null) return { kind: "none" };
		const e = entry as Record<string, unknown>;
		if (e.type === "oauth") return { kind: "oauth" };
		if (e.type === "api_key") {
			return { kind: "api_key", apiKey: typeof e.key === "string" ? e.key : undefined };
		}
		return { kind: "none" };
	} catch {
		return { kind: "none" };
	}
}

// --- subagent 聚合 ------------------------------------------------------------

export interface SubagentRecord {
	agent: string;
	model: string;
	usage: UsageAgg;
	turns: number;
}

/**
 * 记录一次 subagent tool_result。store 以 runKey（details.runId，缺失则用
 * fallbackKey）为键整体覆盖 —— 同一 run 被状态查询重复上报时不会重复累加。
 */
export function recordSubagentResults(
	store: Map<string, SubagentRecord[]>,
	details: unknown,
	fallbackKey: string,
): void {
	if (typeof details !== "object" || details === null) return;
	const d = details as Record<string, unknown>;
	const results = d.results;
	if (!Array.isArray(results) || results.length === 0) return;
	const records: SubagentRecord[] = [];
	for (const r of results) {
		if (typeof r !== "object" || r === null) continue;
		const rec = r as Record<string, unknown>;
		const usage = emptyAgg();
		addUsage(usage, rec.usage);
		const turns =
			typeof rec.usage === "object" && rec.usage !== null && typeof (rec.usage as Record<string, unknown>).turns === "number"
				? ((rec.usage as Record<string, unknown>).turns as number)
				: 0;
		records.push({
			agent: typeof rec.agent === "string" ? rec.agent : "agent",
			model: typeof rec.model === "string" ? rec.model : "?",
			usage,
			turns,
		});
	}
	if (records.length === 0) return;
	const runKey = typeof d.runId === "string" ? d.runId : fallbackKey;
	store.set(runKey, records);
}

/** 跨所有 run 按 agent+model 汇总，附运行次数 */
export function summarizeSubagents(
	store: Map<string, SubagentRecord[]>,
): Array<SubagentRecord & { runs: number }> {
	const byKey = new Map<string, SubagentRecord & { runs: number }>();
	for (const records of store.values()) {
		for (const r of records) {
			const key = `${r.agent} ${r.model}`;
			const acc = byKey.get(key);
			if (acc) {
				acc.usage.input += r.usage.input;
				acc.usage.output += r.usage.output;
				acc.usage.cacheRead += r.usage.cacheRead;
				acc.usage.cacheWrite += r.usage.cacheWrite;
				acc.usage.cost += r.usage.cost;
				acc.turns += r.turns;
				acc.runs += 1;
			} else {
				byKey.set(key, { ...r, usage: { ...r.usage }, runs: 1 });
			}
		}
	}
	return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

const WIDGET_ID = "hud";
const BALANCE_TTL_MS = 5 * 60 * 1000;
const CODEX_QUOTA_TTL_MS = 5 * 60 * 1000;
const GO_QUOTA_TTL_MS = 5 * 60 * 1000;
const STREAM_REFRESH_MS = 300;
const OPENCODE_GO_PROVIDER = "opencode-go";

export default function hud(pi: ExtensionAPI) {
	let enabled = true;
	let runStart: number | null = null; // 当前 agent run 开始时间
	let activeMs = 0; // 已结束 run 的累计活跃时长
	let msgStart: number | null = null; // 当前流式 assistant 消息开始时间
	let streamChars = 0; // 当前流式消息已收到的字符数（tok/s 实时估算用）
	let lastSpeed: number | null = null; // 最近一条完成消息的真实 tok/s
	let codexQuota: CodexQuota | null = null;
	let codexQuotaAt = 0;
	let codexQuotaFailed = false; // 上一次查询失败（渲染成 ✗，避免静默显示"—"查不出原因）
	let goQuota: GoQuota | null = null;
	let goQuotaAt = 0;
	let goQuotaFailed = false;
	let auth: AuthInfo = { kind: "none" };
	let balance: Balance | null = null;
	let balanceAt = 0;
	const subRuns = new Map<string, SubagentRecord[]>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastStreamRefresh = 0;

	const agentDir = path.join(os.homedir(), ".pi", "agent");
	const authPath = path.join(agentDir, "auth.json");

	/**
	 * 逐条消息各自判断能不能查到官方 CNY 价目表：能查到的精确累加进 cnyCost，
	 * 查不到的（比如切换过没有价目表的模型）只把那一条的 USD cost 计入 uncoveredUsd，
	 * 不会因为某一条没有价目表就让整个 session 都退化成汇率估算。
	 */
	function aggregateBranch(ctx: ExtensionContext): { agg: UsageAgg; cnyCost: number; uncoveredUsd: number } {
		const agg = emptyAgg();
		let cnyCost = 0;
		let uncoveredUsd = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const msg = entry.message as { usage?: unknown; provider?: string; model?: string };
				addUsage(agg, msg.usage);
				const usage = (typeof msg.usage === "object" && msg.usage !== null ? msg.usage : {}) as Record<string, number>;
				const exact = msg.provider && msg.model ? exactCnyCost(msg.provider, msg.model, usage) : null;
				if (exact !== null) cnyCost += exact;
				else uncoveredUsd += usdCostOf(msg.usage);
			}
		}
		return { agg, cnyCost, uncoveredUsd };
	}

	function maybeFetchBalance(ctx: ExtensionContext): void {
		const provider = ctx.model?.provider;
		if (!provider || auth.kind !== "api_key" || !auth.apiKey) return;
		const api = BALANCE_APIS[provider];
		if (!api || Date.now() - balanceAt < BALANCE_TTL_MS) return;
		balanceAt = Date.now();
		fetch(api.url, {
			headers: { Authorization: `Bearer ${auth.apiKey}` },
			signal: AbortSignal.timeout(5000),
		})
			.then((res) => (res.ok ? res.json() : null))
			.then((json: unknown) => {
				if (json !== null) {
					balance = api.parse(json);
					refresh(ctx);
				}
			})
			.catch(() => {
				/* 余额查询失败不影响 HUD 其余部分 */
			});
	}

	function maybeFetchCodexQuota(ctx: ExtensionContext): void {
		if (ctx.model?.provider !== "openai-codex" || auth.kind !== "oauth") return;
		if (Date.now() - codexQuotaAt < CODEX_QUOTA_TTL_MS) return;
		codexQuotaAt = Date.now();
		(async () => {
			const { readStoredCredential } = await import("@earendil-works/pi-coding-agent");
			const cred = readStoredCredential("openai-codex");
			if (cred?.type !== "oauth" || !cred.access || !cred.accountId) throw new Error("no codex oauth credential");
			const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
				headers: { Authorization: `Bearer ${cred.access}`, "chatgpt-account-id": String(cred.accountId), originator: "pi" },
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) throw new Error(`wham/usage ${res.status}`);
			codexQuota = parseCodexUsage(await res.json());
			codexQuotaFailed = false;
			refresh(ctx);
		})().catch(() => {
			// 配额查询失败不影响 HUD 其余部分，但要在 UI 上留痕（✗），
			// 否则下次上游 API 变动时又只剩一个查不出原因的"—"
			codexQuotaFailed = true;
			refresh(ctx);
		});
	}

	function maybeFetchOpencodeGoQuota(ctx: ExtensionContext): void {
		if (ctx.model?.provider !== OPENCODE_GO_PROVIDER) return;
		if (Date.now() - goQuotaAt < GO_QUOTA_TTL_MS) return;
		goQuotaAt = Date.now();
		const apiKey = auth.kind === "api_key" ? auth.apiKey : undefined;
		// fetch 全链路 async（含 Chrome Keychain），不阻塞 agent 主循环
		fetchOpencodeGoQuota({ apiKey, agentDir })
			.then((q) => {
				const next = applyGoQuotaFetchResult(goQuota, q);
				goQuota = next.goQuota;
				goQuotaFailed = next.goQuotaFailed;
				refresh(ctx);
			})
			.catch(() => {
				const next = applyGoQuotaFetchResult(goQuota, null);
				goQuota = next.goQuota;
				goQuotaFailed = next.goQuotaFailed;
				refresh(ctx);
			});
	}

	function buildLines(ctx: ExtensionContext): string[] {
		const t = ctx.ui.theme;
		const sep = t.fg("dim", " │ ");
		const lines: string[] = [];
		const { agg, cnyCost, uncoveredUsd } = aggregateBranch(ctx);

		// ── 第 1 行：主 agent + 认证形态 ──
		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const seg1: string[] = [`${t.fg("accent", "λ")} ${t.fg("accent", modelLabel)}`];
		const isOpencodeGo = ctx.model?.provider === OPENCODE_GO_PROVIDER;
		if (isOpencodeGo) {
			// Go 是 api_key 存盘但产品是订阅三窗口，不走余额分支
			const goParts: string[] = [];
			for (const { label, window: w } of goQuota ? goQuotaWindowEntries(goQuota) : []) {
				const left = Math.max(0, 100 - w.usedPercent);
				let s = `${label} 剩 ${left.toFixed(0)}%`;
				if (w.resetsInSeconds !== undefined) s += t.fg("dim", ` (重置 ${fmtDuration(w.resetsInSeconds * 1000)})`);
				goParts.push(s);
			}
			const quotaText =
				goParts.length > 0
					? goParts.join(t.fg("dim", " · "))
					: goQuotaFailed
						? t.fg("error", "额度 ✗")
						: t.fg("dim", "额度 —");
			seg1.push(`${t.fg("muted", "订阅")} ${quotaText}`);
			if (goQuota?.useBalance) seg1.push(t.fg("dim", "Zen余额回落开"));
			const sessionCost = fmtSessionCost(cnyCost, uncoveredUsd);
			if (sessionCost !== null) seg1.push(`本次 ${t.fg("warning", sessionCost)}`);
		} else if (auth.kind === "oauth") {
			const quotaParts: string[] = [];
			if (codexQuota?.primary) {
				const q = codexQuota.primary;
				const left = Math.max(0, 100 - q.usedPercent);
				let s = `${fmtWindowLabel(q.windowSeconds)} 剩 ${left.toFixed(0)}%`;
				if (q.resetsInSeconds !== undefined) s += t.fg("dim", ` (重置 ${fmtDuration(q.resetsInSeconds * 1000)})`);
				quotaParts.push(s);
			}
			if (codexQuota?.secondary) {
				const q = codexQuota.secondary;
				quotaParts.push(`${fmtWindowLabel(q.windowSeconds)} 剩 ${Math.max(0, 100 - q.usedPercent).toFixed(0)}%`);
			}
			const quotaText =
				quotaParts.length > 0
					? quotaParts.join(t.fg("dim", " · "))
					: codexQuotaFailed
						? t.fg("error", "额度 ✗")
						: t.fg("dim", "额度 —");
			seg1.push(`${t.fg("muted", "订阅")} ${quotaText}`);
		} else {
			// 只有在 BALANCE_APIS 里登记过的才显示余额栏，避免 opencode-go 之类误导成「余额 —」
			if (auth.kind === "api_key" && ctx.model?.provider && BALANCE_APIS[ctx.model.provider]) {
				seg1.push(
					`${t.fg("muted", "API")} 余额 ${balance ? t.fg("success", fmtMoney(balance.amount, balance.currency)) : t.fg("dim", "—")}`,
				);
			}
			const sessionCost = fmtSessionCost(cnyCost, uncoveredUsd);
			if (sessionCost !== null) seg1.push(`本次 ${t.fg("warning", sessionCost)}`);
		}
		lines.push(seg1.join(sep));

		// ── 第 2 行：context + 执行时间 + token 速度 + 缓存命中 ──
		const seg2: string[] = [];
		const usage = ctx.getContextUsage();
		if (usage) {
			const pct = usage.percent ?? 0;
			const pctColor = pct >= 85 ? "error" : pct >= 70 ? "warning" : "success";
			const tok = usage.tokens !== null ? fmtTokens(usage.tokens) : "?";
			seg2.push(
				`${t.fg("accent", "⊡")} ${bar(pct, 10)} ${t.fg(pctColor, `${pct.toFixed(1)}%`)} ${t.fg("dim", `${tok}/${fmtTokens(usage.contextWindow)}`)}`,
			);
		}
		const elapsed = activeMs + (runStart !== null ? Date.now() - runStart : 0);
		if (elapsed > 0) seg2.push(`${t.fg("muted", "⏱")} ${fmtDuration(elapsed)}`);
		let speed: number | null = lastSpeed;
		if (msgStart !== null && Date.now() - msgStart > 1000) {
			speed = streamChars / 4 / ((Date.now() - msgStart) / 1000); // 流式期间粗估：4 字符 ≈ 1 token
		}
		if (speed !== null && speed > 0) seg2.push(`${t.fg("muted", "⚡")} ${speed.toFixed(0)} tok/s`);
		const hit = cacheHitRate(agg);
		if (hit !== null) seg2.push(`${t.fg("muted", "⛁")} cache ${hit.toFixed(0)}%`);
		seg2.push(t.fg("dim", `↑${fmtTokens(agg.input + agg.cacheRead + agg.cacheWrite)} ↓${fmtTokens(agg.output)}`));
		lines.push(seg2.join(sep));

		// ── 第 3 行：subagents（有才显示） ──
		const subs = summarizeSubagents(subRuns);
		if (subs.length > 0) {
			const parts = subs.map((s) => {
				const cost = s.usage.cost > 0 ? ` ${t.fg("warning", fmtCost(s.usage.cost))}` : "";
				const runs = s.runs > 1 ? t.fg("dim", ` ×${s.runs}`) : "";
				return `${t.fg("accent", s.agent)} ${t.fg("muted", s.model)} ${t.fg("dim", `↑${fmtTokens(s.usage.input + s.usage.cacheRead + s.usage.cacheWrite)} ↓${fmtTokens(s.usage.output)}`)}${cost}${runs}`;
			});
			lines.push(`${t.fg("muted", "↳")} ${parts.join(sep)}`);
		}

		return lines;
	}

	function refresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		try {
			ctx.ui.setWidget(WIDGET_ID, buildLines(ctx), { placement: "belowEditor" });
		} catch {
			/* 渲染失败不打断 agent */
		}
	}

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) auth = readAuthInfo(authPath, ctx.model.provider);
		maybeFetchBalance(ctx);
		maybeFetchCodexQuota(ctx);
		maybeFetchOpencodeGoQuota(ctx);
		refresh(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		auth = readAuthInfo(authPath, event.model.provider);
		balance = null;
		balanceAt = 0;
		codexQuota = null;
		codexQuotaAt = 0;
		codexQuotaFailed = false;
		goQuota = null;
		goQuotaAt = 0;
		goQuotaFailed = false;
		maybeFetchBalance(ctx);
		maybeFetchCodexQuota(ctx);
		maybeFetchOpencodeGoQuota(ctx);
		refresh(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		runStart = Date.now();
		stopTimer();
		timer = setInterval(() => refresh(ctx), 1000); // 执行时间/流式速度的秒级走字
		refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (runStart !== null) {
			activeMs += Date.now() - runStart;
			runStart = null;
		}
		refresh(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopTimer();
		maybeFetchBalance(ctx);
		maybeFetchCodexQuota(ctx);
		maybeFetchOpencodeGoQuota(ctx);
		refresh(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role === "assistant") {
			msgStart = Date.now();
			streamChars = 0;
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		let chars = 0;
		for (const c of event.message.content) {
			if (c.type === "text") chars += c.text.length;
			else if (c.type === "thinking") chars += c.thinking.length;
		}
		streamChars = chars;
		const now = Date.now();
		if (now - lastStreamRefresh >= STREAM_REFRESH_MS) {
			lastStreamRefresh = now;
			refresh(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (msgStart !== null) {
			const dt = (Date.now() - msgStart) / 1000;
			const out = (event.message as { usage?: { output?: number } }).usage?.output ?? 0;
			if (dt > 0.5 && out > 0) lastSpeed = out / dt;
			msgStart = null;
		}
		refresh(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "subagent" && !event.isError) {
			recordSubagentResults(subRuns, (event as { details?: unknown }).details, event.toolCallId);
		}
		refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));

	pi.registerCommand("hud", {
		description: "Toggle the HUD statusline widget",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			refresh(ctx);
			ctx.ui.notify(`hud: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
