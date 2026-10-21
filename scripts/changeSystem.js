const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";
const VURS_DIE_RESULT = Symbol("vurs-pf2e.fixedDieResult");
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

Hooks.once("ready", () => {
  applySystemMode();
  installVursCheckRoll();
  installVursAverageDamage();
});
Hooks.on("vurs-pf2e.systemModeChanged", mode => applySystemMode(mode));

function getSystemMode() {
  return game.settings.get(MODULE_ID, SETTING_KEY) ?? "default";
}

function actorHasDicelessFlag(actor) {
  if (typeof actor === "string") {
    try { actor = fromUuidSync(actor); } catch { actor = null; }
  }
  // Avoid getFlag(): it throws when the "vurs" scope has not been registered
  // by an active module. The actor's persisted flag data is safe to inspect.
  return foundry.utils.getProperty(actor, "flags.vurs.diceless") === 1;
}

function getCheckActor(check, options = {}) {
  return options.origin?.actor ?? options.actor ?? options.self?.actor ??
    check?.actor ?? check?.statistic?.actor ?? options.item?.actor ?? null;
}

function getDamageRollActor(roll) {
  const options = roll?.options ?? {};
  const damage = options.damage ?? {};
  const actor = damage.origin?.actor ?? damage.self?.actor ?? damage.actor ??
    options.origin?.actor ?? options.self?.actor ?? options.actor ??
    damage.item?.actor ?? options.item?.actor;
  if (actor) return actor;

  const controlledActors = (canvas.tokens?.controlled ?? []).map(token => token.actor).filter(Boolean);
  const flaggedControlled = controlledActors.filter(actorHasDicelessFlag);
  if (flaggedControlled.length === 1) return flaggedControlled[0];
  return actorHasDicelessFlag(game.user?.character) ? game.user.character : null;
}

function applySystemMode(mode = getSystemMode()) {
  const translations = game.i18n.translations;
  if (translations) {
    for (const [path, vursText] of Object.entries(VURS_TRANSLATIONS)) {
      if (!originalTranslations.has(path)) originalTranslations.set(path, foundry.utils.getProperty(translations, path));
      const text = mode === "default" ? originalTranslations.get(path) : vursText;
      if (text !== undefined) foundry.utils.setProperty(translations, path, text);
    }
  }
  for (const app of Object.values(ui.windows ?? {})) app.render?.(false);
}

function installVursCheckRoll() {
  const checkApi = game.pf2e?.Check;
  if (!checkApi || typeof checkApi.roll !== "function" || checkApi.__vursCheckRollInstalled) return;

  const originalRoll = checkApi.roll;
  checkApi.roll = async function (check, options = {}, event = null, callback) {
    const actor = getCheckActor(check, options);
    const actorDiceless = actorHasDicelessFlag(actor);
    if (getSystemMode() !== "vurs" && !actorDiceless) return originalRoll.call(this, check, options, event, callback);

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

  // Recalculate the dialog height once after inserting the extra row.
  app.options.height = "auto";
  requestAnimationFrame(() => app.setPosition({ height: "auto" }));

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

// Preserve VURS roll data when PF2e rerolls a check from its chat card.
// Rerolling for a new result (including a Hero Point) raises the base by 50%;
// keep-higher/lower rerolls continue to use Fortune/Misfortune rules.
Hooks.on("pf2e.preReroll", (originalRoll, newRoll, resource, rerollOptions = {}) => {
  if ((getSystemMode() !== "vurs" && !actorHasDicelessFlag(originalRoll?.options?.actor)) || !Number.isFinite(originalRoll?.options?.vursRawBase)) return;
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
      const actorDiceless = pendingCheck?.actorDiceless || actorHasDicelessFlag(this.options?.actor);
      const dicelessEnabled = mode === "vurs" || actorDiceless;
      const isVursCheckRoll = dicelessEnabled && (
        looksLikePf2eCheckRoll || Number.isFinite(this.options?.vursFixedBase)
      );
      const activeState = isVursCheckRoll ? pendingCheck : null;
      const rawCheckBase = activeState
        ? 8 + activeState.buildup
        : (isVursCheckRoll ? this.options.vursRawBase ?? this.options.vursFixedBase : null);
      let fixedCheckBase = activeState ? getVursCheckBase(activeState) : (isVursCheckRoll ? this.options.vursFixedBase : null);
      if (isVursCheckRoll && !activeState && Number.isFinite(rawCheckBase) && this.options.isReroll) {
        const keep = this.options.vursRerollKeep ?? "new";
        fixedCheckBase = getAdjustedVursBase(rawCheckBase, keep === "lower" ? "misfortune" : "fortune");
      }
      const damageActorDiceless = actorHasDicelessFlag(getDamageRollActor(this));
      const isDamageRoll = (mode === "vurs" || damageActorDiceless) && (
        ["DamageRoll", "DamageInstance"].includes(rollClass) ||
        this.options?.type === "damage-roll" ||
        Boolean(this.options?.damage)
      );
      const previousResults = [];

      if ((isVursCheckRoll && Number.isFinite(fixedCheckBase)) || isDamageRoll) {
        if (isVursCheckRoll && activeState) {
          this.options.vursBuildup = activeState.buildup;
          this.options.vursRawBase = rawCheckBase;
          this.options.vursFixedBase = fixedCheckBase;
          this.options.vursFortuneState = getVursCheckEffect(activeState.context);
          this.options.vursDiceless = true;
        }
        if (isDamageRoll && damageActorDiceless) this.options.vursDiceless = true;
        for (const die of this.dice ?? []) {
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
