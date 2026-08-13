/**
 * hud 纯函数测试
 * 运行：node --test tests/hud.test.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	addUsage,
	applyGoQuotaFetchResult,
	bar,
	cacheHitRate,
	classifyDashboardAuthFailure,
	classifyGoWindowName,
	emptyAgg,
	exactCnyCost,
	fmtCost,
	fmtDuration,
	fmtMoney,
	fmtSessionCost,
	fmtTokens,
	fmtWindowLabel,
	formatGoQuotaStatusText,
	GO_AUTH_LOGIN_URL,
	goAuthNotifyMessage,
	goQuotaWindowEntries,
	parseCodexUsage,
	parseDeepseekBalance,
	parseMoonshotBalance,
	parseOpencodeGoDashboardHtml,
	parseOpencodeGoUsage,
	parseStepfunBalance,
	readAuthInfo,
	recordSubagentResults,
	resolveOpencodeGoQuotaConfig,
	shouldNotifyGoAuthExpired,
	summarizeSubagents,
	type SubagentRecord,
} from "../src/index.ts";

test("fmtTokens", () => {
	assert.equal(fmtTokens(0), "0");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5k");
	assert.equal(fmtTokens(1_048_576), "1.0M");
});

test("fmtDuration", () => {
	assert.equal(fmtDuration(500), "0s");
	assert.equal(fmtDuration(42_000), "42s");
	assert.equal(fmtDuration(60_000), "1m");
	assert.equal(fmtDuration(192_000), "3m12s");
	assert.equal(fmtDuration(3_600_000), "1h");
	assert.equal(fmtDuration(8_040_000), "2h14m");
	assert.equal(fmtDuration((7 * 24 * 60 + 8 * 60 + 22) * 60_000), "7d 8h 22m");
});

test("fmtCost / fmtMoney", () => {
	assert.equal(fmtCost(0), "$0");
	assert.equal(fmtCost(0.412), "$0.412");
	assert.equal(fmtCost(1.5), "$1.50");
	assert.equal(fmtMoney(110.2, "CNY"), "¥110.20");
	assert.equal(fmtMoney(3.5, "USD"), "$3.50");
	assert.equal(fmtMoney(1, "EUR"), "EUR 1.00");
});

test("fmtSessionCost: 精确 CNY 与未覆盖 USD 分开原样显示，不做汇率换算；都没有时返回 null", () => {
	assert.equal(fmtSessionCost(2.04, 0), "¥2.04");
	assert.equal(fmtSessionCost(0, 0.412), "$0.412");
	assert.equal(fmtSessionCost(2.04, 0.412), "¥2.04 + $0.412");
	assert.equal(fmtSessionCost(0, 0), null);
});

test("exactCnyCost: deepseek 官方价目表按 token 精确算价，未知 provider/model 返回 null", () => {
	// deepseek-v4-flash：input(未命中) ¥1/M、cacheRead(命中) ¥0.02/M、output ¥2/M
	const cost = exactCnyCost("deepseek", "deepseek-v4-flash", { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 });
	assert.ok(cost !== null);
	assert.ok(Math.abs((cost as number) - (1 + 1 + 0.04)) < 1e-9);
	assert.equal(exactCnyCost("deepseek", "unknown-model", { input: 1000 }), null);
	assert.equal(exactCnyCost("openai", "gpt-5", { input: 1000 }), null);
});

test("exactCnyCost: kimi-k3 / stepfun 官方价目表", () => {
	// kimi-k3：input(未命中) ¥20/M、output ¥100/M
	const kimi = exactCnyCost("kimi", "kimi-k3", { input: 1_000_000, output: 1_000_000 });
	assert.ok(kimi !== null && Math.abs((kimi as number) - 120) < 1e-9);
	// step-3.7-flash：input(未命中) ¥1.35/M、output ¥8.1/M
	const step = exactCnyCost("stepfun", "step-3.7-flash", { input: 1_000_000, output: 1_000_000 });
	assert.ok(step !== null && Math.abs((step as number) - 9.45) < 1e-9);
});

test("bar", () => {
	assert.equal(bar(0, 10), "░░░░░░░░░░");
	assert.equal(bar(50, 10), "█████░░░░░");
	assert.equal(bar(100, 10), "██████████");
	assert.equal(bar(150, 10), "██████████"); // 越界收敛
	assert.equal(bar(-5, 10), "░░░░░░░░░░");
});

test("addUsage: pi-ai 形状（cost.total）", () => {
	const agg = emptyAgg();
	addUsage(agg, { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, cost: { total: 0.12 } });
	addUsage(agg, { input: 10, output: 5, cacheRead: 90, cacheWrite: 3, cost: { total: 0.01 } });
	assert.equal(agg.input, 110);
	assert.equal(agg.output, 55);
	assert.equal(agg.cacheRead, 990);
	assert.equal(agg.cacheWrite, 33);
	assert.ok(Math.abs(agg.cost - 0.13) < 1e-9);
});

test("addUsage: pi-subagents 形状（cost 为 number）与脏输入", () => {
	const agg = emptyAgg();
	addUsage(agg, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 });
	addUsage(agg, null);
	addUsage(agg, "garbage");
	addUsage(agg, { input: "NaN", cost: {} });
	assert.deepEqual(agg, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 });
});

test("cacheHitRate", () => {
	const agg = emptyAgg();
	assert.equal(cacheHitRate(agg), null); // 无 prompt tokens
	addUsage(agg, { input: 100, output: 0, cacheRead: 850, cacheWrite: 50, cost: 0 });
	assert.equal(cacheHitRate(agg), 85);
});

// 两个真实抓包样本：
// 1) 双窗口（来自 openai/codex 官方 issue 讨论的 rate_limits 结构，5h + 7d）
// 2) 单窗口（本机 Plus 订阅账号真实 GET .../backend-api/wham/usage 响应，只有 7d 窗口，secondary 为 null）
test("parseCodexUsage: 双窗口样本", () => {
	const q = parseCodexUsage({
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 34.5, limit_window_seconds: 18000, reset_after_seconds: 8040, reset_at: 1776111121 },
			secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 351406, reset_at: 1776672455 },
		},
	});
	assert.ok(q);
	assert.equal(q.primary?.usedPercent, 34.5);
	assert.equal(q.primary?.windowSeconds, 18000);
	assert.equal(q.primary?.resetsInSeconds, 8040);
	assert.equal(q.secondary?.usedPercent, 12);
	assert.equal(q.secondary?.windowSeconds, 604800);
});

test("parseCodexUsage: 单窗口样本（Plus 订阅，secondary 为 null）", () => {
	const q = parseCodexUsage({
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 66, limit_window_seconds: 604800, reset_after_seconds: 523970, reset_at: 1785148410 },
			secondary_window: null,
		},
		credits: { has_credits: false },
	});
	assert.ok(q);
	assert.equal(q.primary?.usedPercent, 66);
	assert.equal(q.secondary, undefined);
});

test("parseCodexUsage: 无 rate_limit / 脏输入 / used_percent 非法", () => {
	assert.equal(parseCodexUsage({ plan_type: "plus" }), null);
	assert.equal(parseCodexUsage(null), null);
	assert.equal(parseCodexUsage("garbage"), null);
	assert.equal(
		parseCodexUsage({ rate_limit: { primary_window: { used_percent: "abc" }, secondary_window: null } }),
		null,
	);
});

test("fmtWindowLabel", () => {
	assert.equal(fmtWindowLabel(18000), "5h");
	assert.equal(fmtWindowLabel(604800), "7d");
	assert.equal(fmtWindowLabel(1800), "30m");
	assert.equal(fmtWindowLabel(undefined), "窗口");
	assert.equal(fmtWindowLabel(0), "窗口");
});

// 真实抓包样本：GET https://opencode.ai/zen/go/v1/usage 带 api key 的响应
test("parseDeepseekBalance", () => {
	const b = parseDeepseekBalance({
		is_available: true,
		balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "0.00" }],
	});
	assert.deepEqual(b, { amount: 110, currency: "CNY" });
	assert.equal(parseDeepseekBalance({ balance_infos: [] }), null);
	assert.equal(parseDeepseekBalance(null), null);
	assert.equal(parseDeepseekBalance({ balance_infos: [{ total_balance: "abc" }] }), null);
});

test("parseMoonshotBalance", () => {
	const b = parseMoonshotBalance({ code: 0, data: { available_balance: 49.58 }, status: true });
	assert.deepEqual(b, { amount: 49.58, currency: "CNY" });
	assert.equal(parseMoonshotBalance({ data: {} }), null);
	assert.equal(parseMoonshotBalance(undefined), null);
});

test("parseStepfunBalance", () => {
	const b = parseStepfunBalance({
		object: "account",
		type: "prepaid",
		balance: 12.5,
		total_cash_balance: 0,
		total_voucher_balance: 12.5,
	});
	assert.deepEqual(b, { amount: 12.5, currency: "CNY" });
	assert.equal(parseStepfunBalance({ object: "account" }), null);
	assert.equal(parseStepfunBalance(null), null);
});

test("readAuthInfo", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hud-test-"));
	const authPath = path.join(dir, "auth.json");
	fs.writeFileSync(
		authPath,
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "x", refresh: "y" },
			deepseek: { type: "api_key", key: "sk-test" },
		}),
	);
	assert.deepEqual(readAuthInfo(authPath, "openai-codex"), { kind: "oauth" });
	assert.deepEqual(readAuthInfo(authPath, "deepseek"), { kind: "api_key", apiKey: "sk-test" });
	assert.deepEqual(readAuthInfo(authPath, "unknown"), { kind: "none" });
	assert.deepEqual(readAuthInfo(path.join(dir, "missing.json"), "deepseek"), { kind: "none" });
	fs.rmSync(dir, { recursive: true, force: true });
});

const subUsage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	cost,
	turns: 1,
});

test("recordSubagentResults: 同 runId 覆盖不累加", () => {
	const store = new Map<string, SubagentRecord[]>();
	const details = {
		runId: "run-1",
		results: [{ agent: "scout", model: "kimi-k3", usage: subUsage(1000, 200, 0.01) }],
	};
	recordSubagentResults(store, details, "call-1");
	// 管理类查询把同一 run 的最新状态再报一次（usage 更大）
	recordSubagentResults(
		store,
		{ runId: "run-1", results: [{ agent: "scout", model: "kimi-k3", usage: subUsage(2000, 400, 0.02) }] },
		"call-2",
	);
	const subs = summarizeSubagents(store);
	assert.equal(subs.length, 1);
	assert.equal(subs[0].usage.input, 2000);
	assert.equal(subs[0].runs, 1);
});

test("recordSubagentResults: 无 runId 用 fallbackKey，各自独立累加", () => {
	const store = new Map<string, SubagentRecord[]>();
	recordSubagentResults(store, { results: [{ agent: "scout", model: "kimi-k3", usage: subUsage(1000, 200, 0.01) }] }, "call-1");
	recordSubagentResults(store, { results: [{ agent: "scout", model: "kimi-k3", usage: subUsage(500, 100, 0.005) }] }, "call-2");
	const subs = summarizeSubagents(store);
	assert.equal(subs.length, 1);
	assert.equal(subs[0].usage.input, 1500);
	assert.equal(subs[0].usage.output, 300);
	assert.equal(subs[0].runs, 2);
});

test("summarizeSubagents: 不同 agent/model 分开统计", () => {
	const store = new Map<string, SubagentRecord[]>();
	recordSubagentResults(
		store,
		{
			runId: "run-1",
			results: [
				{ agent: "scout", model: "kimi-k3", usage: subUsage(100, 10, 0.001) },
				{ agent: "worker", model: "deepseek-chat", usage: subUsage(200, 20, 0.002) },
			],
		},
		"call-1",
	);
	const subs = summarizeSubagents(store).sort((a, b) => a.agent.localeCompare(b.agent));
	assert.equal(subs.length, 2);
	assert.equal(subs[0].agent, "scout");
	assert.equal(subs[1].agent, "worker");
	assert.equal(subs[1].model, "deepseek-chat");
});

test("recordSubagentResults: 脏 details 不入库", () => {
	const store = new Map<string, SubagentRecord[]>();
	recordSubagentResults(store, null, "c1");
	recordSubagentResults(store, {}, "c2");
	recordSubagentResults(store, { results: [] }, "c3");
	recordSubagentResults(store, { results: ["garbage"] }, "c4");
	assert.equal(store.size, 0);
});

// --- OpenCode Go -------------------------------------------------------------

test("parseOpencodeGoUsage: PR #16513 对象形（rolling/weekly/monthly）", () => {
	const q = parseOpencodeGoUsage({
		useBalance: false,
		rollingUsage: { status: "ok", resetInSec: 2520, usagePercent: 65 },
		weeklyUsage: { status: "ok", resetInSec: 259200, usagePercent: 30 },
		monthlyUsage: { status: "ok", resetInSec: 1728000, usagePercent: 12 },
	});
	assert.ok(q);
	assert.equal(q.rolling?.usedPercent, 65);
	assert.equal(q.rolling?.resetsInSeconds, 2520);
	assert.equal(q.weekly?.usedPercent, 30);
	assert.equal(q.monthly?.usedPercent, 12);
	assert.equal(q.useBalance, false);
	assert.equal(q.source, "api");
});

test("parseOpencodeGoUsage: windows[] 形 + 脏输入", () => {
	const q = parseOpencodeGoUsage({
		windows: [
			{ name: "5-hour", usagePercent: 10, resetInSec: 100 },
			{ name: "weekly", usagePercent: 20, resetInSec: 200 },
			{ name: "monthly", usagePercent: 30, resetInSec: 300 },
		],
	});
	assert.ok(q);
	assert.equal(q.rolling?.usedPercent, 10);
	assert.equal(q.weekly?.usedPercent, 20);
	assert.equal(q.monthly?.usedPercent, 30);
	assert.equal(parseOpencodeGoUsage(null), null);
	assert.equal(parseOpencodeGoUsage({}), null);
	assert.equal(parseOpencodeGoUsage({ rollingUsage: { usagePercent: "x" } }), null);
});

test("classifyGoWindowName: week/month 优先于 hour/5，避免误分类", () => {
	assert.equal(classifyGoWindowName("weekly"), "weekly");
	assert.equal(classifyGoWindowName("5-hour"), "rolling");
	assert.equal(classifyGoWindowName("rolling"), "rolling");
	assert.equal(classifyGoWindowName("monthly"), "monthly");
	// 旧逻辑 name.includes("5") 会把 "week-5" 之类误判；现要求 week 先命中
	assert.equal(classifyGoWindowName("week-5"), "weekly");
	assert.equal(classifyGoWindowName("unknown"), null);
});

test("parseOpencodeGoDashboardHtml: SSR hydration 样本（字段顺序 status/reset/percent）", () => {
	const html = `
		<script>/*$*/rollingUsage:$R[35]={status:"ok",resetInSec:17577,usagePercent:8}/*$*/
		weeklyUsage:$R[36]={status:"ok",resetInSec:56759,usagePercent:22}
		monthlyUsage:$R[37]={status:"ok",resetInSec:2486823,usagePercent:41}</script>
	`;
	const q = parseOpencodeGoDashboardHtml(html);
	assert.ok(q);
	assert.equal(q.source, "dashboard");
	assert.equal(q.rolling?.usedPercent, 8);
	assert.equal(q.rolling?.resetsInSeconds, 17577);
	assert.equal(q.weekly?.usedPercent, 22);
	assert.equal(q.monthly?.usedPercent, 41);
});

test("parseOpencodeGoDashboardHtml: percent-first 顺序 + data-slot 回退", () => {
	const ssr = `rollingUsage:$R[1]={usagePercent:50,resetInSec:3600}`;
	const q1 = parseOpencodeGoDashboardHtml(ssr);
	assert.equal(q1?.rolling?.usedPercent, 50);
	assert.equal(q1?.rolling?.resetsInSeconds, 3600);

	const slot = `
		<div data-slot="usage-item">
			<span data-slot="usage-label">Rolling Usage</span>
			<span data-slot="usage-value">15%</span>
			<span data-slot="reset-time">Resets in 2 hours 10 minutes</span>
		</div>
		<div data-slot="usage-item">
			<span data-slot="usage-label">Weekly Usage</span>
			<span data-slot="usage-value">40%</span>
			<span data-slot="reset-time">Resets in 3 days</span>
		</div>
	`;
	const q2 = parseOpencodeGoDashboardHtml(slot);
	assert.ok(q2);
	assert.equal(q2.rolling?.usedPercent, 15);
	assert.equal(q2.rolling?.resetsInSeconds, 2 * 3600 + 10 * 60);
	assert.equal(q2.weekly?.usedPercent, 40);
	assert.equal(q2.weekly?.resetsInSeconds, 3 * 86400);
	assert.equal(parseOpencodeGoDashboardHtml("<html>no usage</html>"), null);
});

test("parseOpencodeGoDashboardHtml: SSR 缺一窗时用 data-slot 补齐，不丢已有 SSR 窗", () => {
	const html = `
		rollingUsage:$R[1]={usagePercent:11,resetInSec:100}
		<div data-slot="usage-item">
			<span data-slot="usage-label">Weekly Usage</span>
			<span data-slot="usage-value">22%</span>
			<span data-slot="reset-time">Resets in 1 day</span>
		</div>
		<div data-slot="usage-item">
			<span data-slot="usage-label">Monthly Usage</span>
			<span data-slot="usage-value">33%</span>
			<span data-slot="reset-time">Resets in 2 days</span>
		</div>
	`;
	const q = parseOpencodeGoDashboardHtml(html);
	assert.ok(q);
	assert.equal(q.rolling?.usedPercent, 11);
	assert.equal(q.weekly?.usedPercent, 22);
	assert.equal(q.monthly?.usedPercent, 33);
});

test("goQuotaWindowEntries: 稳定顺序 5h/周/月", () => {
	const entries = goQuotaWindowEntries({
		monthly: { usedPercent: 1 },
		rolling: { usedPercent: 2 },
		weekly: { usedPercent: 3 },
	});
	assert.deepEqual(
		entries.map((e) => e.label),
		["5h", "周", "月"],
	);
	assert.equal(entries[0].window.usedPercent, 2);
});

test("applyGoQuotaFetchResult: 失败清陈旧，成功替换，auth 标记需重登", () => {
	const stale = { rolling: { usedPercent: 90 }, source: "dashboard" as const };
	const fail = applyGoQuotaFetchResult(stale, { quota: null, reason: "unavailable" });
	assert.equal(fail.goQuota, null);
	assert.equal(fail.goQuotaFailed, true);
	assert.equal(fail.goAuthExpired, false);
	assert.equal(formatGoQuotaStatusText(fail.goQuota, fail.goQuotaFailed, fail.goAuthExpired), "额度 ✗");

	const authFail = applyGoQuotaFetchResult(stale, { quota: null, reason: "auth_expired" });
	assert.equal(authFail.goAuthExpired, true);
	assert.equal(formatGoQuotaStatusText(authFail.goQuota, authFail.goQuotaFailed, authFail.goAuthExpired), "额度 ✗ 需重登");

	const noCred = applyGoQuotaFetchResult(null, { quota: null, reason: "no_credentials" });
	assert.equal(noCred.goAuthExpired, true);

	const fresh = { rolling: { usedPercent: 10, resetsInSeconds: 60 }, source: "api" as const };
	const ok = applyGoQuotaFetchResult(stale, { quota: fresh, reason: "ok" });
	assert.equal(ok.goQuotaFailed, false);
	assert.equal(ok.goAuthExpired, false);
	assert.equal(ok.goQuota?.rolling?.usedPercent, 10);
	assert.match(formatGoQuotaStatusText(ok.goQuota, ok.goQuotaFailed, ok.goAuthExpired), /5h 剩 90%/);
});

test("formatGoQuotaStatusText: 未就绪显示 —", () => {
	assert.equal(formatGoQuotaStatusText(null, false), "额度 —");
	assert.equal(formatGoQuotaStatusText(null, false, false), "额度 —");
});

test("classifyDashboardAuthFailure: 401/登录页/密码框 → auth_expired", () => {
	assert.equal(classifyDashboardAuthFailure(401, "https://opencode.ai/workspace/x/go", ""), "auth_expired");
	assert.equal(classifyDashboardAuthFailure(403, "https://opencode.ai/workspace/x/go", ""), "auth_expired");
	assert.equal(
		classifyDashboardAuthFailure(200, "https://opencode.ai/auth/login", "<html>welcome</html>"),
		"auth_expired",
	);
	assert.equal(
		classifyDashboardAuthFailure(200, "https://opencode.ai/workspace/x/go", '<input type="password" />'),
		"auth_expired",
	);
	assert.equal(
		classifyDashboardAuthFailure(500, "https://opencode.ai/workspace/x/go", "internal error"),
		"unavailable",
	);
});

test("shouldNotifyGoAuthExpired: 仅在新进入失效态时提醒一次", () => {
	assert.equal(shouldNotifyGoAuthExpired(false, true), true);
	assert.equal(shouldNotifyGoAuthExpired(true, true), false);
	assert.equal(shouldNotifyGoAuthExpired(true, false), false);
	assert.equal(shouldNotifyGoAuthExpired(false, false), false);
});

test("goAuthNotifyMessage: 用 /auth 而非 404 的 /workspace；有 wrk 时附带 /go", () => {
	const base = goAuthNotifyMessage();
	assert.match(base, /opencode\.ai\/auth/);
	assert.doesNotMatch(base, /opencode\.ai\/workspace[^\w/]/);
	assert.equal(GO_AUTH_LOGIN_URL, "https://opencode.ai/auth");

	const withWs = goAuthNotifyMessage("wrk_01TEST");
	assert.match(withWs, /opencode\.ai\/auth/);
	assert.match(withWs, /opencode\.ai\/workspace\/wrk_01TEST\/go/);
});

test("resolveOpencodeGoQuotaConfig: 文件优先，env 只补空字段", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hud-go-cfg-"));
	fs.writeFileSync(
		path.join(dir, "opencode-go-quota.json"),
		JSON.stringify({ workspaceId: "wrk_from_file", authCookie: "cookie_from_file" }),
	);
	const cfg = resolveOpencodeGoQuotaConfig(dir, {
		OPENCODE_GO_WORKSPACE_ID: "wrk_from_env",
		OPENCODE_GO_AUTH_COOKIE: "cookie_from_env",
	});
	assert.equal(cfg.workspaceId, "wrk_from_file");
	assert.equal(cfg.authCookie, "cookie_from_file");

	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "hud-go-cfg2-"));
	const cfg2 = resolveOpencodeGoQuotaConfig(dir2, {
		OPENCODE_GO_WORKSPACE_ID: "wrk_only_env",
	});
	assert.equal(cfg2.workspaceId, "wrk_only_env");
	assert.equal(cfg2.authCookie, undefined);

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(dir2, { recursive: true, force: true });
});
