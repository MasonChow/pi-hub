/**
 * Suggestion cooldown state machine helpers.
 */

export type CooldownState = {
	/** Until this epoch ms, auto re-fire is suppressed unless policy allows break. */
	until: number;
	/** User dismissed; require stronger signal to break early. */
	dismissed: boolean;
	/** Last fire reason fingerprint. */
	lastReasons: string[];
};

export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_COOLDOWN_TURNS = 5;

export function isInCooldown(
	state: CooldownState | null,
	now: number,
	turnsSinceSuggest: number,
): boolean {
	if (!state) return false;
	if (now < state.until) return true;
	if (turnsSinceSuggest < DEFAULT_COOLDOWN_TURNS) return true;
	return false;
}

export function enterCooldown(now: number, reasons: string[], dismissed: boolean): CooldownState {
	return {
		until: now + DEFAULT_COOLDOWN_MS,
		dismissed,
		lastReasons: reasons,
	};
}
