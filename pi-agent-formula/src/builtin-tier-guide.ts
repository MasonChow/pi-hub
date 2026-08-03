/**
 * Market model table (single JSON: builtin-models.json)
 *
 * Maintain: edit `builtin-models.json` only
 * - power: higher = stronger (within-tier sort)
 * - tags: red / yellow / white / skip
 * - deprecated: true → default spectator (skip)
 * - match: regex; put more specific entries first
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ModelTableEntry = {
	id: string;
	match: string;
	/** Higher = stronger */
	power: number;
	tags: string[];
	deprecated?: boolean;
	note?: string;
};

export type BuiltinModelsTable = {
	updated: string;
	sourceNote: string;
	fallbacks: {
		lightTags: string[];
		oauthDefaultTags: string[];
		apiKeyDefaultTags: string[];
		/** Power when no table entry matches */
		defaultPower: number;
	};
	models: ModelTableEntry[];
};

/** @deprecated compat shape */
export type BuiltinTagRule = {
	label: string;
	pattern: string;
	tags: string[];
};

/** @deprecated compat shape */
export type BuiltinTierGuide = {
	updated: string;
	sourceNote: string;
	rules: BuiltinTagRule[];
	fallbacks: {
		lightTags: string[];
		oauthDefaultTags: string[];
		apiKeyDefaultTags: string[];
		defaultPower?: number;
		defaultRank?: number;
	};
};

const LIGHT_HINT =
	/luna|flash|haiku|mini|small|light|spark|nano|lite|fast|instant/;

const HEAVY_HINT =
	/opus|fable|sol|reasoner|thinking|ultra|max|pro(?!.*flash)|xhigh/;

function readPower(row: Record<string, unknown>, fallback: number): number {
	if (typeof row.power === "number") return row.power;
	// brief aliases if someone still has old keys
	if (typeof row["战力值"] === "number") return row["战力值"] as number;
	if (typeof row.rank === "number") return Math.max(0, 1000 - (row.rank as number));
	return fallback;
}

function loadTable(): BuiltinModelsTable {
	const dir = dirname(fileURLToPath(import.meta.url));
	const raw = JSON.parse(readFileSync(join(dir, "builtin-models.json"), "utf8")) as Record<
		string,
		unknown
	>;
	const fb = (raw.fallbacks ?? {}) as Record<string, unknown>;
	const defaultPower =
		typeof fb.defaultPower === "number"
			? fb.defaultPower
			: typeof fb["默认战力值"] === "number"
				? (fb["默认战力值"] as number)
				: typeof fb.defaultRank === "number"
					? Math.max(0, 1000 - (fb.defaultRank as number))
					: 50;

	const modelsIn = Array.isArray(raw.models) ? raw.models : [];
	const models: ModelTableEntry[] = modelsIn.map((m) => {
		const row = m as Record<string, unknown>;
		return {
			id: String(row.id ?? ""),
			match: String(row.match ?? ""),
			power: readPower(row, defaultPower),
			tags: Array.isArray(row.tags) ? (row.tags as string[]) : ["yellow"],
			deprecated: Boolean(row.deprecated),
			note: typeof row.note === "string" ? row.note : undefined,
		};
	});

	return {
		updated: String(raw.updated ?? ""),
		sourceNote: String(raw.sourceNote ?? ""),
		fallbacks: {
			lightTags: (fb.lightTags as string[]) ?? ["white"],
			oauthDefaultTags: (fb.oauthDefaultTags as string[]) ?? ["yellow"],
			apiKeyDefaultTags: (fb.apiKeyDefaultTags as string[]) ?? ["yellow"],
			defaultPower,
		},
		models,
	};
}

let cached: BuiltinModelsTable | null = null;

export function getBuiltinModelsTable(): BuiltinModelsTable {
	if (!cached) cached = loadTable();
	return cached;
}

export function resetBuiltinModelsCache(): void {
	cached = null;
}

export function getBuiltinTierGuide(): BuiltinTierGuide {
	const t = getBuiltinModelsTable();
	return {
		updated: t.updated,
		sourceNote: t.sourceNote,
		fallbacks: t.fallbacks,
		rules: t.models.map((m) => ({
			label: m.note ? `${m.id}: ${m.note}` : m.id,
			pattern: m.match,
			tags: m.deprecated ? ["skip"] : m.tags,
		})),
	};
}

