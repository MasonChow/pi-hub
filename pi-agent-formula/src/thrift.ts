/**
 * Economy / thrift: suggest downshift when the session is calm and
 * the current tire is stronger than the task needs.
 *
 * Separate from negative-fire (quality upgrade). Never sole-trigger on volume.
 * Design O4: auto thrift on by default (long cooldown lives in cooldown.ts).
 */

import type { AuthKind, TireTag } from "./config.ts";
import type { FitAssessment } from "./difficulty.ts";
import type { NegativeFire, SessionSignalSnapshot } from "./signals.ts";

export type EconomyFire = {
	shouldFire: boolean;
	/** Weaker tire to box onto when shouldFire. */
	targetTire: TireTag | null;
	reasons: string[];
};

/** O5: thrift copy differs for subscription quota vs metered API. */
export function thriftSaveHint(auth: AuthKind = "none"): string {
	if (auth === "oauth") return "降档可节省订阅额度消耗";
	if (auth === "api_key") return "降档可降低 API 按量费用";
	return "降档可降低额度/费用消耗";
}

/**
 * Auto economy only when:
 * - fit says economy (overprovisioned)
 * - no quality negative fire
 * - session is calm (no corrections / tool fails / explicit switch)
 * - enough turns to trust "task is light" (≥ 2 user turns)
 */
export function computeEconomyFire(
	snap: SessionSignalSnapshot,
	negative: NegativeFire,
	fit: FitAssessment,
	auth: AuthKind = "none",
): EconomyFire {
	if (negative.shouldFire) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (snap.explicitSwitchIntent) {
		// User asked to switch — leave to quality / explicit path, not thrift.
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (fit.direction !== "economy" || !fit.targetTire) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (snap.consecutiveCorrections > 0 || snap.sameToolFailStreak > 0) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (snap.userTurnCount < 2) {
		return {
			shouldFire: false,
			targetTire: null,
			reasons: ["轮次不足，暂不自动建议降档"],
		};
	}

	const reasons = [
		...fit.reasons.filter((r) => r.includes("偏强") || r.includes("难度")),
		"会话平稳（无连续纠正/工具失败），适合降档",
		thriftSaveHint(auth),
	];
	return {
		shouldFire: true,
		targetTire: fit.targetTire,
		reasons,
	};
}

/**
 * Manual /boxbox: surface economy even on first turns if fit is clear.
 * Still requires overprovisioned fit; does not require multi-turn calm beyond no active pain.
 */
export function computeEconomyOpportunity(
	snap: SessionSignalSnapshot,
	negative: NegativeFire,
	fit: FitAssessment,
	auth: AuthKind = "none",
): EconomyFire {
	if (negative.shouldFire) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (fit.direction !== "economy" || !fit.targetTire) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	if (snap.consecutiveCorrections >= 2 || snap.sameToolFailStreak >= 2) {
		return { shouldFire: false, targetTire: null, reasons: [] };
	}
	return {
		shouldFire: true,
		targetTire: fit.targetTire,
		reasons: [
			...fit.reasons.slice(0, 3),
			"手动进站：任务相对当前胎偏轻",
			thriftSaveHint(auth),
		],
	};
}
