import {
	actorHasVursDisableStates,
	areVursDisableLocksUiEnforced,
	beginVursConditionPass,
	getDragonblightDamageSources,
	getDragonblightDamageTypes,
	getVursConditionFlags,
	getVursConditionPassGeneration,
	getVursItemFrequencyValue,
	getVursItemSlug,
	getVursItemTraits,
	hasDragonblightActionTrait,
	hasDragonblightDamageTypeInValue,
	isAcquisitionGatedItem,
	isDragonblightStrikeAffected,
	itemHasBreakerTrait,
	itemIgnoresBroken,
	setConditionDisabled,
	setConditionDisabledWithBreakerExemption,
	updateVursBreakerGlow
} from "./disableConditions.js";

const ACTING_STATUSES = ["staggered", "unconscious", "cantAct", "incapacitated", "petrified", "stunned"];
const SPEED_CONDITIONS = ["rooted", "immobilized", "prone", "paralyzed", ...ACTING_STATUSES];
const EQUIPMENT_ITEM_TYPES = new Set(["weapon", "shield", "armor"]);
const statusFlag = (flags, status) => flags[`is${status[0].toUpperCase()}${status.slice(1)}`];

function isVursSupportedActor(actor) {
	return Boolean(actor?.isOfType?.("character") || actor?.isOfType?.("npc"));
}

// actor.system.actions is rescanned for every row otherwise; build the
// itemId → action lookup once per pass generation.
const hudActionMapCache = new WeakMap();
function getHudActionMap(actor) {
	const gen = getVursConditionPassGeneration();
	const cached = actor && typeof actor === "object" ? hudActionMapCache.get(actor) : null;
	if (cached && cached.gen === gen) return cached.map;
	const map = new Map();
	for (const action of actor?.system?.actions ?? []) {
		const id = action?.item?.id;
		if (id && !map.has(id)) map.set(id, action);
	}
	if (actor && typeof actor === "object") hudActionMapCache.set(actor, { gen, map });
	return map;
}

function findHudAction(actor, itemId, index) {
	if (Number.isInteger(index)) {
		const byIndex = actor.system?.actions?.[index];
		if (byIndex) return byIndex;
	}
	if (itemId) {
		return getHudActionMap(actor).get(itemId) ?? null;
	}
	return null;
}

// Never returns null: rows whose item can't be resolved (virtual actions,
// blast ids, stale data) still get evaluated with null-item defaults, matching
// how the sheet treats elements with a missing item.
function hudRowContext(element, actor, category) {
	const itemId = element.dataset.itemId;
	const item = itemId ? actor.items?.get(itemId) ?? null : null;
	const index = category === "strike" && element.dataset.index !== undefined && element.dataset.index !== ""
		? Number(element.dataset.index)
		: NaN;
	const action = findHudAction(actor, itemId, index);
	return {
		item,
		action,
		traits: getVursItemTraits(item),
		slug: getVursItemSlug(item, element)
	};
}

function hasReactionCost(item, traits) {
	return item?.actionCost?.type === "reaction" || traits.includes("reaction");
}

// Skills-sidebar action rows (.item.statistic) are not actor items — their
// data-item-uuid is the sourceId of a compendium action Item, resolved
// synchronously (the sidebar already loaded it during preparation).
const hudSidebarItemCache = new WeakMap();
function resolveHudSidebarItem(element) {
	if (hudSidebarItemCache.has(element)) return hudSidebarItemCache.get(element);
	let item = null;
	const uuid = element.dataset.itemUuid;
	if (uuid) {
		try {
			const resolved = fromUuidSync(uuid, { strict: false });
			if (resolved instanceof Item) item = resolved;
		} catch { /* compendium not cached yet */ }
	}
	// Only cache successes so a late-loading compendium can still resolve.
	if (item) hudSidebarItemCache.set(element, item);
	return item;
}

function hudItemSlug(item, element) {
	return getVursItemSlug(item, element) ??
		(typeof item?.name === "string"
			? item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
			: null);
}

