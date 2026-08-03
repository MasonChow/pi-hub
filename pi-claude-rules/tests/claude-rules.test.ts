/**
 * claude-rules 行为测试 — 对照 Claude Code 官方文档的语义
 * 运行：node --test tests/claude-rules.test.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	compileGlob,
	discoverRules,
	expandBraces,
	findMarkdownFiles,
	parseRuleFile,
	ruleMatchesFile,
	splitTopLevelCommas,
} from "../src/index.ts";

function matches(pattern: string, file: string): boolean {
	const re = compileGlob(pattern);
	return re !== null && re.test(file);
}

test("glob: 官方文档示例", () => {
	// **/*.ts — 任意目录下所有 ts 文件（含根目录）
	assert.ok(matches("**/*.ts", "src/api/handler.ts"));
	assert.ok(matches("**/*.ts", "lib/util.ts"));
	assert.ok(matches("**/*.ts", "a.ts"));
	assert.ok(!matches("**/*.ts", "a.tsx"));
	// src/**/* — src 下所有文件
	assert.ok(matches("src/**/*", "src/api/handler.ts"));
	assert.ok(matches("src/**/*", "src/a.ts"));
	assert.ok(!matches("src/**/*", "lib/a.ts"));
	// *.md — 仅根目录
	assert.ok(matches("*.md", "README.md"));
	assert.ok(!matches("*.md", "docs/README.md"));
	// 特定目录
	assert.ok(matches("src/components/*.tsx", "src/components/Button.tsx"));
	assert.ok(!matches("src/components/*.tsx", "src/components/nested/Button.tsx"));
	// 花括号扩展
	assert.ok(matches("src/**/*.{ts,tsx}", "src/a/b.tsx"));
	assert.ok(matches("src/**/*.{ts,tsx}", "src/b.ts"));
	assert.ok(!matches("src/**/*.{ts,tsx}", "src/b.js"));
});

test("glob: ** 边界与 ? 与字符类", () => {
	assert.ok(matches("src/**", "src/deep/nested/file.ts"));
	assert.ok(matches("a?c.md", "abc.md"));
	assert.ok(!matches("a?c.md", "abbc.md"));
	assert.ok(matches("file[0-9].md", "file1.md"));
	assert.ok(!matches("file[0-9].md", "fileA.md"));
	assert.ok(matches("file[!0-9].md", "fileA.md"));
});

test("glob: 无效括号表达式 → 匹配不到任何内容（v2.1.207）", () => {
	assert.equal(compileGlob("photos [2024/**"), null);
	assert.equal(compileGlob("foo[.md"), null);
});

test("glob: 转义的 [ 按字面匹配", () => {
	assert.ok(matches("photos \\[2024/**", "photos [2024/img.png"));
});

test("splitTopLevelCommas: 花括号内逗号不切分", () => {
	assert.deepEqual(splitTopLevelCommas("src/**/*.{ts,tsx}, docs/**"), [
		"src/**/*.{ts,tsx}",
		"docs/**",
	]);
});

test("expandBraces: 嵌套展开", () => {
	assert.deepEqual(expandBraces("a.{ts,tsx}"), ["a.ts", "a.tsx"]);
	assert.deepEqual(expandBraces("{a,b{1,2}}.md"), ["a.md", "b1.md", "b2.md"]);
	assert.deepEqual(expandBraces("plain.md"), ["plain.md"]);
});

test("frontmatter: 无 frontmatter → 无条件规则", () => {
	const r = parseRuleFile("# title\n\nbody");
	assert.equal(r.paths, null);
	assert.equal(r.content, "# title\n\nbody");
});

test("frontmatter: 逗号分隔字符串形式", () => {
	const r = parseRuleFile('---\npaths: "src/**/*.{ts,tsx}, docs/**"\n---\n\nbody');
	assert.deepEqual(r.paths, ["src/**/*.{ts,tsx}", "docs/**"]);
	assert.equal(r.content, "body");
});

test("frontmatter: 内联数组形式", () => {
	const r = parseRuleFile('---\npaths: ["src/**", \'lib/**\']\n---\nbody');
	assert.deepEqual(r.paths, ["src/**", "lib/**"]);
});

test("frontmatter: YAML 块列表形式", () => {
	const r = parseRuleFile("---\npaths:\n  - src/**\n  - \"lib/**\"\nother: x\n---\nbody");
	assert.deepEqual(r.paths, ["src/**", "lib/**"]);
	assert.equal(r.content, "body");
});

