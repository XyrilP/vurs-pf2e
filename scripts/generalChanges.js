import {
	getActiveDamageActorForVurs,
	installActorDamageActionContext,
	installDicelessPatches
} from "./features/diceless.js";
import { installVursCriticalDamage } from "./features/vursCriticalDamage.js";
import { appendVursPlayCostIcons } from "./features/playCostIcons.js";
import {
	normalizeVursPlayCost,
	replaceVursPlayCostToken,
	replaceVursPlayCostTokensOnActorSheet,
	replaceVursPlayResourceTokens,
	resolveVursPlayCostRolls
} from "./features/vursTextTokens.js";
import {
	hardResetActorPlayResources,
	hasVursPlayResourcesDrawer,
	refreshVursPlayResourcesDrawer,
	renderVursPlayResourcesDrawer
} from "./features/playResources.js";
import "./features/pf2eHud.js";
import {
	getVursBaseMaxHp,
	getVursMaxHpReduction,
	getVursStoredMaxHpReduction
} from "./features/vursHp.js";
import {
	actorHasVursDisableStates,
	areDisabledFeaturesEnforced,
	getBrokenConditionFlag,
	getDragonblightDamageSources,
	getDragonblightDamageTypes,
	getDragonblightDamageTypesFromValue,
	hasDragonblightActionTrait,
	hasDragonblightDamageTraitInValue,
	hasDragonblightDamageTypeInValue,
	isAcquisitionGatedItem,
	isDragonblightStrikeAffected,
	isDragonblightTrait,
	itemHasBreakerTrait,
	itemIgnoresBroken,
	ruleEnablesBroken,
	ruleEnablesVursCondition,
	beginVursConditionPass,
	getVursConditionFlags,
	getVursConditionPassGeneration,
	getVursConditionPresenceKeys,
	setConditionButtonDisabled,
	setConditionDisabled,
	setConditionDisabledWithBreakerExemption,
	updateVursBreakerGlow
} from "./features/disableConditions.js";
import {
	addNpcConfigurationButton,
	addNpcPrepareDerivedDataHandler,
	renderNpcRelationshipStatistics
} from "./features/npcConfiguration.js";
import {
	addNpcRestButton,
	installNpcSheetActions
} from "./features/npcSheetActions.js";
import { applyFullVursSkillAttributes, applyVursHitPoints } from "./features/modes/fullVurs.js";
import { applyAgnosticVursSkillAttributes } from "./features/modes/agnosticVurs.js";
import {
	addMainAttributeBuilderControl,
	addMainAttributeIndicator,
	applyMainAttributeBoost,
	applyMainAttributeToStrike,
	getMainAttribute,
	registerMainAttributeDamageModifiers
} from "./features/mainAttribute.js";
import {
	applyVursConsolidatedSkillAttributes,
	applyVursStatisticSkillMirrors,
	addVursExtendedSaveRows,
	hideVursPerceptionSidebarSection,
	relabelVursDexteritySkill,
	relabelVursCoreSkills,
	linkVursStatisticSkillControls,
	groupVursSkillsByAttribute,
	nestVursConsolidatedSkills,
	colorVursAttributeModifierFrames
} from "./features/consolidatedSkills.js";
import {
	actorHasAgnosticSystemFlag,
	actorHasDicelessFlag,
	actorHasVursSystemFlag,
	actorUsesAgnosticVurs,
	actorUsesDicelessRolls,
	actorUsesMainAttribute,
	actorUsesVursHpRules,
	actorUsesVursSystem,
	getActorSystemMode,
	isAgnosticVursMode,
	getSystemMode,
	isAnyVursMode,
	isFullVursMode
} from "./features/systemModes.js";

const MODULE_ID = "vurs-pf2e";
const DRAGONBLIGHT_DAMAGE_SOURCE_OPTION = "vurs:dragonblight-damage-source";
const VURS_UNDO_ACTIVE = Symbol("vurs-pf2e.undoDamageActive");
const VURS_IWR_TEST_PATCH = Symbol("vurs-pf2e.iwrTestPatch");
const VURS_IWR_INSTANCE_TEST_PATCH = Symbol("vurs-pf2e.iwrInstanceTestPatch");
const VURS_SPECIAL_IWR_RULE_PATCH = Symbol("vurs-pf2e.specialIwrRulePatch");
const VURS_SPECIAL_DAMAGE_SELECTOR_METHOD_PATCH = Symbol("vurs-pf2e.specialDamageSelectorMethodPatch");
const VURS_SPECIAL_DAMAGE_RULE_PREDICATE = Symbol("vurs-pf2e.specialDamageRulePredicate");
const VURS_DRAGONBLIGHT_DAMAGE_DIALOG_PATCH = Symbol("vurs-pf2e.dragonblightDamageDialogPatch");
const VURS_PLAY_COST_REFRESH_PATCH = Symbol("vurs-pf2e.playCostRefreshPatch");
const VURS_BROKEN_PASSIVE_RULE_PATCH = Symbol("vurs-pf2e.brokenPassiveRulePatch");
const VURS_DRAGONBLIGHT_RULE_PATCH = Symbol("vurs-pf2e.dragonblightRulePatch");
const VURS_MUTED_ITEM_RULE_PATCH = Symbol("vurs-pf2e.mutedItemRulePatch");
const VURS_MUTED_PHYSICAL_RULE_PATCH = Symbol("vurs-pf2e.mutedPhysicalRulePatch");
const VURS_MUTED_EQUIPPED_PATCH = Symbol("vurs-pf2e.mutedEquippedPatch");
const VURS_MUTED_INVESTED_PATCH = Symbol("vurs-pf2e.mutedInvestedPatch");
const VURS_ORIGINAL_EQUIPPED_GETTER = Symbol("vurs-pf2e.originalEquippedGetter");
let specialDamageDomainHookInstalled = false;

const VURS_ABILITY_LABELS = {
	str: "Strength",
	dex: "Agility",
	con: "Wealth",
	int: "Intelligence",
	wis: "Spirit",
	cha: "Void"
};
const VURS_TRANSLATIONS = {
	"PF2E.AbilityStr": "Strength",
	"PF2E.AbilityDex": "Agility",
	"PF2E.AbilityCon": "Wealth",
	"PF2E.AbilityInt": "Intelligence",
	"PF2E.AbilityWis": "Spirit",
	"PF2E.AbilityCha": "Void",
	"PF2E.AbilityCheck.str": "Strength Check",
	"PF2E.AbilityCheck.dex": "Agility Check",
	"PF2E.AbilityCheck.con": "Wealth Check",
	"PF2E.AbilityCheck.int": "Intelligence Check",
	"PF2E.AbilityCheck.wis": "Spirit Check",
	"PF2E.AbilityCheck.cha": "Void Check",
	"PF2E.AbilityId.str": "Str",
	"PF2E.AbilityId.dex": "Agi",
	"PF2E.AbilityId.con": "Wea",
	"PF2E.AbilityId.int": "Int",
	"PF2E.AbilityId.wis": "Spi",
	"PF2E.AbilityId.cha": "Voi"
};
const DEFAULT_ABILITY_TRANSLATIONS = Object.freeze({
	"PF2E.AbilityStr": "Strength",
	"PF2E.AbilityDex": "Dexterity",
	"PF2E.AbilityCon": "Constitution",
	"PF2E.AbilityInt": "Intelligence",
	"PF2E.AbilityWis": "Wisdom",
	"PF2E.AbilityCha": "Charisma",
	"PF2E.AbilityCheck.str": "Strength Check",
	"PF2E.AbilityCheck.dex": "Dexterity Check",
	"PF2E.AbilityCheck.con": "Constitution Check",
	"PF2E.AbilityCheck.int": "Intelligence Check",
	"PF2E.AbilityCheck.wis": "Wisdom Check",
	"PF2E.AbilityCheck.cha": "Charisma Check",
	"PF2E.AbilityId.str": "Str",
	"PF2E.AbilityId.dex": "Dex",
	"PF2E.AbilityId.con": "Con",
	"PF2E.AbilityId.int": "Int",
	"PF2E.AbilityId.wis": "Wis",
	"PF2E.AbilityId.cha": "Cha"
});
const originalTranslations = new Map();
const registeredActorWrappers = new Set();
let actorCreationHookInstalled = false;
let rollPatchRetryTimer = null;

// The module's en-registered vurs.json pre-overrides these keys with VURS
// names, so a captured "original" equal to the VURS text is not a real
// original. Missing keys (for example under the vurs language) fall back to
// canonical PF2e English values as well.
function resolveDefaultAbilityTranslation(path) {
	const captured = originalTranslations.get(path);
	if (typeof captured === "string" && captured.length > 0 && captured !== VURS_TRANSLATIONS[path]) {
		return captured;
	}
	return DEFAULT_ABILITY_TRANSLATIONS[path] ?? captured;
}

function localizeDefaultAbility(key) {
	const original = resolveDefaultAbilityTranslation(key);
	if (typeof original === "string" && original.length > 0) return original;
	const standardLabels = {
		"PF2E.AbilityStr": "Strength",
		"PF2E.AbilityDex": "Dexterity",
		"PF2E.AbilityCon": "Constitution",
		"PF2E.AbilityInt": "Intelligence",
		"PF2E.AbilityWis": "Wisdom",
		"PF2E.AbilityCha": "Charisma"
	};
	return standardLabels[key] ?? game.i18n.localize(key);
}

Hooks.once("init", registerCustomIwrTypes);

// Roll classes are available during setup. Wait for PF2e's systemReady hook
// before patching actors: its document classes are still being assembled in
// setup, and an early wrapper can mark the base Actor class before PF2e adds
// its preparation methods.
Hooks.once("setup", () => {
	installDicelessPatches();
});
// PF2e emits this after its document classes, synthetics, and configuration
// are ready, but before the first character sheet is prepared.
Hooks.once("pf2e.systemReady", () => {
	registerVursCharacterPreparationWrappers();
	registerVursNpcPreparationWrappers();
	installVursDeathStateGetterPatches();
	installBrokenPassiveRuleSuppression();
	installDragonblightRuleSuppression();
	installMutedItemRuleSuppression();
	installMutedUnequippedItems();
	installCustomDamageIwrPatch();
	installSystemPatches();
	installActorPreparationSupport(false);
	applySystemMode();
});
Hooks.once("ready", () => {
	updateDisabledFeaturesPresentation();
	registerVursCharacterPreparationWrappers();
	registerVursNpcPreparationWrappers();
	installVursDeathStateGetterPatches();
	installBrokenPassiveRuleSuppression();
	installDragonblightRuleSuppression();
	installMutedItemRuleSuppression();
	installMutedUnequippedItems();
	installCustomDamageIwrPatch();
	installActorPreparationSupport(false);
	applySystemMode();
	installDicelessPatches();
	// A bounded retry covers PF2e builds that expose Check or the Dice Roll
	// class after setup. Stop as soon as both wrappers are in place.
	if (rollPatchRetryTimer) clearInterval(rollPatchRetryTimer);
	let attempts = 0;
	rollPatchRetryTimer = setInterval(() => {
		attempts++;
		installDicelessPatches();
		const Roll = foundry.dice?.Roll ?? globalThis.Roll;
		const checkReady = Boolean(game.pf2e?.Check?.__vursCheckRollInstalled);
		const diceReady = Boolean(Roll?.prototype?.__vursRollEvaluationInstalled && foundry.dice?.terms?.Die?.prototype?.__vursResultInstalled);
		// Keep checking briefly even after the first successful install: PF2e may
		// replace its Check facade once the remaining system startup completes.
		if (attempts >= 25 || (attempts >= 10 && checkReady && diceReady)) {
			clearInterval(rollPatchRetryTimer);
			rollPatchRetryTimer = null;
		}
	}, 200);
});
Hooks.once("ready", migrateLegacyVursActorFlags);
Hooks.on("vurs-pf2e.systemModeChanged", mode => {
	applySystemMode(mode);
	void hardResetAllActorPlayResources();
});

async function hardResetAllActorPlayResources() {
	const actors = new Set([
		...(game.actors?.contents ?? []),
		game.user?.character
	].filter(Boolean));
	for (const actor of actors) {
		try {
			await hardResetActorPlayResources(actor);
		} catch (error) {
			console.error(`vurs-pf2e | Failed to reset Play resources for ${actor.name} after system mode change`, error);
		}
	}
	await game.settings.set(MODULE_ID, "lastAppliedSystemMode", getSystemMode());
}