function isDragonblightRowAffected(item, action, traits, isSpell, damageTypes) {
	const hasAffectedTrait = isSpell ||
		hasDragonblightActionTrait(traits) ||
		hasDragonblightActionTrait(action?.traits?.value ?? action?.traits);
	if (hasAffectedTrait) return true;
	return hasDragonblightDamageTypeInValue(
		getDragonblightDamageSources(item?.system, action),
		damageTypes
	);
}

function applyActingStatuses(element, flags, disableInteraction = true, exempt = false) {
	for (const status of ACTING_STATUSES) {
		setConditionDisabled(element, status, statusFlag(flags, status) && !exempt, disableInteraction);
	}
}

// The sidebar root carries data-type ("spells"/"actions"/"items"/...), but fall
// back to content sniffing in case it hasn't been stamped yet.
function hudSidebarType(root) {
	if (root?.dataset?.type) return root.dataset.type;
	if (root?.querySelector('.item[data-item-type^="spell"]')) return "spells";
	if (root?.querySelector(".item.attack, .item.action")) return "actions";
	if (root?.querySelector(".item.feat")) return "feats";
	if (root?.querySelector(".inventory-wealth, .inventory-bulk")) return "items";
	return null;
}

// ---------------------------------------------------------------------------
// Section-level conditions
//
// The sheet disables whole containers (spellcasting tab, strikes list, actions
// tab, inventory sections). The HUD renders sections as flat header + row
// siblings inside a CSS multi-column list, so there is no wrapper element to
// mark. Instead the section HEADER carries the visible label/overlay (via
// setConditionDisabled) while each row gets a parallel `vursSec*` flag that
// contributes to inert + blur WITHOUT adding its own overlay text — producing
// the same "one disabled section" look. These helpers must run AFTER every
// item-level setConditionDisabled pass so the final inert state sees both.
// ---------------------------------------------------------------------------

// Each row receives ~10 section-condition writes per pass; the active-flag
// count is tracked per element so secActive doesn't rescan every dataset key.
const hudSectionActiveCounts = new WeakMap();

function setHudSectionCondition(element, condition, isDisabled) {
	if (!element) return;
	const flagKey = `vursSec${condition[0].toUpperCase()}${condition.slice(1)}`;
	const flagValue = String(isDisabled);
	const previous = element.dataset[flagKey];
	const flagChanged = previous !== flagValue;
	if (flagChanged) element.dataset[flagKey] = flagValue;

	let activeCount = hudSectionActiveCounts.get(element);
	if (activeCount === undefined) {
		activeCount = Object.keys(element.dataset).reduce((count, key) =>
			count + (key.startsWith("vursSec") && key !== "vursSecAny" && element.dataset[key] === "true" ? 1 : 0), 0);
	}
	if (flagChanged) {
		if (previous === "true" && flagValue !== "true") activeCount--;
		else if (previous !== "true" && flagValue === "true") activeCount++;
		hudSectionActiveCounts.set(element, activeCount);
	}
	const secActive = activeCount > 0;
	const secAny = secActive ? "true" : "";
	if (element.dataset.vursSecAny !== secAny) element.dataset.vursSecAny = secAny;
	const itemActive = (element.dataset.vursConditionLabel ?? "") !== "";
	const disabled = areVursDisableLocksUiEnforced() && (secActive || itemActive);
	if (element.inert !== disabled) element.inert = disabled;
	if (disabled) {
		if (element.getAttribute("aria-disabled") !== "true") element.setAttribute("aria-disabled", "true");
	} else if (element.hasAttribute("aria-disabled")) {
		element.removeAttribute("aria-disabled");
	}
}

function applyHudActingStatusSection(element, flags, exempt = false) {
	for (const status of ACTING_STATUSES) {
		setHudSectionCondition(element, status, statusFlag(flags, status) && !exempt);
	}
}

// Applies the sheet's section/tab-level conditions to every row of a HUD
// sidebar section. Runs unconditionally (writes explicit true/false) so stale
// flags clear when a condition is removed without a full re-render.
// Collects the .item rows belonging to an items-sidebar section header.
function hudItemSectionRows(header) {
	const rows = [];
	for (let element = header.nextElementSibling; element && element.tagName !== "HEADER"; element = element.nextElementSibling) {
		if (element.classList?.contains("item") && element.dataset.itemId) rows.push(element);
	}
	return rows;
}

