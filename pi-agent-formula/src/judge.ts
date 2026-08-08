/**
 * Async judge: pack payload, parse response. Caller invokes model complete.
 */

import type { FormulaConfig } from "./config.ts";
import { modelKey } from "./config.ts";
import type { FitAssessment } from "./difficulty.ts";
import type { HeatLevel, SessionSignalSnapshot } from "./signals.ts";
import type { SuggestMode } from "./suggest.ts";

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
	/** Rule-side fit (difficulty + current tire). */
	fit?: FitAssessment | null;
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
	/** quality | economy | match when parseable. */
	mode: SuggestMode | null;
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
		"Decide if the CURRENT model is a poor FIT for the task — either underpowered (upgrade) or overpowered (economy downshift to save quota/cost).",
		"Tires (capability vs burn rate): red=very strong but burns quota/cost fast; yellow=balanced everyday; white=weaker peak but thrifty/durable.",
		"Two goals:",
		"1) QUALITY / MATCH: repeated corrections, tool loops, hard architecture/debug, user wants stronger model → SWITCH yes + stronger TIER.",
		"2) ECONOMY: session is calm, task looks light/simple, current tire is stronger than needed → SWITCH yes + weaker TIER to save cost/quota.",
		"Multi-turn Q&A is NORMAL — do not upgrade only because of many turns.",
		"Do not economy-downshift if the user is still stuck, correcting, or doing hard work.",
		"Reply in EXACTLY this format (no markdown fences):",
		"SWITCH: yes|no",
		"TIER: <red|yellow|white|none>",
		"MODE: <quality|economy|match|none>",
		"REASON: <one short paragraph in the user's language>",
		"If no switch: SWITCH: no, TIER: none, MODE: none.",
		"TIER must be one of the listed tire tags when SWITCH is yes.",
		"MODE=quality for capability pain; MODE=economy for thrift downshift; MODE=match when difficulty exceeds current tire without hard failure yet.",
	].join("\n");

	const tiers = input.tierNames.map((t) => `- ${t}`).join("\n") || "(none)";
	const cur = input.current
		? modelKey(input.current.provider, input.current.model)
		: "(none)";

	const fit = input.fit;
	const fitLines = fit
		? [
				`Rule fit: direction=${fit.direction} currentTire=${fit.currentTire ?? "?"} needTire=${fit.difficulty.recommendedTire} band=${fit.difficulty.band} score=${fit.difficulty.score}`,
				`Rule fit reasons: ${fit.reasons.join(" | ")}`,
			]
		: ["Rule fit: (not provided)"];

	const userParts = [
		`Current model: ${cur}`,
		`Configured tags (pick one as TIER):\n${tiers}`,
		`Signals: turns=${input.snap.userTurnCount} context%=${input.snap.contextPercent ?? "?"} corrections=${input.snap.consecutiveCorrections} toolFailStreak=${input.snap.sameToolFailStreak} explicitSwitch=${input.snap.explicitSwitchIntent}`,
		`Heat: ${input.heat.score} (${input.heat.reasons.join(", ") || "none"})`,
		...fitLines,
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
	const modeMatch = raw.match(/MODE:\s*(\S+)/i);

	const shouldSwitch = switchMatch[1].toLowerCase() === "yes";
	let tier: string | null = null;
	if (tierMatch) {
		const t = tierMatch[1].replace(/[.,;]+$/, "");
		if (t.toLowerCase() !== "none" && validTiers.includes(t)) tier = t;
		// also accept if validTiers has lowercase
		else if (t.toLowerCase() !== "none") {
			const lower = t.toLowerCase();
			if (validTiers.map((x) => x.toLowerCase()).includes(lower)) tier = lower;
		}
	}
	const reason = (reasonMatch ? reasonMatch[1].trim() : raw) || raw;

	let mode: SuggestMode | null = null;
	if (modeMatch) {
		const m = modeMatch[1].replace(/[.,;]+$/, "").toLowerCase();
		if (m === "quality" || m === "economy" || m === "match" || m === "none") {
			mode = m;
		}
	}

	if (shouldSwitch && !tier) {
		// Unusable yes without valid tier → fall back to rules
		return null;
	}
	if (shouldSwitch && !mode) {
		// Infer mode from tier strength vs common defaults later; leave null for caller
		mode = null;
	}
	return { reason, tier, shouldSwitch, mode };
}
