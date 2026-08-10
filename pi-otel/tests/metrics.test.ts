import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attributes } from "@opentelemetry/api";
import {
	AggregationTemporality,
	DataPointType,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type DataPoint,
	type Histogram,
	type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { Usage } from "@earendil-works/pi-ai";
import {
	ATTR_COMPACTION_TOKENS_BEFORE,
	ATTR_ERROR_SCOPE,
	createMetrics,
	mergeAttrs,
	METRIC_COMPACTION,
	METRIC_CONTEXT_TOKENS,
	METRIC_CONTEXT_USAGE_RATIO,
	METRIC_COST_USD,
	METRIC_ERRORS,
	METRIC_TOKENS,
	METRIC_TOOL_DURATION,
	type PiMetrics,
} from "../src/metrics.ts";
import {
	ATTR_COMPACTION_REASON,
	ATTR_ERROR_TYPE,
	ATTR_TOKEN_TYPE,
	ATTR_TOOL_IS_ERROR,
	ATTR_TOOL_NAME,
} from "../src/attrs.ts";

interface Harness {
	metrics: PiMetrics;
	collect(): Promise<ResourceMetrics>;
	shutdown(): Promise<void>;
}

function setup(): Harness {
	const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: 3_600_000,
	});
	const provider = new MeterProvider({ readers: [reader] });
	return {
		metrics: createMetrics(provider.getMeter("pi-otel-test")),
		async collect() {
			await reader.forceFlush();
			const batches = exporter.getMetrics();
			const last = batches[batches.length - 1];
			assert.ok(last, "expected at least one exported batch");
			return last;
		},
		shutdown: () => provider.shutdown(),
	};
}

function numberPoints(
	rm: ResourceMetrics,
	name: string,
): ReadonlyArray<DataPoint<number>> {
	for (const scope of rm.scopeMetrics) {
		const metric = scope.metrics.find((m) => m.descriptor.name === name);
		if (!metric) continue;
		if (
			metric.dataPointType === DataPointType.SUM ||
			metric.dataPointType === DataPointType.GAUGE
		) {
			return metric.dataPoints;
		}
	}
	return [];
}

function histogramPoints(
	rm: ResourceMetrics,
	name: string,
): ReadonlyArray<DataPoint<Histogram>> {
	for (const scope of rm.scopeMetrics) {
		const metric = scope.metrics.find((m) => m.descriptor.name === name);
		if (metric?.dataPointType === DataPointType.HISTOGRAM) {
			return metric.dataPoints;
		}
	}
	return [];
}

function pointValue(
	points: ReadonlyArray<DataPoint<number>>,
	match: Attributes,
): number | undefined {
	const found = points.find((p) =>
		Object.entries(match).every(([key, value]) => p.attributes[key] === value),
	);
	return found?.value;
}

function makeUsage(overrides?: Partial<Usage>): Usage {
	return {
		input: 100,
		output: 40,
		cacheRead: 500,
		cacheWrite: 60,
		cacheWrite1h: 10,
		reasoning: 15,
		totalTokens: 700,
		cost: {
			input: 0.001,
			output: 0.002,
			cacheRead: 0.0005,
			cacheWrite: 0.0003,
			total: 0.0038,
		},
		...overrides,
	};
}

test("recordUsage records each token type without folding subsets", async () => {
	const { metrics, collect, shutdown } = setup();
	metrics.recordUsage(makeUsage(), { model: "m1" });
	const rm = await collect();
	const points = numberPoints(rm, METRIC_TOKENS);

	const expected: ReadonlyArray<readonly [string, number]> = [
		["input", 100],
		["output", 40],
		["cache_read", 500],
		["cache_write", 60],
		["cache_write_1h", 10],
		["reasoning", 15],
	];
	for (const [type, value] of expected) {
		assert.equal(
			pointValue(points, { [ATTR_TOKEN_TYPE]: type }),
			value,
			`pi.tokens{type=${type}}`,
		);
	}
	// reasoning stays its own series; output is reported as-is (40, not 55).
	assert.equal(pointValue(points, { [ATTR_TOKEN_TYPE]: "output" }), 40);
	assert.equal(pointValue(points, { model: "m1", [ATTR_TOKEN_TYPE]: "input" }), 100);
	await shutdown();
});

test("recordUsage skips zero and undefined fields", async () => {
	const { metrics, collect, shutdown } = setup();
	metrics.recordUsage(
		makeUsage({
			cacheRead: 0,
			cacheWrite: 0,
			cacheWrite1h: undefined,
			reasoning: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}),
	);
	const rm = await collect();
	const tokenPoints = numberPoints(rm, METRIC_TOKENS);

	for (const type of ["cache_read", "cache_write", "cache_write_1h", "reasoning"]) {
		assert.equal(
			pointValue(tokenPoints, { [ATTR_TOKEN_TYPE]: type }),
			undefined,
			`pi.tokens{type=${type}} must be absent`,
		);
	}
	assert.equal(numberPoints(rm, METRIC_COST_USD).length, 0);
	await shutdown();
});

