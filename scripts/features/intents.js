import { actorUsesDicelessRolls, getActorSystemMode, isAgnosticVursMode } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const FLAG_SCOPE = "vurs";
const INTENT_FLAG = "intent";
const INTENT_TYPES = ["unknown", "attacking", "multiattack", "defending", "buffing", "debuffing", "special", "fleeing", "healing"];
const DETAIL_LEVELS = [0, 1, 2];
const DEFAULT_DETAIL_LEVEL = 1;

const INTENT_TYPE_INFO = {
	unknown: { color: 0x9b59b6, glyph: "\uf059" },
	attacking: { color: 0xe74c3c, glyph: "\uf71c" },
	multiattack: { color: 0xe74c3c, glyph: "\uf71c" },
	defending: { color: 0x00bcd4, glyph: "\uf132" },
	buffing: { color: 0x00e5ff, glyph: "\uf062" },
	debuffing: { color: 0x8b0000, glyph: "\uf063" },
	special: { color: 0x3498db, glyph: "\uf890" },
	fleeing: { color: 0xf39c12, glyph: "\uf08e" },
	healing: { color: 0x2ecc71, glyph: "+" }
};

const INTENT_TRANSLATIONS = {
	Title: "Intent",
	Types: {
		Unknown: "Unknown",
		Attacking: "Attacking",
		Multiattack: "Multiattack",
		Defending: "Defending",
		Buffing: "Buffing",
		Debuffing: "Debuffing",
		Special: "Special",
		Fleeing: "Fleeing",
		Healing: "Healing"
	},
	Fields: {
		Action: "Action",
		Type: "Intent Type",
		Target: "Target",
		NoTarget: "— No target —",
		Detail: "Information Level",
		AttackTier: "Attack Tier",
		AttackCount: "Number of Attacks",
		Damage: "Damage"
	},
	Detail: {
		Basic: "Type only",
		Target: "Type + target",
		Action: "Type + target + action"
	},
	AttackTier: {
		Auto: "Auto (from damage)",
		Low: "Low",
		Moderate: "Moderate",
		High: "High",
		Extreme: "Extreme"
	},
	Buttons: {
		Save: "Save Intent",
		Clear: "Clear Intent",
		Cancel: "Cancel"
	},
	Sheet: {
		Button: "Set Intent",
		Active: "Intent set: {type}"
	},
	Tooltip: {
		Target: "Target: {target}",
		Action: "Action: {action}",
		UnknownAction: "Unknown action",
		Remove: "Right-click to remove"
	},
	Keybind: {
		Name: "VURS: Intents",
		Hint: "Press while token(s) are selected to generate an Unknown intent, or hold while clicking an action's send-to-chat icon on an NPC sheet to open the intent dialog."
	}
};

let intentModifierHeld = false;
const intentSheetRoots = new WeakSet();
const intentSnapshots = new Map();
let rebuildScheduled = false;

// ---------------------------------------------------------------------------
// Intent data
// ---------------------------------------------------------------------------

function getIntent(actor) {
	return actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG] ?? null;
}

const INTENT_SETTING_KEYS = Object.freeze({
	default: "intentsInDefault",
	vurs: "intentsInVurs",
	agnostic: "intentsInAgnostic"
});

export function intentsEnabled(actor) {
	const mode = getActorSystemMode(actor);
	const key = mode === "vurs"
		? INTENT_SETTING_KEYS.vurs
		: isAgnosticVursMode(mode)
			? INTENT_SETTING_KEYS.agnostic
			: INTENT_SETTING_KEYS.default;
	return game.settings.get(MODULE_ID, key) === true;
}

function isIntentOwner(actor) {
	if (!actor?.isOfType?.("npc")) return false;
	if (!intentsEnabled(actor)) return false;
	return actor.testUserPermission?.(game.user, "OWNER") ?? actor.isOwner === true;
}

function itemHasTrait(item, slug) {
	if (!item) return false;
	if (item.traits?.has?.(slug)) return true;
	const traits = item.system?.traits;
	return Boolean(
		(Array.isArray(traits?.value) && traits.value.includes(slug)) ||
		(Array.isArray(traits?.custom) && traits.custom.includes(slug))
	);
}

function resolveSheetAction(actor, element) {
	const actions = actor?.system?.actions ?? [];
	const itemId = element?.dataset?.itemId;
	const item = itemId ? actor?.items?.get?.(itemId) ?? null : null;
	let action = itemId
		? actions.find(entry => entry?.item?.id === itemId) ?? null
		: null;
	if (!action) {
		const index = Number(element?.dataset?.actionIndex ?? element?.dataset?.index);
		if (Number.isFinite(index)) action = actions[index] ?? null;
	}
	const isStrike = element?.hasAttribute?.("data-strike") === true || action?.type === "strike";
	return { item, action, isStrike };
}

const MULTIATTACK_NUMBER_WORDS = Object.freeze({
	a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
	seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
});

function isAttackLikeType(type) {
	return type === "attacking" || type === "multiattack";
}

function resolveStrikeItemByName(actor, name) {
	const strikes = actor?.items?.filter(entry => entry?.type === "melee" || entry?.type === "ranged") ?? [];
	const needle = (name ?? "").toLowerCase();
	if (!needle) return strikes[0] ?? null;
	for (const strike of strikes) {
		const strikeName = (strike.name ?? "").toLowerCase();
		if (strikeName && (strikeName.includes(needle) || needle.includes(strikeName))) return strike;
	}
	return strikes[0] ?? null;
}

