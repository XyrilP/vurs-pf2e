import { getRateOfFire, handleBurstFireHudClick, isAutomaticStrike } from "./burstFire.js";
import { getAutomaticAreaCollateralTrait } from "./collateralDamage.js";
import { renderVursPlayResourcesHudPanel } from "./playResources.js";
import { actorUsesVursHpRules } from "./systemModes.js";
import { getVursBaseMaxHp, getVursMaxHpReduction } from "./vursHp.js";
import { applyVursHudDisableStates } from "./pf2eHudDisables.js";

const HUD_MODULE_ID = "pf2e-hud";
const hudRootsWithBurstFireHandlers = new WeakSet();
const hudRootsWithScheduledRefresh = new WeakSet();
const hudActors = new WeakMap();

function getHudActor(app) {
	return [
		app?.actor,
		app?.document?.actor,
		app?.document,
		app?.object,
		app?.options?.actor,
		// The actions/spells/feats sidebar is a child ApplicationV2 of the HUD;
		// its actor lives on the parent app.
		app?.parent?.actor,
		app?.parent?.document?.actor,
		app?.parent?.object
	].find(actor =>
		actor?.isOfType?.("character") ||
		actor?.isOfType?.("npc") ||
		actor?.type === "character" ||
		actor?.type === "npc"
	);
}

function getHudRoot(app, element) {
	const root = app?.element instanceof HTMLElement ? app.element : element;
	if (!(root instanceof HTMLElement)) return null;
	return root.matches(".pf2e-hud-element")
		? root
		: root.querySelector(".pf2e-hud-element");
}

const hudActorUuidCache = new Map();
const hudElementApps = new WeakMap();

function actorFromHudUuid(uuid) {
	if (hudActorUuidCache.has(uuid)) return hudActorUuidCache.get(uuid);
	const actor = game.actors?.find(candidate => candidate.uuid === uuid) ?? null;
	if (actor) hudActorUuidCache.set(uuid, actor);
	return actor;
}

// Resolve the actor behind any .pf2e-hud-element (main HUDs, sidebar, popups).
// Falls back to the owning ApplicationV2 instance so elements that never went
// through our render hook (e.g. a sidebar opened before this module loaded)
// still resolve via app.parent.actor.
function resolveHudActor(root) {
	let actor = hudActors.get(root);
	if (actor) return actor;
	const uuid = root?.dataset?.vursHudActorUuid;
	if (uuid) actor = actorFromHudUuid(uuid);
	if (!actor) {
		let app;
		if (hudElementApps.has(root)) {
			app = hudElementApps.get(root);
		} else {
			for (const candidate of foundry.applications?.instances?.values?.() ?? []) {
				if (candidate?.element === root || candidate?.element?.contains?.(root)) {
					app = candidate;
					break;
				}
			}
			hudElementApps.set(root, app ?? null);
		}
		actor = app ? getHudActor(app) : null;
	}
	if (actor) {
		hudActors.set(root, actor);
		if (root.dataset) root.dataset.vursHudActorUuid = actor.uuid;
	}
	return actor;
}

const hudRootsWithDisableObservers = new WeakSet();

// pf2e-hud swaps sidebar/panel innerHTML without a full renderApplicationV2
// (sidebar switching, filtering), which would wipe injected state — mirror the
// sheet's own MutationObserver re-application for those cases.
function observeHudDisableStates(root) {
	if (hudRootsWithDisableObservers.has(root)) return;
	hudRootsWithDisableObservers.add(root);
	let scheduled = false;
	const observer = new MutationObserver(() => {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			if (!root.isConnected) {
				observer.disconnect();
				hudRootsWithDisableObservers.delete(root);
				return;
			}
			const actor = resolveHudActor(root);
			if (actor) applyVursHudDisableStates(root, actor);
		});
	});
	observer.observe(root, { childList: true, subtree: true });
}

// pf2e-hud clamps its number inputs to [data-min, max] with data-min hardcoded
// to 0, and it captures those bounds when it attaches listeners — so the only
// reliable way to let HP go negative is to intercept wheel/blur in the capture
// phase before its handlers run. We clamp the top at hp.max and allow the value
// below zero so the overflow becomes the VURS max-HP reduction.
function isHudHpInput(element, actor) {
	if (!(element instanceof HTMLInputElement) || !element.classList.contains("text-number")) return false;
	const name = element.getAttribute("name") || "";
	return foundry.utils.getProperty(actor, name) === actor?.system?.attributes?.hp ||
		name === "system.attributes.hp" || name === "system.attributes.hp.value";
}

