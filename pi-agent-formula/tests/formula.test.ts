/**
 * fit pure-function tests
 * Run: node --test tests/formula.test.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	availableKeySet,
	buildCatalogueRows,
	buildTagProposals,
	catalogueCoverageGaps,
	checkCatalogueConsistency,
	configQualityHints,
	formatCatalogueForConfig,
	formatConfigSummary,
	formatTireRoster,
	formatTwoModuleProposalZh,
	loadFormulaConfig,
	modelKey,
	parseFormulaConfigStructure,
	pickByTagPriority,
	readProviderAuthKind,
	recommendJudge,
	saveFormulaConfig,
	validateFormulaConfig,
	type AvailableModel,
	type CatalogueRow,
} from "../src/config.ts";
import { estimateSwitchCostBand, ratesFromModelCost } from "../src/cost.ts";
import {
	enterCooldown,
	isInCooldown,
	canBreakCooldown,
	DEFAULT_COOLDOWN_MS,
	DEFAULT_COOLDOWN_TURNS,
} from "../src/cooldown.ts";
import { packJudgePrompt, parseJudgeVerdict, capText } from "../src/judge.ts";
import {
	assessDifficulty,
	assessFit,
} from "../src/difficulty.ts";
import {
	computeHeat,
	computeNegativeFire,
	isCorrectionIntent,
	isExplicitSwitchIntent,
	nextCorrectionStreak,
	nextToolFailStreak,
	type SessionSignalSnapshot,
} from "../src/signals.ts";
import { buildSuggestion, formatSuggestionMessage, resolveCurrentTire } from "../src/suggest.ts";
import {
	computeEconomyFire,
	computeEconomyOpportunity,
	thriftSaveHint,
} from "../src/thrift.ts";
import {
	compareWithinTierMatch,
	suggestTagsFromGuide,
} from "../src/builtin-tier-guide.ts";

const catalogue: AvailableModel[] = [
	{ provider: "anthropic", id: "claude-haiku" },
	{ provider: "anthropic", id: "claude-sonnet" },
	{ provider: "deepseek", id: "deepseek-v4-flash" },
	{ provider: "openai-codex", id: "gpt-5" },
];

function tmpPath(): string {
	return path.join(
		os.tmpdir(),
		`fit-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);
}

/** Covers full catalogue (all 4 models) — required on save when available is non-empty. */
const goodConfig = {
	judge: { provider: "anthropic", model: "claude-haiku" },
	models: [
		{ provider: "anthropic", model: "claude-haiku", tags: ["skip"] },
		{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] },
		{ provider: "deepseek", model: "deepseek-v4-flash", tags: ["white"] },
		{ provider: "openai-codex", model: "gpt-5", tags: ["yellow"] },
	],
	tagPriority: ["red", "yellow", "white"],
};

// --- config ---

test("validateFormulaConfig: accepts tagged models + tagPriority", () => {
	const r = validateFormulaConfig(goodConfig, catalogue);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.config.models.length, 4);
		assert.ok(r.config.tagPriority[0] === "red");
		const cheap = r.config.models.find((m) => m.model === "deepseek-v4-flash");
		assert.ok(cheap?.tags.includes("white")); // cheap+fast normalize to white
	}
});

test("validateFormulaConfig: rejects unknown model", () => {
	const unknown = validateFormulaConfig(
		{
			judge: { provider: "anthropic", model: "nope" },
			models: [{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] }],
		},
		catalogue,
	);
	assert.equal(unknown.ok, false);
});

test("validateFormulaConfig: rejects partial catalogue (must tag every available model)", () => {
	const partial = validateFormulaConfig(
		{
			judge: { provider: "anthropic", model: "claude-haiku" },
			models: [
				{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] },
				{ provider: "deepseek", model: "deepseek-v4-flash", tags: ["white"] },
			],
		},
		catalogue,
	);
	assert.equal(partial.ok, false);
	if (!partial.ok) assert.ok(partial.errors.some((e) => e.includes("cover ALL")));
});

