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
 *
 * Chrome 发现路径全部异步（execFile / Keychain），避免卡死 pi 主线程。
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export type GoWindowKey = "rolling" | "weekly" | "monthly";

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
 * 将 windows[] 项的 name/id 映射到三窗口之一。
 * 先匹配 week/month，再 match rolling；避免 name 含 "5"/"hour" 时误伤 weekly。
 */
export function classifyGoWindowName(name: string): GoWindowKey | null {
	const n = name.toLowerCase().trim();
	if (!n) return null;
	if (n.includes("week")) return "weekly";
	if (n.includes("month")) return "monthly";
	if (n.includes("roll") || n.includes("5h") || n.includes("5-hour") || n.includes("5 hour") || n === "primary") {
		return "rolling";
	}
	// 仅当明确是 hour 窗口且不是其它周期时
	if (/\bhour/.test(n) && !n.includes("week") && !n.includes("month")) return "rolling";
	return null;
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
			const key = classifyGoWindowName(String(w.name ?? w.id ?? w.window ?? ""));
			if (key === "rolling") out.rolling = parsed;
			else if (key === "weekly") out.weekly = parsed;
			else if (key === "monthly") out.monthly = parsed;
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

function matchSsrWindow(html: string, key: GoWindowKey): GoQuotaWindow | undefined {
	// 字段顺序不固定：status / resetInSec / usagePercent 任意排列；允许冒号后空白
	const rePctFirst = new RegExp(
		`${key}Usage:\\s*\\$R\\[\\d+\\]\\s*=\\s*\\{[^}]*usagePercent:\\s*${NUM}[^}]*resetInSec:\\s*${NUM}[^}]*\\}`,
	);
	const reResetFirst = new RegExp(
		`${key}Usage:\\s*\\$R\\[\\d+\\]\\s*=\\s*\\{[^}]*resetInSec:\\s*${NUM}[^}]*usagePercent:\\s*${NUM}[^}]*\\}`,
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
function parseDataSlotWindows(html: string): Partial<Record<GoWindowKey, GoQuotaWindow>> {
	const out: Partial<Record<GoWindowKey, GoQuotaWindow>> = {};
	const parts = html.split(/data-slot="usage-item"/);
	for (let i = 1; i < parts.length; i++) {
		const chunk = parts[i];
		const labelMatch = chunk.match(/data-slot="usage-label">([^<]+)</);
		if (!labelMatch) continue;
		const label = labelMatch[1].trim().toLowerCase();
		const usageMatch = chunk.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
		if (!usageMatch) continue;
		const usedPercent = Number(usageMatch[1]);
		if (!Number.isFinite(usedPercent)) continue;

		const resetNow = /data-slot="reset-now"/.test(chunk);
		const resetMatch = chunk.match(/data-slot="reset-time">([\s\S]*?)<\/span>/);
		let resetsInSeconds: number | undefined;
		if (resetNow) {
			resetsInSeconds = 0;
		} else if (resetMatch) {
			const resetContent = resetMatch[1]
				.replace(/<!--\$-->/g, "")
				.replace(/<!--\/-->/g, "")
				.replace(/Resets?\s*in\s*/i, "")
				.trim();
			const parsed = parseHumanReset(resetContent);
			// 重置文案解不出时仍保留 usedPercent（比整窗丢弃更有用）
			resetsInSeconds = parsed === null ? undefined : parsed;
		}

		let key: GoWindowKey | null = null;
		if (label.includes("rolling")) key = "rolling";
		else if (label.includes("weekly")) key = "weekly";
		else if (label.includes("monthly")) key = "monthly";
		if (key) out[key] = { usedPercent, resetsInSeconds };
	}
	return out;
}

/** 从 dashboard HTML 解析三窗口额度；SSR 缺哪窗就用 data-slot 补哪窗 */
export function parseOpencodeGoDashboardHtml(html: string): GoQuota | null {
	const slot = parseDataSlotWindows(html);
	const rolling = matchSsrWindow(html, "rolling") ?? slot.rolling;
	const weekly = matchSsrWindow(html, "weekly") ?? slot.weekly;
	const monthly = matchSsrWindow(html, "monthly") ?? slot.monthly;
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

/**
 * 读显式配置。文件先填缺省；env 仅在对应字段仍空时补齐（与 README「后者补齐前者缺失」一致）。
 */
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
		if (!out.authCookie && typeof obj.cookie === "string") out.authCookie = obj.cookie.trim();
		if (!out.authCookie && typeof obj.auth === "string") out.authCookie = obj.auth.trim();
	}

	const envWs = env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const envCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (!out.workspaceId && envWs) out.workspaceId = envWs;
	if (!out.authCookie && envCookie) out.authCookie = envCookie;

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

async function withCopiedDb<T>(src: string, fn: (tmp: string) => Promise<T>): Promise<T | null> {
	if (!fs.existsSync(src)) return null;
	const tmp = path.join(
		os.tmpdir(),
		`pi-hud-chrome-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
	);
	try {
		await fsPromises.copyFile(src, tmp);
		// 限制临时 DB 权限（仅当前用户可读写）
		try {
			await fsPromises.chmod(tmp, 0o600);
		} catch {
			/* ignore chmod failures on odd fs */
		}
		return await fn(tmp);
	} catch {
		return null;
	} finally {
		try {
			await fsPromises.unlink(tmp);
		} catch {
			/* ignore */
		}
	}
}

async function pythonSqliteB64(dbPath: string, sql: string): Promise<string | null> {
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
		const { stdout } = await execFileAsync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 2 * 1024 * 1024,
		});
		return stdout.trim();
	} catch {
		return null;
	}
}

async function pythonSqliteTextRows(dbPath: string, sql: string): Promise<string[]> {
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
		const { stdout } = await execFileAsync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 2 * 1024 * 1024,
		});
		return stdout
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** 从 Chrome History 提取最近访问的 opencode workspace id */
export async function discoverOpencodeWorkspaceIdFromChrome(): Promise<string | undefined> {
	for (const dir of chromeUserDataDirs()) {
		const hist = path.join(dir, "History");
		const urls = await withCopiedDb(hist, (tmp) =>
			pythonSqliteTextRows(
				tmp,
				"SELECT url FROM urls WHERE url LIKE '%://opencode.ai/workspace/%' OR url LIKE '%://www.opencode.ai/workspace/%' ORDER BY last_visit_time DESC LIMIT 30",
			),
		);
		if (!urls) continue;
		for (const url of urls) {
			// 锚定 host，避免 History 里假域名
			const m = url.match(/^https?:\/\/(?:www\.)?opencode\.ai\/workspace\/(wrk_[A-Za-z0-9]+)/i);
			if (m) return m[1];
		}
	}
	return undefined;
}

async function chromeSafeStoragePassword(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const { stdout } = await execFileAsync(
			"security",
			["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
			{ encoding: "utf8", timeout: 5000 },
		);
		return stdout.trim();
	} catch {
		return null;
	}
}

const COOKIE_SQL =
	"SELECT encrypted_value FROM cookies WHERE name = 'auth' AND (host_key = 'opencode.ai' OR host_key = '.opencode.ai' OR host_key LIKE '%.opencode.ai') ORDER BY LENGTH(host_key) ASC LIMIT 1";

function decryptChromeV10Cookie(enc: Buffer, key: Buffer): string | null {
	if (enc.length < 4) return null;
	const prefix = enc.subarray(0, 3).toString("utf8");
	// macOS Chrome 经典路径是 v10 + AES-CBC；v11/v20 未支持则跳过
	if (prefix !== "v10") return null;
	try {
		const iv = Buffer.alloc(16, 0x20);
		const data = enc.subarray(3);
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		const out = Buffer.concat([decipher.update(data), decipher.final()]);
		const plain = out.length > 32 ? out.subarray(32).toString("utf8") : out.toString("utf8");
		const idx = plain.indexOf("Fe26");
		const cookie = (idx >= 0 ? plain.slice(idx) : plain).trim();
		return cookie.length > 20 ? cookie : null;
	} catch {
		return null;
	}
}

/** 解密 macOS Chrome Cookie 库中的 opencode.ai auth（异步，且仅在确有密文时读 Keychain） */
export async function readChromeOpencodeAuthCookie(): Promise<string | undefined> {
	const candidates: Buffer[] = [];
	for (const dir of chromeUserDataDirs()) {
		const cookiesPath = path.join(dir, "Cookies");
		const b64 = await withCopiedDb(cookiesPath, (tmp) => pythonSqliteB64(tmp, COOKIE_SQL));
		if (!b64) continue;
		try {
			candidates.push(Buffer.from(b64, "base64"));
		} catch {
			/* ignore */
		}
	}
	if (candidates.length === 0) return undefined;

	const password = await chromeSafeStoragePassword();
	if (!password) return undefined;
	const key = crypto.pbkdf2Sync(Buffer.from(password), Buffer.from("saltysalt"), 1003, 16, "sha1");

	for (const enc of candidates) {
		const cookie = decryptChromeV10Cookie(enc, key);
		if (cookie) return cookie;
	}
	return undefined;
}

/** 合并显式配置 + Chrome 自动发现（async，不阻塞事件循环） */
export async function resolveOpencodeGoCredentials(
	agentDir = path.join(os.homedir(), ".pi", "agent"),
	env: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeGoQuotaConfig> {
	const cfg = resolveOpencodeGoQuotaConfig(agentDir, env);
	if (!cfg.workspaceId) cfg.workspaceId = await discoverOpencodeWorkspaceIdFromChrome();
	// 没有 workspace 时仍可读 cookie（配置可能只缺一边）；两边都缺再省 Keychain
	if (!cfg.authCookie) cfg.authCookie = await readChromeOpencodeAuthCookie();
	return cfg;
}

/** 拉取结果原因：区分登录态问题 vs 一般不可用 */
export type GoQuotaFetchReason = "ok" | "auth_expired" | "unavailable" | "no_credentials";

export interface GoQuotaFetchOutcome {
	quota: GoQuota | null;
	reason: GoQuotaFetchReason;
}

export const GO_AUTH_NOTIFY_MESSAGE =
	"OpenCode Go 登录态失效：请在 Chrome 打开 https://opencode.ai/workspace 重新登录，额度显示会自动恢复";

/**
 * 根据 dashboard HTTP 响应判断是登录失效还是其它错误。
 * 纯函数，便于单测。
 */
export function classifyDashboardAuthFailure(
	status: number,
	finalUrl: string,
	html: string,
): Exclude<GoQuotaFetchReason, "ok"> {
	if (status === 401 || status === 403) return "auth_expired";
	// 被踢到登录/鉴权页
	if (/\/(auth|login|signin|sign-in|sign_in)\b/i.test(finalUrl)) return "auth_expired";
	const low = html.toLowerCase();
	// 登录表单强信号
	if (low.includes('type="password"') || low.includes("type='password'") || low.includes('name="password"')) {
		return "auth_expired";
	}
	// 无 usage 且文案像登录墙
	if (
		!low.includes("rollingusage") &&
		!low.includes('data-slot="usage-item"') &&
		(/(sign\s*in|log\s*in|登录|登陆)/i.test(html) || low.includes("oauth") && low.includes("continue with"))
	) {
		return "auth_expired";
	}
	return "unavailable";
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
): Promise<GoQuotaFetchOutcome> {
	const cookieHeader = authCookie.startsWith("auth=") ? authCookie : `auth=${authCookie}`;
	const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				Cookie: cookieHeader,
				Accept: "text/html",
				"User-Agent": DASHBOARD_UA,
			},
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
	} catch {
		return { quota: null, reason: "unavailable" };
	}

	const html = await res.text().catch(() => "");
	const finalUrl = res.url || url;
	if (res.ok) {
		const quota = parseOpencodeGoDashboardHtml(html);
		if (quota) return { quota, reason: "ok" };
		return { quota: null, reason: classifyDashboardAuthFailure(res.status, finalUrl, html) };
	}
	return { quota: null, reason: classifyDashboardAuthFailure(res.status, finalUrl, html) };
}

/**
 * 查 OpenCode Go 额度：官方 API → dashboard scrape。
 * 返回结构化 reason，供 HUD 区分「需重登」与一般失败。
 */
export async function fetchOpencodeGoQuota(opts: {
	apiKey?: string;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<GoQuotaFetchOutcome> {
	if (opts.apiKey) {
		try {
			const official = await fetchOpencodeGoUsageOfficial(opts.apiKey);
			if (official) return { quota: official, reason: "ok" };
		} catch {
			/* 404 / 网络 → 回退 scrape */
		}
	}

	const creds = await resolveOpencodeGoCredentials(opts.agentDir, opts.env);
	if (!creds.workspaceId || !creds.authCookie) {
		return { quota: null, reason: "no_credentials" };
	}
	return fetchOpencodeGoUsageDashboard(creds.workspaceId, creds.authCookie);
}

/**
 * 应用一次 Go 额度拉取结果（纯函数，供测试与 HUD 共用）。
 * 失败时清掉陈旧 quota；auth/no_credentials 标记 goAuthExpired。
 */
export function applyGoQuotaFetchResult(
	_prev: GoQuota | null,
	outcome: GoQuotaFetchOutcome,
): { goQuota: GoQuota | null; goQuotaFailed: boolean; goAuthExpired: boolean } {
	if (outcome.reason === "ok" && outcome.quota) {
		return { goQuota: outcome.quota, goQuotaFailed: false, goAuthExpired: false };
	}
	const goAuthExpired = outcome.reason === "auth_expired" || outcome.reason === "no_credentials";
	return { goQuota: null, goQuotaFailed: true, goAuthExpired };
}

/**
 * 是否应弹出登录提醒：仅在「新进入」auth 失效态时 true（避免每 5 分钟刷屏）。
 */
export function shouldNotifyGoAuthExpired(prevAuthExpired: boolean, nextAuthExpired: boolean): boolean {
	return nextAuthExpired && !prevAuthExpired;
}

/** 渲染用：按稳定顺序产出标签 + 窗口 */
export function goQuotaWindowEntries(q: GoQuota): Array<{ label: string; window: GoQuotaWindow }> {
	const entries: Array<{ label: string; window: GoQuotaWindow }> = [];
	if (q.rolling) entries.push({ label: "5h", window: q.rolling });
	if (q.weekly) entries.push({ label: "周", window: q.weekly });
	if (q.monthly) entries.push({ label: "月", window: q.monthly });
	return entries;
}

/**
 * HUD 第 1 行 Go 额度文案片段（无 theme 时用纯文本；测试覆盖接线）。
 * auth 失效 → "额度 ✗ 需重登"；其它失败 → "额度 ✗"；未就绪 → "额度 —"
 */
export function formatGoQuotaStatusText(
	goQuota: GoQuota | null,
	goQuotaFailed: boolean,
	goAuthExpired = false,
): string {
	const parts: string[] = [];
	if (goQuota) {
		for (const { label, window: w } of goQuotaWindowEntries(goQuota)) {
			const left = Math.max(0, 100 - w.usedPercent);
			let s = `${label} 剩 ${left.toFixed(0)}%`;
			if (w.resetsInSeconds !== undefined) {
				// 不在此 fmtDuration，避免与 index 循环依赖；只给秒数供测试断言
				s += ` (重置 ${w.resetsInSeconds}s)`;
			}
			parts.push(s);
		}
	}
	if (parts.length > 0) return parts.join(" · ");
	if (goAuthExpired) return "额度 ✗ 需重登";
	return goQuotaFailed ? "额度 ✗" : "额度 —";
}