// If the world was saved under a different system mode than the one that last
// ran (for example, the mode changed while the world was closed), rebuild all
// actor Play resources once on load. Actors without stored Play resource data
// are skipped by the helper.
Hooks.once("ready", () => {
	const currentMode = getSystemMode();
	const lastMode = game.settings.get(MODULE_ID, "lastAppliedSystemMode");
	if (lastMode && lastMode !== currentMode) {
		void hardResetAllActorPlayResources();
	} else if (!lastMode) {
		void game.settings.set(MODULE_ID, "lastAppliedSystemMode", currentMode);
	}
});
// The active canvas can create synthetic token actors after `ready`. Reprepare
// them when it finishes so their first rendered sheet already has VURS data.
Hooks.on("canvasReady", refreshCanvasActors);
Hooks.once("ready", () => {
	for (const actor of game.actors?.contents ?? []) {
		// Seed the Downed candidates so effects applied before this session are
		// still cleaned up without scanning every actor on each update.
		if (getActorEffectItems(actor).some(item => item.flags?.vurs?.downedEffect === true)) {
			vursDownedCandidates.add(actor);
		}
		syncVursConditionFlags(actor);
		stripVursDeathConditions(actor);
		void enforceVursDownedEffect(actor);
		clearVursNpcHpReduction(actor);
	}
});
// VURS Negative HP rules replace PF2e's Dying/Wounded conditions entirely.
// Strip them whenever they appear on an actor using the rules, whether added
// by damage, a macro, or a pre-existing character sheet.
const VURS_SUPPRESSED_DEATH_CONDITIONS = new Set(["dying", "wounded"]);
function stripVursDeathConditions(actor) {
	if (!actorUsesVursHpRules(actor)) return;
	// Only condition-type items can match — itemTypes.condition is a tiny
	// subset, avoiding a full collection scan on every actor update.
	const conditions = actor?.itemTypes?.condition ?? actor?.items?.filter(item => item.isOfType?.("condition")) ?? [];
	const suppressed = conditions.filter(item => VURS_SUPPRESSED_DEATH_CONDITIONS.has(item.slug));
	if (!suppressed.length) return;
	actor.deleteEmbeddedDocuments("Item", suppressed.map(item => item.id))
		.catch(error => console.error(`${MODULE_ID} | Failed to remove ${suppressed[0].slug} under VURS HP rules`, error));
}
// NPCs no longer use the Negative HP rules, but actors damaged while the rules
// still applied may carry a stale max-HP reduction flag. Remove it so it cannot
// resurface if the rules are ever re-enabled for NPCs.
function clearVursNpcHpReduction(actor) {
	if (!actor?.isOfType?.("npc")) return;
	const hasFlag = foundry.utils.getProperty(actor, "flags.vurs.hp.maxReduction") !== undefined ||
		foundry.utils.getProperty(actor, "_source.flags.vurs.hp.maxReduction") !== undefined;
	if (!hasFlag) return;
	actor.update({
		"flags.vurs.hp.maxReduction": new foundry.data.operators.ForcedDeletion()
	}, { render: false }).catch(error =>
		console.error(`${MODULE_ID} | Failed to clear NPC HP reduction`, error));
}
Hooks.on("updateActor", actor => {
	stripVursDeathConditions(actor);
	void enforceVursDownedEffect(actor);
	clearVursNpcHpReduction(actor);
});
Hooks.on("createItem", item => {
	if (!item?.isOfType?.("condition") || !VURS_SUPPRESSED_DEATH_CONDITIONS.has(item?.slug)) return;
	const actor = item.parent ?? item.actor;
	if (!actorUsesVursHpRules(actor)) return;
	item.delete().catch(error => console.error(`${MODULE_ID} | Failed to suppress ${item.slug} under VURS HP rules`, error));
});
// Long rest removes the max-HP reduction completely. PF2e's native character
// rest and the module's NPC rest both emit this hook.
Hooks.on("pf2e.restForTheNight", actor => {
	if (!actorUsesVursHpRules(actor)) return;
	// PF2e restores HP against the still-reduced max before this hook runs, so
	// clear the reduction first, then top HP back up by the cleared amount now
	// that the full maximum is available again.
	const reduction = Math.max(0, Number(getVursStoredMaxHpReduction(actor)) || 0);
	actor.update({
		"flags.vurs.hp.maxReduction": new foundry.data.operators.ForcedDeletion()
	}).then(() => {
		if (reduction <= 0) return null;
		const hp = actor.system?.attributes?.hp;
		const value = Number(hp?.value) || 0;
		const topUp = Math.min(reduction, Math.max(0, (Number(hp?.max) || 0) - value));
		return topUp > 0 ? actor.update({ "system.attributes.hp.value": value + topUp }) : null;
	}).catch(error => console.error(`${MODULE_ID} | Failed to clear HP reduction on rest`, error));
});
// A successful Treat Wounds also removes the max-HP reduction. PF2e posts the
// healing as a separate chat card that inherits the check's treatWoundsMacroFlag
// and origin link; only successful outcomes produce the "Healing Roll" flavor
// (critical failure posts a "Damage Roll" instead). Track those cards and match
// applied healing amounts against their totals in the applyDamage wrapper.
const VURS_TREAT_WOUNDS_HEAL_TTL = 5 * 60 * 1000;
const vursTreatWoundsHeals = new Map();
Hooks.on("createChatMessage", message => {
	const flags = message?.flags?.pf2e;
	if (!flags?.treatWoundsMacroFlag || !flags?.origin?.messageId) return;
	const treatWoundsLabel = game.i18n.localize("PF2E.Actions.TreatWounds.Rolls.TreatWounds");
	if (!message.flavor?.includes(treatWoundsLabel)) return;
	const total = Number(message.rolls?.[0]?.total);
	if (!Number.isFinite(total) || total <= 0) return;
	const now = Date.now();
	for (const [id, entry] of vursTreatWoundsHeals) {
		if (now - entry.createdAt > VURS_TREAT_WOUNDS_HEAL_TTL) vursTreatWoundsHeals.delete(id);
	}
	vursTreatWoundsHeals.set(message.id, {
		total,
		outcome: flags.context?.outcome ?? null,
		createdAt: now
	});
	if (vursTreatWoundsHeals.size > 50) {
		const oldest = [...vursTreatWoundsHeals.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
		if (oldest) vursTreatWoundsHeals.delete(oldest[0]);
	}
});
function matchVursTreatWoundsHeal(amount, outcome) {
	const now = Date.now();
	for (const [id, entry] of vursTreatWoundsHeals) {
		if (now - entry.createdAt > VURS_TREAT_WOUNDS_HEAL_TTL) {
			vursTreatWoundsHeals.delete(id);
			continue;
		}
		if (entry.outcome && outcome && entry.outcome !== outcome) continue;
		for (const multiplier of [0.5, 1, 2, 3]) {
			if (Math.abs(amount - entry.total * multiplier) < 0.5) return true;
		}
	}
	return false;
}

// The configured Downed effect is applied while an actor under Negative HP
// rules sits at 0 HP and removed once healed above it. Only items this feature
// applied (flagged flags.vurs.downedEffect) are ever removed, so manually
// applied copies of the same effect are left alone.
const VURS_DOWNED_BUSY = new WeakSet();
// Actors that may carry an applied Downed effect. Lets the per-updateActor
// check skip the item scan entirely for the vast majority of updates.
const vursDownedCandidates = new WeakSet();
const VURS_DOWNED_EFFECT_UUID = "Compendium.vurs-pf2e.vurs-effects.Item.4gFFVIejnvRuRpOF";
// Cache the resolved compendium source per UUID so actors sitting at 0 HP do not
// refetch it on every actor update. Only successful resolutions are cached, so a
// compendium that loads later can still resolve on a subsequent update.
const vursDownedSourceCache = new Map();
async function resolveVursDownedSource(uuid) {
	if (vursDownedSourceCache.has(uuid)) return vursDownedSourceCache.get(uuid);
	const source = await fromUuid(uuid);
	if (source) vursDownedSourceCache.set(uuid, source);
	return source;
}
// The Downed source is an "effect" — restricting the scan to effect-type items
// avoids a full collection scan on every actor update.
function getActorEffectItems(actor) {
	return actor?.itemTypes?.effect ?? actor?.items?.filter(item => item.type === "effect") ?? [];
}
async function enforceVursDownedEffect(actor) {
	if (!actor?.items || VURS_DOWNED_BUSY.has(actor)) return;
	const usesVursHp = actorUsesVursHpRules(actor);
	const tracked = vursDownedCandidates.has(actor);
	const atZeroHp = Number(actor.system?.attributes?.hp?.value) <= 0;
	// Fast path: an untracked actor can't carry the effect, so the only work
	// left is applying it — which requires VURS HP rules and 0 HP.
	if (!tracked && !(usesVursHp && atZeroHp)) return;
	try {
		const uuid = String(game.settings.get(MODULE_ID, "downedEffectUuid") ?? "").trim() || VURS_DOWNED_EFFECT_UUID;
		const effectItems = getActorEffectItems(actor);
		const applied = effectItems.filter(item => item.flags?.vurs?.downedEffect === true);
		if (!usesVursHp || !uuid || !atZeroHp) {
			if (applied.length) {
				await actor.deleteEmbeddedDocuments("Item", applied.map(item => item.id));
			}
			vursDownedCandidates.delete(actor);
			return;
		}
		if (applied.length) {
			vursDownedCandidates.add(actor);
			return;
		}

		const source = await resolveVursDownedSource(uuid);
		if (!source) {
			console.warn(`${MODULE_ID} | Downed Effect UUID did not resolve: ${uuid}`);
			return;
		}
		// Avoid duplicating an effect the actor already carries under another
		// application path (same type and name).
		if (effectItems.some(item => item.type === source.type && item.name === source.name)) return;

		VURS_DOWNED_BUSY.add(actor);
		try {
			const data = source.toObject();
			delete data._id;
			delete data.folder;
			delete data.sort;
			data.flags ??= {};
			data.flags.vurs = { ...(data.flags.vurs ?? {}), downedEffect: true };
			await actor.createEmbeddedDocuments("Item", [data]);
			vursDownedCandidates.add(actor);
		} finally {
			VURS_DOWNED_BUSY.delete(actor);
		}
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to enforce Downed effect`, error);
	}
}
Hooks.on("canvasReady", () => {
	for (const token of canvas.tokens?.placeables ?? []) {
		if (token.actor) syncVursConditionFlags(token.actor);
	}
});
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
	Hooks.on(hook, syncVursConditionFlagsFromItem);
	Hooks.on(hook, refreshCooldownChargeUpStateFromItem);
}
Hooks.on("updateItem", refreshBrokenStateFromItem);
Hooks.on("updateCombat", (combat, changes) => {
	// Cooldowns only tick on turn/round changes; lifecycle is covered by the
	// createCombat/deleteCombat hooks. This avoids rescanning every actor and
	// token on unrelated combat updates.
	if (changes?.turn === undefined && changes?.round === undefined) return;
	refreshCooldownChargeUpStateForOpenSheets();
});
Hooks.on("createCombat", refreshCooldownChargeUpStateForOpenSheets);
Hooks.on("deleteCombat", refreshCooldownChargeUpStateForOpenSheets);
// Register this before the first ApplicationV2 render. The builder may be
// opened before ready-time actor preparation finishes.

function isSupportedVursActor(actor) {
	return Boolean(
		actor?.isOfType?.("character") ||
		actor?.isOfType?.("npc")
	);
}

function updateDisabledFeaturesPresentation() {
	globalThis.document?.body?.classList.toggle("vurs-disabled-features-unenforced", !areDisabledFeaturesEnforced());
}

function hasMutedOrCursedCondition(actor, rules = null) {
	if (!isSupportedVursActor(actor)) return false;
	const presence = getVursConditionPresenceKeys(actor);
	if (presence.has("muted") || presence.has("cursed")) return true;
	if ([
		foundry.utils.getProperty(actor, "flags.vurs.conditions.isMuted"),
		foundry.utils.getProperty(actor, "flags.vurs.conditions.isCursed")
	].some(value => [1, "1", true].includes(value))) {
		return true;
	}
	if (!rules) return false;
	return rules.some(rule =>
		ruleEnablesVursCondition(rule, actor, "isMuted") ||
		ruleEnablesVursCondition(rule, actor, "isCursed")
	);
}

function installMutedUnequippedItems() {
	const shieldPrototype = CONFIG.PF2E?.Item?.documentClasses?.shield?.prototype;
	let physicalItemPrototype = shieldPrototype;
	while (physicalItemPrototype && !Object.hasOwn(physicalItemPrototype, "isEquipped")) {
		physicalItemPrototype = Object.getPrototypeOf(physicalItemPrototype);
	}
	if (!physicalItemPrototype) return;

	installMutedPhysicalItemRuleSuppression(physicalItemPrototype);

	const prototypes = new Set([physicalItemPrototype]);
	for (const ItemClass of Object.values(CONFIG.PF2E?.Item?.documentClasses ?? {})) {
		const prototype = ItemClass?.prototype;
		if (!prototype || !physicalItemPrototype.isPrototypeOf(prototype)) continue;
		if (
			Object.hasOwn(prototype, "isEquipped") ||
			Object.hasOwn(prototype, "isInvested")
		) {
			prototypes.add(prototype);
		}
	}

	for (const prototype of prototypes) {
		if (!prototype[VURS_MUTED_EQUIPPED_PATCH]) {
			const equippedDescriptor = Object.getOwnPropertyDescriptor(prototype, "isEquipped");
			if (typeof equippedDescriptor?.get === "function") {
				Object.defineProperty(prototype, VURS_ORIGINAL_EQUIPPED_GETTER, {
					value: equippedDescriptor.get
				});
				Object.defineProperty(prototype, "isEquipped", {
					...equippedDescriptor,
					get() {
						const isEquipped = equippedDescriptor.get.call(this);
						if (
							!isEquipped ||
							!areDisabledFeaturesEnforced() ||
							!hasMutedOrCursedCondition(this.actor)
						) return isEquipped;
						if (["weapon", "shield", "armor"].some(type => this.isOfType?.(type))) {
							return isEquipped;
						}
						return false;
					}
				});
				Object.defineProperty(prototype, VURS_MUTED_EQUIPPED_PATCH, { value: true });
			}
		}

		if (!prototype[VURS_MUTED_INVESTED_PATCH]) {
			const investedDescriptor = Object.getOwnPropertyDescriptor(prototype, "isInvested");
			if (typeof investedDescriptor?.get === "function") {
				Object.defineProperty(prototype, "isInvested", {
					...investedDescriptor,
					get() {
						const isInvested = investedDescriptor.get.call(this);
						if (
							isInvested !== false ||
							!hasMutedOrCursedCondition(this.actor) ||
							["weapon", "shield", "armor"].some(type => this.isOfType?.(type))
						) {
							return isInvested;
						}
						return wasInvestedBeforeMuted(this) ? true : isInvested;
					}
				});
				Object.defineProperty(prototype, VURS_MUTED_INVESTED_PATCH, { value: true });
			}
		}
	}
}

function wasInvestedBeforeMuted(item) {
	const traits = foundry.utils.getProperty(item, "system.traits.value");
	if (
		!Array.isArray(traits) ||
		!traits.includes("invested") ||
		item.isStowed ||
		!item.isIdentified ||
		item.system.equipped.invested !== true
	) {
		return false;
	}

	const equippedGetter = getOriginalEquippedGetter(item);
	const wasEquipped = equippedGetter ? equippedGetter.call(item) : item.isEquipped;
	return wasEquipped || !["implanted", "worn"].includes(item.system.usage.type);
}

function getOriginalEquippedGetter(item) {
	for (let prototype = Object.getPrototypeOf(item); prototype; prototype = Object.getPrototypeOf(prototype)) {
		if (Object.hasOwn(prototype, VURS_ORIGINAL_EQUIPPED_GETTER)) {
			return prototype[VURS_ORIGINAL_EQUIPPED_GETTER];
		}
	}
	return null;
}

function installMutedPhysicalItemRuleSuppression(physicalItemPrototype) {
	const prototypes = new Set([physicalItemPrototype]);
	for (const ItemClass of Object.values(CONFIG.PF2E?.Item?.documentClasses ?? {})) {
		const prototype = ItemClass?.prototype;
		if (
			prototype &&
			physicalItemPrototype.isPrototypeOf(prototype) &&
			Object.hasOwn(prototype, "prepareRuleElements")
		) {
			prototypes.add(prototype);
		}
	}

	for (const prototype of prototypes) {
		if (prototype[VURS_MUTED_PHYSICAL_RULE_PATCH]) continue;
		const original = prototype.prepareRuleElements;
		if (typeof original !== "function") continue;

		prototype.prepareRuleElements = function (...args) {
			if (
				this.isOfType?.("physical") &&
				!["weapon", "shield", "armor"].some(type => this.isOfType(type)) &&
				areDisabledFeaturesEnforced() &&
				hasMutedOrCursedCondition(this.actor)
			) {
				return this.rules = [];
			}
			return original.apply(this, args);
		};
		Object.defineProperty(prototype, VURS_MUTED_PHYSICAL_RULE_PATCH, { value: true });
	}
}

Hooks.on("renderApplicationV2", (app, element, context, options) => {
	requestAnimationFrame(() => {
		const root = app?.element ?? element;
		// pf2e-hud elements contain none of the sheet selectors used below, and
		// scripts/features/pf2eHud.js handles HUD-specific presentation. Skipping
		// them avoids running the whole sheet battery on every HUD render.
		if (
			root?.matches?.(".pf2e-hud-element") ||
			root?.closest?.(".pf2e-hud-element") ||
			root?.querySelector?.(".pf2e-hud-element")
		) return;
		const actor = [
			app?.actor,
			app?.document?.actor,
			app?.document,
			app?.object,
			app?.options?.actor,
			context?.actor,
			options?.actor
		].find(candidate => candidate?.documentName === "Actor" || candidate?.type === "npc") ??
			game.actors?.contents?.find(
				candidate => candidate.apps?.[app?.id] === app
			);

		// Do not render Play Resources in the generic ApplicationV2 hook.

		if (actorUsesMainAttribute(actor)) addMainAttributeBuilderControl(app, root, actor);
		addMainAttributeIndicator(root, actor);
		addNpcRestButton(root, actor);
		if (!isSupportedVursActor(actor)) return;
		reorderAttributeBuilderColumns(root, actor);
		reorderCharacterSheetAttributes(root, actor);
		applyActorAbilityLabels(root, actor);
		colorVursAttributeModifierFrames(root, actor);
		addVursExtendedSaveRows(root, actor);
		hideVursPerceptionSidebarSection(root, actor);
		relabelVursDexteritySkill(root, actor);
		relabelVursCoreSkills(root, actor);
		linkVursStatisticSkillControls(root, actor);
		nestVursConsolidatedSkills(root, actor);
		groupVursSkillsByAttribute(root, actor, localizeDefaultAbility);
	});
});
function installPf2eRollDialogCompatibility() {
	if (typeof globalThis.libWrapper?.register !== "function") {
		console.error(`${MODULE_ID} | Could not install PF2E roll dialog compatibility: libWrapper is unavailable`);
		return;
	}

	try {
		globalThis.libWrapper.register(
			MODULE_ID,
			"Handlebars.helpers.selectOptions",
			function (wrapped, choices, options) {
				const messageModes = options?.data?.root?.messageModes;
				if (choices === undefined && messageModes) {
					return wrapped(messageModes, options);
				}
				return wrapped(choices, options);
			},
			"WRAPPER"
		);
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to install PF2E roll dialog compatibility`, error);
	}
}
Hooks.once("ready", installPf2eRollDialogCompatibility);
Hooks.once("ready", installNpcSheetActions);
Hooks.on("renderActorSheet", (app, html) => {
	installActorDamageActionContext(app?.actor);
	addNpcRestButton(html, app?.actor);
	applyActorSheetPresentation(app, html);
});
Hooks.on("renderItemSheet", (app, html) => addVursAbilityCostField(app, html));
Hooks.on("preUpdateItem", (item, changes) => {
	const hasFlatPlayCost = Object.hasOwn(changes ?? {}, "flags.vurs.playCost");
	const hasNestedPlayCost = !!changes?.flags?.vurs && Object.hasOwn(changes.flags.vurs, "playCost");
	const flatValue = hasFlatPlayCost ? changes["flags.vurs.playCost"] : undefined;
	const nestedValue = hasNestedPlayCost ? changes.flags.vurs.playCost : undefined;
	const value = flatValue !== undefined ? flatValue : nestedValue;
	if (value === undefined) return;
	const normalizedValue = normalizeVursPlayCost(value);
	if (normalizedValue) {
		if (hasFlatPlayCost) changes["flags.vurs.playCost"] = normalizedValue;
		else changes.flags.vurs.playCost = normalizedValue;
		return;
	}
	delete changes["flags.vurs.playCost"];
	if (changes.flags?.vurs) delete changes.flags.vurs.playCost;
	changes.flags ??= {};
	changes.flags.vurs ??= {};
	changes.flags.vurs.playCost = new foundry.data.operators.ForcedDeletion();
});
Hooks.on("renderApplication", (app, html) => {
	if (app?.actor || app?.document?.documentName === "Actor" || app?.object?.documentName === "Actor") return;
	applyActorSheetPresentation(app, html);
});

function syncVursConditionFlagsFromItem(item) {
	if (item?.type !== "condition") return;
	syncVursConditionFlags(item.actor ?? item.parent);
}

function refreshBrokenStateFromItem(item) {
	if (!item?.isOfType?.("action", "feat")) return;
	const actor = item.actor ?? item.parent;
	if (!isSupportedVursActor(actor)) return;

	for (const app of Object.values(actor.apps ?? {})) {
		const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
		if (root) applyBrokenState(root, actor);
	}
}

