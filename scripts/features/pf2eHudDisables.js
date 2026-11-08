import {
	areDisabledFeaturesEnforced,
	getDragonblightDamageSources,
	getDragonblightDamageTypes,
	getVursConditionFlags,
	getVursItemSlug,
	getVursItemTraits,
	hasDragonblightActionTrait,
	hasDragonblightDamageTypeInValue,
	isAcquisitionGatedItem,
	isDragonblightStrikeAffected,
	itemIgnoresBroken,
	setConditionDisabled
} from "./disableConditions.js";

const ACTING_STATUSES = ["staggered", "unconscious", "cantAct", "incapacitated", "petrified", "stunned"];
const SPEED_CONDITIONS = ["rooted", "immobilized", "prone", "paralyzed", ...ACTING_STATUSES];
const EQUIPMENT_ITEM_TYPES = new Set(["weapon", "shield", "armor"]);
const statusFlag = (flags, status) => flags[`is${status[0].toUpperCase()}${status.slice(1)}`];

function isVursSupportedActor(actor) {
	return Boolean(actor?.isOfType?.("character") || actor?.isOfType?.("npc"));
}

function findHudAction(actor, itemId, index) {
	if (Number.isInteger(index)) {
		const byIndex = actor.system?.actions?.[index];
		if (byIndex) return byIndex;
	}
	if (itemId) {
		return actor.system?.actions?.find(action => action.item?.id === itemId) ?? null;
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

function applyActingStatuses(element, flags, disableInteraction = true) {
	for (const status of ACTING_STATUSES) {
		setConditionDisabled(element, status, statusFlag(flags, status), disableInteraction);
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

function setHudSectionCondition(element, condition, isDisabled) {
	if (!element) return;
	element.dataset[`vursSec${condition[0].toUpperCase()}${condition.slice(1)}`] = String(isDisabled);
	const secActive = Object.entries(element.dataset).some(([key, value]) =>
		key.startsWith("vursSec") && key !== "vursSecAny" && value === "true");
	element.dataset.vursSecAny = secActive ? "true" : "";
	const itemActive = (element.dataset.vursConditionLabel ?? "") !== "";
	const disabled = areDisabledFeaturesEnforced() && (secActive || itemActive);
	element.inert = disabled;
	if (disabled) element.setAttribute("aria-disabled", "true");
	else element.removeAttribute("aria-disabled");
}

function applyHudActingStatusSection(element, flags) {
	for (const status of ACTING_STATUSES) {
		setHudSectionCondition(element, status, statusFlag(flags, status));
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
function isHudEquipmentSection(header, actor) {
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

function applyHudSectionStates(root, flags, actor) {
	const sidebarType = hudSidebarType(root);
	if (sidebarType === "spells") {
		// Whole spellcasting tab: silenced (also when cursed), cursed,
		// dragonblight and acting statuses.
		for (const row of root.querySelectorAll('.item[data-item-type^="spell"][data-item-id]')) {
			setHudSectionCondition(row, "silenced", flags.isSilenced || flags.isCursed);
			setHudSectionCondition(row, "cursed", flags.isCursed);
			setHudSectionCondition(row, "dragonblight", flags.isDragonblight);
			applyHudActingStatusSection(row, flags);
		}
	} else if (sidebarType === "actions") {
		// Strikes list: disarmed (also when cursed), cursed, restrained,
		// paralyzed and acting statuses blanket every strike row.
		for (const row of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
			setHudSectionCondition(row, "disarmed", flags.isDisarmed || flags.isCursed);
			setHudSectionCondition(row, "cursed", flags.isCursed);
			setHudSectionCondition(row, "restrained", flags.isRestrained);
			setHudSectionCondition(row, "paralyzed", flags.isParalyzed);
			applyHudActingStatusSection(row, flags);
		}
		// .tab.actions disables the whole actions tab for acting statuses —
		// blast rows and regular action rows included.
		for (const row of root.querySelectorAll('.item.attack[data-item-id]:not([data-index]), .item.action[data-item-id]')) {
			applyHudActingStatusSection(row, flags);
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
				setHudSectionCondition(row, "muted", flags.isMuted || flags.isCursed);
				setHudSectionCondition(row, "cursed", flags.isCursed);
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
	const { item, action } = hudRowContext(element, actor, "strike");

	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && isDragonblightStrikeAffected(item, action, damageTypes)
	);

	const disableItems = flags.isMuted || flags.isCursed;
	for (const button of element.querySelectorAll('.variant.auxiliary[data-auxiliary-action-index]')) {
		const auxiliary = action?.auxiliaryActions?.[Number(button.dataset.auxiliaryActionIndex)];
		if (auxiliary?.action !== "raise-a-shield" && auxiliary?.action !== "parry") continue;
		setConditionDisabled(button, "muted", disableItems);
		setConditionDisabled(button, "cursed", flags.isCursed);
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

	// Silenced/cursed pass (mirrors applySilencedState: basic actions exempt).
	setConditionDisabled(element, "silenced", flags.isSilenced && !isBasicAction);
	setConditionDisabled(element, "cursed", flags.isCursed && !isBasicAction);
	// Muted pass runs after and overwrites vursCursed, exactly like the sheet.
	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated);
	if (slug === "raise-a-shield") {
		setConditionDisabled(element, "muted", disableItems);
		setConditionDisabled(element, "cursed", flags.isCursed);
	}
	setConditionDisabled(
		element,
		"fatigued",
		flags.isFatigued && (isExplorationAction || traits.includes("exploration"))
	);
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction));
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && isDragonblightRowAffected(item, action, traits, false, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && slug !== "recall-knowledge");
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && item?.isOfType?.("action", "feat") && (isReaction || (isPassive && !itemIgnoresBroken(item)))
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

	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration"));
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction));
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && isDragonblightRowAffected(item, action, traits, false, damageTypes)
	);
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && (isReaction || (isPassive && !itemIgnoresBroken(item)))
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

	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration"));
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction));
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && isDragonblightRowAffected(item, action, traits, true, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && slug !== "recall-knowledge");
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

	setConditionDisabled(element, "silenced", flags.isSilenced && !isBasicAction);
	setConditionDisabled(element, "cursed", flags.isCursed && !isBasicAction);
	setConditionDisabled(element, "muted", disableItems && isAcquisitionGated);
	setConditionDisabled(element, "cursed", flags.isCursed && isAcquisitionGated);
	setConditionDisabled(element, "fatigued", flags.isFatigued && traits.includes("exploration"));
	setConditionDisabled(element, "confused", flags.isConfused && (isDelayOrReady || isReaction));
	setConditionDisabled(
		element,
		"dragonblight",
		flags.isDragonblight && isDragonblightRowAffected(item, null, traits, false, damageTypes)
	);
	setConditionDisabled(element, "rooted", flags.isRooted && traits.some(trait => ["move", "traversal", "teleportation"].includes(trait)));
	setConditionDisabled(element, "immobilized", flags.isImmobilized && traits.includes("move"));
	setConditionDisabled(element, "prone", flags.isProne && !["crawl", "stand"].includes(slug) && traits.includes("move"));
	setConditionDisabled(
		element,
		"restrained",
		flags.isRestrained && !["escape", "force-open"].includes(slug) && traits.some(trait => ["attack", "manipulate"].includes(trait))
	);
	setConditionDisabled(element, "paralyzed", flags.isParalyzed && slug !== "recall-knowledge");
	setConditionDisabled(
		element,
		"broken",
		flags.isBroken && (isReaction || (isPassive && !itemIgnoresBroken(item)))
	);
	applyActingStatuses(element, flags);
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
	// ([data-index]) are excluded on the sheet too.
	const rowSelector = ".item.action[data-item-id], .item.feat[data-item-id], .item[data-item-type=\"spell\"][data-item-id]";
	for (const element of root.querySelectorAll(rowSelector)) {
		const item = actor.items?.get(element.dataset.itemId);
		if (!item) continue;
		applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound);
	}
	// Skills-sidebar actions resolve to compendium items via data-item-uuid.
	for (const element of root.querySelectorAll(".item.statistic[data-item-uuid]")) {
		const item = resolveHudSidebarItem(element);
		if (item) applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound);
	}
}

