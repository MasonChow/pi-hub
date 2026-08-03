/**
 * Agent Formula — F1-themed model roster + pit-stop switch advisor for Pi.
 *
 * Brand: Agent Formula
 * Config: /formula-config → ~/.pi/agent/formula-pit.json (FORMULA_PIT_CONFIG_PATH)
 * Box (进站): /boxbox → "Box box!"
 *
 * Tires (vertical strength):
 *   red    红胎 Soft  — 进攻/强档
 *   yellow 黄胎 Medium — 均衡/默认
 *   white  白胎 Hard  — 省钱/轻量
 *
 * No legacy fit/boxbox paths or strong/default/cheap aliases.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ModelRef = {
	provider: string;
	model: string;
};

/** A work model the user may switch to; multiple tags can coexist. */
export type TaggedModel = ModelRef & {
	tags: string[];
};

export type FormulaConfig = {
	judge: ModelRef;
	/** Tagged switch targets. At least one required. */
	models: TaggedModel[];
	/**
	 * When choosing a switch target, walk this tag list in order and pick the
	 * first available model that has the tag and is not the current model.
	 */
	tagPriority: string[];
};

export type ValidationOk = { ok: true; config: FormulaConfig };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationErr;

export type AvailableModel = {
	provider: string;
	id: string;
};

/** Auth shape for a provider (from ~/.pi/agent/auth.json). */
export type AuthKind = "oauth" | "api_key" | "none";

/** Tags that mean "confirmed in catalogue walk but not a switch target". */
export const SKIP_TAGS = new Set(["skip", "ignore", "exclude", "unused"]);

/** Brand (collision-safe product family name). */
export const AGENT_FORMULA_BRAND = "Agent Formula";
/** Product line name. */
export const AGENT_FORMULA_PRODUCT = "Agent Formula";

/**
 * F1 dry compounds as strength tags (vertical ladder, red first).
 * Soft(red) = strongest push; Medium(yellow) = balanced; Hard(white) = economy/light.
 */
export const TIRE_TAGS = ["red", "yellow", "white"] as const;
export type TireTag = (typeof TIRE_TAGS)[number];

/** Default match order when tagPriority omitted. */
export const DEFAULT_TAG_PRIORITY = ["red", "yellow", "white", "judge"];

/** Normalize a single tag. */
export function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase();
}