// The sheet exempts an inventory section when its create-item types include
// weapon/shield/armor — i.e. the Weapons & Shields and Armor sections. The HUD
// header has no data-types, but its .name label is localized from the same
// PF2e keys, so match on that first; resolved item types are the fallback.
const EXEMPT_INVENTORY_SECTION_LABEL_KEYS = [
	"PF2E.Actor.Inventory.Section.WeaponsAndShields",
	"TYPES.Item.armor"
];
// Runs per header per pass; localize + sibling-row walks are cached per
// (header, actor, pass generation).
const hudEquipmentSectionCache = new WeakMap();
function isHudEquipmentSection(header, actor) {
	const gen = getVursConditionPassGeneration();
	const cached = header && typeof header === "object" ? hudEquipmentSectionCache.get(header) : null;
	if (cached && cached.gen === gen && cached.actor === actor) return cached.result;
	const result = computeIsHudEquipmentSection(header, actor);
	if (header && typeof header === "object") hudEquipmentSectionCache.set(header, { gen, actor, result });
	return result;
}
function computeIsHudEquipmentSection(header, actor) {
	const label = header.querySelector(".name")?.textContent?.trim();
	if (label && EXEMPT_INVENTORY_SECTION_LABEL_KEYS.some(key => label === game.i18n.localize(key))) {
		return true;
	}
	const types = new Set();
	for (const row of hudItemSectionRows(header)) {
		const type = actor.items?.get(row.dataset.itemId)?.type;
		if (type) types.add(type);
	}
	return types.size > 0 && [...types].every(type => EQUIPMENT_ITEM_TYPES.has(type));
}

function hudRowIsBreaker(actor, row) {
	const item = row?.dataset?.itemId ? actor?.items?.get(row.dataset.itemId) : null;
	return itemHasBreakerTrait(item);
}