function applyCooldownChargeUpToItem(element, item, cooldownItemUuids, currentRound) {
	const traits = getVursItemTraits(item);
	const chargeUpTrait = traits.find(trait => /^charge-up-\d+$/.test(trait));
	const chargeUpRound = chargeUpTrait ? Number(chargeUpTrait.match(/\d+$/)?.[0]) : null;
	setConditionDisabled(element, "cooldown", cooldownItemUuids.has(item.uuid));
	setConditionDisabled(
		element,
		"chargeUp",
		Boolean(game.combat) && Number.isInteger(chargeUpRound) && currentRound <= chargeUpRound
	);
}

// Tab-level conditions map to the sheet's .tab.spellcasting / .tab.actions
// containers. The HUD sidebar's .inner element is the equivalent wrapper —
// marking it produces ONE overlay + inert for the whole tab (headers, toggles
// and rows included), exactly like the sheet. Runs unconditionally so cleared
// conditions reset.
function applyHudTabStates(root, flags) {
	const inner = root.querySelector(".inner");
	if (!inner) return;
	const sidebarType = hudSidebarType(root);
	if (sidebarType === "spells") {
		// The whole spellcasting tab: silenced (also when cursed), cursed,
		// dragonblight and acting statuses.
		setConditionDisabled(inner, "silenced", flags.isSilenced || flags.isCursed);
		setConditionDisabled(inner, "cursed", flags.isCursed);
		setConditionDisabled(inner, "dragonblight", flags.isDragonblight);
		applyActingStatuses(inner, flags);
	} else if (sidebarType === "actions") {
		// .tab.actions is acting-status-disabled as a whole on the sheet.
		applyActingStatuses(inner, flags);
	} else if (sidebarType === "skills") {
		// Can't act = staggered/unconscious/cantAct/incapacitated/petrified/
		// stunned — the whole skills tab goes inert, checks included.
		applyActingStatuses(inner, flags);
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

export function applyVursHudDisableStates(root, actor) {
	if (!root || !isVursSupportedActor(actor)) return;
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
		applyHudUtilityStates(root, flags);
	}
	applyHudSectionHeaderStates(root, flags, actor);
	applyHudSectionStates(root, flags, actor);
	applyHudTabStates(root, flags);
}