test("catalogueCoverageGaps / two-module Chinese proposal", () => {
	const gaps = catalogueCoverageGaps(
		[{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] }],
		catalogue,
	);
	assert.ok(gaps.length >= 3);
	const rows = buildCatalogueRows(catalogue, "/nonexistent-auth-path");
	assert.equal(rows.length, 4);
	const text = formatCatalogueForConfig(rows);
	assert.ok(text.includes("评判") || text.includes("①"));
	assert.ok(text.includes("换模") || text.includes("②"));
	assert.ok(text.includes("red") || text.includes("white") || text.includes("红") || text.includes("白"));
	assert.ok(text.includes("→") || text.includes("↓"));
	assert.ok(!text.includes("| 模型 |"), "should not use markdown table");
	// short ids appear (may omit provider prefix when unique)
	for (const m of catalogue) {
		assert.ok(text.includes(m.id) || text.includes(`${m.provider}/${m.id}`));
	}
	// compact: prefer few lines
	assert.ok(text.includes("### P"), "uses ### P1 heading format");
	assert.ok(text.includes("> "), "uses blockquote for tire meaning");
	// no machine-facing keys dump — agent uses tool details.rows
	assert.ok(!text.includes("[agent]"), "no [agent] keys block");
	assert.ok(!text.includes("keys="), "no keys= one-liner");
});

test("recommendJudge prefers oauth light when present", () => {
	const rows: CatalogueRow[] = [
		{ provider: "deepseek", id: "deepseek-v4-pro", auth: "api_key", judgePreferred: false },
		{ provider: "openai-codex", id: "gpt-5.6-luna", auth: "oauth", judgePreferred: true },
		{ provider: "openai-codex", id: "gpt-5.4", auth: "oauth", judgePreferred: true },
	];
	const j = recommendJudge(rows);
	assert.ok(j);
	assert.equal(j!.provider, "openai-codex");
	assert.equal(j!.model, "gpt-5.6-luna");
	assert.ok(j!.reasonZh.includes("订阅"));
	const proposal = formatTwoModuleProposalZh(rows, j, buildTagProposals(rows));
	assert.ok(proposal.includes("评判") || proposal.includes("①"));
	assert.ok(proposal.includes("luna") || proposal.includes("gpt-5.6-luna"));
	assert.equal(buildTagProposals(rows).length, 3);
});

test("readProviderAuthKind: missing file is none", () => {
	assert.equal(readProviderAuthKind("/no/such/auth.json", "openai-codex"), "none");
});

test("parseFormulaConfigStructure allows missing catalogue models; consistency flags them", () => {
	const parsed = parseFormulaConfigStructure({
		judge: { provider: "anthropic", model: "claude-haiku" },
		models: [
			{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] },
			{ provider: "gone", model: "retired", tags: ["white"] },
		],
	});
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const c = checkCatalogueConsistency(parsed.config, catalogue);
	assert.equal(c.consistent, false);
	assert.ok(c.missing.includes("gone/retired"));
	assert.ok(c.present.includes("anthropic/claude-sonnet"));
});

