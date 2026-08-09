/**
 * OpenCode Go 订阅额度：官方 API（优先）+ dashboard scrape 回退。
 *
 * 官方 `GET /zen/go/v1/usage` 截至 2026-08 仍未上线（issue #16017 / PR #16513），
 * 实测 404。当前可用数据源是 workspace dashboard HTML（SSR 里嵌了
 * rollingUsage / weeklyUsage / monthlyUsage）。
 *
 * 凭据解析顺序（后者仅在前者缺失时补齐）：
 * 1. ~/.pi/agent/opencode-go-quota.json（workspaceId / authCookie）
 * 2. 环境变量 OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE
 * 3. opencode-quota 的配置文件（若已装）
 * 4. macOS Chrome：History 里扫 workspaceId，Cookies 里解 auth（Keychain）
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GoQuotaWindow {
	usedPercent: number;
	resetsInSeconds?: number;
}

export interface GoQuota {
	rolling?: GoQuotaWindow;
	weekly?: GoQuotaWindow;
	monthly?: GoQuotaWindow;
	useBalance?: boolean;
	/** 数据来源，便于调试 */
	source?: "api" | "dashboard";
}

export interface OpencodeGoQuotaConfig {
	workspaceId?: string;
	authCookie?: string;
}

const OFFICIAL_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DASHBOARD_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function parseWindowFields(obj: unknown): GoQuotaWindow | undefined {
	if (typeof obj !== "object" || obj === null) return undefined;
	const o = obj as Record<string, unknown>;
	const used = Number(o.usagePercent ?? o.usage_percent ?? o.used_percent);
	if (!Number.isFinite(used)) return undefined;
	const reset = Number(o.resetInSec ?? o.reset_in_sec ?? o.reset_after_seconds ?? o.resetsInSeconds);
	return {
		usedPercent: used,
		resetsInSeconds: Number.isFinite(reset) ? reset : undefined,
	};
}

/**
 * 解析官方 /zen/go/v1/usage JSON。兼容 PR #16513 的 rollingUsage 对象形，
 * 以及 PR #32913 的 windows[] 形。
 */
export function parseOpencodeGoUsage(json: unknown): GoQuota | null {
	if (typeof json !== "object" || json === null) return null;
	const root = json as Record<string, unknown>;

	const rolling = parseWindowFields(root.rollingUsage ?? root.rolling_usage ?? root.rolling);
	const weekly = parseWindowFields(root.weeklyUsage ?? root.weekly_usage ?? root.weekly);
	const monthly = parseWindowFields(root.monthlyUsage ?? root.monthly_usage ?? root.monthly);

	// windows: [{ name: "rolling"|"5-hour"|..., usagePercent, resetInSec }, ...]
	if (!rolling && !weekly && !monthly && Array.isArray(root.windows)) {
		const out: GoQuota = { source: "api" };
		for (const item of root.windows) {
			if (typeof item !== "object" || item === null) continue;
			const w = item as Record<string, unknown>;
			const parsed = parseWindowFields(w);
			if (!parsed) continue;
			const name = String(w.name ?? w.id ?? w.window ?? "").toLowerCase();
			if (name.includes("roll") || name.includes("5") || name.includes("hour")) out.rolling = parsed;
			else if (name.includes("week")) out.weekly = parsed;
			else if (name.includes("month")) out.monthly = parsed;
		}
		if (typeof root.useBalance === "boolean") out.useBalance = root.useBalance;
		return out.rolling || out.weekly || out.monthly ? out : null;
	}

	if (!rolling && !weekly && !monthly) return null;
	const q: GoQuota = { rolling, weekly, monthly, source: "api" };
	if (typeof root.useBalance === "boolean") q.useBalance = root.useBalance;
	else if (typeof root.use_balance === "boolean") q.useBalance = root.use_balance;
	return q;
}

