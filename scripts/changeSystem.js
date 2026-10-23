const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";
const VURS_DIE_RESULT = Symbol("vurs-pf2e.fixedDieResult");
const VURS_UNDO_ACTIVE = Symbol("vurs-pf2e.undoDamageActive");
const VURS_KEY_STRIKE_PATCH = Symbol("vurs-pf2e.keyStrikePatch");
const VURS_MAIN_ATTRIBUTE_PATCH = Symbol("vurs-pf2e.mainAttributePatch");
const VURS_KEY_ATTACK_MODIFIER = Symbol("vurs-pf2e.keyAttackModifier");
const VURS_KEY_DAMAGE_MODIFIER = Symbol("vurs-pf2e.keyDamageModifier");
const VURS_DAMAGE_ACTION_WRAPPED = Symbol("vurs-pf2e.damageActionContext");
const VURS_INLINE_DAMAGE_CONTEXT_PATCH = Symbol("vurs-pf2e.inlineDamageActorContext");
const VURS_IWR_TEST_PATCH = Symbol("vurs-pf2e.iwrTestPatch");
const VURS_IWR_INSTANCE_TEST_PATCH = Symbol("vurs-pf2e.iwrInstanceTestPatch");
const VURS_SPECIAL_IWR_RULE_PATCH = Symbol("vurs-pf2e.specialIwrRulePatch");
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
const activeVursCheckRolls = [];
const activeVursDamageActors = [];
const registeredActorWrappers = new Set();
const registeredIwrDamageTargets = new Set();
let mostRecentCheckActor = null;
let actorCreationHookInstalled = false;
let rollPatchRetryTimer = null;

Hooks.once("init", registerCustomIwrTypes);

