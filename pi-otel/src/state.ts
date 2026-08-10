/**
 * Session-frozen state and the cross-session requirement store.
 *
 * The store lives at ~/.pi/pi-otel/state.json and survives pi restarts:
 * - `byCwd` remembers which requirement a project directory is bound to,
 *   so follow-up sessions in the same directory inherit the binding.
 * - `lastTraceByRequirement` remembers the previous session root span per
 *   requirement, so a new session trace can link back to it.
 *
 * All reads and writes are fail-open: a missing or corrupt file is
 * replaced by an empty store, and write failures are only counted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordTelemetryError } from "./otel.ts";

export interface TraceRef {
	traceId: string;
	spanId: string;
}

export interface PiOtelStateFile {
	/** Requirement id bound to a project directory (absolute cwd). */
	byCwd: Record<string, string>;
	/** Root span of the most recent session trace, per requirement id. */
	lastTraceByRequirement: Record<string, TraceRef>;
}

/**
 * Snapshot frozen at `session_start`. Everything reported during the
 * session reads from this object, never from live resolvers, so a session
 * keeps one stable identity end to end.
 */
export interface SessionState {
	readonly sessionId: string | undefined;
	readonly requirementId: string | undefined;
	readonly resourceAttributes: Readonly<Record<string, string>>;
}

export function createSessionState(init: {
	sessionId?: string;
	requirementId?: string;
	resourceAttributes: Record<string, string>;
}): SessionState {
	return Object.freeze({
		sessionId: init.sessionId,
		requirementId: init.requirementId,
		resourceAttributes: Object.freeze({ ...init.resourceAttributes }),
	});
}

export function defaultStateFilePath(): string {
	return join(homedir(), ".pi", "pi-otel", "state.json");
}

function emptyStateFile(): PiOtelStateFile {
	return { byCwd: {}, lastTraceByRequirement: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTraceRef(value: unknown): value is TraceRef {
	return (
		isRecord(value) &&
		typeof value["traceId"] === "string" &&
		typeof value["spanId"] === "string"
	);
}

/** Keep only structurally valid entries; anything else is dropped. */
function sanitizeStateFile(parsed: unknown): PiOtelStateFile {
	const state = emptyStateFile();
	if (!isRecord(parsed)) return state;
	if (isRecord(parsed["byCwd"])) {
		for (const [cwd, requirementId] of Object.entries(parsed["byCwd"])) {
			if (typeof requirementId === "string") state.byCwd[cwd] = requirementId;
		}
	}
	if (isRecord(parsed["lastTraceByRequirement"])) {
		for (const [requirementId, ref] of Object.entries(
			parsed["lastTraceByRequirement"],
		)) {
			if (isTraceRef(ref)) {
				state.lastTraceByRequirement[requirementId] = {
					traceId: ref.traceId,
					spanId: ref.spanId,
				};
			}
		}
	}
	return state;
}

export function readStateFile(filePath = defaultStateFilePath()): PiOtelStateFile {
	try {
		const raw = readFileSync(filePath, "utf8");
		return sanitizeStateFile(JSON.parse(raw));
	} catch {
		// Missing or corrupt file — start over with an empty store.
		return emptyStateFile();
	}
}

export function writeStateFile(
	state: PiOtelStateFile,
	filePath = defaultStateFilePath(),
): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch (err) {
		recordTelemetryError(err);
	}
}

export function getRequirementForCwd(
	cwd: string,
	filePath = defaultStateFilePath(),
): string | undefined {
	return readStateFile(filePath).byCwd[cwd];
}

/** Bind (or, with undefined, unbind) a requirement for a project directory. */
export function setRequirementForCwd(
	cwd: string,
	requirementId: string | undefined,
	filePath = defaultStateFilePath(),
): void {
	const state = readStateFile(filePath);
	if (requirementId === undefined) {
		delete state.byCwd[cwd];
	} else {
		state.byCwd[cwd] = requirementId;
	}
	writeStateFile(state, filePath);
}

export function getLastTraceForRequirement(
	requirementId: string,
	filePath = defaultStateFilePath(),
): TraceRef | undefined {
	return readStateFile(filePath).lastTraceByRequirement[requirementId];
}

export function setLastTraceForRequirement(
	requirementId: string,
	ref: TraceRef,
	filePath = defaultStateFilePath(),
): void {
	const state = readStateFile(filePath);
	state.lastTraceByRequirement[requirementId] = { ...ref };
	writeStateFile(state, filePath);
}
