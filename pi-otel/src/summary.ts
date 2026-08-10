/**
 * Session totals, accumulated in memory and emitted once at
 * `session_shutdown` as the `pi.session.summary` log record.
 *
 * Metrics answer "how much across the fleet"; this record answers "what did
 * this one session cost". Per-session distributions (interventions per
 * session, cost per intervention bucket) and joins against other systems
 * need one row per session — which metrics cannot serve once
 * high-cardinality attributes are kept out of metric labels
 * (`PI_OTEL_METRICS_EXCLUDE_ATTRS`).
 *
 * Session resource attributes are carried by the log pipeline, so this
 * module only produces the totals.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { COST_FIELDS, TOKEN_FIELDS } from "./metrics.ts";
import type { InterventionKind } from "./types.ts";

/** `pi.session.summary` attribute prefixes (log-only keys). */
const ATTR_SUMMARY_DURATION_MS = "pi.summary.duration_ms";
const ATTR_SUMMARY_TURNS = "pi.summary.turns";
const ATTR_SUMMARY_AGENT_BUSY_MS = "pi.summary.agent_busy_ms";
const ATTR_SUMMARY_MODELS = "pi.summary.models";
const ATTR_SUMMARY_INTERVENTIONS_TOTAL = "pi.summary.interventions.total";
const PREFIX_SUMMARY_TOKENS = "pi.summary.tokens.";
const PREFIX_SUMMARY_COST = "pi.summary.cost.";
const PREFIX_SUMMARY_INTERVENTIONS = "pi.summary.interventions.";
const ATTR_SUMMARY_COST_TOTAL = `${PREFIX_SUMMARY_COST}total_usd`;

export type SummaryAttributes = Record<string, string | number>;

export interface SessionSummary {
	/** Fold one assistant (or compaction) `usage` into the session totals. */
	addUsage(usage: Usage, model?: string): void;
	addIntervention(kind: InterventionKind): void;
	addTurn(): void;
	addBusyMs(ms: number): void;
	/** Totals as flat log attributes; zero-valued series are omitted. */
	attributes(endedAt: number): SummaryAttributes;
}

/** Micro-dollar precision: enough for any real session, no float dust. */
function usd(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function bump(counts: Map<string, number>, key: string, delta: number): void {
	if (!Number.isFinite(delta) || delta <= 0) return;
	counts.set(key, (counts.get(key) ?? 0) + delta);
}

export function createSessionSummary(startedAt: number): SessionSummary {
	const tokens = new Map<string, number>();
	const cost = new Map<string, number>();
	const interventions = new Map<string, number>();
	const models = new Set<string>();
	let turns = 0;
	let busyMs = 0;

	return {
		addUsage(usage, model) {
			for (const [type, pick] of TOKEN_FIELDS) bump(tokens, type, pick(usage) ?? 0);
			for (const [type, pick] of COST_FIELDS) bump(cost, type, pick(usage));
			if (model !== undefined && model !== "") models.add(model);
		},
		addIntervention(kind) {
			bump(interventions, kind, 1);
		},
		addTurn() {
			turns += 1;
		},
		addBusyMs(ms) {
			if (Number.isFinite(ms) && ms > 0) busyMs += ms;
		},
		attributes(endedAt) {
			const out: SummaryAttributes = {
				[ATTR_SUMMARY_DURATION_MS]: Math.max(0, endedAt - startedAt),
				[ATTR_SUMMARY_TURNS]: turns,
				[ATTR_SUMMARY_AGENT_BUSY_MS]: busyMs,
			};
			for (const [type, value] of tokens) out[PREFIX_SUMMARY_TOKENS + type] = value;
			let costTotal = 0;
			for (const [type, value] of cost) {
				out[`${PREFIX_SUMMARY_COST + type}_usd`] = usd(value);
				costTotal += value;
			}
			out[ATTR_SUMMARY_COST_TOTAL] = usd(costTotal);
			let interventionTotal = 0;
			for (const [kind, value] of interventions) {
				out[PREFIX_SUMMARY_INTERVENTIONS + kind] = value;
				interventionTotal += value;
			}
			out[ATTR_SUMMARY_INTERVENTIONS_TOTAL] = interventionTotal;
			// Sorted so the same model set always renders the same string.
			if (models.size > 0) {
				out[ATTR_SUMMARY_MODELS] = [...models].sort().join(",");
			}
			return out;
		},
	};
}