// Roll classes are available during setup. Wait for PF2e's systemReady hook
// before patching actors: its document classes are still being assembled in
// setup, and an early wrapper can mark the base Actor class before PF2e adds
// its preparation methods.
Hooks.once("setup", () => {
  installVursRollPatches();
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
  installVursRollPatches();
  // A bounded retry covers PF2e builds that expose Check or the Dice Roll
  // class after setup. Stop as soon as both wrappers are in place.
  if (rollPatchRetryTimer) clearInterval(rollPatchRetryTimer);
  let attempts = 0;
  rollPatchRetryTimer = setInterval(() => {
    attempts++;
    installVursRollPatches();
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
      .find(candidate => candidate?.isOfType?.("character")) ??
      game.actors?.contents?.find(candidate => candidate.apps?.[app?.id] === app);
    if (VURS_MAIN_ATTRIBUTE_ENABLED) addMainAttributeChoice(app, root, context, options);
    reorderAttributeBuilderColumns(root, actor);
    reorderCharacterSheetAttributes(root, actor);
    applyActorAbilityLabels(root, actor);
    applyMainAttributeStar(root, actor);
  });
});
Hooks.on("renderActorSheet", (app, html) => {
  installActorDamageActionContext(app?.actor);
  applyActorSheetPresentation(app, html);
});
Hooks.on("renderApplication", (app, html) => applyActorSheetPresentation(app, html));
Hooks.on("updateActor", actor => {
  for (const app of Object.values(actor.apps ?? {})) {
    const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
    if (root) requestAnimationFrame(() => addVursMaxHpReductionControl(root, actor));
  }
});
Hooks.on("renderChatMessage", (message, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const button = root?.querySelector('button[data-action="revertDamage"]');
  if (!button || button.dataset.vursReductionUndo) return;
  button.dataset.vursReductionUndo = "true";
  button.addEventListener("click", () => {
    const appliedDamage = message.flags?.pf2e?.appliedDamage;
  const reductionUpdate = appliedDamage?.updates?.find(update =>
    update.path === "flags.vurs.hp.maxReduction" || update.path === `flags.${MODULE_ID}.hp.maxReduction`
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
    .find(candidate => candidate?.isOfType?.("character"));
  if (!root || !actor) return;
  requestAnimationFrame(() => addVursMaxHpReductionControl(root, actor));
  allowNegativeHpEntry(root, actor);
  reorderCharacterSheetAttributes(root, actor);
  applyActorAbilityLabels(root, actor);
  applyMainAttributeStar(root, actor);
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

function getSystemMode() {
  return game.settings.get(MODULE_ID, SETTING_KEY) ?? "default";
}

function actorHasVursSystemFlag(actor) {
  if (typeof actor === "string") {
    const reference = actor;
    try { actor = fromUuidSync(reference); } catch { actor = null; }
    actor ??= game.actors?.get(reference) ?? null;
  }
  const flag = foundry.utils.getProperty(actor, "flags.vurs.vursSystem") ??
    foundry.utils.getProperty(actor, "_source.flags.vurs.vursSystem") ??
    foundry.utils.getProperty(actor, "document._source.flags.vurs.vursSystem");
  return flag === 1 || flag === "1";
}

function actorUsesVursSystem(actor) {
  return getSystemMode() === "vurs" || actorHasVursSystemFlag(actor);
}

function actorUsesVursHpRules(actor) {
  const mode = getSystemMode();
  if (mode === "vurs" || mode === "vurs-agnostic") return true;
  if (mode === "default") {
    return game.settings.get(MODULE_ID, "negativeHpInDefault") === true || actorHasVursSystemFlag(actor);
  }
  return actorHasVursSystemFlag(actor);
}

function actorUsesDicelessRolls(actor) {
  // Full VURS mode enables diceless rolls globally. In other modes, either
  // actor-level VURS flag opts that actor into diceless rules.
  return getSystemMode() === "vurs" || actorHasDicelessFlag(actor) || actorHasVursSystemFlag(actor);
}

function actorHasDicelessFlag(actor) {
  if (typeof actor === "string") {
    const reference = actor;
    try { actor = fromUuidSync(reference); } catch { actor = null; }
    actor ??= game.actors?.get(reference) ?? null;
  }
  // Avoid getFlag(): it throws when the "vurs" scope has not been registered
  // by an active module. The actor's persisted flag data is safe to inspect.
  const flag = foundry.utils.getProperty(actor, "flags.vurs.diceless") ??
    foundry.utils.getProperty(actor, "_source.flags.vurs.diceless") ??
    foundry.utils.getProperty(actor, "document._source.flags.vurs.diceless");
  return flag === 1 || flag === "1";
}

function getCheckActor(check, options = {}) {
  return options.origin?.actor ?? options.actor ?? options.self?.actor ??
    options.token?.actor ?? options.item?.actor ?? check?.actor ?? check?.origin?.actor ??
    check?.statistic?.actor ?? check?.statistic?.parent?.actor ??
    findActorInRollContext(options) ?? findActorInRollContext(check);
}

function getDamageRollActor(roll) {
  const options = roll?.options ?? {};
  const damage = options.damage ?? {};
  const actor = damage.origin?.actor ?? damage.self?.actor ?? damage.actor ??
    options.origin?.actor ?? options.self?.actor ?? options.actor ??
    damage.item?.actor ?? options.item?.actor ?? roll?.actor ?? roll?.item?.actor ??
    roll?.parent?.actor ?? roll?.source?.actor ?? roll?.context?.actor ?? options.vursActorUuid;
  if (actor) return actor;

  return findActorInRollContext(roll) ?? findActorInRollContext(options);
}

function findActorInRollContext(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.isOfType === "function" && value.isOfType("character", "npc", "creature", "hazard")) return value;
  for (const key of ["actor", "actorId", "actorUuid", "sourceActor", "originActor", "origin", "self", "source", "item", "token", "damage", "context", "options"]) {
    const nested = value[key];
    if (!nested) continue;
    if (typeof nested === "string" && ["actor", "actorId", "actorUuid", "sourceActor", "originActor"].includes(key)) {
      let referencedActor = null;
      try { referencedActor = fromUuidSync(nested); } catch { /* Try the world actor collection below. */ }
      referencedActor ??= game.actors?.get(nested) ?? null;
      if (referencedActor?.isOfType?.("character", "npc", "creature", "hazard")) return referencedActor;
    }
    const found = Array.isArray(nested)
      ? nested.map(entry => findActorInRollContext(entry, seen, depth + 1)).find(Boolean)
      : findActorInRollContext(nested, seen, depth + 1);
    if (found) return found;
  }
  return null;
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
  if (!root || !actor?.isOfType?.("character") || !actorHasVursSystemFlag(actor) || getSystemMode() === "vurs") return;

  const replacements = new Map();
  const shortLabels = { str: "Str", dex: "Agi", con: "Wea", int: "Int", wis: "Spi", cha: "Voi" };
  for (const [ability, vursLabel] of Object.entries(VURS_ABILITY_LABELS)) {
    const original = game.i18n.localize(`PF2E.Ability${ability[0].toUpperCase()}${ability.slice(1)}`);
    const current = original && original !== `PF2E.Ability${ability[0].toUpperCase()}${ability.slice(1)}`
      ? original
      : ({ str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" })[ability];
    replacements.set(current, vursLabel);
    const shortOriginal = game.i18n.localize(`PF2E.AbilityId.${ability}`);
    replacements.set(shortOriginal && shortOriginal !== `PF2E.AbilityId.${ability}` ? shortOriginal : shortLabels[ability], shortLabels[ability]);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const parentTag = node.parentElement?.tagName;
    if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(parentTag)) continue;
    let text = node.nodeValue;
    for (const [source, replacement] of replacements) {
      if (!source) continue;
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), replacement);
    }
    if (text !== node.nodeValue) node.nodeValue = text;
  }
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
  const actors = new Set(getCanvasActors());
  for (const actor of actors) {
    installActorKeyAttributeSupport(actor, false);
    actor.reset?.();
    actor.sheet?.render?.(false);
  }
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
  installVursRollPatches();
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

function installVursRollPatches() {
  installInlineDamageActorContext();
  installVursCheckRoll();
  installVursAverageDamage();
}

function installInlineDamageActorContext() {
  const textEditor = game.pf2e?.TextEditor;
  const original = textEditor?._onClickInlineRoll;
  if (typeof original !== "function" || textEditor[VURS_INLINE_DAMAGE_CONTEXT_PATCH]) return;

  textEditor._onClickInlineRoll = async function (event, ...args) {
    const anchor = event?.target?.closest?.("a");
    if (!anchor?.dataset?.formula || !("damageRoll" in anchor.dataset)) {
      return original.call(this, event, ...args);
    }

    const actor = getInlineDamageActor(anchor);
    if (!actor) return original.call(this, event, ...args);
    activeVursDamageActors.push(actor);
    try {
      return await original.call(this, event, ...args);
    } finally {
      const index = activeVursDamageActors.lastIndexOf(actor);
      if (index >= 0) activeVursDamageActors.splice(index, 1);
    }
  };
  Object.defineProperty(textEditor, VURS_INLINE_DAMAGE_CONTEXT_PATCH, { value: true });
}

function getInlineDamageActor(anchor) {
  const messageElement = anchor.closest("li.chat-message");
  const message = game.messages?.get(messageElement?.dataset.messageId ?? "");
  if (message?.speakerActor) return message.speakerActor;

  const appElement = anchor.closest(".sheet");
  const appId = Number(appElement?.dataset.appid);
  const app = Number.isFinite(appId) ? ui.windows?.[appId] : null;
  if (app?.actor) return app.actor;
  if (app?.item?.actor) return app.item.actor;

  const itemUuid = anchor.closest("[data-item-uuid]")?.dataset.itemUuid;
  if (!itemUuid || itemUuid.startsWith("Compendium.")) return null;
  try { return fromUuidSync(itemUuid)?.actor ?? null; } catch { return null; }
}

function installActorDamageActionContext(actor) {
  if (!actor?.isOfType?.("character", "npc", "creature")) return;
  const actions = actor.system?.actions;
  if (!Array.isArray(actions)) return;

  for (const action of actions) {
    for (const method of ["damage", "critical"]) {
      const original = action?.[method];
      if (typeof original !== "function" || original[VURS_DAMAGE_ACTION_WRAPPED]) continue;
      const wrapped = async function (...args) {
        activeVursDamageActors.push(actor);
        try {
          return await original.apply(this, args);
        } finally {
          const index = activeVursDamageActors.lastIndexOf(actor);
          if (index >= 0) activeVursDamageActors.splice(index, 1);
        }
      };
      Object.defineProperty(wrapped, VURS_DAMAGE_ACTION_WRAPPED, { value: true });
      action[method] = wrapped;
    }
  }
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
  if (!actorUsesVursSystem(actor)) return;

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
        await targetActor.update({ [`flags.${MODULE_ID}.mainAttribute`]: ability });
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
    const isSelected = button.dataset.vursMainAttribute === selected;
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.setAttribute("aria-label", `Main ${VURS_ABILITY_LABELS[button.dataset.vursMainAttribute]}`);
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
  if (!actorClass?.prototype || typeof globalThis.libWrapper?.register !== "function") return;
  const wrappers = {
    prepareBuildData: function (wrapped, ...args) {
      const result = wrapped(...args);
      applyMainAttributeBoost(this);
      return result;
    },
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
      if (actorUsesVursSystem(this)) addSavingThrowRuleSupport(this, ["acquisition", "soul"]);
      const result = wrapped(...args);
      if (actorUsesVursSystem(this)) {
        for (const slug of ["acquisition", "soul"]) addSavingThrowDomains(this.skills?.[slug], slug);
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
      const result = wrapped(...args);
      installActorDamageActionContext(this);
      if (actorUsesVursSystem(this)) {
        applyStrengthBasedHitPoints(this);
        if (getSystemMode() !== "vurs" && actorHasVursSystemFlag(this)) applyActorAbilityDataLabels(this);
      }
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
    const moduleReductionPath = `flags.${MODULE_ID}.hp.maxReduction`;
    const hpUndo = recordedUpdates.find(update => update.path === hpPath);
    const reductionUndo = recordedUpdates.find(update => update.path === reductionPath || update.path === moduleReductionPath);
    if (!snapshot && !reductionUndo) return originalUndoDamage.call(this, appliedDamage, ...args);

    const updates = foundry.utils.deepClone(recordedUpdates);
    const otherUpdates = updates.filter(update => update.path !== hpPath &&
      update.path !== reductionPath && update.path !== moduleReductionPath);
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
    const moduleReductionPath = `flags.${MODULE_ID}.hp.maxReduction`;
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

function addSavingThrowDomains(statistic, slug) {
  if (!statistic) return;
  statistic.domains ??= [];
  for (const domain of ["saving-throw", `${slug}-based`]) {
    if (!statistic.domains.includes(domain)) statistic.domains.push(domain);
  }
  if (statistic.data) {
    statistic.data.domains = [...new Set([...(statistic.data.domains ?? []), "saving-throw", `${slug}-based`])];
    statistic.data.rollOptions = [...new Set([...(statistic.data.rollOptions ?? []), "saving-throw", `saving-throw:${slug}`])];
  }
}

function applyStrengthBasedHitPoints(actor) {
  const abilities = actor.system?.abilities;
  const hp = actor.system?.attributes?.hp;
  if (!abilities || !hp) return;
  const level = Math.max(Number(actor.level) || 1, 1);
  const strengthModifier = abilities.str?.mod;
  const constitutionModifier = abilities.con?.mod;
  if (!Number.isFinite(strengthModifier) || !Number.isFinite(constitutionModifier)) return;

  const adjustment = (strengthModifier - constitutionModifier) * level;
  if (!Number.isFinite(adjustment) || adjustment === 0) return;
  const hpModifier = hp.modifiers?.find(modifier => modifier?.slug === "hp-con" || modifier?.ability === "con");
  if (hpModifier && Number.isFinite(hpModifier.modifier)) {
    const replacement = strengthModifier * level;
    const modifierAdjustment = replacement - hpModifier.modifier;
    hpModifier.modifier = replacement;
    hpModifier.ability = "str";
    hpModifier.label = VURS_ABILITY_LABELS.str;
    if (Number.isFinite(hp.totalModifier)) hp.totalModifier += modifierAdjustment;
    if (Number.isFinite(hp.totalModifier)) hp.max = hp.totalModifier;
    else if (Number.isFinite(hp.max)) hp.max += modifierAdjustment;
  } else {
    if (Number.isFinite(hp.totalModifier)) {
      hp.totalModifier += adjustment;
      hp.max = hp.totalModifier;
    } else if (Number.isFinite(hp.max)) {
      hp.max += adjustment;
    }
  }

  // PF2e may have already clamped the prepared value against its initial
  // Constitution-based maximum earlier in startup. Restore the persisted
  // current HP before applying the final maximum so that intermediate prep
  // cannot permanently remove HP when VURS raises the maximum again.
  const sourceHpValue = foundry.utils.getProperty(actor, "_source.system.attributes.hp.value");
  const currentHp = Number.isFinite(sourceHpValue) ? sourceHpValue : hp.value;
  // VURS negative-HP damage is recorded separately from PF2e's derived HP
  // maximum. This lets damage reduce max HP temporarily without changing the
  // character's underlying level/class HP calculation.
  const maxHpAdjustment = getVursMaxHpReduction(actor);
  if (Number.isFinite(hp.max) && maxHpAdjustment !== 0) {
    hp.max = Math.max(0, hp.max - maxHpAdjustment);
  }
  if (Number.isFinite(currentHp) && Number.isFinite(hp.max)) hp.value = Math.min(currentHp, hp.max);
  if (Array.isArray(hp.modifiers)) {
    hp.breakdown = hp.modifiers.filter(modifier => modifier?.enabled !== false && Number.isFinite(modifier?.modifier))
      .map(modifier => `${modifier.label ?? modifier.slug ?? "Modifier"} ${modifier.modifier < 0 ? "" : "+"}${modifier.modifier}`)
      .join(", ");
  }

  const stamina = hp.sp;
  if (stamina && Number.isFinite(stamina.max)) {
    stamina.max += adjustment;
    const sourceStaminaValue = foundry.utils.getProperty(actor, "_source.system.attributes.hp.sp.value");
    const currentStamina = Number.isFinite(sourceStaminaValue) ? sourceStaminaValue : stamina.value;
    if (Number.isFinite(currentStamina)) stamina.value = Math.min(currentStamina, stamina.max);
  }
}

function getVursMaxHpReduction(actor) {
  // The public flags object can lag behind a document update in some PF2e
  // preparation flows. Prefer persisted source data so partial damage reverts
  // immediately expose the restored reduction value to preparation and sheets.
  // The module scope is registered in module.json, unlike the legacy `vurs`
  // scope; prefer it while retaining the old path for existing actor data.
  const value = foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}.hp.maxReduction`) ??
    foundry.utils.getProperty(actor, `document._source.flags.${MODULE_ID}.hp.maxReduction`) ??
    foundry.utils.getProperty(actor, `flags.${MODULE_ID}.hp.maxReduction`) ??
    foundry.utils.getProperty(actor, "_source.flags.vurs.hp.maxReduction") ??
    foundry.utils.getProperty(actor, "document._source.flags.vurs.hp.maxReduction") ??
    foundry.utils.getProperty(actor, "flags.vurs.hp.maxReduction");
  const reduction = Number(value);
  if (!Number.isFinite(reduction)) return 0;
  const normalized = Math.trunc(reduction);
  if (normalized <= 0) return normalized;
  const preparedBaseMax = Number(actor?.system?.attributes?.hp?.totalModifier);
  return Number.isFinite(preparedBaseMax) ? Math.min(normalized, Math.max(0, preparedBaseMax)) : normalized;
}

function getVursReductionUpdates(value) {
  // `vurs` is not a registered Foundry package scope. Writing it causes
  // Actor.update to reject the entire update, including the valid module flag.
  return { [`flags.${MODULE_ID}.hp.maxReduction`]: value };
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

function applyMainAttributeStar(element, actor) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const selectedAttribute = VURS_MAIN_ATTRIBUTE_ENABLED && actorUsesVursSystem(actor)
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
  if (!["vurs", "vurs-agnostic"].includes(getSystemMode()) && !actorHasVursSystemFlag(actor)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const rows = root?.querySelector?.(".attribute-rows");
  if (!rows) return;
  for (const columns of rows.querySelectorAll(".attributes")) {
    const children = [...columns.children];
    if (children.length !== 6) continue;
    children.forEach((child, index) => {
      child.style.order = String(index === 4 ? 5 : index === 5 ? 4 : index);
    });
  }
}

function reorderCharacterSheetAttributes(element, actor) {
  if (!["vurs", "vurs-agnostic"].includes(getSystemMode()) && !actorHasVursSystemFlag(actor)) return;
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
  const chosen = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.mainAttribute`);
  return VURS_ABILITY_KEYS.includes(chosen) ? chosen : null;
}

function applyMainAttributeBoost(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesVursSystem(actor)) return;
  const attribute = getMainAttribute(actor);
  const ability = actor.system?.abilities?.[attribute];
  if (!ability || !Number.isFinite(ability.mod)) return;

  // Match PF2e boosts: +1 modifier below +4, otherwise +0.5 (rounded down).
  ability.mod += ability.mod >= 4 ? 0.5 : 1;
  ability.mod = Math.clamp(ability.mod, -5, 10);
  ability.base = Math.trunc(ability.mod);
}

function applyKeyAttributeToStrikes(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesVursSystem(actor)) return;
  installKeyAttributeDamageModifier(actor);
}

function installMainAttributeAttackModifier(actor) {
  if (!VURS_MAIN_ATTRIBUTE_ENABLED || !actorUsesVursSystem(actor)) return;
  const modifiers = actor.synthetics?.modifiers;
  if (!modifiers || Object.values(modifiers).some(entries => entries?.includes?.(actor[VURS_KEY_ATTACK_MODIFIER]))) return;

  const strikeAttackModifiers = (modifiers["strike-attack-roll"] ??= []);
  const ModifierClass = game.pf2e?.Modifier;
  if (typeof ModifierClass !== "function") return;

  const mainAttributeModifier = ({ resolvables } = {}) => {
    if (!actorUsesVursSystem(actor)) return null;
    const weapon = resolvables?.weapon;
    if (!weapon || weapon.actor?.uuid !== actor.uuid || !weapon.isOfType?.("weapon")) return null;

    // A Strike Rule Element can set the weapon's attribute directly. Honor it;
    // otherwise use Main, falling back to the class key attribute until chosen.
    const selectedAttribute = VURS_ABILITY_KEYS.includes(weapon.system?.attribute)
      ? weapon.system.attribute
      : getMainAttribute(actor) ?? actor.system?.details?.keyability?.value;
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
    if (!actorUsesVursSystem(actor)) return null;
    const weapon = resolvables?.weapon;
    if (!weapon || weapon.actor?.uuid !== actor.uuid || !weapon.isOfType?.("weapon")) return null;

    const selectedAttribute = VURS_ABILITY_KEYS.includes(weapon.system?.attribute)
      ? weapon.system.attribute
      : getMainAttribute(actor) ?? actor.system.details.keyability.value;
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

function installVursCheckRoll() {
  const checkApi = game.pf2e?.Check;
  if (!checkApi || typeof checkApi.roll !== "function" || checkApi.__vursCheckRollInstalled) return;

  const originalRoll = checkApi.roll;
  checkApi.roll = async function (check, options = {}, event = null, callback) {
    const actor = getCheckActor(check, options);
    const actorDiceless = actorHasDicelessFlag(actor);
    if (!actorUsesDicelessRolls(actor)) return originalRoll.call(this, check, options, event, callback);
    if (actor) mostRecentCheckActor = actor;

    const context = { ...options, vursBuildupEnabled: true };
    const state = { buildup: 0, context, actor, actorDiceless };
    // Keep this state out of PF2e's serialized check context while making it
    // available to the dialog and the die-roll adapter.
    Object.defineProperty(context, "__vursCheckState", { value: state });
    if (context.type === "flat-check") {
      const buildup = await chooseFlatCheckBuildup();
      if (buildup === null) return null;
      state.buildup = buildup;
      context.skipDialog = true;
    }

    // Respect PF2e's quick-roll preference. If it skips the dialog, Buildup
    // stays at 0 and the check still uses a fixed VURS base of 8.
    activeVursCheckRolls.push(state);
    try {
      return await originalRoll.call(this, check, context, event, callback);
    } finally {
      const index = activeVursCheckRolls.lastIndexOf(state);
      if (index >= 0) activeVursCheckRolls.splice(index, 1);
    }
  };
  Object.defineProperty(checkApi, "__vursCheckRollInstalled", { value: true });
}

Hooks.on("renderCheckModifiersDialog", (app, html) => {
  if (!app.context?.vursBuildupEnabled) return;
  if (!(app.options?.classes ?? []).includes("roll-modifiers-dialog")) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  const form = root?.querySelector("form.check-modifiers-content");
  if (!form || form.querySelector(".vurs-buildup-selector")) return;

  const group = document.createElement("div");
  group.className = "form-group vurs-buildup-selector";
  const choices = document.createElement("div");
  choices.className = "vurs-buildup-buttons";
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Buildup");
  choices.style.display = "flex";
  choices.style.flexWrap = "nowrap";
  choices.style.alignItems = "center";
  choices.style.justifyContent = "center";
  choices.style.gap = "0.5rem";
  for (const [value, circle, text] of [["0", "8", "None"], ["2", "10", "Buildup +2"], ["5", "13", "Buildup +5"], ["10", "18", "Buildup +10"]]) {
    const option = document.createElement("span");
    option.className = "vurs-buildup-option";
    option.style.display = "inline-flex";
    option.style.alignItems = "center";
    option.style.gap = "0.3rem";
    option.style.whiteSpace = "nowrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vurs-buildup-choice";
    button.dataset.buildup = value;
    button.textContent = circle;
    button.title = `${text} (${circle})`;
    button.style.width = "2rem";
    button.style.height = "2rem";
    button.style.minWidth = "2rem";
    button.style.padding = "0";
    button.style.borderRadius = "50%";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.setAttribute("aria-pressed", value === "0" ? "true" : "false");
    if (value === "0") button.classList.add("active");
    const choiceLabel = document.createElement("span");
    choiceLabel.textContent = text;
    option.append(button, choiceLabel);
    choices.append(option);
  }
  const updateBuildupDisplay = () => {
    const effect = getVursCheckEffect(app.context);
    for (const option of choices.querySelectorAll(".vurs-buildup-option")) {
      const button = option.querySelector("button[data-buildup]");
      const choiceLabel = option.querySelector("span");
      const buildup = Number(button.dataset.buildup);
      const base = getAdjustedVursBase(8 + buildup, effect);
      button.textContent = String(base);
      button.title = `${choiceLabel.dataset.baseLabel} (${base})`;
      choiceLabel.textContent = effect === "none" || buildup === 0
        ? choiceLabel.dataset.baseLabel
        : `Buildup ${base - 8 >= 0 ? "+" : ""}${base - 8}`;
    }
  };
  for (const option of choices.querySelectorAll(".vurs-buildup-option")) {
    const button = option.querySelector("button[data-buildup]");
    const choiceLabel = option.querySelector("span");
    choiceLabel.dataset.baseLabel = button.title.split(" (")[0];
  }
  updateBuildupDisplay();
  group.append(choices);
  const rollTwice = form.querySelector(".roll-twice");
  if (rollTwice) rollTwice.before(group);
  else form.append(group);

  // PF2e refreshes the modifier form after some modifier changes. Keep the
  // selected buttons alive and move this same group into the refreshed form.
  const restoreChoices = () => {
    const currentForm = root.querySelector("form.check-modifiers-content");
    if (!currentForm) return;
    if (!currentForm.contains(group)) {
      const currentRollTwice = currentForm.querySelector(".roll-twice");
      if (currentRollTwice) currentRollTwice.before(group);
      else currentForm.append(group);
      updateBuildupDisplay();
    }
    requestAnimationFrame(() => expandCheckDialog(currentForm, app, root));
  };
  const observer = new MutationObserver(restoreChoices);
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("change", updateBuildupDisplay);
  root.addEventListener("click", event => {
    if (event.target.closest("[data-roll-twice]")) requestAnimationFrame(updateBuildupDisplay);
  });
  root.addEventListener("submit", () => {
    const state = app.context.__vursCheckState;
    const selected = choices.querySelector('button[aria-pressed="true"]');
    if (state && selected) state.buildup = Number(selected.dataset.buildup);
  }, true);

  // Recalculate the dialog height once after inserting the extra row.
  app.options.height = "auto";
  requestAnimationFrame(() => expandCheckDialog(form, app, root));

  choices.addEventListener("click", event => {
    const button = event.target.closest("button[data-buildup]");
    if (!button) return;
    for (const choice of choices.querySelectorAll("button[data-buildup]")) {
      const selected = choice === button;
      choice.setAttribute("aria-pressed", String(selected));
      choice.classList.toggle("active", selected);
    }
  });
  form.addEventListener("change", updateBuildupDisplay);
  form.addEventListener("click", event => {
    if (event.target.closest("[data-roll-twice]")) requestAnimationFrame(updateBuildupDisplay);
  });

  // Store the selected base before PF2e closes the dialog and evaluates its
  // normal CheckRoll. Buildup is a d20 result, not a fortune substitution.
  form.addEventListener("submit", () => {
    const state = app.context.__vursCheckState;
    const selected = choices.querySelector('button[aria-pressed="true"]');
    if (state && selected) state.buildup = Number(selected.dataset.buildup);
  }, true);
});

function expandCheckDialog(form, app, root) {
  if (!form?.isConnected) return;
  const appElement = app.element instanceof HTMLElement ? app.element : root.closest(".app");
  const content = appElement?.querySelector(".window-content") ?? root;
  const overflow = content.scrollHeight - content.clientHeight;
  if (overflow <= 0) return;

  const currentHeight = appElement?.getBoundingClientRect().height ?? app.position?.height ?? 0;
  // Grow by the exact clipped amount plus a small border allowance. This
  // keeps the dialog's own content area tall enough after each modifier edit.
  app.setPosition({ height: Math.ceil(currentHeight + overflow + 4) });
}

// Preserve VURS roll data when PF2e rerolls a check from its chat card.
// Rerolling for a new result (including a Hero Point) raises the base by 50%;
// keep-higher/lower rerolls continue to use Fortune/Misfortune rules.
Hooks.on("pf2e.preReroll", (originalRoll, newRoll, resource, rerollOptions = {}) => {
  const actor = findActorInRollContext(originalRoll?.options) ?? originalRoll?.options?.actor;
  const wasVursCheck = originalRoll?.options?.vursDiceless === true || actorUsesDicelessRolls(actor);
  if (!wasVursCheck || !Number.isFinite(originalRoll?.options?.vursRawBase)) return;
  newRoll.options.vursDiceless = true;
  newRoll.options.vursReroll = true;
  newRoll.options.vursBuildup = originalRoll.options.vursBuildup ?? 0;
  newRoll.options.vursRawBase = originalRoll.options.vursRawBase;
  newRoll.options.vursFixedBase = originalRoll.options.vursFixedBase;
  newRoll.options.vursRerollKeep = rerollOptions.keep ?? "new";
});

function chooseFlatCheckBuildup() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    new Dialog({
      title: "VURS Check",
      content: "Choose a Buildup value for this check.",
      buttons: {
        base: { label: "None (8)", callback: () => finish(0) },
        two: { label: "+2 (10)", callback: () => finish(2) },
        five: { label: "+5 (13)", callback: () => finish(5) },
        ten: { label: "+10 (18)", callback: () => finish(10) },
        cancel: { label: "Cancel", callback: () => finish(null) }
      },
      default: "base",
      close: () => finish(null)
    }).render(true);
  });
}

/**
 * In full VURS, use the mathematical average for dice that belong to PF2e
 * damage rolls. This covers strike damage, spell damage, and PF2e inline
 * @Damage[] rolls, all of which use PF2e's DamageRoll class. Generic Foundry
 * Roll instances (including /r) are deliberately left random.
 */
function installVursAverageDamage() {
  const Die = foundry.dice?.terms?.Die;
  const Roll = foundry.dice?.Roll ?? globalThis.Roll;
  if (Die?.prototype && !Die.prototype.__vursResultInstalled) {
    const originalDieRoll = Die.prototype._roll;
    Die.prototype._roll = async function (...args) {
      // The roll evaluator only stamps this temporary value for a VURS-mode
      // roll or a roll belonging to an actor with the diceless flag.
      if (Number.isFinite(this[VURS_DIE_RESULT])) {
        return this[VURS_DIE_RESULT];
      }
      return originalDieRoll.apply(this, args);
    };
    Object.defineProperty(Die.prototype, "__vursResultInstalled", { value: true });
  }

  if (Roll?.prototype && !Roll.prototype.__vursRollEvaluationInstalled) {
    const originalEvaluate = Roll.prototype.evaluate;
    Roll.prototype.evaluate = async function (...args) {
      const mode = getSystemMode();
      const rollClass = this.constructor?.name;
      const pendingCheck = activeVursCheckRolls.at(-1);
      const looksLikePf2eCheckRoll = rollClass === "CheckRoll" || (
        pendingCheck && typeof this.options?.dice === "string" && Number.isFinite(this.options?.totalModifier)
      );
      // The pending Check.roll wrapper is authoritative. PF2e can alter the
      // concrete CheckRoll class name or its serialized options between
      // system builds, so don't let those details disable the fixed result.
      const isPendingCheckRoll = Boolean(pendingCheck && !pendingCheck.rollApplied);
      const checkActor = pendingCheck?.actor ?? this.options?.actor;
      const actorDiceless = pendingCheck?.actorDiceless || this.options.vursDiceless === true || actorUsesDicelessRolls(checkActor);
      const dicelessEnabled = mode === "vurs" || actorDiceless;
      const isVursCheckRoll = dicelessEnabled && (
        isPendingCheckRoll || looksLikePf2eCheckRoll || Number.isFinite(this.options?.vursFixedBase)
      );
      const activeState = isVursCheckRoll ? pendingCheck : null;
      const rawCheckBase = activeState
        ? 8 + activeState.buildup
        : (isVursCheckRoll ? this.options.vursRawBase ?? this.options.vursFixedBase : null);
      let fixedCheckBase = activeState ? getVursCheckBase(activeState) : (isVursCheckRoll ? this.options.vursFixedBase : null);
      if (isVursCheckRoll && !activeState && Number.isFinite(rawCheckBase) &&
        (this.options.vursReroll || this.options.isReroll)) {
        const keep = this.options.vursRerollKeep ?? "new";
        fixedCheckBase = getAdjustedVursBase(rawCheckBase, keep === "lower" ? "misfortune" : "fortune");
      }
      const damageActor = getDamageRollActor(this) ?? activeVursDamageActors.at(-1);
      const damageActorDiceless = this.options?.vursDiceless === true || actorUsesDicelessRolls(damageActor);
      const isDamageRoll = (mode === "vurs" || damageActorDiceless) && (
        ["DamageRoll", "DamageInstance"].includes(rollClass) ||
        this.options?.type === "damage-roll" ||
        Boolean(this.options?.damage)
      );
      const previousResults = [];

      if ((isVursCheckRoll && Number.isFinite(fixedCheckBase)) || isDamageRoll) {
        if (isVursCheckRoll && activeState) {
          activeState.rollApplied = true;
          this.options.vursBuildup = activeState.buildup;
          this.options.vursRawBase = rawCheckBase;
          this.options.vursFixedBase = fixedCheckBase;
          this.options.vursFortuneState = getVursCheckEffect(activeState.context);
          this.options.vursDiceless = true;
        }
        if (isDamageRoll && damageActorDiceless) this.options.vursDiceless = true;
        for (const die of getNestedRollDice(this)) {
          if (!(die instanceof Die)) continue;
          previousResults.push([die, die[VURS_DIE_RESULT]]);
          if (isVursCheckRoll) die[VURS_DIE_RESULT] = fixedCheckBase;
          else {
            const faces = Number(die.faces);
            if (Number.isFinite(faces) && faces > 0) die[VURS_DIE_RESULT] = Math.ceil((faces + 1) / 2);
          }
        }
      }

      try {
        const result = await originalEvaluate.apply(this, args);

        return result;
      } finally {
        for (const [die, oldResult] of previousResults) {
          if (oldResult === undefined) delete die[VURS_DIE_RESULT];
          else die[VURS_DIE_RESULT] = oldResult;
        }
      }
    };
    Object.defineProperty(Roll.prototype, "__vursRollEvaluationInstalled", { value: true });
  }
}

function getNestedRollDice(roll) {
  const Die = foundry.dice?.terms?.Die;
  const dice = new Set();
  const visited = new WeakSet();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Die && value instanceof Die) {
      dice.add(value);
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (["options", "actor", "parent", "_source", "results", "_formula"].includes(key)) continue;
      visit(nested);
    }
  };
  visit(roll?.terms);
  // The top-level terms of a PF2e DamageRoll are pools whose actual dice are
  // nested inside their instances and component rolls.
  visit(roll?.instances);
  visit(roll?.rolls);
  return [...dice];
}

function getVursCheckBase(state) {
  return getAdjustedVursBase(8 + state.buildup, getVursCheckEffect(state.context));
}

function getVursCheckEffect(context) {
  const options = context.options instanceof Set ? context.options : new Set(context.options ?? []);
  const selectedSubstitutions = (context.substitutions ?? []).filter(substitution => substitution.selected);
  const fortune = options.has("fortune") || context.rollTwice === "keep-higher" || selectedSubstitutions.some(substitution => substitution.effectType === "fortune");
  const misfortune = options.has("misfortune") || context.rollTwice === "keep-lower" || selectedSubstitutions.some(substitution => substitution.effectType === "misfortune");
  if (fortune === misfortune) return "none";
  return fortune ? "fortune" : "misfortune";
}

function getAdjustedVursBase(base, effect) {
  if (effect === "fortune") base = Math.floor(base * 1.5);
  else if (effect === "misfortune") base = Math.floor(base * 0.5);
  return Math.max(1, Math.min(20, base));
}