function hudHpBounds(actor) {
	const hp = actor?.system?.attributes?.hp;
	const max = Math.max(0, Number(hp?.max) || 0);
	return {
		min: -(Number(hp?.value) || 0) - max,
		max
	};
}

function allowNegativeHudHpInput(root) {
	if (root.dataset.vursHudHpWired) return;
	root.dataset.vursHudHpWired = "true";
	// Resolve the actor at event time so a HUD actor/mode switch can't leave a
	// stale closure committing to the wrong actor. Non-VURS actors return early
	// WITHOUT intercepting, so pf2e-hud's native [0, max] handler still runs.
	const actorFor = () => {
		const actor = hudActors.get(root);
		return actorUsesVursHpRules(actor) ? actor : null;
	};
	const commit = (actor, value) => actor.update({ "system.attributes.hp.value": value });
	// Wheel only edits the displayed absolute value while the field is focused;
	// blur commits it (matching pf2e-hud). Flag wheel edits so a negative result
	// is read as absolute HP rather than a typed +/- delta. The top is always
	// clamped to the effective hp.max — it can never scroll past max.
	root.addEventListener("wheel", event => {
		const actor = actorFor();
		const field = event.target;
		if (!actor || !isHudHpInput(field, actor) || event.deltaY === 0 ||
			document.activeElement !== field) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const { min, max } = hudHpBounds(actor);
		const next = Math.min(Math.max((Number(field.value) || 0) + Math.sign(-1 * event.deltaY), min), max);
		field.dataset.vursHudWheel = "true";
		field.value = String(next);
	}, true);
	root.addEventListener("input", event => {
		const actor = actorFor();
		const field = event.target;
		if (actor && isHudHpInput(field, actor)) field.dataset.vursHudWheel = "";
	}, true);
	root.addEventListener("blur", event => {
		const actor = actorFor();
		const field = event.target;
		if (!actor || !isHudHpInput(field, actor)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const { min, max } = hudHpBounds(actor);
		const wheelAbsolute = field.dataset.vursHudWheel === "true";
		field.dataset.vursHudWheel = "";
		const raw = (field.value || "").trim();
		const entered = Number(raw);
		const current = Number(actor.system?.attributes?.hp?.value) || 0;
		const reset = () => { field.value = String(current); };
		if (!Number.isFinite(entered)) { reset(); return; }
		const signed = !wheelAbsolute && (raw.startsWith("+") || raw.startsWith("-"));
		const result = Math.min(Math.max(wheelAbsolute || !signed ? Math.trunc(entered) : current + Math.trunc(entered), min), max);
		// Skip the update entirely when nothing changed — pf2e-hud does the same
		// (z===g), and an unconditional actor.update triggers a full re-prepare
		// and every updateActor/render hook, which is the source of the lag.
		if (result === current) { field.value = String(current); return; }
		field.value = String(result);
		commit(actor, result).catch(() => reset());
	}, true);
}

const formatHudMaxAdjustment = adjustment =>
	adjustment > 0 ? `-${adjustment}` : adjustment < 0 ? `+${Math.abs(adjustment)}` : "";

// Mirrors the actor sheet's addVursMaxHpReductionControl, but targets pf2e-hud's
// HP section directly: [data-section="hp"] .numbers .max shows the effective
// hp.max. Scoped to the HP section so stamina (hp.sp) and temp-HP are untouched.
function addVursHudMaxHpControl(root, actor, retries = 4) {
	if (!actorUsesVursHpRules(actor) || !actor?.system?.attributes?.hp) return;
	const section = root.querySelector('[data-section="hp"]');
	const maxElement = section?.querySelector(".numbers .max") ?? null;
	if (!section?.isConnected || !maxElement) {
		if (retries > 0 && root.isConnected) {
			requestAnimationFrame(() => addVursHudMaxHpControl(root, actor, retries - 1));
		}
		return;
	}
	if (section.querySelector(".vurs-max-hp-edit")) return;
	const hp = actor.system.attributes.hp;
	if (!Number.isFinite(hp?.max)) return;

	const displayedMax = String(hp.max);
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
	valueEditor.style.cssText = "cursor:text;outline:none;display:inline-block;min-width:1ch;";
	valueEditor.textContent = displayedMax;
	maxElement.style.position ||= "relative";
	maxElement.replaceChildren(valueEditor);
	const indicator = document.createElement("span");
	indicator.className = "vurs-max-hp-reduction-indicator";
	indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatHudMaxAdjustment(currentAdjustment) || "none"}`);
	indicator.textContent = formatHudMaxAdjustment(currentAdjustment);
	indicator.style.cssText = "position:absolute;top:auto;left:auto;right:-0.35em;bottom:-0.55em;display:block;width:2.2em;padding:0;color:inherit;background:transparent;border:0;border-radius:0;font:inherit;font-size:0.55em;line-height:1.3;text-align:right;white-space:nowrap;z-index:1;pointer-events:none;";
	maxElement.append(indicator);

	const updateEditIndicator = value => {
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		const baseMax = getVursBaseMaxHp(actor);
		const desiredMax = Math.max(0, Number.isFinite(value) ? Math.trunc(value) : effectiveMax || Number(hp.max));
		const adjustment = baseMax - desiredMax;
		indicator.textContent = formatHudMaxAdjustment(adjustment);
		indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatHudMaxAdjustment(adjustment) || "none"}`);
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
		// that absolute value by one; typing a number sets it directly. The small
		// indicator shows the resulting signed adjustment.
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
		const effectiveMax = Number(actor.system?.attributes?.hp?.max);
		const baseMax = getVursBaseMaxHp(actor);
		const enteredMaximum = Number(valueEditor.textContent.trim());
		const desiredMax = Math.max(0, Number.isFinite(enteredMaximum) ? Math.trunc(enteredMaximum) : effectiveMax || Number(hp.max));
		const adjustment = baseMax - desiredMax;
		valueEditor.textContent = String(desiredMax);
		valueEditor.setAttribute("aria-valuenow", String(desiredMax));
		updateEditIndicator(desiredMax);
		try {
			await actor.update({ "flags.vurs.hp.maxReduction": adjustment });
		} catch (error) {
			console.error(`${HUD_MODULE_ID} | Failed to update VURS maximum HP`, error);
			ui.notifications?.error("Could not update maximum HP.");
			showMaximum();
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

function onHudClick(event, app, root) {
	if (!(event.target instanceof Element)) return;
	const target = event.target.closest('[data-action="strike-attack"]');
	if (!target || !root.contains(target)) return;
	const actor = getHudActor(app)
		?? game.actors?.get(root.dataset.vursHudActorUuid);
	if (actor) handleBurstFireHudClick(event, actor, target, root);
}

function createBurstFireHudIcon() {
	const icon = document.createElement("img");
	icon.className = "alt-usage-icon auto-fire vurs-burst-fire-icon";
	icon.src = "systems/pf2e/assets/icons/striking-balls.svg";
	icon.alt = "";
	return icon;
}

function formatHudBurstFireLabel(root, actor) {
	for (const strikeElement of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
		const strike = actor.system?.actions?.find(action => action.item?.id === strikeElement.dataset.itemId);
		if (!strike) continue;

		const isPrepared = Boolean(strikeElement.querySelector(".vurs-burst-fire-armed"));
		strikeElement.classList.toggle(
			"vurs-area-strike-hidden",
			!isPrepared && Boolean(getAutomaticAreaCollateralTrait(strike.item))
		);

		const autoFireIndex = strike.altUsages?.findIndex(usage => usage.type === "auto-fire") ?? -1;
		const burstFireIndex = strike.altUsages?.findIndex(usage => usage.type === "burst-fire") ?? -1;
		if (autoFireIndex >= 0 && burstFireIndex >= 0) {
			const autoFireCategory = strikeElement
				.querySelector(`[data-alt-usage="${autoFireIndex}"]`)
				?.closest(".variants")
				?.querySelector(":scope > .category");
			const burstFireButton = strikeElement.querySelector(
				`[data-alt-usage="${burstFireIndex}"][data-action="strike-attack"]`
			);
			const burstFireCategory = burstFireButton
				?.closest(".variants")
				?.querySelector(":scope > .category");
			if (autoFireCategory && burstFireCategory) {
				burstFireCategory.replaceWith(autoFireCategory.cloneNode(true));
			}
		}

		for (const button of strikeElement.querySelectorAll('[data-action="strike-attack"][data-alt-usage]')) {
			const altUsage = strike.altUsages?.[Number(button.dataset.altUsage)];
			if (altUsage?.type !== "burst-fire") continue;
			const variantIndex = Number(button.dataset.variantIndex ?? 0);
			const variant = altUsage.variants?.[variantIndex];
			if (!variant?.label) continue;
			const rateOfFire = getRateOfFire(actor, strike) ?? 0;
			const rateLabel = game.i18n.format("VURS.BurstFire.RateOfFireShort", {
				shots: rateOfFire
			});
			const actionGlyph = document.createElement("span");
			actionGlyph.className = "action-glyph";
			actionGlyph.textContent = "2";
			button.classList.add("vurs-burst-fire-trigger");
			button.replaceChildren(
				actionGlyph,
				document.createTextNode(` Burst-Fire (${rateLabel})`)
			);
			button.setAttribute(
				"aria-label",
				`2 AP Burst-Fire (${rateLabel}) — ${strike.item.name}`
			);
			const category = button.closest(".variants")
				?.querySelector(":scope > .category");
			if (category && !category.querySelector("img.vurs-burst-fire-icon")) {
				category.replaceChildren(createBurstFireHudIcon());
			}
		}

		const hasBurstFireUsage = strike.altUsages?.some(usage => usage.type === "burst-fire");
		if (!hasBurstFireUsage && isAutomaticStrike(strike)) {
			if (!strikeElement.querySelector(".vurs-burst-fire-trigger[data-vurs-synthetic]")) {
				const rateOfFire = getRateOfFire(actor, strike) ?? 0;
				const rateLabel = game.i18n.format("VURS.BurstFire.RateOfFireShort", {
					shots: rateOfFire
				});
				const button = document.createElement("div");
				button.className = "variant attack vurs-burst-fire-trigger";
				button.dataset.action = "strike-attack";
				button.dataset.variantIndex = "0";
				button.dataset.vursSynthetic = "true";
				const actionGlyph = document.createElement("span");
				actionGlyph.className = "action-glyph";
				actionGlyph.textContent = "2";
				button.append(
					actionGlyph,
					document.createTextNode(` Burst-Fire (${rateLabel})`)
				);
				button.setAttribute(
					"aria-label",
					`2 AP Burst-Fire (${rateLabel}) — ${strike.item.name}`
				);
				const category = document.createElement("span");
				category.className = "category";
				category.append(createBurstFireHudIcon());
				const mainVariants = [...strikeElement.querySelectorAll(":scope > .variants")]
					.find(group => group.querySelector('[data-action="strike-attack"]:not([data-alt-usage])'));
				if (mainVariants) {
					const row = document.createElement("div");
					row.className = "variants vurs-burst-fire-row";
					row.append(category, button);
					mainVariants.after(row);
				}
			}
		}
	}
}

Hooks.on("renderApplicationV2", (app, element) => {
	if (!game.modules.get(HUD_MODULE_ID)?.active) return;
	const root = getHudRoot(app, element);
	if (!root) return;

	const actor = resolveHudActor(root);
	if (actor) {
		formatHudBurstFireLabel(root, actor);
		allowNegativeHudHpInput(root);
		requestAnimationFrame(() => {
			addVursHudMaxHpControl(root, actor);
			applyVursHudDisableStates(root, actor);
		});
		observeHudDisableStates(root);
	}
	if (root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") {
		renderVursPlayResourcesHudPanel(root, actor);
	}

	if (hudRootsWithBurstFireHandlers.has(root)) return;
	hudRootsWithBurstFireHandlers.add(root);
	root.addEventListener("click", event => onHudClick(event, app, root), true);
});

Hooks.on("updateActor", actor => {
	for (const root of document.querySelectorAll(".pf2e-hud-element")) {
		const hudActor = resolveHudActor(root);
		if (hudActor?.uuid !== actor.uuid) continue;
		formatHudBurstFireLabel(root, hudActor);
		allowNegativeHudHpInput(root);
		requestAnimationFrame(() => {
			addVursHudMaxHpControl(root, hudActor);
			applyVursHudDisableStates(root, hudActor);
		});
		observeHudDisableStates(root);
		if ((root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") &&
			!hudRootsWithScheduledRefresh.has(root)) {
			hudRootsWithScheduledRefresh.add(root);
			requestAnimationFrame(() => {
				hudRootsWithScheduledRefresh.delete(root);
				if (!root.isConnected) return;
				renderVursPlayResourcesHudPanel(root, hudActor, { refresh: true });
			});
		}
	}
});
