/**
 * Mid-session fitness signals.
 * Volume (turns / context / duration) only raises heat.
 * Negative set A fires auto suggestions.
 */

export type SessionSignalSnapshot = {
	userTurnCount: number;
	contextPercent: number | null;
	/** Wall ms since session start (or first tracked message). */
	sessionDurationMs: number;
	/** Consecutive user messages that look like corrections. */
	consecutiveCorrections: number;
	/** Consecutive failures of the same tool name. */
	sameToolFailStreak: number;
	lastFailedTool: string | null;
	/** User explicitly asked to switch models or complained about the model. */
	explicitSwitchIntent: boolean;
};

export type HeatLevel = {
	/** 0–100 soft score for judge context only. */
	score: number;
	reasons: string[];
};

export type NegativeFire = {
	shouldFire: boolean;
	reasons: string[];
};

/** Narrow correction lexicon (ZH + EN). Not full NLU. */
const CORRECTION_PATTERNS: RegExp[] = [
	/不对/,
	/不是这样/,
	/我说的是/,
	/我是说/,
	/改成/,
	/应该是/,
	/你理解错/,
	/理解错了/,
	/重做/,
	/重新来/,
	/搞错了/,
	/错了[，,。]?\s*我/,
	/\bwrong\b/i,
	/\bno[,.]?\s+I\s+meant\b/i,
	/\bthat's not\b/i,
	/\bthat is not\b/i,
	/\byou misunderstood\b/i,
	/\btry again\b/i,
	/\bdo it again\b/i,
	/\brewrite\b/i,
	/\bfix it\b/i,
];

const EXPLICIT_SWITCH_PATTERNS: RegExp[] = [
	/换(个|一个)?模型/,
	/切换模型/,
	/换模/,
	/别用这个模型/,
	/换个(更)?(强|聪明|快|便宜)的/,
	/模型(不行|太弱|太慢|太贵)/,
	/\bswitch models?\b/i,
	/\bchange models?\b/i,
	/\bdifferent model\b/i,
	/\buse a (better|stronger|faster|cheaper) model\b/i,
	/\bthis model (is|sucks|can't)\b/i,
];

export function isCorrectionIntent(userText: string): boolean {
	const t = userText.trim();
	if (!t) return false;
	return CORRECTION_PATTERNS.some((re) => re.test(t));
}

export function isExplicitSwitchIntent(userText: string): boolean {
	const t = userText.trim();
	if (!t) return false;
	return EXPLICIT_SWITCH_PATTERNS.some((re) => re.test(t));
}

/**
 * Update consecutive correction streak given the latest user message.
 * Non-correction user messages reset the streak.
 */
export function nextCorrectionStreak(prev: number, userText: string): number {
	return isCorrectionIntent(userText) ? prev + 1 : 0;
}

/**
 * Tool failure streak: same tool name failing repeatedly.
 * Success or different tool resets appropriately.
 */
export function nextToolFailStreak(
	prev: { tool: string | null; streak: number },
	event: { toolName: string; failed: boolean },
): { tool: string | null; streak: number } {
	if (!event.failed) return { tool: null, streak: 0 };
	if (prev.tool === event.toolName) {
		return { tool: event.toolName, streak: prev.streak + 1 };
	}
	return { tool: event.toolName, streak: 1 };
}

/** Volume-only heat — never sole trigger for auto fire. */
export function computeHeat(snap: SessionSignalSnapshot): HeatLevel {
	const reasons: string[] = [];
	let score = 0;

	if (snap.userTurnCount >= 8) {
		score += 15;
		reasons.push(`user turns=${snap.userTurnCount}`);
	} else if (snap.userTurnCount >= 4) {
		score += 8;
		reasons.push(`user turns=${snap.userTurnCount}`);
	}

	if (snap.contextPercent !== null) {
		if (snap.contextPercent >= 85) {
			score += 25;
			reasons.push(`context ${snap.contextPercent.toFixed(0)}%`);
		} else if (snap.contextPercent >= 70) {
			score += 15;
			reasons.push(`context ${snap.contextPercent.toFixed(0)}%`);
		}
	}

	const minutes = snap.sessionDurationMs / 60_000;
	if (minutes >= 45) {
		score += 15;
		reasons.push(`session ${minutes.toFixed(0)}m`);
	} else if (minutes >= 20) {
		score += 8;
		reasons.push(`session ${minutes.toFixed(0)}m`);
	}

	// Negative signals contribute heat too (for judge context) but fire is separate
	if (snap.consecutiveCorrections >= 1) {
		score += 10 * Math.min(snap.consecutiveCorrections, 3);
		reasons.push(`corrections×${snap.consecutiveCorrections}`);
	}
	if (snap.sameToolFailStreak >= 1) {
		score += 10 * Math.min(snap.sameToolFailStreak, 3);
		reasons.push(`tool fails×${snap.sameToolFailStreak}`);
	}
	if (snap.explicitSwitchIntent) {
		score += 30;
		reasons.push("explicit switch intent");
	}

	return { score: Math.min(100, score), reasons };
}

/**
 * Negative set A: fire only on quality problems, not multi-turn volume alone.
 * - consecutive corrections ≥ 2
 * - same tool fail streak ≥ 2
 * - explicit switch / model complaint
 */
export function computeNegativeFire(snap: SessionSignalSnapshot): NegativeFire {
	const reasons: string[] = [];
	if (snap.consecutiveCorrections >= 2) {
		reasons.push(`连续纠正 ${snap.consecutiveCorrections} 次`);
	}
	if (snap.sameToolFailStreak >= 2) {
		reasons.push(
			`工具 ${snap.lastFailedTool ?? "?"} 连续失败 ${snap.sameToolFailStreak} 次`,
		);
	}
	if (snap.explicitSwitchIntent) {
		reasons.push("用户明确要求换模或抱怨当前模型");
	}
	return { shouldFire: reasons.length > 0, reasons };
}