export function normalizeTagsList(tags: string[]): string[] {
	const out: string[] = [];
	for (const raw of tags) {
		const t = normalizeTag(raw);
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** True if model has at least one non-skip tag (eligible switch target). */
export function isSwitchableTaggedModel(m: TaggedModel): boolean {
	return m.tags.some((t) => !SKIP_TAGS.has(t));
}

export function defaultAuthPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

/** Read provider auth kind from auth.json (oauth subscription vs api_key metered). */
export function readProviderAuthKind(authPath: string, provider: string): AuthKind {
	try {
		const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
		const entry = raw[provider];
		if (typeof entry !== "object" || entry === null) return "none";
		const e = entry as Record<string, unknown>;
		if (e.type === "oauth") return "oauth";
		if (e.type === "api_key") return "api_key";
		return "none";
	} catch {
		return "none";
	}
}

export type CatalogueRow = {
	provider: string;
	id: string;
	auth: AuthKind;
	/** oauth preferred for judge billing */
	judgePreferred: boolean;
};

/** Build sorted catalogue rows with auth labels for /formula-config listing. */
export function buildCatalogueRows(
	available: AvailableModel[],
	authPath: string = defaultAuthPath(),
): CatalogueRow[] {
	const rows = available.map((m) => {
		const auth = readProviderAuthKind(authPath, m.provider);
		return {
			provider: m.provider,
			id: m.id,
			auth,
			judgePreferred: auth === "oauth",
		};
	});
	// oauth first, then api_key, then none; stable by provider/id
	const rank = (a: AuthKind) => (a === "oauth" ? 0 : a === "api_key" ? 1 : 2);
	rows.sort((a, b) => {
		const d = rank(a.auth) - rank(b.auth);
		if (d !== 0) return d;
		const p = a.provider.localeCompare(b.provider);
		if (p !== 0) return p;
		return a.id.localeCompare(b.id);
	});
	return rows;
}

/** Chinese labels for auth kinds (user-facing). */
export function authKindZh(auth: AuthKind): string {
	if (auth === "oauth") return "订阅套餐";
	if (auth === "api_key") return "API 按量计费";
	return "未配置认证";
}

/**
 * Tag glossary — F1 颜色只是昵称；核心是「能力 vs 消耗」取舍。
 * 软胎：抓地最强但磨得快；硬胎：没那么猛但耐用省。
 */
export const TAG_GLOSSARY_ZH: Record<string, string> = {
	red:
		"红胎（软胎）— 很强，但消耗快（额度/费用/延迟都更狠）。难题、大重构、硬 bug、连续纠错时用",
	yellow:
		"黄胎（中性）— 能力与消耗折中，日常主力。常规写功能、改逻辑、读代码、联调",
	white:
		"白胎（硬胎）— 没那么猛，但更耐用更省（更快更便宜）。小改、草稿、简单问、额度紧时用",
	skip: "旁观（不进站）— 确认目录里有这台，但 /boxbox 默认不会建议切到它",
};

/**
 * User-facing default priority ladder (first = tried first when suggesting a switch).
 */
export const TAG_PRIORITY_LADDER_ZH: Array<{ tag: string; rank: number; meaning: string }> = [
	{ tag: "red", rank: 1, meaning: "红胎：很强但消耗快 — 卡壳时优先上" },
	{ tag: "yellow", rank: 2, meaning: "黄胎：能力/消耗均衡 — 日常默认" },
	{ tag: "white", rank: 3, meaning: "白胎：更省更耐 — 小活/额度紧" },
];

/** Title under ### P1 (short name only). */
export const TIRE_HEADING_ZH: Record<string, string> = {
	red: "红胎",
	yellow: "黄胎",
	white: "白胎",
	skip: "旁观",
};

/**
 * Body under each P-heading (blockquote). 取舍 · 适合场景
 */
export const TIRE_BLURB_ZH: Record<string, string> = {
	red: "很强但消耗快 · 适合重构/硬bug/架构/纠了还不对",
	yellow: "能力与消耗均衡 · 适合日常开发/读改代码/联调",
	white: "够用且更省更耐 · 适合小改/草稿/简单问/额度紧",
	skip: "不进站 · 确认有此模型但不参与 /boxbox 建议",
};

/** @deprecated */
export const TIRE_ROW_LABEL_ZH = Object.fromEntries(
	Object.keys(TIRE_HEADING_ZH).map((k) => [
		k,
		`${TIRE_HEADING_ZH[k]} — ${TIRE_BLURB_ZH[k] ?? ""}`,
	]),
) as Record<string, string>;
export const TIRE_LABEL_SHORT_ZH = TIRE_ROW_LABEL_ZH;

/** Explain how tagPriority drives switch matching (user-facing Chinese). */
export function tagPriorityExplainerZh(priority: string[] = DEFAULT_TAG_PRIORITY): string {
	const workOrder = priority.filter((t) => t !== "judge" && !SKIP_TAGS.has(t));
	const ladder = workOrder
		.map((tag, i) => {
			const known = TAG_PRIORITY_LADDER_ZH.find((x) => x.tag === tag);
			const meaning = known?.meaning ?? TAG_GLOSSARY_ZH[tag] ?? tag;
			return `  ${i + 1}. 【${tag}】${meaning}`;
		})
		.join("\n");
	return [
		"匹配优先级（tagPriority）— 决定 /fit「先试哪一档」：",
		"  当建议换模时，按下面顺序找「带该标签、当前可用、且不是你正在用的模型」的第一个命中。",
		"  排在前面的标签更优先；后面的是备选。skip 的模型不进这条队列。",
		"",
		"  当前建议顺序（数字越小越优先）：",
		ladder,
		"",
		"  例：白胎上改小功能却连续改错 → 更可能 box 上红胎（更强模型）。",
		"  可改胎序，例如只要「强 → 省」：red > white。",
	].join("\n");
}

export {
	BUILTIN_TIER_GUIDE,
	authPreferenceRank,
	compareWithinTierMatch,
	looksLightModelId,
	speedClass,
	suggestTagsFromGuide,
} from "./builtin-tier-guide.ts";
import {
	BUILTIN_TIER_GUIDE,
	compareWithinTierMatch,
	looksLightModelId,
	suggestTagsFromGuide,
} from "./builtin-tier-guide.ts";

/** Suggested tags for a work model — driven by editable builtin-tier-guide.ts */
export function suggestTagsForModel(
	modelId: string,
	auth: AuthKind,
	provider = "",
): string[] {
	return suggestTagsFromGuide({ provider, modelId, auth });
}

export type JudgeRecommendation = {
	provider: string;
	model: string;
	auth: AuthKind;
	reasonZh: string;
};

/** True if builtin guide would default this model to skip-only (not recommended). */
export function isBuiltinSkipDefault(provider: string, modelId: string): boolean {
	const tags = suggestTagsFromGuide({ provider, modelId, auth: "none" });
	return tags.length > 0 && tags.every((t) => SKIP_TAGS.has(t));
}

/**
 * Pick one recommended judge: prefer oauth + light id; then any oauth; then light api_key; then first.
 * Never recommends builtin-skip models (e.g. GPT-5.4 / 5.5) unless they are the only models left.
 */
export function recommendJudge(rows: CatalogueRow[]): JudgeRecommendation | null {
	if (rows.length === 0) return null;
	const eligible = rows.filter((r) => !isBuiltinSkipDefault(r.provider, r.id));
	const pool = eligible.length > 0 ? eligible : rows;

	const oauthLight = pool.filter((r) => r.auth === "oauth" && looksLightModelId(r.id));
	const oauthAny = pool.filter((r) => r.auth === "oauth");
	const apiLight = pool.filter((r) => r.auth === "api_key" && looksLightModelId(r.id));

	const pick =
		oauthLight[0] ??
		oauthAny.find((r) => /luna|flash|mini|spark|haiku/.test(r.id.toLowerCase())) ??
		oauthAny[0] ??
		apiLight[0] ??
		pool[0];

	let reasonZh: string;
	if (pick.auth === "oauth" && looksLightModelId(pick.id)) {
		reasonZh =
			"属于订阅套餐下的轻量/快速模型，适合做「评判参谋」：调用不额外按量计费（吃订阅额度），且足够快，不会拖慢你的主任务。";
	} else if (pick.auth === "oauth") {
		reasonZh =
			"属于订阅套餐模型，优先于 API 按量模型做评判，避免参谋调用产生额外按量费用。若有更轻的订阅档（如 luna/flash）可再改。";
	} else if (looksLightModelId(pick.id)) {
		reasonZh =
			"当前没有检测到可用的订阅(oauth)模型，故推荐轻量按量模型作评判；若你之后登录订阅账号，建议把 judge 改回订阅轻量档。";
	} else {
		reasonZh =
			"目录中暂无更合适的轻量/订阅选项，暂用此模型；配置后仍可随时 /formula-config 调整。";
	}

	return {
		provider: pick.provider,
		model: pick.id,
		auth: pick.auth,
		reasonZh,
	};
}

export type TagProposalRow = {
	provider: string;
	model: string;
	auth: AuthKind;
	suggestedTags: string[];
};

/** Default full-list tag proposal for module 2 (every catalogue row). */
export function buildTagProposals(rows: CatalogueRow[]): TagProposalRow[] {
	return rows.map((r) => ({
		provider: r.provider,
		model: r.id,
		auth: r.auth,
		suggestedTags: suggestTagsForModel(r.id, r.auth, r.provider),
	}));
}

/** Short auth mix for a horizontal band of models. */
function authSummaryForRows(rows: TagProposalRow[]): string {
	if (rows.length === 0) return "";
	const kinds = new Set(rows.map((r) => authKindZh(r.auth)));
	return [...kinds].join("/");
}

/**
 * Compact two-module Chinese proposal (one-screen friendly).
 * Strength ranks vertical; models within a rank horizontal; empty ranks omitted.
 */
export function formatTwoModuleProposalZh(
	rows: CatalogueRow[],
	judge: JudgeRecommendation | null = recommendJudge(rows),
	tagRows: TagProposalRow[] = buildTagProposals(rows),
	tagPriority: string[] = DEFAULT_TAG_PRIORITY,
): string {
	const workPri = tagPriority.filter((t) => t !== "judge" && !SKIP_TAGS.has(t));
	const keyOf = (r: TagProposalRow) => modelKey(r.provider, r.model);
	const isSkipOnly = (r: TagProposalRow) =>
		r.suggestedTags.length > 0 && r.suggestedTags.every((t) => SKIP_TAGS.has(t));
	const primaryTag = (r: TagProposalRow): string => {
		const t = r.suggestedTags.find((x) => !SKIP_TAGS.has(x));
		return t ?? "skip";
	};
	const shortId = (key: string) => {
		// openai-codex/gpt-5.6-luna → gpt-5.6-luna when unique enough
		const parts = key.split("/");
		return parts.length === 2 ? parts[1] : key;
	};
	const shortKey = (r: TagProposalRow) => {
		const full = keyOf(r);
		const id = shortId(full);
		const clash = tagRows.filter((x) => shortId(keyOf(x)) === id).length > 1;
		return clash ? full : id;
	};

	const lines: string[] = [
		"【Agent Formula】一屏确认 · 同意请直接回「都同意」",
		`（${BUILTIN_TIER_GUIDE.updated} · builtin-models.json）`,
		"",
		"① 评判模型（要不要 box 时用；优先订阅轻量）",
	];

	if (!judge) {
		lines.push("   （无可用模型）");
	} else {
		const jKey = modelKey(judge.provider, judge.model);
		const jShort = shortId(jKey);
		lines.push(`   ${jShort}  ·  ${authKindZh(judge.auth)}`);
		const reason =
			judge.auth === "oauth" && looksLightModelId(judge.model)
				? "订阅轻量，适合当参谋"
				: judge.auth === "oauth"
					? "订阅模型，少花按量费"
					: "暂无合适订阅轻量，用此模型";
		lines.push(`   ${reason}`);
	}

	lines.push(
		"",
		"② 轮胎队列（上↓优先；同行左→右=订阅优先再比快）",
	);

	const assigned = new Set<string>();
	let rankShown = 0;
	for (const tag of workPri) {
		const here = tagRows.filter((r) => !isSkipOnly(r) && primaryTag(r) === tag);
		if (here.length === 0) continue; // omit empty ranks — saves screen
		// 同档横向 = 匹配顺序：oauth → api_key，再 speed 快→慢
		const sortedHere = [...here].sort((a, b) =>
			compareWithinTierMatch(
				{ provider: a.provider, model: a.model, auth: a.auth },
				{ provider: b.provider, model: b.model, auth: b.auth },
				tag,
			),
		);
		rankShown += 1;
		const heading = TIRE_HEADING_ZH[tag] ?? tag;
		const blurb = TIRE_BLURB_ZH[tag] ?? "";
		const names = sortedHere.map((r) => {
			assigned.add(keyOf(r));
			return shortKey(r);
		});
		// Markdown-ish: ### P1 红胎 + blockquote meaning + models
		if (rankShown > 1) lines.push("");
		lines.push(`### P${rankShown} ${heading}`);
		lines.push("");
		if (blurb) lines.push(`> ${blurb}`);
		lines.push("");
		lines.push(names.join(" → "));
	}

	const orphan = tagRows.filter((r) => !isSkipOnly(r) && !assigned.has(keyOf(r)));
	if (orphan.length > 0) {
		const sortedOrphan = [...orphan].sort((a, b) =>
			compareWithinTierMatch(
				{ provider: a.provider, model: a.model, auth: a.auth },
				{ provider: b.provider, model: b.model, auth: b.auth },
			),
		);
		for (const r of sortedOrphan) assigned.add(keyOf(r));
		lines.push(
			`其他 ${sortedOrphan.map((r) => `${shortKey(r)}[${r.suggestedTags[0]}]`).join(" → ")}`,
		);
	}

	const skipModels = tagRows.filter(isSkipOnly);
	const missing = tagRows.filter((r) => !assigned.has(keyOf(r)) && !isSkipOnly(r));
	const skips = [...skipModels, ...missing];
	if (skips.length > 0) {
		lines.push(`skip ${skips.map((r) => shortKey(r)).join(" · ")}`);
	}

	lines.push(
		"",
		`共 ${tagRows.length} 模 · 改：①换评判 / 「x→red」/「y→skip」/ 胎序 red>yellow>white`,
	);

	return lines.join("\n");
}

/**
 * User-facing catalogue proposal only (judge + tire list).
 * Full provider/model rows stay in tool `details.rows` for the agent to save —
 * no second keys dump on screen.
 */
export function formatCatalogueForConfig(rows: CatalogueRow[]): string {
	if (rows.length === 0) return "（无可用模型）";
	const judge = recommendJudge(rows);
	return formatTwoModuleProposalZh(rows, judge);
}

/**
 * Every available model must appear in models[] (full catalogue confirmation).
 * Missing keys are returned for error messages.
 */
export function catalogueCoverageGaps(
	models: TaggedModel[],
	available: AvailableModel[],
): string[] {
	const configured = new Set(models.map((m) => modelKey(m.provider, m.model)));
	const gaps: string[] = [];
	for (const a of available) {
		const k = modelKey(a.provider, a.id);
		if (!configured.has(k)) gaps.push(k);
	}
	return gaps;
}

export function defaultConfigPath(): string {
	return process.env.FORMULA_PIT_CONFIG_PATH?.trim() || path.join(os.homedir(), ".pi", "agent", "formula-pit.json");
}

export function modelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

export function availableKeySet(models: AvailableModel[]): Set<string> {
	return new Set(models.map((m) => modelKey(m.provider, m.id)));
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function parseModelRef(raw: unknown, label: string, errors: string[]): ModelRef | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${label} must be an object { provider, model }`);
		return null;
	}
	const o = raw as Record<string, unknown>;
	if (!isNonEmptyString(o.provider)) {
		errors.push(`${label}.provider must be a non-empty string`);
	}
	if (!isNonEmptyString(o.model)) {
		errors.push(`${label}.model must be a non-empty string`);
	}
	if (!isNonEmptyString(o.provider) || !isNonEmptyString(o.model)) return null;
	return { provider: o.provider.trim(), model: o.model.trim() };
}

function parseTags(raw: unknown, label: string, errors: string[]): string[] | null {
	if (!Array.isArray(raw) || raw.length === 0) {
		errors.push(`${label}.tags must be a non-empty string array`);
		return null;
	}
	const tags: string[] = [];
	for (const t of raw) {
		if (!isNonEmptyString(t)) {
			errors.push(`${label}.tags entries must be non-empty strings`);
			continue;
		}
		const tag = normalizeTag(t);
		if (tag && !tags.includes(tag)) tags.push(tag);
	}
	if (tags.length === 0) {
		errors.push(`${label}.tags must contain at least one valid tag`);
		return null;
	}
	return tags;
}

function parseTagPriority(raw: unknown, errors: string[]): string[] {
	if (raw === undefined || raw === null) return [...DEFAULT_TAG_PRIORITY];
	if (!Array.isArray(raw)) {
		errors.push("tagPriority must be an array of tag strings");
		return [...DEFAULT_TAG_PRIORITY];
	}
	const out: string[] = [];
	for (const t of raw) {
		if (!isNonEmptyString(t)) {
			errors.push("tagPriority entries must be non-empty strings");
			continue;
		}
		const tag = normalizeTag(t);
		if (tag && !out.includes(tag)) out.push(tag);
	}
	// Append defaults not listed so uncommon tags still match later
	for (const d of DEFAULT_TAG_PRIORITY) {
		if (!out.includes(d)) out.push(d);
	}
	return out.length > 0 ? out : [...DEFAULT_TAG_PRIORITY];
}

/**
 * Parse + hard-validate against available catalogue (for save / strict load).
 * Requires models[] with tire tags (red/yellow/white) or skip.
 */
export function validateFormulaConfig(raw: unknown, available: AvailableModel[]): ValidationResult {
	const errors: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, errors: ["config must be a JSON object"] };
	}
	const o = raw as Record<string, unknown>;
	const availableKeys = availableKeySet(available);
	const checkPresence = availableKeys.size > 0;

	const judge = parseModelRef(o.judge, "judge", errors);
	if (judge && checkPresence && !availableKeys.has(modelKey(judge.provider, judge.model))) {
		errors.push(`judge model not available: ${modelKey(judge.provider, judge.model)}`);
	}

	const models: TaggedModel[] = [];

	if (!Array.isArray(o.models)) {
		errors.push("models must be a non-empty array of { provider, model, tags }");
	} else if (o.models.length === 0) {
		errors.push("models must contain at least one entry");
	} else {
		for (let i = 0; i < o.models.length; i++) {
			const item = o.models[i];
			const label = `models[${i}]`;
			const ref = parseModelRef(item, label, errors);
			if (!ref) continue;
			const tags = parseTags(
				typeof item === "object" && item !== null ? (item as Record<string, unknown>).tags : undefined,
				label,
				errors,
			);
			if (!tags) continue;
			if (checkPresence && !availableKeys.has(modelKey(ref.provider, ref.model))) {
				errors.push(`${label} model not available: ${modelKey(ref.provider, ref.model)}`);
				continue;
			}
			const key = modelKey(ref.provider, ref.model);
			const existing = models.find((m) => modelKey(m.provider, m.model) === key);
			if (existing) {
				for (const t of tags) {
					if (!existing.tags.includes(t)) existing.tags.push(t);
				}
			} else {
				models.push({ ...ref, tags });
			}
		}
	}

	const tagPriority = parseTagPriority(o.tagPriority, errors);

	// Full catalogue confirmation: every available model must be tagged (or skip)
	if (checkPresence && models.length > 0) {
		const gaps = catalogueCoverageGaps(models, available);
		if (gaps.length > 0) {
			errors.push(
				`models must cover ALL available Pi models (missing ${gaps.length}): ${gaps.slice(0, 12).join(", ")}${gaps.length > 12 ? "…" : ""}. Use tags:["skip"] to confirm-and-exclude.`,
			);
		}
		const switchable = models.filter(isSwitchableTaggedModel);
		if (switchable.length === 0) {
			errors.push(
				'at least one model must have a tire tag (red/yellow/white) so Box can switch',
			);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	if (!judge) return { ok: false, errors: ["judge is required"] };
	if (models.length === 0) {
		return { ok: false, errors: ["models must contain at least one tagged model"] };
	}
	return { ok: true, config: { judge, models, tagPriority } };
}

/**
 * Structure-only parse: does not require models to exist in the live catalogue.
 * Used for startup consistency checks and soft load.
 */
export function parseFormulaConfigStructure(raw: unknown): ValidationResult {
	return validateFormulaConfig(raw, []); // empty available → skip presence checks
}

export type ConsistencyResult = {
	consistent: boolean;
	/** provider/model keys missing from live catalogue */
	missing: string[];
	/** present keys */
	present: string[];
};

/** Compare configured judge + tagged models against live Pi available models. */
export function checkCatalogueConsistency(
	config: FormulaConfig,
	available: AvailableModel[],
): ConsistencyResult {
	const keys = availableKeySet(available);
	const refs = [config.judge, ...config.models];
	const missing: string[] = [];
	const present: string[] = [];
	const seen = new Set<string>();
	for (const r of refs) {
		const k = modelKey(r.provider, r.model);
		if (seen.has(k)) continue;
		seen.add(k);
		if (keys.has(k)) present.push(k);
		else missing.push(k);
	}
	return { consistent: missing.length === 0, missing, present };
}

export type LoadResult =
	| { status: "missing" }
	| { status: "invalid"; errors: string[]; rawText?: string }
	| {
			status: "ok";
			config: FormulaConfig;
			/** Soft: missing from live catalogue (still ok structure) */
			consistency: ConsistencyResult;
	  };

/**
 * Load config from formula-pit.json only (no legacy paths).
 */
export function loadFormulaConfig(configPath: string, available: AvailableModel[]): LoadResult {
	if (!fs.existsSync(configPath)) return { status: "missing" };

	let text: string;
	try {
		text = fs.readFileSync(configPath, "utf8");
	} catch (e) {
		return { status: "invalid", errors: [`cannot read config: ${String(e)}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { status: "invalid", errors: ["config is not valid JSON"], rawText: text };
	}
	const parsed = parseFormulaConfigStructure(raw);
	if (!parsed.ok) return { status: "invalid", errors: parsed.errors, rawText: text };
	const consistency = checkCatalogueConsistency(parsed.config, available);
	return { status: "ok", config: parsed.config, consistency };
}

/**
 * Validate (including presence) then write atomically. Rejects unavailable models.
 */
export function saveFormulaConfig(
	configPath: string,
	raw: unknown,
	available: AvailableModel[],
): ValidationResult {
	const result = validateFormulaConfig(raw, available);
	if (!result.ok) return result;

	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	const body = `${JSON.stringify(result.config, null, 2)}\n`;
	try {
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, configPath);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		return { ok: false, errors: [`failed to write config: ${String(e)}`] };
	}
	return result;
}

