/**
 * Rule-based model match suggestion from tagged models + tag priority.
 * Modes: quality (upgrade), economy (downshift thrift), match (difficulty fit).
 */

import type { FormulaConfig, ModelRef, TireTag } from "./config.ts";
import {
	isSwitchableTaggedModel,
	modelKey,
	pickByTagPriority,
	type AvailableModel,
} from "./config.ts";
import type { CostBand } from "./cost.ts";
import type { FitAssessment } from "./difficulty.ts";
import { assessFit, assessDifficulty, strongestTireTag } from "./difficulty.ts";
import type { HeatLevel, NegativeFire, SessionSignalSnapshot } from "./signals.ts";
import type { EconomyFire } from "./thrift.ts";

export type AvailableRef = { provider: string; id: string };

/** Why we recommend a switch (user-facing mode). */
export type SuggestMode = "quality" | "economy" | "match" | "none";

export type SuggestInput = {
	config: FormulaConfig;
	current: ModelRef | null;
	available: AvailableRef[];
	snap: SessionSignalSnapshot;
	heat: HeatLevel;
	negative: NegativeFire;
	/** Precomputed fit; if omitted, derived from snap + config current tire. */
	fit?: FitAssessment | null;
	/** Economy opportunity (manual or auto). */
	economy?: EconomyFire | null;
	/**
	 * When true, allow difficulty underpowered "match" to recommend upgrade
	 * even without negative fire (typical for manual /boxbox).
	 */
	allowMatchUpgrade?: boolean;
	/** Optional judge free-text (when present, preferred for reason). */
	judgeReason?: string | null;
	/** Optional judge preferred tag (was tier name). */
	judgeTier?: string | null;
	/**
	 * Explicit judge switch decision when judge ran successfully.
	 * null/undefined = no usable judge verdict (use rules only; do not suppress).
	 */
	judgeShouldSwitch?: boolean | null;
	/** Optional judge mode hint: quality | economy | match. */
	judgeMode?: SuggestMode | null;
	costBand: CostBand;
};

export type Suggestion = {
	shouldSwitch: boolean;
	/** Target model if shouldSwitch */
	target: ModelRef | null;
	/** Matched tag label for display */
	tierName: string | null;
	reason: string;
	costSummary: string;
	/** quality | economy | match | none */
	mode: SuggestMode;
	/** Difficulty / fit snapshot for UI. */
	fit: FitAssessment | null;
	/** Candidates considered (available only). */
	candidates: Array<{ tier: string; ref: ModelRef }>;
};

export function resolveCurrentTire(
	config: FormulaConfig,
	current: ModelRef | null,
): TireTag | null {
	if (!current) return null;
	const row = config.models.find(
		(m) => m.provider === current.provider && m.model === current.model,
	);
	if (!row) return null;
	return strongestTireTag(row.tags);
}

function buildFit(
	config: FormulaConfig,
	current: ModelRef | null,
	snap: SessionSignalSnapshot,
	userMessages: string[] | undefined,
	fit: FitAssessment | null | undefined,
): FitAssessment {
	if (fit) return fit;
	const difficulty = assessDifficulty({
		userMessages: userMessages ?? [],
		consecutiveCorrections: snap.consecutiveCorrections,
		sameToolFailStreak: snap.sameToolFailStreak,
	});
	return assessFit(resolveCurrentTire(config, current), difficulty);
}

/**
 * Prefer stronger tags on quality failures; weaker on economy; judge tier when set.
 */