async function syncVursConditionFlags(actor) {
	if (!isSupportedVursActor(actor)) return;
	const changes = { flags: { vurs: { conditions: {} } } };
	for (const [condition, flagName] of [
		["confused", "isConfused"],
		["fatigued", "isFatigued"],
		["immobilized", "isImmobilized"],
		["unconscious", "isUnconscious"],
		["paralyzed", "isParalyzed"],
		["petrified", "isPetrified"],
		["prone", "isProne"],
		["restrained", "isRestrained"],
		["stunned", "isStunned"]
	]) {
		const hasCondition = actor.hasCondition?.(condition) === true;
		const flag = foundry.utils.getProperty(actor, `flags.vurs.conditions.${flagName}`);
		const flagIsSet = flag === 1 || flag === "1" || flag === true;
		if (hasCondition === flagIsSet) continue;

		changes.flags.vurs.conditions[flagName] = hasCondition
			? 1
			: new foundry.data.operators.ForcedDeletion();
	}
	if (Object.keys(changes.flags.vurs.conditions).length === 0) return;

	try {
		await actor.update(changes, { render: false });
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to synchronize condition flags for ${actor.name}`, error);
	}
}

const scheduledPlayResourceRefreshes = new WeakMap();
const scheduledConditionStateRefreshes = new WeakSet();

Hooks.on("updateActor", (actor, changes, options = {}, userId) => {
	// Play-resource sheets render themselves after Apply on the initiating
	// client. Foundry forwards custom update options to every client, so only
	// skip the refresh for the user who made the change; remote clients still
	// need it to pick up the new values.
	if (options.vursPlayResourceOnly && userId === game.user.id) return;
	if (!isSupportedVursActor(actor)) return;

	for (const app of Object.values(actor.apps ?? {})) {
		const root = app?.element instanceof HTMLElement
			? app.element
			: app?.element?.[0];
		if (!root) continue;

		// Condition-state application scans the sheet DOM for every update. Actor
		// updates arrive in bursts during combat, so coalesce them into one pass
		// per frame per sheet; the functions read the latest actor state anyway.
		if (!scheduledConditionStateRefreshes.has(root)) {
			scheduledConditionStateRefreshes.add(root);
			requestAnimationFrame(() => {
				scheduledConditionStateRefreshes.delete(root);
				if (!root.isConnected) return;
				beginVursConditionPass();
				applyDisarmedStrikeState(root, actor);
				applySilencedState(root, actor);
				applyDragonblightState(root, actor);
				applyMutedState(root, actor);
				applyConfusedState(root, actor);
				applyFatiguedState(root, actor);
				applyRootedState(root, actor);
				applyImmobilizedState(root, actor);
				applyProneState(root, actor);
				applyRestrainedState(root, actor);
				applyActingStatusState(root, actor, "staggered");
				applyParalyzedState(root, actor);
				applyActingStatusState(root, actor, "unconscious");
				applyActingStatusState(root, actor, "cantAct");
				applyActingStatusState(root, actor, "incapacitated");
				applyActingStatusState(root, actor, "petrified");
				applyActingStatusState(root, actor, "stunned");
				applyBrokenState(root, actor);
				applyCooldownChargeUpState(root, actor);
				updateVursBreakerGlow(root, actor, VURS_BREAKER_GLOW_SHEET_SELECTOR);
			});
		}

		if (hasVursPlayResourcesDrawer(root)) {
			if (scheduledPlayResourceRefreshes.has(root)) continue;
			scheduledPlayResourceRefreshes.set(root, true);
			requestAnimationFrame(() => {
				scheduledPlayResourceRefreshes.delete(root);
				if (!root.isConnected) return;
				refreshVursPlayResourcesDrawer(root, actor);
				addVursMaxHpReductionControl(root, actor);
			});
		}
	}
});

Hooks.on("renderChatMessage", (message, html) => {
	const root = html instanceof HTMLElement ? html : html?.[0];
	const actor = message?.speaker?.actor ? game.actors?.get(message.speaker.actor)
		: message?.actor ?? null;
	if (root && actor) replaceVursPlayResourceTokens(root, actor);
	const originUuid = message?.flags?.pf2e?.origin?.uuid ?? message?.flags?.pf2e?.origin?.itemUuid;
	const originItem = message?.item ?? (originUuid ? fromUuidSync(originUuid) : null);
	const playCost = normalizeVursPlayCost(foundry.utils.getProperty(originItem, "flags.vurs.playCost"));
	if (root && playCost) replaceVursPlayCostToken(root, playCost);
	const button = root?.querySelector('button[data-action="revertDamage"]');
	if (!button || button.dataset.vursReductionUndo) return;
	button.dataset.vursReductionUndo = "true";
	button.addEventListener("click", () => {
		const appliedDamage = message.flags?.pf2e?.appliedDamage;
		const reductionUpdate = appliedDamage?.updates?.find(update =>
			update.path === "flags.vurs.hp.maxReduction"
		);
		if (!appliedDamage || !reductionUpdate) return;
		const actor = fromUuidSync(appliedDamage.uuid);
		if (!actor) return;
		const targetReduction = Number.isFinite(Number(appliedDamage.vursNegativeHp?.reduction))
			? Number(appliedDamage.vursNegativeHp.reduction)
			: getVursMaxHpReduction(actor) + Number(reductionUpdate.value || 0);
		// PF2e handles this action through a delegated asynchronous click handler.
		// Reassert the pre-damage reduction after that handler finishes, including
		// cases where its Actor.undoDamage update omits custom flag paths.
		setTimeout(() => actor.update({ "flags.vurs.hp.maxReduction": targetReduction }, { render: true })
			.catch(error => console.error(`${MODULE_ID} | Failed to restore HP reduction after damage revert`, error)), 150);
	});
});
// VURS Negative HP rules remove PF2e's Dying/Wounded/death-recovery functions.
// The conditions themselves are stripped mechanically; this hides the sheet
// controls that would otherwise adjust their values or roll recovery checks.
function applyNegativeHpSheetState(root, actor) {
	if (!actorUsesVursHpRules(actor)) return;
	for (const element of root.querySelectorAll(
		'a[data-action="adjust-condition-value"], [data-action="recovery-check"]'
	)) {
		element.remove();
	}
}
// Only usable entries glow on sheets — actions, feats, spells and strikes —
// not the whole item (inventory rows etc.).
const VURS_BREAKER_GLOW_SHEET_SELECTOR = ".actions-list > .item[data-item-id], .feats-list [data-item-id], .spell-list > .spell[data-item-id], [data-strike][data-action-index]";

// Stale disable markers left in the DOM: every disable path writes a
// non-empty vursConditionLabel (cooldown/charge-up included) or the breaker
// glow class, so their absence proves no pass has anything to clear.
const VURS_SHEET_DISABLE_MARKS = '[data-vurs-condition-label]:not([data-vurs-condition-label=""]), .vurs-breaker-glow';

// Every data-vurs-* condition attribute any pass can write. One shared scan
// collects which are currently "true", letting inactive conditions skip their
// passes entirely while stale flags still force the owning pass to run.
const VURS_CONDITION_ATTRS = [
	"cursed", "muted", "disarmed", "silenced", "dragonblight", "fatigued",
	"confused", "rooted", "immobilized", "prone", "restrained", "paralyzed",
	"staggered", "unconscious", "cant-act", "incapacitated", "petrified",
	"stunned", "broken", "cooldown", "charge-up"
];
const vursAttrDatasetKey = attr =>
	"vurs" + attr.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join("");

function applyVursConditionStates(root, actor) {
	if (!actorHasVursDisableStates(actor) && !root.querySelector(VURS_SHEET_DISABLE_MARKS)) return;
	const flags = getVursConditionFlags(actor);
	const on = name => flags[`is${name}`] === true;
	const staleAttrs = new Set();
	for (const element of root.querySelectorAll(
		VURS_CONDITION_ATTRS.map(attr => `[data-vurs-${attr}="true"]`).join(", ")
	)) {
		for (const attr of VURS_CONDITION_ATTRS) {
			if (element.dataset[vursAttrDatasetKey(attr)] === "true") staleAttrs.add(attr);
		}
	}
	const run = (active, attrs) => active || attrs.some(attr => staleAttrs.has(attr));

	if (run(on("Disarmed") || on("Cursed"), ["disarmed", "cursed"])) applyDisarmedStrikeState(root, actor);
	if (run(on("Silenced") || on("Cursed"), ["silenced", "cursed"])) applySilencedState(root, actor);
	if (run(on("Dragonblight"), ["dragonblight"])) applyDragonblightState(root, actor);
	if (run(on("Muted") || on("Cursed"), ["muted", "cursed"])) applyMutedState(root, actor);
	if (run(on("Confused"), ["confused"])) applyConfusedState(root, actor);
	if (run(on("Fatigued"), ["fatigued"])) applyFatiguedState(root, actor);
	if (run(on("Rooted"), ["rooted"])) applyRootedState(root, actor);
	if (run(on("Immobilized"), ["immobilized"])) applyImmobilizedState(root, actor);
	if (run(on("Prone"), ["prone"])) applyProneState(root, actor);
	if (run(on("Restrained"), ["restrained"])) applyRestrainedState(root, actor);
	if (run(on("Staggered"), ["staggered"])) applyActingStatusState(root, actor, "staggered");
	if (run(on("Paralyzed"), ["paralyzed"])) applyParalyzedState(root, actor);
	if (run(on("Unconscious"), ["unconscious"])) applyActingStatusState(root, actor, "unconscious");
	if (run(on("CantAct"), ["cant-act"])) applyActingStatusState(root, actor, "cantAct");
	if (run(on("Incapacitated"), ["incapacitated"])) applyActingStatusState(root, actor, "incapacitated");
	if (run(on("Petrified"), ["petrified"])) applyActingStatusState(root, actor, "petrified");
	if (run(on("Stunned"), ["stunned"])) applyActingStatusState(root, actor, "stunned");
	if (run(on("Broken"), ["broken"])) applyBrokenState(root, actor);
	applyCooldownChargeUpState(root, actor);
	exemptVursFrequencyEditors(root);
	updateVursBreakerGlow(root, actor, VURS_BREAKER_GLOW_SHEET_SELECTOR);
}

// Cooldown doubles as a "recharge pending" state: the frequency/uses input is
// the manual recharge path, so it must stay editable. inert cannot exempt
// descendants, so when cooldown is the row's ONLY active disable we move inert
// onto the row's other children and leave .frequency interactive. Any extra
// condition — or the hold-key bypass lifting inert entirely — restores the
// normal full lock.
const VURS_FREQ_LOCK_MARK = "vursFreqLock";

function exemptVursFrequencyEditors(root) {
	for (const row of root.querySelectorAll(".item, .spell")) {
		const frequency = row.querySelector(".frequency");
		const otherConditionActive = VURS_CONDITION_ATTRS.some(attr =>
			attr !== "cooldown" && row.dataset[vursAttrDatasetKey(attr)] === "true"
		);
		const exempt = frequency
			&& row.inert
			&& row.dataset.vursCooldown === "true"
			&& !otherConditionActive;
		if (exempt) {
			row.inert = false;
			row.dataset.vursFreqExempt = "true";
			for (const child of row.children) {
				if (child === frequency || child.contains(frequency)) continue;
				if (!child.inert) child.inert = true;
				child.dataset[VURS_FREQ_LOCK_MARK] = "true";
			}
			continue;
		}
		if (row.dataset.vursFreqExempt !== "true") continue;
		delete row.dataset.vursFreqExempt;
		for (const child of row.children) {
			if (child.dataset[VURS_FREQ_LOCK_MARK] !== "true") continue;
			child.inert = false;
			delete child.dataset[VURS_FREQ_LOCK_MARK];
		}
	}
}

// Re-runs the condition passes on every open actor sheet. Used by the
// hold-key disable bypass (disableOverrideKeybind.js) so inert/buttons
// recompute the moment the bypass engages or releases.
export function refreshVursDisableLocks() {
	// One pass generation for the whole refresh so getVursConditionFlags and
	// the row caches are shared across an actor's multiple open sheets.
	beginVursConditionPass();
	const actors = new Set([
		...(game.actors?.contents ?? []),
		game.user?.character,
		...(game.combat?.combatants?.contents ?? []).map(combatant => combatant.actor),
		...(canvas.tokens?.placeables ?? []).map(token => token.actor)
	].filter(Boolean));
	for (const actor of actors) {
		if (!isSupportedVursActor(actor)) continue;
		for (const app of Object.values(actor.apps ?? {})) {
			const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
			if (!root) continue;
			applyVursConditionStates(root, actor);
		}
	}
}

function applyActorSheetPresentation(app, element) {
	const root = element instanceof HTMLElement ? element : element?.[0];
	const actor = [
		app?.actor,
		app?.document?.actor,
		app?.document,
		app?.object
	].find(candidate => candidate?.documentName === "Actor" || candidate?.type === "npc");
	if (!root || !actor) return;
	beginVursConditionPass();
	addNpcRestButton(root, actor);
	if (!isSupportedVursActor(actor)) return;
	applyNegativeHpSheetState(root, actor);
	renderVursPlayResourcesDrawer(root, actor, app);
	addNpcConfigurationButton(root, actor);
	renderNpcRelationshipStatistics(root, actor, app);
	applyVursConditionStates(root, actor);
	replaceVursPlayResourceTokens(root, actor);
	replaceVursPlayCostTokensOnActorSheet(root, actor);
	if (!root.dataset.vursPlayResourceTokenObserver) {
		root.dataset.vursPlayResourceTokenObserver = "true";
		let updateScheduled = false;
		let observer;
		observer = new MutationObserver(() => {
			if (updateScheduled) return;
			updateScheduled = true;
			requestAnimationFrame(() => {
				updateScheduled = false;
				if (!root.isConnected) {
					observer.disconnect();
					delete root.dataset.vursPlayResourceTokenObserver;
					return;
				}
				beginVursConditionPass();
				applyVursConditionStates(root, actor);
				applyNegativeHpSheetState(root, actor);
				replaceVursPlayResourceTokens(root, actor);
				replaceVursPlayCostTokensOnActorSheet(root, actor);
			});
		});
		observer.observe(root, { childList: true, subtree: true });
	}
	requestAnimationFrame(() => addVursMaxHpReductionControl(root, actor));
	allowNegativeHpEntry(root, actor);
	addMainAttributeIndicator(root, actor);
	reorderCharacterSheetAttributes(root, actor);
	applyActorAbilityLabels(root, actor);
	colorVursAttributeModifierFrames(root, actor);
	addVursExtendedSaveRows(root, actor);
	hideVursPerceptionSidebarSection(root, actor);
	relabelVursDexteritySkill(root, actor);
	relabelVursCoreSkills(root, actor);
	linkVursStatisticSkillControls(root, actor);
	nestVursConsolidatedSkills(root, actor);
	groupVursSkillsByAttribute(root, actor, localizeDefaultAbility);
}

const STRIKE_ROW_SELECTOR = "[data-strike][data-action-index]";
const ACTION_ROW_SELECTOR = ".actions-list > .item[data-item-id]";
const SPELL_ROW_SELECTOR = ".spell-list > .spell[data-item-id]";
const ITEM_ROW_SELECTOR = `${ACTION_ROW_SELECTOR}, ${SPELL_ROW_SELECTOR}, ${STRIKE_ROW_SELECTOR}`;

function applyDisarmedStrikeState(root, actor) {
	const { isDisarmed, isCursed } = getVursConditionFlags(actor);
	let section;

	if (actor.isOfType?.("character") || actor.type === "character") {
		const encounterPanel = root.querySelector('.actions-panel[data-tab="encounter"]');
		section = encounterPanel?.querySelector(":scope > ol.strikes-list[data-strikes]");
	} else if (actor.isOfType?.("npc") || actor.type === "npc") {
		section = root.querySelector(".attacks.section-container");
	}

	if (!section) return;
	setConditionDisabledWithBreakerExemption(section, "disarmed", isDisarmed || isCursed, actor, STRIKE_ROW_SELECTOR);
	setConditionDisabledWithBreakerExemption(section, "cursed", isCursed, actor, STRIKE_ROW_SELECTOR);
}

function applySilencedState(root, actor) {
	const { isSilenced, isCursed } = getVursConditionFlags(actor);
	const spellcastingTab = root.querySelector(
		'.tab.spellcasting[data-tab="spellcasting"], .tab.spells[data-tab="spells"]'
	);
	setConditionDisabledWithBreakerExemption(
		spellcastingTab,
		"silenced",
		isSilenced || isCursed,
		actor,
		SPELL_ROW_SELECTOR
	);
	setConditionDisabledWithBreakerExemption(spellcastingTab, "cursed", isCursed, actor, SPELL_ROW_SELECTOR);

	const actionSelector = actor.isOfType?.("character") || actor.type === "character"
		? '.tab.actions[data-tab="actions"] .actions-list > .item[data-item-id]'
		: ".actions.section-container .actions-list > .item[data-item-id]";
	for (const element of root.querySelectorAll(actionSelector)) {
		const item = actor.items?.get(element.dataset.itemId);
		const slug = item?.slug ?? foundry.utils.getProperty(item, "system.slug");
		const isBasicAction = typeof slug === "string" && game.pf2e?.actions?.has(slug) === true;
		const isBreaker = itemHasBreakerTrait(item);
		setConditionDisabled(element, "silenced", isSilenced && !isBasicAction && !isBreaker);
		setConditionDisabled(element, "cursed", isCursed && !isBasicAction && !isBreaker);
	}
}

function applyDragonblightState(root, actor) {
	const { isDragonblight } = getVursConditionFlags(actor);
	if (!isDragonblight) {
		for (const element of root.querySelectorAll('[data-vurs-dragonblight="true"]')) {
			setConditionDisabled(element, "dragonblight", false);
		}
		return;
	}

	const damageTypes = getDragonblightDamageTypes();
	setConditionDisabledWithBreakerExemption(
		root.querySelector('.tab.spellcasting[data-tab="spellcasting"], .tab.spells[data-tab="spells"]'),
		"dragonblight",
		true,
		actor,
		SPELL_ROW_SELECTOR
	);
	const selector = [
		".actions-list > .item:not([data-strike])",
		".spell-list > .spell[data-item-id]",
		".feats-list [data-item-id]"
	].join(", ");

	for (const element of root.querySelectorAll(selector)) {
		const item = element.dataset.itemId ? actor.items?.get(element.dataset.itemId) : null;
		const slug = item?.slug ??
			foundry.utils.getProperty(item, "system.slug") ??
			element.dataset.slug ??
			element.dataset.actionSlug ??
			element.dataset.action;
		const action = typeof slug === "string" ? game.pf2e?.actions?.get?.(slug) : null;
		setConditionDisabled(
			element,
			"dragonblight",
			isDragonblightAffected(item, action, element, damageTypes) && !itemHasBreakerTrait(item)
		);
	}

	for (const strike of root.querySelectorAll(
		".strikes-list [data-strike][data-action-index], " +
		".attacks.section-container [data-strike][data-action-index]"
	)) {
		const action = actor.system.actions?.[Number(strike.dataset.actionIndex)];
		const item = actor.items?.get(action?.item?.id ?? strike.dataset.itemId);
		setConditionDisabled(
			strike,
			"dragonblight",
			isDragonblightStrikeAffected(item, action, damageTypes) && !itemHasBreakerTrait(item)
		);
	}
}

function isDragonblightAffected(item, action, element, damageTypes) {
	const itemTraits = foundry.utils.getProperty(item, "system.traits.value");
	const actionTraits = action?.traits?.value ?? action?.traits;
	const hasAffectedTrait = item?.type === "spell" ||
		element?.matches(".spell-list > .spell") ||
		hasDragonblightActionTrait(itemTraits) ||
		hasDragonblightActionTrait(actionTraits);
	const hasAffectedDamage = hasDragonblightDamageTypeInValue(
		getDragonblightDamageSources(item?.system, action),
		damageTypes
	);
	return hasAffectedTrait || hasAffectedDamage;
}

function applyMutedState(root, actor) {
	const { isMuted, isCursed } = getVursConditionFlags(actor);
	const disableItems = isMuted || isCursed;
	const inventoryTab = root.querySelector('.tab.inventory[data-tab="inventory"]');
	setConditionDisabled(inventoryTab, "muted", false);
	setConditionDisabled(inventoryTab, "cursed", false);
	const inventoryList = inventoryTab?.querySelector(".inventory-list");
	for (const header of inventoryList?.querySelectorAll(":scope > header") ?? []) {
		const itemList = header.nextElementSibling;
		if (!itemList?.matches("ul.items")) continue;
		const itemTypes = new Set(
			header.querySelector('[data-action="create-item"]')?.dataset.types?.split(",") ?? []
		);
		if (itemTypes.has("weapon") || itemTypes.has("shield") || itemTypes.has("armor")) {
			for (const element of itemList.querySelectorAll(":scope > li[data-item-id]")) {
				setConditionDisabled(element, "muted", false);
				setConditionDisabled(element, "cursed", false);
			}
		} else {
			setConditionDisabled(header, "muted", disableItems, false);
			setConditionDisabled(header, "cursed", isCursed, false);
			setConditionDisabledWithBreakerExemption(itemList, "muted", disableItems, actor, "li[data-item-id]");
			setConditionDisabledWithBreakerExemption(itemList, "cursed", isCursed, actor, "li[data-item-id]");
		}
	}
	for (const element of root.querySelectorAll(
		".actions-list > .item[data-item-id], .feats-list [data-item-id], .spell-list > .spell[data-item-id]"
	)) {
		const item = actor.items?.get(element.dataset.itemId);
		const isAcquisitionGated = isAcquisitionGatedItem(item);
		const isBreaker = itemHasBreakerTrait(item);
		setConditionDisabled(element, "muted", disableItems && isAcquisitionGated && !isBreaker);
		setConditionDisabled(element, "cursed", isCursed && isAcquisitionGated && !isBreaker);
	}

	for (const element of root.querySelectorAll(".actions-list > .item[data-item-id]")) {
		const item = actor.items?.get(element.dataset.itemId);
		const slug = item?.slug ?? foundry.utils.getProperty(item, "system.slug");
		if (slug !== "raise-a-shield") continue;

		element.dataset.vursRaiseShieldAction = "true";
		const isBreaker = itemHasBreakerTrait(item);
		setConditionDisabled(element, "muted", disableItems && !isBreaker);
		setConditionDisabled(element, "cursed", isCursed && !isBreaker);
	}

	for (const strike of root.querySelectorAll(".strikes-list > [data-strike][data-action-index]")) {
		const action = actor.system.actions?.[Number(strike.dataset.actionIndex)];
		const item = actor.items?.get(action?.item?.id);
		const isShieldStrike = item?.isOfType?.("shield") || item?.type === "shield";

		for (const button of strike.querySelectorAll('[data-action="auxiliary-action"]')) {
			const auxiliaryAction = action.auxiliaryActions?.[Number(button.dataset.auxiliaryActionIndex)];
			const isShieldRaise = isShieldStrike && auxiliaryAction?.action === "raise-a-shield";
			const isParry = auxiliaryAction?.action === "parry";
			if (!isShieldRaise && !isParry) continue;

			const isBreaker = itemHasBreakerTrait(item);
			button.dataset.vursMutedAuxiliary = "true";
			setConditionButtonDisabled(button, disableItems && !isBreaker);
			setConditionDisabled(button, "muted", disableItems && !isBreaker);
			setConditionDisabled(button, "cursed", isCursed && !isBreaker);
		}
	}

	if (actor.isOfType?.("npc") || actor.type === "npc") {
		for (const button of root.querySelectorAll('.subsection.shield button[data-action="raise-a-shield"]')) {
			setConditionButtonDisabled(button, disableItems);
			setConditionDisabled(button, "muted", disableItems);
			setConditionDisabled(button, "cursed", isCursed);
		}
	}
}

function applyFatiguedState(root, actor) {
	const { isFatigued } = getVursConditionFlags(actor);
	for (const panel of root.querySelectorAll(
		'.tab.actions .actions-panel[data-tab="exploration"], .tab.actions .actions-panel[data-tab="downtime"]'
	)) {
		setConditionDisabledWithBreakerExemption(panel, "fatigued", isFatigued, actor, ACTION_ROW_SELECTOR);
	}

	for (const element of root.querySelectorAll(
		".actions-list > .item[data-item-id], .spell-list > .spell[data-item-id]"
	)) {
		const item = actor.items?.get(element.dataset.itemId);
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		setConditionDisabled(
			element,
			"fatigued",
			isFatigued && Array.isArray(traits) && traits.includes("exploration") && !traits.includes("breaker")
		);
	}

	for (const element of root.querySelectorAll(".feats-list [data-item-id]")) {
		const item = actor.items?.get(element.dataset.itemId);
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		setConditionDisabled(
			element,
			"fatigued",
			isFatigued && Array.isArray(traits) && traits.includes("exploration") && !traits.includes("breaker")
		);
	}
}

function applyConfusedState(root, actor) {
	const { isConfused } = getVursConditionFlags(actor);
	const selector = [
		".actions-list > .item[data-item-id]",
		".spell-list > .spell[data-item-id]",
		".feats-list [data-item-id]"
	].join(", ");
	for (const element of root.querySelectorAll(selector)) {
		const item = actor.items?.get(element.dataset.itemId);
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		const slug = item?.slug ?? foundry.utils.getProperty(item, "system.slug");
		const isDelayOrReady = ["delay", "ready"].includes(slug);
		const hasReaction = item?.actionCost?.type === "reaction" ||
			(Array.isArray(traits) && traits.includes("reaction"));
		setConditionDisabled(element, "confused", isConfused && (isDelayOrReady || hasReaction) && !itemHasBreakerTrait(item));
	}
}

function applyRootedState(root, actor) {
	const { isRooted } = getVursConditionFlags(actor);
	applyMovementConditionToSpeed(root, actor, "rooted", isRooted);
	for (const { element, traits } of getActionAndSpellItems(root, actor)) {
		const hasMovementTrait = traits.some(trait => ["move", "traversal", "teleportation"].includes(trait));
		setConditionDisabled(element, "rooted", isRooted && hasMovementTrait && !traits.includes("breaker"));
	}
}

function applyImmobilizedState(root, actor) {
	const { isImmobilized } = getVursConditionFlags(actor);
	applyMovementConditionToSpeed(root, actor, "immobilized", isImmobilized);
	for (const { element, traits } of getActionAndSpellItems(root, actor)) {
		setConditionDisabled(element, "immobilized", isImmobilized && traits.includes("move") && !traits.includes("breaker"));
	}
}

function applyProneState(root, actor) {
	const { isProne } = getVursConditionFlags(actor);
	applyMovementConditionToSpeed(root, actor, "prone", isProne);
	for (const { element, traits, slug } of getActionAndSpellItems(root, actor)) {
		const isException = ["crawl", "stand"].includes(slug);
		setConditionDisabled(element, "prone", isProne && !isException && traits.includes("move") && !traits.includes("breaker"));
	}
}

function applyRestrainedState(root, actor) {
	const { isRestrained } = getVursConditionFlags(actor);

	for (const { element, traits, slug } of getActionAndSpellItems(root, actor)) {
		const isException = ["escape", "force-open"].includes(slug);
		const isRestricted = !isException && traits.some(trait =>
			trait === "attack" || trait === "manipulate"
		);
		setConditionDisabled(element, "restrained", isRestrained && isRestricted && !traits.includes("breaker"));
	}

	if (actor.isOfType?.("character") || actor.type === "character") {
		const strikeSection = root.querySelector(".strikes-list");
		setConditionDisabledWithBreakerExemption(strikeSection, "restrained", isRestrained, actor, STRIKE_ROW_SELECTOR);
	} else {
		const attacksSection = root.querySelector(".attacks.section-container");
		setConditionDisabledWithBreakerExemption(attacksSection, "restrained", isRestrained, actor, ITEM_ROW_SELECTOR);
	}
}

function applyParalyzedState(root, actor) {
	const { isParalyzed } = getVursConditionFlags(actor);
	applyMovementConditionToSpeed(root, actor, "paralyzed", isParalyzed);

	for (const { element, traits, slug } of getActionAndSpellItems(root, actor)) {
		setConditionDisabled(element, "paralyzed", isParalyzed && slug !== "recall-knowledge" && !traits.includes("breaker"));
	}

	const isCharacter = actor.isOfType?.("character") || actor.type === "character";
	const strikeSection = isCharacter
		? root.querySelector(".strikes-list")
		: root.querySelector(".attacks.section-container");
	setConditionDisabledWithBreakerExemption(strikeSection, "paralyzed", isParalyzed, actor, ITEM_ROW_SELECTOR);
}

function applyActingStatusState(root, actor, condition) {
	const flagKey = `is${condition[0].toUpperCase()}${condition.slice(1)}`;
	const isActive = getVursConditionFlags(actor)[flagKey] === true;
	applyMovementConditionToSpeed(root, actor, condition, isActive);

	if (actor.isOfType?.("character") || actor.type === "character") {
		setConditionDisabledWithBreakerExemption(
			root.querySelector('.tab.actions[data-tab="actions"]'),
			condition,
			isActive,
			actor,
			ITEM_ROW_SELECTOR
		);
		setConditionDisabledWithBreakerExemption(
			root.querySelector('.tab.spellcasting[data-tab="spellcasting"]'),
			condition,
			isActive,
			actor,
			SPELL_ROW_SELECTOR
		);
		return;
	}

	setConditionDisabledWithBreakerExemption(
		root.querySelector(".attacks.section-container"),
		condition,
		isActive,
		actor,
		STRIKE_ROW_SELECTOR
	);
	setConditionDisabledWithBreakerExemption(
		root.querySelector(".actions.section-container"),
		condition,
		isActive,
		actor,
		ITEM_ROW_SELECTOR
	);
	setConditionDisabledWithBreakerExemption(
		root.querySelector('.tab.spells[data-tab="spells"]'),
		condition,
		isActive,
		actor,
		SPELL_ROW_SELECTOR
	);
}

function applyMovementConditionToSpeed(root, actor, condition, isDisabled) {
	const selector = actor.isOfType?.("character") || actor.type === "character"
		? '.tab.character .subsection.speeds'
		: ".sidebar .subsection.speeds";
	setConditionDisabled(root.querySelector(selector), condition, isDisabled);
}

function applyBrokenState(root, actor) {
	const isBroken = [1, "1", true].includes(getBrokenConditionFlag(actor)) ||
		getVursConditionPresenceKeys(actor).has("broken");
	const itemSelector = actor.isOfType?.("character") || actor.type === "character"
		? [
			'.tab.actions[data-tab="actions"] .actions-list > .item[data-item-id]',
			'.tab.feats[data-tab="feats"] .feats-list [data-item-id]'
		].join(", ")
		: ".actions.section-container .actions-list > .item[data-item-id], .passives.section-container .actions-list > .item[data-item-id]";

	for (const element of root.querySelectorAll(itemSelector)) {
		const item = actor.items?.get(element.dataset.itemId);
		if (!item?.isOfType?.("action", "feat")) continue;
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		const hasReactionTrait = Array.isArray(traits) && traits.includes("reaction");
		const isReaction = item.actionCost?.type === "reaction" || hasReactionTrait;
		const isPassive = !item.actionCost;
		setConditionDisabled(element, "broken", isBroken && !itemHasBreakerTrait(item) && (
			isReaction || (isPassive && !itemIgnoresBroken(item))
		));
	}
}

function applyCooldownChargeUpState(root, actor) {
	const cooldownItemUuids = new Set(
		(actor.itemTypes?.effect ?? [])
			.map(effect => effect.getFlag?.("vurs-pf2e", "sourceItemUuid"))
			.filter(Boolean)
	);
	const combat = game.combat;
	const currentRound = combat?.started ? combat.round : 0;
	for (const { element, item } of getDisableableActionItems(root, actor)) {
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		const chargeUpTrait = Array.isArray(traits)
			? traits.find(trait => /^charge-up-\d+$/.test(trait))
			: null;
		const chargeUpRound = chargeUpTrait ? Number(chargeUpTrait.match(/\d+$/)?.[0]) : null;
		const frequencyDepleted = foundry.utils.getProperty(item, "system.frequency.value") === 0;
		setConditionDisabled(element, "cooldown", cooldownItemUuids.has(item.uuid) || frequencyDepleted);
		setConditionDisabled(
			element,
			"chargeUp",
			Boolean(combat) && Number.isInteger(chargeUpRound) && currentRound <= chargeUpRound
		);
	}
}

// Both builders rescan the same rows for every condition pass; cache per
// (root, actor, pass generation) so each refresh resolves items once.
const disableableActionItemsCache = new WeakMap();
const actionAndSpellItemsCache = new WeakMap();

function getDisableableActionItems(root, actor) {
	const gen = getVursConditionPassGeneration();
	const cached = disableableActionItemsCache.get(root);
	if (cached && cached.gen === gen && cached.actor === actor) return cached.value;
	const value = computeDisableableActionItems(root, actor);
	disableableActionItemsCache.set(root, { gen, actor, value });
	return value;
}

function computeDisableableActionItems(root, actor) {
	const itemSelector = actor.isOfType?.("character") || actor.type === "character"
		? [
			'.tab.actions[data-tab="actions"] .actions-list > .item[data-item-id]',
			'.tab.feats[data-tab="feats"] .feats-list [data-item-id]',
			'.tab.spellcasting[data-tab="spellcasting"] .spell-list > .spell[data-item-id]'
		].join(", ")
		: [
			".actions.section-container .actions-list > .item[data-item-id]",
			".passives.section-container .actions-list > .item[data-item-id]",
			'.tab.spells[data-tab="spells"] .spell-list > .spell[data-item-id]'
		].join(", ");

	return [...root.querySelectorAll(itemSelector)].flatMap(element => {
		const item = actor.items?.get(element.dataset.itemId);
		return item ? [{ element, item }] : [];
	});
}

// Item writes arrive in bursts (condition ticks, flag updates); each one used
// to rescan every open sheet. Coalesce to one refresh per actor per frame.
const scheduledCooldownRefreshes = new WeakSet();
function refreshCooldownChargeUpStateFromItem(item) {
	const actor = item?.actor ?? item?.parent;
	if (!isSupportedVursActor(actor) || scheduledCooldownRefreshes.has(actor)) return;
	scheduledCooldownRefreshes.add(actor);
	requestAnimationFrame(() => {
		scheduledCooldownRefreshes.delete(actor);
		refreshCooldownChargeUpState(actor);
	});
}

function refreshCooldownChargeUpStateForOpenSheets() {
	const actors = new Set([
		...(game.actors?.contents ?? []),
		...(game.combat?.combatants?.contents ?? []).map(combatant => combatant.actor),
		...(canvas.tokens?.placeables ?? []).map(token => token.actor)
	].filter(Boolean));
	for (const actor of actors) refreshCooldownChargeUpState(actor);
}

function refreshCooldownChargeUpState(actor) {
	if (!isSupportedVursActor(actor)) return;
	for (const app of Object.values(actor.apps ?? {})) {
		const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
		if (root) applyCooldownChargeUpState(root, actor);
	}
}

function getActionAndSpellItems(root, actor) {
	const gen = getVursConditionPassGeneration();
	const cached = actionAndSpellItemsCache.get(root);
	if (cached && cached.gen === gen && cached.actor === actor) return cached.value;
	const value = computeActionAndSpellItems(root, actor);
	actionAndSpellItemsCache.set(root, { gen, actor, value });
	return value;
}

function computeActionAndSpellItems(root, actor) {
	const itemSelector = actor.isOfType?.("character") || actor.type === "character"
		? [
			'.tab.actions[data-tab="actions"] .actions-list > .item[data-item-id]',
			'.tab.spellcasting[data-tab="spellcasting"] .spell-list > .spell[data-item-id]'
		].join(", ")
		: [
			".actions.section-container .actions-list > .item[data-item-id]",
			'.tab.spells[data-tab="spells"] .spell-list > .spell[data-item-id]'
		].join(", ");

	return [...root.querySelectorAll(itemSelector)].map(element => {
		const item = actor.items?.get(element.dataset.itemId);
		const traits = foundry.utils.getProperty(item, "system.traits.value");
		const slug = item?.slug ??
			foundry.utils.getProperty(item, "system.slug") ??
			element.dataset.slug ??
			element.dataset.actionSlug ??
			element.dataset.action;
		return { element, traits: Array.isArray(traits) ? traits : [], slug };
	});
}

function installBrokenPassiveRuleSuppression() {
	for (const type of ["character", "npc"]) {
		const prototype = CONFIG.PF2E?.Actor?.documentClasses?.[type]?.prototype;
		const original = prototype?.prepareRuleElements;
		if (typeof original !== "function" || prototype[VURS_BROKEN_PASSIVE_RULE_PATCH]) continue;

		prototype.prepareRuleElements = function (...args) {
			const rules = original.apply(this, args);
			if (!areDisabledFeaturesEnforced()) return rules;
			const isBroken = [1, "1", true].includes(getBrokenConditionFlag(this)) ||
				getVursConditionPresenceKeys(this).has("broken") ||
				rules.some(rule => ruleEnablesBroken(rule, this));
			if (!isBroken) return rules;

			return rules.filter(rule => {
				const item = rule.item;
				return !item?.isOfType?.("action", "feat") || item.actionCost || itemIgnoresBroken(item);
			});
		};
		Object.defineProperty(prototype, VURS_BROKEN_PASSIVE_RULE_PATCH, { value: true });
	}
}

function installDragonblightRuleSuppression() {
	for (const type of ["character", "npc"]) {
		const prototype = CONFIG.PF2E?.Actor?.documentClasses?.[type]?.prototype;
		const original = prototype?.prepareRuleElements;
		if (typeof original !== "function" || prototype[VURS_DRAGONBLIGHT_RULE_PATCH]) continue;

		prototype.prepareRuleElements = function (...args) {
			const rules = original.apply(this, args);
			if (!areDisabledFeaturesEnforced()) return rules;

			const isDragonblight = [1, "1", true].includes(
				foundry.utils.getProperty(this, "flags.vurs.conditions.isDragonblight")
			) || getVursConditionPresenceKeys(this).has("dragonblight") ||
				rules.some(rule => ruleEnablesVursCondition(rule, this, "isDragonblight"));
			if (!isDragonblight) return rules;

			const damageTypes = getDragonblightDamageTypes();
			const affectedItems = new WeakMap();
			return rules.filter(rule => {
				const item = rule.item;
				if (!item || (typeof item !== "object" && typeof item !== "function")) return true;
				if (item.isOfType?.("weapon", "melee")) return true;
				if (!affectedItems.has(item)) {
					affectedItems.set(item, isDragonblightAffected(item, null, null, damageTypes) && !itemHasBreakerTrait(item));
				}
				return !affectedItems.get(item);
			});
		};
		Object.defineProperty(prototype, VURS_DRAGONBLIGHT_RULE_PATCH, { value: true });
	}
}

function actorHasDragonblight(actor) {
	return [1, "1", true].includes(
		foundry.utils.getProperty(actor, "flags.vurs.conditions.isDragonblight")
	) || getVursConditionPresenceKeys(actor).has("dragonblight") || actor?.rules?.some(rule =>
		ruleEnablesVursCondition(rule, actor, "isDragonblight")
	);
}

function installMutedItemRuleSuppression() {
	for (const type of ["character", "npc"]) {
		const prototype = CONFIG.PF2E?.Actor?.documentClasses?.[type]?.prototype;
		const original = prototype?.prepareRuleElements;
		if (typeof original !== "function" || prototype[VURS_MUTED_ITEM_RULE_PATCH]) continue;

		prototype.prepareRuleElements = function (...args) {
			const rules = original.apply(this, args);
			if (!areDisabledFeaturesEnforced() || !hasMutedOrCursedCondition(this, rules)) return rules;

			const isMutedItemRule = rule => {
				const item = rule.item;
				return !itemHasBreakerTrait(item) && (
					(item?.isOfType?.("physical") &&
						!["weapon", "shield", "armor"].some(itemType => item.isOfType(itemType))) ||
					isAcquisitionGatedItem(item)
				);
			};
			const rulesByItem = new Map();
			for (const rule of rules) {
				if (!isMutedItemRule(rule)) continue;
				const item = rule.item;
				if (!rulesByItem.has(item)) rulesByItem.set(item, new Set());
				rulesByItem.get(item).add(rule);
			}
			for (const [item, mutedRules] of rulesByItem) {
				item.rules = item.rules.filter(rule => !mutedRules.has(rule));
			}

			return rules.filter(rule => !isMutedItemRule(rule));
		};
		Object.defineProperty(prototype, VURS_MUTED_ITEM_RULE_PATCH, { value: true });
	}
}

function addVursAbilityCostField(app, element) {
	const item = app?.item ?? app?.object;
	if (!item || !["action", "feat"].includes(item.type)) return;
	const root = element instanceof HTMLElement ? element : element?.[0];
	const currentPlayCost = normalizeVursPlayCost(foundry.utils.getProperty(item, "flags.vurs.playCost"));
	const playCost = resolveVursPlayCostRolls(currentPlayCost, item.actor ?? item.parent?.actor)
		.split("; ")
		.map(entry => entry.trim())
		.filter(Boolean)
		.join("; ");
	const description = root?.querySelector(".tab.description .editor-content, .tab.description");
	if (description && !description.contains(document.activeElement)) {
		if (playCost) replaceVursPlayCostToken(description, playCost);
		replaceVursPlayResourceTokens(description, item.actor ?? item.parent?.actor);
	}
	const details = root?.querySelector(".sheet-header .details");
	const existingGlyph = root?.querySelector(".sheet-header .action-glyph, .sheet-header .action-cost, .sheet-header .vurs-play-cost-glyph");
	if (details) {
		const staleGlyph = details.querySelector(".vurs-play-cost-glyph");
		if (!playCost && staleGlyph) staleGlyph.remove();
	}
	if (playCost && details && !details.querySelector(".vurs-play-cost-glyph") && !root?.querySelector(".sheet-header .vurs-play-cost-glyph")) {
		const glyph = document.createElement("div");
		glyph.className = "vurs-play-cost-glyph";
		playCost.split("; ").map(entry => entry.trim()).filter(Boolean).forEach((entry, index) => {
			if (index) {
				const separator = document.createElement("div");
				separator.className = "vurs-play-cost-separator";
				separator.textContent = "; ";
				glyph.append(separator);
			}
			const group = document.createElement("div");
			group.className = "vurs-play-cost-glyph-group";
			group.title = entry;
			appendVursPlayCostIcons(group, entry);
			glyph.append(group);
		});
		glyph.title = playCost;
		if (existingGlyph && !existingGlyph.classList.contains("vurs-play-cost-glyph")) existingGlyph.replaceWith(glyph);
		else details.insertBefore(glyph, details.querySelector(".level") ?? null);
	}
	const basics = root?.querySelector(".tab.details fieldset.basics, .tab.details, .tab[data-tab='details']");
	if (!basics) return;
	let group = basics.querySelector("[data-vurs-cost-field]");
	if (!group) {
		group = document.createElement("div");
		group.className = "form-group";
		group.dataset.vursCostField = "true";
		const label = document.createElement("label");
		label.textContent = "Play Cost";
		label.htmlFor = `${app.id ?? item.id}-vurs-cost`;
		const fields = document.createElement("div");
		fields.className = "form-fields";
		const input = document.createElement("input");
		input.type = "text";
		input.id = label.htmlFor;
		input.name = "flags.vurs.playCost";
		input.value = currentPlayCost;
		input.placeholder = "1 AP; 1 AP and SP; 1 AP, TP or Reaction";
		fields.append(input);
		group.append(label, fields);
		const actionGroup = [...basics.querySelectorAll(".form-group")].find(candidate =>
			/actions/i.test(candidate.querySelector("label")?.textContent ?? "") ||
			candidate.querySelector('select[name$="actionType"], select[name$="actionType.value"], input[name$="actionType"]')
		);
		if (actionGroup) actionGroup.insertAdjacentElement("afterend", group);
		else basics.append(group);
	} else {
		const input = group.querySelector("input[name='flags.vurs.playCost']");
		if (input) input.value = currentPlayCost;
	}
}

function allowNegativeHpEntry(root, actor) {
	if (!actorUsesVursHpRules(actor)) return;
	const hp = actor.system?.attributes?.hp;
	const input = root.querySelector('input[name$="attributes.hp.value"], input[data-property$="attributes.hp.value"], input[name$="hp.value"]');
	const effectiveMax = Number(hp?.max);
	const maximumNegative = Math.max(0, Number.isFinite(effectiveMax) ? effectiveMax : 0);
	const isCurrentHpInput = target => target instanceof HTMLInputElement &&
		target.matches('input[name$="attributes.hp.value"], input[data-property$="attributes.hp.value"], input[name$="hp.value"]');
	// A leading + or - makes the entry a delta applied to current HP; an unsigned
	// number sets HP absolutely. Only the portion of a delta that pushes HP below
	// zero becomes a max-HP reduction.
	const commitHpEntry = rawText => {
		const text = String(rawText).trim();
		const entered = Number(text);
		const baseHp = Number(actor.system?.attributes?.hp?.value) || 0;
		const maxHp = Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0);
		// Skip the update when the result equals current HP — an unconditional
		// actor.update forces a full re-prepare and every updateActor hook.
		if (text.startsWith("+") || text.startsWith("-")) {
			const newHp = baseHp + Math.trunc(entered);
			if (newHp < 0) return applyVursNegativeHp(actor, -newHp);
			const clamped = Math.min(newHp, maxHp);
			return clamped === baseHp ? Promise.resolve() : actor.update({ "system.attributes.hp.value": clamped });
		}
		const clamped = Math.clamp(Number.isFinite(entered) ? Math.trunc(entered) : baseHp, 0, maxHp);
		return clamped === baseHp ? Promise.resolve() : actor.update({ "system.attributes.hp.value": clamped });
	};
	if (!root.dataset.vursNegativeHpDelegation) {
		root.dataset.vursNegativeHpDelegation = "true";
		// Catch these events during capture at the sheet boundary, before PF2e's
		// delegated form listeners can persist a raw HP value themselves. We own
		// the commit and interpret the field as a delta, so block every HP input.
		root.addEventListener("input", event => {
			const field = event.target;
			if (!isCurrentHpInput(field)) return;
			field.dataset.vursHpWheel = "";
			field.dataset.vursHpDelta = "";
			field.dataset.numValue = String(actor.system?.attributes?.hp?.value ?? 0);
			event.stopImmediatePropagation();
		}, true);
		root.addEventListener("wheel", event => {
			const target = event.target instanceof Element ? event.target : null;
			const field = target?.closest?.('input[name$="attributes.hp.value"], input[data-property$="attributes.hp.value"], input[name$="hp.value"]');
			if (!field || document.activeElement !== field || event.deltaY === 0) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			// Mirror PF2e's data-allow-delta wheel: adjust the committed absolute
			// HP by +/-1. Flag it so a below-zero result is read as absolute, not
			// as a typed +/- delta.
			const baseHp = Number(field.dataset.numValue ?? actor.system?.attributes?.hp?.value) || 0;
			const next = baseHp + Math.sign(-1 * event.deltaY);
			field.dataset.numValue = String(next);
			field.dataset.vursHpWheel = "true";
			field.value = String(next);
			field.dataset.vursWheelDirty = "true";
		}, { capture: true, passive: false });
		root.addEventListener("change", event => {
			const field = event.target;
			if (!isCurrentHpInput(field)) return;
			const wheelAbsolute = field.dataset.vursHpWheel === "true";
			field.dataset.vursWheelDirty = "";
			field.dataset.vursHpWheel = "";
			field.dataset.vursHpDelta = "";
			field.dataset.numValue = "";
			event.preventDefault();
			event.stopImmediatePropagation();
			const raw = field.value.trim();
			const entered = Number(raw);
			const isDelta = raw.startsWith("+") || raw.startsWith("-");
			const resetField = () => { field.value = String(actor.system?.attributes?.hp?.value ?? 0); };
			if (!Number.isFinite(entered)) { resetField(); return; }
			// Wheel edits are absolute HP and may go below zero into maxReduction.
			const wheelClamped = Math.trunc(entered) < 0 ? null
				: Math.min(Math.max(Math.trunc(entered), 0), Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0));
			const commit = wheelAbsolute
				? (Math.trunc(entered) < 0
					? applyVursNegativeHp(actor, -Math.trunc(entered))
					: (wheelClamped === (Number(actor.system?.attributes?.hp?.value) || 0)
						? Promise.resolve()
						: actor.update({ "system.attributes.hp.value": wheelClamped })))
				: (isDelta && Math.trunc(entered) === 0 ? Promise.resolve() : commitHpEntry(raw));
			commit.then(() => {
				field.value = String(actor.system?.attributes?.hp?.value ?? 0);
			}).catch(error => {
				console.error(`${MODULE_ID} | Failed to update current HP`, error);
				ui.notifications?.error("Could not update current HP.");
				resetField();
			});
		}, true);
	}
	if (input) {
		input.min = String(-(maximumNegative + (Number(hp?.value) || 0)));
		input.step = "1";
		if (!input.dataset.vursNegativeHp) {
			input.dataset.vursNegativeHp = "true";
			// A wheel edit is committed once when the field loses focus.
			input.addEventListener("blur", () => {
				if (input.dataset.vursWheelDirty !== "true") return;
				input.dataset.vursWheelDirty = "";
				input.dispatchEvent(new Event("change", { bubbles: true }));
			});
		}
		return;
	}

	// Some PF2e sheet layouts render current HP as text instead of an input.
	// Make that value editable in place so entering a negative number reaches
	// the actor update wrapper that converts the overflow into max HP loss.
	const currentHpLabels = new Set([
		"CURRENT HP",
		"CURRENT HIT POINTS",
		String(game.i18n.localize("PF2E.HitPointsHeader")).replace(/\s+/g, " ").trim().toUpperCase()
	]);
	const labels = [...root.querySelectorAll("*")].filter(element =>
		currentHpLabels.has(element.textContent.replace(/\s+/g, " ").trim().toUpperCase())
	);
	const hpValue = String(hp?.value ?? 0);
	let valueElement = null;
	for (const label of labels) {
		let container = label.parentElement;
		for (let depth = 0; container && depth < 4 && !valueElement; depth++, container = container.parentElement) {
			valueElement = [...container.querySelectorAll("*")].find(element =>
				element !== label && element.childElementCount === 0 && element.textContent.trim() === hpValue
			) ?? null;
		}
		if (valueElement) break;
	}
	if (!valueElement || valueElement.classList.contains("vurs-negative-hp-edit")) return;

	valueElement.classList.add("vurs-negative-hp-edit");
	valueElement.contentEditable = "true";
	valueElement.spellcheck = false;
	valueElement.setAttribute("role", "spinbutton");
	valueElement.setAttribute("aria-label", "Current HP");
	valueElement.setAttribute("aria-valuemin", String(-(maximumNegative + (Number(hp?.value) || 0))));
	valueElement.setAttribute("aria-valuemax", String(hp?.max ?? 0));
	valueElement.title = "Edit current HP; enter a delta such as +5 or -3";
	let cancelEdit = false;
	valueElement.addEventListener("focus", () => {
		cancelEdit = false;
		valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0);
		const range = document.createRange();
		range.selectNodeContents(valueElement);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	});
	valueElement.addEventListener("input", () => {
		valueElement.dataset.vursHpWheel = "";
		valueElement.dataset.vursHpDelta = "";
		valueElement.dataset.numValue = String(actor.system?.attributes?.hp?.value ?? 0);
	});
	valueElement.addEventListener("wheel", event => {
		if (document.activeElement !== valueElement || event.deltaY === 0) return;
		event.preventDefault();
		const baseHp = Number(valueElement.dataset.numValue ?? actor.system?.attributes?.hp?.value) || 0;
		const next = baseHp + Math.sign(-1 * event.deltaY);
		valueElement.dataset.numValue = String(next);
		valueElement.dataset.vursHpWheel = "true";
		valueElement.textContent = String(next);
	}, { passive: false });
	valueElement.addEventListener("blur", async () => {
		const wheelAbsolute = valueElement.dataset.vursHpWheel === "true";
		valueElement.dataset.vursHpWheel = "";
		valueElement.dataset.vursHpDelta = "";
		valueElement.dataset.numValue = "";
		const resetElement = () => { valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0); };
		if (cancelEdit) {
			cancelEdit = false;
			resetElement();
			return;
		}
		const raw = valueElement.textContent.trim();
		const entered = Number(raw);
		const isDelta = raw.startsWith("+") || raw.startsWith("-");
		if (!Number.isFinite(entered)) { resetElement(); return; }
		try {
			if (wheelAbsolute) {
				const v = Math.trunc(entered);
				if (v < 0) await applyVursNegativeHp(actor, -v);
				else await actor.update({ "system.attributes.hp.value": Math.min(Math.max(v, 0), Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0)) });
			} else if (!(isDelta && Math.trunc(entered) === 0)) {
				await commitHpEntry(raw);
			}
			valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to update current HP`, error);
			ui.notifications?.error("Could not update current HP.");
			resetElement();
		}
	});
	valueElement.addEventListener("keydown", event => {
		if (event.key === "Enter") {
			event.preventDefault();
			valueElement.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelEdit = true;
			valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0);
			valueElement.blur();
		}
	});
}

