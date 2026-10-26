import { installActorDamageActionContext, installDicelessPatches } from "./features/diceless.js";
import { renderVursPlayResources } from "./features/playResources.js";
import { applyFullVursSkillAttributes, applyVursHitPoints } from "./features/modes/fullVurs.js";
import { applyAgnosticVursSkillAttributes } from "./features/modes/agnosticVurs.js";
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
  getSystemMode,
  isAnyVursMode,
  isFullVursMode
} from "./features/systemModes.js";

const MODULE_ID = "vurs-pf2e";
const VURS_UNDO_ACTIVE = Symbol("vurs-pf2e.undoDamageActive");
const VURS_KEY_STRIKE_PATCH = Symbol("vurs-pf2e.keyStrikePatch");
const VURS_KEY_ATTACK_MODIFIER = Symbol("vurs-pf2e.keyAttackModifier");
const VURS_KEY_DAMAGE_MODIFIER = Symbol("vurs-pf2e.keyDamageModifier");
const VURS_IWR_TEST_PATCH = Symbol("vurs-pf2e.iwrTestPatch");
const VURS_IWR_INSTANCE_TEST_PATCH = Symbol("vurs-pf2e.iwrInstanceTestPatch");
const VURS_SPECIAL_IWR_RULE_PATCH = Symbol("vurs-pf2e.specialIwrRulePatch");
const registeredIwrDamageTargets = new Set();
const VURS_MAIN_ATTRIBUTE_ENABLED = true;
const VURS_ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];
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
const originalTranslations = new Map();
const registeredActorWrappers = new Set();
let actorCreationHookInstalled = false;
let rollPatchRetryTimer = null;