test("frontmatter: 有 frontmatter 但无 paths → 无条件，frontmatter 剥离", () => {
	const r = parseRuleFile("---\ntitle: x\n---\nbody");
	assert.equal(r.paths, null);
	assert.equal(r.content, "body");
});

test("frontmatter: 未闭合 → 整体视为内容", () => {
	const r = parseRuleFile("---\npaths: src/**\nno closing");
	assert.equal(r.paths, null);
	assert.ok(r.content.startsWith("---"));
});

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-rules-test-"));
	return root;
}

test("发现: 递归 .md、忽略其他扩展名、symlink 目录与循环检测", () => {
	const root = makeFixture();
	const rulesDir = path.join(root, ".claude", "rules");
	fs.mkdirSync(path.join(rulesDir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(rulesDir, "a.md"), "A");
	fs.writeFileSync(path.join(rulesDir, "sub", "b.md"), "B");
	fs.writeFileSync(path.join(rulesDir, "ignore.txt"), "x");
	// 外部目录经 symlink 挂进来
	const shared = path.join(root, "shared");
	fs.mkdirSync(shared);
	fs.writeFileSync(path.join(shared, "c.md"), "C");
	fs.symlinkSync(shared, path.join(rulesDir, "linked"));
	// 循环 symlink
	fs.symlinkSync(rulesDir, path.join(shared, "loop"));
	const files = findMarkdownFiles(rulesDir).map((f) => path.basename(f)).sort();
	assert.deepEqual(files, ["a.md", "b.md", "c.md"]);
	fs.rmSync(root, { recursive: true, force: true });
});

test("发现: 用户级在前项目级在后、realpath 去重、paths 编译", () => {
	const root = makeFixture();
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(home, ".claude", "rules"), { recursive: true });
	fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude", "rules", "global.md"), "G");
	fs.writeFileSync(
		path.join(project, ".claude", "rules", "ts.md"),
		"---\npaths: \"**/*.ts\"\n---\nTS rule",
	);
	// 项目里 symlink 回用户级同一文件 → 应去重
	fs.symlinkSync(
		path.join(home, ".claude", "rules", "global.md"),
		path.join(project, ".claude", "rules", "dup.md"),
	);
	const rules = discoverRules(project, home);
	assert.deepEqual(
		rules.map((r) => [path.basename(r.file), r.scope]),
		[
			["global.md", "user"],
			["ts.md", "project"],
		],
	);
	const tsRule = rules[1];
	assert.equal(tsRule.patterns?.length, 1);
	assert.ok(ruleMatchesFile(tsRule, path.join(project, "src", "a.ts")));
	assert.ok(!ruleMatchesFile(tsRule, path.join(project, "src", "a.js")));
	// 项目外的文件不匹配项目规则
	assert.ok(!ruleMatchesFile(tsRule, path.join(root, "elsewhere", "a.ts")));
	fs.rmSync(root, { recursive: true, force: true });
});

test("发现: cwd 在子目录时仍找到外层项目的 .claude/rules", () => {
	const root = makeFixture();
	const project = path.join(root, "proj");
	const sub = path.join(project, "packages", "app");
	fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
	fs.mkdirSync(sub, { recursive: true });
	fs.writeFileSync(path.join(project, ".claude", "rules", "r.md"), "R");
	const rules = discoverRules(sub, path.join(root, "home-not-exist"));
	assert.equal(rules.length, 1);
	assert.equal(rules[0].scope, "project");
	assert.equal(rules[0].baseDir, project);
	fs.rmSync(root, { recursive: true, force: true });
});

test("匹配: 通过 symlink 路径读取也命中（v2.1.198）", () => {
	const root = makeFixture();
	const project = path.join(root, "p");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
	fs.writeFileSync(path.join(project, "src", "real.ts"), "");
	fs.writeFileSync(
		path.join(project, ".claude", "rules", "ts.md"),
		"---\npaths: src/**/*.ts\n---\nrule",
	);
	fs.symlinkSync(path.join(project, "src", "real.ts"), path.join(project, "alias.ts"));
	const rules = discoverRules(project, path.join(root, "no-home"));
	// 经 symlink alias.ts 读取，realpath 落在 src/ 下 → 命中
	assert.ok(ruleMatchesFile(rules[0], path.join(project, "alias.ts")));
	fs.rmSync(root, { recursive: true, force: true });
});
