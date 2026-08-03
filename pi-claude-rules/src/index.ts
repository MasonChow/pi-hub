/**
 * claude-rules — 让 pi 以 Claude Code 的策略消费 .claude/rules/
 *
 * 一比一对齐 Claude Code 的 rules 语义（https://code.claude.com/docs/en/memory.md）：
 *
 * - 发现：用户级 ~/.claude/rules/ + 项目级 <project>/.claude/rules/（cwd 逐级向上），
 *   递归扫描所有 .md；目录/文件 symlink 均解析，循环 symlink 检测跳过；realpath 去重
 * - 无 paths frontmatter 的规则：每次 agent 启动无条件注入（挂在 system prompt 上，
 *   天然在 compact 后存活，等价 Claude Code 会话级注入）
 * - 带 paths frontmatter 的规则：agent read 到匹配文件时才注入到该 tool result
 *   （Claude Code 文档只定义 read 触发；paths 支持逗号分隔字符串 / YAML 列表 / 内联数组）
 * - glob：支持 ** / * / ? / {a,b} / [...]；无效括号表达式的模式静默不匹配（对齐 v2.1.207）；
 *   symlink 路径与 realpath 双路径匹配（对齐 v2.1.198）
 * - 顺序：用户级先注入、项目级后注入（项目优先级更高）；同级内字典序（文档未定义，取确定性排序）
 * - 与 pi 内建 contextFiles（AGENTS.md/CLAUDE.md）按 realpath 去重，避免重复注入
 * - /rules 命令查看已加载规则及状态（对齐 /memory 的可见性）
 *
 * 安装：pi install npm:@masonchow/pi-claude-rules
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 纯函数（导出供测试）
// ---------------------------------------------------------------------------

/** 按顶层逗号切分，忽略 {} / [] 内部的逗号（花括号扩展形式的 glob 内含逗号） */
export function splitTopLevelCommas(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += ch + input[i + 1];
			i++;
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 花括号展开："a.{ts,tsx}" → ["a.ts", "a.tsx"]，支持嵌套 */
export function expandBraces(pattern: string): string[] {
	let start = -1;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "{") {
			start = i;
			break;
		}
	}
	if (start === -1) return [pattern];
	let depth = 0;
	let end = -1;
	for (let i = start; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return [pattern]; // 未闭合，按字面处理
	const prefix = pattern.slice(0, start);
	const inner = pattern.slice(start + 1, end);
	const suffix = pattern.slice(end + 1);
	const alts = splitTopLevelCommas(inner);
	if (alts.length === 0) return [pattern];
	return alts.flatMap((alt) => expandBraces(prefix + alt + suffix));
}

function escapeRegExp(ch: string): string {
	return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** 单个（已展开花括号的）glob → 正则源码；无效括号表达式返回 null */
function compileSingle(pattern: string): string | null {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "\\" && i + 1 < pattern.length) {
			out += escapeRegExp(pattern[i + 1]);
			i += 2;
			continue;
		}
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				const prevOk = i === 0 || pattern[i - 1] === "/";
				const next = pattern[i + 2];
				if (prevOk && next === "/") {
					out += "(?:[^/]+/)*"; // '**/' 匹配零个或多个目录层级
					i += 3;
					continue;
				}
				if (prevOk && next === undefined) {
					out += ".*"; // 末尾 '**' 匹配任意深度
					i += 2;
					continue;
				}
				out += "[^/]*"; // 非整段的 '**' 退化为 '*'
				i += 2;
				continue;
			}
			out += "[^/]*";
			i++;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i++;
			continue;
		}
		if (ch === "[") {
			// 括号表达式：找到闭合 ]（首字符可为 ! 取反，紧随其后的 ] 是字面量）
			let j = i + 1;
			let negate = false;
			if (pattern[j] === "!" || pattern[j] === "^") {
				negate = true;
				j++;
			}
			let body = "";
			if (pattern[j] === "]") {
				body += "\\]";
				j++;
			}
			while (j < pattern.length && pattern[j] !== "]") {
				if (pattern[j] === "\\" && j + 1 < pattern.length) {
					body += "\\" + pattern[j + 1];
					j += 2;
					continue;
				}
				body += pattern[j] === "^" ? "\\^" : pattern[j];
				j++;
			}
			if (j >= pattern.length || body.length === 0) {
				return null; // 无法解析为有效括号表达式 → 整个模式不匹配任何内容
			}
			out += `[${negate ? "^" : ""}${body}]`;
			i = j + 1;
			continue;
		}
		out += escapeRegExp(ch);
		i++;
	}
	return out;
}

