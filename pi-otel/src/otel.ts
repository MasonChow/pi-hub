/**
 * OpenTelemetry SDK bootstrap.
 *
 * Endpoint, headers, timeouts, and protocol all come from the standard
 * OTEL_* environment variables consumed by the OTLP exporters — pi-otel
 * adds no configuration surface of its own.
 *
 * Everything here is fail-open: bootstrap errors degrade to no-op
 * instruments, and `guard()` keeps event handlers from ever throwing
 * into pi.
 */
import {
	createNoopMeter,
	ProxyTracerProvider,
	type Attributes,
	type Counter,
	type Meter,
	type Tracer,
} from "@opentelemetry/api";
import { createNoopLogger, type Logger } from "@opentelemetry/api-logs";
import {
	defaultResource,
	resourceFromAttributes,
	type Resource,
} from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
	ATTR_PI_VERSION,
	ATTR_PROJECT_PATH,
	ATTR_SESSION_ID,
	ATTR_SESSION_PARENT_ID,
} from "./attrs.ts";
import type { PiOtelOptions } from "./types.ts";

const SCOPE_NAME = "pi-otel";

export interface OtelHandles {
	meter: Meter;
	tracer: Tracer;
	logger: Logger;
	/** Flush all pending batches. Call from `session_shutdown`. */
	forceFlushAll(): Promise<void>;
	shutdownAll(): Promise<void>;
}

function isTruthyEnv(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

/** True when reporting is switched off (OTEL_SDK_DISABLED / PI_OTEL_DISABLED). */
export function isDisabled(): boolean {
	return (
		isTruthyEnv(process.env["OTEL_SDK_DISABLED"]) ||
		isTruthyEnv(process.env["PI_OTEL_DISABLED"])
	);
}

async function readPiVersion(): Promise<string | undefined> {
	try {
		const { VERSION } = await import("@earendil-works/pi-coding-agent");
		if (typeof VERSION === "string") return VERSION;
	} catch {
		// Host package unavailable (e.g. standalone tests) — omit pi.version.
	}
	return undefined;
}

/**
 * Build the session resource. `service.name` defaults to "pi" and
 * `pi.version` is filled from the host package when resolvable; both can
 * be pre-set through `attrs`.
 */
export async function buildResource(
	attrs: Record<string, string>,
): Promise<Resource> {
	const merged: Record<string, string> = { ...attrs };
	merged["service.name"] ??= "pi";
	if (merged[ATTR_PI_VERSION] === undefined) {
		const version = await readPiVersion();
		if (version !== undefined) merged[ATTR_PI_VERSION] = version;
	}
	return defaultResource().merge(resourceFromAttributes(merged));
}

/**
 * Resource attributes dropped from metrics by default. Backends that
 * promote resource attributes to metric labels explode on per-session ids;
 * the fork parent id has the same per-session shape, and the project path
 * follows because it is per-checkout identity, not a fleet-level dimension.
 * Traces and logs always keep the full set — that is where per-session
 * drill-down (and the fork lineage link) belongs.
 */
const DEFAULT_METRICS_EXCLUDE_ATTRS = [
	ATTR_SESSION_ID,
	ATTR_SESSION_PARENT_ID,
	ATTR_PROJECT_PATH,
];

/**
 * `PI_OTEL_METRICS_EXCLUDE_ATTRS`, comma-separated. Unset falls back to the
 * default list; set to an empty string to keep every attribute on metrics.
 */
function metricsExcludedAttrs(): Set<string> {
	const raw = process.env["PI_OTEL_METRICS_EXCLUDE_ATTRS"];
	const keys =
		raw === undefined
			? DEFAULT_METRICS_EXCLUDE_ATTRS
			: raw.split(",").map((key) => key.trim());
	return new Set(keys.filter((key) => key !== ""));
}

/** The metrics-side view of the session resource (see above). */
export function metricsResource(resource: Resource): Resource {
	const excluded = metricsExcludedAttrs();
	if (excluded.size === 0) return resource;
	const kept: Attributes = {};
	for (const [key, value] of Object.entries(resource.attributes)) {
		if (!excluded.has(key)) kept[key] = value;
	}
	return resourceFromAttributes(kept);
}

function noopHandles(): OtelHandles {
	return {
		meter: createNoopMeter(),
		tracer: new ProxyTracerProvider().getTracer(SCOPE_NAME),
		logger: createNoopLogger(),
		forceFlushAll: () => Promise.resolve(),
		shutdownAll: () => Promise.resolve(),
	};
}

/**
 * Create per-session providers (metrics + traces + logs) exporting over
 * OTLP/HTTP. Providers are kept instance-local — nothing is registered on
 * the OpenTelemetry globals of the host process. Returns no-op instruments
 * when disabled or when bootstrap fails.
 */
export function initOtel(
	resource: Resource,
	options?: PiOtelOptions,
): OtelHandles {
	if (isDisabled()) return noopHandles();
	try {
		const exporters = options?.exporters;
		const meterProvider = new MeterProvider({
			resource: metricsResource(resource),
			readers: [
				new PeriodicExportingMetricReader({
					exporter: exporters?.metrics ?? new OTLPMetricExporter(),
				}),
			],
		});
		const tracerProvider = new BasicTracerProvider({
			resource,
			spanProcessors: [
				new BatchSpanProcessor(exporters?.traces ?? new OTLPTraceExporter()),
			],
		});
		const loggerProvider = new LoggerProvider({
			resource,
			processors: [
				new BatchLogRecordProcessor({
					exporter: exporters?.logs ?? new OTLPLogExporter(),
				}),
			],
		});

		const meter = meterProvider.getMeter(SCOPE_NAME);
		telemetryErrorCounter = meter.createCounter("pi.telemetry.errors", {
			description: "Errors swallowed by the pi-otel fail-open guard",
		});

		const settle = async (tasks: Promise<unknown>[]): Promise<void> => {
			await Promise.allSettled(tasks);
		};
		return {
			meter,
			tracer: tracerProvider.getTracer(SCOPE_NAME),
			logger: loggerProvider.getLogger(SCOPE_NAME),
			forceFlushAll: () =>
				settle([
					meterProvider.forceFlush(),
					tracerProvider.forceFlush(),
					loggerProvider.forceFlush(),
				]),
			shutdownAll: () =>
				settle([
					meterProvider.shutdown(),
					tracerProvider.shutdown(),
					loggerProvider.shutdown(),
				]),
		};
	} catch (err) {
		recordTelemetryError(err);
		return noopHandles();
	}
}

// Health counter, armed by the first successful initOtel(). Before that,
// guard failures are counted nowhere and stay silent by design.
let telemetryErrorCounter: Counter | undefined;

/**
 * Count an internal pi-otel error without ever propagating it.
 * Set PI_OTEL_DEBUG=1 to also log it to stderr.
 */
export function recordTelemetryError(err: unknown): void {
	try {
		telemetryErrorCounter?.add(1);
		if (process.env["PI_OTEL_DEBUG"] === "1") {
			console.warn("[pi-otel]", err);
		}
	} catch {
		// Never let error accounting itself throw.
	}
}

/**
 * Fail-open wrapper for pi event handlers. The wrapped handler never
 * throws and never returns a value (pi-otel handlers must not influence
 * pi behavior).
 */
export function guard<Args extends unknown[]>(
	fn: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
	return async (...args: Args): Promise<void> => {
		try {
			await fn(...args);
		} catch (err) {
			recordTelemetryError(err);
		}
	};
}
