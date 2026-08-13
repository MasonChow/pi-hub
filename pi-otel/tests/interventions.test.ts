import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import {
	INTERVENTION_BUS_CHANNEL,
	createInterventionClassifier,
	defaultClassifier,
} from "../src/interventions.ts";
import type {
	InterventionKind,
	InterventionSignal,
	PiOtelPlugin,
} from "../src/types.ts";

function inputSignal(init: {
	source?: InputEvent["source"];
	streamingBehavior?: InputEvent["streamingBehavior"];
	inputIndex?: number;
}): InterventionSignal {
	const event: InputEvent = {
		type: "input",
		text: "do the thing",
		source: init.source ?? "interactive",
	};
	if (init.streamingBehavior !== undefined) {
		event.streamingBehavior = init.streamingBehavior;
	}
	return { source: "input", event, inputIndex: init.inputIndex ?? 2 };
}

function abortSignal(
	stopReason: AssistantMessage["stopReason"],
): InterventionSignal {
	return {
		source: "abort",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 0,
		},
	};
}

function questionSignal(lastAssistantText: string): InterventionSignal {
	return { source: "question", lastAssistantText };
}

function busSignal(channel: string, data: unknown): InterventionSignal {
	return { source: "bus", channel, data };
}

const defaultCases: {
	name: string;
	signal: InterventionSignal;
	expected: InterventionKind | null;
}[] = [
	// input
	{
		name: "input: extension-injected is never an intervention",
		signal: inputSignal({ source: "extension", streamingBehavior: "steer" }),
		expected: null,
	},
	{
		name: "input: first user input is the task prompt",
		signal: inputSignal({ inputIndex: 1 }),
		expected: null,
	},
	{
		name: "input: streamingBehavior steer",
		signal: inputSignal({ streamingBehavior: "steer" }),
		expected: "steer",
	},
	{
		name: "input: streamingBehavior followUp",
		signal: inputSignal({ streamingBehavior: "followUp" }),
		expected: "follow_up",
	},
	{
		name: "input: idle follow-up prompt (no streamingBehavior) counts as steer",
		signal: inputSignal({ inputIndex: 3 }),
		expected: "steer",
	},
	{
		name: "input: rpc source is classified like interactive",
		signal: inputSignal({ source: "rpc", streamingBehavior: "followUp" }),
		expected: "follow_up",
	},
	// abort
	{
		name: "abort: stopReason aborted is an interrupt",
		signal: abortSignal("aborted"),
		expected: "interrupt",
	},
	{
		name: "abort: stopReason error is a provider failure, not an intervention",
		signal: abortSignal("error"),
		expected: null,
	},
	// question
	{
		name: "question: trailing half-width question mark",
		signal: questionSignal("Should I proceed with the migration?"),
		expected: "question",
	},
	{
		name: "question: trailing full-width question mark",
		signal: questionSignal("需要我继续吗？"),
		expected: "question",
	},
	{
		name: "question: question mark behind markdown decoration",
		signal: questionSignal("All done. **Deploy to production now?**"),
		expected: "question",
	},
	{
		name: "question: last non-empty line decides on multiline text",
		signal: questionSignal("Summary of changes.\nWhich option do you prefer?\n\n"),
		expected: "question",
	},
	{
		name: "question: statement is not a question",
		signal: questionSignal("All tests pass. The task is complete."),
		expected: null,
	},
	{
		name: "question: question mark only mid-text does not count",
		signal: questionSignal("Fixed the bug (why? see commit). Done."),
		expected: null,
	},
	{
		name: "question: empty text",
		signal: questionSignal(""),
		expected: null,
	},
	// bus
	{
		name: "bus: approval kind on the agreed channel is passed through",
		signal: busSignal(INTERVENTION_BUS_CHANNEL, { kind: "approval" }),
		expected: "approval",
	},
	{
		name: "bus: any valid kind is passed through",
		signal: busSignal(INTERVENTION_BUS_CHANNEL, { kind: "interrupt" }),
		expected: "interrupt",
	},
	{
		name: "bus: other channels are ignored",
		signal: busSignal("some-other:channel", { kind: "approval" }),
		expected: null,
	},
	{
		name: "bus: unknown kind is dropped",
		signal: busSignal(INTERVENTION_BUS_CHANNEL, { kind: "escalation" }),
		expected: null,
	},
	{
		name: "bus: non-object payload is dropped",
		signal: busSignal(INTERVENTION_BUS_CHANNEL, "approval"),
		expected: null,
	},
	{
		name: "bus: null payload is dropped",
		signal: busSignal(INTERVENTION_BUS_CHANNEL, null),
		expected: null,
	},
];