function applyHudSectionStates(root, flags, actor) {
	const sidebarType = hudSidebarType(root);
	if (sidebarType === "spells") {
		// Whole spellcasting tab: silenced (also when cursed), cursed,
		// dragonblight and acting statuses.
		for (const row of root.querySelectorAll('.item[data-item-type^="spell"][data-item-id]')) {
			const exempt = hudRowIsBreaker(actor, row);
			setHudSectionCondition(row, "silenced", (flags.isSilenced || flags.isCursed) && !exempt);
			setHudSectionCondition(row, "cursed", flags.isCursed && !exempt);
			setHudSectionCondition(row, "dragonblight", flags.isDragonblight && !exempt);
			applyHudActingStatusSection(row, flags, exempt);
		}
	} else if (sidebarType === "actions") {
		// Strikes list: disarmed (also when cursed), cursed, restrained,
		// paralyzed and acting statuses blanket every strike row.
		for (const row of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
			const exempt = hudRowIsBreaker(actor, row);
			setHudSectionCondition(row, "disarmed", (flags.isDisarmed || flags.isCursed) && !exempt);
			setHudSectionCondition(row, "cursed", flags.isCursed && !exempt);
			setHudSectionCondition(row, "restrained", flags.isRestrained && !exempt);
			setHudSectionCondition(row, "paralyzed", flags.isParalyzed && !exempt);
			applyHudActingStatusSection(row, flags, exempt);
		}
		// .tab.actions disables the whole actions tab for acting statuses —
		// blast rows and regular action rows included.
		for (const row of root.querySelectorAll('.item.attack[data-item-id]:not([data-index]), .item.action[data-item-id]')) {
			applyHudActingStatusSection(row, flags, hudRowIsBreaker(actor, row));
		}
		// Exploration/downtime panels are disabled as a whole when fatigued.
		if (flags.isFatigued) {
			for (const header of root.querySelectorAll("header[data-filter-value]")) {
				if (!["exploration", "downtime"].includes(header.dataset.filterValue)) continue;
				for (let element = header.nextElementSibling; element && element.tagName !== "HEADER"; element = element.nextElementSibling) {
					if (element.classList?.contains("item")) {
						setHudSectionCondition(element, "fatigued", true);
					}
				}
			}
		}
	} else if (sidebarType === "items") {
		// Muted/cursed disables every non-equipment inventory section —
		// weapon/shield/armor sections stay usable, like the sheet.
		for (const header of root.querySelectorAll("header[data-filter-value]")) {
			if (isHudEquipmentSection(header, actor)) continue;
			for (const row of hudItemSectionRows(header)) {
				const exempt = hudRowIsBreaker(actor, row);
				setHudSectionCondition(row, "muted", (flags.isMuted || flags.isCursed) && !exempt);
				setHudSectionCondition(row, "cursed", flags.isCursed && !exempt);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Item-level conditions (per-row, keep their own overlay labels)
// ---------------------------------------------------------------------------

// Dragonblight strike check + muted/cursed auxiliary buttons only — the
// section-level flags (disarm/cursed/restrained/paralyzed/statuses) moved to
// applyHudSectionStates.
function applyStrikeConditions(element, actor, flags, damageTypes) {
	const { item, action, traits } = hudRowContext(element, actor, "strike");
	const isBreaker = traits.includes("breaker");

	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && !isBreaker && isDragonblightStrikeAffected(item, action, damageTypes)
	);

	const disableItems = (flags.isMuted || flags.isCursed) && !isBreaker;
	for (const button of element.querySelectorAll('.variant.auxiliary[data-auxiliary-action-index]')) {
		const auxiliary = action?.auxiliaryActions?.[Number(button.dataset.auxiliaryActionIndex)];
		if (auxiliary?.action !== "raise-a-shield" && auxiliary?.action !== "parry") continue;
		setConditionDisabled(button, "muted", disableItems);
		setConditionDisabled(button, "cursed", flags.isCursed && !isBreaker);
	}
}

// Action rows cover .item.action entries and blast rows (.item.attack without
// data-index) — both are action items on the sheet's actions list.
function applyActionRowConditions(element, actor, flags, damageTypes) {
	const { item, action, traits, slug } = hudRowContext(element, actor, "action");
	const isBasicAction = typeof slug === "string" && game.pf2e?.actions?.has(slug) === true;
	const disableItems = flags.isMuted || flags.isCursed;
	const isAcquisitionGated = isAcquisitionGatedItem(item);
	const isReaction = hasReactionCost(item, traits);
	const isPassive = !item?.actionCost;
	const isDelayOrReady = ["delay", "ready"].includes(slug);
	const isExplorationAction = Boolean(
		element.querySelector('a[data-action="toggle-exploration"]')
	);
	const isBreaker = traits.includes("breaker");

	// Silenced/cursed pass (mirrors applySilencedState: basic actions exempt).
	setConditionDisabled(element, "silenced", flags.isSilenced && !isBasicAction && !isBreaker);
	setConditionDisabled(element, "cursed", flags.isCursed && !isBasicAction && !isBreaker);
	// Muted pass runs after and overwrites vursCursed, exactly like the sheet.
	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated && !isBreaker);
	if (slug === "raise-a-shield") {
		setConditionDisabled(element, "muted", disableItems && !isBreaker);
		setConditionDisabled(element, "cursed", flags.isCursed && !isBreaker);
	}
	setConditionDisabled(
		element,
		"fatigued",
		flags.isFatigued && (isExplorationAction || traits.includes("exploration")) && !isBreaker
	);
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction) && !isBreaker);
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && !isBreaker && isDragonblightRowAffected(item, action, traits, false, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && !isBreaker && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && !isBreaker && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !isBreaker && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !isBreaker && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && !isBreaker && slug !== "recall-knowledge");
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && !isBreaker && item?.isOfType?.("action", "feat") && (isReaction || (isPassive && !itemIgnoresBroken(item)))
	);
}

// Feat rows mirror the sheet's feats-list selectors: muted/cursed (gated),
// fatigued, confused, dragonblight, broken. No movement/paralyzed/acting
// statuses — the sheet's feats tab is outside those containers.
function applyFeatRowConditions(element, actor, flags, damageTypes) {
	const { item, action, traits, slug } = hudRowContext(element, actor, "feat");
	const disableItems = flags.isMuted || flags.isCursed;
	const isAcquisitionGated = isAcquisitionGatedItem(item);
	const isReaction = hasReactionCost(item, traits);
	const isPassive = !item?.actionCost;
	const isDelayOrReady = ["delay", "ready"].includes(slug);
	const isBreaker = traits.includes("breaker");

	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration") && !isBreaker);
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction) && !isBreaker);
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && !isBreaker && isDragonblightRowAffected(item, action, traits, false, damageTypes)
	);
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && !isBreaker && (isReaction || (isPassive && !itemIgnoresBroken(item)))
	);
}