async function applyVursNegativeHp(actor, overflow) {
	const currentMaximum = Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0);
	const amount = Math.min(currentMaximum, Math.max(0, Math.floor(Number(overflow) || 0)));
	if (!amount) return;
	const currentAdjustment = getVursMaxHpReduction(actor);
	const baseMax = getVursBaseMaxHp(actor);
	const adjustment = Math.min(baseMax, currentAdjustment + amount);
	await actor.update({
		"system.attributes.hp.value": 0,
		["flags.vurs.hp.maxReduction"]: adjustment
	});
}

function addVursMaxHpReductionControl(root, actor, retries = 4) {
	if (!actorUsesVursHpRules(actor) || root.querySelector(".vurs-max-hp-edit")) return;
	const hp = actor.system?.attributes?.hp;
	if (!Number.isFinite(hp?.max)) return;

	const maxHpLabels = new Set([
		"MAX HP",
		"MAXIMUM HP",
		String(game.i18n.localize("PF2E.MaxHitPointsLabel")).replace(/\s+/g, " ").trim().toUpperCase()
	]);
	const labels = [...root.querySelectorAll("*")].filter(element =>
		maxHpLabels.has(element.textContent.replace(/\s+/g, " ").trim().toUpperCase())
	);
	const displayedMax = String(hp.max);
	let valueElement = null;
	for (const label of labels) {
		let container = label.parentElement;
		for (let depth = 0; container && depth < 4 && !valueElement; depth++, container = container.parentElement) {
			valueElement = [...container.querySelectorAll("*")].find(element =>
				element !== label && element.childElementCount === 0 && element.textContent.trim() === displayedMax
			) ?? null;
		}
		if (valueElement) break;
	}
	if (!valueElement || valueElement.matches("input, button")) {
		if (retries > 0 && root.isConnected) requestAnimationFrame(() => addVursMaxHpReductionControl(root, actor, retries - 1));
		return;
	}

	const currentAdjustment = getVursMaxHpReduction(actor);
	const valueEditor = document.createElement("span");
	valueEditor.className = "vurs-max-hp-edit";
	valueEditor.contentEditable = "true";
	valueEditor.spellcheck = false;
	valueEditor.setAttribute("role", "spinbutton");
	valueEditor.setAttribute("aria-label", "Maximum HP");
	valueEditor.setAttribute("aria-valuemin", "0");
	valueEditor.setAttribute("aria-valuenow", displayedMax);
	valueEditor.title = "Edit maximum HP; use the scroll wheel to adjust it";
	valueEditor.textContent = displayedMax;
	valueElement.style.position ||= "relative";
	valueElement.replaceChildren(valueEditor);
	const indicator = document.createElement("span");
	indicator.className = "vurs-max-hp-reduction-indicator";
	const formatAdjustment = adjustment => adjustment > 0 ? `-${adjustment}` : adjustment < 0 ? `+${Math.abs(adjustment)}` : "";
	indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatAdjustment(currentAdjustment) || "none"}`);
	indicator.textContent = formatAdjustment(currentAdjustment);
	indicator.style.cssText = "position:absolute;top:auto;left:auto;right:-0.35em;bottom:-0.55em;display:block;width:2.2em;padding:0;color:inherit;background:transparent;border:0;border-radius:0;font:inherit;font-size:0.55em;line-height:1.3;text-align:right;white-space:nowrap;z-index:1;pointer-events:none;";
	valueElement.append(indicator);

	const updateEditIndicator = value => {
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		const preparedBaseMax = Number(actor.system?.attributes?.hp?.totalModifier);
		const baseMax = Math.max(0, Number.isFinite(preparedBaseMax)
			? preparedBaseMax
			: (Number.isFinite(effectiveMax) ? effectiveMax : hp.max) + currentAdjustment);
		const desiredMax = Math.max(0, Number.isFinite(value) ? Math.trunc(value) : effectiveMax || hp.max);
		const adjustment = baseMax - desiredMax;
		indicator.textContent = formatAdjustment(adjustment);
		indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatAdjustment(adjustment) || "none"}`);
		indicator.style.color = adjustment > 0 ? "#ff8a8a" : "inherit";
		indicator.style.webkitTextStroke = adjustment > 0 ? "0.6px #1a0d0d" : "0";
		indicator.style.textShadow = adjustment > 0
			? "-1px -1px 0 #1a0d0d, 1px -1px 0 #1a0d0d, -1px 1px 0 #1a0d0d, 1px 1px 0 #1a0d0d"
			: "none";
	};
	updateEditIndicator(Number(hp.max));

	const showMaximum = () => {
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		if (Number.isFinite(effectiveMax)) {
			valueEditor.textContent = String(effectiveMax);
			valueEditor.setAttribute("aria-valuenow", String(effectiveMax));
		}
		updateEditIndicator(effectiveMax);
	};
	let cancelEdit = false;
	valueEditor.addEventListener("focus", () => {
		cancelEdit = false;
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		valueEditor.textContent = String(Number.isFinite(effectiveMax) ? effectiveMax : hp.max);
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(valueEditor);
		selection?.removeAllRanges();
		selection?.addRange(range);
		updateEditIndicator(Number(valueEditor.textContent));
	});
	valueEditor.addEventListener("input", () => updateEditIndicator(Number(valueEditor.textContent.trim())));
	valueEditor.addEventListener("wheel", event => {
		if (document.activeElement !== valueEditor || event.deltaY === 0) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		// The editor always contains the absolute maximum HP. Scrolling changes
		// that absolute value by one; typing a number (for example, "5") sets it
		// directly. The small indicator shows the resulting signed adjustment.
		const current = Number(valueEditor.textContent.trim()) || 0;
		const next = Math.max(0, current + (event.deltaY < 0 ? 1 : -1));
		valueEditor.textContent = String(next);
		valueEditor.setAttribute("aria-valuenow", String(next));
		updateEditIndicator(next);
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(valueEditor);
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, { passive: false });
	const saveMaximum = async () => {
		if (cancelEdit) {
			cancelEdit = false;
			showMaximum();
			return;
		}
		const previousAdjustment = getVursMaxHpReduction(actor);
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		const preparedBaseMax = Number(actor.system?.attributes?.hp?.totalModifier);
		const baseMax = Math.max(0, Number.isFinite(preparedBaseMax)
			? preparedBaseMax
			: (Number.isFinite(effectiveMax) ? effectiveMax : hp.max) + previousAdjustment);
		const enteredMaximum = Number(valueEditor.textContent.trim());
		const desiredMax = Math.max(0, Number.isFinite(enteredMaximum) ? Math.trunc(enteredMaximum) : effectiveMax || hp.max);
		const adjustment = baseMax - desiredMax;
		valueEditor.textContent = String(desiredMax);
		valueEditor.setAttribute("aria-valuenow", String(desiredMax));
		indicator.textContent = formatAdjustment(adjustment);
		indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatAdjustment(adjustment) || "none"}`);
		updateEditIndicator(desiredMax);
		try {
			await actor.update({ "flags.vurs.hp.maxReduction": adjustment });
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to update VURS maximum HP`, error);
			ui.notifications?.error("Could not update maximum HP.");
			showMaximum();
			indicator.textContent = formatAdjustment(previousAdjustment);
		}
	};
	valueEditor.addEventListener("blur", saveMaximum);
	valueEditor.addEventListener("keydown", event => {
		if (event.key === "Enter") {
			event.preventDefault();
			valueEditor.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelEdit = true;
			showMaximum();
			valueEditor.blur();
		}
	});
}

