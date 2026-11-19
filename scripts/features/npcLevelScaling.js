// Building Creatures benchmark tables from the Pathfinder GM Core (ch. 2),
// as published on Archives of Nethys (Rules.aspx?ID=2874). Each table covers
// creature levels -1 through 24; levels beyond 24 extrapolate along the
// 20-to-24 slope of each column.
//
// A table is { tiers: [...], rows: [[cell, ...], ...] } where rows are indexed
// by level + 1. A cell is a number, a [min, max] range, or null when the tier
// is unavailable at that level.

const MIN_BENCHMARK_LEVEL = -1;
const MAX_BENCHMARK_LEVEL = 24;
const EXTRAPOLATION_BASE_LEVEL = 20;

// Table 2-1: Ability Modifier Scales (Extreme, High, Moderate, Low).
// Extreme is unavailable at levels -1 and 0.
const ABILITY_MODIFIERS = {
	tiers: ["extreme", "high", "moderate", "low"],
	rows: [
		[null, 3, 2, 0], [null, 3, 2, 0],
		[5, 4, 3, 1], [5, 4, 3, 1], [5, 4, 3, 1],
		[6, 5, 3, 2], [6, 5, 4, 2], [7, 5, 4, 2], [7, 6, 4, 2], [7, 6, 4, 3], [7, 6, 4, 3],
		[8, 7, 5, 3], [8, 7, 5, 3], [8, 7, 5, 4], [9, 8, 5, 4], [9, 8, 5, 4],
		[9, 8, 6, 4], [10, 9, 6, 5], [10, 9, 6, 5], [10, 9, 6, 5], [11, 10, 6, 5],
		[11, 10, 7, 6], [11, 10, 7, 6], [11, 10, 8, 6], [11, 10, 8, 6], [13, 12, 9, 7]
	]
};

// Table 2-2 / 2-6: Perception and Saving Throws share identical values
// (Extreme, High, Moderate, Low, Terrible).
const PERCEPTION_SAVES = {
	tiers: ["extreme", "high", "moderate", "low", "terrible"],
	rows: [
		[9, 8, 5, 2, 0], [10, 9, 6, 3, 1],
		[11, 10, 7, 4, 2], [12, 11, 8, 5, 3], [14, 12, 9, 6, 4], [15, 14, 11, 8, 6],
		[17, 15, 12, 9, 7], [18, 17, 14, 11, 8], [20, 18, 15, 12, 10], [21, 19, 16, 13, 11],
		[23, 21, 18, 15, 12], [24, 22, 19, 16, 14], [26, 24, 21, 18, 15], [27, 25, 22, 19, 16],
		[29, 26, 23, 20, 18], [30, 28, 25, 22, 19], [32, 29, 26, 23, 20], [33, 30, 28, 25, 22],
		[35, 32, 29, 26, 23], [36, 33, 30, 27, 24], [38, 35, 32, 29, 26], [39, 36, 33, 30, 27],
		[41, 38, 35, 32, 28], [43, 39, 36, 33, 30], [44, 40, 37, 34, 31], [46, 42, 38, 36, 32]
	]
};

// Table 2-3: Skills (Extreme, High, Moderate, Low range).
const SKILLS = {
	tiers: ["extreme", "high", "moderate", "low"],
	rows: [
		[8, 5, 4, [1, 2]], [9, 6, 5, [2, 3]],
		[10, 7, 6, [3, 4]], [11, 8, 7, [4, 5]], [13, 10, 9, [5, 7]], [15, 12, 10, [7, 8]],
		[16, 13, 12, [8, 10]], [18, 15, 13, [9, 11]], [20, 17, 15, [11, 13]], [21, 18, 16, [12, 14]],
		[23, 20, 18, [13, 16]], [25, 22, 19, [15, 17]], [26, 23, 21, [16, 19]], [28, 25, 22, [17, 20]],
		[30, 27, 24, [19, 22]], [31, 28, 25, [20, 23]], [33, 30, 27, [21, 25]], [35, 32, 28, [23, 26]],
		[36, 33, 30, [24, 28]], [38, 35, 31, [25, 29]], [40, 37, 33, [27, 31]], [41, 38, 34, [28, 32]],
		[43, 40, 36, [29, 34]], [45, 42, 37, [31, 35]], [46, 43, 38, [32, 36]], [48, 45, 40, [33, 38]]
	]
};