export const BUILTIN_TIER_GUIDE: BuiltinTierGuide = new Proxy({} as BuiltinTierGuide, {
	get(_t, prop) {
		return getBuiltinTierGuide()[prop as keyof BuiltinTierGuide];
	},
});

function matchEntry(
	provider: string,
	modelId: string,
	table: BuiltinModelsTable = getBuiltinModelsTable(),
): ModelTableEntry | null {
	const full = `${provider.toLowerCase()}/${modelId.toLowerCase()}`;
	const mid = modelId.toLowerCase();
	for (const entry of table.models) {
		let re: RegExp;
		try {
			re = new RegExp(entry.match, "i");
		} catch {
			continue;
		}
		if (re.test(full) || re.test(mid)) return entry;
	}
	return null;
}

export function looksLightModelId(modelId: string): boolean {
	return LIGHT_HINT.test(modelId.toLowerCase());
}

/** 0 = fast … 2 = heavy */
export function speedClass(modelId: string): number {
	const id = modelId.toLowerCase();
	if (LIGHT_HINT.test(id)) return 0;
	if (HEAVY_HINT.test(id)) return 2;
	return 1;
}

/** power: higher = stronger */
export function modelPower(
	provider: string,
	modelId: string,
	table: BuiltinModelsTable = getBuiltinModelsTable(),
): number {
	const hit = matchEntry(provider, modelId, table);
	if (hit) return hit.power;
	const base = table.fallbacks.defaultPower;
	if (looksLightModelId(modelId)) return Math.max(0, base - 20);
	return base;
}

/** @deprecated use modelPower */
export function modelRank(provider: string, modelId: string): number {
	return modelPower(provider, modelId);
}

/** @deprecated use modelPower (higher = stronger) */
export function strengthClass(modelId: string, provider = ""): number {
	return modelPower(provider, modelId);
}

export function isDeprecatedModel(
	provider: string,
	modelId: string,
	table: BuiltinModelsTable = getBuiltinModelsTable(),
): boolean {
	return Boolean(matchEntry(provider, modelId, table)?.deprecated);
}

export function authPreferenceRank(auth: "oauth" | "api_key" | "none"): number {
	if (auth === "oauth") return 0;
	if (auth === "api_key") return 1;
	return 2;
}

/**
 * Within-tier: oauth → higher power first → faster → name
 */
export function compareWithinTierMatch(
	a: { provider: string; model: string; auth: "oauth" | "api_key" | "none" },
	b: { provider: string; model: string; auth: "oauth" | "api_key" | "none" },
	tireTag?: string,
): number {
	const ar = authPreferenceRank(a.auth);
	const br = authPreferenceRank(b.auth);
	if (ar !== br) return ar - br;

	const pa = modelPower(a.provider, a.model);
	const pb = modelPower(b.provider, b.model);
	if (pa !== pb) return pb - pa;

	const as = speedClass(a.model);
	const bs = speedClass(b.model);
	if (as !== bs) return as - bs;

	return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
}

export type SuggestTagsInput = {
	provider: string;
	modelId: string;
	auth: "oauth" | "api_key" | "none";
	guide?: unknown;
};

export function suggestTagsFromGuide(input: SuggestTagsInput): string[] {
	const table = getBuiltinModelsTable();
	const hit = matchEntry(input.provider, input.modelId, table);
	if (hit) {
		if (hit.deprecated) return ["skip"];
		return normalizeTags(hit.tags);
	}
	if (looksLightModelId(input.modelId)) {
		return normalizeTags(table.fallbacks.lightTags);
	}
	if (input.auth === "oauth") {
		return normalizeTags(table.fallbacks.oauthDefaultTags);
	}
	return normalizeTags(table.fallbacks.apiKeyDefaultTags);
}

function normalizeTags(tags: string[]): string[] {
	const out: string[] = [];
	for (const t of tags) {
		const x = t.trim().toLowerCase();
		if (x && !out.includes(x)) out.push(x);
	}
	return out.length > 0 ? out : ["yellow"];
}