/** All unique tags declared on work models. */
export function allConfigTags(config: FormulaConfig): string[] {
	const tags = new Set<string>();
	for (const m of config.models) {
		for (const t of m.tags) tags.add(t);
	}
	return [...tags];
}

export function formatConfigSummary(
	config: FormulaConfig,
	opts?: { available?: AvailableModel[]; authPath?: string },
): string {
	const pri = config.tagPriority.filter((t) => t !== "judge");
	const lines = [
		"角色说明: judge=评判参谋；models=全量打标；tagPriority=换模匹配顺序（越靠前越优先）",
		`judge（评判）: ${modelKey(config.judge.provider, config.judge.model)}`,
		`匹配优先级（P1→P…）: ${pri.map((t, i) => `P${i + 1}=${t}`).join(" → ")}`,
		"models（须覆盖 Pi 全部可用模型）:",
		...config.models.map((m) => {
			if (!isSwitchableTaggedModel(m)) {
				return `  ${modelKey(m.provider, m.model)}  tags=[${m.tags.join(", ")}]  优先阶=—（skip）`;
			}
			const ranks = m.tags
				.filter((t) => !SKIP_TAGS.has(t))
				.map((t) => {
					const idx = pri.indexOf(t);
					return idx >= 0 ? `${t}=P${idx + 1}` : t;
				});
			return `  ${modelKey(m.provider, m.model)}  tags=[${m.tags.join(", ")}]  ${ranks.join(", ")}`;
		}),
	];
	const hints = configQualityHints(config, opts);
	if (hints.length > 0) {
		lines.push("配置提示:");
		for (const h of hints) lines.push(`  - ${h}`);
	}
	return lines.join("\n");
}