function localizeDefaultAbility(key) {
  const original = originalTranslations.get(key);
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
  installCustomDamageIwrPatch();
  installSystemPatches();
  installKeyAttributeStrikes(false);
  applySystemMode();
});
Hooks.once("ready", () => {
  registerVursCharacterPreparationWrappers();
  installCustomDamageIwrPatch();
  installKeyAttributeStrikes(false);
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
Hooks.on("vurs-pf2e.systemModeChanged", mode => applySystemMode(mode));
// The active canvas can create synthetic token actors after `ready`. Reprepare
// them when it finishes so their first rendered sheet already has VURS data.
Hooks.on("canvasReady", refreshCanvasActors);
// Register this before the first ApplicationV2 render. The builder may be
// opened before ready-time actor preparation finishes.
Hooks.on("renderApplicationV2", (app, element, context, options) => {
  requestAnimationFrame(() => {
    const root = app?.element ?? element;
    const actor = [app?.actor, app?.document?.actor, app?.document,
      app?.options?.actor, context?.actor, options?.actor]
      .find(candidate => candidate?.isOfType?.("character") || candidate?.isOfType?.("npc")) ??
      game.actors?.contents?.find(candidate => (candidate?.isOfType?.("character") || candidate?.isOfType?.("npc")) && candidate.apps?.[app?.id] === app);
    renderVursPlayResources(root, actor);
    if (VURS_MAIN_ATTRIBUTE_ENABLED) addMainAttributeChoice(app, root, context, options);
    reorderAttributeBuilderColumns(root, actor);
    reorderCharacterSheetAttributes(root, actor);
    applyActorAbilityLabels(root, actor);
    applyMainAttributeStar(root, actor);
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
Hooks.on("renderActorSheet", (app, html) => {
  installActorDamageActionContext(app?.actor);
  applyActorSheetPresentation(app, html);
});
Hooks.on("renderItemSheet", (app, html) => addVursAbilityCostField(app, html));
Hooks.on("preUpdateItem", (item, changes) => {
  const flatValue = changes?.["flags.vurs.playCost"];
  const nestedValue = changes?.flags?.vurs?.playCost;
  const value = flatValue ?? nestedValue;
  if (value === undefined) return;
  const normalizedValue = String(value ?? "")
    .split(";")
    .map(entry => entry.trim())
    .filter(Boolean)
    .join("; ");
  if (normalizedValue) {
    if (flatValue !== undefined) changes["flags.vurs.playCost"] = normalizedValue;
    else changes.flags.vurs.playCost = normalizedValue;
    return;
  }
  delete changes["flags.vurs.playCost"];
  if (changes.flags?.vurs) delete changes.flags.vurs.playCost;
  changes.flags ??= {};
  changes.flags.vurs ??= {};
  changes.flags.vurs["-=playCost"] = null;
});
Hooks.on("renderApplication", (app, html) => applyActorSheetPresentation(app, html));
Hooks.on("updateActor", (actor, changes, options = {}) => {
  // Clicking a Play-resource control updates only its own row. The update is
  // persisted normally, but must not trigger the broad VURS UI refresh.
  if (options.vursPlayResourceOnly) return;
  for (const app of Object.values(actor.apps ?? {})) {
    const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
    if (root) requestAnimationFrame(() => {
      renderVursPlayResources(root, actor);
      addVursMaxHpReductionControl(root, actor);
    });
  }
});
Hooks.on("renderChatMessage", (message, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actor = message?.speaker?.actor ? game.actors?.get(message.speaker.actor)
    : message?.actor ?? null;
  if (root && actor) replaceVursPlayResourceTokens(root, actor);
  const originUuid = message?.flags?.pf2e?.origin?.uuid ?? message?.flags?.pf2e?.origin?.itemUuid;
  const originItem = message?.item ?? (originUuid ? fromUuidSync(originUuid) : null);
  const playCost = originItem && String(foundry.utils.getProperty(originItem, "flags.vurs.playCost") ?? "").trim();
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
if (VURS_MAIN_ATTRIBUTE_ENABLED) {
  Hooks.once("ready", installMainAttributeObserver);
}

function applyActorSheetPresentation(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const actor = [app?.actor, app?.document?.actor, app?.document, app?.object]
    .find(candidate => candidate?.isOfType?.("character") || candidate?.isOfType?.("npc"));
  if (!root || !actor) return;
  renderVursPlayResources(root, actor);
  replaceVursPlayResourceTokens(root, actor);
  replaceVursPlayCostTokensOnActorSheet(root, actor);
  if (!root.dataset.vursPlayResourceTokenObserver) {
    root.dataset.vursPlayResourceTokenObserver = "true";
    const observer = new MutationObserver(() => {
      replaceVursPlayResourceTokens(root, actor);
      replaceVursPlayCostTokensOnActorSheet(root, actor);
    });
    observer.observe(root, { childList: true, subtree: true });
  }
  // The remaining presentation changes are character-sheet specific.
  if (!actor.isOfType?.("character")) return;
  requestAnimationFrame(() => addVursMaxHpReductionControl(root, actor));
  allowNegativeHpEntry(root, actor);
  reorderCharacterSheetAttributes(root, actor);
  applyActorAbilityLabels(root, actor);
  applyMainAttributeStar(root, actor);
  colorVursAttributeModifierFrames(root, actor);
  addVursExtendedSaveRows(root, actor);
  hideVursPerceptionSidebarSection(root, actor);
  relabelVursDexteritySkill(root, actor);
  relabelVursCoreSkills(root, actor);
  linkVursStatisticSkillControls(root, actor);
  nestVursConsolidatedSkills(root, actor);
  groupVursSkillsByAttribute(root, actor, localizeDefaultAbility);
}

function replaceVursPlayCostTokensOnActorSheet(root, actor) {
  for (const itemElement of root.querySelectorAll(".item[data-item-id], [data-item-id]")) {
    const item = actor?.items?.get(itemElement.dataset.itemId);
    const playCost = item && String(foundry.utils.getProperty(item, "flags.vurs.playCost") ?? "").trim();
    if (!playCost) continue;
    replaceVursPlayCostToken(itemElement, playCost);
  }
}


function addVursAbilityCostField(app, element) {
  const item = app?.item ?? app?.object;
  if (!item || !["action", "feat"].includes(item.type)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const playCost = resolveVursPlayCostRolls(String(foundry.utils.getProperty(item, "flags.vurs.playCost") ?? ""), item.actor ?? item.parent?.actor)
    .split("; ")
    .map(entry => entry.trim())
    .filter(Boolean)
    .join("; ");
  const description = root?.querySelector(".tab.description .editor-content, .tab.description");
  if (description && !description.contains(document.activeElement)) {
    if (playCost) replaceVursPlayCostToken(description, playCost);
    replaceVursPlayResourceTokens(description, item.actor ?? item.parent?.actor);
  }
  if (playCost) {
    const details = root?.querySelector(".sheet-header .details");
    const existingGlyph = root?.querySelector(".sheet-header .action-glyph, .sheet-header .action-cost");
    if (details && !details.querySelector(".vurs-play-cost-glyph") && !root?.querySelector(".sheet-header .vurs-play-cost-glyph")) {
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
      if (existingGlyph) existingGlyph.replaceWith(glyph);
      else details.insertBefore(glyph, details.querySelector(".level") ?? null);
    }
  }
  const basics = root?.querySelector(".tab.details fieldset.basics, .tab.details, .tab[data-tab='details']");
  if (!basics || basics.querySelector("[data-vurs-cost-field]")) return;

  const group = document.createElement("div");
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
  input.value = foundry.utils.getProperty(item, "flags.vurs.playCost") ?? "";
  input.placeholder = "1 AP; 1 AP and SP; 1 AP, TP or Reaction";
  fields.append(input);
  group.append(label, fields);
  const actionGroup = [...basics.querySelectorAll(".form-group")].find(group =>
    /actions/i.test(group.querySelector("label")?.textContent ?? "") ||
    group.querySelector('select[name$="actionType"], select[name$="actionType.value"], input[name$="actionType"]')
  );
  if (actionGroup) actionGroup.insertAdjacentElement("afterend", group);
  else basics.append(group);
}

function replaceVursPlayCostToken(description, playCost) {
  const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!node.nodeValue.includes("VURS.PlayCost")) continue;
    const parts = node.nodeValue.split("VURS.PlayCost");
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (part) fragment.append(document.createTextNode(part));
      if (index >= parts.length - 1) return;
      const inline = document.createElement("span");
      inline.className = "vurs-play-cost-description vurs-play-cost-inline";
      const label = document.createElement("strong");
      label.textContent = "Play Cost";
      inline.append(label);
      playCost.split(";").map(entry => entry.trim()).filter(Boolean).forEach((entry, entryIndex) => {
        if (entryIndex) inline.append(document.createTextNode("; "));
        const icons = document.createElement("span");
        icons.className = "vurs-play-cost-description-icons";
        icons.title = entry;
        appendVursPlayCostIcons(icons, entry);
        inline.append(icons);
      });
      fragment.append(inline);
    });
    node.replaceWith(fragment);
  }
}

function replaceVursPlayResourceTokens(description, actor) {
  const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const aliases = { One: 1, Two: 2, Three: 3, Longer: 4 };
  const resources = {
    AP: "AP", SP: "SP", TP: "TP", BP: "BP", MP: "MP", KP: "KP", SR: "SR",
    actionPoints: "AP", staminaPoints: "SP", tacticPoints: "TP", budgetPoints: "BP",
    magicPoints: "MP", karmaPoints: "KP", styleRank: "SR", reactions: "REACTION", free: "FREE"
  };
  for (const node of nodes) {
    const resolvedText = node.nodeValue.replace(/VURS\.PlayResource\.\[\[(.+?)\]\](AP|SP|TP|BP|MP|KP|SR)/gi,
      (match, formula, resource) => `VURS.PlayResource.${resolveVursPlayCostRolls(`[[${formula}]]`, actor)}${resource}`);
    if (resolvedText !== node.nodeValue) node.nodeValue = resolvedText;
    const matches = [...node.nodeValue.matchAll(/VURS\.PlayResource\.((?:(\d+)|(One|Two|Three|Longer))?(AP|SP|TP|BP|MP|KP|SR|actionPoints|staminaPoints|tacticPoints|budgetPoints|magicPoints|karmaPoints|styleRank|reactions|reaction|free))/gi)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(node.nodeValue.slice(offset, match.index)));
      const amount = match[2] ? Number(match[2]) : (aliases[match[3]] ?? 1);
      const resourceKey = Object.keys(resources).find(key => key.toLowerCase() === match[4].toLowerCase());
      const resource = resources[resourceKey];
      const rendered = document.createElement("span");
      rendered.className = "vurs-play-resource-token";
      if (amount === 0 && resource === "AP") {
        rendered.title = "Free Action";
        const icon = document.createElement("img");
        icon.src = "modules/vurs-pf2e/assets/custom-icons/resource-icons/FreeAction.svg";
        icon.alt = "Free Action";
        icon.draggable = false;
        rendered.append(icon);
        fragment.append(rendered);
        offset = match.index + match[0].length;
        continue;
      }
      rendered.title = `${amount === 4 ? "4+" : amount} ${resource}`;
      appendVursPlayCostIcons(rendered, `${amount} ${resource}`);
      fragment.append(rendered);
      offset = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(node.nodeValue.slice(offset)));
    node.replaceWith(fragment);
  }
}

function resolveVursPlayCostRolls(playCost, actor) {
  const RollClass = globalThis.Roll ?? foundry?.dice?.Roll;
  if (!playCost.includes("[[") || !RollClass) return playCost;
  const rollData = actor?.getRollData?.() ?? {};
  if (actor && !rollData.actor) rollData.actor = actor.getRollData?.() ?? actor;
  return playCost.replace(/\[\[\s*([^\]]+)\s*\]\]/g, (match, formula) => {
    try {
      const roll = RollClass.create(formula, rollData);
      roll.evaluate({ async: false });
      return String(Number.isFinite(roll.total) ? roll.total : 0);
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to evaluate Play Cost inline roll`, formula, error);
      return match;
    }
  });
}

function appendVursPlayCostIcons(container, playCost) {
  if (!container.title) container.title = playCost;
  const entries = playCost.split(/\s*(;|,|\band\b|\bor\b|\bcombined\b)\s*/i).filter(Boolean);
  let lastAmount = 1;
  let lastOperator = null;
  for (const entry of entries) {
    const operator = /^(;|,|\+|and|or|combined)$/i.test(entry) ? entry.toLowerCase() : null;
    if (operator) {
      lastOperator = operator;
      const separator = document.createElement("span");
      separator.className = "vurs-play-cost-inline-separator";
      separator.textContent = operator === "or" || operator === "," ? "/" : operator === "and" ? " + " : operator === "combined" ? " combined " : "; ";
      container.append(separator);
      continue;
    }
    const match = entry.match(/^(\d+)?\s*(AP|SP|TP|BP|MP|RP|REACTIONS?|FREE)$/i);
    if (!match) {
      container.append(document.createTextNode(entry));
      continue;
    }
    const amount = Math.max(1, Number(match[1] ?? (lastOperator === "or" ? lastAmount : 1)));
    const resource = /^(RP|REACTIONS?)$/i.test(match[2]) ? "REACTION" : /^(FREE)$/i.test(match[2]) ? "FREE" : match[2].toUpperCase();
    if (resource === "BP") {
      const stacks = document.createElement("span");
      stacks.className = `vurs-play-cost-resource-stacks vurs-play-cost-${resource.toLowerCase()}-stacks`;
      const iconTypes = resource === "MP"
        ? [...Array(Math.floor(amount / 5)).fill("mp-diamond-star-5"), ...Array(amount % 5).fill("mp-diamond-arm")]
        : Array(amount).fill("coin");
      const iconCount = iconTypes.length;
      const stackSize = resource === "BP" ? 5 : 2;
      for (let offset = 0; offset < iconCount; offset += stackSize) {
        const stack = document.createElement("span");
        stack.className = "vurs-play-cost-resource-stack";
        for (let index = 0; index < Math.min(stackSize, iconCount - offset); index += 1) {
          const iconType = iconTypes[offset + index];
          const icon = iconType.startsWith("mp-diamond-") ? document.createElement("img") : document.createElement("i");
          if (icon instanceof HTMLImageElement) {
            icon.src = `modules/vurs-pf2e/assets/custom-icons/resource-icons/${iconType === "mp-diamond-star-5" ? "MP-Diamond-Star-5" : "MP-Diamond-Arm"}.svg`;
            icon.alt = `${amount} MP`;
          } else icon.className = `fa-solid fa-${iconType}`;
          icon.style.setProperty("--stack-index", String(index));
          icon.setAttribute("aria-hidden", "true");
          stack.append(icon);
        }
        stacks.append(stack);
      }
      container.append(stacks);
      lastAmount = amount;
      continue;
    }
    if (resource === "MP") {
      container.classList.add("vurs-play-cost-mp-stars");
      for (let index = 0; index < amount; index += 1) {
        const icon = document.createElement("i");
        icon.className = "fa-solid fa-star vurs-play-cost-mp-star";
        icon.setAttribute("aria-hidden", "true");
        container.append(icon);
      }
      lastAmount = amount;
      continue;
    }
    if (resource === "REACTION") {
      for (let index = 0; index < amount; index += 1) {
        const icon = document.createElement("img");
        icon.src = "modules/vurs-pf2e/assets/custom-icons/resource-icons/Reaction.svg";
        icon.alt = "Reaction";
        icon.draggable = false;
        container.append(icon);
      }
      lastAmount = amount;
      continue;
    }
    if (resource === "FREE") {
      const icon = document.createElement("img");
      icon.src = "modules/vurs-pf2e/assets/custom-icons/resource-icons/FreeAction.svg";
      icon.alt = "Free Action";
      icon.draggable = false;
      container.append(icon);
      lastAmount = amount;
      continue;
    }
    const iconName = amount === 1 ? `One${resource}`
      : amount === 2 ? `Two${resource}`
        : amount === 3 ? `Three${resource}` : `Longer${resource}`;
    const icon = document.createElement("img");
    icon.src = `modules/vurs-pf2e/assets/custom-icons/resource-icons/${iconName}.svg`;
    icon.alt = entry;
    icon.draggable = false;
    container.append(icon);
    lastAmount = amount;
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
  if (!root.dataset.vursNegativeHpDelegation) {
    root.dataset.vursNegativeHpDelegation = "true";
    // Catch these events during capture at the sheet boundary, before PF2e's
    // delegated form listeners can persist a negative HP value themselves.
    root.addEventListener("input", event => {
      const field = event.target;
      if (!isCurrentHpInput(field) || (Number(field.value) >= 0 && !field.value.trim().startsWith("-"))) return;
      event.stopImmediatePropagation();
    }, true);
    root.addEventListener("wheel", event => {
      const target = event.target instanceof Element ? event.target : null;
      const field = target?.closest?.('input[name$="attributes.hp.value"], input[data-property$="attributes.hp.value"], input[name$="hp.value"]');
      if (!field || document.activeElement !== field || event.deltaY === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const maximum = Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0);
      const current = Number(field.value) || 0;
      field.value = String(Math.clamp(current + (event.deltaY < 0 ? 1 : -1), -maximum, maximum));
      field.dataset.vursWheelDirty = "true";
    }, { capture: true, passive: false });
    root.addEventListener("change", event => {
      const field = event.target;
      if (!isCurrentHpInput(field)) return;
      field.dataset.vursWheelDirty = "";
      const entered = Number(field.value);
      if (!Number.isFinite(entered) || entered >= 0) {
        if (field.value.trim().startsWith("-")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          field.value = String(actor.system?.attributes?.hp?.value ?? 0);
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const currentMax = Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0);
      const overflow = Math.min(currentMax, Math.ceil(-entered));
      field.value = "0";
      applyVursNegativeHp(actor, overflow).catch(error => {
        console.error(`${MODULE_ID} | Failed to apply negative HP`, error);
        ui.notifications?.error("Could not apply negative HP.");
        field.value = String(actor.system?.attributes?.hp?.value ?? 0);
      });
    }, true);
  }
  if (input) {
    input.min = String(-maximumNegative);
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
  valueElement.setAttribute("aria-valuemin", String(-maximumNegative));
  valueElement.setAttribute("aria-valuemax", String(hp?.max ?? 0));
  valueElement.title = "Edit current HP; negative values reduce maximum HP";
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
  valueElement.addEventListener("wheel", event => {
    if (document.activeElement !== valueElement || event.deltaY === 0) return;
    event.preventDefault();
    const current = Number(valueElement.textContent.trim()) || 0;
    valueElement.textContent = String(Math.clamp(current + (event.deltaY < 0 ? 1 : -1), -maximumNegative, Number(hp?.max ?? 0)));
  }, { passive: false });
  valueElement.addEventListener("blur", async () => {
    if (cancelEdit) {
      cancelEdit = false;
      valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0);
      return;
    }
    const entered = Number(valueElement.textContent.trim());
    const value = Math.clamp(Number.isFinite(entered) ? Math.trunc(entered) : Number(hp?.value ?? 0), -maximumNegative, Number(hp?.max ?? 0));
    valueElement.textContent = String(value);
    try {
      if (value < 0) await applyVursNegativeHp(actor, -value);
      else await actor.update({ "system.attributes.hp.value": value });
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to update current HP`, error);
      ui.notifications?.error("Could not update current HP.");
      valueElement.textContent = String(actor.system?.attributes?.hp?.value ?? 0);
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
  if (!actorUsesVursSystem(actor) || root.querySelector(".vurs-max-hp-edit")) return;
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
    indicator.style.color = adjustment > 0 ? "#ff3b3b" : "inherit";
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
      const text = mode === "default" ? originalTranslations.get(path) : vursText;
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
    ...Object.values(ui.windows ?? {}).map(app => app.actor)
  ].filter(Boolean));
  for (const actor of actors) {
    installActorKeyAttributeSupport(actor, false);
    // PF2e's reset clears cached prepared state before rebuilding it. Calling
    // prepareData directly can leave startup-derived sheet data stale until
    // the next document update (such as changing HP).
    actor.reset?.();
    actor.sheet?.render?.(false);
  }
  for (const app of Object.values(ui.windows ?? {})) app.render?.(false);
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
    installActorKeyAttributeSupport(actor, false);
    actor.reset?.();
    actor.sheet?.render?.(false);
  }
  // Derived VURS HP is applied during actor preparation. That preparation
  // does not emit an actor update, so token bars can retain their pre-VURS
  // maximum until each active token is explicitly refreshed.
  for (const token of tokens) token.refresh?.();
}

function installKeyAttributeStrikes(reprepare = true) {
  const actors = [...(game.actors?.contents ?? [])];
  for (const actor of actors) installActorKeyAttributeSupport(actor, reprepare);
  if (!actorCreationHookInstalled) {
    Hooks.on("createActor", actor => installActorKeyAttributeSupport(actor));
    actorCreationHookInstalled = true;
  }
}

function installSystemPatches() {
  installDicelessPatches();
}

function addMainAttributeChoice(app, element, context = {}, renderOptions = {}) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED) return;
  const candidate = element instanceof HTMLElement ? element : element?.[0] ?? app.element;
  const root = candidate instanceof HTMLElement ? candidate : candidate?.[0];
  if (!root) return;
  const rows = root.querySelector(".attribute-rows");
  if (!rows) return;
  const findActor = () => {
    const builder = app ?? foundry.applications?.instances?.get?.("attribute-builder");
    return renderOptions.actor ?? context.actor ?? builder?.options?.actor ?? builder?.actor ?? builder?.document ??
      game.actors?.contents?.find(candidate => candidate.apps?.["attribute-builder"] === builder);
  };
  const actor = findActor();
  if (!actorUsesMainAttribute(actor)) {
    rows.querySelector("[data-section='vurs-main']")?.remove();
    return;
  }

  let section = rows.querySelector("[data-section='vurs-main']");
  if (!section) {
    const classSection = [...rows.querySelectorAll(":scope > section[role='group']")]
      .find(candidate => !candidate.hasAttribute("data-section"));
    if (!classSection) return;

    section = document.createElement("section");
    section.className = "row svelte-8m1dup vurs-main-attribute-choice";
    section.dataset.section = "vurs-main";
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", "Main attribute boost");

    const heading = document.createElement("div");
    heading.className = "row-heading svelte-8m1dup";
    heading.innerHTML = '<div class="label svelte-8m1dup"><div class="title svelte-8m1dup">Main</div><div class="description svelte-8m1dup"></div></div>';
    section.append(heading);

    const choices = document.createElement("div");
    choices.className = "attributes svelte-8m1dup";
    const exampleButton = rows.querySelector("button.attribute-button.boost");
    for (const ability of VURS_ABILITY_KEYS) {
      const column = document.createElement("div");
      column.className = "row-column svelte-8m1dup";
      const button = exampleButton?.cloneNode(true) ?? document.createElement("button");
      button.classList.add("attribute-button", "boost");
      button.type = "button";
      button.textContent = "BOOST";
      button.dataset.vursMainAttribute = ability;
      button.addEventListener("click", async () => {
        const targetActor = findActor();
        if (!targetActor?.isOfType?.("character")) {
          ui.notifications?.warn("Could not find the character for this Attribute Boost builder.");
          return;
        }
        const nextMainAttribute = getMainAttribute(targetActor) === ability ? null : ability;
        await targetActor.update({ "flags.vurs.mainAttribute": nextMainAttribute });
        targetActor.sheet?.render(false);
        app?.render?.({ force: true });
      });
      column.append(button);
      choices.append(column);
    }
    section.append(choices);
    classSection.after(section);
  }

  // The row is a builder feature, so keep it visible even if PF2e doesn't
  // expose its private actor reference in the render hook options.
  const selected = actor?.isOfType?.("character") ? getMainAttribute(actor) : null;
  const description = section.querySelector(".row-heading .description");
  if (description) description.textContent = selected ? VURS_ABILITY_LABELS[selected] : "Choose one";
  for (const button of section.querySelectorAll("button[data-vurs-main-attribute]")) {
    const ability = button.dataset.vursMainAttribute;
    const isSelected = ability === selected;
    button.textContent = game.i18n.localize("PF2E.Actor.Character.AttributeBuilder.Boost");
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.setAttribute("aria-label", `Main ${VURS_ABILITY_LABELS[ability]} boost`);
    button.disabled = false;
  }
}

