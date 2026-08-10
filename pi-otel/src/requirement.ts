/**
 * Requirement resolution and the /req command.
 *
 * A "requirement" is the work item (ticket, issue, task) a session
 * contributes to; it is reported as the `pi.requirement.id` resource
 * attribute so cost/time/intervention data aggregates across sessions.
 *
 * The id is resolved once at `session_start` and frozen for the session
 * (see SessionState), so `/req` bindings made mid-session only take
 * effect for sessions started afterwards.
 */
import { execSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { guard, recordTelemetryError } from "./otel.ts";
import {
	getRequirementForCwd,
	setRequirementForCwd,
	type SessionState,
} from "./state.ts";

/**
 * Default branch pattern: first ticket-style token, standalone or after a
 * "/" ("feature/CC-1234-fix" and "CC-1234" both yield "CC-1234").
 */
export const DEFAULT_BRANCH_PATTERN = /(?:^|\/)([A-Za-z][A-Za-z0-9]+-\d+)/;

const BRANCH_REGEX_ENV = "PI_OTEL_REQUIREMENT_BRANCH_REGEX";
const REQUIREMENT_ID_ENV = "PI_REQUIREMENT_ID";

export interface ResolveRequirementOptions {
	/** Environment to consult. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Returns the current git branch of `cwd`, or undefined when there is
	 * none. Defaults to running `git branch --show-current`.
	 */
	readBranch?: (cwd: string) => string | undefined;
}

/**
 * Current git branch of `cwd`. Undefined outside a repo, on detached
 * HEAD, or when git itself is unavailable — never throws.
 */
export function readGitBranch(cwd: string): string | undefined {
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

/**
 * The env override is a pattern without flags; an invalid pattern is
 * counted and the default is used instead.
 */
function branchPattern(env: Record<string, string | undefined>): RegExp {
	const custom = env[BRANCH_REGEX_ENV];
	if (custom !== undefined && custom !== "") {
		try {
			return new RegExp(custom);
		} catch (err) {
			recordTelemetryError(err);
		}
	}
	return DEFAULT_BRANCH_PATTERN;
}

/**
 * Resolve the requirement id for a session, by priority:
 *
 * 1. `PI_REQUIREMENT_ID` env var (CI / scripted runs)
 * 2. `stored` — the `/req` binding for `cwd` (pass `getRequirementForCwd(cwd)`)
 * 3. git branch name matched against `PI_OTEL_REQUIREMENT_BRANCH_REGEX`
 *    or {@link DEFAULT_BRANCH_PATTERN} (first capture group, else full match)
 * 4. undefined — the reporter maps this to "unknown"
 */
export function resolveRequirement(
	cwd: string,
	stored: string | undefined,
	options: ResolveRequirementOptions = {},
): string | undefined {
	const env = options.env ?? process.env;
	const readBranch = options.readBranch ?? readGitBranch;

	const fromEnv = env[REQUIREMENT_ID_ENV]?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

	if (stored !== undefined && stored !== "") return stored;

	const branch = readBranch(cwd);
	if (branch === undefined) return undefined;
	const match = branchPattern(env).exec(branch);
	if (match === null) return undefined;
	return match[1] ?? match[0];
}

/** The command's window onto pi — kept minimal so tests can fake it. */
export interface ReqCommandIo {
	cwd: string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ReqCommandOptions {
	/**
	 * Returns the frozen state of the current session, used to show which
	 * requirement is actually being reported right now. A getter (not a
	 * value) because the session is recreated on every `session_start`.
	 */
	getSessionState?: () => SessionState | undefined;
	/** Override the state file location (tests). */
	stateFilePath?: string;
}

function describeSessionRequirement(options: ReqCommandOptions): string {
	if (options.getSessionState === undefined) return "";
	const active = options.getSessionState()?.requirementId;
	return active === undefined
		? "; this session reports none"
		: `; this session keeps reporting "${active}"`;
}

/**
 * `/req` command body:
 * - `/req <id>`  bind `cwd` to a requirement (persisted in state.json)
 * - `/req`       show the binding and the session's frozen value
 * - `/req clear` unbind `cwd`
 *
 * Bindings apply to sessions started afterwards — the running session's
 * requirement was frozen at `session_start`.
 */
export function runReqCommand(
	args: string,
	io: ReqCommandIo,
	options: ReqCommandOptions = {},
): void {
	const arg = args.trim();

	if (arg === "") {
		const bound = getRequirementForCwd(io.cwd, options.stateFilePath);
		const binding =
			bound === undefined
				? "no requirement bound to this directory"
				: `this directory is bound to "${bound}"`;
		io.notify(
			`pi-otel: ${binding}${describeSessionRequirement(options)}. Use /req <id> to bind, /req clear to unbind.`,
			"info",
		);
		return;
	}

	if (arg === "clear") {
		const bound = getRequirementForCwd(io.cwd, options.stateFilePath);
		if (bound === undefined) {
			io.notify("pi-otel: no requirement bound to this directory.", "info");
			return;
		}
		setRequirementForCwd(io.cwd, undefined, options.stateFilePath);
		io.notify(
			`pi-otel: removed the "${bound}" binding. Takes effect for new sessions${describeSessionRequirement(options)}.`,
			"info",
		);
		return;
	}

	if (/\s/.test(arg)) {
		io.notify("pi-otel: usage: /req <id> | /req | /req clear", "error");
		return;
	}

	setRequirementForCwd(io.cwd, arg, options.stateFilePath);
	io.notify(
		`pi-otel: bound this directory to "${arg}". Sessions started here from now on will report it${describeSessionRequirement(options)}.`,
		"info",
	);
}

/** Register the `/req` command. Handler is fail-open via `guard`. */
export function registerReqCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	options: ReqCommandOptions = {},
): void {
	pi.registerCommand("req", {
		description:
			"Bind this directory to a requirement id for pi-otel reporting (/req <id> | /req | /req clear)",
		handler: guard((args: string, ctx: ExtensionCommandContext) => {
			runReqCommand(
				args,
				{
					cwd: ctx.cwd,
					notify: (message, type) => ctx.ui.notify(message, type),
				},
				options,
			);
		}),
	});
}