function detectMultiattack(actor, item) {
	if (!item || item.type === "melee" || item.type === "ranged") return null;
	const raw = item.system?.description?.value ?? item.system?.description ?? "";
	const text = String(raw)
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&amp;/g, " ")
		.replace(/\s+/g, " ");
	const pattern = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(?:([a-z][a-z\s'-]*?)\s+)?Strikes?\b/gi;
	let total = 0;
	const components = [];
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const token = match[1].toLowerCase();
		const count = /^\d+$/.test(token) ? Number(token) : MULTIATTACK_NUMBER_WORDS[token] ?? 1;
		total += count;
		components.push({ name: match[2]?.trim().toLowerCase() ?? "", count });
	}
	if (total < 2) return null;
	const formulaCounts = new Map();
	let representative = null;
	for (const component of components) {
		const strike = resolveStrikeItemByName(actor, component.name);
		if (strike && !representative) representative = strike;
		const formula = resolveStrikeDamageFormula(strike) ?? resolveStrikeDamageFormula(representative);
		if (!formula) continue;
		const key = formula.replace(/\s+/g, "").toLowerCase();
		const existing = formulaCounts.get(key);
		if (existing) existing.count += component.count;
		else formulaCounts.set(key, { formula, count: component.count });
	}
	const damage = [...formulaCounts.values()]
		.map(group => group.count > 1 ? group.formula + "x" + group.count : group.formula)
		.join("; ");
	return { count: total, item: representative, damage: damage || null };
}

function inferIntentType({ actor, item, isStrike }) {
	if (isStrike) return "attacking";
	if (detectMultiattack(actor, item)) return "multiattack";
	if (itemHasTrait(item, "defend")) return "defending";
	if (itemHasTrait(item, "healing")) return "healing";
	return "special";
}

function resolveIntentItem(actor, intent = getIntent(actor)) {
	if (!intent) return null;
	if (intent.itemId) {
		const item = actor?.items?.get?.(intent.itemId);
		if (item) return item;
	}
	if (intent.itemUuid) {
		try {
			return fromUuidSync(intent.itemUuid) ?? null;
		} catch {
			return null;
		}
	}
	return null;
}

const ATTACK_TIERS = ["low", "moderate", "high", "extreme"];

const ATTACK_TIER_INFO = {
	low: { glyph: "\uf6cb" },
	moderate: { glyph: "\uf71c" },
	high: { glyph: "\uf710" },
	extreme: { glyph: "\uf1e2" }
};

// PF2e GM Core Table 2-10 "Strike Damage" average values by level.
const STRIKE_DAMAGE_BY_LEVEL = {
	"-1": { extreme: 4, high: 3, moderate: 3, low: 2 },
	0: { extreme: 6, high: 5, moderate: 4, low: 3 },
	1: { extreme: 8, high: 6, moderate: 5, low: 4 },
	2: { extreme: 11, high: 9, moderate: 8, low: 6 },
	3: { extreme: 15, high: 12, moderate: 10, low: 8 },
	4: { extreme: 18, high: 14, moderate: 12, low: 9 },
	5: { extreme: 20, high: 16, moderate: 13, low: 11 },
	6: { extreme: 23, high: 18, moderate: 15, low: 12 },
	7: { extreme: 25, high: 20, moderate: 17, low: 13 },
	8: { extreme: 28, high: 22, moderate: 18, low: 15 },
	9: { extreme: 30, high: 24, moderate: 20, low: 16 },
	10: { extreme: 33, high: 26, moderate: 22, low: 17 },
	11: { extreme: 35, high: 28, moderate: 23, low: 19 },
	12: { extreme: 38, high: 30, moderate: 25, low: 20 },
	13: { extreme: 40, high: 32, moderate: 27, low: 21 },
	14: { extreme: 43, high: 34, moderate: 28, low: 23 },
	15: { extreme: 45, high: 36, moderate: 30, low: 24 },
	16: { extreme: 48, high: 37, moderate: 31, low: 25 },
	17: { extreme: 50, high: 38, moderate: 32, low: 26 },
	18: { extreme: 53, high: 40, moderate: 33, low: 27 },
	19: { extreme: 55, high: 42, moderate: 35, low: 28 },
	20: { extreme: 58, high: 44, moderate: 37, low: 29 },
	21: { extreme: 60, high: 46, moderate: 38, low: 31 },
	22: { extreme: 63, high: 48, moderate: 40, low: 32 },
	23: { extreme: 65, high: 50, moderate: 42, low: 33 },
	24: { extreme: 68, high: 52, moderate: 44, low: 35 }
};

const DAMAGE_DIE_AVERAGES = Object.freeze({ 4: 2.5, 6: 3.5, 8: 4.5, 10: 5.5, 12: 6.5, 20: 10.5 });

function parseDamageAverage(formula) {
	if (typeof formula !== "string" || !formula.trim()) return null;
	let total = 0;
	let matched = false;
	const termPattern = /([+-]?)\s*(\d*)d(\d+)|([+-]?\d+)/g;
	let match;
	while ((match = termPattern.exec(formula)) !== null) {
		if (match[3] !== undefined) {
			const count = match[2] ? Number(match[2]) : 1;
			const dieAverage = DAMAGE_DIE_AVERAGES[Number(match[3])];
			if (dieAverage === undefined) return null;
			total += (match[1] === "-" ? -1 : 1) * count * dieAverage;
			matched = true;
		} else if (match[4] !== undefined) {
			total += Number(match[4]);
			matched = true;
		}
	}
	return matched ? total : null;
}

function resolveStrikeDamage(item) {
	if (!item) return null;
	const rolls = item.system?.damageRolls;
	if (rolls && typeof rolls === "object") {
		const entries = Object.values(rolls);
		const base = entries.find(roll => roll && !roll.category) ?? entries[0];
		const average = parseDamageAverage(base?.damage);
		if (average !== null) return average;
	}
	const dice = Number(item.system?.damage?.dice);
	const modifier = Number(item.system?.damage?.modifier);
	if (!Number.isFinite(dice) && !Number.isFinite(modifier)) return null;
	const dieAverage = Number.isFinite(dice)
		? DAMAGE_DIE_AVERAGES[dice] ?? (dice + 1) / 2
		: 0;
	return dieAverage + (Number.isFinite(modifier) ? modifier : 0);
}

function resolveStrikeDamageFormula(item) {
	if (!item) return null;
	const rolls = item.system?.damageRolls;
	if (rolls && typeof rolls === "object") {
		const entries = Object.values(rolls);
		const base = entries.find(roll => roll && !roll.category) ?? entries[0];
		if (typeof base?.damage === "string" && base.damage.trim()) return base.damage.trim();
	}
	const dice = Number(item.system?.damage?.dice);
	const modifier = Number(item.system?.damage?.modifier);
	if (!Number.isFinite(dice) && !Number.isFinite(modifier)) return null;
	let formula = Number.isFinite(dice) ? "1d" + dice : "";
	if (Number.isFinite(modifier) && modifier !== 0) formula += (formula ? (modifier > 0 ? "+" : "") : "") + modifier;
	return formula || null;
}

function formatAttackDamage(formula) {
	if (typeof formula !== "string" || !formula.trim()) return null;
	return formula.trim().replace(/([+-])/g, " $1 ").replace(/\s{2,}/g, " ").trim();
}

function resolveDicelessDamage(formula) {
	if (typeof formula !== "string" || !formula.trim()) return null;
	let total = 0;
	let matched = false;
	const termPattern = /([+-]?)\s*(\d*)d(\d+)|([+-]?\d+)/g;
	let match;
	while ((match = termPattern.exec(formula)) !== null) {
		if (match[3] !== undefined) {
			const count = match[2] ? Number(match[2]) : 1;
			const faces = Number(match[3]);
			const dieResult = Math.ceil((faces + 1) / 2);
			total += (match[1] === "-" ? -1 : 1) * count * dieResult;
			matched = true;
		} else if (match[4] !== undefined) {
			total += Number(match[4]);
			matched = true;
		}
	}
	return matched ? total : null;
}

function parseAttackDamageSegments(text) {
	if (typeof text !== "string" || !text.trim()) return [];
	const groups = new Map();
	for (const segment of text.split(";")) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const multMatch = /x(\d+)\s*$/i.exec(trimmed);
		const explicit = Boolean(multMatch);
		const formula = (explicit ? trimmed.slice(0, multMatch.index) : trimmed).trim();
		const count = explicit ? Math.max(1, Math.trunc(Number(multMatch[1])) || 1) : 1;
		if (!formula) continue;
		const key = formula.replace(/\s+/g, "").toLowerCase();
		const existing = groups.get(key);
		if (existing) {
			existing.count += count;
			existing.explicit = existing.explicit || explicit;
		} else {
			groups.set(key, { formula, count, explicit });
		}
	}
	return [...groups.values()];
}

