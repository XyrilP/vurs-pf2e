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

const VURS_CONDITION_NAMES = ["Cursed", "Muted", "Disarmed", "Silenced", "Dragonblight", "Confused", "Fatigued", "Rooted", "Immobilized", "Incapacitated", "Paralyzed", "Petrified", "Prone", "Restrained", "Staggered", "Stunned", "Unconscious", "CantAct", "Broken", "Cooldown", "ChargeUp"];

// Every refresh pass re-asserts every flag on every element, so the common
// case is "value unchanged". The active-flag count is tracked per element to
// keep inert computation O(1); the label (which needs the full name list) is
// only rebuilt when a flag actually transitions. All data-vurs<Condition>
// writes go through this function, so the count cannot drift.
const conditionActiveCounts = new WeakMap();

export function setConditionDisabled(element, condition, isDisabled, disableInteraction = true) {
	if (!element) return;
	const flagKey = `vurs${condition[0].toUpperCase()}${condition.slice(1)}`;
	const flagValue = String(isDisabled);
	const previous = element.dataset[flagKey];
	const flagChanged = previous !== flagValue;
	if (flagChanged) element.dataset[flagKey] = flagValue;

	let activeCount = conditionActiveCounts.get(element);
	if (activeCount === undefined) {
		activeCount = VURS_CONDITION_NAMES.reduce(
			(count, name) => count + (element.dataset[`vurs${name}`] === "true" ? 1 : 0),
			0
		);
	}
	if (flagChanged) {
		if (previous === "true" && flagValue !== "true") activeCount--;
		else if (previous !== "true" && flagValue === "true") activeCount++;
		conditionActiveCounts.set(element, activeCount);
		const label = VURS_CONDITION_NAMES
			.filter(name => element.dataset[`vurs${name}`] === "true")
			.map(name => name === "CantAct" ? "Can't Act" : name === "ChargeUp" ? "Charge Up" : name)
			.join(" · ");
		if (element.dataset.vursConditionLabel !== label) element.dataset.vursConditionLabel = label;
	}
	const disabled = areDisabledFeaturesEnforced() && disableInteraction && activeCount > 0;
	if (element.inert !== disabled) element.inert = disabled;
	if (disabled) {
		if (element.getAttribute("aria-disabled") !== "true") element.setAttribute("aria-disabled", "true");
	} else if (element.hasAttribute("aria-disabled")) {
		element.removeAttribute("aria-disabled");
	}
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
	) || itemHasBreakerTrait(item);
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
// Memoized per refresh pass: isBroken resolution scans actor.rules with
// roll-option tests, which is too expensive to repeat within one pass.
// Every refresh path calls beginVursConditionPass() first, and actor flag or
// rule changes only arrive via actor updates that trigger a new pass.
const vursConditionFlagsCache = new WeakMap();

export function getVursConditionFlags(actor) {
	const gen = vursConditionPassGeneration;
	const cached = actor && typeof actor === "object" ? vursConditionFlagsCache.get(actor) : null;
	if (cached && cached.gen === gen) return cached.flags;
	const flags = buildVursConditionFlags(actor);
	if (actor && typeof actor === "object") vursConditionFlagsCache.set(actor, { gen, flags });
	return flags;
}

