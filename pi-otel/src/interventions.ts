/**
 * Human-intervention classification.
 *
 * pi has no first-class intervention event, so interventions are inferred
 * from indirect signals (see `InterventionSignal`). The mapping is
 * inherently subjective; the rules here are the built-in fallback behind
 * the `PiOtelPlugin.classifyIntervention` chain.
 */
import { recordTelemetryError } from "./otel.ts";
import type {
	InterventionKind,
	InterventionSignal,
	PiOtelPlugin,
} from "./types.ts";

/**
 * Shared event-bus channel for approval-gate extensions (pi core has no
 * approval events, see research §3.1). Expected payload:
 * `{ kind: InterventionKind }`.
 */
export const INTERVENTION_BUS_CHANNEL = "pi-otel:intervention";

const INTERVENTION_KINDS: readonly string[] = [
	"steer",
	"follow_up",
	"interrupt",
	"approval",
	"question",
];

function isInterventionKind(value: unknown): value is InterventionKind {
	return typeof value === "string" && INTERVENTION_KINDS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Markdown/quote/bracket decoration that may trail the final punctuation. */
const TRAILING_DECORATION = /["'“”*_`~\])}）】」』〉》>\s]+$/u;

/**
 * Simple question heuristic: the last non-empty line, after stripping
 * trailing decoration, ends with a half- or full-width question mark.
 */
export function isQuestionText(text: string): boolean {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const stripped = lines[i].replace(TRAILING_DECORATION, "");
		if (stripped === "") continue;
		return stripped.endsWith("?") || stripped.endsWith("？");
	}
	return false;
}

/**
 * Built-in classification rules (research §3.1 / §3.2 / §7.1):
 *
 * - input: extension-injected input is automation → null; the first input
 *   of a session is the task prompt itself → null; `streamingBehavior`
 *   "steer" → steer, "followUp" → follow_up, undefined (idle follow-up
 *   prompt) → steer.
 * - abort: assistant `stopReason === "aborted"` → interrupt. "error" is a
 *   provider failure (auto-retried, counted by pi.errors) → null.
 * - question: final assistant text at `agent_settled` reads as a question.
 * - bus: `{ kind }` published on INTERVENTION_BUS_CHANNEL is passed
 *   through — the contract for enterprise approval extensions.
 */
export function defaultClassifier(
	signal: InterventionSignal,
): InterventionKind | null {
	switch (signal.source) {
		case "input": {
			if (signal.event.source === "extension") return null;
			if (signal.inputIndex <= 1) return null;
			if (signal.event.streamingBehavior === "followUp") return "follow_up";
			return "steer";
		}
		case "abort":
			return signal.message.stopReason === "aborted" ? "interrupt" : null;
		case "question":
			return isQuestionText(signal.lastAssistantText) ? "question" : null;
		case "bus": {
			if (signal.channel !== INTERVENTION_BUS_CHANNEL) return null;
			if (!isRecord(signal.data)) return null;
			const kind = signal.data["kind"];
			return isInterventionKind(kind) ? kind : null;
		}
	}
}

/**
 * Compose the plugin chain over the built-in rules. Plugins are asked in
 * order: a kind is adopted, `null` vetoes the signal (built-in rules are
 * skipped), no hook / `undefined` passes to the next plugin. A throwing
 * plugin is skipped (fail-open).
 */
export function createInterventionClassifier(
	plugins: readonly PiOtelPlugin[],
): (signal: InterventionSignal) => InterventionKind | null {
	return (signal) => {
		for (const plugin of plugins) {
			let verdict: InterventionKind | null | undefined;
			try {
				verdict = plugin.classifyIntervention?.(signal);
			} catch (err) {
				recordTelemetryError(err);
				continue;
			}
			if (verdict !== undefined) return verdict;
		}
		return defaultClassifier(signal);
	};
}