test("cost accumulates across recordUsage calls and sums to total", async () => {
	const { metrics, collect, shutdown } = setup();
	metrics.recordUsage(makeUsage());
	metrics.recordUsage(makeUsage());
	const rm = await collect();
	const points = numberPoints(rm, METRIC_COST_USD);

	const expected: ReadonlyArray<readonly [string, number]> = [
		["input", 0.002],
		["output", 0.004],
		["cache_read", 0.001],
		["cache_write", 0.0006],
	];
	let sum = 0;
	for (const [type, value] of expected) {
		const got = pointValue(points, { [ATTR_TOKEN_TYPE]: type });
		assert.ok(got !== undefined && Math.abs(got - value) < 1e-12, `pi.cost.usd{type=${type}}`);
		sum += got;
	}
	assert.ok(Math.abs(sum - 2 * 0.0038) < 1e-12, "component sum equals 2 × cost.total");
	await shutdown();
});

test("mergeAttrs drops invalid values and lets later parts win", () => {
	const cases: ReadonlyArray<{
		name: string;
		parts: ReadonlyArray<Record<string, unknown> | undefined>;
		expected: Attributes;
	}> = [
		{
			name: "drops undefined and null values",
			parts: [{ a: "x", b: undefined, c: null }],
			expected: { a: "x" },
		},
		{
			name: "drops objects, arrays, and NaN",
			parts: [{ o: { nested: 1 }, arr: [1], nan: Number.NaN, ok: 1, flag: false }],
			expected: { ok: 1, flag: false },
		},
		{
			name: "later parts override earlier",
			parts: [{ a: 1, b: "keep" }, { a: 2 }],
			expected: { a: 2, b: "keep" },
		},
		{
			name: "undefined parts are skipped",
			parts: [undefined, { a: "y" }, undefined],
			expected: { a: "y" },
		},
	];
	for (const c of cases) {
		assert.deepEqual(mergeAttrs(...c.parts), c.expected, c.name);
	}
});

test("context gauges report the latest sample only", async () => {
	const { metrics, collect, shutdown } = setup();

	// Anchor the batch with another metric: an all-empty collection is not
	// exported at all, and gauges must stay absent until the first sample.
	metrics.recordTurn();
	const before = await collect();
	assert.equal(numberPoints(before, METRIC_CONTEXT_TOKENS).length, 0);

	metrics.recordContextSample({ tokens: 12_000, usageRatio: 0.15 }, { s: "a" });
	metrics.recordContextSample({ tokens: 15_000, usageRatio: 0.2 }, { s: "a" });
	const rm = await collect();
	assert.equal(
		pointValue(numberPoints(rm, METRIC_CONTEXT_TOKENS), { s: "a" }),
		15_000,
	);
	assert.equal(
		pointValue(numberPoints(rm, METRIC_CONTEXT_USAGE_RATIO), { s: "a" }),
		0.2,
	);
	await shutdown();
});

test("recordCompaction counts and folds compaction usage into tokens", async () => {
	const { metrics, collect, shutdown } = setup();
	metrics.recordCompaction(
		{ tokensBefore: 84_000, reason: "auto", usage: makeUsage() },
		{ model: "m1" },
	);
	const rm = await collect();

	assert.equal(
		pointValue(numberPoints(rm, METRIC_COMPACTION), {
			[ATTR_COMPACTION_TOKENS_BEFORE]: 84_000,
			[ATTR_COMPACTION_REASON]: "auto",
		}),
		1,
	);
	assert.equal(
		pointValue(numberPoints(rm, METRIC_TOKENS), {
			model: "m1",
			[ATTR_TOKEN_TYPE]: "input",
		}),
		100,
	);
	await shutdown();
});

test("tool duration and errors carry their dimensions; invalid durations are skipped", async () => {
	const { metrics, collect, shutdown } = setup();
	metrics.recordToolDuration(42, { toolName: "bash", isError: false });
	metrics.recordToolDuration(Number.NaN, { toolName: "bash", isError: false });
	metrics.recordToolDuration(-5, { toolName: "bash", isError: false });
	metrics.recordError("llm", "overloaded_error");
	const rm = await collect();

	const tool = histogramPoints(rm, METRIC_TOOL_DURATION).find(
		(p) =>
			p.attributes[ATTR_TOOL_NAME] === "bash" &&
			p.attributes[ATTR_TOOL_IS_ERROR] === false,
	);
	assert.ok(tool, "tool duration point");
	assert.equal(tool.value.count, 1);
	assert.equal(tool.value.sum, 42);

	assert.equal(
		pointValue(numberPoints(rm, METRIC_ERRORS), {
			[ATTR_ERROR_SCOPE]: "llm",
			[ATTR_ERROR_TYPE]: "overloaded_error",
		}),
		1,
	);
	await shutdown();
});