// Table 2-5: Armor Class (Extreme, High, Moderate, Low).
const ARMOR_CLASS = {
	tiers: ["extreme", "high", "moderate", "low"],
	rows: [
		[18, 15, 14, 12], [19, 16, 15, 13],
		[19, 16, 15, 13], [21, 18, 17, 15], [22, 19, 18, 16], [24, 21, 20, 18], [25, 22, 21, 19],
		[27, 24, 23, 21], [28, 25, 24, 22], [30, 27, 26, 24], [31, 28, 27, 25], [33, 30, 29, 27],
		[34, 31, 30, 28], [36, 33, 32, 30], [37, 34, 33, 31], [39, 36, 35, 33], [40, 37, 36, 34],
		[42, 39, 38, 36], [43, 40, 39, 37], [45, 42, 41, 39], [46, 43, 42, 40], [48, 45, 44, 42],
		[49, 46, 45, 43], [51, 48, 47, 45], [52, 49, 48, 46], [54, 51, 50, 48]
	]
};

// Table 2-7: Hit Points (High, Moderate, Low ranges; no Extreme column).
const HIT_POINTS = {
	tiers: ["high", "moderate", "low"],
	rows: [
		[[17, 20], [14, 16], [11, 13]],
		[[17, 20], [14, 16], [11, 13]], [[24, 26], [19, 21], [14, 16]], [[36, 40], [28, 32], [21, 25]],
		[[53, 59], [42, 48], [31, 37]], [[72, 78], [57, 63], [42, 48]], [[91, 97], [72, 78], [53, 59]],
		[[115, 123], [91, 99], [67, 75]], [[140, 148], [111, 119], [82, 90]], [[165, 173], [131, 139], [97, 105]],
		[[190, 198], [151, 159], [112, 120]], [[215, 223], [171, 179], [127, 135]], [[240, 248], [191, 199], [142, 150]],
		[[265, 273], [211, 219], [157, 165]], [[290, 298], [231, 239], [172, 180]], [[315, 323], [251, 259], [187, 195]],
		[[340, 348], [271, 279], [202, 210]], [[365, 373], [291, 299], [217, 225]], [[390, 398], [311, 319], [232, 240]],
		[[415, 423], [331, 339], [247, 255]], [[440, 448], [351, 359], [262, 270]], [[465, 473], [371, 379], [277, 285]],
		[[495, 505], [395, 405], [295, 305]], [[532, 544], [424, 436], [317, 329]], [[569, 581], [454, 466], [339, 351]],
		[[617, 633], [492, 508], [367, 383]]
	]
};

// Table 2-9: Strike Attack Bonus (Extreme, High, Moderate, Low).
const STRIKE_ATTACK = {
	tiers: ["extreme", "high", "moderate", "low"],
	rows: [
		[10, 8, 6, 4], [10, 8, 6, 4],
		[11, 9, 7, 5], [13, 11, 9, 7], [14, 12, 10, 8], [16, 14, 12, 9], [17, 15, 13, 11],
		[19, 17, 15, 12], [20, 18, 16, 13], [22, 20, 18, 15], [23, 21, 19, 16], [25, 23, 21, 17],
		[27, 24, 22, 19], [28, 26, 24, 20], [29, 27, 25, 21], [31, 29, 27, 23], [32, 30, 28, 24],
		[34, 32, 30, 25], [35, 33, 31, 27], [37, 35, 33, 28], [38, 36, 34, 29], [40, 38, 36, 31],
		[41, 39, 37, 32], [43, 41, 39, 33], [44, 42, 40, 35], [46, 44, 42, 36]
	]
};

// Table 2-11: Spell DC and Spell Attack Bonus. Each row holds
// [extremeDc, extremeAttack, highDc, highAttack, moderateDc, moderateAttack].
const SPELL_DC_ATTACK = {
	tiers: ["extreme", "high", "moderate"],
	rows: [
		[19, 11, 16, 8, 13, 5], [19, 11, 16, 8, 13, 5],
		[20, 12, 17, 9, 14, 6], [22, 14, 18, 10, 15, 7], [23, 15, 20, 12, 17, 9],
		[25, 17, 21, 13, 18, 10], [26, 18, 22, 14, 19, 11], [27, 19, 24, 16, 21, 13],
		[29, 21, 25, 17, 22, 14], [30, 22, 26, 18, 23, 15], [32, 24, 28, 20, 25, 17],
		[33, 25, 29, 21, 26, 18], [34, 26, 30, 22, 27, 19], [36, 28, 32, 24, 29, 21],
		[37, 29, 33, 25, 30, 22], [39, 31, 34, 26, 31, 23], [40, 32, 36, 28, 33, 25],
		[41, 33, 37, 29, 34, 26], [43, 35, 38, 30, 35, 27], [44, 36, 40, 32, 37, 29],
		[46, 38, 41, 33, 38, 30], [47, 39, 42, 34, 39, 31], [48, 40, 44, 36, 41, 33],
		[50, 42, 45, 37, 42, 34], [51, 43, 46, 38, 43, 35], [52, 44, 48, 40, 45, 37]
	]
};