function buildVursConditionFlags(actor) {
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

export function itemHasBreakerTrait(item) {
	return getVursItemTraits(item).includes("breaker");
}

export function getVursItemSlug(item, element = null) {
	return item?.slug ??
		foundry.utils.getProperty(item, "system.slug") ??
		element?.dataset?.slug ??
		element?.dataset?.actionSlug ??
		element?.dataset?.action ??
		null;
}

// ---------------------------------------------------------------------------
// Breaker exemption for blanket container disables
//
// Blanket conditions (acting statuses, disarmed, silenced, etc.) inert whole
// containers, and inert cannot be overridden on descendants. When a container
// holds rows whose item has the "breaker" trait, the disable switches to mixed
// mode: every descendant subtree containing no Breaker rows is flagged exactly
// as before, while Breaker rows and their ancestors stay usable. Containers
// without Breaker rows take the normal setConditionDisabled path untouched.
// ---------------------------------------------------------------------------

const breakerMixedDisables = new WeakMap();

// Disable-condition refreshes run many passes over the same rows (one per
// condition per container). Row → item/breaker resolution is identical across
// all of them, so it is cached per refresh pass: every refresh block calls
// beginVursConditionPass() first, bounding staleness to a single pass.
let vursConditionPassGeneration = 0;
export function beginVursConditionPass() {
	return ++vursConditionPassGeneration;
}
export function getVursConditionPassGeneration() {
	return vursConditionPassGeneration;
}

const breakerRowCache = new WeakMap();

function resolveBreakerRowItem(row, actor, resolveItem) {
	const cached = breakerRowCache.get(row);
	if (cached && cached.gen === vursConditionPassGeneration && cached.actor === actor && cached.resolve === (resolveItem ?? null)) {
		return cached;
	}
	const item = resolveItem ? resolveItem(row) : defaultBreakerRowItem(actor, row);
	const entry = { gen: vursConditionPassGeneration, actor, resolve: resolveItem ?? null, item, isBreaker: itemHasBreakerTrait(item) };
	breakerRowCache.set(row, entry);
	return entry;
}

// Mixed-mode containers carry visual-only flags (disableInteraction=false), so
// setConditionDisabled's inert computation can't be trusted on them: a normal
// condition flag and a mixed visual flag can coexist. Recompute inert from the
// flags that are NOT currently in mixed mode.
function refreshMixedContainerInert(container) {
	const mixed = breakerMixedDisables.get(container);
	const mixedConditions = new Set(mixed ? mixed.keys() : []);
	const blocked = VURS_CONDITION_NAMES.some(name => {
		if (container.dataset[`vurs${name}`] !== "true") return false;
		const key = name[0].toLowerCase() + name.slice(1);
		return !mixedConditions.has(key);
	});
	const inert = areDisabledFeaturesEnforced() && blocked;
	container.inert = inert;
	if (inert) container.setAttribute("aria-disabled", "true");
	else container.removeAttribute("aria-disabled");
}

function defaultBreakerRowItem(actor, row) {
	const itemId = row.dataset?.itemId;
	if (itemId) return actor?.items?.get(itemId) ?? null;
	const index = row.dataset?.actionIndex ?? row.dataset?.index;
	if (index !== undefined && index !== "") {
		return actor?.system?.actions?.[Number(index)]?.item ?? null;
	}
	return null;
}

// One container is typically hit by several condition passes per refresh
// (acting statuses alone run six), each scanning the same rows. Row lists are
// stable within a pass generation — passes never add or remove rows — so the
// querySelectorAll results are cached per (container, selector, generation).
const breakerRowsListCache = new WeakMap();

function collectBreakerRows(container, rowSelector, actor, resolveItem) {
	const gen = vursConditionPassGeneration;
	const resolveKey = resolveItem ?? null;
	let entry = breakerRowsListCache.get(container);
	if (!entry || entry.gen !== gen || entry.actor !== actor || entry.resolve !== resolveKey) {
		entry = { gen, actor, resolve: resolveKey, selectors: new Map() };
		breakerRowsListCache.set(container, entry);
	}
	let rows = entry.selectors.get(rowSelector);
	if (!rows) {
		rows = [];
		for (const row of container.querySelectorAll(rowSelector)) {
			if (resolveBreakerRowItem(row, actor, resolveItem).isBreaker) rows.push(row);
		}
		entry.selectors.set(rowSelector, rows);
	}
	return rows;
}

function clearBreakerMixedDisable(container, state, condition) {
	const entry = state?.get(condition);
	if (!entry) return;
	for (const element of entry.flagged) {
		if (element.isConnected !== false) setConditionDisabled(element, condition, false);
	}
	releaseBreakerExemptAncestors(container, state, condition, entry.exemptAncestors);
	state.delete(condition);
	if (state.size === 0) {
		breakerMixedDisables.delete(container);
		container.classList.remove("vurs-breaker-mixed");
	}
}

// Ancestors of Breaker rows get .vurs-breaker-exempt so CSS can lift the whole
// chain above the container overlay — a descendant's z-index alone can be
// trapped by an intermediate stacking context. The class is removed once no
// remaining mixed condition on the container needs that ancestor.
function releaseBreakerExemptAncestors(container, state, condition, exemptAncestors) {
	const stillNeeded = new Set();
	for (const [otherCondition, otherEntry] of state ?? []) {
		if (otherCondition === condition) continue;
		for (const ancestor of otherEntry?.exemptAncestors ?? []) stillNeeded.add(ancestor);
	}
	for (const ancestor of exemptAncestors ?? []) {
		if (!stillNeeded.has(ancestor)) ancestor.classList.remove("vurs-breaker-exempt");
	}
}

export function setConditionDisabledWithBreakerExemption(
	container,
	condition,
	isDisabled,
	actor,
	rowSelector,
	resolveItem = null
) {
	if (!container) return;
	const state = breakerMixedDisables.get(container);
	const wasMixed = state?.has(condition) ?? false;

	// Fast path: inactive and never mixed — identical to a plain clear. Still
	// refresh inert when the container carries mixed-mode visual flags:
	// setConditionDisabled would otherwise count them and wrongly re-inert it.
	if (!isDisabled && !wasMixed) {
		setConditionDisabled(container, condition, false);
		if (breakerMixedDisables.has(container)) refreshMixedContainerInert(container);
		return;
	}

	const breakerRows = isDisabled ? collectBreakerRows(container, rowSelector, actor, resolveItem) : [];
	if (!isDisabled || !breakerRows.length) {
		if (wasMixed) clearBreakerMixedDisable(container, state, condition);
		setConditionDisabled(container, condition, isDisabled);
		if (wasMixed || breakerMixedDisables.has(container)) refreshMixedContainerInert(container);
		return;
	}

	// Mixed mode: the container shows the standard disabled overlay without
	// going inert (disableInteraction=false), so Breaker rows can stay usable
	// above it. Every other top-level subtree is flagged as a unit. Clear the
	// previous pass first — the DOM may have shifted since it ran.
	if (wasMixed) clearBreakerMixedDisable(container, state, condition);
	setConditionDisabled(container, condition, true, false);
	container.classList.add("vurs-breaker-mixed");

	const breakerRowSet = new Set(breakerRows);
	const exempt = new Set(breakerRows);
	const insideBreaker = new Set();
	const exemptAncestors = new Set();
	for (const row of breakerRows) {
		for (const descendant of row.querySelectorAll("*")) {
			exempt.add(descendant);
			insideBreaker.add(descendant);
		}
		for (let ancestor = row.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
			exempt.add(ancestor);
			exemptAncestors.add(ancestor);
		}
	}
	for (const ancestor of exemptAncestors) ancestor.classList.add("vurs-breaker-exempt");

	const flagged = new Set();
	const visit = element => {
		if (insideBreaker.has(element)) return;
		if (exempt.has(element)) {
			// Breaker rows must not carry this condition's flag; ancestors of
			// Breaker rows recurse so their other children still get flagged.
			if (breakerRowSet.has(element)) {
				setConditionDisabled(element, condition, false);
				return;
			}
			for (const child of element.children) visit(child);
			return;
		}
		setConditionDisabled(element, condition, true);
		flagged.add(element);
	};
	for (const child of container.children) visit(child);

	let containerState = breakerMixedDisables.get(container);
	if (!containerState) {
		containerState = new Map();
		breakerMixedDisables.set(container, containerState);
	}
	containerState.set(condition, { flagged, exemptAncestors: [...exemptAncestors] });
	refreshMixedContainerInert(container);
}

const BREAKER_GLOW_ROW_SELECTOR = "[data-item-id], [data-strike][data-action-index]";

// Marks Breaker-trait rows with .vurs-breaker-glow while the actor has any
// active disabling condition, so they stand out as usable amid the disables.
// The class drives PF2e's native `glow` keyframes (pf2e.css).
export function updateVursBreakerGlow(root, actor, rowSelector = BREAKER_GLOW_ROW_SELECTOR, resolveItem = null) {
	if (!root) return;
	const flags = getVursConditionFlags(actor);
	const anyDisabled = Object.values(flags).some(Boolean);
	for (const row of root.querySelectorAll(rowSelector)) {
		const usable = anyDisabled
			&& !row.closest("[inert]")
			&& row.dataset.vursCooldown !== "true"
			&& row.dataset.vursChargeUp !== "true";
		row.classList.toggle("vurs-breaker-glow", usable && resolveBreakerRowItem(row, actor, resolveItem).isBreaker);
	}
}
