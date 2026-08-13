/**
 * Session summary totals: one asserted attribute record per scenario, so
 * the expected `pi.session.summary` payload is readable as-is.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { createSessionSummary } from "../src/summary.ts";

function usage(overrides?: Partial<Usage>): Usage {
	return {
		input: 1000,
		output: 200,
		cacheRead: 300,
		cacheWrite: 50,
		reasoning: 40,
		totalTokens: 1550,
		cost: {
			input: 0.01,
			output: 0.006,
			cacheRead: 0.0009,
			cacheWrite: 0.0005,
			total: 0.0174,
		},
		...overrides,
	};
}

test("summary totals: tokens, cost, interventions, turns, models", () => {
	const summary = createSessionSummary(1_000);
	summary.addUsage(usage(), "claude-sonnet-5");
	summary.addUsage(
		usage({ input: 500, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: undefined }),
		"claude-opus-5",
	);
	summary.addTurn();
	summary.addTurn();
	summary.addIntervention("steer");
	summary.addIntervention("steer");
	summary.addIntervention("question");
	summary.addBusyMs(30_000);
	summary.addBusyMs(18_000);

	assert.deepEqual(summary.attributes(749_000), {
		"pi.summary.duration_ms": 748_000,
		"pi.summary.turns": 2,
		"pi.summary.agent_busy_ms": 48_000,
		"pi.summary.tokens.input": 1500,
		"pi.summary.tokens.output": 220,
		"pi.summary.tokens.cache_read": 300,
		"pi.summary.tokens.cache_write": 50,
		"pi.summary.tokens.reasoning": 40,
		"pi.summary.cost.input_usd": 0.02,
		"pi.summary.cost.output_usd": 0.012,
		"pi.summary.cost.cache_read_usd": 0.0018,
		"pi.summary.cost.cache_write_usd": 0.001,
		"pi.summary.cost.total_usd": 0.0348,
		"pi.summary.interventions.steer": 2,
		"pi.summary.interventions.question": 1,
		"pi.summary.interventions.total": 3,
		// Sorted, so the same model set always renders the same string.
		"pi.summary.models": "claude-opus-5,claude-sonnet-5",
	});
});

test("empty session summary reports zeroed totals, no token series", () => {
	const summary = createSessionSummary(1_000);

	assert.deepEqual(summary.attributes(1_500), {
		"pi.summary.duration_ms": 500,
		"pi.summary.turns": 0,
		"pi.summary.agent_busy_ms": 0,
		"pi.summary.cost.total_usd": 0,
		"pi.summary.interventions.total": 0,
	});
});
