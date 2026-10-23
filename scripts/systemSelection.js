const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";
const NEGATIVE_HP_SETTING_KEY = "negativeHpInDefault";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
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

  game.settings.register(MODULE_ID, NEGATIVE_HP_SETTING_KEY, {
    name: "Enable Negative HP in Default Mode",
    hint: "When enabled, damage below 0 HP reduces maximum HP in Default mode, as it does in VURS.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => window.location.reload()
  });
});

