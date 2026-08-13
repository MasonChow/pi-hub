/**
 * Agent Formula — F1-themed model roster + box-call switch advisor for Pi
 *
 * Commands:
 *   /formula-config  — conversational create/update of ~/.pi/agent/formula-pit.json
 *   /formula-tires   — view configured tire roster (what box can pick)
 *   /boxbox          — Box box! assess switch (difficulty + thrift + cost + confirm → setModel)
 *
 * Manual only: /boxbox assesses on demand; nothing auto-triggers during a session.
 *
 * Install: pi install npm:@masonchow/pi-agent-formula
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Value import OK: tests never import this entry module (pure modules only).
import { Type } from "@earendil-works/pi-ai";

import {
	allConfigTags,
	buildCatalogueRows,
	defaultAuthPath,
	defaultConfigPath,
	formatCatalogueForConfig,
	formatConfigSummary,
	formatTireRoster,
	loadFormulaConfig,
	modelKey,
	pickByTagPriority,
	readProviderAuthKind,
	saveFormulaConfig,
	type AvailableModel,
	type FormulaConfig,
	type ModelRef,
} from "./config.ts";
import { estimateSwitchCostBand, ratesFromModelCost, type CostBand } from "./cost.ts";
import {
	assessDifficulty,
	assessFit,
	type FitAssessment,
} from "./difficulty.ts";
import {
	capText,
	DEFAULT_ASSISTANT_EXCERPT_CHARS,
	JUDGE_TIMEOUT_MS,
	packJudgePrompt,
	parseJudgeVerdict,
	type JudgeVerdict,
} from "./judge.ts";
import {
	computeHeat,
	computeNegativeFire,
	isExplicitSwitchIntent,
	nextCorrectionStreak,
	nextToolFailStreak,
	type SessionSignalSnapshot,
} from "./signals.ts";
import {
	buildSuggestion,
	formatSuggestionMessage,
	resolveCurrentTire,
	type Suggestion,
} from "./suggest.ts";
import {
	computeEconomyOpportunity,
	type EconomyFire,
} from "./thrift.ts";
import {
	canBreakCooldown,
	enterCooldown,
	isInCooldown,
	type CooldownKind,
	type CooldownState,
} from "./cooldown.ts";

// Pure modules stay free of extension runtime deps so node --test can import them.
// Cooldown helpers: ./cooldown.ts

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listAvailable(ctx: ExtensionContext): AvailableModel[] {
	const models = ctx.modelRegistry.getAvailable();
	return models.map((m) => ({ provider: m.provider, id: m.id }));
}

function currentRef(ctx: ExtensionContext): ModelRef | null {
	if (!ctx.model) return null;
	return { provider: ctx.model.provider, model: ctx.model.id };
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n");
}

type SessionMsg = {
	role?: string;
	content?: unknown;
	usage?: unknown;
};

/** Session entries are wrapped: { type: "message", message: AgentMessage }. */
function collectMessages(ctx: ExtensionContext): {
	userMessages: string[];
	assistantExcerpts: string[];
	avgOutputTokens: number;
} {
	const branch = ctx.sessionManager.getBranch() as Array<{
		type?: string;
		message?: SessionMsg;
	}>;
	const userMessages: string[] = [];
	const assistantExcerpts: string[] = [];
	let outSum = 0;
	let outN = 0;

	for (const entry of branch) {
		const m = entry?.type === "message" ? entry.message : undefined;
		if (!m) continue;
		if (m.role === "user") {
			const t = extractText(m.content).trim();
			// Skip our own injected /formula-config prompts
			if (t.startsWith("[Agent Formula")) continue;
			if (t) userMessages.push(t);
		} else if (m.role === "assistant") {
			const t = extractText(m.content).trim();
			if (t) assistantExcerpts.push(capText(t, DEFAULT_ASSISTANT_EXCERPT_CHARS));
			const usage = m.usage;
			if (typeof usage === "object" && usage !== null) {
				const o = (usage as { output?: unknown }).output;
				if (typeof o === "number" && Number.isFinite(o)) {
					outSum += o;
					outN += 1;
				}
			}
		}
	}

	return {
		userMessages,
		assistantExcerpts: assistantExcerpts.slice(-6),
		avgOutputTokens: outN > 0 ? outSum / outN : 800,
	};
}