// Spell rows keep only item-level conditions; silenced/cursed/dragonblight and
// acting statuses are section-level (the whole spellcasting tab) and are
// applied by applyHudSectionStates.
function applySpellRowConditions(element, actor, flags, damageTypes) {
	const { item, action, traits, slug } = hudRowContext(element, actor, "spell");
	const disableItems = flags.isMuted || flags.isCursed;
	const isAcquisitionGated = isAcquisitionGatedItem(item);
	const isReaction = hasReactionCost(item, traits);
	const isDelayOrReady = ["delay", "ready"].includes(slug);
	const isBreaker = traits.includes("breaker");

	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration") && !isBreaker);
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction) && !isBreaker);
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && !isBreaker && isDragonblightRowAffected(item, action, traits, true, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && !isBreaker && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && !isBreaker && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !isBreaker && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !isBreaker && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && !isBreaker && slug !== "recall-knowledge");
}

// Skill actions (.item.statistic on the skills sidebar) get the same
// item-level predicates as action rows. Skill CHECKS (skill group headers,
// lore rows) are not actions and stay usable — matching how the sheet leaves
// skill checks alone under every condition.
function applySkillActionRowConditions(element, actor, flags, damageTypes) {
	const item = resolveHudSidebarItem(element);
	if (!item) {
		// Unresolvable compendium item: acting statuses still blanket actions.
		applyActingStatuses(element, flags);
		return;
	}
	const traits = getVursItemTraits(item);
	const slug = hudItemSlug(item, element);
	const isBasicAction = typeof slug === "string" && game.pf2e?.actions?.has(slug) === true;
	const disableItems = flags.isMuted || flags.isCursed;
	const isAcquisitionGated = isAcquisitionGatedItem(item);
	const isReaction = hasReactionCost(item, traits);
	const isPassive = !item.actionCost;
	const isDelayOrReady = ["delay", "ready"].includes(slug);
	const isBreaker = traits.includes("breaker");

	setConditionDisabled(element, "silenced", flags.isSilenced && !isBasicAction && !isBreaker);
	setConditionDisabled(element, "cursed", flags.isCursed && !isBasicAction && !isBreaker);
	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated && !isBreaker);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration") && !isBreaker);
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction) && !isBreaker);
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && !isBreaker && isDragonblightRowAffected(item, null, traits, false, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && !isBreaker && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && !isBreaker && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !isBreaker && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !isBreaker && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && !isBreaker && slug !== "recall-knowledge");
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && !isBreaker && (isReaction || (isPassive && !itemIgnoresBroken(item)))
	);
	applyActingStatuses(element, flags, true, isBreaker);
}

function applyHudCooldownChargeUp(root, actor) {
	const cooldownItemUuids = new Set(
		(actor.itemTypes?.effect ?? [])
			.map(effect => effect.getFlag?.("vurs-pf2e", "sourceItemUuid"))
			.filter(Boolean)
	);
	const combat = game.combat;
	const currentRound = combat?.started ? combat.round : 0;
	// Mirrors getDisableableActionItems: action/feat/spell rows only — strikes
	// ([data-index]) are excluded on the sheet too. Persistent-HUD shortcut
	// slots carry the same data-item-id/data-item-uuid payloads.
	const rowSelector = ".item.action[data-item-id], .item.feat[data-item-id], .item[data-item-type=\"spell\"][data-item-id], .shortcut[data-item-id]";
	for (const element of root.querySelectorAll(rowSelector)) {
		const item = actor.items?.get(element.dataset.itemId);
		if (!item) continue;
		applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound);
	}
	// Skills-sidebar actions and statistic shortcuts resolve to compendium
	// items via data-item-uuid.
	for (const element of root.querySelectorAll(".item.statistic[data-item-uuid], .shortcut[data-item-uuid]")) {
		const item = resolveHudSidebarItem(element);
		if (item) applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound);
	}
}

function applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound) {
	const traits = getVursItemTraits(item);
	const chargeUpTrait = traits.find(trait => /^charge-up-\d+$/.test(trait));
	const chargeUpRound = chargeUpTrait ? Number(chargeUpTrait.match(/\d+$/)?.[0]) : null;
	const frequencyDepleted = getVursItemFrequencyValue(item) === 0;
	setConditionDisabled(element, "cooldown", cooldownItemUuids.has(item.uuid) || frequencyDepleted);
	setConditionDisabled(
		element,
		"chargeUp",
		Boolean(game.combat) && Number.isInteger(chargeUpRound) && currentRound <= chargeUpRound
	);
}

const HUD_ITEM_ROW_SELECTOR = ".item[data-item-id], .item.statistic[data-item-uuid], .shortcut[data-item-uuid]";

function hudBreakerRowItem(actor, row) {
	const itemId = row?.dataset?.itemId;
	if (itemId) {
		const item = actor?.items?.get(itemId);
		if (item) return item;
	}
	const index = row?.dataset?.index;
	if (index !== undefined && index !== "") {
		const action = actor?.system?.actions?.[Number(index)];
		if (action?.item) return action.item;
	}
	return resolveHudSidebarItem(row);
}

// Tab-level conditions map to the sheet's .tab.spellcasting / .tab.actions
// containers. The HUD sidebar's .inner element is the equivalent wrapper —
// marking it produces ONE overlay + inert for the whole tab (headers, toggles
// and rows included), exactly like the sheet. Runs unconditionally so cleared
// conditions reset. Containers holding Breaker rows switch to mixed mode so
// those rows stay usable.
function applyHudTabStates(root, flags, actor, resolveItem = null) {
	const inner = root.querySelector(".inner");
	if (!inner) return;
	const sidebarType = hudSidebarType(root);
	if (!resolveItem) resolveItem = row => hudBreakerRowItem(actor, row);
	const tabCondition = (condition, active) =>
		setConditionDisabledWithBreakerExemption(inner, condition, active, actor, HUD_ITEM_ROW_SELECTOR, resolveItem);
	if (sidebarType === "spells") {
		// The whole spellcasting tab: silenced (also when cursed), cursed,
		// dragonblight and acting statuses.
		tabCondition("silenced", flags.isSilenced || flags.isCursed);
		tabCondition("cursed", flags.isCursed);
		tabCondition("dragonblight", flags.isDragonblight);
		for (const status of ACTING_STATUSES) tabCondition(status, statusFlag(flags, status));
	} else if (sidebarType === "actions") {
		// .tab.actions is acting-status-disabled as a whole on the sheet.
		for (const status of ACTING_STATUSES) tabCondition(status, statusFlag(flags, status));
	} else if (sidebarType === "skills") {
		// Can't act = staggered/unconscious/cantAct/incapacitated/petrified/
		// stunned — the whole skills tab goes inert, checks included.
		for (const status of ACTING_STATUSES) tabCondition(status, statusFlag(flags, status));
	}
}

// Section headers carry the visible overlay for SECTION-level conditions only
// (strikes/blasts attack flags, exploration/downtime fatigued, items muted/
// cursed). Tab-level conditions live on .inner via applyHudTabStates. Headers
// are chrome and never go inert — rows and .inner do the blocking.
function applyHudSectionHeaderStates(root, flags, actor) {
	const sidebarType = hudSidebarType(root);
	for (const header of root.querySelectorAll("header[data-filter-value]")) {
		if (sidebarType === "actions") {
			// The strikes/blasts headers ARE the attacks section — they carry the
			// attack-section conditions (disarm/cursed/restrained/paralyzed).
			if (header.classList.contains("strikes") || header.classList.contains("blasts")) {
				setConditionDisabled(header, "disarmed", flags.isDisarmed || flags.isCursed, false);
				setConditionDisabled(header, "cursed", flags.isCursed, false);
				setConditionDisabled(header, "restrained", flags.isRestrained, false);
				setConditionDisabled(header, "paralyzed", flags.isParalyzed, false);
			}
			if (flags.isFatigued && ["exploration", "downtime"].includes(header.dataset.filterValue)) {
				setConditionDisabled(header, "fatigued", true, false);
			}
		} else if (sidebarType === "items") {
			const disabled = !isHudEquipmentSection(header, actor);
			setConditionDisabled(header, "muted", disabled && (flags.isMuted || flags.isCursed), false);
			setConditionDisabled(header, "cursed", disabled && flags.isCursed, false);
		}
	}
}