/**
 * User-facing tire roster (what /boxbox can pick). Prefer this over dumping
 * candidates into the box suggestion — keeps the call focused.
 */
export function formatTireRoster(
	config: FormulaConfig,
	opts?: {
		available?: AvailableModel[];
		authPath?: string;
		current?: ModelRef | null;
	},
): string {
	const available = opts?.available ?? [];
	const authPath = opts?.authPath ?? defaultAuthPath();
	const availKeys = availableKeySet(available);
	const checkAvail = availKeys.size > 0;
	const pri = config.tagPriority.filter((t) => t !== "judge" && !SKIP_TAGS.has(t));
	const cur = opts?.current
		? modelKey(opts.current.provider, opts.current.model)
		: null;

	const shortId = (key: string) => {
		const parts = key.split("/");
		return parts.length === 2 ? parts[1]! : key;
	};
	const allSwitchable = config.models.filter(isSwitchableTaggedModel);
	const shortKey = (m: TaggedModel) => {
		const full = modelKey(m.provider, m.model);
		const id = shortId(full);
		const clash =
			config.models.filter((x) => shortId(modelKey(x.provider, x.model)) === id).length > 1;
		return clash ? full : id;
	};

	const isLive = (m: TaggedModel) =>
		!checkAvail || availKeys.has(modelKey(m.provider, m.model));

	const lines: string[] = [
		"【Agent Formula】可选档位",
		`匹配顺序: ${pri.map((t, i) => `P${i + 1} ${TIRE_HEADING_ZH[t] ?? t}`).join(" → ")}`,
	];
	if (cur) lines.push(`当前: ${cur}`);
	lines.push("");

	const assigned = new Set<string>();
	let rankShown = 0;
	for (const tag of pri) {
		const here = allSwitchable.filter((m) => m.tags.includes(tag) && isLive(m));
		if (here.length === 0) continue;
		const sorted = sortWithinTier(here, authPath, tag);
		rankShown += 1;
		if (rankShown > 1) lines.push("");
		lines.push(`### P${rankShown} ${TIRE_HEADING_ZH[tag] ?? tag}`);
		lines.push("");
		const blurb = TIRE_BLURB_ZH[tag];
		if (blurb) lines.push(`> ${blurb}`);
		lines.push("");
		const names = sorted.map((m) => {
			assigned.add(modelKey(m.provider, m.model));
			const mark = cur && modelKey(m.provider, m.model) === cur ? "（当前）" : "";
			return `${shortKey(m)}${mark}`;
		});
		lines.push(names.join(" → "));
	}

	const skips = config.models.filter((m) => !isSwitchableTaggedModel(m) && isLive(m));
	if (skips.length > 0) {
		lines.push("");
		lines.push(`skip ${skips.map((m) => shortKey(m)).join(" · ")}`);
	}

	const offline = allSwitchable.filter((m) => !isLive(m));
	if (offline.length > 0) {
		lines.push("");
		lines.push(`不可用 ${offline.map((m) => shortKey(m)).join(" · ")}`);
	}

	lines.push(
		"",
		`共 ${assigned.size} 可切换 · 进站评估 /boxbox · 改配置 /formula-config`,
	);
	return lines.join("\n");
}