function costBandFor(ctx: ExtensionContext, target: ModelRef | null): CostBand {
	const usage = ctx.getContextUsage();
	const contextTokens = usage?.tokens ?? 0;
	const { avgOutputTokens } = collectMessages(ctx);
	const cur = ctx.model;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const currentRates = cur?.cost ? ratesFromModelCost(cur.cost) : zero;
	let candidateRates = currentRates;
	if (target) {
		const m = ctx.modelRegistry.find(target.provider, target.model);
		if (m?.cost) candidateRates = ratesFromModelCost(m.cost);
	}
	return estimateSwitchCostBand({
		contextTokens: contextTokens || 4000,
		avgOutputTokensPerTurn: avgOutputTokens,
		current: currentRates,
		candidate: candidateRates,
		currentEffectiveInputRate: currentRates.cacheRead || currentRates.input,
	});
}

function buildSnapshot(
	ctx: ExtensionContext,
	tracking: {
		sessionStart: number;
		correctionStreak: number;
		toolFail: { tool: string | null; streak: number };
		explicitSwitch: boolean;
	},
): SessionSignalSnapshot {
	const { userMessages } = collectMessages(ctx);
	const usage = ctx.getContextUsage();
	return {
		userTurnCount: userMessages.length,
		contextPercent: usage?.percent ?? null,
		sessionDurationMs: Date.now() - tracking.sessionStart,
		consecutiveCorrections: tracking.correctionStreak,
		sameToolFailStreak: tracking.toolFail.streak,
		lastFailedTool: tracking.toolFail.tool,
		explicitSwitchIntent: tracking.explicitSwitch,
	};
}

function buildSessionFit(
	ctx: ExtensionContext,
	config: FormulaConfig,
	snap: SessionSignalSnapshot,
): FitAssessment {
	const { userMessages } = collectMessages(ctx);
	const difficulty = assessDifficulty({
		userMessages,
		consecutiveCorrections: snap.consecutiveCorrections,
		sameToolFailStreak: snap.sameToolFailStreak,
	});
	return assessFit(resolveCurrentTire(config, currentRef(ctx)), difficulty);
}

