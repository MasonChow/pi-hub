/**
 * Rule-based model match suggestion from tagged models + tag priority.
 */

import type { FormulaConfig, ModelRef } from "./config.ts";
import {
	isSwitchableTaggedModel,
	modelKey,
	pickByTagPriority,
	type AvailableModel,
} from "./config.ts";
import type { CostBand } from "./cost.ts";
import type { HeatLevel, NegativeFire, SessionSignalSnapshot } from "./signals.ts";

export type AvailableRef = { provider: string; id: string };

export type SuggestInput = {
	config: FormulaConfig;
	current: ModelRef | null;
	available: AvailableRef[];
	snap: SessionSignalSnapshot;
	heat: HeatLevel;
	negative: NegativeFire;
	/** Optional judge free-text (when present, preferred for reason). */
	judgeReason?: string | null;
	/** Optional judge preferred tag (was tier name). */
	judgeTier?: string | null;
	/**
	 * Explicit judge switch decision when judge ran successfully.
	 * null/undefined = no usable judge verdict (use rules only; do not suppress).
	 */
	judgeShouldSwitch?: boolean | null;
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
	/** Candidates considered (available only). */
	candidates: Array<{ tier: string; ref: ModelRef }>;
};

/**
 * Prefer stronger tags on quality failures via tagPriority / judge preferred tag.
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

	const preferredTag =
		input.judgeTier &&
		input.config.models.some((m) => m.tags.includes(input.judgeTier!.toLowerCase()))
			? input.judgeTier.toLowerCase()
			: null;

	const pick = pickByTagPriority(input.config, input.current, available, preferredTag);

	const ruleShould = input.negative.shouldFire;
	const judgeDecided = typeof input.judgeShouldSwitch === "boolean";
	const judgeSaysYes =
		judgeDecided && input.judgeShouldSwitch === true && (preferredTag != null || pick != null);
	const judgeSaysNo = judgeDecided && input.judgeShouldSwitch === false;

	const shouldSwitch = !judgeSaysNo && (ruleShould || judgeSaysYes) && pick !== null;

	let reason: string;
	if (judgeSaysNo && input.judgeReason) {
		reason = input.judgeReason.replace(/^\s*NO_SWITCH\s*:?\s*/i, "").trim();
	} else if (input.judgeReason && (judgeSaysYes || !judgeDecided)) {
		reason = input.judgeReason.replace(/^\s*NO_SWITCH\s*:?\s*/i, "").trim();
	} else if (input.negative.reasons.length > 0) {
		reason = `检测到任务/模型可能不匹配: ${input.negative.reasons.join("；")}`;
	} else if (input.heat.score >= 40) {
		reason = `会话负载较高（heat=${input.heat.score}）: ${input.heat.reasons.join(", ")}`;
	} else {
		reason = "未检测到强负向信号；若仍想换模可先 /formula-tires 看可选档位。";
	}

	return {
		shouldSwitch,
		target: shouldSwitch && pick ? pick.ref : null,
		tierName: shouldSwitch && pick ? pick.matchedTag : null,
		reason,
		costSummary: input.costBand.summary,
		candidates,
	};
}

export function formatSuggestionMessage(s: Suggestion, current: ModelRef | null): string {
	const cur = current ? modelKey(current.provider, current.model) : "(none)";
	const tireZh: Record<string, string> = {
		red: "红胎·强但耗快",
		yellow: "黄胎·均衡",
		white: "白胎·省而耐",
	};
	// Keep focus on the call: current → yes/no → reason → one target. Full roster is /formula-tires.
	const lines = [
		"## Box box! — Agent Formula",
		`当前: ${cur}`,
		`是否建议换模型: ${s.shouldSwitch ? "是" : "否"}`,
		`原因: ${s.reason}`,
	];
	if (s.target && s.tierName) {
		const tire = tireZh[s.tierName] ?? s.tierName;
		lines.push(`建议: ${tire} → ${modelKey(s.target.provider, s.target.model)}`);
	}
	lines.push("", s.costSummary);
	return lines.join("\n");
}
