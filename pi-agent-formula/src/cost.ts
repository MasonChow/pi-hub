/**
 * Coarse switch cost band — interval + explicit cache-miss note.
 * Not accounting-grade; used for decision support only.
 */

export type ModelCostRates = {
	/** USD per million tokens (or any consistent unit). */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type CostBandInput = {
	/** Current prompt-ish tokens still in context (will be re-billed if cache dies). */
	contextTokens: number;
	/** Recent average output tokens per turn (for "continue K turns" estimate). */
	avgOutputTokensPerTurn: number;
	/** Assumed remaining turns after switch for mid/high band. */
	continueTurnsLow?: number;
	continueTurnsMid?: number;
	continueTurnsHigh?: number;
	current: ModelCostRates;
	/** Effective input rate if staying (cache-friendly). Prefer cacheRead when known. */
	currentEffectiveInputRate?: number;
	candidate: ModelCostRates;
};

export type CostBand = {
	/** Human-readable multi-line summary. */
	summary: string;
	/** Whether switch implies losing prompt cache continuity. */
	cacheMiss: true;
	lowUsd: number;
	midUsd: number;
	highUsd: number;
};

function perMillion(tokens: number, ratePerM: number): number {
	return (tokens / 1_000_000) * ratePerM;
}

function fmtUsd(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0";
	if (n < 0.01) return `~$${n.toFixed(4)}`;
	if (n < 1) return `~$${n.toFixed(3)}`;
	return `~$${n.toFixed(2)}`;
}

/**
 * Estimate absolute rough spend on the *switch path* for the next K turns:
 * full re-bill of current context as candidate input (cache miss) + K * output
 * + small follow-on input growth. Not a delta vs stay (delta can invert when
 * candidate is cheaper). Always labels cache miss.
 */
export function estimateSwitchCostBand(input: CostBandInput): CostBand {
	const kLow = input.continueTurnsLow ?? 3;
	const kMid = input.continueTurnsMid ?? 10;
	const kHigh = input.continueTurnsHigh ?? 20;
	const ctx = Math.max(0, input.contextTokens);
	const out = Math.max(0, input.avgOutputTokensPerTurn);

	const switchPrefix = perMillion(ctx, input.candidate.input); // full miss on candidate

	const bandFor = (k: number): number => {
		const switchOut = perMillion(out * k, input.candidate.output);
		const switchInFollow = perMillion(ctx * 0.05 * k, input.candidate.input);
		return Math.max(0, switchPrefix + switchOut + switchInFollow);
	};

	const lowUsd = bandFor(kLow);
	const midUsd = bandFor(kMid);
	const highUsd = bandFor(kHigh);

	const stayHint = perMillion(ctx, input.currentEffectiveInputRate ?? input.current.cacheRead);

	const summary = [
		`切换路径成本粗估（非账单；含 prompt cache 丢失）:`,
		`  低（再跑 ~${kLow} 轮）: ${fmtUsd(lowUsd)}`,
		`  中（再跑 ~${kMid} 轮）: ${fmtUsd(midUsd)}`,
		`  高（再跑 ~${kHigh} 轮）: ${fmtUsd(highUsd)}`,
		`说明: 换模后当前上下文前缀按新模型 full input 重算（约 ${fmtUsd(switchPrefix)} 前缀重计）；` +
			`若留下且 cache 仍命中，同体积前缀有效价约 ${fmtUsd(stayHint)}。`,
	].join("\n");

	return { summary, cacheMiss: true, lowUsd, midUsd, highUsd };
}

export function ratesFromModelCost(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): ModelCostRates {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
	};
}