function formatAttackDamageGroup(actor, formula, count) {
	let display;
	if (actorUsesDicelessRolls(actor)) {
		const diceless = resolveDicelessDamage(formula);
		display = diceless === null ? formatAttackDamage(formula) : String(diceless);
	} else {
		display = formatAttackDamage(formula);
	}
	if (!display) return null;
	return count > 1 ? display + "x" + count : display;
}

function buildAttackDamageLines(actor, intent, strikeItem) {
	if (!isAttackLikeType(intent.type)) return [];
	const attackCount = Math.max(1, Math.trunc(Number(intent.attackCount)) || 1);
	const stored = typeof intent.attackDamage === "string" && intent.attackDamage.trim()
		? intent.attackDamage.trim()
		: null;
	let groups;
	if (intent.type === "multiattack" && stored) {
		groups = parseAttackDamageSegments(stored);
		if (groups.length === 1 && !groups[0].explicit && attackCount > 1) {
			groups[0].count = attackCount;
		}
	}
	if (!groups?.length) {
		const formula = stored ?? resolveStrikeDamageFormula(strikeItem);
		groups = formula ? [{ formula, count: attackCount }] : [];
	}
	return groups
		.map(group => formatAttackDamageGroup(actor, group.formula, group.count))
		.filter(Boolean);
}

function strikeDamageRow(actor) {
	const level = Math.trunc(Number(actor?.level));
	if (!Number.isFinite(level)) return null;
	const clamped = Math.min(24, Math.max(-1, level));
	return STRIKE_DAMAGE_BY_LEVEL[String(clamped)] ?? null;
}

function deriveAttackTier(actor, item) {
	const average = resolveStrikeDamage(item);
	const row = strikeDamageRow(actor);
	if (average === null || !row) return null;
	let best = "moderate";
	let bestDistance = Infinity;
	for (const tier of ["extreme", "high", "moderate", "low"]) {
		const distance = Math.abs(average - row[tier]);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = tier;
		}
	}
	return best;
}

function resolveAttackTier(actor, intent) {
	if (ATTACK_TIERS.includes(intent?.attackTier)) return intent.attackTier;
	const item = resolveIntentItem(actor, intent);
	return deriveAttackTier(actor, item) ?? "moderate";
}

function intentAttackTierLabel(tier) {
	return game.i18n.localize("VURS.Intents.AttackTier." + tier[0].toUpperCase() + tier.slice(1));
}

