/**
 * Task difficulty → recommended tire strength.
 * Cheap heuristics first; judge may refine. Never silently setModel.
 */

import { TIRE_TAGS, type TireTag } from "./config.ts";

export type DifficultyBand = "light" | "medium" | "hard";

export type DifficultyAssessment = {
	/** 0–100, higher = harder. */
	score: number;
	band: DifficultyBand;
	/** Tire that fits this difficulty (capability vs burn). */
	recommendedTire: TireTag;
	reasons: string[];
};

/** Vertical strength: white < yellow < red. */
export const TIRE_STRENGTH: Record<TireTag, number> = {
	white: 0,
	yellow: 1,
	red: 2,
};

export function tireStrength(tag: string | null | undefined): number | null {
	if (!tag) return null;
	const t = tag.toLowerCase();
	if (t === "red" || t === "yellow" || t === "white") return TIRE_STRENGTH[t];
	return null;
}

/** Strongest tire tag among a model's tags (skip ignored). */
export function strongestTireTag(tags: readonly string[]): TireTag | null {
	let best: TireTag | null = null;
	let bestN = -1;
	for (const raw of tags) {
		const t = raw.toLowerCase();
		if (t !== "red" && t !== "yellow" && t !== "white") continue;
		const n = TIRE_STRENGTH[t];
		if (n > bestN) {
			bestN = n;
			best = t;
		}
	}
	return best;
}

const HARD_PATTERNS: RegExp[] = [
	/\b(architecture|architect|redesign|migration|migrate)\b/i,
	/\b(race condition|deadlock|memory leak|heisenbug)\b/i,
	/\b(distributed|scalability|consensus|sharding)\b/i,
	/\b(security audit|threat model|cve)\b/i,
	/\b(large[- ]?scale refactor|rewrite (the )?system)\b/i,
	/架构|体系结构|重构|迁移|竞态|死锁|内存泄漏/,
	/分布式|可扩展|分片|安全审计|威胁模型/,
	/跨模块|跨服务|全仓|整个系统/,
];

const MEDIUM_PATTERNS: RegExp[] = [
	/\b(implement|feature|refactor|debug|investigate)\b/i,
	/\b(code review|pull request|unit test|integration test)\b/i,
	/\b(fix|bug|broken|failing|error)\b/i,
	/实现|功能|联调|调试|排查|修 bug|修bug/,
	/代码评审|单测|集成测试|接口|组件/,
	/为什么|怎么实现|如何实现/,
];