function applySystemMode(mode = getSystemMode()) {
	registerVursCharacterPreparationWrappers();
	const translations = game.i18n.translations;
	if (translations) {
		for (const [path, vursText] of Object.entries(VURS_TRANSLATIONS)) {
			if (!originalTranslations.has(path)) originalTranslations.set(path, foundry.utils.getProperty(translations, path));
			const text = mode === "default" ? resolveDefaultAbilityTranslation(path) : vursText;
			if (text !== undefined) foundry.utils.setProperty(translations, path, text);
		}
	}
	// Reprepare world, synthetic-token, and open-sheet actors. PF2e can prepare
	// token actors separately from their world actor, which otherwise leaves a
	// sheet displaying the pre-VURS values until its next update.
	const actors = new Set([
		...(game.actors?.contents ?? []),
		...getCanvasActors(),
		game.user?.character,
		...getOpenApplications().map(app => app.actor ?? app.document?.actor)
	].filter(Boolean));
	for (const actor of actors) {
		installActorVursPreparation(actor, false);
		stripVursDeathConditions(actor);
		void enforceVursDownedEffect(actor);
		// PF2e's reset clears cached prepared state before rebuilding it. Calling
		// prepareData directly can leave startup-derived sheet data stale until
		// the next document update (such as changing HP).
		actor.reset?.();
		rerenderApplication(actor.sheet);
	}
	for (const app of getOpenApplications()) rerenderApplication(app);
}

function getOpenApplications() {
	const v2Applications = foundry.applications?.instances?.values?.() ?? [];
	return [...new Set([...Object.values(ui.windows ?? {}), ...v2Applications])];
}

function rerenderApplication(app) {
	if (typeof app?.render !== "function") return;
	const ApplicationV2 = foundry.applications?.api?.ApplicationV2;
	if (ApplicationV2 && app instanceof ApplicationV2) app.render({ force: true });
	else app.render(false);
}

function getApplicationForRoot(root) {
	const applicationElement = root?.closest?.(".application");
	const v2App = applicationElement?.id
		? foundry.applications?.instances?.get(applicationElement.id)
		: null;
	if (v2App) return v2App;
	const appId = Number(root?.closest?.(".window-app[data-appid], [data-appid]")?.dataset?.appid);
	return Number.isFinite(appId) ? ui.windows?.[appId] ?? null : null;
}

function applyActorAbilityLabels(element, actor) {
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!root || !actor?.isOfType?.("character")) return;
	const useVursLabels = actorUsesVursSystem(actor);
	const restoreDefaultLabels = !useVursLabels && isAnyVursMode();
	if (!restoreDefaultLabels && !(useVursLabels && getSystemMode() === "default")) return;

	const replacements = new Map();
	const shortLabels = { str: "Str", dex: "Agi", con: "Wea", int: "Int", wis: "Spi", cha: "Voi" };
	const standardShortLabels = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };
	const standardLabels = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
	for (const [ability, vursLabel] of Object.entries(VURS_ABILITY_LABELS)) {
		const original = game.i18n.localize(`PF2E.Ability${ability[0].toUpperCase()}${ability.slice(1)}`);
		const current = original && original !== `PF2E.Ability${ability[0].toUpperCase()}${ability.slice(1)}`
			? original
			: standardLabels[ability];
		const label = useVursLabels ? vursLabel : standardLabels[ability];
		replacements.set(useVursLabels ? current : vursLabel, label);
		replacements.set(useVursLabels ? standardLabels[ability] : vursLabel, label);
		const shortOriginal = game.i18n.localize(`PF2E.AbilityId.${ability}`);
		const currentShort = shortOriginal && shortOriginal !== `PF2E.AbilityId.${ability}`
			? shortOriginal
			: standardShortLabels[ability];
		const shortLabel = useVursLabels ? shortLabels[ability] : standardShortLabels[ability];
		replacements.set(useVursLabels ? currentShort : shortLabels[ability], shortLabel);
		replacements.set(useVursLabels ? standardShortLabels[ability] : shortLabels[ability], shortLabel);
	}

	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes = [];
	while (walker.nextNode()) textNodes.push(walker.currentNode);
	for (const node of textNodes) {
		const parentTag = node.parentElement?.tagName;
		if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(parentTag)) continue;
		const text = replaceAbilityLabelText(node.nodeValue, replacements);
		if (text !== node.nodeValue) node.nodeValue = text;
	}

	// Skill modifier breakdowns are stored in tooltip attributes rather than
	// text nodes, so translate those too (for example, a Deception breakdown
	// that names Charisma as its key ability).
	const tooltipAttributes = ["title", "aria-label", "data-tooltip"];
	for (const element of [root, ...root.querySelectorAll("*")]) {
		for (const attribute of tooltipAttributes) {
			const value = element.getAttribute(attribute);
			if (!value) continue;
			const translated = replaceAbilityLabelText(value, replacements);
			if (translated !== value) element.setAttribute(attribute, translated);
		}
	}
}

function replaceAbilityLabelText(text, replacements) {
	let translated = text;
	for (const [source, replacement] of replacements) {
		if (!source) continue;
		const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		translated = translated.replace(new RegExp(`\\b${escaped}\\b`, "gi"), replacement);
	}
	return translated;
}

function getCanvasActors() {
	const actors = [];
	for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
		if (token.actor) actors.push(token.actor);
	}
	for (const token of globalThis.canvas?.tokens?.controlled ?? []) {
		if (token.actor) actors.push(token.actor);
	}
	return actors;
}

function refreshCanvasActors() {
	const tokens = globalThis.canvas?.tokens?.placeables ?? [];
	const actors = new Set(tokens.map(token => token.actor).filter(Boolean));
	for (const actor of actors) {
		installActorVursPreparation(actor, false);
		actor.reset?.();
		actor.sheet?.render?.(false);
	}
	// Derived VURS HP is applied during actor preparation. That preparation
	// does not emit an actor update, so token bars can retain their pre-VURS
	// maximum until each active token is explicitly refreshed. Only the bars
	// need it — a full token.refresh() also propagates refreshSize, which can
	// race the async turn-marker texture load during encounters and crash
	// Token._refreshSize on this.turnMarker.mesh.
	for (const token of tokens) token.renderFlags?.set?.({ refreshBars: true });
}

function installActorPreparationSupport(reprepare = true) {
	const actors = [...(game.actors?.contents ?? [])];
	for (const actor of actors) installActorVursPreparation(actor, reprepare);
	if (!actorCreationHookInstalled) {
		Hooks.on("createActor", actor => installActorVursPreparation(actor));
		actorCreationHookInstalled = true;
	}
}

function installSystemPatches() {
	installDicelessPatches();
	installVursCriticalDamage();
	installVursPlayCostRefreshPatch();
}

function installVursPlayCostRefreshPatch() {
	const prototype = CONFIG.Item?.documentClass?.prototype;
	const originalRefresh = prototype?.refreshFromCompendium;
	if (typeof originalRefresh !== "function" || prototype[VURS_PLAY_COST_REFRESH_PATCH]) return;

	prototype.refreshFromCompendium = async function (options = {}) {
		const sourceId = this.sourceId;
		const sourceItem = sourceId?.startsWith("Compendium.") ? await fromUuid(sourceId) : null;
		const originalUpdate = this.update;
		const ownUpdateDescriptor = Object.getOwnPropertyDescriptor(this, "update");
		this.update = function (changes, updateOptions = {}) {
			if (updateOptions.diff === false && updateOptions.recursive === false && changes?.system && sourceId) {
				const stats = changes._stats ??= {};
				const sourceStats = this._source?._stats ?? {};
				if (sourceStats.duplicateSource) stats.duplicateSource = sourceStats.duplicateSource;
				if (sourceStats.compendiumSource) stats.compendiumSource = sourceStats.compendiumSource;
				if (!stats.duplicateSource && !stats.compendiumSource) stats.duplicateSource = sourceId;
			}
			return originalUpdate.call(this, changes, updateOptions);
		};
		let refreshedItem;
		try {
			refreshedItem = await originalRefresh.call(this, options);
		} finally {
			if (ownUpdateDescriptor) Object.defineProperty(this, "update", ownUpdateDescriptor);
			else delete this.update;
		}
		if (!refreshedItem || !sourceItem) return refreshedItem;

		const playCost = normalizeVursPlayCost(foundry.utils.getProperty(sourceItem, "flags.vurs.playCost"));
		const update = playCost
			? { "flags.vurs.playCost": playCost }
			: { "flags.vurs.playCost": new foundry.data.operators.ForcedDeletion() };

		if (options.update === false) this.updateSource(update);
		else {
			await this.update(update, { render: false });
			if (this.sheet?.rendered) rerenderApplication(this.sheet);
		}
		return refreshedItem;
	};
	Object.defineProperty(prototype, VURS_PLAY_COST_REFRESH_PATCH, { value: true });
}

function installActorVursPreparation(actor, reprepare = true) {
	if (actor?.isOfType?.("character")) registerVursCharacterPreparationWrappers();
	else if (actor?.isOfType?.("npc")) registerVursNpcPreparationWrappers();
	else return;
	if (reprepare) actor.prepareData?.();
}