export function buildSuggestion(input: SuggestInput): Suggestion {
	const available: AvailableModel[] = input.available.map((a) => ({
		provider: a.provider,
		id: a.id,
	}));

	const candidates = input.config.models
		.filter(
			(m) =>
				isSwitchableTaggedModel(m) &&
				available.some((a) => a.provider === m.provider && a.id === m.model),
		)
		.map((m) => ({
			tier: m.tags.join("+"),
			ref: { provider: m.provider, model: m.model } as ModelRef,
		}));

	const fit = buildFit(
		input.config,
		input.current,
		input.snap,
		// snap does not carry messages; caller should pass fit when available
		undefined,
		input.fit,
	);

	const economy = input.economy ?? {
		shouldFire: false,
		targetTire: null,
		reasons: [],
	};

	const judgeDecided = typeof input.judgeShouldSwitch === "boolean";
	const judgeSaysNo = judgeDecided && input.judgeShouldSwitch === false;
	const judgeSaysYes = judgeDecided && input.judgeShouldSwitch === true;

	// Priority: quality negative > judge yes > match underpowered > economy
	let mode: SuggestMode = "none";
	let preferredTag: string | null = null;

	const judgeTierOk =
		input.judgeTier &&
		input.config.models.some((m) => m.tags.includes(input.judgeTier!.toLowerCase()))
			? input.judgeTier.toLowerCase()
			: null;

	if (input.negative.shouldFire) {
		mode = "quality";
		preferredTag = judgeTierOk ?? fit.targetTire ?? "red";
		// On quality pain, if fit already wants upgrade use that tire; else climb toward red
		if (fit.direction === "upgrade" && fit.targetTire) {
			preferredTag = judgeTierOk ?? fit.targetTire;
		} else if (!judgeTierOk) {
			preferredTag = "red";
		}
	} else if (judgeSaysYes && judgeTierOk) {
		mode =
			input.judgeMode === "economy" || input.judgeMode === "match" || input.judgeMode === "quality"
				? input.judgeMode
				: fit.direction === "economy"
					? "economy"
					: fit.direction === "upgrade"
						? "match"
						: "quality";
		preferredTag = judgeTierOk;
	} else if (
		input.allowMatchUpgrade &&
		fit.direction === "upgrade" &&
		fit.targetTire
	) {
		mode = "match";
		preferredTag = judgeTierOk ?? fit.targetTire;
	} else if (economy.shouldFire && economy.targetTire) {
		mode = "economy";
		preferredTag = judgeTierOk ?? economy.targetTire;
	} else if (judgeSaysYes) {
		// Judge yes without valid tier — still try pick by default priority
		mode = input.judgeMode === "economy" ? "economy" : "quality";
		preferredTag = judgeTierOk;
	}

	// O1: match (difficulty upgrade) is manual /boxbox only — never auto.
	if (!input.allowMatchUpgrade && mode === "match") {
		if (economy.shouldFire && economy.targetTire) {
			mode = "economy";
			preferredTag = economy.targetTire;
		} else {
			mode = "none";
			preferredTag = null;
		}
	}

	// Auto path: judge must not invent quality without a negative signal
	// (entry may be economy-only; keep thrift unless quality pain is present).
	if (
		!input.allowMatchUpgrade &&
		mode === "quality" &&
		!input.negative.shouldFire &&
		!input.snap.explicitSwitchIntent
	) {
		if (economy.shouldFire && economy.targetTire) {
			mode = "economy";
			preferredTag = economy.targetTire;
		} else {
			mode = "none";
			preferredTag = null;
		}
	}

	const pick = pickByTagPriority(
		input.config,
		input.current,
		available,
		preferredTag,
	);

	const shouldSwitch =
		!judgeSaysNo &&
		pick !== null &&
		(mode === "quality" || mode === "economy" || mode === "match");

	const finalMode: SuggestMode = shouldSwitch ? mode : "none";

	let reason: string;
	if (judgeSaysNo && input.judgeReason) {
		reason = input.judgeReason.replace(/^\s*NO_SWITCH\s*:?\s*/i, "").trim();
	} else if (input.judgeReason && (judgeSaysYes || !judgeDecided) && shouldSwitch) {
		reason = input.judgeReason.replace(/^\s*NO_SWITCH\s*:?\s*/i, "").trim();
	} else if (finalMode === "quality" && input.negative.reasons.length > 0) {
		reason = `检测到任务/模型可能不匹配: ${input.negative.reasons.join("；")}`;
		if (fit.direction === "upgrade") {
			reason += `；${fit.reasons.find((r) => r.includes("偏弱")) ?? ""}`.replace(/；\s*$/, "");
		}
	} else if (finalMode === "economy") {
		reason =
			economy.reasons.length > 0
				? economy.reasons.join("；")
				: fit.reasons.join("；") || "当前胎偏强，可降档省消耗";
	} else if (finalMode === "match") {
		reason =
			fit.reasons.find((r) => r.includes("偏弱")) ??
			fit.reasons.join("；") ??
			"任务难度高于当前胎强";
	} else if (input.heat.score >= 40) {
		reason = `会话负载较高（heat=${input.heat.score}）: ${input.heat.reasons.join(", ")}`;
	} else if (fit.direction === "stay") {
		reason =
			fit.reasons.find((r) => r.includes("匹配")) ??
			`当前胎强与任务难度匹配（${fit.difficulty.band} → ${fit.difficulty.recommendedTire}）`;
	} else {
		reason = "未检测到强负向或明显过配；若仍想换模可先 /formula-tires 看可选档位。";
	}

	return {
		shouldSwitch: Boolean(shouldSwitch && pick),
		target: shouldSwitch && pick ? pick.ref : null,
		tierName: shouldSwitch && pick ? pick.matchedTag : null,
		reason,
		costSummary: input.costBand.summary,
		mode: finalMode,
		fit,
		candidates,
	};
}

const MODE_ZH: Record<SuggestMode, string> = {
	quality: "质量进站（升档）",
	economy: "省耗进站（降档）",
	match: "难度匹配（升档）",
	none: "无需进站",
};

export function formatSuggestionMessage(s: Suggestion, current: ModelRef | null): string {
	const cur = current ? modelKey(current.provider, current.model) : "(none)";
	const tireZh: Record<string, string> = {
		red: "红胎·强但耗快",
		yellow: "黄胎·均衡",
		white: "白胎·省而耐",
	};
	const lines = [
		"## Box box! — Agent Formula",
		`当前: ${cur}`,
		`是否建议换模型: ${s.shouldSwitch ? "是" : "否"}`,
		`模式: ${MODE_ZH[s.mode] ?? s.mode}`,
	];
	if (s.fit) {
		const curTire = s.fit.currentTire ?? "?";
		const need = s.fit.difficulty.recommendedTire;
		lines.push(
			`难度: ${s.fit.difficulty.band} (score=${s.fit.difficulty.score}) → 建议${need}胎 · 当前${curTire}胎`,
		);
	}
	lines.push(`原因: ${s.reason}`);
	if (s.target && s.tierName) {
		const tire = tireZh[s.tierName] ?? s.tierName;
		const arrow =
			s.mode === "economy" ? "降档" : s.mode === "match" || s.mode === "quality" ? "升档" : "切换";
		lines.push(`建议${arrow}: ${tire} → ${modelKey(s.target.provider, s.target.model)}`);
	}
	if (s.mode === "economy") {
		lines.push(
			"",
			"省耗说明: 降到更省的胎可降低后续消耗；换模会丢失 prompt cache 连续性（短会话未必划算）。",
		);
	}
	lines.push("", s.costSummary);
	return lines.join("\n");
}
