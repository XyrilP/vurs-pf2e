const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "Select System",
    hint: "Choose the rules mode for this world.",
    scope: "world",
    config: true,
    type: String,
    default: "default",
    choices: {
      default: "Default",
      "vurs": "Vionheart Universe Roleplaying System",
      "vurs-agnostic": "VURS (Agnostic)"
    }
  });
});
