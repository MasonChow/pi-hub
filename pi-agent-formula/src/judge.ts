/**
 * Async judge: pack payload, parse response. Caller invokes model complete.
 */

import type { FormulaConfig } from "./config.ts";
import { modelKey } from "./config.ts";
import type { HeatLevel, SessionSignalSnapshot } from "./signals.ts";

export type JudgeMessage = {
	role: "user" | "assistant";
	text: string;
};

export type JudgePackInput = {
	config: FormulaConfig;
	current: { provider: string; model: string } | null;
	snap: SessionSignalSnapshot;
	heat: HeatLevel;
	/** All user messages (full). */
	userMessages: string[];
	/** Assistant excerpts already length-capped by caller. */
	assistantExcerpts: string[];
	/** Valid tags from config models (for TIER line). */
	tierNames: string[];
};

export type JudgePack = {
	system: string;
	user: string;
};

export type JudgeVerdict = {
	/** Free-text reason; may start with NO_SWITCH to keep current. */
	reason: string;
	/** Preferred tier name from config, or null. */
	tier: string | null;
	shouldSwitch: boolean;
};

export const DEFAULT_ASSISTANT_EXCERPT_CHARS = 800;
export const JUDGE_TIMEOUT_MS = 25_000;

export function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

export function packJudgePrompt(input: JudgePackInput): JudgePack {
	const system = [
		"You are the race engineer for Agent Formula (F1 pit-wall metaphor).",
		"Decide if the CURRENT model is a poor fit and which TIRE compound to box onto.",
		"Tires (capability vs burn rate): red=very strong but burns quota/cost fast; yellow=balanced everyday; white=weaker peak but thrifty/durable. Models may carry multiple tags.",
		"Multi-turn Q&A skills (long interviews) are NORMAL — do not recommend switch only because of many turns.",
		"Recommend switch mainly for: repeated user corrections, tool failure loops, clear model inadequacy, or user asking to switch.",
		"Reply in EXACTLY this format (no markdown fences):",
		"SWITCH: yes|no",
		"TIER: <red|yellow|white|none>",
		"REASON: <one short paragraph in the user's language>",
		"If no switch: SWITCH: no and TIER: none. You may prefix REASON with NO_SWITCH.",
		"TIER must be one of the listed tire tags when SWITCH is yes.",
	].join("\n");

	const tiers = input.tierNames.map((t) => `- ${t}`).join("\n") || "(none)";
	const cur = input.current
		? modelKey(input.current.provider, input.current.model)
		: "(none)";

	const userParts = [
		`Current model: ${cur}`,
		`Configured tags (pick one as TIER):\n${tiers}`,
		`Signals: turns=${input.snap.userTurnCount} context%=${input.snap.contextPercent ?? "?"} corrections=${input.snap.consecutiveCorrections} toolFailStreak=${input.snap.sameToolFailStreak} explicitSwitch=${input.snap.explicitSwitchIntent}`,
		`Heat: ${input.heat.score} (${input.heat.reasons.join(", ") || "none"})`,
		"",
		"User messages (full):",
		...input.userMessages.map((m, i) => `[U${i + 1}] ${m}`),
		"",
		"Assistant excerpts (capped):",
		...input.assistantExcerpts.map((m, i) => `[A${i + 1}] ${m}`),
	];

	return { system, user: userParts.join("\n") };
}

/**
 * Parse judge free-form text into a verdict. Tolerates minor format drift.
 */
/**
 * Parse judge free-form text. Returns null when the response is not usable
 * (caller should fall back to rules without treating this as an explicit "no").
 */
export function parseJudgeVerdict(text: string, validTiers: string[]): JudgeVerdict | null {
	const raw = text.trim();
	if (!raw) return null;
	const switchMatch = raw.match(/SWITCH:\s*(yes|no)/i);
	if (!switchMatch) return null;

	const tierMatch = raw.match(/TIER:\s*(\S+)/i);
	const reasonMatch = raw.match(/REASON:\s*([\s\S]+)/i);

	const shouldSwitch = switchMatch[1].toLowerCase() === "yes";
	let tier: string | null = null;
	if (tierMatch) {
		const t = tierMatch[1].replace(/[.,;]+$/, "");
		if (t.toLowerCase() !== "none" && validTiers.includes(t)) tier = t;
	}
	const reason = (reasonMatch ? reasonMatch[1].trim() : raw) || raw;

	if (shouldSwitch && !tier) {
		// Unusable yes without valid tier → fall back to rules
		return null;
	}
	return { reason, tier, shouldSwitch };
}