function matchSsrWindow(html: string, key: "rolling" | "weekly" | "monthly"): GoQuotaWindow | undefined {
	// 字段顺序不固定：status / resetInSec / usagePercent 任意排列
	const rePctFirst = new RegExp(
		`${key}Usage:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\\}`,
	);
	const reResetFirst = new RegExp(
		`${key}Usage:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\\}`,
	);
	const m1 = rePctFirst.exec(html);
	if (m1) {
		const usedPercent = Number(m1[1]);
		const resetsInSeconds = Number(m1[2]);
		if (Number.isFinite(usedPercent)) {
			return {
				usedPercent,
				resetsInSeconds: Number.isFinite(resetsInSeconds) ? resetsInSeconds : undefined,
			};
		}
	}
	const m2 = reResetFirst.exec(html);
	if (m2) {
		const resetsInSeconds = Number(m2[1]);
		const usedPercent = Number(m2[2]);
		if (Number.isFinite(usedPercent)) {
			return {
				usedPercent,
				resetsInSeconds: Number.isFinite(resetsInSeconds) ? resetsInSeconds : undefined,
			};
		}
	}
	return undefined;
}

function parseHumanReset(text: string): number | null {
	const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
	if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) return 0;
	let total = 0;
	let hit = false;
	const day = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
	const hour = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
	const minute = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
	const second = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
	if (day) {
		total += Number(day[1]) * 86400;
		hit = true;
	}
	if (hour) {
		total += Number(hour[1]) * 3600;
		hit = true;
	}
	if (minute) {
		total += Number(minute[1]) * 60;
		hit = true;
	}
	if (second) {
		total += Number(second[1]);
		hit = true;
	}
	return hit ? total : null;
}

/** data-slot HTML 回退解析（SSR 丢失时） */
function parseDataSlotWindows(html: string): Partial<Record<"rolling" | "weekly" | "monthly", GoQuotaWindow>> {
	const out: Partial<Record<"rolling" | "weekly" | "monthly", GoQuotaWindow>> = {};
	const parts = html.split(/data-slot="usage-item"/);
	for (let i = 1; i < parts.length; i++) {
		const chunk = parts[i];
		const labelMatch = chunk.match(/data-slot="usage-label">([^<]+)</);
		if (!labelMatch) continue;
		const label = labelMatch[1].trim().toLowerCase();
		const usageMatch = chunk.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
		if (!usageMatch) continue;
		const usedPercent = Number(usageMatch[1]);
		const resetMatch = chunk.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/);
		if (!resetMatch) continue;
		const resetContent = resetMatch[2]
			.replace(/<!--\$-->/g, "")
			.replace(/<!--\/-->/g, "")
			.replace(/Resets?\s*in\s*/i, "")
			.trim();
		const resetsInSeconds = resetMatch[1] === "reset-now" ? 0 : parseHumanReset(resetContent);
		if (!Number.isFinite(usedPercent) || resetsInSeconds === null) continue;
		let key: "rolling" | "weekly" | "monthly" | null = null;
		if (label.includes("rolling")) key = "rolling";
		else if (label.includes("weekly")) key = "weekly";
		else if (label.includes("monthly")) key = "monthly";
		if (key) out[key] = { usedPercent, resetsInSeconds };
	}
	return out;
}

/** 从 dashboard HTML 解析三窗口额度 */
export function parseOpencodeGoDashboardHtml(html: string): GoQuota | null {
	let rolling = matchSsrWindow(html, "rolling");
	let weekly = matchSsrWindow(html, "weekly");
	let monthly = matchSsrWindow(html, "monthly");
	if (!rolling && !weekly && !monthly) {
		const slot = parseDataSlotWindows(html);
		rolling = slot.rolling;
		weekly = slot.weekly;
		monthly = slot.monthly;
	}
	if (!rolling && !weekly && !monthly) return null;
	return { rolling, weekly, monthly, source: "dashboard" };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
	} catch {
		/* missing / invalid */
	}
	return null;
}

