import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	resolveRequirement,
	runReqCommand,
	type ReqCommandIo,
} from "../src/requirement.ts";
import { createSessionState, getRequirementForCwd } from "../src/state.ts";

interface ResolveCase {
	name: string;
	env?: Record<string, string | undefined>;
	stored?: string;
	branch?: string;
	want: string | undefined;
}

const resolveCases: ResolveCase[] = [
	{
		name: "env wins over stored and branch",
		env: { PI_REQUIREMENT_ID: "ENV-1" },
		stored: "ST-2",
		branch: "feature/BR-3-x",
		want: "ENV-1",
	},
	{
		name: "env is trimmed",
		env: { PI_REQUIREMENT_ID: "  ENV-1  " },
		want: "ENV-1",
	},
	{
		name: "blank env is ignored, stored wins",
		env: { PI_REQUIREMENT_ID: "   " },
		stored: "ST-2",
		branch: "feature/BR-3-x",
		want: "ST-2",
	},
	{
		name: "stored wins over branch",
		stored: "ST-2",
		branch: "feature/BR-3-x",
		want: "ST-2",
	},
	{
		name: "empty stored falls through to branch",
		stored: "",
		branch: "feature/BR-3-x",
		want: "BR-3",
	},
	{
		name: "branch: id after slash, trailing words dropped",
		branch: "feature/CC-1234-fix-login",
		want: "CC-1234",
	},
	{ name: "branch: bare ticket id", branch: "CC-1234", want: "CC-1234" },
	{ name: "branch: lowercase id accepted", branch: "fix/abc-12", want: "abc-12" },
	{ name: "branch without ticket id", branch: "main", want: undefined },
	{ name: "no branch (detached HEAD / not a repo)", want: undefined },
	{
		name: "custom regex overrides default (capture group)",
		env: { PI_OTEL_REQUIREMENT_BRANCH_REGEX: "req_(\\d+)" },
		branch: "work/req_42-things",
		want: "42",
	},
	{
		name: "custom regex without group uses full match",
		env: { PI_OTEL_REQUIREMENT_BRANCH_REGEX: "REQ\\d+" },
		branch: "REQ77-stuff",
		want: "REQ77",
	},
	{
		name: "invalid custom regex falls back to default",
		env: { PI_OTEL_REQUIREMENT_BRANCH_REGEX: "((" },
		branch: "feature/CC-9-z",
		want: "CC-9",
	},
];

for (const c of resolveCases) {
	test(`resolveRequirement: ${c.name}`, () => {
		const got = resolveRequirement("/proj", c.stored, {
			env: c.env ?? {},
			readBranch: () => c.branch,
		});
		assert.equal(got, c.want);
	});
}

function fakeIo(cwd: string): ReqCommandIo & {
	messages: { message: string; type: string | undefined }[];
} {
	const messages: { message: string; type: string | undefined }[] = [];
	return {
		cwd,
		messages,
		notify(message, type) {
			messages.push({ message, type });
		},
	};
}

test("runReqCommand: bind / show / clear lifecycle", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-otel-req-"));
	const stateFilePath = join(dir, "state.json");
	const cwd = "/some/project";
	const io = fakeIo(cwd);
	const session = createSessionState({
		requirementId: "OLD-1",
		resourceAttributes: {},
	});
	const options = { stateFilePath, getSessionState: () => session };
	try {
		runReqCommand("CC-1", io, options);
		assert.equal(getRequirementForCwd(cwd, stateFilePath), "CC-1");
		assert.match(io.messages[0]!.message, /"CC-1"/);
		assert.match(io.messages[0]!.message, /"OLD-1"/); // frozen-session caveat

		runReqCommand("", io, options);
		assert.match(io.messages[1]!.message, /bound to "CC-1"/);

		runReqCommand("clear", io, options);
		assert.equal(getRequirementForCwd(cwd, stateFilePath), undefined);

		runReqCommand("clear", io, options); // idempotent: nothing bound
		assert.match(io.messages[3]!.message, /no requirement bound/);
		assert.ok(io.messages.every((m) => m.type === "info"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runReqCommand: rejects multi-word args without writing state", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-otel-req-"));
	const stateFilePath = join(dir, "state.json");
	const io = fakeIo("/some/project");
	try {
		runReqCommand("CC-1 CC-2", io, { stateFilePath });
		assert.equal(getRequirementForCwd("/some/project", stateFilePath), undefined);
		assert.equal(io.messages[0]!.type, "error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