/** glob → RegExp；无效模式返回 null（调用方按"不匹配任何内容"处理） */
export function compileGlob(pattern: string): RegExp | null {
	let p = pattern.trim();
	if (p.startsWith("./")) p = p.slice(2);
	if (p.length === 0) return null;
	const sources: string[] = [];
	for (const expanded of expandBraces(p)) {
		const src = compileSingle(expanded);
		if (src === null) return null;
		sources.push(src);
	}
	try {
		return new RegExp(`^(?:${sources.join("|")})$`);
	} catch {
		return null;
	}
}

export interface ParsedRule {
	content: string;
	/** null = 无 frontmatter 或无 paths 字段 → 无条件规则 */
	paths: string[] | null;
}

function stripQuotes(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	return t;
}

/** 解析 YAML frontmatter 的 paths 字段；frontmatter 从注入内容中剥离 */
export function parseRuleFile(src: string): ParsedRule {
	if (!/^---[ \t]*\r?\n/.test(src)) return { content: src, paths: null };
	const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(src.slice(3));
	if (!closing) return { content: src, paths: null }; // 未闭合 → 视为无 frontmatter
	const fmEnd = 3 + closing.index;
	const frontmatter = src.slice(3, fmEnd);
	const body = src.slice(fmEnd + closing[0].length).replace(/^\r?\n/, "");
	const lines = frontmatter.split(/\r?\n/);
	let paths: string[] | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = /^paths:\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		const value = m[1].trim();
		if (value.length > 0) {
			// 内联形式：paths: "a, b" / paths: [a, b] / paths: a, b
			let v = stripQuotes(value);
			if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
			paths = splitTopLevelCommas(v).map(stripQuotes).filter((s) => s.length > 0);
		} else {
			// 块列表形式：paths: 换行后跟 "- item"
			const items: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const item = /^\s+-\s+(.+)$/.exec(lines[j]);
				if (!item) break;
				items.push(stripQuotes(item[1]));
			}
			paths = items;
		}
		break;
	}
	return { content: body, paths };
}

/** 递归发现目录下所有 .md（跟随 symlink，realpath 循环检测），返回绝对路径、字典序 */
export function findMarkdownFiles(dir: string, visitedDirs?: Set<string>): string[] {
	const visited = visitedDirs ?? new Set<string>();
	let realDir: string;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		return [];
	}
	if (visited.has(realDir)) return [];
	visited.add(realDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const results: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(full); // statSync 跟随 symlink
		} catch {
			continue; // 悬空 symlink 等，跳过
		}
		if (stat.isDirectory()) {
			results.push(...findMarkdownFiles(full, visited));
		} else if (stat.isFile() && entry.name.endsWith(".md")) {
			results.push(full);
		}
	}
	return results;
}

export interface Rule {
	/** 发现时的路径（用于展示，保留 symlink 原样） */
	file: string;
	/** realpath（用于去重） */
	realPath: string;
	scope: "user" | "project";
	/** paths glob 的匹配基准目录（项目根 / cwd） */
	baseDir: string;
	content: string;
	rawPaths: string[] | null;
	/** null = 无条件；[] = 有 paths 但全部无效 → 不匹配任何内容 */
	patterns: RegExp[] | null;
}