// Negative HP wrappers shared by every actor type the rules apply to
// (characters and NPCs). All gates use actorUsesVursHpRules so Default mode
// with the feature enabled behaves identically to the VURS profiles.
function vursSharedHpWrappers() {
	return {
		modifyTokenAttribute: function (wrapped, attribute, value, isDelta = false, ...args) {
			const enteredHp = Number(value);
			if (attribute === "attributes.hp" && !isDelta && Number.isFinite(enteredHp) &&
				enteredHp < 0 && actorUsesVursHpRules(this)) {
				// PF2e routes the token HUD's absolute HP field through applyDamage.
				// Persist negative absolute values directly so _preUpdate converts
				// them to HP reduction, while chat-applied damage remains disabled.
				return this.update({ "system.attributes.hp.value": enteredHp });
			}
			return wrapped(attribute, value, isDelta, ...args);
		},
		update: async function (wrapped, changed, options = {}, ...args) {
			const requestedHp = foundry.utils.getProperty(changed, "system.attributes.hp.value") ??
				changed?.["system.attributes.hp.value"];
			const repairUndoHp = options.damageUndo === true && options.vursDamageUndoRepair !== true &&
				actorUsesVursHpRules(this) && Number.isFinite(Number(requestedHp));
			const result = await wrapped(changed, options, ...args);
			if (!repairUndoHp) return result;

			// PF2e restores HP and the VURS max-HP reduction in one update. That
			// update can clamp the restored HP against the old reduced maximum.
			// Reapply the undo value after the reduction has been restored.
			const desiredHp = Number(requestedHp);
			const restoredMax = Number(this.system?.attributes?.hp?.max);
			const restoredHp = Math.clamp(desiredHp, 0, Number.isFinite(restoredMax) ? restoredMax : desiredHp);
			if (this.system?.attributes?.hp?.value !== restoredHp) {
				await wrapped({ "system.attributes.hp.value": restoredHp }, {
					...options,
					vursDamageUndoRepair: true,
					damageTaken: 0
				}, ...args);
			}
			return result;
		},
		_preUpdate: function (wrapped, changed, options, user, ...args) {
			if (actorUsesVursHpRules(this)) {
				const changedHp = foundry.utils.getProperty(changed, "system.attributes.hp");
				const reductionPath = "flags.vurs.hp.maxReduction";
				const hasExplicitReduction = foundry.utils.getProperty(changed, reductionPath) !== undefined ||
					foundry.utils.getProperty(changed, "flags.vurs.hp.maxReduction") !== undefined;
				const currentReduction = getVursMaxHpReduction(this);
				const currentMax = Number(this.system?.attributes?.hp?.max);
				// PF2e's damage-revert action restores the previous HP value. Since
				// the VURS max-HP flag is outside PF2e's health data, that restore can
				// otherwise leave the reduced maximum in place and clamp HP back down.
				// If an update restores HP above the reduced maximum without carrying
				// an explicit reduction value, restore the unreduced maximum too.
				if (Number.isFinite(changedHp?.value) && changedHp.value > currentMax &&
					currentReduction > 0 && !hasExplicitReduction) {
					foundry.utils.setProperty(changed, reductionPath, 0);
				}
				if (Number.isFinite(changedHp?.value) && changedHp.value < 0) {
					const overflow = Math.ceil(-changedHp.value);
					const baseMax = getVursBaseMaxHp(this);
					changedHp.value = 0;
					foundry.utils.setProperty(changed, reductionPath,
						Math.min(baseMax, currentReduction + overflow));
				}
			}
			return wrapped(changed, options, user, ...args);
		},
		calculateHealthDelta: function (wrapped, healthData, ...args) {
			const result = wrapped(healthData, ...args);
			if (!actorUsesVursHpRules(this) || !healthData || healthData.delta <= 0 || healthData.hp?.max <= 0) return result;

			// PF2e applies damage to temporary HP, then stamina, then HP. Preserve
			// that order and convert only the remaining damage below zero HP.
			let remainingDamage = healthData.delta;
			const fromTemporaryHp = Math.min(Math.max(healthData.hp.temp || 0, 0), remainingDamage);
			remainingDamage -= fromTemporaryHp;
			if (healthData.sp && game.pf2e.settings.variants.stamina) {
				remainingDamage -= Math.min(Math.max(healthData.sp.value || 0, 0), remainingDamage);
			}
			const overflow = Math.max(0, remainingDamage - Math.max(healthData.hp.value || 0, 0));
			if (overflow <= 0) return result;

			const currentAdjustment = getVursMaxHpReduction(this);
			const baseMax = getVursBaseMaxHp(this);
			const adjusted = Math.min(baseMax, currentAdjustment + overflow);
			foundry.utils.setProperty(this._source, "flags.vurs.hp.maxReduction", currentAdjustment);
			result.updates ??= {};
			result.updates["flags.vurs.hp.maxReduction"] = adjusted;
			return result;
		},
		undoDamage: async function (wrapped, appliedDamage, ...args) {

			if (this[VURS_UNDO_ACTIVE]) return wrapped(appliedDamage, ...args);

			const snapshot = appliedDamage?.vursNegativeHp;
			const recordedUpdates = appliedDamage?.updates ?? [];
			const hpPath = "system.attributes.hp.value";
			const reductionPath = "flags.vurs.hp.maxReduction";
			const hpUndo = recordedUpdates.find(update => update.path === hpPath);
			const reductionUndo = recordedUpdates.find(update => update.path === reductionPath);
			if (!snapshot && !reductionUndo) return wrapped(appliedDamage, ...args);

			const updates = foundry.utils.deepClone(recordedUpdates);
			const otherUpdates = updates.filter(update => update.path !== hpPath && update.path !== reductionPath);
			const currentReduction = getVursMaxHpReduction(this);
			const targetReduction = snapshot
				? Number(snapshot.reduction) || 0
				: currentReduction + (Number(reductionUndo.value) || 0);
			const currentHp = Number(this.system?.attributes?.hp?.value) || 0;
			const targetHp = Math.max(0, snapshot
				? Number(snapshot.hp) || 0
				: currentHp + (Number(hpUndo?.value) || 0));

			// PF2e's undoDamage starts Actor.update without awaiting it. Capture that
			// update, inject the saved reduction alongside HP, and await completion so
			// its asynchronous write cannot overwrite the rollback.
			const updateDescriptor = Object.getOwnPropertyDescriptor(this, "update");
			const originalUpdate = this.update;
			const pendingUpdates = [];
			this[VURS_UNDO_ACTIVE] = true;
			this.update = function (...updateArgs) {
				if (updateArgs[1]?.damageUndo && updateArgs[0] && typeof updateArgs[0] === "object") {
					updateArgs[0] = { ...updateArgs[0], ...getVursReductionUpdates(targetReduction) };
				}
				const pending = originalUpdate.apply(this, updateArgs);
				pendingUpdates.push(pending);
				return pending;
			};
			let result;
			try {
				result = await wrapped({ ...appliedDamage, updates: otherUpdates }, ...args);
				await Promise.all(pendingUpdates);
				await this.update({
					[hpPath]: targetHp,
					...getVursReductionUpdates(targetReduction)
				}, { damageUndo: true, damageTaken: currentHp - targetHp, render: true });
				return result;
			} finally {
				if (updateDescriptor) Object.defineProperty(this, "update", updateDescriptor);
				else delete this.update;
				delete this[VURS_UNDO_ACTIVE];
			}
		}
	};
}

// Negative HP damage handling joins the shared applyDamage handler chain
// (dispatched by the single libWrapper registration in lifesteal.js) instead of
// registering its own applyDamage wrapper, which libWrapper rejects as a
// duplicate for the same module and target.
const VURS_NEGATIVE_HP_DAMAGE_HANDLER = Symbol.for(`${MODULE_ID}.negativeHpDamageHandler`);
async function vursNegativeHpApplyDamageHandler(actor, wrapped, args) {
	const params = args[0];
	const reductionPath = "flags.vurs.hp.maxReduction";
	const hpRules = actorUsesVursHpRules(actor);
	const previousReduction = hpRules ? getVursMaxHpReduction(actor) : 0;
	const previousHp = hpRules ? Number(actor.system?.attributes?.hp?.value) || 0 : 0;
	// Chat messages are append-only and chronological, so a single anchor id is
	// enough to find the messages created during this damage call without
	// snapshotting the whole history into a Set on every roll.
	const messagesBefore = hpRules ? (game.messages?.contents ?? []) : null;
	const previousLastMessageId = messagesBefore?.[messagesBefore.length - 1]?.id ?? null;
	const persistedReduction = foundry.utils.getProperty(actor, reductionPath) ??
		foundry.utils.getProperty(actor, `_source.${reductionPath}`);
	// PF2e creates its damage-revert record from numeric values that existed
	// before damage. Seed zero so the first VURS overflow update is included
	// in that native undo record as well.
	if (hpRules && !Number.isFinite(Number(persistedReduction))) {
		await actor.update({ [reductionPath]: 0 }, { render: false });
	}
	const result = await wrapped(...args);
	if (!messagesBefore) return result;

	// A successful Treat Wounds removes the max-HP reduction on the
	// patient, matching the long-rest recovery rule.
	const appliedAmount = Number(params?.damage);
	if (appliedAmount < 0 && getVursMaxHpReduction(actor) > 0 &&
		matchVursTreatWoundsHeal(Math.abs(appliedAmount), params?.outcome)) {
		await actor.update({
			"flags.vurs.hp.maxReduction": new foundry.data.operators.ForcedDeletion()
		}, { render: false });
	}

	const nextReduction = getVursMaxHpReduction(actor);
	if (nextReduction <= previousReduction) return result;

	// Some PF2e update paths omit custom flag changes from their prepared
	// actor update and from the damage-taken card's undo record. Keep the
	// reduction out of PF2e's appliedDamage updates (the module reasserts it
	// itself) and record the real HP delta so native undo stays accurate.
	const allMessages = game.messages?.contents ?? [];
	const newDamageCandidates = [];
	// Scan backwards from the newest message and stop at the pre-damage anchor.
	// If the anchor is absent (chat cleared) the loop simply scans everything,
	// preserving the original full-scan behavior as a fallback.
	for (let index = allMessages.length - 1; index >= 0; index--) {
		const candidate = allMessages[index];
		if (candidate.id === previousLastMessageId) break;
		if (foundry.utils.getProperty(candidate, "flags.pf2e.context.type") !== "damage-taken") continue;
		// PF2e leaves appliedDamage null when no HP was actually changed (for
		// example, an actor already at 0 HP). Match the recipient card by its
		// speaker as a fallback so overkill is still reported there.
		if (foundry.utils.getProperty(candidate, "flags.pf2e.appliedDamage.uuid") === actor.uuid ||
			candidate.speaker?.actor === actor.id) {
			newDamageCandidates.push(candidate);
		}
	}
	const message = newDamageCandidates
		.sort((left, right) => right.timestamp - left.timestamp)[0];
	const appliedDamage = message && foundry.utils.getProperty(message, "flags.pf2e.appliedDamage");
	if (message && appliedDamage && Array.isArray(appliedDamage.updates)) {
		const updatedAppliedDamage = foundry.utils.deepClone(appliedDamage);
		const hpUndoDelta = previousHp - (Number(actor.system?.attributes?.hp?.value) || 0);
		const hpUpdate = updatedAppliedDamage.updates.find(update => update.path === "system.attributes.hp.value");
		if (hpUpdate && hpUndoDelta === 0) {
			updatedAppliedDamage.updates = updatedAppliedDamage.updates.filter(update => update !== hpUpdate);
		} else if (hpUpdate) {
			hpUpdate.value = hpUndoDelta;
		}
		// PF2e's native undo handles HP. Keep this custom reduction out of its
		// update list so the actor ledger applies the reduction delta once after
		// PF2e's fire-and-forget HP update finishes.
		updatedAppliedDamage.updates = updatedAppliedDamage.updates.filter(update =>
			update.path !== reductionPath
		);
		await message.update({ "flags.pf2e.appliedDamage": updatedAppliedDamage });
	}
	return result;
}

function installVursNegativeHpDamageHandler() {
	if (globalThis[VURS_NEGATIVE_HP_DAMAGE_HANDLER]) return;
	const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
	damageHandlers.add(vursNegativeHpApplyDamageHandler);
	globalThis[VURS_NEGATIVE_HP_DAMAGE_HANDLER] = true;
}

// Post-prepareDerivedData handler for NPCs, dispatched by the shared wrapper
// in npcConfiguration.js alongside its DC-scaling handler.
function vursNpcPrepareDerivedDataHandler(actor, result) {
	installActorDamageActionContext(actor);
	if (actorUsesVursHpRules(actor)) {
		applyVursHitPoints(
			actor,
			getVursStoredMaxHpReduction(actor),
			VURS_ABILITY_LABELS.str,
			actorUsesVursSystem(actor)
		);
	}
	return result;
}

function registerVursCharacterPreparationWrappers(actorClass = CONFIG.PF2E?.Actor?.documentClasses?.character) {
	if (!actorClass?.prototype) return;
	installVursNegativeHpDamageHandler();
	if (typeof globalThis.libWrapper?.register !== "function") return;
	const wrappers = {
		prepareBuildData: function (wrapped, ...args) {
			const result = wrapped(...args);
			if (actorUsesMainAttribute(this)) applyMainAttributeBoost(this);
			return result;
		},
		prepareStrike: function (wrapped, ...args) {
			const attribute = actorUsesMainAttribute(this) ? getMainAttribute(this) : null;
			const item = args[0];
			if (!attribute || !item?.system) return wrapped(...args);

			const originalDefaultAttribute = Object.getOwnPropertyDescriptor(item, "defaultAttribute");
			const abilityModifiers = this.system?.abilities;
			const originalAbilityModifiers = new Map();
			let defaultAttributeOverridden = false;
			try {
				Object.defineProperty(item, "defaultAttribute", {
					configurable: true,
					value: attribute
				});
				defaultAttributeOverridden = true;
				const mainModifier = abilityModifiers?.[attribute]?.mod;
				if (Number.isFinite(mainModifier)) {
					for (const [ability, data] of Object.entries(abilityModifiers)) {
						if (ability === attribute || !Number.isFinite(data?.mod)) continue;
						originalAbilityModifiers.set(ability, data.mod);
						data.mod = Math.min(data.mod, mainModifier - 1);
					}
				}
				if (item.defaultAttribute !== attribute) {
					console.error(`${MODULE_ID} | Could not set Main Attribute for ${item.name}'s Strike`);
				}
			} catch (error) {
				console.error(`${MODULE_ID} | Failed to set Main Attribute for ${item.name}'s Strike`, error);
			}

			let strike;
			try {
				strike = wrapped(...args);
			} finally {
				for (const [ability, modifier] of originalAbilityModifiers) {
					abilityModifiers[ability].mod = modifier;
				}
				if (defaultAttributeOverridden) {
					if (originalDefaultAttribute) {
						Object.defineProperty(item, "defaultAttribute", originalDefaultAttribute);
					} else {
						delete item.defaultAttribute;
					}
				}
			}
			return applyMainAttributeToStrike(this, strike, item, attribute);
		},
		prepareSaves: function (wrapped, ...args) {
			if (actorUsesVursSystem(this) && this.system?.saves) {
				if (this.system.saves.fortitude) this.system.saves.fortitude.attribute = "str";
				if (this.system.saves.will) this.system.saves.will.attribute = "int";
			}
			return wrapped(...args);
		},
		preparePerception: function (wrapped, ...args) {
			const usesVurs = actorUsesVursSystem(this);
			if (usesVurs) addSavingThrowRuleSupport(this, ["perception"]);
			const perceptionRank = this.system?.perception?.rank;
			const result = wrapped(...args);
			if (usesVurs && this.perception) {
				const current = this.perception;
				const data = foundry.utils.deepClone(current.data);
				data.attribute = "cha";
				data.modifiers = (data.modifiers ?? []).filter(modifier =>
					!(modifier.type === "ability" && modifier.ability === "wis")
				);
				data.domains = [...new Set([
					...(data.domains ?? []).filter(domain => domain !== "wis-based"),
					"cha-based",
					"saving-throw"
				])];
				data.rollOptions = [...new Set([...(data.rollOptions ?? []), "saving-throw", "saving-throw:perception"])];
				this.perception = new current.constructor(this, data, current.config);
				this.system.perception = Object.assign(this.perception.getTraceData(), {
					details: this.system.perception.details,
					mod: this.perception.mod,
					rank: perceptionRank ?? this.perception.rank
				});
			}
			return result;
		},
		prepareSkills: function (wrapped, ...args) {
			if (this.isOfType?.("character")) {
				const usesVurs = actorUsesVursSystem(this);
				if (getActorSystemMode(this) === "vurs") applyFullVursSkillAttributes(this);
				if (actorUsesAgnosticVurs(this)) applyAgnosticVursSkillAttributes(this);
				const dexteritySkill = this.system?.skills?.["dexterity-skill"];
				if (dexteritySkill) dexteritySkill.label = usesVurs ? "Dexterity" : "Agility";
			}
			if (actorUsesVursSystem(this)) addSavingThrowRuleSupport(this, ["acquisition", "soul"]);
			const result = wrapped(...args);
			if (actorUsesVursSystem(this)) {
				for (const slug of ["acquisition", "soul"]) addSavingThrowDomains(this, slug);
			}
			return result;
		},
		prepareDerivedData: function (wrapped, ...args) {
			const result = wrapped(...args);
			installActorDamageActionContext(this);
			if (actorUsesVursHpRules(this)) {
				// VURS profiles use Strength-based HP; Default mode with the feature
				// keeps PF2e's Constitution-based maximum and only applies the
				// persisted max-HP reduction.
				applyVursHitPoints(
					this,
					getVursStoredMaxHpReduction(this),
					VURS_ABILITY_LABELS.str,
					actorUsesVursSystem(this)
				);
			}
			if (actorUsesVursSystem(this)) {
				if (actorUsesMainAttribute(this)) registerMainAttributeDamageModifiers(this);
				if (actorUsesAgnosticVurs(this) || (!isFullVursMode() &&
					(actorHasVursSystemFlag(this) || actorHasAgnosticSystemFlag(this)))) applyActorAbilityDataLabels(this);
			} else if (isAnyVursMode()) {
				applyDefaultActorAbilityDataLabels(this);
			}
			applyVursConsolidatedSkillAttributes(this);
			applyVursStatisticSkillMirrors(this);
			return result;
		},
		...vursSharedHpWrappers()
	};
	for (const [method, wrapper] of Object.entries(wrappers)) {
		registerActorPreparationWrapper(actorClass, method, wrapper);
	}
}

function registerVursNpcPreparationWrappers(actorClass = CONFIG.PF2E?.Actor?.documentClasses?.npc) {
	if (!actorClass?.prototype) return;
	installVursNegativeHpDamageHandler();
	if (typeof globalThis.libWrapper?.register !== "function") return;
	const wrappers = {
		preparePerception: function (wrapped, ...args) {
			const usesVurs = actorUsesVursSystem(this);
			if (usesVurs) addSavingThrowRuleSupport(this, ["perception"]);
			const result = wrapped(...args);
			if (usesVurs) addSavingThrowDomains(this, "perception");
			return result;
		},
		prepareSkills: function (wrapped, ...args) {
			const usesVurs = actorUsesVursSystem(this);
			if (usesVurs) addSavingThrowRuleSupport(this, ["acquisition", "soul"]);
			const result = wrapped(...args);
			if (usesVurs) {
				for (const slug of ["acquisition", "soul"]) addSavingThrowDomains(this, slug);
			}
			return result;
		},
		...vursSharedHpWrappers()
	};
	// NPCs share the Negative HP rules with characters. Apply the persisted
	// max-HP reduction (and Strength-based HP for VURS profiles) during
	// whichever preparation stage the NPC class exposes. prepareDerivedData is
	// shared with npcConfiguration's DC scaling through a single dispatcher
	// wrapper because libWrapper allows only one wrapper per module per target.
	const hpPreparationMethod = typeof actorClass.prototype?.prepareDerivedData === "function"
		? "prepareDerivedData"
		: typeof actorClass.prototype?.prepareData === "function" ? "prepareData" : null;
	if (hpPreparationMethod === "prepareDerivedData") {
		addNpcPrepareDerivedDataHandler(vursNpcPrepareDerivedDataHandler);
	} else if (hpPreparationMethod === "prepareData") {
		wrappers.prepareData = function (wrapped, ...args) {
			const result = wrapped(...args);
			installActorDamageActionContext(this);
			if (actorUsesVursHpRules(this)) {
				applyVursHitPoints(
					this,
					getVursStoredMaxHpReduction(this),
					VURS_ABILITY_LABELS.str,
					actorUsesVursSystem(this)
				);
			}
			return result;
		};
	}
	for (const [method, wrapper] of Object.entries(wrappers)) {
		registerActorPreparationWrapper(actorClass, method, wrapper);
	}
}

