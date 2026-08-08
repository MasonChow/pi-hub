/**
 * Suggestion cooldown state machine helpers.
 */

export type CooldownKind = "quality" | "economy" | "match" | "generic";

export type CooldownState = {
	/** Until this epoch ms, auto re-fire is suppressed unless policy allows break. */
	until: number;
	/** User dismissed; require stronger signal to break early. */
	dismissed: boolean;
	/** Last fire reason fingerprint. */
	lastReasons: string[];
	/** What kind of suggestion entered cooldown (economy stays quiet longer). */
	kind: CooldownKind;
};

export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_COOLDOWN_TURNS = 5;
/** Economy downshift: less aggressive auto re-prompt. */
export const ECONOMY_COOLDOWN_MS = 45 * 60 * 1000;
export const ECONOMY_COOLDOWN_TURNS = 10;

export function isInCooldown(
	state: CooldownState | null,
	now: number,
	turnsSinceSuggest: number,
): boolean {
	if (!state) return false;
	if (now < state.until) return true;
	const turnFloor =
		state.kind === "economy" ? ECONOMY_COOLDOWN_TURNS : DEFAULT_COOLDOWN_TURNS;
	if (turnsSinceSuggest < turnFloor) return true;
	return false;
}

export function enterCooldown(
	now: number,
	reasons: string[],
	dismissed: boolean,
	kind: CooldownKind = "generic",
): CooldownState {
	const ms = kind === "economy" ? ECONOMY_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
	return {
		until: now + ms,
		dismissed,
		lastReasons: reasons,
		kind,
	};
}