export function configQualityHints(
	config: FormulaConfig,
	opts?: { available?: AvailableModel[]; authPath?: string },
): string[] {
	const hints: string[] = [];
	const switchable = config.models.filter(isSwitchableTaggedModel);
	const keys = switchable.map((m) => modelKey(m.provider, m.model));
	const unique = new Set(keys);
	if (unique.size < 2 && keys.length >= 1) {
		hints.push(
			"可切换模型（非 skip）不足 2 个：Box 选择很少。请为更多模型贴红/黄/白胎。",
		);
	}
	const judgeKey = modelKey(config.judge.provider, config.judge.model);
	if (keys.length > 0 && keys.every((k) => k === judgeKey)) {
		hints.push(
			"judge 与全部可切换模型相同：可接受，但通常 judge 选订阅套餐里的轻量档更省。",
		);
	}

	// Prefer subscription (oauth) for judge when any oauth model exists
	const available = opts?.available ?? [];
	const authPath = opts?.authPath ?? defaultAuthPath();
	if (available.length > 0) {
		const rows = buildCatalogueRows(available, authPath);
		const oauthRows = rows.filter((r) => r.auth === "oauth");
		const judgeAuth = readProviderAuthKind(authPath, config.judge.provider);
		if (oauthRows.length > 0 && judgeAuth === "api_key") {
			const examples = oauthRows
				.slice(0, 5)
				.map((r) => modelKey(r.provider, r.id))
				.join(", ");
			hints.push(
				`judge 当前是 api_key 按量模型；存在订阅(oauth)模型时优先选订阅轻量档作 judge（例: ${examples}），以降低按量费用。`,
			);
		}
	}
	return hints;
}

