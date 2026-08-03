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
	bar,
	cacheHitRate,
	emptyAgg,
	exactCnyCost,
	fmtCost,
	fmtDuration,
	fmtMoney,
	fmtSessionCost,
	fmtTokens,
	fmtWindowLabel,
	parseCodexUsage,
	parseDeepseekBalance,
	parseMoonshotBalance,
	parseStepfunBalance,
	readAuthInfo,
	recordSubagentResults,
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
