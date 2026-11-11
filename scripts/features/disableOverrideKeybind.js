import {
	areDisabledFeaturesEnforced,
	setVursDisableUiBypass
} from "./disableConditions.js";
import { refreshVursDisableLocks } from "../generalChanges.js";
import { refreshVursHudDisableLocks } from "./pf2eHud.js";

const MODULE_ID = "vurs-pf2e";

let bypassHeld = false;
let refreshScheduled = false;

function refreshAllDisableLocks() {
	if (refreshScheduled) return;
	refreshScheduled = true;
	requestAnimationFrame(() => {
		refreshScheduled = false;
		refreshVursDisableLocks();
		refreshVursHudDisableLocks();
	});
}

function syncUnenforcedBodyClass() {
	// While the bypass is held the body carries the same class the
	// unenforced setting uses, so disabled content reveals on hover. On
	// release it falls back to the setting-driven value.
	document.body?.classList.toggle(
		"vurs-disabled-features-unenforced",
		bypassHeld || !areDisabledFeaturesEnforced()
	);
}

function setBypass(active) {
	if (bypassHeld === active) return;
	bypassHeld = active;
	setVursDisableUiBypass(active);
	// vurs-disable-bypass fully reveals pf2e-hud disables while held (no hover
	// needed); the unenforced class keeps the setting-driven hover reveal on
	// sheets and falls back to the enforcement setting on release.
	document.body?.classList.toggle("vurs-disable-bypass", active);
	syncUnenforcedBodyClass();
	refreshAllDisableLocks();
}

Hooks.once("init", () => {
	game.keybindings?.register(MODULE_ID, "vursTemporaryDisableUnlock", {
		name: "VURS: Temporarily Lift Disabled-Feature Locks",
		hint: "While held, condition disables do not lock character sheets or the pf2e-hud. Item rules are unaffected.",
		editable: [
			{ key: "AltLeft", modifiers: [] },
			{ key: "AltRight", modifiers: [] }
		],
		onDown: () => {
			setBypass(true);
			return true;
		},
		onUp: () => {
			setBypass(false);
			return true;
		}
	});
});

// A missed keyup (alt-tab, OS-level Alt interception) would leave the bypass
// stuck on — release it whenever the window loses focus.
window.addEventListener("blur", () => setBypass(false));