const LIGHT_PATTERNS: RegExp[] = [
	/\b(format|rename|typo|translate|summarize|tl;?dr)\b/i,
	/\b(what is|what's|explain briefly|one[- ]liner)\b/i,
	/\b(convert json|pretty[- ]?print|boilerplate)\b/i,
	/格式化|改名|错别字|翻译|总结一下|一句话/,
	/是什么|简单解释|润色|排版|注释/,
	/^(好的|继续|ok|yes|嗯|行)[.。!！]?$/i,
];

function joinRecent(userMessages: string[], maxMessages: number): string {
	if (userMessages.length === 0) return "";
	return userMessages.slice(-maxMessages).join("\n");
}

function scoreFromText(text: string): { score: number; reasons: string[] } {
	const reasons: string[] = [];
	let score = 18; // default mild-medium bias for coding sessions

	if (!text.trim()) {
		return { score: 10, reasons: ["无用户消息，按轻量估"] };
	}

	let hardHits = 0;
	for (const re of HARD_PATTERNS) {
		if (re.test(text)) hardHits += 1;
	}
	if (hardHits > 0) {
		score += Math.min(45, 22 + hardHits * 10);
		reasons.push(`高难关键词×${hardHits}`);
	}

	let medHits = 0;
	for (const re of MEDIUM_PATTERNS) {
		if (re.test(text)) medHits += 1;
	}
	if (medHits > 0) {
		score += Math.min(28, 10 + medHits * 6);
		reasons.push(`常规开发关键词×${medHits}`);
	}

	let lightHits = 0;
	for (const re of LIGHT_PATTERNS) {
		if (re.test(text)) lightHits += 1;
	}
	if (lightHits > 0 && hardHits === 0) {
		score -= Math.min(22, 8 + lightHits * 5);
		reasons.push(`轻量关键词×${lightHits}`);
	}

	const len = text.length;
	if (len >= 1200) {
		score += 18;
		reasons.push(`近期用户文本较长(${len}字)`);
	} else if (len >= 400) {
		score += 8;
		reasons.push(`近期用户文本中等(${len}字)`);
	} else if (len > 0 && len < 40 && hardHits === 0 && medHits === 0) {
		score -= 10;
		reasons.push("近期用户文本很短");
	}

	// Multi-path / multi-file hints
	const pathish = (text.match(/[./][\w.-]+\.(ts|tsx|js|jsx|go|py|rs|java|md)/gi) ?? []).length;
	if (pathish >= 4) {
		score += 16;
		reasons.push(`多文件线索×${pathish}`);
	} else if (pathish >= 2) {
		score += 8;
		reasons.push(`多文件线索×${pathish}`);
	}

	return { score: Math.max(0, Math.min(100, score)), reasons };
}

function bandFromScore(score: number): DifficultyBand {
	if (score >= 55) return "hard";
	if (score >= 28) return "medium";
	return "light";
}

function tireFromBand(band: DifficultyBand): TireTag {
	if (band === "hard") return "red";
	if (band === "medium") return "yellow";
	return "white";
}

export type DifficultyInput = {
	userMessages: string[];
	/** Optional mid-session stress that raises difficulty. */
	consecutiveCorrections?: number;
	sameToolFailStreak?: number;
	/** How many recent user messages to inspect (default 4). */
	window?: number;
};

/**
 * Rule-based difficulty for tire matching.
 * Negative mid-session stress bumps score (corrections / tool loops).
 */
export function assessDifficulty(input: DifficultyInput): DifficultyAssessment {
	const window = input.window ?? 4;
	const text = joinRecent(input.userMessages, window);
	const { score: base, reasons } = scoreFromText(text);
	let score = base;

	const corr = input.consecutiveCorrections ?? 0;
	if (corr >= 2) {
		score = Math.min(100, score + 18 + Math.min(corr, 4) * 4);
		reasons.push(`连续纠正×${corr}`);
	} else if (corr === 1) {
		score = Math.min(100, score + 8);
		reasons.push("出现纠正");
	}

	const fails = input.sameToolFailStreak ?? 0;
	if (fails >= 2) {
		score = Math.min(100, score + 16 + Math.min(fails, 4) * 3);
		reasons.push(`同工具失败×${fails}`);
	} else if (fails === 1) {
		score = Math.min(100, score + 6);
		reasons.push("工具失败");
	}

	const band = bandFromScore(score);
	const recommendedTire = tireFromBand(band);
	if (reasons.length === 0) reasons.push(`score=${score}`);

	return {
		score,
		band,
		recommendedTire,
		reasons,
	};
}

export type FitDirection = "upgrade" | "economy" | "stay";

export type FitAssessment = {
	direction: FitDirection;
	/** Tire to aim for when not stay. */
	targetTire: TireTag | null;
	currentTire: TireTag | null;
	difficulty: DifficultyAssessment;
	reasons: string[];
};

/**
 * Compare current tire vs difficulty-recommended tire.
 * upgrade = underpowered; economy = overprovisioned; stay = match or unknown.
 */
export function assessFit(
	currentTire: TireTag | null,
	difficulty: DifficultyAssessment,
): FitAssessment {
	const curN = tireStrength(currentTire);
	const needN = TIRE_STRENGTH[difficulty.recommendedTire];
	const reasons = [
		`任务难度 ${difficulty.band}(score=${difficulty.score}) → 建议${difficulty.recommendedTire}胎`,
		...difficulty.reasons.slice(0, 4),
	];

	if (curN === null) {
		return {
			direction: "stay",
			targetTire: difficulty.recommendedTire,
			currentTire,
			difficulty,
			reasons: [...reasons, "当前模型未打胎标，仅作参考"],
		};
	}

	if (needN > curN) {
		return {
			direction: "upgrade",
			targetTire: difficulty.recommendedTire,
			currentTire,
			difficulty,
			reasons: [
				...reasons,
				`当前${currentTire}胎偏弱，建议升到${difficulty.recommendedTire}胎`,
			],
		};
	}

	if (needN < curN) {
		return {
			direction: "economy",
			targetTire: difficulty.recommendedTire,
			currentTire,
			difficulty,
			reasons: [
				...reasons,
				`当前${currentTire}胎偏强，可降到${difficulty.recommendedTire}胎以省额度/费用`,
			],
		};
	}

	return {
		direction: "stay",
		targetTire: null,
		currentTire,
		difficulty,
		reasons: [...reasons, "当前胎强与任务难度匹配"],
	};
}

/** True if tag is a known tire compound. */
export function isTireTag(tag: string): tag is TireTag {
	return (TIRE_TAGS as readonly string[]).includes(tag);
}