function registerActorPreparationWrapper(actorClass, method, wrapper) {
	const actorPrototype = actorClass?.prototype;
	if (!actorPrototype || typeof actorPrototype[method] !== "function") return;
	const classKey = actorClass.name || "CharacterPF2e";
	const key = `${classKey}:${method}`;
	if (registeredActorWrappers.has(key)) return;

	// Register against PF2e's stable class path. A temporary window alias can
	// resolve differently inside libWrapper and silently miss startup prep.
	// PF2e exposes the concrete character document class before systemReady.
	const actorClasses = CONFIG.PF2E?.Actor?.documentClasses ?? {};
	const actorType = Object.entries(actorClasses).find(([, documentClass]) => documentClass === actorClass)?.[0];
	const isBaseActorClass = actorClass === CONFIG.Actor?.documentClass;
	const target = actorType
		? `CONFIG.PF2E.Actor.documentClasses.${actorType}.prototype.${method}`
		: isBaseActorClass ? `CONFIG.Actor.documentClass.prototype.${method}` : null;
	if (!target) {
		console.warn(`${MODULE_ID} | Skipping ${classKey}.${method}: not a configured PF2e actor class`);
		return;
	}
	try {
		globalThis.libWrapper.register(MODULE_ID, target, wrapper, "WRAPPER");
		registeredActorWrappers.add(key);
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to register libWrapper for ${target}`, error);
	}
}

// VURS Negative HP rules replace PF2e's dying/wounded flow with a plain 0 HP
// state: no condition items are applied, so PF2e's isDead/canAct getters would
// treat a condition-less 0 HP actor as dead and unable to act. Wrap the owning
// prototypes so actors under the rules stay alive and active at 0 HP while the
// `dead` status (death trait, instant death) is still respected.
const VURS_DEATH_STATE_GETTER = Symbol("vurs-pf2e.deathStateGetter");
function installVursDeathStateGetterPatches() {
	const prototypes = new Set();
	for (const actorClass of [
		CONFIG.PF2E?.Actor?.documentClasses?.character,
		CONFIG.PF2E?.Actor?.documentClasses?.npc
	]) {
		let prototype = actorClass?.prototype;
		while (prototype && prototype !== Object.prototype) {
			prototypes.add(prototype);
			prototype = Object.getPrototypeOf(prototype);
		}
	}
	for (const prototype of prototypes) {
		for (const [property, wrap] of [["isDead", wrapVursIsDeadGetter], ["canAct", wrapVursCanActGetter]]) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
			if (!descriptor?.get || descriptor.get[VURS_DEATH_STATE_GETTER]) continue;
			const original = descriptor.get;
			const wrapped = wrap(original);
			Object.defineProperty(wrapped, VURS_DEATH_STATE_GETTER, { value: true });
			Object.defineProperty(prototype, property, { configurable: true, get: wrapped });
		}
	}
}

function wrapVursIsDeadGetter(original) {
	return function () {
		const dead = original.call(this);
		if (!dead || !actorUsesVursHpRules(this)) return dead;
		const hp = this.system?.attributes?.hp;
		if (Number(hp?.value) <= 0 && !this.statuses?.has("dead")) return false;
		return dead;
	};
}

function wrapVursCanActGetter(original) {
	return function () {
		const canAct = original.call(this);
		if (canAct || !actorUsesVursHpRules(this)) return canAct;
		const hp = this.system?.attributes?.hp;
		if (Number(hp?.value) > 0 || this.statuses?.has("dead")) return canAct;
		if (typeof this.hasCondition !== "function") return canAct;
		if (this.hasCondition("paralyzed", "stunned")) return canAct;
		return true;
	};
}

function installVursDamagePatch() {
	const actorClass = CONFIG.Actor?.documentClass;
	const prototype = actorClass?.prototype;
	if (!prototype || typeof prototype.applyDamage !== "function" || prototype.__vursNegativeHpDamagePatch) return;

	const originalApplyDamage = prototype.applyDamage;
	prototype.applyDamage = async function (params, ...args) {
		const reductionPath = "flags.vurs.hp.maxReduction";
		const previousReduction = getVursMaxHpReduction(this);
		const previousHp = Number(this.system?.attributes?.hp?.value) || 0;
		const previousMessages = new Set(game.messages?.contents?.map(message => message.id) ?? []);
		const originalCalculateHealthDelta = this.calculateHealthDelta;
		const ownCalculateDescriptor = Object.getOwnPropertyDescriptor(this, "calculateHealthDelta");
		let overflowToApply = 0;

		this.calculateHealthDelta = function (healthData, ...calculateArgs) {
			const calculation = originalCalculateHealthDelta.call(this, healthData, ...calculateArgs);
			if (!actorUsesVursHpRules(this) || !healthData || Number(healthData.delta) <= 0 || Number(healthData.hp?.max) <= 0) {
				return calculation;
			}

			let remainingDamage = Number(healthData.delta);
			const fromTemporaryHp = Math.min(Math.max(Number(healthData.hp.temp) || 0, 0), remainingDamage);
			remainingDamage -= fromTemporaryHp;
			if (healthData.sp && game.pf2e.settings.variants.stamina) {
				remainingDamage -= Math.min(Math.max(Number(healthData.sp.value) || 0, 0), remainingDamage);
			}
			const hpValue = Math.max(Number(healthData.hp.value) || 0, 0);
			const overflow = Math.max(0, remainingDamage - hpValue);
			if (overflow > 0) {
				overflowToApply = Math.max(overflowToApply, overflow);
				const currentAdjustment = getVursMaxHpReduction(this);
				const baseMaximum = getVursBaseMaxHp(this);
				// Preserve the existing numeric flag in PF2e's pre-damage snapshot so
				// its native undo card can capture the reduction delta.
				foundry.utils.setProperty(this._source, reductionPath, currentAdjustment);
				foundry.utils.setProperty(this._source, moduleReductionPath, currentAdjustment);
				calculation.updates[reductionPath] = Math.min(baseMaximum, currentAdjustment + overflow);
				calculation.updates[moduleReductionPath] = Math.min(baseMaximum, currentAdjustment + overflow);
			}
			return calculation;
		};

		let result;
		try {
			result = await originalApplyDamage.call(this, params, ...args);
		} finally {
			if (ownCalculateDescriptor) Object.defineProperty(this, "calculateHealthDelta", ownCalculateDescriptor);
			else delete this.calculateHealthDelta;
		}

		let nextReduction = getVursMaxHpReduction(this);
		if (actorUsesVursHpRules(this) && overflowToApply > 0) {
			const baseMaximum = getVursBaseMaxHp(this);
			const desiredReduction = Math.min(baseMaximum, previousReduction + overflowToApply);
			if (desiredReduction > nextReduction) {
				// Some PF2e update paths omit custom flag changes from their prepared
				// actor update. Apply the computed overflow after PF2e finishes too.
				await this.update(getVursReductionUpdates(desiredReduction), { render: false });
				nextReduction = getVursMaxHpReduction(this);
			}
		}
		if (!actorUsesVursHpRules(this) || nextReduction <= previousReduction) return result;

		const message = [...(game.messages?.contents ?? [])]
			.filter(candidate => {
				if (previousMessages.has(candidate.id) ||
					foundry.utils.getProperty(candidate, "flags.pf2e.context.type") !== "damage-taken") return false;
				// PF2e leaves appliedDamage null when no HP was actually changed (for
				// example, an actor already at 0 HP). Match the recipient card by its
				// speaker as a fallback so overkill is still reported there.
				return foundry.utils.getProperty(candidate, "flags.pf2e.appliedDamage.uuid") === this.uuid ||
					candidate.speaker?.actor === this.id;
			})
			.sort((left, right) => right.timestamp - left.timestamp)[0];
		const appliedDamage = message && foundry.utils.getProperty(message, "flags.pf2e.appliedDamage");
		if (message && appliedDamage && Array.isArray(appliedDamage.updates)) {
			const updatedAppliedDamage = foundry.utils.deepClone(appliedDamage);
			const hpUndoDelta = previousHp - (Number(this.system?.attributes?.hp?.value) || 0);
			const hpUpdate = updatedAppliedDamage.updates.find(update => update.path === "system.attributes.hp.value");
			if (hpUpdate && hpUndoDelta === 0) {
				updatedAppliedDamage.updates = updatedAppliedDamage.updates.filter(update => update !== hpUpdate);
			} else if (hpUpdate) {
				hpUpdate.value = hpUndoDelta;
			}
			// PF2e's native undo handles HP. Keep this custom reduction out of its
			// update list so the actor ledger applies the reduction delta once after
			// PF2e's fire-and-forget HP update finishes.
			updatedAppliedDamage.updates = updatedAppliedDamage.updates.filter(update =>
				update.path !== reductionPath && update.path !== moduleReductionPath &&
				update.path !== "flags.vurs.hp.maxReduction"
			);
			await message.update({ "flags.pf2e.appliedDamage": updatedAppliedDamage });
		}
		return result;
	};
	Object.defineProperty(prototype, "__vursNegativeHpDamagePatch", { value: true });
}

function addSavingThrowRuleSupport(actor, slugs) {
	const modifiers = actor.synthetics?.modifiers;
	const adjustments = actor.synthetics?.modifierAdjustments;
	for (const slug of slugs) {
		for (const collection of [modifiers, adjustments]) {
			if (!collection) continue;
			const savingThrowEntries = collection["saving-throw"];
			if (!Array.isArray(savingThrowEntries)) continue;
			const entries = (collection[slug] ??= []);
			for (const entry of savingThrowEntries) {
				if (!entries.includes(entry)) entries.push(entry);
			}
		}
	}
}

function addSavingThrowDomains(actor, slug) {
	const isPerception = slug === "perception";
	const current = isPerception ? actor.perception : actor.skills?.[slug];
	if (!current?.data) return;

	// Rebuild the Statistic after extending its domains. Mutating the prepared
	// statistic after construction only adds a roll option; PF2e has already
	// extracted synthetics for its check selector by then.
	const data = foundry.utils.deepClone(current.data);
	data.domains = [...new Set([...(data.domains ?? []), "saving-throw", `${slug}-based`])];
	data.check ??= {};
	data.check.domains = [...new Set([...(data.check.domains ?? []), "saving-throw"])];
	data.rollOptions = [...new Set([...(data.rollOptions ?? []), "saving-throw", `saving-throw:${slug}`])];

	const statistic = new current.constructor(actor, data, current.config);
	if (isPerception) actor.perception = statistic;
	else actor.skills[slug] = statistic;
	const systemData = isPerception ? actor.system.perception : actor.system.skills?.[slug];
	if (systemData) {
		const updatedSystemData = Object.assign({}, systemData, statistic.getTraceData(), {
			mod: statistic.check.mod
		});
		if (isPerception) actor.system.perception = updatedSystemData;
		else actor.system.skills[slug] = updatedSystemData;
	}
}

function getVursReductionUpdates(value) {
	return { "flags.vurs.hp.maxReduction": value };
}

function applyActorAbilityDataLabels(actor) {
	const abilities = actor.system?.abilities;
	if (!abilities) return;
	const shortLabels = { str: "Str", dex: "Agi", con: "Wea", int: "Int", wis: "Spi", cha: "Voi" };
	for (const [slug, label] of Object.entries(VURS_ABILITY_LABELS)) {
		if (!abilities[slug]) continue;
		abilities[slug].label = label;
		abilities[slug].shortLabel = shortLabels[slug];
	}
}

function applyDefaultActorAbilityDataLabels(actor) {
	const abilities = actor.system?.abilities;
	if (!abilities) return;
	const labels = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
	const shortLabels = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };
	for (const [slug, label] of Object.entries(labels)) {
		if (!abilities[slug]) continue;
		abilities[slug].label = label;
		abilities[slug].shortLabel = shortLabels[slug];
	}
}

function reorderAttributeBuilderColumns(element, actor) {
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!isAnyVursMode() && !actorHasVursSystemFlag(actor) &&
		!actorHasAgnosticSystemFlag(actor)) return;
	const rows = root?.querySelector?.(".attribute-rows");
	if (!rows) return;
	for (const columns of rows.querySelectorAll(".attributes")) {
		const children = columns.matches(".summary-row .attributes")
			? [...columns.querySelectorAll(":scope > .row-column")]
			: [...columns.children];
		if (children.length !== 6) continue;
		// Keep the builder's Spirit and Void items on the same grid row while
		// swapping their columns. Assigning only grid-column makes CSS Grid place
		// Void on the next row because it follows Spirit in document order.
		children.forEach((child, index) => {
			child.style.gridColumn = String(index === 4 ? 6 : index === 5 ? 5 : index + 1);
			child.style.gridRow = "1";
		});
	}
}

function reorderCharacterSheetAttributes(element, actor) {
	if (!actorUsesVursSystem(actor)) return;
	const root = element instanceof HTMLElement ? element : element?.[0];
	const selectors = [
		".subsection.attributes ul",
		".attribute-modifiers .section-body .list"
	].join(", ");
	const lists = root?.matches?.(selectors)
		? [root]
		: [...(root?.querySelectorAll?.(selectors) ?? [])];
	for (const list of lists) {
		const order = ["str", "dex", "con", "int", "cha", "wis"];
		const npcAttributes = list.matches(".attribute-modifiers .section-body .list");
		const spiritSelector = npcAttributes ? ':scope > [data-attribute="wis"]' : ':scope > li[data-attribute="wis"]';
		const voidSelector = npcAttributes ? ':scope > [data-attribute="cha"]' : ':scope > li[data-attribute="cha"]';
		const spiritAttribute = list.querySelector(spiritSelector);
		const voidAttribute = list.querySelector(voidSelector);
		if (npcAttributes) {
			if (spiritAttribute && voidAttribute) voidAttribute.before(spiritAttribute);
			for (const [index, slug] of order.entries()) {
				const item = list.querySelector(`:scope > [data-attribute="${slug}"]`);
				if (!item) continue;
				list.append(item);
				item.style.gridColumn = String(index % 3 + 1);
				item.style.gridRow = String(Math.floor(index / 3) + 1);
			}
			continue;
		}
		if (spiritAttribute && voidAttribute) spiritAttribute.before(voidAttribute);
		const items = [...list.querySelectorAll(":scope > li[data-attribute]")];
		for (const item of items) {
			const position = order.indexOf(item.dataset.attribute);
			if (position >= 0) {
				item.style.order = String(position);
				item.style.gridColumn = String(position + 1);
			}
		}
	}
}

async function migrateLegacyVursActorFlags() {
	const migrations = [
		{ legacy: "mainAttribute", current: "flags.vurs.mainAttribute" },
		{ legacy: "MainAttribute", current: "flags.vurs.mainAttribute" },
		{ legacy: "hp.maxReduction", current: "flags.vurs.hp.maxReduction" },
		{ legacy: "hpReduction", current: "flags.vurs.hp.maxReduction" },
		{ legacy: "vursSystem", current: "flags.vurs.vursSystem" },
		{ legacy: "agnosticSystem", current: "flags.vurs.agnosticSystem" },
		{ legacy: "defaultSystem", current: "flags.vurs.defaultSystem" },
		{ legacy: "diceless", current: "flags.vurs.diceless" }
	];
	for (const actor of game.actors?.contents ?? []) {
		const updates = {};
		const pendingUpdates = new Set();
		const legacyFlags = foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}`) ??
			foundry.utils.getProperty(actor, `flags.${MODULE_ID}`);
		if (!legacyFlags || typeof legacyFlags !== "object") continue;

		for (const { legacy, current } of migrations) {
			const sourceValue = foundry.utils.getProperty(actor, `_source.${current}`);
			const currentValue = sourceValue !== undefined ? sourceValue : foundry.utils.getProperty(actor, current);
			const legacyValue = foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}.${legacy}`) ??
				foundry.utils.getProperty(actor, `flags.${MODULE_ID}.${legacy}`);
			if (currentValue === undefined && legacyValue !== undefined && !pendingUpdates.has(current)) {
				updates[current] = legacyValue;
				pendingUpdates.add(current);
			}
		}

		const legacyTopLevelKeys = new Set(["mainAttribute", "MainAttribute", "hpReduction", "vursSystem", "agnosticSystem", "defaultSystem", "diceless"]);
		const legacyHp = legacyFlags.hp;
		const hpContainsOnlyLegacyValue = !legacyHp || (typeof legacyHp === "object" &&
			Object.keys(legacyHp).every(key => key === "maxReduction"));
		const scopeContainsOnlyLegacyValues = Object.keys(legacyFlags).every(key =>
			legacyTopLevelKeys.has(key) || (key === "hp" && hpContainsOnlyLegacyValue)
		);
		if (scopeContainsOnlyLegacyValues) {
			// No other actor features use this module scope, so remove the stale
			// scope itself after copying its values into flags.vurs.
			updates[`flags.${MODULE_ID}`] = new foundry.data.operators.ForcedDeletion();
		} else {
			// Preserve any unrelated module data and delete only migrated fields.
			for (const key of legacyTopLevelKeys) {
				if (Object.hasOwn(legacyFlags, key)) updates[`flags.${MODULE_ID}.${key}`] = new foundry.data.operators.ForcedDeletion();
			}
			if (legacyHp && Object.hasOwn(legacyHp, "maxReduction")) {
				updates[`flags.${MODULE_ID}.hp.maxReduction`] = new foundry.data.operators.ForcedDeletion();
			}
		}
		try {
			await actor.update(updates, { render: false });
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to migrate legacy actor flags for ${actor.name}`, error);
		}
	}
}

function registerCustomIwrTypes() {
	const immunities = CONFIG.PF2E?.immunityTypes;
	const resistances = CONFIG.PF2E?.resistanceTypes;
	if (!immunities || !resistances) return;
	immunities.special ??= "special";
	resistances.special ??= "special";
	immunities["all-damage"] ??= resistances["all-damage"] ?? "All Damage";
}

function installCustomDamageIwrPatch() {
	registerCustomIwrTypes();
	installSpecialIwrRuleElementPatch();
	installSpecialDamageSelectorPatch();
	installDragonblightDamageDialogSuppression();

	const handlerKey = Symbol.for(`${MODULE_ID}.iwrDamageHandler`);
	const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)];
	if (!(damageHandlers instanceof Set)) {
		console.error(`${MODULE_ID} | Could not install IWR damage handling: shared applyDamage handlers are unavailable`);
		return;
	}

	if (!globalThis[handlerKey]) {
		damageHandlers.add(function (actor, wrapped, args) {
			if (!["character", "npc"].includes(actor?.type)) return wrapped(...args);
			const attributes = actor.attributes;
			for (const entry of [...(attributes?.immunities ?? []), ...(attributes?.resistances ?? [])]) {
				installIwrTestPatch(entry);
			}
			return wrapped(...args);
		});
		globalThis[handlerKey] = true;
	}

	installDragonblightDamageSuppression(damageHandlers);
}

function installDragonblightDamageDialogSuppression() {
	const prototype = foundry.appv1?.api?.Application?.prototype;
	const originalRender = prototype?.render;
	if (typeof originalRender !== "function" || prototype[VURS_DRAGONBLIGHT_DAMAGE_DIALOG_PATCH]) return;

	prototype.render = function (...args) {
		if (this.constructor?.name === "DamageModifierDialog") {
			const context = this.context;
			const actor = context?.self?.actor ??
				context?.origin?.actor ??
				getActiveDamageActorForVurs();
			if (actorHasDragonblight(actor)) {
				const damageTypes = getDragonblightDamageTypes();
				const formulaData = this.formulaData;
				if (formulaData) {
					if (Array.isArray(formulaData.base)) {
						formulaData.base = formulaData.base.filter(component =>
							!isDragonblightDamageComponent(component, damageTypes)
						);
					}
					for (const property of ["dice", "modifiers"]) {
						if (!Array.isArray(formulaData[property])) continue;
						for (const component of formulaData[property]) {
							if (!isDragonblightDamageComponent(component, damageTypes)) continue;
							component.enabled = false;
							component.ignored = true;
						}
					}
					this.baseDamageType = formulaData.base?.[0]?.damageType ?? "untyped";
				}
			}
		}
		return originalRender.apply(this, args);
	};
	Object.defineProperty(prototype, VURS_DRAGONBLIGHT_DAMAGE_DIALOG_PATCH, { value: true });
}

function isDragonblightDamageComponent(component, damageTypes) {
	const type = typeof component?.damageType === "string"
		? component.damageType
		: typeof component?.type === "string"
			? component.type
			: null;
	return (type !== null && (damageTypes.has(type) || isDragonblightTrait(type))) ||
		hasDragonblightDamageTraitInValue(component);
}