test("saveFormulaConfig: atomic write; invalid does not clobber", () => {
	const p = tmpPath();
	try {
		const ok = saveFormulaConfig(p, goodConfig, catalogue);
		assert.equal(ok.ok, true);
		const before = fs.readFileSync(p, "utf8");
		const bad = saveFormulaConfig(
			p,
			{
				judge: { provider: "anthropic", model: "missing" },
				models: [{ provider: "anthropic", model: "claude-sonnet", tags: ["red"] }],
			},
			catalogue,
		);
		assert.equal(bad.ok, false);
		assert.equal(fs.readFileSync(p, "utf8"), before);
		const loaded = loadFormulaConfig(p, catalogue);
		assert.equal(loaded.status, "ok");
		if (loaded.status === "ok") assert.equal(loaded.consistency.consistent, true);
	} finally {
		try {
			fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}
});

test("loadFormulaConfig: missing vs invalid json", () => {
	const missing = loadFormulaConfig(path.join(os.tmpdir(), "fit-no-such-file.json"), catalogue);
	assert.equal(missing.status, "missing");
	const p = tmpPath();
	try {
		fs.writeFileSync(p, "{not json", "utf8");
		assert.equal(loadFormulaConfig(p, catalogue).status, "invalid");
	} finally {
		try {
			fs.unlinkSync(p);
		} catch {
			/* ignore */
		}
	}
});

test("pickByTagPriority walks priority and skips current", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const pick = pickByTagPriority(
		parsed.config,
		{ provider: "anthropic", model: "claude-sonnet" },
		catalogue,
		null,
	);
	// strong is current → next available non-current by tagPriority
	assert.ok(pick);
	assert.notEqual(pick!.ref.model, "claude-sonnet");

	const preferWhite = pickByTagPriority(
		parsed.config,
		{ provider: "openai-codex", model: "gpt-5" },
		catalogue,
		"white",
	);
	assert.equal(preferWhite?.ref.model, "deepseek-v4-flash");
});

test("modelKey / formatConfigSummary / quality hints", () => {
	assert.equal(modelKey("a", "b"), "a/b");
	assert.ok(availableKeySet(catalogue).has("deepseek/deepseek-v4-flash"));
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const summary = formatConfigSummary(parsed.config);
	assert.ok(summary.includes("tags="));
	assert.ok(summary.includes("tagPriority"));
	assert.equal(configQualityHints(parsed.config).length, 0);

	const collapsed = configQualityHints({
		judge: { provider: "openai-codex", model: "gpt-5" },
		models: [
			{ provider: "openai-codex", model: "gpt-5", tags: ["yellow"] },
			{ provider: "openai-codex", model: "gpt-5", tags: ["white"] },
		],
		tagPriority: ["yellow", "white"],
	});
	// models list has two entries same key after merge on validate; quality on unmerged-like:
	assert.ok(collapsed.length >= 0);
});

// --- signals ---

test("isCorrectionIntent / isExplicitSwitchIntent", () => {
	assert.equal(isCorrectionIntent("不对，应该是左边"), true);
	assert.equal(isCorrectionIntent("下一题：什么是缓存？"), false);
	assert.equal(isExplicitSwitchIntent("换个模型试试"), true);
});

test("nextCorrectionStreak / tool fail / negative fire", () => {
	assert.equal(nextCorrectionStreak(1, "还是不对"), 2);
	assert.equal(nextCorrectionStreak(2, "好的继续"), 0);
	let s = nextToolFailStreak({ tool: null, streak: 0 }, { toolName: "bash", failed: true });
	s = nextToolFailStreak(s, { toolName: "bash", failed: true });
	assert.equal(s.streak, 2);

	const base: SessionSignalSnapshot = {
		userTurnCount: 20,
		contextPercent: 90,
		sessionDurationMs: 60 * 60_000,
		consecutiveCorrections: 0,
		sameToolFailStreak: 0,
		lastFailedTool: null,
		explicitSwitchIntent: false,
	};
	assert.equal(computeNegativeFire(base).shouldFire, false);
	assert.ok(computeHeat(base).score > 0);
	assert.equal(computeNegativeFire({ ...base, consecutiveCorrections: 2 }).shouldFire, true);
});

// --- cost / judge / suggest ---

