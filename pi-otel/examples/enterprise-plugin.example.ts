/**
 * Enterprise plugin skeleton for pi-otel.
 *
 * Copy this into your internal package (e.g. `@yourorg/pi-otel-enterprise`),
 * replace the relative import with `@masonchow/pi-otel`, and pass the plugin
 * through `PiOtelOptions.plugins` when wiring the extension entry.
 *
 * The core stays generic; everything org-specific lives here.
 */
import { execSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	InterventionKind,
	InterventionSignal,
	PiOtelPlugin,
} from "../src/types.ts";

/** Jira-style ticket key, standalone or after a "/" in a branch name. */
const JIRA_KEY_PATTERN = /(?:^|\/)([A-Z][A-Z0-9]+-\d+)/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INTERVENTION_KINDS: readonly InterventionKind[] = [
	"steer",
	"follow_up",
	"interrupt",
	"approval",
	"question",
];

function isInterventionKind(value: unknown): value is InterventionKind {
	return (
		typeof value === "string" &&
		(INTERVENTION_KINDS as readonly string[]).includes(value)
	);
}

function currentBranch(cwd: string): string | undefined {
	try {
		const branch = execSync("git branch --show-current", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return branch === "" ? undefined : branch;
	} catch {
		return undefined;
	}
}

export const enterprisePlugin: PiOtelPlugin = {
	/**
	 * Called once per session, at `session_start`. The result is frozen and
	 * stamped as resource attributes on every metric/span/log of the session.
	 *
	 * Contract: values must be stable for the whole session — no timestamps,
	 * no random values, nothing that changes between calls. Unstable values
	 * fragment aggregation and break the session's identity.
	 */
	resolveAttributes(ctx: ExtensionContext): Record<string, string> {
		const attrs: Record<string, string> = {};

		// Org dimensions, typically provisioned by your dev-machine tooling.
		const team = process.env["MYORG_TEAM"];
		if (team !== undefined) attrs["myorg.team"] = team;
		const user = process.env["MYORG_USER"] ?? process.env["USER"];
		if (user !== undefined) attrs["myorg.user"] = user;

		// Ticket metadata beyond the core's `pi.requirement.id` resolution:
		// e.g. also record the Jira project the branch belongs to.
		// (For plain id resolution you usually don't need this hook at all —
		// the core's /req command, PI_REQUIREMENT_ID, and
		// PI_OTEL_REQUIREMENT_BRANCH_REGEX already cover it.)
		const branch = currentBranch(ctx.cwd);
		const key = branch === undefined ? null : JIRA_KEY_PATTERN.exec(branch);
		if (key?.[1] !== undefined) {
			attrs["myorg.jira.key"] = key[1];
			attrs["myorg.jira.project"] = key[1].split("-", 1)[0] ?? "";
		}

		return attrs;
	},

	/**
	 * Called for every candidate intervention signal: each user input, each
	 * aborted assistant response, the final assistant message when the agent
	 * settles, and each message on the `pi-otel:intervention` event bus
	 * channel. Returning a kind adopts it; returning `null` vetoes the
	 * signal entirely (the built-in classifier is skipped); returning
	 * `undefined` defers to the next plugin and finally the built-in rules.
	 */
	classifyIntervention(
		signal: InterventionSignal,
	): InterventionKind | null | undefined {
		// Consume approval events published by your approval-gate extension:
		//   pi.events.emit("pi-otel:intervention", { kind: "approval", tool: "bash" })
		if (signal.source === "bus" && signal.channel === "pi-otel:intervention") {
			if (isRecord(signal.data) && isInterventionKind(signal.data["kind"])) {
				return signal.data["kind"];
			}
			return null;
		}

		// Example policy override: treat every user input after the first as
		// steering, even ones the built-in classifier would ignore.
		if (signal.source === "input" && signal.inputIndex > 1) {
			return "steer";
		}

		return undefined; // everything else: defer to the built-in rules
	},

	/**
	 * Consulted when computing `pi.cost.usd`, keyed by model id. Only list
	 * models your internal proxy bills differently from pi's public price
	 * table; unlisted models keep pi's own cost. Prices are USD per 1M tokens.
	 */
	costTable: {
		"myorg-proxy/big-model": {
			input: 2.5,
			output: 10,
			cacheRead: 0.25,
			cacheWrite: 3.125,
		},
	},

	/**
	 * Called with the session's resource attributes at `session_start`,
	 * before they are frozen and stamped on every signal. Return the
	 * attributes to actually export — drop or mask whatever your privacy
	 * policy forbids.
	 */
	redact(attrs: Record<string, unknown>): Record<string, unknown> {
		const out = { ...attrs };
		delete out["pi.project.path"]; // e.g. keep local directory layouts private
		return out;
	},
};
