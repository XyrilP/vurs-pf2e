import { getRateOfFire, handleBurstFireHudClick, isAutomaticStrike, rollBurstFire } from "./burstFire.js";
import { getAutomaticAreaCollateralTrait } from "./collateralDamage.js";
import { renderVursPlayResourcesHudPanel } from "./playResources.js";
import { actorUsesVursHpRules } from "./systemModes.js";
import { getVursBaseMaxHp, getVursMaxHpReduction } from "./vursHp.js";
import { applyVursHudDisableStates } from "./pf2eHudDisables.js";
import { replaceVursTextTokens } from "./vursTextTokens.js";

const HUD_MODULE_ID = "pf2e-hud";
const hudRootsWithBurstFireHandlers = new WeakSet();
const hudRootsWithScheduledRefresh = new WeakSet();
const hudRootsWithScheduledHudRefresh = new WeakSet();
// Each injected max-HP editor's indicator updater, so actor updates can refresh
// the reduction badge without rebuilding the control.
const hudMaxHpIndicatorUpdaters = new WeakMap();

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

const hudElementApps = new WeakMap();

// Resolve the actor behind any .pf2e-hud-element (main HUDs, sidebar, popups).
// The owning ApplicationV2 is cached per element, but the actor itself is
// re-derived on every call — pf2e-hud can reuse a window element for a
// different actor, so caching the actor goes stale. getHudActor is a cheap
// property scan, so freshness costs almost nothing.
function resolveHudActor(root) {
	let app = hudElementApps.get(root);
	if (app === undefined) {
		for (const candidate of foundry.applications?.instances?.values?.() ?? []) {
			if (candidate?.element === root || candidate?.element?.contains?.(root)) {
				app = candidate;
				break;
			}
		}
		// Only cache successful lookups — a null result may just mean the app
		// hasn't registered in instances yet, and caching it would fail forever.
		if (app) hudElementApps.set(root, app);
	}
	const actor = app ? getHudActor(app) : null;
	if (actor && root?.dataset) root.dataset.vursHudActorUuid = actor.uuid;
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
			// The refresh below mutates the observed subtree (burst-fire
			// formatting, max-HP control); pause observation so our own writes
			// don't re-trigger this callback every frame.
			observer.disconnect();
			const actor = resolveHudActor(root);
			if (actor) {
				applyVursHudDisableStates(root, actor);
				formatHudBurstFireLabel(root, actor);
				addVursHudMaxHpControl(root, actor);
				// pf2e-hud swaps panel innerHTML without renderApplicationV2 or an
				// actor update (e.g., token reselection), which wipes the injected
				// Play Resources section — rebuild it when it's gone or stale.
				if (root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") {
					const section = root.querySelector(":scope > .vurs-play-resources-hud");
					const actorUuid = actor.uuid ?? actor.id;
					if (!section || section.dataset.actorUuid !== actorUuid) {
						renderVursPlayResourcesHudPanel(root, actor, { refresh: true });
					}
				}
			}
			observer.observe(root, { childList: true, subtree: true });
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
		const actor = resolveHudActor(root);
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
	const existingEditor = section.querySelector(".vurs-max-hp-edit");
	if (existingEditor) {
		// pf2e-hud patches HP values without re-rendering, so the injected
		// editor survives actor updates — refresh it instead of keeping the
		// stale text/badge captured at injection time. Skip while focused so an
		// in-progress edit is never clobbered.
		if (document.activeElement !== existingEditor) {
			const liveMax = Number(actor.system?.attributes?.hp?.max);
			if (Number.isFinite(liveMax)) {
				const text = String(liveMax);
				if (existingEditor.textContent !== text) existingEditor.textContent = text;
				existingEditor.setAttribute("aria-valuenow", text);
				hudMaxHpIndicatorUpdaters.get(existingEditor)?.(liveMax, actor);
			}
		}
		return;
	}
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
	const indicator = document.createElement("span");
	indicator.className = "vurs-max-hp-reduction-indicator";
	indicator.setAttribute("aria-label", `Maximum HP adjustment: ${formatHudMaxAdjustment(currentAdjustment) || "none"}`);
	indicator.textContent = formatHudMaxAdjustment(currentAdjustment);
	// Absolute tag on the wrapper's bottom-right corner — the wrapper shrink-
	// wraps the digits, so the badge tracks the number rather than the wide
	// .max grid cell.
	indicator.style.cssText = "position:absolute;top:auto;left:auto;right:-1em;bottom:-1em;display:block;padding:0 0.1em;color:#fff;line-height:1.4;white-space:nowrap;pointer-events:none;";
	// The wrapper is the badge's positioned ancestor and stays a SIBLING of the
	// contentEditable editor — textContent writes on the editor must never
	// reach the badge.
	const maxHpWrapper = document.createElement("span");
	maxHpWrapper.style.cssText = "display:inline-block;position:relative;";
	maxHpWrapper.append(valueEditor, indicator);
	maxElement.replaceChildren(maxHpWrapper);
	const editorFontSize = parseFloat(getComputedStyle(valueEditor).fontSize);
	if (Number.isFinite(editorFontSize)) {
		indicator.style.fontSize = `${Math.max(8, editorFontSize - 3)}px`;
	}

	const updateEditIndicator = (value, forActor = actor) => {
		const effectiveMax = Number(forActor.system?.attributes?.hp?.max);
		const baseMax = getVursBaseMaxHp(forActor);
		const desiredMax = Math.max(0, Number.isFinite(value) ? Math.trunc(value) : effectiveMax || Number(hp.max));
		const adjustment = baseMax - desiredMax;
		const adjustmentText = formatHudMaxAdjustment(adjustment);
		if (indicator.textContent !== adjustmentText) indicator.textContent = adjustmentText;
		indicator.setAttribute("aria-label", `Maximum HP adjustment: ${adjustmentText || "none"}`);
		// The badge has its own dark background, so it needs light text — the
		// sheet's dark-red-on-light styling doesn't apply here.
		indicator.style.color = adjustment > 0 ? "#ff8a8a" : "#ffffff";
		indicator.style.webkitTextStroke = "0";
		indicator.style.textShadow = "none";
	};
	updateEditIndicator(Number(hp.max));
	hudMaxHpIndicatorUpdaters.set(valueEditor, updateEditIndicator);

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
	const shortcut = event.target.closest(".shortcut[data-type='strike']");
	if (shortcut && root.contains(shortcut)) {
		const shortcutActor = getHudActor(app) ?? resolveHudActor(root);
		if (shortcutActor && handleBurstFireShortcutClick(event, shortcutActor, shortcut)) return;
	}
	const target = event.target.closest('[data-action="strike-attack"]');
	if (!target || !root.contains(target)) return;
	const actor = getHudActor(app) ?? resolveHudActor(root);
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
	// The burst-fire pass below is the expensive part (alt-usage lookups and
	// nested button queries per strike). Most actors have no burst-fire
	// usages, so skip it entirely — the area-strike hiding still needs the
	// outer loop and runs regardless.
	const hasBurstFireUsage = actor.system?.actions?.some(action =>
		action?.altUsages?.some(usage => usage?.type === "burst-fire" || usage?.type === "auto-fire"));
	for (const strikeElement of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
		const strike = actor.system?.actions?.find(action => action.item?.id === strikeElement.dataset.itemId);
		if (!strike) continue;

		const isPrepared = Boolean(strikeElement.querySelector(".vurs-burst-fire-armed"));
		strikeElement.classList.toggle(
			"vurs-area-strike-hidden",
			!isPrepared && Boolean(getAutomaticAreaCollateralTrait(strike.item))
		);
		// Automatic strikes get a synthetic burst-fire button even without a
		// burst-fire alt usage, so they must pass the gate too.
		if (!hasBurstFireUsage && !isAutomaticStrike(strike)) continue;

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
			if (autoFireCategory && burstFireCategory && !burstFireCategory.isEqualNode(autoFireCategory)) {
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
			const ariaLabel = `2 AP Burst-Fire (${rateLabel}) — ${strike.item.name}`;
			// Skip the rewrite when this button is already formatted — the pass
			// runs on every actor update and replaceChildren would otherwise
			// destroy transient pf2e-hud UI state each time.
			if (button.dataset.vursBurstFireLabel === ariaLabel && button.querySelector(".action-glyph")) continue;
			const actionGlyph = document.createElement("span");
			actionGlyph.className = "action-glyph";
			actionGlyph.textContent = "2";
			button.classList.add("vurs-burst-fire-trigger");
			button.dataset.vursBurstFireLabel = ariaLabel;
			button.replaceChildren(
				actionGlyph,
				document.createTextNode(` Burst-Fire (${rateLabel})`)
			);
			button.setAttribute("aria-label", ariaLabel);
			const category = button.closest(".variants")
				?.querySelector(":scope > .category");
			if (category && !category.querySelector("img.vurs-burst-fire-icon")) {
				category.replaceChildren(createBurstFireHudIcon());
			}
		}

		const strikeHasBurstFireUsage = strike.altUsages?.some(usage => usage.type === "burst-fire");
		if (!strikeHasBurstFireUsage && isAutomaticStrike(strike)) {
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

function getShortcutStrike(actor, slot) {
	const itemId = slot?.dataset?.itemId;
	return actor?.system?.actions?.find(action => action.item?.id === itemId) ?? null;
}

const PF2E_HUD_RADIAL_TEMPLATE = "modules/pf2e-hud/templates/shortcuts/radial.hbs";

// Replicates pf2e-hud's shortcut radialMenu() so automatic+area strike
// shortcuts get the same menu style as normal Melee/Ranged strikes.
async function showShortcutRadialMenu(slot, sections, onSelect) {
	const html = await foundry.applications.handlebars.renderTemplate(
		PF2E_HUD_RADIAL_TEMPLATE,
		{ sections }
	);
	if (!slot.isConnected) return;
	const panel = document.createElement("div");
	panel.className = "pf2e-hud-element";
	panel.id = "pf2e-hud-radial-panel";
	panel.innerHTML = html;
	panel.style.setProperty("--columns", String(sections.length));
	document.body.appendChild(panel);
	const slotRect = slot.getBoundingClientRect();
	const panelRect = panel.getBoundingClientRect();
	panel.style.left = `${slotRect.left + slotRect.width / 2 - panelRect.width / 2}px`;
	const above = slotRect.top - panelRect.height - 6;
	panel.style.top = `${above >= 0 ? above : slotRect.bottom + 6}px`;
	const close = () => panel.remove();
	panel.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		const option = event.target.closest(".option");
		close();
		if (option && !option.classList.contains("selected") && option.dataset.value !== undefined) {
			onSelect(option.dataset.value, event);
		}
	});
	panel.addEventListener("contextmenu", event => {
		event.preventDefault();
		event.stopPropagation();
	});
	panel.addEventListener("auxclick", event => {
		event.preventDefault();
		event.stopPropagation();
	});
	panel.addEventListener("mouseleave", close);
}

function getShortcutRangeTitle(item) {
	return item?.isMelee
		? "PF2E.WeaponRangeMelee"
		: item?.isThrown
			? "PF2E.TraitThrown"
			: "PF2E.NPCAttackRanged";
}

// Mirrors pf2e-hud's strike radial labels: variant 0 gets the "Strike" label
// plus glyph and a shortened variant label (NPC labels are two words like
// "Strike +23"), while MAP variants keep their full "+18 (MAP -5)" text.
function getShortcutVariantLabel(actor, variant, index = 0) {
	const label = String(variant?.label ?? "");
	if (index > 0) return label;
	const short = actor.isOfType?.("npc") ? label.split(" ")[1] ?? label : label;
	const glyph = globalThis.Handlebars?.helpers?.actionGlyph?.(1) ?? "";
	return `${game.i18n.localize("PF2E.WeaponStrikeLabel")} ${glyph} ${short}`
		.replace(/\s+/g, " ")
		.trim();
}

// Second-stage radial: the strike's MAP variants for Burst-Fire.
async function showShortcutBurstFireVariantRadial(slot, actor, strike, event) {
	const sections = [{
		title: getShortcutRangeTitle(strike.item),
		options: (strike.variants ?? []).map((variant, index) => ({
			value: String(index),
			label: getShortcutVariantLabel(actor, variant, index)
		}))
	}];
	await showShortcutRadialMenu(slot, sections, (value, selectEvent) => {
		void rollBurstFire(actor, strike, Number(value), { event: selectEvent ?? event })
			.catch(error => {
				console.error(`${HUD_MODULE_ID} | Could not roll Burst-Fire from shortcut for ${strike.item.name}`, error);
				ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.RollFailed"));
			});
	});
}

// Automatic strike shortcuts can't use pf2e-hud's own radial: it iterates
// altUsages assuming three variants each, but the injected burst-fire usage
// has one. Rebuild the same-style menu ourselves — normal strike variants
// plus auto-fire alongside a Burst-Fire section. Automatic+Area weapons are
// burst-fire-only, so their strike section is omitted entirely.
async function showShortcutAutomaticRadial(slot, actor, strike, event) {
	const isAreaOnly = Boolean(getAutomaticAreaCollateralTrait(strike.item));
	const sections = [];
	if (!isAreaOnly) {
		sections.push({
			title: getShortcutRangeTitle(strike.item),
			options: (strike.variants ?? []).map((variant, index) => ({
				value: `strike-${index}`,
				label: getShortcutVariantLabel(actor, variant, index)
			}))
		});
		const autoFire = strike.altUsages?.find(usage => usage.type === "auto-fire");
		if (autoFire?.variants?.length) {
			sections.push({
				title: autoFire.label ?? "Auto-Fire",
				options: autoFire.variants.map((variant, index) => ({
					value: `auto-fire-${index}`,
					label: getShortcutVariantLabel(actor, variant, index)
				}))
			});
		}
	}
	const rateOfFire = getRateOfFire(actor, strike) ?? 0;
	const rateLabel = game.i18n.format("VURS.BurstFire.RateOfFireShort", { shots: rateOfFire });
	const burstFireTitle = game.i18n.localize("VURS.BurstFire.Title");
	const actionGlyph = globalThis.Handlebars?.helpers?.actionGlyph?.(2) ?? "2";
	sections.push({
		title: burstFireTitle,
		options: [{
			value: "burst",
			label: `${burstFireTitle} ${actionGlyph} (${rateLabel})`
		}]
	});
	await showShortcutRadialMenu(slot, sections, async (value, selectEvent) => {
		if (value === "burst") {
			if (slot.isConnected) await showShortcutBurstFireVariantRadial(slot, actor, strike, event);
			return;
		}
		const separator = value.lastIndexOf("-");
		const kind = value.slice(0, separator);
		const index = Number(value.slice(separator + 1));
		const rollTarget = kind === "strike"
			? strike
			: strike.altUsages?.find(usage => usage.type === kind);
		const variant = rollTarget?.variants?.[index];
		if (!variant?.roll) return;
		try {
			await variant.roll({ event: selectEvent ?? event });
		} catch (error) {
			console.error(`${HUD_MODULE_ID} | Shortcut strike roll failed for ${strike.item.name}`, error);
		}
	});
}

function handleBurstFireShortcutClick(event, actor, slot) {
	const strike = getShortcutStrike(actor, slot);
	if (!strike || !isAutomaticStrike(strike)) return false;
	event.preventDefault();
	event.stopImmediatePropagation();
	void showShortcutAutomaticRadial(slot, actor, strike, event);
	return true;
}

Hooks.on("renderApplicationV2", (app, element) => {
	if (!game.modules.get(HUD_MODULE_ID)?.active) return;
	// pf2e-hud popups (item summaries, NPC notes, text popups) render enriched
	// HTML outside actor sheets — resolve VURS text tokens there too.
	const popupActor = app?.actor;
	if (popupActor && element instanceof HTMLElement) {
		if (element.querySelector(".item-summary")) {
			replaceVursTextTokens(element, popupActor, app.item ?? null);
		} else if (element.querySelector(".text-content")) {
			replaceVursTextTokens(element, popupActor);
		}
	}
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

// Re-runs disable states on every open pf2e-hud element. Used by the hold-key
// disable bypass (disableOverrideKeybind.js) so inert/labels recompute the
// moment the bypass engages or releases.
export function refreshVursHudDisableLocks() {
	if (!game.modules.get(HUD_MODULE_ID)?.active) return;
	for (const root of document.querySelectorAll(".pf2e-hud-element")) {
		const actor = resolveHudActor(root);
		if (actor) applyVursHudDisableStates(root, actor);
	}
}

Hooks.on("updateActor", actor => {
	if (!game.modules.get(HUD_MODULE_ID)?.active) return;
	for (const root of document.querySelectorAll(".pf2e-hud-element")) {
		const hudActor = resolveHudActor(root);
		if (hudActor?.uuid !== actor.uuid) continue;
		observeHudDisableStates(root);
		// Coalesce the heavy DOM work (burst-fire formatting, HP input wiring,
		// max-HP control, disable states) into one rAF per root — actor updates
		// are frequent during combat and this used to run synchronously.
		if (!hudRootsWithScheduledHudRefresh.has(root)) {
			hudRootsWithScheduledHudRefresh.add(root);
			requestAnimationFrame(() => {
				hudRootsWithScheduledHudRefresh.delete(root);
				if (!root.isConnected) return;
				formatHudBurstFireLabel(root, hudActor);
				allowNegativeHudHpInput(root);
				addVursHudMaxHpControl(root, hudActor);
				applyVursHudDisableStates(root, hudActor);
			});
		}
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