function intentTypeLabel(type) {
	return game.i18n.localize(`VURS.Intents.Types.${type[0].toUpperCase()}${type.slice(1)}`);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

function registerIntentLocalization() {
	const translations = game.i18n?.translations;
	if (!translations) return;
	const register = (entries, prefix) => {
		for (const [key, value] of Object.entries(entries)) {
			const path = `${prefix}.${key}`;
			if (value && typeof value === "object") register(value, path);
			else if (!game.i18n.has(path)) foundry.utils.setProperty(translations, path, value);
		}
	};
	register(INTENT_TRANSLATIONS, "VURS.Intents");
}

// ---------------------------------------------------------------------------
// Intent dialog
// ---------------------------------------------------------------------------

class IntentDialog extends foundry.applications.api.HandlebarsApplicationMixin(
	foundry.applications.api.ApplicationV2
) {
	static DEFAULT_OPTIONS = {
		id: `${MODULE_ID}-intent-dialog`,
		classes: [MODULE_ID, "vurs-intent-dialog"],
		tag: "form",
		position: { width: 420 },
		window: { resizable: true },
		form: {
			handler: IntentDialog.#onSubmit,
			submitOnChange: false,
			closeOnSubmit: true
		}
	};

	static PARTS = {
		form: { template: `modules/${MODULE_ID}/templates/intentDialog.hbs` }
	};

	constructor(actor, { item = null, action = null, isStrike = false } = {}) {
		super();
		this.actor = actor;
		this.item = item;
		this.action = action;
		this.isStrike = isStrike;
		this.options.window ??= {};
		this.options.window.title = game.i18n.localize("VURS.Intents.Title");
	}

	async _prepareContext() {
		const existing = getIntent(this.actor);
		const editingThisItem = existing?.itemId && this.item?.id === existing.itemId;
		const inferredType = inferIntentType({ actor: this.actor, item: this.item, isStrike: this.isStrike });
		const currentType = editingThisItem && isIntentType(existing.type)
			? existing.type
			: inferredType;
		const currentTarget = existing?.targetUuid ?? "";
		const currentLevel = DETAIL_LEVELS.includes(existing?.detailLevel)
			? existing.detailLevel
			: DEFAULT_DETAIL_LEVEL;

		const selfUuid = this.actor?.uuid;
		const selfId = this.actor?.id;
		const detectedMultiattack = currentType === "multiattack"
			? detectMultiattack(this.actor, this.item)
			: null;
		const tierSourceItem = detectedMultiattack?.item ?? this.item;
		const userTargetUuid = [...(game.user?.targets ?? [])]
			.map(token => token?.document ?? token)
			.find(document => document?.actor &&
				document.actor.uuid !== selfUuid && document.actor.id !== selfId)
			?.uuid ?? "";
		const selectedTarget = currentTarget || userTargetUuid;
		const targets = [...(canvas.scene?.tokens ?? [])]
			.filter(document => document?.actor &&
				document.actor.uuid !== selfUuid && document.actor.id !== selfId)
			.map(document => ({
				uuid: document.uuid,
				name: document.name || document.actor?.name || document.uuid,
				selected: document.uuid === selectedTarget
			}));

		return {
			actionName: existing?.actionName ?? this.item?.name ?? game.i18n.localize("VURS.Intents.Tooltip.UnknownAction"),
			types: INTENT_TYPES.map(type => ({
				value: type,
				label: intentTypeLabel(type),
				selected: type === currentType
			})),
			targets,
			levels: DETAIL_LEVELS.map(level => ({
				value: String(level),
				label: game.i18n.localize(`VURS.Intents.Detail.${["Basic", "Target", "Action"][level]}`),
				selected: level === currentLevel
			})),
			isAttackLike: isAttackLikeType(currentType),
			attackTiers: ATTACK_TIERS.map(tier => ({
				value: tier,
				label: intentAttackTierLabel(tier),
				selected: tier === (ATTACK_TIERS.includes(existing?.attackTier)
					? existing.attackTier
					: deriveAttackTier(this.actor, tierSourceItem) ?? "moderate")
			})),
			attackCount: existing?.attackCount ?? detectedMultiattack?.count ?? 1,
			attackDamage: existing?.attackDamage ?? detectedMultiattack?.damage ?? resolveStrikeDamageFormula(tierSourceItem) ?? "",
			hasIntent: Boolean(existing)
		};
	}

	static async #onSubmit(event, form, formData) {
		event.preventDefault();
		const values = formData.object ?? {};
		const type = values.type;
		if (!isIntentType(type)) return;
		const app = activeIntentDialog;
		const actor = app?.actor;
		if (!actor) return;
		const attackCount = Math.max(1, Math.trunc(Number(values.attackCount)) || 1);
		const intent = {
			type,
			itemId: app.item?.id ?? null,
			itemUuid: app.item?.uuid ?? null,
			actionName: (values.actionName ?? "").trim() || null,
			attackTier: ATTACK_TIERS.includes(values.attackTier) ? values.attackTier : null,
			attackCount: attackCount > 1 ? attackCount : null,
			attackDamage: (values.attackDamage ?? "").trim() || null,
			targetUuid: values.target || null,
			detailLevel: DETAIL_LEVELS.includes(Number(values.detail))
				? Number(values.detail)
				: DEFAULT_DETAIL_LEVEL,
			by: game.user.id,
			at: Date.now()
		};
		await actor.setFlag(FLAG_SCOPE, INTENT_FLAG, intent);
	}

	_onRender(context, options) {
		super._onRender?.(context, options);
		const clearButton = this.element?.querySelector("#vurs-intent-clear");
		clearButton?.addEventListener("click", () => {
			void (async () => {
				if (getIntent(this.actor)) await this.actor.unsetFlag(FLAG_SCOPE, INTENT_FLAG);
				this.close();
			})();
		});
		const cancelButton = this.element?.querySelector('[data-action="cancel"]');
		cancelButton?.addEventListener("click", () => this.close());
	}
}

function isIntentType(type) {
	return INTENT_TYPES.includes(type);
}

let activeIntentDialog = null;

function openIntentDialog(actor, { item = null, action = null, isStrike = false } = {}) {
	if (!isIntentOwner(actor)) {
		return;
	}
	const existing = getIntent(actor);
	const resolvedItem = item ?? resolveIntentItem(actor, existing);
	const resolvedAction = action ?? (resolvedItem
		? actor.system?.actions?.find(entry => entry?.item?.id === resolvedItem.id) ?? null
		: null);
	const dialog = new IntentDialog(actor, {
		item: resolvedItem,
		action: resolvedAction,
		isStrike: isStrike || resolvedAction?.type === "strike"
	});
	activeIntentDialog = dialog;
	return dialog.render({ force: true });
}

// ---------------------------------------------------------------------------
// NPC sheet buttons + I+click gesture
// ---------------------------------------------------------------------------