// Table 2-8: Resistances and Weaknesses (Maximum, Minimum per level).
const RESIST_WEAK = {
	rows: [
		{ max: 1, min: 1 }, { max: 3, min: 1 }, { max: 3, min: 2 }, { max: 5, min: 2 },
		{ max: 6, min: 3 }, { max: 7, min: 4 }, { max: 8, min: 4 }, { max: 9, min: 5 },
		{ max: 10, min: 5 }, { max: 11, min: 6 }, { max: 12, min: 6 }, { max: 13, min: 7 },
		{ max: 14, min: 7 }, { max: 15, min: 8 }, { max: 16, min: 8 }, { max: 17, min: 9 },
		{ max: 18, min: 9 }, { max: 19, min: 9 }, { max: 19, min: 10 }, { max: 20, min: 10 },
		{ max: 21, min: 11 }, { max: 22, min: 11 }, { max: 23, min: 12 }, { max: 24, min: 12 },
		{ max: 25, min: 13 }, { max: 26, min: 13 }
	]
};

export const NPC_BENCHMARK_TABLES = Object.freeze({
	abilities: ABILITY_MODIFIERS,
	perceptionSaves: PERCEPTION_SAVES,
	skills: SKILLS,
	ac: ARMOR_CLASS,
	hp: HIT_POINTS,
	strikeAttack: STRIKE_ATTACK,
	spellDcAttack: SPELL_DC_ATTACK
});



function clampLevel(level) {
	return Math.min(MAX_BENCHMARK_LEVEL, Math.max(MIN_BENCHMARK_LEVEL, level));
}

function cellNumber(cell) {
	if (cell === null || cell === undefined) return null;
	if (Array.isArray(cell)) return (cell[0] + cell[1]) / 2;
	return cell;
}

function rowAt(table, level) {
	return table.rows[clampLevel(level) - MIN_BENCHMARK_LEVEL];
}

function columnValue(table, level, tierIndex) {
	const numeric = Number(level);
	if (!Number.isFinite(numeric)) return null;
	if (numeric <= MAX_BENCHMARK_LEVEL) {
		return cellNumber(rowAt(table, numeric)?.[tierIndex]);
	}
	const high = cellNumber(rowAt(table, MAX_BENCHMARK_LEVEL)?.[tierIndex]);
	const low = cellNumber(rowAt(table, EXTRAPOLATION_BASE_LEVEL)?.[tierIndex]);
	if (high === null) return null;
	if (low === null) return high;
	return high + ((high - low) / (MAX_BENCHMARK_LEVEL - EXTRAPOLATION_BASE_LEVEL)) * (numeric - MAX_BENCHMARK_LEVEL);
}

function availableTiers(table, level) {
	const row = rowAt(table, level);
	const tiers = [];
	for (let index = 0; index < table.tiers.length; index += 1) {
		if (cellNumber(row?.[index]) !== null) tiers.push(index);
	}
	return tiers.length ? tiers : [0];
}

export function classifyBenchmarkTier(table, level, value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return null;
	let best = null;
	let bestDistance = Infinity;
	for (const tier of availableTiers(table, level)) {
		const candidate = columnValue(table, level, tier);
		const distance = Math.abs(numeric - candidate);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = tier;
		}
	}
	return best;
}

function benchmarkDeltaForTier(table, baseLevel, targetLevel, tier) {
	if (tier === null || tier === undefined) return 0;
	const from = columnValue(table, baseLevel, tier);
	const to = columnValue(table, targetLevel, tier);
	if (from === null || to === null) return 0;
	return Math.round(to - from);
}

// Returns table[targetLevel][tier] - table[baseLevel][tier] for the tier the
// original value classifies into at baseLevel, preserving the NPC's offset
// from the official benchmark.
export function getBenchmarkDelta(table, baseLevel, targetLevel, originalValue) {
	const tier = classifyBenchmarkTier(table, baseLevel, originalValue);
	return benchmarkDeltaForTier(table, baseLevel, targetLevel, tier);
}

export function getBenchmarkTierDelta(table, tierName, baseLevel, targetLevel) {
	const tier = table.tiers.indexOf(tierName);
	if (tier < 0) return 0;
	return benchmarkDeltaForTier(table, baseLevel, targetLevel, tier);
}