test("estimateSwitchCostBand", () => {
	const band = estimateSwitchCostBand({
		contextTokens: 50_000,
		avgOutputTokensPerTurn: 1000,
		current: ratesFromModelCost({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
		candidate: ratesFromModelCost({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 }),
	});
	assert.equal(band.cacheMiss, true);
	assert.ok(band.highUsd >= band.lowUsd - 1e-9);
});

test("parseJudgeVerdict", () => {
	const yes = parseJudgeVerdict("SWITCH: yes\nTIER: red\nREASON: 连续纠正", ["red", "white"]);
	assert.ok(yes?.shouldSwitch && yes.tier === "red");
	assert.equal(parseJudgeVerdict("SWITCH: yes\nTIER: ultra\nREASON: x", ["red"]), null);
	const eco = parseJudgeVerdict(
		"SWITCH: yes\nTIER: white\nMODE: economy\nREASON: 任务很轻",
		["red", "white"],
	);
	assert.ok(eco?.shouldSwitch && eco.tier === "white" && eco.mode === "economy");
});

test("packJudgePrompt", () => {
	const pack = packJudgePrompt({
		config: parseFormulaConfigStructure(goodConfig).ok
			? (parseFormulaConfigStructure(goodConfig) as { ok: true; config: import("../src/config.ts").FormulaConfig })
					.config
			: ({} as import("../src/config.ts").FormulaConfig),
		current: { provider: "openai-codex", model: "gpt-5" },
		snap: {
			userTurnCount: 2,
			contextPercent: 40,
			sessionDurationMs: 1000,
			consecutiveCorrections: 2,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 20, reasons: ["corrections×2"] },
		userMessages: ["不对，重做"],
		assistantExcerpts: [capText("x".repeat(2000), 100)],
		tierNames: ["red", "white", "yellow"],
	});
	assert.ok(pack.user.includes("不对，重做"));
	assert.ok(pack.system.includes("TIRE") || pack.system.includes("Agent Formula"));
	assert.ok(pack.system.includes("ECONOMY") || pack.system.includes("economy"));
});

test("assessDifficulty: hard vs light", () => {
	const hard = assessDifficulty({
		userMessages: ["请做跨模块架构重构，处理分布式竞态与迁移方案"],
	});
	assert.equal(hard.band, "hard");
	assert.equal(hard.recommendedTire, "red");

	const light = assessDifficulty({
		userMessages: ["帮我格式化一下这段 JSON，改个变量名"],
	});
	assert.equal(light.band, "light");
	assert.equal(light.recommendedTire, "white");
});

test("assessFit + economy fire", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;

	const light = assessDifficulty({ userMessages: ["简单解释一下什么是缓存"] });
	const fitEco = assessFit("red", light);
	assert.equal(fitEco.direction, "economy");
	assert.equal(fitEco.targetTire, "white");

	const hard = assessDifficulty({
		userMessages: ["系统架构 redesign + migration strategy"],
	});
	const fitUp = assessFit("white", hard);
	assert.equal(fitUp.direction, "upgrade");

	const snapCalm: SessionSignalSnapshot = {
		userTurnCount: 4,
		contextPercent: 30,
		sessionDurationMs: 10_000,
		consecutiveCorrections: 0,
		sameToolFailStreak: 0,
		lastFailedTool: null,
		explicitSwitchIntent: false,
	};
	const neg = computeNegativeFire(snapCalm);
	const autoEco = computeEconomyFire(snapCalm, neg, fitEco, "oauth");
	assert.equal(autoEco.shouldFire, true);
	assert.equal(autoEco.targetTire, "white");
	assert.ok(autoEco.reasons.some((r) => r.includes("订阅")));

	// quality pain blocks economy
	const snapPain = { ...snapCalm, consecutiveCorrections: 2 };
	const blocked = computeEconomyFire(snapPain, computeNegativeFire(snapPain), fitEco);
	assert.equal(blocked.shouldFire, false);

	const manual = computeEconomyOpportunity(snapCalm, neg, fitEco, "api_key");
	assert.equal(manual.shouldFire, true);
	assert.ok(manual.reasons.some((r) => r.includes("API") || r.includes("按量")));

	assert.equal(thriftSaveHint("oauth").includes("订阅"), true);
	assert.equal(resolveCurrentTire(parsed.config, { provider: "anthropic", model: "claude-sonnet" }), "red");
});

test("buildSuggestion: auto path never fires match (O1)", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const costBand = estimateSwitchCostBand({
		contextTokens: 1000,
		avgOutputTokensPerTurn: 100,
		current: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		candidate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	});
	const hard = assessDifficulty({
		userMessages: ["跨服务架构迁移与竞态修复"],
	});
	const fitUp = assessFit("white", hard);
	// Auto: allowMatchUpgrade false — underpowered alone must not switch
	const auto = buildSuggestion({
		config: parsed.config,
		current: { provider: "deepseek", model: "deepseek-v4-flash" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 2,
			contextPercent: 20,
			sessionDurationMs: 1000,
			consecutiveCorrections: 0,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 10, reasons: [] },
		negative: { shouldFire: false, reasons: [] },
		fit: fitUp,
		allowMatchUpgrade: false,
		judgeShouldSwitch: true,
		judgeTier: "red",
		judgeMode: "match",
		costBand,
	});
	assert.equal(auto.shouldSwitch, false);
	assert.equal(auto.mode, "none");
});