function applyHudUtilityStates(root, flags) {
	// Speed control: movement conditions + acting statuses (mirrors the sheet's
	// applyMovementConditionToSpeed callers; restrained does not disable speed).
	const speedLink = root.querySelector('[data-section="speeds"]');
	for (const condition of SPEED_CONDITIONS) {
		setConditionDisabled(speedLink, condition, statusFlag(flags, condition));
	}

	// Main-HUD action links that correspond to sheet actions-tab actions.
	const raiseShield = root.querySelector('a[data-action="raise-shield"]');
	setConditionDisabled(raiseShield, "muted", flags.isMuted || flags.isCursed);
	setConditionDisabled(raiseShield, "cursed", flags.isCursed);

	for (const selector of ['a[data-action="take-cover"]', 'a[data-action="use-resolve"]']) {
		const link = root.querySelector(selector);
		applyActingStatuses(link, flags);
	}

	const changeSpeed = root.querySelector('a[data-action="change-speed"]');
	for (const condition of SPEED_CONDITIONS) {
		setConditionDisabled(changeSpeed, condition, statusFlag(flags, condition));
	}
}

// ---------------------------------------------------------------------------
// Persistent-HUD shortcut slots
//
// [data-panel="shortcuts"] renders .shortcut.item slots that none of the
// sidebar passes above match. Each slot's data-type maps to the same rules as
// its sidebar counterpart: strikes/blasts take the strikes section conditions,
// actions/feats/spells/skill actions take their row rules, consumables take
// the inventory muted/cursed rule, and equipment plus non-action utilities
// (macros, roll-option toggles, blast cost) stay usable — matching how the
// sheet leaves equipment sections and non-action UI alone.
// ---------------------------------------------------------------------------

function resolveHudShortcutItem(element, actor) {
	const itemId = element.dataset.itemId;
	if (itemId) {
		const item = actor.items?.get(itemId);
		if (item) return item;
	}
	return resolveHudSidebarItem(element);
}

function applyHudShortcutConditions(element, actor, flags, damageTypes) {
	const type = element.dataset.type;

	if (type === "strike" || type === "blast") {
		// Strike shortcuts carry the weapon's itemId; the strike action is
		// resolved through the same itemId → action map the sidebar uses.
		const { item, action, traits } = hudRowContext(element, actor, "strike");
		const exempt = traits.includes("breaker");
		setConditionDisabled(element, "disarmed", (flags.isDisarmed || flags.isCursed) && !exempt);
		setConditionDisabled(element, "cursed", flags.isCursed && !exempt);
		setConditionDisabled(element, "restrained", flags.isRestrained && !exempt);
		setConditionDisabled(element, "paralyzed", flags.isParalyzed && !exempt);
		setConditionDisabled(
			element,
			"dragonblight",
			flags.isDragonblight && !exempt && isDragonblightStrikeAffected(item, action, damageTypes)
		);
		applyActingStatuses(element, flags, true, exempt);
		return;
	}

	const exempt = itemHasBreakerTrait(resolveHudShortcutItem(element, actor));

	if (type === "action") {
		// The actions tab is acting-status disabled as a whole on the sheet.
		applyActionRowConditions(element, actor, flags, damageTypes);
		applyActingStatuses(element, flags, true, exempt);
	} else if (type === "feat" || type === "stance") {
		applyFeatRowConditions(element, actor, flags, damageTypes);
	} else if (type === "spell") {
		// Spellcasting tab conditions blanket every spell: silenced (also when
		// cursed), cursed, dragonblight and acting statuses.
		applySpellRowConditions(element, actor, flags, damageTypes);
		setConditionDisabled(element, "silenced", (flags.isSilenced || flags.isCursed) && !exempt);
		setConditionDisabled(element, "cursed", flags.isCursed && !exempt);
		setConditionDisabled(element, "dragonblight", flags.isDragonblight && !exempt);
		applyActingStatuses(element, flags, true, exempt);
	} else if (type === "skillAction" || type === "extraAction") {
		// Statistic shortcuts carry data-item-uuid — the sidebar-item resolver
		// and row rules apply unchanged (acting statuses included).
		applySkillActionRowConditions(element, actor, flags, damageTypes);
	} else if (type === "consumable") {
		setConditionDisabled(element, "muted", (flags.isMuted || flags.isCursed) && !exempt);
		setConditionDisabled(element, "cursed", flags.isCursed && !exempt);
	}
	// equipment / macro / toggle / blastCost: no disable rules.
}