// Attribute modifiers have a terrible range (~-5) that does not change by
// level: values more than 1 below the Low benchmark do not scale.
export function getAttributeBenchmarkDelta(baseLevel, targetLevel, originalValue) {
	const numeric = Number(originalValue);
	if (Number.isFinite(numeric) && numeric <= -4) return 0;
	return getBenchmarkDelta(ABILITY_MODIFIERS, baseLevel, targetLevel, originalValue);
}

const SPELL_TIER_COLUMN = { extreme: 0, high: 2, moderate: 4 };
const SPELL_KIND_OFFSET = { dc: 0, attack: 1 };

export function getSpellBenchmarkDelta(kind, baseLevel, targetLevel, originalValue) {
	const offset = SPELL_KIND_OFFSET[kind] ?? 0;
	const numeric = Number(originalValue);
	if (!Number.isFinite(numeric)) return 0;
	let bestTier = null;
	let bestDistance = Infinity;
	for (const [tierName, column] of Object.entries(SPELL_TIER_COLUMN)) {
		const candidate = columnValue(SPELL_DC_ATTACK, baseLevel, column + offset);
		if (candidate === null) continue;
		const distance = Math.abs(numeric - candidate);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestTier = tierName;
		}
	}
	if (!bestTier) return 0;
	const column = SPELL_TIER_COLUMN[bestTier] + offset;
	const from = columnValue(SPELL_DC_ATTACK, baseLevel, column);
	const to = columnValue(SPELL_DC_ATTACK, targetLevel, column);
	if (from === null || to === null) return 0;
	return Math.round(to - from);
}

function resistWeakRow(level) {
	return RESIST_WEAK.rows[clampLevel(level) - MIN_BENCHMARK_LEVEL];
}

function resistBound(level, key) {
	const numeric = Number(level);
	if (!Number.isFinite(numeric)) return null;
	if (numeric <= MAX_BENCHMARK_LEVEL) return resistWeakRow(numeric)?.[key] ?? null;
	const high = resistWeakRow(MAX_BENCHMARK_LEVEL)[key];
	const low = resistWeakRow(EXTRAPOLATION_BASE_LEVEL)[key];
	return high + ((high - low) / (MAX_BENCHMARK_LEVEL - EXTRAPOLATION_BASE_LEVEL)) * (numeric - MAX_BENCHMARK_LEVEL);
}

// Weaknesses use the Maximum column; resistances preserve the value's
// position within the level's [min, max] band.
export function getResistBenchmarkDelta(kind, baseLevel, targetLevel, originalValue) {
	const numeric = Number(originalValue);
	if (!Number.isFinite(numeric)) return 0;
	if (kind === "weakness") {
		const from = resistBound(baseLevel, "max");
		const to = resistBound(targetLevel, "max");
		if (from === null || to === null) return 0;
		return Math.round(to - from);
	}
	const baseMin = resistBound(baseLevel, "min");
	const baseMax = resistBound(baseLevel, "max");
	const targetMin = resistBound(targetLevel, "min");
	const targetMax = resistBound(targetLevel, "max");
	if ([baseMin, baseMax, targetMin, targetMax].some(value => value === null)) return 0;
	const span = baseMax - baseMin;
	const fraction = span > 0 ? Math.min(1, Math.max(0, (numeric - baseMin) / span)) : 0;
	const adjusted = targetMin + fraction * (targetMax - targetMin);
	return Math.round(adjusted - numeric);
}

// Classifies a saving-throw-style value into the perception/saves table and
// maps the tier onto the three-tier spell table (Low/Terrible -> Moderate).
export function getSaveTierForSpellBenchmark(level, value) {
	const tier = classifyBenchmarkTier(PERCEPTION_SAVES, level, value);
	if (tier === null) return null;
	const name = PERCEPTION_SAVES.tiers[tier];
	if (name === "extreme") return "extreme";
	if (name === "high") return "high";
	return "moderate";
}

export function getSpellTierBenchmarkDelta(tierName, kind, baseLevel, targetLevel) {
	const tierColumn = SPELL_TIER_COLUMN[tierName];
	if (tierColumn === undefined) return 0;
	const column = tierColumn + (SPELL_KIND_OFFSET[kind] ?? 0);
	const from = columnValue(SPELL_DC_ATTACK, baseLevel, column);
	const to = columnValue(SPELL_DC_ATTACK, targetLevel, column);
	if (from === null || to === null) return 0;
	return Math.round(to - from);
}

export default NPC_BENCHMARK_TABLES;
