const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";
const NEGATIVE_HP_SETTING_KEY = "negativeHpInDefault";
const DEFAULT_SKILL_GROUPING_SETTING_KEY = "groupSkillsByAttributeInDefault";
const DEFAULT_VURS_SKILLS_SETTING_KEY = "includeVursSkillsInDefault";
const DEFAULT_SAVE_SKILLS_SETTING_KEY = "addSaveSkillsInDefault";

function registerModuleSettings() {
  const settings = globalThis.game?.settings;
  if (!settings?.register) return;
  const registered = key => settings.settings?.has?.(`${MODULE_ID}.${key}`) ?? false;
  if (!registered(SETTING_KEY)) settings.register(MODULE_ID, SETTING_KEY, {
    name: "Select System",
    hint: "Choose the rules mode for this world.",
    scope: "world",
    config: true,
    type: String,
    default: "default",
    onChange: value => {
      Hooks.callAll("vurs-pf2e.systemModeChanged", value);
      // Some system and sheet labels are initialized only once per page.
      // Reload after the saved setting is applied so all mode changes take effect.
      window.location.reload();
    },
    choices: {
      default: "Default",
      "vurs": "Vionheart Universe Roleplaying System",
      "vurs-agnostic": "VURS (Agnostic)"
    }
  });

  if (!registered(NEGATIVE_HP_SETTING_KEY)) settings.register(MODULE_ID, NEGATIVE_HP_SETTING_KEY, {
    name: "Enable Negative HP in Default Mode",
    hint: "When enabled, damage below 0 HP reduces maximum HP in Default mode, as it does in VURS.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => window.location.reload()
  });

  if (!registered(DEFAULT_SKILL_GROUPING_SETTING_KEY)) settings.register(MODULE_ID, DEFAULT_SKILL_GROUPING_SETTING_KEY, {
    name: "Group Skills by Attribute in Default Mode",
    hint: "Organize character skills into the VURS attribute groups when the world uses Default mode.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => window.location.reload()
  });

  if (!registered(DEFAULT_VURS_SKILLS_SETTING_KEY)) settings.register(MODULE_ID, DEFAULT_VURS_SKILLS_SETTING_KEY, {
    name: "Add VURS Skills in Default Mode",
    hint: "Make VURS homebrew skills available when the world uses Default mode.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => window.location.reload()
  });

  if (!registered(DEFAULT_SAVE_SKILLS_SETTING_KEY)) settings.register(MODULE_ID, DEFAULT_SAVE_SKILLS_SETTING_KEY, {
    name: "Add Saves and Perception to Skills in Default Mode",
    hint: "Show Fortitude, Reflex, Will, and Perception in the Skills tab, using their matching statistics.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => window.location.reload()
  });
}

// Module scripts normally register settings during init. Keep guarded later
// hooks as a fallback for worlds where the module is activated or reloaded
// after that hook has already fired.
registerModuleSettings();
Hooks.once("init", registerModuleSettings);
Hooks.once("setup", registerModuleSettings);
Hooks.once("ready", registerModuleSettings);

