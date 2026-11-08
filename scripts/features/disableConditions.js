import { getSystemMode, isAgnosticVursMode } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const DRAGONBLIGHT_DAMAGE_TYPES = Object.freeze([
	"acid",
	"cold",
	"electricity",
	"fire",
	"sonic",
	"dragon",
	"vurs-magic"
]);
const DRAGONBLIGHT_ELEMENTAL_TRAITS = Object.freeze([
	"acid",
	"cold",
	"electricity",
	"fire",
	"sonic",
	"air",
	"earth",
	"metal",
	"water",
	"wood"
]);
const DRAGONBLIGHT_MAGICAL_TRAITS = Object.freeze([
	"magical",
	"arcane",
	"divine",
	"occult",
	"primal"
]);
let dragonblightDamageTypeCache = null;
const DISABLED_FEATURE_ENFORCEMENT_SETTINGS = Object.freeze({
	default: "enforceDisabledFeaturesInDefault",
	vurs: "enforceDisabledFeaturesInVurs",
	agnostic: "enforceDisabledFeaturesInAgnostic"
});

export function areDisabledFeaturesEnforced() {
	const settings = globalThis.game?.settings;
	const mode = getSystemMode();
	const key = mode === "vurs"
		? DISABLED_FEATURE_ENFORCEMENT_SETTINGS.vurs
		: isAgnosticVursMode(mode)
			? DISABLED_FEATURE_ENFORCEMENT_SETTINGS.agnostic
			: DISABLED_FEATURE_ENFORCEMENT_SETTINGS.default;
	const registration = `${MODULE_ID}.${key}`;
	if (!settings?.settings?.has?.(registration)) return true;
	return settings.get(MODULE_ID, key) !== false;
}

export function setConditionDisabled(element, condition, isDisabled, disableInteraction = true) {
	if (!element) return;
	element.dataset[`vurs${condition[0].toUpperCase()}${condition.slice(1)}`] = String(isDisabled);
	const activeConditions = ["Cursed", "Muted", "Disarmed", "Silenced", "Dragonblight", "Confused", "Fatigued", "Rooted", "Immobilized", "Incapacitated", "Paralyzed", "Petrified", "Prone", "Restrained", "Staggered", "Stunned", "Unconscious", "CantAct", "Broken", "Cooldown", "ChargeUp"]
		.filter(name => element.dataset[`vurs${name}`] === "true")
		.map(name => name === "CantAct" ? "Can't Act" : name === "ChargeUp" ? "Charge Up" : name);
	element.dataset.vursConditionLabel = activeConditions.join(" · ");
	const disabled = areDisabledFeaturesEnforced() && disableInteraction && activeConditions.length > 0;
	element.inert = disabled;
	if (disabled) element.setAttribute("aria-disabled", "true");
	else element.removeAttribute("aria-disabled");
}

export function setConditionButtonDisabled(button, isDisabled) {
	isDisabled = isDisabled && areDisabledFeaturesEnforced();
	if (isDisabled) {
		if (!Object.hasOwn(button.dataset, "vursOriginalDisabled")) {
			button.dataset.vursOriginalDisabled = String(button.disabled);
		}
		button.disabled = true;
	} else if (Object.hasOwn(button.dataset, "vursOriginalDisabled")) {
		button.disabled = button.dataset.vursOriginalDisabled === "true";
		delete button.dataset.vursOriginalDisabled;
	}
}

export function getDragonblightDamageTypes() {
	const systemConfig = CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
	if (dragonblightDamageTypeCache && dragonblightDamageTypeCache.systemConfig === systemConfig) {
		return dragonblightDamageTypeCache.types;
	}

	const configuredTypes = systemConfig?.damageTypes;
	const types = new Set(configuredTypes
		? DRAGONBLIGHT_DAMAGE_TYPES.filter(type => Object.hasOwn(configuredTypes, type))
		: DRAGONBLIGHT_DAMAGE_TYPES);
	dragonblightDamageTypeCache = { systemConfig, types };
	return types;
}

export function hasDragonblightDamageTypeInValue(value, damageTypes) {
	if (Array.isArray(value)) {
		return value.some(entry => hasDragonblightDamageTypeInValue(entry, damageTypes));
	}
	if (!value || typeof value !== "object") return false;

	return Object.entries(value).some(([key, entry]) =>
		(["damageType", "damage-type"].includes(key) &&
			typeof entry === "string" &&
			(damageTypes.has(entry) || isDragonblightTrait(entry))) ||
		(entry && typeof entry === "object" &&
			hasDragonblightDamageTypeInValue(entry, damageTypes))
	);
}

export function getDragonblightDamageTypesFromValue(value, damageTypes, result = new Set()) {
	if (typeof value === "string") return result;
	if (Array.isArray(value)) {
		for (const entry of value) getDragonblightDamageTypesFromValue(entry, damageTypes, result);
		return result;
	}
	if (!value || typeof value !== "object") return result;

	for (const [key, entry] of Object.entries(value)) {
		if (
			["damageType", "damage-type"].includes(key) &&
			typeof entry === "string" &&
			damageTypes.has(entry)
		) {
			result.add(entry);
		} else if (entry && typeof entry === "object") {
			getDragonblightDamageTypesFromValue(entry, damageTypes, result);
		}
	}
	return result;
}

