const MODULE_ID = "vurs-pf2e";

const SETTING_KEYS = Object.freeze({
  systemMode: "systemMode",
  enforceDisabledFeaturesInDefault: "enforceDisabledFeaturesInDefault",
  enforceDisabledFeaturesInVurs: "enforceDisabledFeaturesInVurs",
  enforceDisabledFeaturesInAgnostic: "enforceDisabledFeaturesInAgnostic",
  dicelessInDefault: "dicelessInDefault",
  dicelessInAgnostic: "dicelessInAgnostic",
  negativeHpInDefault: "negativeHpInDefault",
  groupSkillsByAttributeInDefault: "groupSkillsByAttributeInDefault",
  colorAttributeModifierFramesInDefault: "colorAttributeModifierFramesInDefault",
  includeVursSkillsInDefault: "includeVursSkillsInDefault",
  addSaveSkillsInDefault: "addSaveSkillsInDefault",
  addActionPointsInDefault: "addActionPointsInDefault",
  vursCriticalDamageInDefault: "vursCriticalDamageInDefault",
  manualDamageApplication: "manualDamageApplication",
  automaticDamageRolls: "automaticDamageRolls",
  automaticTemplatePlacement: "automaticTemplatePlacement",
  automaticNpcSavingThrows: "automaticNpcSavingThrows",
  allowPlayersToControlFollowers: "allowPlayersToControlFollowers",
  colorTokenRingsByPlayer: "colorTokenRingsByPlayer"
});

function requestSettingsRefresh(settingName) {
  const dialog = globalThis.Dialog;
  if (typeof dialog?.confirm !== "function") {
    globalThis.ui?.notifications?.warn?.(`${settingName} changed. Refresh the page to apply it.`);
    return;
  }

  dialog.confirm({
    title: "Refresh Required",
    content: `<p>${settingName} changed. Refresh the page now to apply it?</p>`,
    yes: () => window.location.reload(),
    defaultYes: false
  });
}

const FEATURE_DEFINITIONS = Object.freeze([
  {
    id: "disabledFeatureEnforcement",
    label: "Enforce Disabled Features",
    hint: "Prevent condition-disabled features and rule elements from being used. When off, disabled features are revealed on hover.",
    defaultSetting: SETTING_KEYS.enforceDisabledFeaturesInDefault,
    vursSetting: SETTING_KEYS.enforceDisabledFeaturesInVurs,
    agnosticSetting: SETTING_KEYS.enforceDisabledFeaturesInAgnostic
  },
  {
    id: "negativeHp",
    label: "Negative HP",
    hint: "Damage below 0 HP reduces maximum HP.",
    defaultSetting: SETTING_KEYS.negativeHpInDefault
  },
  {
    id: "diceless",
    label: "Diceless Rolls",
    hint: "Use a fixed VURS-style check result and optional buildup.",
    defaultSetting: SETTING_KEYS.dicelessInDefault,
    agnosticSetting: SETTING_KEYS.dicelessInAgnostic
  },
  {
    id: "skillGrouping",
    label: "Group Skills by Attribute",
    hint: "Organize skills into attribute groups.",
    defaultSetting: SETTING_KEYS.groupSkillsByAttributeInDefault
  },
  {
    id: "attributeFrames",
    label: "Attribute Modifier Borders",
    hint: "Color attribute modifier borders by attribute.",
    defaultSetting: SETTING_KEYS.colorAttributeModifierFramesInDefault
  },
  {
    id: "vursSkills",
    label: "VURS Skills",
    hint: "Add VURS homebrew skills.",
    defaultSetting: SETTING_KEYS.includeVursSkillsInDefault
  },
  {
    id: "saveSkills",
    label: "Saves and Perception Skills",
    hint: "Add Fortitude, Reflex, Will, and Perception to the Skills tab.",
    defaultSetting: SETTING_KEYS.addSaveSkillsInDefault
  },
  {
    id: "actionResources",
    label: "Actions and Reactions",
    hint: "Add three Actions and one Reaction as Play resources.",
    defaultSetting: SETTING_KEYS.addActionPointsInDefault
  },
  {
    id: "criticalDamage",
    label: "VURS Critical Damage",
    hint: "Add maximum damage to critical-hit damage rolls.",
    defaultSetting: SETTING_KEYS.vursCriticalDamageInDefault
  }
]);

const MODE_LABELS = Object.freeze({
  default: "Default",
  vurs: "VURS",
  agnostic: "Agnostic VURS"
});

const ALWAYS_ON_FEATURES = Object.freeze(new Set([
  "negativeHp",
  "skillGrouping",
  "attributeFrames",
  "vursSkills",
  "saveSkills",
  "actionResources",
  "criticalDamage",
  "diceless"
]));