function collectDir(
	rulesDir: string,
	scope: "user" | "project",
	baseDir: string,
	seenReal: Set<string>,
): Rule[] {
	const rules: Rule[] = [];
	for (const file of findMarkdownFiles(rulesDir)) {
		let realPath: string;
		try {
			realPath = fs.realpathSync(file);
		} catch {
			continue;
		}
		if (seenReal.has(realPath)) continue;
		seenReal.add(realPath);
		let src: string;
		try {
			src = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const parsed = parseRuleFile(src);
		rules.push({
			file,
			realPath,
			scope,
			baseDir,
			content: parsed.content,
			rawPaths: parsed.paths,
			patterns:
				parsed.paths === null
					? null
					: parsed.paths.map(compileGlob).filter((r): r is RegExp => r !== null),
		});
	}
	return rules;
}

/** 发现全部规则：用户级 ~/.claude/rules/ 在前，项目级（cwd 逐级向上，外层在前）在后 */
export function discoverRules(cwd: string, home: string): Rule[] {
	const seenReal = new Set<string>();
	const rules: Rule[] = [];
	rules.push(...collectDir(path.join(home, ".claude", "rules"), "user", cwd, seenReal));
	const ancestors: string[] = [];
	let dir = path.resolve(cwd);
	while (true) {
		if (dir !== home) ancestors.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	ancestors.reverse(); // 外层项目先注入，内层（更具体）后注入，优先级更高
	for (const d of ancestors) {
		rules.push(...collectDir(path.join(d, ".claude", "rules"), "project", d, seenReal));
	}
	return rules;
}

/** 一个文件路径是否命中规则的 paths（原路径与 realpath 双路径匹配，对齐 v2.1.198） */
export function ruleMatchesFile(rule: Rule, absFile: string): boolean {
	if (rule.patterns === null || rule.patterns.length === 0) return false;
	const candidates = new Set<string>();
	const rel = path.relative(rule.baseDir, absFile);
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) candidates.add(rel.split(path.sep).join("/"));
	try {
		const realFile = fs.realpathSync(absFile);
		const realBase = fs.realpathSync(rule.baseDir);
		const relReal = path.relative(realBase, realFile);
		if (!relReal.startsWith("..") && !path.isAbsolute(relReal)) {
			candidates.add(relReal.split(path.sep).join("/"));
		}
	} catch {
		// 文件或基准目录无法 realpath 时只用原路径匹配
	}
	for (const candidate of candidates) {
		for (const re of rule.patterns) {
			if (re.test(candidate)) return true;
		}
	}
	return false;
}

const SCOPE_LABEL: Record<Rule["scope"], string> = {
	user: "(user's private global instructions for all projects)",
	project: "(project instructions, checked into the codebase)",
};

export function renderUnconditionalBlock(rules: Rule[]): string {
	const sections = rules.map(
		(r) => `Contents of ${r.file} ${SCOPE_LABEL[r.scope]}:\n\n${r.content.trim()}`,
	);
	return `\n\n# Rules\n\nThe following rules from .claude/rules directories apply to this session. Adhere to them.\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function claudeRules(pi: ExtensionAPI) {
	let rules: Rule[] = [];
	// 已按需注入的 path-scoped 规则（compact 后清空以便重新注入）
	let injected = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		rules = discoverRules(ctx.cwd, os.homedir());
		injected = new Set();
		const unconditional = rules.filter((r) => r.patterns === null).length;
		const scoped = rules.length - unconditional;
		if (rules.length > 0) {
			ctx.ui.notify(
				`claude-rules: ${unconditional} unconditional + ${scoped} path-scoped rule(s) loaded`,
				"info",
			);
		}
	});

	pi.on("session_compact", async () => {
		injected = new Set(); // compact 可能吞掉已注入内容，允许重新触发
	});

	pi.on("before_agent_start", async (event) => {
		// 与 pi 内建 context files（AGENTS.md/CLAUDE.md）按 realpath 去重
		const builtin = new Set<string>();
		for (const f of event.systemPromptOptions?.contextFiles ?? []) {
			try {
				builtin.add(fs.realpathSync(f.path));
			} catch {
				/* ignore */
			}
		}
		const unconditional = rules.filter((r) => r.patterns === null && !builtin.has(r.realPath));
		if (unconditional.length === 0) return;
		return { systemPrompt: event.systemPrompt + renderUnconditionalBlock(unconditional) };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const input = event.input as Record<string, unknown> | undefined;
		const rawPath = (input?.file_path ?? input?.path) as string | undefined;
		if (!rawPath) return;
		const absFile = path.resolve(ctx.cwd, rawPath);
		const matched = rules.filter(
			(r) => r.patterns !== null && !injected.has(r.realPath) && ruleMatchesFile(r, absFile),
		);
		if (matched.length === 0) return;
		for (const r of matched) injected.add(r.realPath);
		const reminder = matched
			.map(
				(r) =>
					`Contents of ${r.file} ${SCOPE_LABEL[r.scope]} — applies to the file you just read:\n\n${r.content.trim()}`,
			)
			.join("\n\n");
		return {
			content: [...event.content, { type: "text" as const, text: `\n<system-reminder>\n${reminder}\n</system-reminder>` }],
		};
	});

	pi.registerCommand("rules", {
		description: "List rules loaded from .claude/rules directories",
		handler: async (_args, ctx) => {
			if (rules.length === 0) {
				ctx.ui.notify("claude-rules: no rules found", "info");
				return;
			}
			const lines = rules.map((r) => {
				const kind =
					r.patterns === null
						? "always"
						: `paths: ${r.rawPaths?.join(", ") ?? ""}${injected.has(r.realPath) ? " [injected]" : ""}`;
				return `[${r.scope}] ${r.file} — ${kind}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