function installDragonblightDamageSuppression(damageHandlers) {
	const handlerKey = Symbol.for(`${MODULE_ID}.dragonblightDamageHandler`);
	if (globalThis[handlerKey]) return;

	const damageTypes = getDragonblightDamageTypes();
	if (damageTypes.size === 0) {
		console.error(`${MODULE_ID} | Could not install Dragonblight damage suppression: no supported damage types are configured`);
		return;
	}

	damageHandlers.add((actor, wrapped, args) => {
		const params = args[0];
		const sourceActor = params?.item?.actor ?? params?.item?.parent;
		const isDragonblighted = actorHasDragonblight(actor) ||
			actorHasDragonblight(sourceActor) ||
			hasDragonblightDamageSourceOption(params?.rollOptions);
		if (!isDragonblighted) return wrapped(...args);

		const hasAffectedTrait = hasDragonblightDamageTraitInOptions(params?.rollOptions) ||
			hasDragonblightActionTrait(foundry.utils.getProperty(params?.item, "system.traits.value")) ||
			hasDragonblightDamageTraitInValue(
				getDragonblightDamageSources(params?.item?.system, params?.item)
			);
		if (typeof params?.damage === "number" && params.damage > 0) {
			const optionTypes = getDamageTypesFromOptions(params.rollOptions);
			const itemTypes = getDragonblightDamageTypesFromValue(
				getDragonblightDamageSources(params.item?.system, params.item),
				damageTypes
			);
			const incomingTypes = optionTypes.size > 0 ? optionTypes : itemTypes;
			const allIncomingTypesAffected = incomingTypes.size > 0 &&
				[...incomingTypes].every(type => damageTypes.has(type));
			if (allIncomingTypesAffected || (incomingTypes.size === 0 && hasAffectedTrait)) {
				return wrapped({ ...params, damage: 0 }, ...args.slice(1));
			}
		}

		const damageInstances = getDragonblightDamageInstances(params?.damage);
		if (Array.isArray(damageInstances) && damageInstances.length > 0) {
			const hasTypedDamageComponents = damageInstances.some(instance =>
				typeof instance?.type === "string" ||
				typeof instance?.damageType === "string" ||
				typeof instance?.type?.slug === "string"
			);
			const affectedInstances = damageInstances.filter(instance => {
				if (instance.kinds?.has?.("damage") === false) return false;
				return hasDragonblightDamageInstanceType(instance, damageTypes) ||
					hasDragonblightDamageTraitInOptions(instance.options) ||
					hasDragonblightDamageTraitInValue(instance.formalDescription) ||
					(hasAffectedTrait && !hasTypedDamageComponents);
			});
			if (affectedInstances.length > 0) {
				const remainingInstances = damageInstances.filter(instance =>
					!affectedInstances.includes(instance)
				);
				if (remainingInstances.length === 0) {
					return wrapped({ ...params, damage: 0 }, ...args.slice(1));
				}

				const damageRoll = params.damage;
				const pool = damageRoll.pool;
				if (typeof pool?.constructor?.fromRolls !== "function" ||
					typeof damageRoll.constructor?.fromTerms !== "function") {
					console.error(`${MODULE_ID} | Could not filter Dragonblight damage components: damage roll reconstruction is unavailable`);
					return wrapped(...args);
				}
				const filteredRoll = damageRoll.constructor.fromTerms(
					[pool.constructor.fromRolls(remainingInstances)],
					foundry.utils.deepClone(damageRoll.options)
				);
				return wrapped({ ...params, damage: filteredRoll }, ...args.slice(1));
			}
		}

		const immunities = actor.attributes?.immunities;
		if (!Array.isArray(immunities)) {
			console.error(`${MODULE_ID} | Could not suppress Dragonblight damage for ${actor.name}: actor immunities are unavailable`);
			return wrapped(...args);
		}

		const immunity = {
			type: "dragonblight",
			label: "Dragonblight",
			test: options => {
				const types = getDamageTypesFromOptions(options);
				if (types.size > 0) {
					return [...types].some(type => damageTypes.has(type));
				}
				return hasAffectedTrait || hasDragonblightDamageOption(options, damageTypes);
			}
		};
		immunities.push(immunity);
		try {
			return wrapped(...args);
		} finally {
			const index = immunities.indexOf(immunity);
			if (index >= 0) immunities.splice(index, 1);
		}
	});

	globalThis[handlerKey] = true;
}

function getDragonblightDamageInstances(damage) {
	const poolRolls = damage?.pool?.rolls;
	if (Array.isArray(poolRolls) && poolRolls.length > 0) return poolRolls;
	const instances = damage?.instances;
	if (Array.isArray(instances) && instances.length > 0) return instances;
	return [];
}

function hasDragonblightDamageInstanceType(instance, damageTypes) {
	const type = typeof instance?.type === "string"
		? instance.type
		: typeof instance?.damageType === "string"
			? instance.damageType
			: typeof instance?.type?.slug === "string"
				? instance.type.slug
				: null;
	return type !== null &&
		(damageTypes.has(type) || isDragonblightTrait(type));
}

function getDamageTypesFromOptions(options) {
	const values = options instanceof Set || Array.isArray(options)
		? options
		: typeof options === "string"
			? [options]
			: [];
	const types = new Set();
	for (const option of values) {
		if (typeof option !== "string") continue;
		const normalized = option.startsWith("item:") ? option.slice("item:".length) : option;
		if (!normalized.startsWith("damage:type:")) continue;
		types.add(normalized.slice("damage:type:".length));
	}
	return types;
}

function hasDragonblightDamageOption(options, damageTypes) {
	const types = getDamageTypesFromOptions(options);
	if (types.size > 0) return [...types].some(type => damageTypes.has(type));
	return hasDragonblightDamageTraitInOptions(options);
}

function hasDragonblightDamageSourceOption(options) {
	if (options instanceof Set) return options.has(DRAGONBLIGHT_DAMAGE_SOURCE_OPTION);
	if (Array.isArray(options)) return options.includes(DRAGONBLIGHT_DAMAGE_SOURCE_OPTION);
	return typeof options === "string" && options === DRAGONBLIGHT_DAMAGE_SOURCE_OPTION;
}

function hasDragonblightDamageTraitInOptions(options) {
	const values = options instanceof Set
		? [...options]
		: Array.isArray(options)
		? options
		: typeof options === "string"
			? [options]
			: [];
	const prefixes = ["item:trait:", "origin:action:trait:", "action:trait:", "damage:trait:"];
	return values.some(option =>
		typeof option === "string" &&
		prefixes.some(prefix =>
			option.startsWith(prefix) &&
			isDragonblightTrait(option.slice(prefix.length))
		)
	);
}

function installSpecialDamageSelectorPatch() {
	if (!specialDamageDomainHookInstalled) {
		Hooks.on("preCreateChatMessage", addSpecialDamageDomainToMessage);
		Hooks.on("createChatMessage", addSpecialDamageDomainToCreatedMessage);
		specialDamageDomainHookInstalled = true;
	}

	const registry = game.pf2e?.RuleElements;
	const ruleElementClasses = [
		...Object.values(registry?.builtin ?? {}),
		...Object.values(registry?.custom ?? {})
	];
	for (const RuleElementClass of new Set(ruleElementClasses)) {
		const prototype = RuleElementClass?.prototype;
		if (!prototype || Object.hasOwn(prototype, VURS_SPECIAL_DAMAGE_SELECTOR_METHOD_PATCH)) continue;

		for (const method of ["beforePrepareData", "afterPrepareData"]) {
			if (!Object.hasOwn(prototype, method) || typeof prototype[method] !== "function") continue;
			const original = prototype[method];
			prototype[method] = function (...args) {
				const selectorProperties = ["selector", "selectors"].filter(property => {
					const descriptor = Object.getOwnPropertyDescriptor(this, property);
					return descriptor &&
						Object.hasOwn(descriptor, "value") &&
						descriptor.writable &&
						hasSpecialDamageSelector(descriptor.value);
				});
				if (selectorProperties.length === 0) return original.apply(this, args);
				if (!installSpecialDamageRulePredicate(this)) return original.apply(this, args);

				const originalSelectors = selectorProperties.map(property => [property, this[property]]);
				for (const [property, selectors] of originalSelectors) {
					this[property] = replaceSpecialDamageSelector(selectors);
				}
				try {
					return original.apply(this, args);
				} finally {
					for (const [property, selectors] of originalSelectors) {
						this[property] = selectors;
					}
				}
			};
		}
		Object.defineProperty(prototype, VURS_SPECIAL_DAMAGE_SELECTOR_METHOD_PATCH, { value: true });
	}
}

function addSpecialDamageDomainToMessage(message, data) {
	const context = foundry.utils.getProperty(data, `flags.${game.system.id}.context`) ??
		foundry.utils.getProperty(message, `flags.${game.system.id}.context`);
	markDragonblightDamageSource(context, data, message);
	addSpecialDamageDomain(context, [message?.rolls, data?.rolls]);
}

function markDragonblightDamageSource(context, data, message) {
	if (context?.type !== "damage-roll") return;
	const originActorUuid = foundry.utils.getProperty(
		data,
		`flags.${game.system.id}.origin.actor`
	) ?? foundry.utils.getProperty(message, `flags.${game.system.id}.origin.actor`);
	const speaker = data?.speaker ?? message?.speaker;
	const sourceActor = (originActorUuid ? fromUuidSync(originActorUuid) : null) ??
		(speaker?.actor ? game.actors?.get(speaker.actor) : null) ??
		(speaker?.token ? canvas.tokens?.get(speaker.token)?.actor : null) ??
		message?.item?.actor ??
		getActiveDamageActorForVurs();
	if (!actorHasDragonblight(sourceActor)) return;

	const messageContext = foundry.utils.getProperty(
		message,
		`flags.${game.system.id}.context`
	);
	const contexts = [...new Set([context, messageContext].filter(Boolean))];
	for (const damageContext of contexts) {
		const options = damageContext.options;
		if (options instanceof Set) {
			options.add(DRAGONBLIGHT_DAMAGE_SOURCE_OPTION);
		} else if (Array.isArray(options)) {
			if (!options.includes(DRAGONBLIGHT_DAMAGE_SOURCE_OPTION)) {
				options.push(DRAGONBLIGHT_DAMAGE_SOURCE_OPTION);
			}
		} else {
			console.error(`${MODULE_ID} | Could not mark Dragonblight damage source: damage roll context options are unavailable`);
		}
	}
	const sourceOptions = messageContext?.options ?? context.options;
	if (message?.updateSource && Array.isArray(sourceOptions)) {
		message.updateSource({
			flags: {
				[game.system.id]: {
					context: { options: sourceOptions }
				}
			}
		});
	}

	const rolls = data?.rolls ?? message?.rolls;
	if (Array.isArray(rolls)) {
		const filteredRolls = rolls.map(roll =>
			filterDragonblightDamageRoll(roll, getDragonblightDamageTypes())
		);
		if (data && Array.isArray(data.rolls)) data.rolls = filteredRolls;
		else if (message && Array.isArray(message.rolls)) message.rolls = filteredRolls;
		if (message?.updateSource && Array.isArray(data?.rolls)) {
			message.updateSource({ rolls: filteredRolls });
		}
	} else {
		console.error(`${MODULE_ID} | Could not filter Dragonblight damage roll: chat message has no rolls array`);
	}
}

function filterDragonblightDamageRoll(roll, damageTypes) {
	const isSerialized = typeof roll === "string";
	let damageRoll = roll;
	if (isSerialized) {
		try {
			const RollClass = globalThis.Roll ?? foundry.dice?.Roll;
			if (typeof RollClass?.fromData !== "function") {
				console.error(`${MODULE_ID} | Could not filter Dragonblight damage roll: Roll.fromData is unavailable`);
				return roll;
			}
			damageRoll = RollClass.fromData(JSON.parse(roll));
		} catch (error) {
			console.error(`${MODULE_ID} | Could not deserialize Dragonblight damage roll`, error);
			return roll;
		}
	}

	const instances = getDragonblightDamageInstances(damageRoll);
	if (instances.length === 0) return roll;
	const affectedInstances = instances.filter(instance =>
		instance.kinds?.has?.("damage") !== false &&
		(hasDragonblightDamageInstanceType(instance, damageTypes) ||
			hasDragonblightDamageTraitInOptions(instance.options) ||
			hasDragonblightDamageTraitInValue(instance.formalDescription))
	);
	if (affectedInstances.length === 0) return roll;

	const remainingInstances = instances.filter(instance =>
		!affectedInstances.includes(instance)
	);
	if (remainingInstances.length === 0) return roll;

	const pool = damageRoll.pool;
	if (typeof pool?.constructor?.fromRolls !== "function" ||
		typeof damageRoll.constructor?.fromTerms !== "function") {
		console.error(`${MODULE_ID} | Could not filter Dragonblight damage roll: damage roll reconstruction is unavailable`);
		return roll;
	}
	const filteredRoll = damageRoll.constructor.fromTerms(
		[pool.constructor.fromRolls(remainingInstances)],
		foundry.utils.deepClone(damageRoll.options)
	);
	return isSerialized ? JSON.stringify(filteredRoll.toJSON()) : filteredRoll;
}

async function addSpecialDamageDomainToCreatedMessage(message) {
	const context = foundry.utils.getProperty(message, `flags.${game.system.id}.context`);
	if (!addSpecialDamageDomain(context, message?.rolls)) return;
	if (!message.canUserModify?.(game.user, "update")) return;

	try {
		await message.update({
			[`flags.${game.system.id}.context.domains`]: context.domains
		});
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to add special-damage domain to created chat message`, error);
	}
}

function addSpecialDamageDomain(context, rolls = []) {
	if (
		context?.type !== "damage-roll" ||
		(!hasSpecialDamageDamageRoll(rolls) && !hasSpecialDamageOption(context.options))
	) return false;
	if (!Array.isArray(context.domains)) {
		console.error(`${MODULE_ID} | Could not add special-damage domain: damage roll context has no domains array`);
		return false;
	}
	if (context.domains.includes("special-damage")) return false;
	context.domains.push("special-damage");
	return true;
}

function hasSpecialDamageDamageRoll(rolls) {
	const excludedTypes = new Set(["physical", "bludgeoning", "piercing", "slashing"]);
	const candidates = (Array.isArray(rolls) ? rolls : [rolls]).flat(Infinity);
	return candidates.some(roll =>
		Array.isArray(roll?.instances) &&
		roll.instances.some(instance =>
			typeof instance.type === "string" && !excludedTypes.has(instance.type)
		)
	);
}

function hasSpecialDamageSelector(selectors) {
	return selectors === "special-damage" ||
		(Array.isArray(selectors) && selectors.includes("special-damage"));
}

function replaceSpecialDamageSelector(selectors) {
	if (selectors === "special-damage") return "damage";
	if (Array.isArray(selectors)) {
		return selectors.map(selector => selector === "special-damage" ? "damage" : selector);
	}
	return selectors;
}

function installSpecialDamageRulePredicate(rule) {
	const predicate = rule.predicate;
	if (!Array.isArray(predicate)) {
		console.error(`${MODULE_ID} | Could not install special-damage selector: Rule Element predicate is unavailable`);
		return false;
	}
	if (rule[VURS_SPECIAL_DAMAGE_RULE_PREDICATE]) return true;

	try {
		const specialDamagePredicate = createSpecialDamagePredicate();
		if (!specialDamagePredicate) return false;
		predicate.push(specialDamagePredicate);
		Object.defineProperty(rule, VURS_SPECIAL_DAMAGE_RULE_PREDICATE, { value: true });
		return true;
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to add special-damage conditions to Rule Element predicate`, error);
		return false;
	}
}

function createSpecialDamagePredicate() {
	const excludedTypes = new Set(["physical", "bludgeoning", "slashing", "piercing"]);
	const systemConfig = CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
	const damageTypes = Object.keys(systemConfig?.damageTypes ?? {})
		.filter(type => !excludedTypes.has(type));
	const options = damageTypes.flatMap(type => [
		`damage:type:${type}`,
		`item:damage:type:${type}`
	]);
	if (options.length === 0) {
		console.error(`${MODULE_ID} | Could not install special-damage selector: no damage types are configured`);
		return null;
	}
	return { or: options };
}

function installSpecialIwrRuleElementPatch() {
	const ruleElements = game.pf2e?.RuleElements?.builtin;
	for (const key of ["Immunity", "Resistance"]) {
		const prototype = ruleElements?.[key]?.prototype;
		if (!prototype || prototype[VURS_SPECIAL_IWR_RULE_PATCH] || typeof prototype.afterPrepareData !== "function") continue;
		const original = prototype.afterPrepareData;
		prototype.afterPrepareData = function (...args) {
			const types = Array.isArray(this.type) ? this.type : [this.type];
			const isSpecialRule = types.length === 1 && types[0] === "special";
			const attributeKey = key === "Immunity" ? "immunities" : "resistances";
			const entries = this.actor?.system?.attributes?.[attributeKey];
			const existingEntries = new Set(entries ?? []);
			const originalType = this.type;
			const originalDefinition = this.definition;
			if (isSpecialRule) {
				// PF2e prepares the rule through its all-damage path, then we restore
				// the custom type so normal exceptions and display labels stay intact.
				this.type = ["all-damage"];
				this.definition = undefined;
			}

			let result;
			try {
				result = original.apply(this, args);
			} finally {
				this.type = originalType;
				this.definition = originalDefinition;
			}

			if (isSpecialRule) {
				for (const entry of this.actor?.system?.attributes?.[attributeKey] ?? []) {
					if (existingEntries.has(entry) || entry.type !== "all-damage") continue;
					entry.type = "special";
					installIwrTestPatch(entry);
				}
			}
			return result;
		};
		Object.defineProperty(prototype, VURS_SPECIAL_IWR_RULE_PATCH, { value: true });
	}
}

function installIwrTestPatch(entry) {
	if (!entry || entry[VURS_IWR_INSTANCE_TEST_PATCH]) return;
	const originalTest = entry.test;
	if (typeof originalTest !== "function") return;
	const patchedTest = function (options) {
		if (hasPureDamageOption(options) && !iwrExplicitlyNamesPure(this)) return false;
		if (this.type === "special") {
			if (!hasSpecialDamageOption(options)) return false;
			// Let PF2e's native test apply user-defined exceptions such as precision.
			const allDamageEntry = Object.create(this);
			allDamageEntry.type = "all-damage";
			return originalTest.call(allDamageEntry, options);
		}
		return originalTest.call(this, options);
	};

	try {
		Object.defineProperty(entry, "test", { configurable: true, value: patchedTest });
		Object.defineProperty(entry, VURS_IWR_INSTANCE_TEST_PATCH, { value: true });
	} catch {
		const prototype = Object.getPrototypeOf(entry);
		if (!prototype || typeof prototype.test !== "function" || prototype[VURS_IWR_TEST_PATCH]) return;
		const prototypeTest = prototype.test;
		prototype.test = function (options) {
			if (hasPureDamageOption(options) && !iwrExplicitlyNamesPure(this)) return false;
			if (this.type === "special") {
				if (!hasSpecialDamageOption(options)) return false;
				const allDamageEntry = Object.create(this);
				allDamageEntry.type = "all-damage";
				return prototypeTest.call(allDamageEntry, options);
			}
			return prototypeTest.call(this, options);
		};
		Object.defineProperty(prototype, VURS_IWR_TEST_PATCH, { value: true });
	}
}

function hasPureDamageOption(options) {
	if (options instanceof Set) return options.has("damage:type:pure");
	if (Array.isArray(options)) return options.includes("damage:type:pure");
	return options === "damage:type:pure";
}

function hasSpecialDamageOption(options) {
	const values = options instanceof Set ? [...options] : Array.isArray(options) ? options :
		typeof options === "string" ? [options] : [];
	const damageOptions = values
		.filter(option => typeof option === "string")
		.map(option => option.startsWith("item:damage:") ? option.slice("item:".length) : option);
	const damageTypeOptions = damageOptions.filter(option => option.startsWith("damage:type:"));
	const damageCategoryOptions = damageOptions.filter(option => option.startsWith("damage:category:"));
	const excludedTypes = ["physical", "bludgeoning", "slashing", "piercing"];
	return damageTypeOptions.some(option =>
		!excludedTypes.some(type => option === `damage:type:${type}`)
	) || damageCategoryOptions.some(option => option !== "damage:category:physical");
}

function iwrExplicitlyNamesPure(iwr) {
	const types = Array.isArray(iwr.type) ? iwr.type : [iwr.type];
	// "All damage" is a broad defense, not a defense specifically against the
	// Pure damage type, so pure damage must bypass broad defenses such as
	// all-damage and special.
	if (types.includes("pure")) return true;
	if (types.includes("all-damage")) return false;
	if (!types.includes("custom")) return false;
	const containsPureOption = value => {
		if (value === "damage:type:pure") return true;
		if (Array.isArray(value)) return value.some(containsPureOption);
		if (value && typeof value === "object") return Object.values(value).some(containsPureOption);
		return false;
	};
	return containsPureOption(iwr.definition);
}