function injectIntentButtons(root, actor) {
	const intent = getIntent(actor);
	const rows = root.querySelectorAll("li.item.action[data-item-id]");
	for (const row of rows) {
		const controls = row.querySelector(":scope > .controls");
		if (!controls) continue;
		let button = controls.querySelector(":scope > .vurs-intent-button");
		if (!button) {
			button = document.createElement("a");
			button.className = "vurs-intent-button";
			button.href = "#";
			button.innerHTML = '<i class="fa-solid fa-bullseye"></i>';
			controls.append(button);
		}
		const { item } = resolveSheetAction(actor, row);
		const active = Boolean(intent?.itemId && item?.id === intent.itemId);
		button.classList.toggle("vurs-intent-active", active);
		button.dataset.tooltip = active
			? game.i18n.format("VURS.Intents.Sheet.Active", {
				type: intentTypeLabel(intent.type)
			})
			: game.i18n.localize("VURS.Intents.Sheet.Button");
	}
}

function onSheetClick(actor, root, event) {
	if (!(event.target instanceof Element)) return;
	const row = event.target.closest("li.item.action[data-item-id]");
	if (!row || !root.contains(row)) return;

	if (event.target.closest(".vurs-intent-button")) {
		event.preventDefault();
		event.stopPropagation();
		const { item, action, isStrike } = resolveSheetAction(actor, row);
		openIntentDialog(actor, { item, action, isStrike });
		return;
	}

	if (intentModifierHeld && event.target.closest('a.chat[data-action="item-to-chat"]')) {
		event.preventDefault();
		event.stopImmediatePropagation();
		const { item, action, isStrike } = resolveSheetAction(actor, row);
		openIntentDialog(actor, { item, action, isStrike });
	}
}

Hooks.on("renderActorSheet", (app, html) => {
	const actor = app?.actor;
	const root = html instanceof HTMLElement ? html : html?.[0];
	if (!actor?.isOfType?.("npc") || !(root instanceof HTMLElement) || !isIntentOwner(actor)) return;
	injectIntentButtons(root, actor);
	if (!intentSheetRoots.has(root)) {
		intentSheetRoots.add(root);
		root.addEventListener("click", event => onSheetClick(actor, root, event), true);
	}
});

// ---------------------------------------------------------------------------
// Token intent layer (PIXI)
// ---------------------------------------------------------------------------

let intentLayer = null;
let intentLineGraphics = null;
let intentTicker = null;
const intentViews = new Map();
let intentTooltip = null;

function getIntentIconSize() {
	return Math.max(48, (canvas?.grid?.sizeX ?? 100) * 0.85);
}

function getIntentFontSize() {
	return Math.max(14, (canvas?.grid?.sizeX ?? 100) * 0.2);
}

function createIntentIcon(type, size, attackTier = null) {
	const graphics = new PIXI.Graphics();
	const info = INTENT_TYPE_INFO[type] ?? { color: 0xffffff, glyph: "\uf059" };
	const glyphChar = isAttackLikeType(type) && ATTACK_TIER_INFO[attackTier]?.glyph || info.glyph;
	const radius = size * 0.5;
	graphics.beginFill(0x000000, 0.6);
	graphics.drawCircle(0, 0, radius * 0.94);
	graphics.endFill();
	const glyph = new PIXI.Text(glyphChar, {
		fontFamily: '"Font Awesome 7 Pro", "Font Awesome 6 Pro", "Font Awesome 6 Free", sans-serif',
		fontSize: size * 0.55,
		fontWeight: "900",
		fill: info.color
	});
	glyph.anchor.set(0.5);
	graphics.addChild(glyph);
	graphics.eventMode = "static";
	graphics.cursor = "pointer";
	graphics.hitArea = new PIXI.Rectangle(-radius, -radius, size, size);
	return graphics;
}

function getTokenTopCenter(tokenDoc) {
	if (!tokenDoc || !canvas?.grid) return null;
	const center = tokenDoc.object?.getCenterPoint?.() ?? tokenDoc.getCenterPoint?.() ?? null;
	if (!center) return null;
	return {
		x: center.x,
		y: center.y - (tokenDoc.height * canvas.grid.sizeY) / 2
	};
}

function resolveTargetTokenDoc(targetUuid) {
	if (!targetUuid) return null;
	let document = null;
	try {
		document = fromUuidSync(targetUuid) ?? null;
	} catch {
		return null;
	}
	const tokenDoc = document?.documentName === "Token" ? document : document?.parent ?? null;
	if (!tokenDoc || tokenDoc.documentName !== "Token") return null;
	if (canvas?.scene && tokenDoc.parent?.id !== canvas.scene.id) return null;
	return tokenDoc;
}

function intentTooltipContent(view) {
	const typeLine = (isAttackLikeType(view.intent.type) && view.attackTier
		? intentTypeLabel(view.intent.type) + " (" + intentAttackTierLabel(view.attackTier) + ")"
		: intentTypeLabel(view.intent.type)) + (view.attackCount > 1 ? " x" + view.attackCount : "");
	const lines = [typeLine];
	if (view.intent.detailLevel >= 1 && view.targetName) {
		lines.push(game.i18n.format("VURS.Intents.Tooltip.Target", { target: view.targetName }));
	}
	if (view.intent.detailLevel >= 2) {
		const actionDetail = (view.actionName ?? game.i18n.localize("VURS.Intents.Tooltip.UnknownAction"))
			+ (view.attackDamageText ? " - " + view.attackDamageText : "");
		lines.push(game.i18n.format("VURS.Intents.Tooltip.Action", { target: actionDetail }));
	}
	if (game.user?.isGM) lines.push(game.i18n.localize("VURS.Intents.Tooltip.Remove"));
	return lines.join("<br>");
}

function ensureIntentTooltip() {
	if (!intentTooltip) {
		intentTooltip = document.createElement("div");
		intentTooltip.className = "vurs-intent-tooltip";
		intentTooltip.hidden = true;
		document.body.appendChild(intentTooltip);
	}
	return intentTooltip;
}