function installMainAttributeObserver() {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !document.body || document.body.__vursMainAttributeObserver) return;
  const attach = () => {
    const app = foundry.applications?.instances?.get?.("attribute-builder") ??
      game.actors?.contents?.map(actor => actor.apps?.["attribute-builder"]).find(Boolean);
    for (const rows of document.querySelectorAll(".attribute-rows")) {
      if (rows.querySelector("[data-section='vurs-main']")) continue;
      const root = rows.closest(".application") ?? rows.parentElement;
      if (root) addMainAttributeChoice(app, root, {}, app?.options ?? {});
    }
  };
  const observer = new MutationObserver(() => requestAnimationFrame(attach));
  observer.observe(document.body, { childList: true, subtree: true });
  Object.defineProperty(document.body, "__vursMainAttributeObserver", { value: observer });
  attach();
}

function installActorKeyAttributeSupport(actor, reprepare = true) {
  if (!actor?.isOfType?.("character")) return;
  registerVursCharacterPreparationWrappers();
  if (reprepare) actor.prepareData?.();
}

function registerVursCharacterPreparationWrappers(actorClass = CONFIG.PF2E?.Actor?.documentClasses?.character) {
  if (!actorClass?.prototype) return;
  if (typeof globalThis.libWrapper?.register !== "function") return;
  const wrappers = {
    prepareSynthetics: function (wrapped, ...args) {
      const result = wrapped(...args);
      if (this.isOfType?.("character")) installMainAttributeAttackModifier(this);
      return result;
    },
    prepareData: function (wrapped, ...args) {
      const result = wrapped(...args);
      if (this.isOfType?.("character")) applyKeyAttributeToStrikes(this);
      return result;
    },
    prepareSaves: function (wrapped, ...args) {
      if (actorUsesVursSystem(this) && this.system?.saves) {
        if (this.system.saves.fortitude) this.system.saves.fortitude.attribute = "str";
        if (this.system.saves.will) this.system.saves.will.attribute = "int";
      }
      return wrapped(...args);
    },
    preparePerception: function (wrapped, ...args) {
      if (actorUsesVursSystem(this)) addSavingThrowRuleSupport(this, ["perception"]);
      const perceptionRank = this.system?.perception?.rank;
      const result = wrapped(...args);
      if (actorUsesVursSystem(this) && this.perception) {
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
        data.rollOptions = [...new Set([...(data.rollOptions ?? []), "saving-throw", "saving-throw:perception"] )];
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
        if (usesVurs) applyFullVursSkillAttributes(this);
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
        actorUsesVursSystem(this) && Number.isFinite(Number(requestedHp));
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
    prepareDerivedData: function (wrapped, ...args) {
      // Apply Main after PF2e has processed its normal build boosts but before
      // PF2e derives dependent statistics from the ability modifiers.
      applyMainAttributeBoost(this);
      const result = wrapped(...args);
      installActorDamageActionContext(this);
      if (actorUsesVursSystem(this)) {
        applyVursHitPoints(
          this,
          getVursMaxHpReduction(this),
          VURS_ABILITY_LABELS.str,
          true
        );
        if (actorUsesAgnosticVurs(this) || (!isFullVursMode() &&
          (actorHasVursSystemFlag(this) || actorHasAgnosticSystemFlag(this)))) applyActorAbilityDataLabels(this);
      } else if (isAnyVursMode()) {
        applyDefaultActorAbilityDataLabels(this);
      }
      applyVursConsolidatedSkillAttributes(this);
      applyVursStatisticSkillMirrors(this);
      return result;
    },
    _preUpdate: function (wrapped, changed, options, user, ...args) {
      if (actorUsesVursSystem(this)) {
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
        let overflowApplied = false;
        if (Number.isFinite(changedHp?.value) && changedHp.value < 0) {
          const overflow = Math.ceil(-changedHp.value);
          const currentAdjustment = currentReduction;
          const baseMax = getVursBaseMaxHp(this);
          changedHp.value = 0;
          foundry.utils.setProperty(changed, reductionPath, Math.min(baseMax, currentAdjustment + overflow));
          overflowApplied = true;
        }

      }
      return wrapped(changed, options, user, ...args);
    },
    applyDamage: async function (wrapped, params, ...args) {
      const reductionPath = "flags.vurs.hp.maxReduction";
      const persistedReduction = foundry.utils.getProperty(this, reductionPath) ??
        foundry.utils.getProperty(this, `_source.${reductionPath}`);
      // PF2e creates its damage-revert record from numeric values that existed
      // before damage. Seed zero so the first VURS overflow update is included
      // in that native undo record as well.
      if (actorUsesVursSystem(this) && !Number.isFinite(Number(persistedReduction))) {
        await this.update({ [reductionPath]: 0 }, { render: false });
      }
      return wrapped(params, ...args);
    },
    calculateHealthDelta: function (wrapped, healthData, ...args) {
      const result = wrapped(healthData, ...args);
      if (!actorUsesVursSystem(this) || !healthData || healthData.delta <= 0 || healthData.hp?.max <= 0) return result;

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
      result.updates["flags.vurs.hp.maxReduction"] = adjusted;
      return result;
    }
  };
  const baseDamageMethods = new Set(["applyDamage", "calculateHealthDelta"]);
  for (const [method, wrapper] of Object.entries(wrappers)) {
    if (!baseDamageMethods.has(method)) registerActorPreparationWrapper(actorClass, method, wrapper);
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

function installVursUndoDamagePatch(actorClass) {
  const prototype = actorClass?.prototype;
  if (!prototype || typeof prototype.undoDamage !== "function" ||
    Object.hasOwn(prototype, "__vursNegativeHpUndoPatch")) return;

  const originalUndoDamage = prototype.undoDamage;
  prototype.undoDamage = async function (appliedDamage, ...args) {
    if (this[VURS_UNDO_ACTIVE]) return originalUndoDamage.call(this, appliedDamage, ...args);

    const snapshot = appliedDamage?.vursNegativeHp;
    const recordedUpdates = appliedDamage?.updates ?? [];
    const hpPath = "system.attributes.hp.value";
    const reductionPath = "flags.vurs.hp.maxReduction";
    const hpUndo = recordedUpdates.find(update => update.path === hpPath);
    const reductionUndo = recordedUpdates.find(update => update.path === reductionPath);
    if (!snapshot && !reductionUndo) return originalUndoDamage.call(this, appliedDamage, ...args);

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
      result = await originalUndoDamage.call(this, { ...appliedDamage, updates: otherUpdates }, ...args);
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
  };
  Object.defineProperty(prototype, "__vursNegativeHpUndoPatch", { value: true });
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
  const current = actor.skills?.[slug];
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
  actor.skills[slug] = statistic;
  const systemData = actor.system.skills?.[slug];
  if (systemData) {
    actor.system.skills[slug] = Object.assign({}, systemData, statistic.getTraceData(), {
      mod: statistic.check.mod
    });
  }
}

function getVursMaxHpReduction(actor) {
  // The public flags object can lag behind a document update in some PF2e
  // preparation flows. Prefer persisted source data so partial damage reverts
  // immediately expose the restored reduction value to preparation and sheets.
  const candidates = [
    foundry.utils.getProperty(actor, "_source.flags.vurs.hp.maxReduction"),
    foundry.utils.getProperty(actor, "document._source.flags.vurs.hp.maxReduction"),
    foundry.utils.getProperty(actor, "flags.vurs.hp.maxReduction"),
    // Read earlier module-scoped values during the one-time migration.
    foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}.hp.maxReduction`),
    foundry.utils.getProperty(actor, `flags.${MODULE_ID}.hp.maxReduction`),
    foundry.utils.getProperty(actor, `flags.${MODULE_ID}.hpReduction`)
  ];
  const value = candidates.find(candidate => candidate !== undefined);
  const reduction = Number(value);
  if (!Number.isFinite(reduction)) return 0;
  const normalized = Math.trunc(reduction);
  if (normalized <= 0) return normalized;
  const preparedBaseMax = Number(actor?.system?.attributes?.hp?.totalModifier);
  return Number.isFinite(preparedBaseMax) ? Math.min(normalized, Math.max(0, preparedBaseMax)) : normalized;
}

function getVursReductionUpdates(value) {
  return { "flags.vurs.hp.maxReduction": value };
}

function getVursBaseMaxHp(actor) {
  const hp = actor?.system?.attributes?.hp;
  const preparedMaximum = Number(hp?.totalModifier);
  if (Number.isFinite(preparedMaximum)) return Math.max(0, preparedMaximum);
  const maximum = Number(hp?.max);
  const adjustment = getVursMaxHpReduction(actor);
  return Math.max(0, (Number.isFinite(maximum) ? maximum : 0) + adjustment);
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

function applyMainAttributeStar(element, actor) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const selectedAttribute = VURS_MAIN_ATTRIBUTE_ENABLED && actorUsesMainAttribute(actor)
    ? getMainAttribute(actor)
    : null;
  for (const item of root?.querySelectorAll?.(".subsection.attributes li[data-attribute]") ?? []) {
    const heading = item.querySelector(".abbreviation");
    const label = heading?.querySelector(":scope > span");
    const existing = heading?.querySelector(":scope > .vurs-main-attribute");
    if (item.dataset.attribute !== selectedAttribute) {
      existing?.remove();
      continue;
    }
    if (!heading || !label || existing) continue;
    const star = document.createElement("i");
    star.className = "vurs-main-attribute fa-solid fa-star";
    star.setAttribute("aria-label", "Main Attribute");
    star.setAttribute("role", "img");
    star.dataset.tooltip = "Main Attribute";
    star.dataset.tooltipDirection = "UP";
    star.dataset.tooltipClass = "pf2e";
    heading.style.position = "relative";
    star.style.position = "absolute";
    star.style.left = `${label.offsetLeft + label.offsetWidth + 3}px`;
    star.style.top = `${label.offsetTop + label.offsetHeight / 2}px`;
    star.style.transform = "translateY(-50%)";
    star.style.fontSize = "0.55em";
    star.style.fontWeight = "900";
    star.style.color = "inherit";
    label.after(star);
  }
}

function reorderAttributeBuilderColumns(element, actor) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const hasActorScopedVursBuilder = Boolean(root?.querySelector?.("[data-section='vurs-main']"));
  if (!isAnyVursMode() && !actorHasVursSystemFlag(actor) &&
    !actorHasAgnosticSystemFlag(actor) && !hasActorScopedVursBuilder) return;
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
  const lists = root?.matches?.(".subsection.attributes ul")
    ? [root]
    : [...(root?.querySelectorAll?.(".subsection.attributes ul") ?? [])];
  for (const list of lists) {
    const order = ["str", "dex", "con", "int", "cha", "wis"];
    const spirit = list.querySelector(':scope > li[data-attribute="wis"]');
    const voidAttribute = list.querySelector(':scope > li[data-attribute="cha"]');
    if (spirit && voidAttribute) spirit.before(voidAttribute);
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

function getMainAttribute(actor) {
  const candidates = [
    foundry.utils.getProperty(actor, "_source.flags.vurs.mainAttribute"),
    foundry.utils.getProperty(actor, "document._source.flags.vurs.mainAttribute"),
    foundry.utils.getProperty(actor, "flags.vurs.mainAttribute"),
    foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}.mainAttribute`),
    foundry.utils.getProperty(actor, `flags.${MODULE_ID}.mainAttribute`),
    foundry.utils.getProperty(actor, `flags.${MODULE_ID}.MainAttribute`)
  ];
  const chosen = candidates.find(candidate => candidate !== undefined);
  return VURS_ABILITY_KEYS.includes(chosen) ? chosen : null;
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
      updates[`flags.-=${MODULE_ID}`] = null;
    } else {
      // Preserve any unrelated module data and delete only migrated fields.
      for (const key of legacyTopLevelKeys) {
        if (Object.hasOwn(legacyFlags, key)) updates[`flags.${MODULE_ID}.-=${key}`] = null;
      }
      if (legacyHp && Object.hasOwn(legacyHp, "maxReduction")) {
        updates[`flags.${MODULE_ID}.hp.-=maxReduction`] = null;
      }
    }
    try {
      await actor.update(updates, { render: false });
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to migrate legacy actor flags for ${actor.name}`, error);
    }
  }
}

function applyMainAttributeBoost(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesMainAttribute(actor)) {
    return;
  }
  const attribute = getMainAttribute(actor);
  const ability = actor.system?.abilities?.[attribute];
  if (!attribute || !ability || !Number.isFinite(ability.mod)) {
    return;
  }

  // Main is a dedicated full boost. Keep it independent from PF2e's partial
  // boost accounting so it cannot leave the prepared modifier fractional.
  ability.mod = Math.floor(Math.clamp(ability.mod + 1, -5, 10));
  ability.base = ability.mod;
}

function applyKeyAttributeToStrikes(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesMainAttribute(actor)) return;
  installKeyAttributeDamageModifier(actor);
}

function installMainAttributeAttackModifier(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesMainAttribute(actor)) return;
  const modifiers = actor.synthetics?.modifiers;
  if (!modifiers || Object.values(modifiers).some(entries => entries?.includes?.(actor[VURS_KEY_ATTACK_MODIFIER]))) return;

  const strikeAttackModifiers = (modifiers["strike-attack-roll"] ??= []);
  const ModifierClass = game.pf2e?.Modifier;
  if (typeof ModifierClass !== "function") return;

  const mainAttributeModifier = ({ resolvables } = {}) => {
    if (!actorUsesMainAttribute(actor)) return null;
    const weapon = resolvables?.weapon;
    if (!weapon || weapon.actor?.uuid !== actor.uuid || !weapon.isOfType?.("weapon")) return null;

    // A Strike Rule Element can set the weapon's attribute directly. Honor it;
    // otherwise use Main only when the actor has selected one.
    const selectedAttribute = VURS_ABILITY_KEYS.includes(weapon.system?.attribute)
      ? weapon.system.attribute
      : getMainAttribute(actor);
    const modifier = actor.system.abilities?.[selectedAttribute]?.mod;
    if (!VURS_ABILITY_KEYS.includes(selectedAttribute) || !Number.isFinite(modifier)) return null;

    return new ModifierClass({
      slug: "vurs-main-attribute-attack",
      label: VURS_ABILITY_LABELS[selectedAttribute],
      modifier,
      type: "ability",
      ability: selectedAttribute,
      force: true
    });
  };

  strikeAttackModifiers.push(mainAttributeModifier);
  actor[VURS_KEY_ATTACK_MODIFIER] = mainAttributeModifier;
}

function installKeyAttributeDamageModifier(actor) {
  const modifiers = actor.synthetics?.modifiers;
  if (!modifiers || Object.values(modifiers).some(entries => entries?.includes?.(actor[VURS_KEY_DAMAGE_MODIFIER]))) return;

  const strikeDamageModifiers = (modifiers["strike-damage"] ??= []);
  const ModifierClass = game.pf2e?.Modifier ??
    actor.system.actions?.flatMap(action => action.modifiers ?? []).find(modifier => modifier?.constructor)?.constructor;
  if (typeof ModifierClass !== "function") return;

  const deferredModifier = ({ resolvables } = {}) => {
    if (!actorUsesMainAttribute(actor)) return null;
    const weapon = resolvables?.weapon;
    if (!weapon || weapon.actor?.uuid !== actor.uuid || !weapon.isOfType?.("weapon")) return null;

    const selectedAttribute = VURS_ABILITY_KEYS.includes(weapon.system?.attribute)
      ? weapon.system.attribute
      : getMainAttribute(actor);
    const selectedValue = actor.system.abilities?.[selectedAttribute]?.mod;
    const strengthValue = actor.system.abilities?.str?.mod;
    if (!Number.isFinite(selectedValue) || !Number.isFinite(strengthValue)) return null;

    const traits = weapon.system.traits?.value ?? [];
    const isStrengthBased = weapon.isMelee ||
      traits.includes("propulsive") ||
      (weapon.isThrown && !traits.includes("splash") && !["alchemical-bomb", "grenade"].includes(weapon.baseType));
    const strengthComponent = isStrengthBased
      ? (strengthValue < 0 || !traits.includes("propulsive") ? strengthValue : Math.floor(strengthValue / 2))
      : 0;
    const adjustment = selectedValue - strengthComponent;
    if (adjustment === 0) return null;

    return new ModifierClass({
      slug: "vurs-key-attribute-damage",
      label: VURS_ABILITY_LABELS[selectedAttribute],
      modifier: adjustment,
      type: "untyped"
    });
  };

  strikeDamageModifiers.push(deferredModifier);
  actor[VURS_KEY_DAMAGE_MODIFIER] = deferredModifier;
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

  const actorClasses = CONFIG.PF2E?.Actor?.documentClasses ?? {};
  const candidates = new Set([
    CONFIG.Actor?.documentClass,
    ...Object.values(actorClasses)
  ].filter(actorClass => typeof actorClass?.prototype?.applyDamage === "function"));

  for (const actorClass of candidates) {
    const actorType = Object.entries(actorClasses).find(([, candidate]) => candidate === actorClass)?.[0];
    const target = actorType
      ? `CONFIG.PF2E.Actor.documentClasses.${actorType}.prototype.applyDamage`
      : actorClass === CONFIG.Actor?.documentClass ? "CONFIG.Actor.documentClass.prototype.applyDamage" : null;
    if (!target || registeredIwrDamageTargets.has(target)) continue;

    const wrapper = function (wrapped, ...args) {
      const attributes = this.attributes;
      for (const entry of [...(attributes?.immunities ?? []), ...(attributes?.resistances ?? [])]) {
        installIwrTestPatch(entry);
      }
      return wrapped(...args);
    };
    try {
      if (globalThis.libWrapper?.register) {
        globalThis.libWrapper.register(MODULE_ID, target, wrapper, "WRAPPER");
      } else {
        const prototype = actorClass.prototype;
        const original = prototype.applyDamage;
        prototype.applyDamage = function (...args) {
          const attributes = this.attributes;
          for (const entry of [...(attributes?.immunities ?? []), ...(attributes?.resistances ?? [])]) {
            installIwrTestPatch(entry);
          }
          return original.apply(this, args);
        };
      }
      registeredIwrDamageTargets.add(target);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to register IWR damage handling for ${target}`, error);
    }
  }
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
  const hasDamageOption = values.includes("damage") || values.some(option =>
    typeof option === "string" && (option.startsWith("damage:type:") || option.startsWith("damage:category:"))
  );
  if (!hasDamageOption || values.includes("damage:category:physical")) return false;
  return !["bludgeoning", "slashing", "piercing"].some(type => values.includes(`damage:type:${type}`));
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