// Stale disable markers: item/section labels (vursConditionLabel covers
// cooldown/charge-up too), section row flags, and breaker glow. Their absence
// proves every pass below would write false/no-op.
const HUD_DISABLE_MARKS = '[data-vurs-condition-label]:not([data-vurs-condition-label=""]), [data-vurs-sec-any="true"], .vurs-breaker-glow';

export function applyVursHudDisableStates(root, actor) {
	if (!root || !isVursSupportedActor(actor)) return;
	beginVursConditionPass();
	if (!actorHasVursDisableStates(actor) && !root.querySelector(HUD_DISABLE_MARKS)) return;
	const flags = getVursConditionFlags(actor);
	// Cooldown/charge-up are effect/trait driven and must run even with no
	// condition flags; every other item-level state early-outs when nothing is
	// active. The section-level pass always runs last so its inert computation
	// sees both item-level labels and section flags, and so cleared conditions
	// reset explicitly.
	applyHudCooldownChargeUp(root, actor);
	const hasConditionFlags = Object.values(flags).some(Boolean);
	// When the last condition clears, the item-level passes must still run once
	// with all-false flags — otherwise stale data-vurs-* labels/inert persist
	// (the section pass reads vursConditionLabel when recomputing inert).
	const hasStaleLabels = !hasConditionFlags &&
		root.querySelector('[data-vurs-condition-label]:not([data-vurs-condition-label=""])') !== null;
	if (hasConditionFlags || hasStaleLabels) {
		const damageTypes = flags.isDragonblight ? getDragonblightDamageTypes() : null;

		for (const strike of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
			applyStrikeConditions(strike, actor, flags, damageTypes);
		}
		// Blast rows carry data-item-id but no data-index; they are action items.
		for (const element of root.querySelectorAll('.item.attack[data-item-id]:not([data-index])')) {
			applyActionRowConditions(element, actor, flags, damageTypes);
		}
		for (const element of root.querySelectorAll(".item.action[data-item-id]")) {
			applyActionRowConditions(element, actor, flags, damageTypes);
		}
		for (const element of root.querySelectorAll(".item.feat[data-item-id]")) {
			applyFeatRowConditions(element, actor, flags, damageTypes);
		}
		for (const element of root.querySelectorAll('.item[data-item-type="spell"][data-item-id]')) {
			applySpellRowConditions(element, actor, flags, damageTypes);
		}
		if (hudSidebarType(root) === "skills") {
			for (const element of root.querySelectorAll(".item.statistic[data-item-uuid]")) {
				applySkillActionRowConditions(element, actor, flags, damageTypes);
			}
		}
		// Persistent-HUD shortcut slots (empty slots are .shortcut.empty and
		// carry no item payload, so .shortcut.item selects populated ones).
		for (const element of root.querySelectorAll(".shortcut.item")) {
			applyHudShortcutConditions(element, actor, flags, damageTypes);
		}
		applyHudUtilityStates(root, flags);
	}
	applyHudSectionHeaderStates(root, flags, actor);
	applyHudSectionStates(root, flags, actor);
	const breakerResolver = row => hudBreakerRowItem(actor, row);
	applyHudTabStates(root, flags, actor, breakerResolver);
	updateVursBreakerGlow(root, actor, HUD_ITEM_ROW_SELECTOR, breakerResolver);
}