/**
 * Sort models for same-tier display/match: oauth → (red: strength) / (else: speed).
 */
export function sortWithinTier<T extends ModelRef>(
	models: T[],
	authPath: string = defaultAuthPath(),
	tireTag?: string,
): T[] {
	return [...models].sort((a, b) =>
		compareWithinTierMatch(
			{
				provider: a.provider,
				model: a.model,
				auth: readProviderAuthKind(authPath, a.provider),
			},
			{
				provider: b.provider,
				model: b.model,
				auth: readProviderAuthKind(authPath, b.provider),
			},
			tireTag,
		),
	);
}

/**
 * Priority candidate pick:
 * 1) walk tagPriority (strength ladder, vertical)
 * 2) within the same tag: subscription (oauth) first, then faster
 * 3) else any other available tagged model (same within-tier sort)
 */
export function pickByTagPriority(
	config: FormulaConfig,
	current: ModelRef | null,
	available: AvailableModel[],
	preferredTag?: string | null,
	authPath: string = defaultAuthPath(),
): { ref: ModelRef; matchedTag: string; tags: string[] } | null {
	const avail = availableKeySet(available);
	const curKey = current ? modelKey(current.provider, current.model) : null;

	const usable = config.models.filter((m) => {
		if (!isSwitchableTaggedModel(m)) return false;
		const k = modelKey(m.provider, m.model);
		if (!avail.has(k)) return false;
		if (curKey && k === curKey) return false;
		return true;
	});
	if (usable.length === 0) return null;

	const preferred = preferredTag ? normalizeTag(preferredTag) : null;
	const order = preferred
		? [preferred, ...config.tagPriority.filter((t) => t !== preferred)]
		: config.tagPriority;

	for (const tag of order) {
		const candidates = usable.filter((m) => m.tags.includes(tag));
		const sorted = sortWithinTier(candidates, authPath, tag);
		const hit = sorted[0];
		if (hit) {
			return {
				ref: { provider: hit.provider, model: hit.model },
				matchedTag: tag,
				tags: hit.tags,
			};
		}
	}
	const sortedAll = sortWithinTier(usable, authPath);
	const first = sortedAll[0];
	return {
		ref: { provider: first.provider, model: first.model },
		matchedTag: first.tags[0] ?? "any",
		tags: first.tags,
	};
}