/** 读显式配置（文件 / 环境 / opencode-quota） */
export function resolveOpencodeGoQuotaConfig(
	agentDir = path.join(os.homedir(), ".pi", "agent"),
	env: NodeJS.ProcessEnv = process.env,
): OpencodeGoQuotaConfig {
	const out: OpencodeGoQuotaConfig = {};

	const filePaths = [
		path.join(agentDir, "opencode-go-quota.json"),
		path.join(os.homedir(), ".config", "opencode", "opencode-quota", "opencode-go.json"),
		path.join(os.homedir(), ".config", "opencode", "opencode-quota", "opencode.json"),
	];
	for (const p of filePaths) {
		const obj = readJsonObject(p);
		if (!obj) continue;
		if (!out.workspaceId && typeof obj.workspaceId === "string") out.workspaceId = obj.workspaceId.trim();
		if (!out.authCookie && typeof obj.authCookie === "string") out.authCookie = obj.authCookie.trim();
		// 兼容 cookie / auth 字段名
		if (!out.authCookie && typeof obj.cookie === "string") out.authCookie = obj.cookie.trim();
		if (!out.authCookie && typeof obj.auth === "string") out.authCookie = obj.auth.trim();
	}

	const envWs = env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const envCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (envWs) out.workspaceId = envWs;
	if (envCookie) out.authCookie = envCookie;

	return out;
}

function chromeUserDataDirs(): string[] {
	if (process.platform !== "darwin") return [];
	const base = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
	const dirs: string[] = [];
	for (const name of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
		const d = path.join(base, name);
		if (fs.existsSync(path.join(d, "Cookies")) || fs.existsSync(path.join(d, "History"))) dirs.push(d);
	}
	return dirs;
}