function showIntentTooltip(event, view) {
	const tooltip = ensureIntentTooltip();
	tooltip.innerHTML = view.tooltipHtml ??= intentTooltipContent(view);
	tooltip.hidden = false;
	const x = event?.client?.x ?? 0;
	const y = event?.client?.y ?? 0;
	tooltip.style.left = `${x + 14}px`;
	tooltip.style.top = `${y + 14}px`;
}

function hideIntentTooltip() {
	if (intentTooltip) intentTooltip.hidden = true;
}

function createIntentView(tokenDoc, intent) {
	const size = getIntentIconSize();
	const attackTier = isAttackLikeType(intent.type) ? resolveAttackTier(tokenDoc.actor, intent) : null;
	const attackCount = isAttackLikeType(intent.type)
		? Math.max(1, Math.trunc(Number(intent.attackCount)) || 1)
		: 1;
	const strikeItem = isAttackLikeType(intent.type) ? resolveIntentItem(tokenDoc.actor, intent) : null;
	const attackDamageLines = buildAttackDamageLines(tokenDoc.actor, intent, strikeItem);
	const attackDamageText = attackDamageLines.length ? attackDamageLines.join(" / ") : null;
	const icon = createIntentIcon(intent.type, size, attackTier);
	const view = {
		tokenId: tokenDoc.id,
		intent,
		attackTier,
		attackCount,
		attackDamageText,
		targetTokenDoc: null,
		targetActorUuid: null,
		tooltipHtml: null,
		icon,
		phase: Math.random() * Math.PI * 2,
		targetName: null,
		actionName: null,
		targetText: null,
		actionText: null,
		damageTexts: [],
		countBadge: null
	};

	const targetDoc = resolveTargetTokenDoc(intent.targetUuid);
	view.targetTokenDoc = targetDoc;
	view.targetActorUuid = targetDoc?.actor?.uuid ?? null;
	if (intent.detailLevel >= 1) {
		view.targetName = targetDoc?.name || targetDoc?.actor?.name || null;
		if (view.targetName) {
			view.targetText = new PIXI.Text(view.targetName, intentLabelStyle());
			view.targetText.anchor.set(0.5, 0);
			intentLayer.addChild(view.targetText);
		}
	}
	if (intent.detailLevel >= 2) {
		const item = strikeItem ?? resolveIntentItem(tokenDoc.actor, intent);
		view.actionName = intent.actionName ?? item?.name ?? null;
		if (view.actionName) {
			view.actionText = new PIXI.Text(view.actionName, intentLabelStyle());
			view.actionText.anchor.set(0.5, 0);
			intentLayer.addChild(view.actionText);
		}
	}

	for (const line of attackDamageLines) {
		const damageText = new PIXI.Text(line, intentLabelStyle());
		damageText.anchor.set(0.5, 0);
		intentLayer.addChild(damageText);
		view.damageTexts.push(damageText);
	}

	if (attackCount > 1 && !attackDamageLines.length) {
		view.countBadge = new PIXI.Text("x" + attackCount, {
			fontFamily: "Signifier, system-ui, sans-serif",
			fontSize: size * 0.3,
			fontWeight: "700",
			fill: 0xffffff,
			stroke: 0x000000,
			strokeThickness: 3,
			lineJoin: "round"
		});
		view.countBadge.position.set(size * 0.24, size * 0.2);
		icon.addChild(view.countBadge);
	}

	icon.on("pointerover", event => showIntentTooltip(event, view));
	icon.on("pointermove", event => {
		if (!intentTooltip?.hidden) showIntentTooltip(event, view);
	});
	icon.on("pointerout", hideIntentTooltip);
	icon.on("pointertap", event => {
		const button = event.button ?? event.nativeEvent?.button;
		if ((button !== undefined && button !== 0) || !game.user?.isGM) return;
		event.stopPropagation();
		const liveDoc = canvas?.scene?.tokens?.get?.(view.tokenId) ?? tokenDoc;
		openIntentDialog(liveDoc.actor, {});
	});
	icon.on("pointerdown", event => {
		if (event.button !== 2 || !game.user?.isGM) return;
		event.stopPropagation();
		event.nativeEvent?.preventDefault?.();
		const liveDoc = canvas?.scene?.tokens?.get?.(view.tokenId) ?? tokenDoc;
		const actor = liveDoc.actor;
		if (actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG]) {
			void actor.unsetFlag(FLAG_SCOPE, INTENT_FLAG).catch(error => {
				console.error(`${MODULE_ID} | Failed to clear intent`, error);
			});
		}
	});

	intentLayer.addChild(icon);
	return view;
}

function intentLabelStyle() {
	const fontSize = getIntentFontSize();
	return {
		fontFamily: "Signifier, system-ui, sans-serif",
		fontSize,
		fontWeight: "700",
		fill: 0xffffff,
		stroke: 0x000000,
		strokeThickness: Math.max(2, fontSize * 0.16),
		lineJoin: "round",
		align: "center"
	};
}