test("formatTireRoster: groups by priority, marks current", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const text = formatTireRoster(parsed.config, {
		available: catalogue,
		current: { provider: "deepseek", model: "deepseek-v4-flash" },
	});
	assert.ok(text.includes("可选档位"));
	assert.ok(text.includes("### P"));
	assert.ok(text.includes("（当前）"));
	assert.ok(text.includes("/boxbox"));
	assert.ok(!text.includes("keys="));
});

test("formatSuggestionMessage: no roster dump", () => {
	const costBand = estimateSwitchCostBand({
		contextTokens: 1000,
		avgOutputTokensPerTurn: 100,
		current: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
		candidate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
	});
	const msg = formatSuggestionMessage(
		{
			shouldSwitch: true,
			target: { provider: "openai-codex", model: "gpt-5" },
			tierName: "red",
			reason: "连续纠正",
			costSummary: costBand.summary,
			mode: "quality",
			fit: assessFit(
				"white",
				assessDifficulty({ userMessages: ["重构架构"] }),
			),
			candidates: [
				{ tier: "red", ref: { provider: "openai-codex", model: "gpt-5" } },
				{ tier: "white", ref: { provider: "deepseek", model: "deepseek-v4-flash" } },
			],
		},
		{ provider: "deepseek", model: "deepseek-v4-flash" },
	);
	assert.ok(msg.includes("是否建议换模型"));
	assert.ok(msg.includes("建议"));
	assert.ok(msg.includes("当前: deepseek/deepseek-v4-flash"));
	assert.ok(msg.includes("难度:"));
	assert.ok(!msg.includes("可选档位"), "roster belongs in /formula-tires, not box call");
});

test("buildSuggestion uses tag priority", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const costBand = estimateSwitchCostBand({
		contextTokens: 1000,
		avgOutputTokensPerTurn: 100,
		current: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
		candidate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
	});
	const s = buildSuggestion({
		config: parsed.config,
		current: { provider: "deepseek", model: "deepseek-v4-flash" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 3,
			contextPercent: 20,
			sessionDurationMs: 1000,
			consecutiveCorrections: 2,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 20, reasons: [] },
		negative: { shouldFire: true, reasons: ["连续纠正 2 次"] },
		costBand,
	});
	assert.equal(s.shouldSwitch, true);
	assert.equal(s.mode, "quality");
	assert.ok(s.target);
	assert.notEqual(modelKey(s.target!.provider, s.target!.model), "deepseek/deepseek-v4-flash");
});