function registerSetting(settings, key, data) {
  const registration = `${MODULE_ID}.${key}`;
  if (settings.settings?.has?.(registration)) return;
  settings.register(MODULE_ID, key, data);
}

function settingValue(settings, key) {
  return settings.get(MODULE_ID, key) === true;
}

class VursFeatureSettings extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-feature-settings`,
    classes: [MODULE_ID, "vurs-feature-settings"],
    tag: "form",
    position: { width: 760 },
    window: { title: "VURS Feature Settings", resizable: true },
    form: {
      handler: VursFeatureSettings.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/moduleSettings.hbs` }
  };

  async _prepareContext() {
    const settings = game.settings;
    const features = FEATURE_DEFINITIONS.map(feature => ({
      ...feature,
      modes: ["default", "vurs", "agnostic"].map(mode => {
        const isVurs = mode === "vurs";
        const isAgnosticDiceless = mode === "agnostic" && feature.id === "diceless";
        const modeSetting = isVurs
          ? feature.vursSetting
          : mode === "agnostic"
            ? feature.agnosticSetting
            : feature.defaultSetting;
        const locked = (isVurs && !feature.vursSetting) ||
          (mode === "agnostic" && ALWAYS_ON_FEATURES.has(feature.id) && !isAgnosticDiceless);
        const enabled = locked || settingValue(settings, modeSetting);
        return {
          id: mode,
          label: MODE_LABELS[mode],
          name: `${mode}.${feature.id}`,
          checked: enabled,
          locked
        };
      })
    }));

    return {
      features,
      modes: ["default", "vurs", "agnostic"].map(id => ({ id, label: MODE_LABELS[id] }))
    };
  }

  static async #onSubmit(event, form, formData) {
    event.preventDefault();
    const values = formData.object;
    const updates = [];
    for (const feature of FEATURE_DEFINITIONS) {
      for (const [mode, key] of [
        ["default", feature.defaultSetting],
        ["vurs", feature.vursSetting],
        ["agnostic", feature.agnosticSetting]
      ]) {
        if (key) {
          updates.push(game.settings.set(MODULE_ID, key, values[`${mode}.${feature.id}`] === true));
        }
      }
    }
    await Promise.all(updates);
    requestSettingsRefresh("Feature settings");
  }
}

const AUTO_CLICKER_SETTINGS = Object.freeze([
  {
    key: SETTING_KEYS.automaticDamageRolls,
    name: "Automatically Roll Eligible Damage and Healing",
    hint: "Automatically roll damage and healing for successful Strikes, eligible healing spells, accepted Auto-Fire/Area-Fire targets, and accepted basic-save spells. Three-action Heal waits for Toolbelt's emanation target selection. Mixed vitality/void effects follow PF2E target healing rules; only targets damaged by that energy type need a save. Area damage waits for the template and accepted targets, and spell damage waits for required saves."
  },
  {
    key: SETTING_KEYS.automaticTemplatePlacement,
    name: "Automatically Place Area Templates",
    hint: "Automatically start PF2e's native template placement for eligible basic-save spells, three-action Heal emanations, and Auto-Fire/Area-Fire. You still choose the area position and direction for Toolbelt targeting. Toolbelt's Dismiss Template option controls whether a placed region remains visible after target selection. When disabled, click the template button manually."
  },
  {
    key: SETTING_KEYS.automaticNpcSavingThrows,
    name: "Automatically Roll Eligible Toolbelt Saves",
    hint: "Requires PF2E Toolbelt Target Helper. After area templates are placed and targets accepted, the GM rolls basic saves for eligible saving-throw spells and Auto-Fire/Area-Fire, including saves for player-owned actors. Damage waits until every target that needs a save has resolved it."
  },
  {
    key: SETTING_KEYS.manualDamageApplication,
    name: "Manual Damage Application",
    hint: "When enabled, Auto-Clicker leaves damage and healing application manual. When disabled, it applies eligible results only after the workflow and any required saves are resolved."
  }
]);

class AutoClickerSettings extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-auto-clicker-settings`,
    classes: [MODULE_ID, "vurs-auto-clicker-settings"],
    tag: "form",
    position: { width: 560 },
    window: { title: "Auto-Clicker", resizable: true },
    form: {
      handler: AutoClickerSettings.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/autoClickerSettings.hbs` }
  };

  async _prepareContext() {
    return {
      settings: AUTO_CLICKER_SETTINGS.map(setting => ({
        ...setting,
        checked: settingValue(game.settings, setting.key)
      }))
    };
  }

  static async #onSubmit(event, form, formData) {
    event.preventDefault();
    const values = formData.object;
    await Promise.all(AUTO_CLICKER_SETTINGS.map(setting =>
      game.settings.set(MODULE_ID, setting.key, values[setting.key] === true)
    ));
  }
}

