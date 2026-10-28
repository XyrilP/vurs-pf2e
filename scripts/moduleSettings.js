const MODULE_ID = "vurs-pf2e";

const SETTING_KEYS = Object.freeze({
  systemMode: "systemMode",
  dicelessInDefault: "dicelessInDefault",
  dicelessInAgnostic: "dicelessInAgnostic",
  negativeHpInDefault: "negativeHpInDefault",
  groupSkillsByAttributeInDefault: "groupSkillsByAttributeInDefault",
  colorAttributeModifierFramesInDefault: "colorAttributeModifierFramesInDefault",
  includeVursSkillsInDefault: "includeVursSkillsInDefault",
  addSaveSkillsInDefault: "addSaveSkillsInDefault",
  addActionPointsInDefault: "addActionPointsInDefault",
  vursCriticalDamageInDefault: "vursCriticalDamageInDefault"
});

function requestSettingsRefresh(settingName) {
  const confirm = globalThis.Dialog?.confirm;
  if (typeof confirm !== "function") {
    globalThis.ui?.notifications?.warn?.(`${settingName} changed. Refresh the page to apply it.`);
    return;
  }

  confirm({
    title: "Refresh Required",
    content: `<p>${settingName} changed. Refresh the page now to apply it?</p>`,
    yes: () => window.location.reload(),
    defaultYes: false
  });
}

const FEATURE_DEFINITIONS = Object.freeze([
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
        const locked = isVurs || (mode === "agnostic" && ALWAYS_ON_FEATURES.has(feature.id) && !isAgnosticDiceless);
        const enabled = locked || (mode === "agnostic"
          ? settingValue(settings, feature.agnosticSetting)
          : settingValue(settings, feature.defaultSetting));
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
      if (feature.defaultSetting) {
        updates.push(game.settings.set(MODULE_ID, feature.defaultSetting,
          values[`default.${feature.id}`] === true));
      }
      if (feature.agnosticSetting) {
        updates.push(game.settings.set(MODULE_ID, feature.agnosticSetting,
          values[`agnostic.${feature.id}`] === true));
      }
    }
    await Promise.all(updates);
    requestSettingsRefresh("Feature settings");
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

  if (!settings.menus?.has?.(`${MODULE_ID}.featureSettings`)) {
    settings.registerMenu(MODULE_ID, "featureSettings", {
      name: "Features by System Mode",
      label: "Configure Features",
      hint: "Choose optional features for each system mode. Locked boxes are always enabled by that mode.",
      icon: "fas fa-table-cells",
      restricted: true,
      type: VursFeatureSettings
    });
  }

  for (const feature of FEATURE_DEFINITIONS) {
    for (const key of [feature.defaultSetting, feature.agnosticSetting].filter(Boolean)) {
      registerSetting(settings, key, {
        scope: "world",
        config: false,
        type: Boolean,
        default: false
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