function tickIntentViews() {
	if (!canvas?.ready || !canvas.scene) return;
	intentLineGraphics?.clear();
	if (!intentViews.size) return;
	const iconSize = getIntentIconSize();
	const fontSize = getIntentFontSize();
	const lineWidth = Math.max(2, (canvas?.grid?.sizeX ?? 100) * 0.05);

	for (const view of intentViews.values()) {
		const tokenDoc = canvas.scene.tokens.get(view.tokenId);
		const top = tokenDoc ? getTokenTopCenter(tokenDoc) : null;
		view.icon.visible = Boolean(top);
		if (view.targetText) view.targetText.visible = Boolean(top);
		if (view.actionText) view.actionText.visible = Boolean(top);
		for (const damageText of view.damageTexts) damageText.visible = Boolean(top);
		if (!top) continue;

		const iconCenterY = top.y - iconSize * 0.62 +
			Math.sin((performance.now() / 1000) * Math.PI + view.phase) * iconSize * 0.08;
		view.icon.position.set(top.x, iconCenterY);
		let labelY = iconCenterY + iconSize * 0.52;
		if (view.targetText) {
			view.targetText.position.set(top.x, labelY);
			labelY += fontSize * 1.25;
		}
		if (view.actionText) {
			view.actionText.position.set(top.x, labelY);
			labelY += fontSize * 1.25;
		}
		for (const damageText of view.damageTexts) {
			damageText.position.set(top.x, labelY);
			labelY += fontSize * 1.25;
		}

		const targetDoc = view.targetTokenDoc;
		const targetTop = targetDoc ? getTokenTopCenter(targetDoc) : null;
		if (!targetTop) continue;
		const color = INTENT_TYPE_INFO[view.intent.type]?.color ?? 0xffffff;
		intentLineGraphics.lineStyle({ width: lineWidth, color, alpha: 0.85, cap: "round" });
		intentLineGraphics.moveTo(top.x, iconCenterY - iconSize * 0.28);
		intentLineGraphics.lineTo(targetTop.x, targetTop.y);
		intentLineGraphics.lineStyle({ width: Math.max(1, lineWidth * 0.35), color, alpha: 0.9 });
		intentLineGraphics.beginFill(color, 0.9);
		intentLineGraphics.drawCircle(targetTop.x, targetTop.y, lineWidth * 2.2);
		intentLineGraphics.endFill();
	}
}

function destroyIntentView(view) {
	view.icon?.destroy();
	view.targetText?.destroy();
	view.actionText?.destroy();
	for (const damageText of view.damageTexts ?? []) damageText.destroy();
}

const pendingActorRefresh = new Map();
let fullRebuildPending = false;

function flushIntentRebuilds() {
	rebuildScheduled = false;
	if (fullRebuildPending) {
		fullRebuildPending = false;
		pendingActorRefresh.clear();
		rebuildIntentViews();
		return;
	}
	const actors = [...pendingActorRefresh.values()];
	pendingActorRefresh.clear();
	for (const actor of actors) refreshIntentViewsForActor(actor);
}

function scheduleIntentRebuild() {
	fullRebuildPending = true;
	if (rebuildScheduled) return;
	rebuildScheduled = true;
	requestAnimationFrame(flushIntentRebuilds);
}

function scheduleActorIntentRefresh(actor) {
	if (!actor?.uuid) return;
	pendingActorRefresh.set(actor.uuid, actor);
	if (rebuildScheduled) return;
	rebuildScheduled = true;
	requestAnimationFrame(flushIntentRebuilds);
}

const intentWatchedActors = new Set();

function rebuildWatchedActors() {
	intentWatchedActors.clear();
	for (const [tokenId, view] of intentViews) {
		const actor = canvas?.scene?.tokens?.get?.(tokenId)?.actor;
		if (actor?.uuid) intentWatchedActors.add(actor.uuid);
		if (view.targetActorUuid) intentWatchedActors.add(view.targetActorUuid);
	}
}

function rebuildIntentViews() {
	if (!intentLayer || !canvas?.ready || !canvas.scene) return;
	for (const view of intentViews.values()) destroyIntentView(view);
	intentViews.clear();
	hideIntentTooltip();

	const enabledCache = new Map();
	for (const tokenDoc of canvas.scene.tokens) {
		const actor = tokenDoc.actor;
		if (!actor?.uuid) continue;
		let enabled = enabledCache.get(actor.uuid);
		if (enabled === undefined) {
			enabled = intentsEnabled(actor);
			enabledCache.set(actor.uuid, enabled);
		}
		if (!enabled) continue;
		const intent = actor.flags?.[FLAG_SCOPE]?.[INTENT_FLAG];
		if (!intent || !isIntentType(intent.type)) continue;
		intentViews.set(tokenDoc.id, createIntentView(tokenDoc, intent));
	}
	rebuildWatchedActors();
}

function refreshIntentViewsForActor(actor) {
	if (!intentLayer || !canvas?.ready || !canvas.scene || !actor?.uuid) return;
	const affectedActors = new Set([actor.uuid]);
	for (const [tokenId, view] of [...intentViews]) {
		const doc = canvas.scene.tokens.get(tokenId);
		const ownerUuid = doc?.actor?.uuid;
		const owns = ownerUuid === actor.uuid || doc?.actor?.id === actor.id;
		const targets = view.targetActorUuid === actor.uuid;
		if (!owns && !targets) continue;
		destroyIntentView(view);
		intentViews.delete(tokenId);
		if (ownerUuid) affectedActors.add(ownerUuid);
	}

	const enabledCache = new Map();
	for (const tokenDoc of canvas.scene.tokens) {
		const tokenActor = tokenDoc.actor;
		if (!tokenActor?.uuid || !affectedActors.has(tokenActor.uuid)) continue;
		let enabled = enabledCache.get(tokenActor.uuid);
		if (enabled === undefined) {
			enabled = intentsEnabled(tokenActor);
			enabledCache.set(tokenActor.uuid, enabled);
		}
		if (!enabled) continue;
		const intent = tokenActor.flags?.[FLAG_SCOPE]?.[INTENT_FLAG];
		if (!intent || !isIntentType(intent.type)) continue;
		intentViews.set(tokenDoc.id, createIntentView(tokenDoc, intent));
	}
	rebuildWatchedActors();
}

function ensureIntentCanvas() {
	if (!canvas?.ready || !canvas.scene) return;
	if (!intentLayer) {
		intentLayer = new PIXI.Container();
		intentLayer.sortableChildren = false;
		intentLayer.zIndex = 999999;
		intentLineGraphics = new PIXI.Graphics();
		intentLineGraphics.eventMode = "none";
		intentLayer.addChild(intentLineGraphics);
		(canvas.interface ?? canvas.tokens).addChild(intentLayer);
	}
	if (!intentTicker) {
		intentTicker = () => tickIntentViews();
		canvas.app?.ticker?.add(intentTicker);
	}
	rebuildIntentViews();
}