for (const c of defaultCases) {
	test(`defaultClassifier: ${c.name}`, () => {
		assert.equal(defaultClassifier(c.signal), c.expected);
	});
}

// --- plugin chain ---

// A signal the default classifier resolves to "question", so plugin
// short-circuits are distinguishable from the fallback.
const questionable = questionSignal("Continue?");

const adopt = (kind: InterventionKind): PiOtelPlugin => ({
	classifyIntervention: () => kind,
});
const veto: PiOtelPlugin = { classifyIntervention: () => null };
const abstain: PiOtelPlugin = { classifyIntervention: () => undefined };
const noHook: PiOtelPlugin = {};
const throwing: PiOtelPlugin = {
	classifyIntervention: () => {
		throw new Error("plugin boom");
	},
};

const chainCases: {
	name: string;
	plugins: PiOtelPlugin[];
	signal: InterventionSignal;
	expected: InterventionKind | null;
}[] = [
	{
		name: "no plugins falls back to the default classifier",
		plugins: [],
		signal: questionable,
		expected: "question",
	},
	{
		name: "plugin kind is adopted over the default",
		plugins: [adopt("approval")],
		signal: questionable,
		expected: "approval",
	},
	{
		name: "plugin null vetoes: default classifier is not consulted",
		plugins: [veto],
		signal: questionable,
		expected: null,
	},
	{
		name: "first non-undefined verdict wins over later plugins",
		plugins: [adopt("steer"), adopt("approval")],
		signal: questionable,
		expected: "steer",
	},
	{
		name: "veto short-circuits later plugins",
		plugins: [veto, adopt("approval")],
		signal: questionable,
		expected: null,
	},
	{
		name: "plugin without the hook is skipped",
		plugins: [noHook, adopt("follow_up")],
		signal: questionable,
		expected: "follow_up",
	},
	{
		name: "plugin undefined abstains: later plugins still run",
		plugins: [abstain, adopt("approval")],
		signal: questionable,
		expected: "approval",
	},
	{
		name: "only abstaining plugins fall through to the default",
		plugins: [abstain],
		signal: questionable,
		expected: "question",
	},
	{
		name: "only hookless plugins falls through to the default",
		plugins: [noHook, noHook],
		signal: questionable,
		expected: "question",
	},
	{
		name: "throwing plugin is skipped, chain continues (fail-open)",
		plugins: [throwing, adopt("interrupt")],
		signal: questionable,
		expected: "interrupt",
	},
	{
		name: "throwing plugin alone falls through to the default",
		plugins: [throwing],
		signal: questionable,
		expected: "question",
	},
];

for (const c of chainCases) {
	test(`createInterventionClassifier: ${c.name}`, () => {
		const classify = createInterventionClassifier(c.plugins);
		assert.equal(classify(c.signal), c.expected);
	});
}

test("createInterventionClassifier: plugins are asked in order", () => {
	const order: string[] = [];
	const spy = (name: string, verdict: InterventionKind | null): PiOtelPlugin => ({
		classifyIntervention: () => {
			order.push(name);
			return verdict;
		},
	});
	const classify = createInterventionClassifier([
		spy("first", null),
		spy("second", "approval"),
	]);
	assert.equal(classify(questionable), null);
	assert.deepEqual(order, ["first"]);
});