export function hasDragonblightDamageTraitInValue(value) {
	if (Array.isArray(value) || value instanceof Set) {
		return [...value].some(entry =>
			(typeof entry === "string" && isDragonblightTrait(entry)) ||
			(entry && typeof entry === "object" && hasDragonblightDamageTraitInValue(entry))
		);
	}
	if (!value || typeof value !== "object") return false;
	if (typeof value.slug === "string" && isDragonblightTrait(value.slug)) return true;

	return Object.entries(value).some(([key, entry]) => {
		if (["trait", "damageType", "damage-type"].includes(key) && typeof entry === "string") {
			return isDragonblightTrait(entry);
		}
		if (key === "traits") {
			return hasDragonblightDamageTraitInValue(entry);
		}
		return entry && typeof entry === "object" &&
			hasDragonblightDamageTraitInValue(entry);
	});
}

export function isDragonblightTrait(trait) {
	return DRAGONBLIGHT_ELEMENTAL_TRAITS.includes(trait) ||
		DRAGONBLIGHT_MAGICAL_TRAITS.includes(trait);
}

export function hasDragonblightActionTrait(traits) {
	if (!Array.isArray(traits) && !(traits instanceof Set)) return false;
	for (const trait of traits) {
		const slug = typeof trait === "string" ? trait : trait?.slug;
		if (DRAGONBLIGHT_ELEMENTAL_TRAITS.includes(slug) ||
			DRAGONBLIGHT_MAGICAL_TRAITS.includes(slug)) {
			return true;
		}
	}
	return false;
}

export function getDragonblightDamageSources(system, action) {
	return [
		system?.damage,
		system?.damageRolls,
		system?.damageType,
		system?.rules,
		action?.damage,
		{ damageType: action?.damageType }
	];
}

export function isDragonblightStrikeAffected(item, action, damageTypes) {
	const mainDamageSources = [
		foundry.utils.getProperty(item, "system.damage"),
		action?.damage,
		action?.damageRoll,
		{ damageType: action?.damageType }
	];
	return mainDamageSources.some(source =>
		hasDragonblightDamageTypeInValue(source, damageTypes) ||
		hasDragonblightDamageTraitInValue(source)
	);
}

export function itemIgnoresBroken(item) {
	const otherTags = [
		foundry.utils.getProperty(item, "_source.system.traits.otherTags"),
		foundry.utils.getProperty(item, "system.traits.otherTags")
	].filter(Array.isArray).flat();
	return otherTags.some(tag =>
		typeof tag === "string" &&
		tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === "immunity-to-broken"
	);
}

export function ruleEnablesVursCondition(rule, actor, condition) {
	if (
		rule.key !== "ActiveEffectLike" ||
		rule.path !== `flags.vurs.conditions.${condition}` ||
		!["applyAEs", "beforeDerived"].includes(rule.phase) ||
		!["override", "add", "upgrade"].includes(rule.mode) ||
		![1, "1", true].includes(rule.value) ||
		rule.ignored ||
		typeof rule.test !== "function"
	) {
		return false;
	}

	return rule.test(new Set(actor.getRollOptions(rule.testDomains)));
}

export function ruleEnablesBroken(rule, actor) {
	return ruleEnablesVursCondition(rule, actor, "isBroken");
}

export function getBrokenConditionFlag(actor) {
	const sourceFlag = foundry.utils.getProperty(actor, "_source.flags.vurs.conditions.isBroken");
	if ([1, "1", true].includes(sourceFlag)) return sourceFlag;
	if (actor?.rules?.some(rule => ruleEnablesBroken(rule, actor))) return 1;
	return sourceFlag ?? foundry.utils.getProperty(actor, "flags.vurs.conditions.isBroken");
}

export function isAcquisitionGatedItem(item) {
	const visited = new Set();
	let current = item;

	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		if (
			current.isOfType?.("feat") &&
			current.system.prerequisites?.value?.some(prerequisite =>
				/\b(?:trained|expert|master|legendary)\s+in\s+acquisition\b/i.test(prerequisite.value ?? "")
			)
		) {
			return true;
		}

		current = current.actor?.items?.get(current.flags?.pf2e?.grantedBy?.id) ?? null;
	}

	return false;
}

// Single read of every VURS condition flag used by the disable states.
export function getVursConditionFlags(actor) {
	const flag = name => {
		const value = foundry.utils.getProperty(actor, `flags.vurs.conditions.${name}`);
		return [1, "1", true].includes(value) || (typeof value === "number" && value > 0);
	};
	return {
		isCursed: flag("isCursed"),
		isMuted: flag("isMuted"),
		isDisarmed: flag("isDisarmed"),
		isSilenced: flag("isSilenced"),
		isDragonblight: flag("isDragonblight"),
		isFatigued: flag("isFatigued"),
		isConfused: flag("isConfused"),
		isRooted: flag("isRooted"),
		isImmobilized: flag("isImmobilized"),
		isProne: flag("isProne"),
		isRestrained: flag("isRestrained"),
		isParalyzed: flag("isParalyzed"),
		isBroken: [1, "1", true].includes(getBrokenConditionFlag(actor)),
		isStaggered: flag("isStaggered"),
		isUnconscious: flag("isUnconscious"),
		isCantAct: flag("isCantAct"),
		isIncapacitated: flag("isIncapacitated"),
		isPetrified: flag("isPetrified"),
		isStunned: flag("isStunned")
	};
}

export function getVursItemTraits(item) {
	const traits = foundry.utils.getProperty(item, "system.traits.value");
	return Array.isArray(traits) ? traits : [];
}

export function getVursItemSlug(item, element = null) {
	return item?.slug ??
		foundry.utils.getProperty(item, "system.slug") ??
		element?.dataset?.slug ??
		element?.dataset?.actionSlug ??
		element?.dataset?.action ??
		null;
}