function teardownIntentCanvas() {
	if (intentTicker) {
		canvas?.app?.ticker?.remove(intentTicker);
		intentTicker = null;
	}
	for (const view of intentViews.values()) destroyIntentView(view);
	intentViews.clear();
	intentLayer?.destroy({ children: true });
	intentLayer = null;
	intentLineGraphics = null;
	hideIntentTooltip();
}

function intentSnapshot(actor) {
	return JSON.stringify({
		i: actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG] ?? null,
		n: actor?.name ?? null
	});
}

Hooks.on("canvasReady", ensureIntentCanvas);
Hooks.on("canvasTearDown", teardownIntentCanvas);
Hooks.on("ready", () => {
	if (canvas?.ready && canvas.scene && !intentLayer) ensureIntentCanvas();
});
Hooks.on("updateActor", actor => {
	if (!actor?.uuid) return;
	if (!intentWatchedActors.has(actor.uuid) && !actor.flags?.[FLAG_SCOPE]?.[INTENT_FLAG]) return;
	const snapshot = intentSnapshot(actor);
	if (intentSnapshots.get(actor.uuid) === snapshot) return;
	intentSnapshots.set(actor.uuid, snapshot);
	scheduleActorIntentRefresh(actor);
});
Hooks.on("createToken", scheduleIntentRebuild);
Hooks.on("deleteToken", scheduleIntentRebuild);
Hooks.on("updateToken", (tokenDoc, changes) => {
	if (!changes || typeof changes !== "object") return;
	const relevant = Object.keys(changes).some(key =>
		key === "actor" || key.startsWith("actor.") ||
		key === "flags" || key.startsWith("flags.") || key === "name"
	);
	if (!relevant) return;
	if (changes.actor !== undefined || !tokenDoc.actor?.uuid) {
		scheduleIntentRebuild();
		return;
	}
	scheduleActorIntentRefresh(tokenDoc.actor);
});
Hooks.on("updateItem", item => {
	const intent = item?.actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG];
	if (intent?.itemId === item?.id) scheduleActorIntentRefresh(item?.actor);
});

// ---------------------------------------------------------------------------
function generateUnknownIntentsForSelection() {
	const controlled = canvas?.tokens?.controlled ?? [];
	for (const token of controlled) {
		const doc = token?.document ?? token;
		const actor = doc?.actor;
		if (!actor?.isOfType?.("npc")) continue;
		if (!intentsEnabled(actor)) continue;
		if (actor.flags?.[FLAG_SCOPE]?.[INTENT_FLAG]) continue;
		void actor.setFlag(FLAG_SCOPE, INTENT_FLAG, {
			type: "unknown",
			itemId: null,
			itemUuid: null,
			targetUuid: null,
			detailLevel: 0,
			by: "system",
			at: Date.now()
		}).catch(error => {
			console.error(`${MODULE_ID} | Failed to create unknown intent`, error);
		});
	}
}

// Turn-end clearing + keybind + init
// ---------------------------------------------------------------------------

Hooks.on("pf2e.endTurn", combatant => {
	const actor = combatant?.actor ?? combatant?.token?.actor;
	if (actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG]) {
		void actor.unsetFlag(FLAG_SCOPE, INTENT_FLAG).catch(error => {
			console.error(`${MODULE_ID} | Failed to clear intent on turn end`, error);
		});
	}
});

const intentRoundSeen = new Map();

Hooks.on("pf2e.startTurn", combatant => {
	if (!game.user?.isGM) return;
	const combat = combatant?.combat ?? combatant?.parent;
	const round = combat?.round;
	const combatId = combat?.id;
	if (!combat || round === undefined || combatId === undefined) return;
	if (intentRoundSeen.get(combatId) === round) return;
	intentRoundSeen.set(combatId, round);

	for (const entry of combat.combatants ?? []) {
		const actor = entry?.actor ?? entry?.token?.actor;
		if (!actor?.isOfType?.("npc")) continue;
		if (!intentsEnabled(actor)) continue;
		if (actor.flags?.[FLAG_SCOPE]?.[INTENT_FLAG]) continue;
		void actor.setFlag(FLAG_SCOPE, INTENT_FLAG, {
			type: "unknown",
			itemId: null,
			itemUuid: null,
			targetUuid: null,
			detailLevel: 0,
			by: "system",
			at: Date.now()
		}).catch(error => {
			console.error(`${MODULE_ID} | Failed to create unknown intent`, error);
		});
	}
});

Hooks.on("deleteCombat", combat => {
	if (combat?.id) intentRoundSeen.delete(combat.id);
});

Hooks.on("deleteActor", actor => {
	intentSnapshots.delete(actor?.uuid);
	if (actor?.uuid) intentWatchedActors.delete(actor.uuid);
	scheduleIntentRebuild();
});

Hooks.on("deleteItem", item => {
	const actor = item?.actor;
	const intent = actor?.flags?.[FLAG_SCOPE]?.[INTENT_FLAG];
	if (intent?.itemId && intent.itemId === item.id) {
		void actor.unsetFlag(FLAG_SCOPE, INTENT_FLAG).catch(() => {});
	}
});

Hooks.once("init", () => {
	registerIntentLocalization();
	game.keybindings?.register(MODULE_ID, "vursIntentModifier", {
		name: game.i18n.localize("VURS.Intents.Keybind.Name"),
		hint: game.i18n.localize("VURS.Intents.Keybind.Hint"),
		editable: [{ key: "KeyI", modifiers: [] }],
		onDown: () => {
			intentModifierHeld = true;
			if (game.user?.isGM) generateUnknownIntentsForSelection();
			return true;
		},
		onUp: () => {
			intentModifierHeld = false;
			return true;
		}
	});
});

window.addEventListener("blur", () => {
	intentModifierHeld = false;
});