function withCopiedDb<T>(src: string, fn: (tmp: string) => T): T | null {
	if (!fs.existsSync(src)) return null;
	const tmp = path.join(os.tmpdir(), `pi-hud-chrome-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	try {
		fs.copyFileSync(src, tmp);
		return fn(tmp);
	} catch {
		return null;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
}

function pythonSqliteB64(dbPath: string, sql: string): string | null {
	try {
		const script = `
import sqlite3, base64, sys
con = sqlite3.connect(${JSON.stringify(dbPath)})
row = con.execute(${JSON.stringify(sql)}).fetchone()
con.close()
if not row or row[0] is None:
    sys.exit(2)
val = row[0]
if isinstance(val, bytes):
    sys.stdout.write(base64.b64encode(val).decode())
else:
    sys.stdout.write(str(val))
`;
		return execFileSync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function pythonSqliteTextRows(dbPath: string, sql: string): string[] {
	try {
		const script = `
import sqlite3, sys
con = sqlite3.connect(${JSON.stringify(dbPath)})
rows = con.execute(${JSON.stringify(sql)}).fetchall()
con.close()
for r in rows:
    if r and r[0] is not None:
        print(r[0])
`;
		const out = execFileSync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** 从 Chrome History 提取最近访问的 opencode workspace id */
export function discoverOpencodeWorkspaceIdFromChrome(): string | undefined {
	for (const dir of chromeUserDataDirs()) {
		const hist = path.join(dir, "History");
		const urls = withCopiedDb(hist, (tmp) =>
			pythonSqliteTextRows(
				tmp,
				"SELECT url FROM urls WHERE url LIKE '%opencode.ai/workspace/%' ORDER BY last_visit_time DESC LIMIT 30",
			),
		);
		if (!urls) continue;
		for (const url of urls) {
			const m = url.match(/opencode\.ai\/workspace\/(wrk_[A-Za-z0-9]+)/);
			if (m) return m[1];
		}
	}
	return undefined;
}

function chromeSafeStoragePassword(): string | null {
	if (process.platform !== "darwin") return null;
	try {
		return execFileSync(
			"security",
			["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
			{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		return null;
	}
}

/** 解密 macOS Chrome Cookie 库中的 opencode.ai auth */
export function readChromeOpencodeAuthCookie(): string | undefined {
	const password = chromeSafeStoragePassword();
	if (!password) return undefined;
	const key = crypto.pbkdf2Sync(Buffer.from(password), Buffer.from("saltysalt"), 1003, 16, "sha1");
	const iv = Buffer.alloc(16, 0x20); // 16 spaces

	for (const dir of chromeUserDataDirs()) {
		const cookiesPath = path.join(dir, "Cookies");
		const b64 = withCopiedDb(cookiesPath, (tmp) =>
			pythonSqliteB64(
				tmp,
				"SELECT encrypted_value FROM cookies WHERE host_key = 'opencode.ai' AND name = 'auth' LIMIT 1",
			),
		);
		if (!b64) continue;
		try {
			const enc = Buffer.from(b64, "base64");
			if (enc.length < 4) continue;
			const prefix = enc.subarray(0, 3).toString("utf8");
			if (prefix !== "v10" && prefix !== "v11") continue;
			const data = enc.subarray(3);
			const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
			const out = Buffer.concat([decipher.update(data), decipher.final()]);
			// Chrome 在 cookie 明文前塞 32 字节完整性前缀
			const plain = out.length > 32 ? out.subarray(32).toString("utf8") : out.toString("utf8");
			const idx = plain.indexOf("Fe26");
			const cookie = (idx >= 0 ? plain.slice(idx) : plain).trim();
			if (cookie.length > 20) return cookie;
		} catch {
			/* 该 profile 解不开就试下一个 */
		}
	}
	return undefined;
}

/** 合并显式配置 + Chrome 自动发现 */
export function resolveOpencodeGoCredentials(
	agentDir = path.join(os.homedir(), ".pi", "agent"),
	env: NodeJS.ProcessEnv = process.env,
): OpencodeGoQuotaConfig {
	const cfg = resolveOpencodeGoQuotaConfig(agentDir, env);
	if (!cfg.workspaceId) cfg.workspaceId = discoverOpencodeWorkspaceIdFromChrome();
	if (!cfg.authCookie) cfg.authCookie = readChromeOpencodeAuthCookie();
	return cfg;
}

export async function fetchOpencodeGoUsageOfficial(apiKey: string, timeoutMs = 5000): Promise<GoQuota | null> {
	const res = await fetch(OFFICIAL_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": "pi-hud/opencode-go",
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) return null;
	const ct = res.headers.get("content-type") ?? "";
	if (!ct.includes("json")) return null;
	const json: unknown = await res.json();
	const q = parseOpencodeGoUsage(json);
	if (q) q.source = "api";
	return q;
}

export async function fetchOpencodeGoUsageDashboard(
	workspaceId: string,
	authCookie: string,
	timeoutMs = 10000,
): Promise<GoQuota | null> {
	// cookie 值可能已带 auth= 前缀
	const cookieHeader = authCookie.startsWith("auth=") ? authCookie : `auth=${authCookie}`;
	const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
	const res = await fetch(url, {
		headers: {
			Cookie: cookieHeader,
			Accept: "text/html",
			"User-Agent": DASHBOARD_UA,
		},
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
	});
	if (!res.ok) return null;
	const html = await res.text();
	return parseOpencodeGoDashboardHtml(html);
}

/**
 * 查 OpenCode Go 额度：官方 API → dashboard scrape。
 * 都失败返回 null（调用方标记 ✗）。
 */
export async function fetchOpencodeGoQuota(opts: {
	apiKey?: string;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<GoQuota | null> {
	if (opts.apiKey) {
		try {
			const official = await fetchOpencodeGoUsageOfficial(opts.apiKey);
			if (official) return official;
		} catch {
			/* 404 / 网络 → 回退 scrape */
		}
	}

	const creds = resolveOpencodeGoCredentials(opts.agentDir, opts.env);
	if (!creds.workspaceId || !creds.authCookie) return null;
	try {
		return await fetchOpencodeGoUsageDashboard(creds.workspaceId, creds.authCookie);
	} catch {
		return null;
	}
}

/** 渲染用：按稳定顺序产出标签 + 窗口 */
export function goQuotaWindowEntries(q: GoQuota): Array<{ label: string; window: GoQuotaWindow }> {
	const entries: Array<{ label: string; window: GoQuotaWindow }> = [];
	if (q.rolling) entries.push({ label: "5h", window: q.rolling });
	if (q.weekly) entries.push({ label: "周", window: q.weekly });
	if (q.monthly) entries.push({ label: "月", window: q.monthly });
	return entries;
}