async function runJudge(
	ctx: ExtensionContext,
	config: FormulaConfig,
	snap: SessionSignalSnapshot,
	fit: FitAssessment,
): Promise<JudgeVerdict | null> {
	const model = ctx.modelRegistry.find(config.judge.provider, config.judge.model);
	if (!model) return null;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;

	const heat = computeHeat(snap);
	const { userMessages, assistantExcerpts } = collectMessages(ctx);
	const pack = packJudgePrompt({
		config,
		current: currentRef(ctx),
		snap,
		heat,
		userMessages,
		assistantExcerpts,
		tierNames: allConfigTags(config),
		fit,
	});

	try {
		const { completeSimple } = await import("@earendil-works/pi-ai");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
		try {
			const result = await completeSimple(
				model,
				{
					systemPrompt: pack.system,
					messages: [{ role: "user", content: pack.user, timestamp: Date.now() }],
				},
				{
					apiKey: auth.apiKey,
					maxTokens: 512,
					signal: controller.signal,
					headers: auth.headers,
				},
			);
			const text = extractText(result.content);
			if (!text) return null;
			// null = unusable response → caller falls back to rules (not an explicit no)
			return parseJudgeVerdict(text, allConfigTags(config));
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

function makeSuggestion(
	ctx: ExtensionContext,
	config: FormulaConfig,
	snap: SessionSignalSnapshot,
	judge: JudgeVerdict | null,
	fit: FitAssessment,
	auto = false,
): Suggestion {
	const heat = computeHeat(snap);
	const negative = computeNegativeFire(snap);
	const available = listAvailable(ctx);
	const cur = currentRef(ctx);
	const auth = cur
		? readProviderAuthKind(defaultAuthPath(), cur.provider)
		: "none";
	// Auto path never surfaces economy (thrift is manual /boxbox only — see #6
	// UX lesson). Negative set A is the sole auto trigger.
	const economy: EconomyFire = auto
		? { shouldFire: false, targetTire: null, reasons: [] }
		: computeEconomyOpportunity(snap, negative, fit, auth);

	// Provisional target for cost band: preferred tire from fit/economy/judge
	const preferred =
		judge?.tier ??
		(negative.shouldFire
			? fit.direction === "upgrade"
				? fit.targetTire
				: "red"
			: economy.shouldFire
				? economy.targetTire
				: fit.direction === "upgrade"
					? fit.targetTire
					: null);
	const pick = pickByTagPriority(
		config,
		currentRef(ctx),
		available,
		preferred,
	);
	const provisional = pick?.ref ?? config.models[0] ?? null;
	const band = costBandFor(
		ctx,
		provisional
			? { provider: provisional.provider, model: provisional.model }
			: null,
	);
	return buildSuggestion({
		config,
		current: currentRef(ctx),
		available: available.map((m) => ({ provider: m.provider, id: m.id })),
		snap,
		heat,
		negative,
		fit,
		economy,
		allowMatchUpgrade: !auto,
		judgeReason: judge?.reason ?? null,
		judgeTier: judge?.tier ?? null,
		judgeShouldSwitch: judge ? judge.shouldSwitch : null,
		judgeMode: judge?.mode ?? null,
		costBand: band,
	});
}

function cooldownKindFromSuggestion(s: Suggestion): CooldownKind {
	if (s.mode === "economy" || s.mode === "quality" || s.mode === "match") return s.mode;
	return "generic";
}

async function presentSuggestion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	suggestion: Suggestion,
	onDone: (dismissed: boolean) => void,
): Promise<void> {
	const msg = formatSuggestionMessage(suggestion, currentRef(ctx));
	ctx.ui.notify(msg.split("\n")[0] ?? "Agent Formula", "info");

	if (!suggestion.shouldSwitch || !suggestion.target) {
		ctx.ui.notify(msg, "info");
		onDone(true);
		return;
	}

	const target = suggestion.target;
	const tire =
		suggestion.tierName === "red"
			? "红胎·强但耗快"
			: suggestion.tierName === "yellow"
				? "黄胎·均衡"
				: suggestion.tierName === "white"
					? "白胎·省而耐"
					: suggestion.tierName ?? "?";
	const modeHint =
		suggestion.mode === "economy"
			? "省耗降档"
			: suggestion.mode === "match"
				? "难度升档"
				: suggestion.mode === "quality"
					? "质量升档"
					: "换胎";
	const label = `${modeHint} ${tire} → ${modelKey(target.provider, target.model)}`;
	const ok = await ctx.ui.confirm(
		"Box box!",
		`${msg}\n\nBox box! 确认进站（${modeHint}）到 ${label}？\n（切换会丢失 prompt cache 连续性）`,
	);
	if (!ok) {
		ctx.ui.notify("已忽略本次 box 建议", "info");
		onDone(true);
		return;
	}

	const model = ctx.modelRegistry.find(target.provider, target.model);
	if (!model) {
		ctx.ui.notify(`模型不可用: ${modelKey(target.provider, target.model)}`, "error");
		onDone(true);
		return;
	}
	const success = await pi.setModel(model);
	if (!success) {
		ctx.ui.notify(`无法切换（可能缺少 API key）: ${modelKey(target.provider, target.model)}`, "error");
		onDone(true);
		return;
	}
	ctx.ui.notify(`已切换到 ${modelKey(target.provider, target.model)}`, "info");
	onDone(false);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const configPath = defaultConfigPath();

	let sessionStart = Date.now();
	let correctionStreak = 0;
	let toolFail = { tool: null as string | null, streak: 0 };
	let explicitSwitch = false;
	let cooldown: CooldownState | null = null;
	let turnsSinceSuggest = 999;
	let nudgedMissingConfig = false;
	let autoRunning = false;

	function tracking() {
		return { sessionStart, correctionStreak, toolFail, explicitSwitch };
	}

	/**
	 * Record a presented suggestion: enter cooldown, reset the turn counter,
	 * and consume the one-shot explicit switch intent.
	 */
	function recordSuggestion(
		suggestion: Suggestion,
		snap: SessionSignalSnapshot,
		dismissed: boolean,
	): void {
		const reasons =
			suggestion.mode === "economy"
				? suggestion.fit?.reasons ?? ["economy"]
				: computeNegativeFire(snap).reasons;
		cooldown = enterCooldown(
			Date.now(),
			reasons.length ? reasons : [suggestion.mode],
			dismissed,
			cooldownKindFromSuggestion(suggestion),
		);
		turnsSinceSuggest = 0;
		explicitSwitch = false;
	}

	// --- tools for conversational config ---
	pi.registerTool({
		name: "formula_list_models",
		label: "Formula list models",
		description:
			"Build the Chinese two-module config proposal: (1) one judge recommendation + reason, (2) COMPLETE model list with suggested tags. Show the tool output to the user almost as-is for one-shot confirmation. Prefer oauth for judge.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const available = listAvailable(ctx);
			const rows = buildCatalogueRows(available, defaultAuthPath());
			const body = formatCatalogueForConfig(rows);
			return {
				content: [{ type: "text", text: body }],
				details: {
					count: rows.length,
					oauthCount: rows.filter((r) => r.auth === "oauth").length,
					rows,
				},
			};
		},
	});

	pi.registerTool({
		name: "formula_get_config",
		label: "Agent Formula get config",
		description:
			"Read current Agent Formula config. Shows judge, tagged models, tagPriority, consistency vs live catalogue, and soft quality hints.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const available = listAvailable(ctx);
			const loaded = loadFormulaConfig(configPath, available);
			if (loaded.status === "missing") {
				return {
					content: [
						{
							type: "text",
							text: [
								`尚未配置（${configPath}）`,
								"",
								"请先 formula_list_models，把「模块一评判 + 模块二轮胎全表」整页给用户确认，再 formula_save_config。",
							].join("\n"),
						},
					],
					details: { status: "missing", path: configPath },
				};
			}
			if (loaded.status === "invalid") {
				return {
					content: [
						{
							type: "text",
							text: `Invalid config at ${configPath}:\n${loaded.errors.join("\n")}`,
						},
					],
					details: { status: "invalid", path: configPath, errors: loaded.errors },
				};
			}
			const c = loaded.consistency;
			const consistencyLine = c.consistent
				? "一致性：OK（配置中的模型都在当前 Pi 可用目录中）"
				: `一致性：过期 — 缺失 ${c.missing.join(", ")}，请 /formula-config 更新`;
			return {
				content: [
					{
						type: "text",
						text: `Config path: ${configPath}\n${consistencyLine}\n${formatConfigSummary(loaded.config, { available, authPath: defaultAuthPath() })}`,
					},
				],
				details: {
					status: "ok",
					path: configPath,
					config: loaded.config,
					consistency: c,
				},
			};
		},
	});

	pi.registerTool({
		name: "formula_save_config",
		label: "Agent Formula save config",
		description:
			"Validate and save Agent Formula config. models_json MUST include EVERY model from formula_list_models (full catalogue confirmation). Use tags:[\"skip\"] to confirm-and-exclude from switching. Prefer judge from oauth/subscription providers. tag_priority_json optional.",
		parameters: Type.Object({
			judge_provider: Type.String({
				description:
					"Provider of JUDGE. Prefer oauth/subscription providers (e.g. openai-codex) over api_key metered ones.",
			}),
			judge_model: Type.String({
				description:
					"Judge model id — prefer a light model on a subscription (oauth) plan, not a metered api_key model, when both exist.",
			}),
			models_json: Type.String({
				description:
					'JSON array covering ALL formula_list_models rows: [{provider, model, tags: string[]}]. Multi-tag OK. tags:["skip"] = confirmed but not a switch target. At least one model must have tire tags (red/yellow/white/…).',
			}),
			tag_priority_json: Type.String({
				description:
					'Optional. JSON array of tag match order, e.g. ["red","yellow","white"]. Pass empty string "" to use defaults.',
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let models: unknown;
			try {
				models = JSON.parse(params.models_json);
			} catch {
				return {
					content: [{ type: "text", text: "models_json is not valid JSON" }],
					details: { ok: false },
				};
			}
			let tagPriority: unknown;
			const priRaw = typeof params.tag_priority_json === "string" ? params.tag_priority_json.trim() : "";
			if (priRaw) {
				try {
					tagPriority = JSON.parse(priRaw);
				} catch {
					return {
						content: [{ type: "text", text: "tag_priority_json is not valid JSON" }],
						details: { ok: false },
					};
				}
			}
			const raw: Record<string, unknown> = {
				judge: { provider: params.judge_provider, model: params.judge_model },
				models,
			};
			if (tagPriority !== undefined) raw.tagPriority = tagPriority;

			const available = listAvailable(ctx);
			const result = saveFormulaConfig(configPath, raw, available);
			if (!result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Save rejected:\n${result.errors.join("\n")}\n\nHint: re-call formula_list_models and include every provider/model row in models_json (use tags:["skip"] if user does not want that model as a switch target). Prefer oauth judge.`,
						},
					],
					details: { ok: false, errors: result.errors },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: [
							`Saved to ${configPath}`,
							formatConfigSummary(result.config, {
								available,
								authPath: defaultAuthPath(),
							}),
							"",
							"请用中文向用户总结：①评判模型是谁、为何；②各标签分别代表什么；③之后 /boxbox 会按轮胎策略建议进站换模。",
						].join("\n"),
					},
				],
				details: { ok: true, path: configPath, config: result.config },
			};
		},
	});

	// --- commands ---
	pi.registerCommand("formula-config", {
		description:
			"Create/update Agent Formula: judge + tagged work models + tag priority",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent busy — try /formula-config when idle", "warning");
				return;
			}
			const available = listAvailable(ctx);
			const loaded = loadFormulaConfig(configPath, available);
			const mode =
				loaded.status === "ok"
					? "UPDATE existing config"
					: "CREATE new config (none or invalid)";
			const existing =
				loaded.status === "ok"
					? `${loaded.consistency.consistent ? "consistency OK" : `STALE missing: ${loaded.consistency.missing.join(", ")}`}\n${formatConfigSummary(loaded.config, { available, authPath: defaultAuthPath() })}`
					: loaded.status === "invalid"
						? `invalid: ${loaded.errors.join("; ")}`
						: "missing";

			const prompt = [
				"[Agent Formula /formula-config]",
				`模式: ${mode}。配置路径: ${configPath}`,
				`当前文件:\n${existing}`,
				"",
				"你是配置向导。禁止让用户手写 JSON。必须用中文，且把「两个确认模块」放在同一条回复里一起展示，方便用户理解配置含义。",
				"",
				"## 用户需要理解的含义（务必先用白话说明）",
				"· 模块一 评判模型(judge)：只在「要不要换模」时异步跑；优先订阅轻量档。",
				"· 模块二 模型标签 + 匹配优先级：全表打标；并展示 tagPriority 阶梯（P1 最先匹配…）。",
				"  用户必须能看懂：/boxbox 不是随机换模，而是按优先级队列找带标签的可用模型。",
				"",
				"## 强制流程",
				"1. formula_list_models（中文分层稿：模块一卡片 + 换模阶梯 + 按档位分组的完整模型清单，无表格）。",
				"2. 可选 formula_get_config。",
				"3. 几乎原样展示；禁止改成表格；禁止删减模型；禁止省略阶梯。",
				"4. 用户一次性确认 judge、各档模型、优先级顺序。",
				"5. formula_save_config 落盘。",
				"6. 中文复述：judge；换模时 1→2→3 档怎么走。",
				"",
				"禁止：表格墙、只推荐几个模型、不解释优先级。",
			].join("\n");

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("formula-tires", {
		description: "Show configured tire roster (red/yellow/white) for Agent Formula",
		handler: async (_args, ctx) => {
			const available = listAvailable(ctx);
			const loaded = loadFormulaConfig(configPath, available);
			if (loaded.status !== "ok") {
				ctx.ui.notify(
					loaded.status === "missing"
						? "尚未配置 Agent Formula，请运行 /formula-config"
						: `配置无效: ${loaded.errors.join("; ")}。请运行 /formula-config`,
					"warning",
				);
				return;
			}
			const body = formatTireRoster(loaded.config, {
				available,
				authPath: defaultAuthPath(),
				current: currentRef(ctx),
			});
			// Full text via notify can truncate; also send as user-visible message when idle.
			ctx.ui.notify("【Agent Formula】可选档位（见下方）", "info");
			if (ctx.isIdle()) {
				pi.sendUserMessage(`[Agent Formula /formula-tires]\n\n${body}`);
			} else {
				// Busy: best-effort dump into notify (may be short)
				ctx.ui.notify(body, "info");
			}
		},
	});

	pi.registerCommand("boxbox", {
		description:
			"Assess task difficulty + thrift: upgrade if underpowered, downshift to save cost; confirm to apply",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent busy — try /boxbox when idle", "warning");
				return;
			}
			const available = listAvailable(ctx);
			const loaded = loadFormulaConfig(configPath, available);
			if (loaded.status !== "ok") {
				ctx.ui.notify(
					loaded.status === "missing"
						? "尚未配置 Agent Formula，请运行 /formula-config"
						: `配置无效: ${loaded.errors.join("; ")}。请运行 /formula-config`,
					"warning",
				);
				if (ctx.isIdle()) {
					pi.sendUserMessage(
						"[Agent Formula] Config missing or invalid. Run /formula-config: formula_list_models, formula_get_config, formula_save_config with judge + tagged models.",
					);
				}
				return;
			}
			if (!loaded.consistency.consistent) {
				ctx.ui.notify(
					`配置中有模型当前不可用: ${loaded.consistency.missing.join(", ")}。将用剩余可用模型建议；可用 /formula-config 更新。`,
					"warning",
				);
			}

			const snap = buildSnapshot(ctx, tracking());
			ctx.ui.notify("Agent Formula: 评估难度与省耗…", "info");

			const fit = buildSessionFit(ctx, loaded.config, snap);
			// Prefer async judge; fall back to rules (difficulty + thrift + quality)
			const judge = await runJudge(ctx, loaded.config, snap, fit);
			const suggestion = makeSuggestion(ctx, loaded.config, snap, judge, fit);

			await presentSuggestion(pi, ctx, suggestion, (dismissed) => {
				recordSuggestion(suggestion, snap, dismissed);
			});
		},
	});

	// --- session lifecycle ---
	pi.on("session_start", async (_event, ctx) => {
		sessionStart = Date.now();
		correctionStreak = 0;
		toolFail = { tool: null, streak: 0 };
		explicitSwitch = false;
		cooldown = null;
		turnsSinceSuggest = 999;
		nudgedMissingConfig = false;
		autoRunning = false;

		// Catalogue consistency: remind only when configured models are missing from Pi.
		const available = listAvailable(ctx);
		const loaded = loadFormulaConfig(configPath, available);
		if (loaded.status === "ok" && !loaded.consistency.consistent) {
			ctx.ui.notify(
				`Agent Formula 配置与当前 Pi 可用模型不一致（缺失: ${loaded.consistency.missing.join(", ")}）。请运行 /formula-config 更新。`,
				"warning",
			);
		}
		// consistent or missing/invalid: no startup spam (missing handled when /boxbox runs)
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as SessionMsg;
		if (msg.role === "user") {
			const text = extractText(msg.content);
			if (text.startsWith("[Agent Formula")) return;
			correctionStreak = nextCorrectionStreak(correctionStreak, text);
			// Reflect the latest user message: a non-switch message clears the one-shot intent.
			explicitSwitch = isExplicitSwitchIntent(text);
			turnsSinceSuggest += 1;
		}
	});

	pi.on("tool_result", async (event) => {
		toolFail = nextToolFailStreak(toolFail, {
			toolName: event.toolName,
			failed: event.isError === true,
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		void maybeAutoBox(ctx);
	});

	/**
	 * Auto mid-session suggestion: fires only on negative set A
	 * (correction streak ≥ 2 / same-tool fail ≥ 2 / explicit switch intent).
	 * Volume signals never trigger; economy stays manual /boxbox only (see #6
	 * UX lesson). Missing/invalid config → at most one mild nudge per session.
	 */
	async function maybeAutoBox(ctx: ExtensionContext): Promise<void> {
		if (autoRunning) return;

		const snap = buildSnapshot(ctx, tracking());
		const negative = computeNegativeFire(snap);

		const available = listAvailable(ctx);
		const loaded = loadFormulaConfig(configPath, available);

		// No valid config: auto path off; one mild nudge per session on pain.
		if (loaded.status !== "ok") {
			if (negative.shouldFire && !nudgedMissingConfig) {
				nudgedMissingConfig = true;
				ctx.ui.notify(
					"Agent Formula 未配置：检测到连续纠正/工具失败。需要自动换模建议时可运行 /formula-config。",
					"info",
				);
			}
			return;
		}

		if (!negative.shouldFire) return;

		const now = Date.now();
		if (isInCooldown(cooldown, now, turnsSinceSuggest)) {
			if (!canBreakCooldown(cooldown, negative, snap.explicitSwitchIntent)) return;
		}

		autoRunning = true;
		try {
			const fit = buildSessionFit(ctx, loaded.config, snap);
			void (async () => {
				try {
					// Judge is async fire-and-forget: never blocks the agent loop.
					const judge = await runJudge(ctx, loaded.config, snap, fit);
					const suggestion = makeSuggestion(
						ctx,
						loaded.config,
						snap,
						judge,
						fit,
						true,
					);

					if (!suggestion.shouldSwitch) {
						recordSuggestion(suggestion, snap, true);
						return;
					}

					// Agent became busy again while judge ran: notify only, no confirm.
					if (!ctx.isIdle()) {
						const modeZh =
							suggestion.mode === "quality"
								? "质量升档"
								: suggestion.mode === "match"
									? "难度升档"
									: "省耗降档";
						ctx.ui.notify(
							`Agent Formula: 建议${modeZh} ${suggestion.tierName ?? ""} → ${
								suggestion.target
									? modelKey(suggestion.target.provider, suggestion.target.model)
									: "?"
							}（${suggestion.reason.slice(0, 80)}）。空闲时运行 /boxbox 确认。`,
							"warning",
						);
						recordSuggestion(suggestion, snap, false);
						return;
					}

					await presentSuggestion(pi, ctx, suggestion, (dismissed) => {
						recordSuggestion(suggestion, snap, dismissed);
					});
				} finally {
					autoRunning = false;
				}
			})();
		} catch {
			autoRunning = false;
		}
	}

}