function registerModuleSettings() {
  const settings = globalThis.game?.settings;
  if (!settings?.register) return;

  registerSetting(settings, SETTING_KEYS.systemMode, {
    name: "System Mode",
    hint: "Choose the rules mode for this world.",
    scope: "world",
    config: true,
    type: String,
    default: "default",
    onChange: value => {
      Hooks.callAll(`${MODULE_ID}.systemModeChanged`, value);
      requestSettingsRefresh("System mode");
    },
    choices: {
      default: "Default",
      vurs: "Vionheart Universe Roleplaying System",
      "vurs-agnostic": "VURS (Agnostic)"
    }
  });

  registerSetting(settings, SETTING_KEYS.allowPlayersToControlFollowers, {
    name: "Allow Players to Control Followers",
    hint: "When enabled, players may control assigned followers. The first player to control one holds exclusive follower control until releasing it; an NPC's Follower override takes precedence.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: value => Hooks.callAll(`${MODULE_ID}.followerPlayerControlChanged`, value === true)
  });

  registerSetting(settings, SETTING_KEYS.colorTokenRingsByPlayer, {
    name: "Color Dynamic Token Rings by Player",
    hint: "A GM selecting the token takes priority. Otherwise use the assigned GM, active follower controller, assigned player, or sole owner.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => Hooks.callAll(`${MODULE_ID}.playerTokenRingColorsChanged`)
  });

  registerSetting(settings, SETTING_KEYS.manualDamageApplication, {
    name: "Manual Damage Application",
    hint: "When enabled, Auto-Clicker leaves damage and healing application manual. When disabled, it applies eligible results only after the workflow and any required saves are resolved.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  registerSetting(settings, SETTING_KEYS.automaticDamageRolls, {
    name: "Automatically Roll Eligible Damage and Healing",
    hint: "Automatically roll damage and healing for successful Strikes, eligible healing spells, accepted Auto-Fire/Area-Fire targets, and accepted basic-save spells. Three-action Heal waits for Toolbelt's emanation target selection. Mixed vitality/void effects follow PF2E target healing rules; only targets damaged by that energy type need a save. Area damage waits for the template and accepted targets, and spell damage waits for required saves.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  registerSetting(settings, SETTING_KEYS.automaticTemplatePlacement, {
    name: "Automatically Place Area Templates",
    hint: "Automatically start PF2E's native template placement for eligible basic-save spells, three-action Heal emanations, and Auto-Fire/Area-Fire. You still choose the area position and direction for Toolbelt targeting. Toolbelt's Dismiss Template option controls whether a placed region remains visible after target selection. When disabled, click the template button manually.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  registerSetting(settings, SETTING_KEYS.automaticNpcSavingThrows, {
    name: "Automatically Roll Eligible Toolbelt Saves",
    hint: "Requires PF2E Toolbelt Target Helper. After area templates are placed and targets accepted, the GM rolls basic saves for eligible saving-throw spells and Auto-Fire/Area-Fire, including saves for player-owned actors. Damage waits until every target that needs a save has resolved it.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  if (!settings.menus?.has?.(`${MODULE_ID}.autoClicker`)) {
    settings.registerMenu(MODULE_ID, "autoClicker", {
      name: "Auto-Clicker",
      label: "Configure",
      hint: "Configure automatic damage and healing rolls, saving throws, and damage application.",
      icon: "fas fa-computer-mouse",
      restricted: true,
      type: AutoClickerSettings
    });
  }

  if (!settings.menus?.has?.(`${MODULE_ID}.featureSettings`)) {
    settings.registerMenu(MODULE_ID, "featureSettings", {
      name: "Features by System Mode",
      label: "Configure Features",
      hint: "Configure optional features and disabled-feature enforcement for each system mode.",
      icon: "fas fa-table-cells",
      restricted: true,
      type: VursFeatureSettings
    });
  }

  for (const feature of FEATURE_DEFINITIONS) {
    for (const key of [feature.defaultSetting, feature.vursSetting, feature.agnosticSetting].filter(Boolean)) {
      registerSetting(settings, key, {
        scope: "world",
        config: false,
        type: Boolean,
        default: feature.id === "disabledFeatureEnforcement"
      });
    }
  }
}

// Module scripts normally register settings during init. Keep guarded later
// hooks as a fallback for worlds where the module is activated or reloaded
// after that hook has already fired.
registerModuleSettings();
Hooks.once("init", registerModuleSettings);
Hooks.once("setup", registerModuleSettings);
Hooks.once("ready", registerModuleSettings);