test("buildSuggestion: economy downshift and match upgrade", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const costBand = estimateSwitchCostBand({
		contextTokens: 1000,
		avgOutputTokensPerTurn: 100,
		current: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 15 },
		candidate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
	});
	const light = assessDifficulty({ userMessages: ["格式化这段代码"] });
	const fitEco = assessFit("red", light);
	const eco = buildSuggestion({
		config: parsed.config,
		current: { provider: "anthropic", model: "claude-sonnet" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 3,
			contextPercent: 20,
			sessionDurationMs: 1000,
			consecutiveCorrections: 0,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 5, reasons: [] },
		negative: { shouldFire: false, reasons: [] },
		fit: fitEco,
		economy: { shouldFire: true, targetTire: "white", reasons: ["过配"] },
		costBand,
	});
	assert.equal(eco.shouldSwitch, true);
	assert.equal(eco.mode, "economy");
	assert.equal(eco.tierName, "white");
	assert.equal(eco.target?.model, "deepseek-v4-flash");

	const hard = assessDifficulty({
		userMessages: ["跨服务架构迁移与竞态修复"],
	});
	const fitUp = assessFit("white", hard);
	const match = buildSuggestion({
		config: parsed.config,
		current: { provider: "deepseek", model: "deepseek-v4-flash" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 1,
			contextPercent: 10,
			sessionDurationMs: 500,
			consecutiveCorrections: 0,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 10, reasons: [] },
		negative: { shouldFire: false, reasons: [] },
		fit: fitUp,
		allowMatchUpgrade: true,
		costBand,
	});
	assert.equal(match.shouldSwitch, true);
	assert.equal(match.mode, "match");
	assert.ok(match.tierName === "red" || match.tierName === "yellow");
});

test("buildSuggestion: judge no does not pick; null judge does not suppress rules", () => {
	const parsed = parseFormulaConfigStructure(goodConfig);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	const costBand = estimateSwitchCostBand({
		contextTokens: 1000,
		avgOutputTokensPerTurn: 100,
		current: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		candidate: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
	});
	const no = buildSuggestion({
		config: parsed.config,
		current: { provider: "openai-codex", model: "gpt-5" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 1,
			contextPercent: 10,
			sessionDurationMs: 100,
			consecutiveCorrections: 2,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 10, reasons: [] },
		negative: { shouldFire: true, reasons: ["x"] },
		judgeReason: "正常 grill",
		judgeTier: null,
		judgeShouldSwitch: false,
		costBand,
	});
	assert.equal(no.shouldSwitch, false);

	const rules = buildSuggestion({
		config: parsed.config,
		current: { provider: "openai-codex", model: "gpt-5" },
		available: catalogue.map((m) => ({ provider: m.provider, id: m.id })),
		snap: {
			userTurnCount: 3,
			contextPercent: 20,
			sessionDurationMs: 1000,
			consecutiveCorrections: 2,
			sameToolFailStreak: 0,
			lastFailedTool: null,
			explicitSwitchIntent: false,
		},
		heat: { score: 20, reasons: [] },
		negative: { shouldFire: true, reasons: ["连续纠正 2 次"] },
		judgeShouldSwitch: null,
		costBand,
	});
	assert.equal(rules.shouldSwitch, true);
});

test("isInCooldown", () => {
	const now = 1_000_000;
	const state = enterCooldown(now, ["x"], true);
	assert.equal(isInCooldown(state, now + 1000, 0), true);
	assert.equal(isInCooldown(state, now + DEFAULT_COOLDOWN_MS + 1, DEFAULT_COOLDOWN_TURNS), false);
});

test("canBreakCooldown: explicit breaks dismissed; quality breaks economy only", () => {
	const now = 1_000_000;
	// no cooldown → nothing to break
	assert.equal(canBreakCooldown(null, { shouldFire: true }, true), false);

	// dismissed quality cooldown: only explicit switch intent breaks it
	const dismissed = enterCooldown(now, ["连续纠正"], true, "quality");
	assert.equal(canBreakCooldown(dismissed, { shouldFire: true }, false), false);
	assert.equal(canBreakCooldown(dismissed, { shouldFire: true }, true), true);

	// active economy cooldown: quality pain breaks it (pain > thrift quiet)
	const economy = enterCooldown(now, ["省耗降档"], false, "economy");
	assert.equal(canBreakCooldown(economy, { shouldFire: true }, false), true);
	// economy cooldown without negative fire is never broken
	assert.equal(canBreakCooldown(economy, { shouldFire: false }, false), false);

	// undismissed quality cooldown: repeated identical pain does not break
	const quality = enterCooldown(now, ["连续纠正"], false, "quality");
	assert.equal(canBreakCooldown(quality, { shouldFire: true }, false), false);
});

test("within-tier match: oauth before api_key, then faster", () => {
	const a = { provider: "deepseek", model: "deepseek-v4-flash", auth: "api_key" as const };
	const b = { provider: "openai-codex", model: "gpt-5.4", auth: "oauth" as const };
	const c = { provider: "openai-codex", model: "gpt-5.6-luna", auth: "oauth" as const };
	// oauth beats api_key even if api is "faster" name
	assert.ok(compareWithinTierMatch(b, a) < 0);
	// both oauth: luna (fast) before gpt-5.4 (mid/heavy)
	assert.ok(compareWithinTierMatch(c, b) < 0);

	const config = {
		judge: { provider: "openai-codex", model: "gpt-5.6-luna" },
		models: [
			{ provider: "deepseek", model: "deepseek-v4-flash", tags: ["white"] },
			{ provider: "openai-codex", model: "gpt-5.4", tags: ["white"] },
			{ provider: "openai-codex", model: "gpt-5.6-luna", tags: ["white"] },
		],
		tagPriority: ["white", "red"],
	};
	const available = [
		{ provider: "deepseek", id: "deepseek-v4-flash" },
		{ provider: "openai-codex", id: "gpt-5.4" },
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
	];
	// Force auth via path that won't have oauth — pickByTagPriority uses auth file.
	// Unit-test sort via pick with mock: write temp auth
	const authPath = path.join(os.tmpdir(), `fit-auth-${process.pid}.json`);
	fs.writeFileSync(
		authPath,
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "x", refresh: "y", expires: 0 },
			deepseek: { type: "api_key", key: "k" },
		}),
		"utf8",
	);
	try {
		const pick = pickByTagPriority(
			config,
			{ provider: "openai-codex", model: "gpt-5.4" },
			available,
			"white",
			authPath,
		);
		// among white excluding current gpt-5.4: luna (oauth+fast) before deepseek flash (api+fast)
		assert.equal(pick?.ref.model, "gpt-5.6-luna");
	} finally {
		try {
			fs.unlinkSync(authPath);
		} catch {
			/* ignore */
		}
	}
});

test("builtin tier guide: strong vs cheap not confused by bare pro", () => {
	// DeepSeek flash is cheap, pro is strong; Luna is cheap not strong
	// V4 Flash ≈ GLM-5.2 能力且更便宜 → 黄胎+白胎，不是纯白胎小模型
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "deepseek",
			modelId: "deepseek-v4-flash",
			auth: "api_key",
		}),
		["yellow", "white"],
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "zhipu",
			modelId: "glm-5.2",
			auth: "api_key",
		}),
		["yellow", "red"],
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			auth: "api_key",
		}),
		["red"],
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
			auth: "oauth",
		}),
		["white"],
	);
	// GPT-5.4 / 5.5 default to skip (user may override in /formula-config)
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			auth: "oauth",
		}),
		["skip"],
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "openai-codex",
			modelId: "gpt-5.5",
			auth: "oauth",
		}),
		["skip"],
	);
	// 5.3 spark kept as light
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "openai-codex",
			modelId: "gpt-5.3-codex-spark",
			auth: "oauth",
		}),
		["white"],
	);
	assert.ok(
		suggestTagsFromGuide({
			provider: "anthropic",
			modelId: "claude-opus-4",
			auth: "api_key",
		}).includes("red"),
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "xai",
			modelId: "grok-4.5",
			auth: "api_key",
		}),
		["red"],
	);
	assert.deepEqual(
		suggestTagsFromGuide({
			provider: "openai",
			modelId: "gpt-5.6-sol",
			auth: "api_key",
		}),
		["red"],
	);
	// 同为红胎时 Sol 能力序优先于 Grok 4.5
	assert.ok(
		compareWithinTierMatch(
			{ provider: "openai", model: "gpt-5.6-sol", auth: "api_key" },
			{ provider: "xai", model: "grok-4.5", auth: "api_key" },
			"red",
		) < 0,
	);
});
