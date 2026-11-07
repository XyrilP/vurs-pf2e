import { getRateOfFire, handleBurstFireHudClick, isAutomaticStrike } from "./burstFire.js";
import { getAutomaticAreaCollateralTrait } from "./collateralDamage.js";
import { renderVursPlayResourcesHudPanel } from "./playResources.js";

const HUD_MODULE_ID = "pf2e-hud";
const hudRootsWithBurstFireHandlers = new WeakSet();
const hudRootsWithScheduledRefresh = new WeakSet();

function getHudActor(app) {
	return [
		app?.actor,
		app?.document?.actor,
		app?.document,
		app?.object,
		app?.options?.actor
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
	return {
		min: -(Number(hp?.value) || 0) - (Number(hp?.totalModifier) || Number(hp?.max) || 0),
		max: Math.max(0, Number(hp?.max) || 0)
	};
}

function allowNegativeHudHpInput(root, actor) {
	if (!actor?.system?.attributes?.hp || root.dataset.vursHudHpWired === actor.uuid) return;
	root.dataset.vursHudHpWired = actor.uuid;
	const commit = value => actor.update({ "system.attributes.hp.value": value });
	// Wheel only edits the displayed absolute value while the field is focused;
	// blur commits it (matching pf2e-hud). Flag wheel edits so a negative result
	// is read as absolute HP rather than a typed +/- delta.
	root.addEventListener("wheel", event => {
		const field = event.target;
		if (!isHudHpInput(field, actor) || event.deltaY === 0 || document.activeElement !== field) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const { min, max } = hudHpBounds(actor);
		const next = Math.clamp((Number(field.value) || 0) + Math.sign(-1 * event.deltaY), min, max);
		field.dataset.vursHudWheel = "true";
		field.value = String(next);
	}, true);
	root.addEventListener("input", event => {
		const field = event.target;
		if (isHudHpInput(field, actor)) field.dataset.vursHudWheel = "";
	}, true);
	root.addEventListener("blur", event => {
		const field = event.target;
		if (!isHudHpInput(field, actor)) return;
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
		const result = Math.clamp(wheelAbsolute || !signed ? Math.trunc(entered) : current + Math.trunc(entered), min, max);
		field.value = String(result);
		commit(result).catch(() => reset());
	}, true);
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

	const actor = getHudActor(app)
		?? game.actors?.get(root.dataset.vursHudActorUuid);
	if (actor) {
		root.dataset.vursHudActorUuid = actor.uuid;
		formatHudBurstFireLabel(root, actor);
		allowNegativeHudHpInput(root, actor);
	}
	if (root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") {
		renderVursPlayResourcesHudPanel(root, actor);
	}

	if (hudRootsWithBurstFireHandlers.has(root)) return;
	hudRootsWithBurstFireHandlers.add(root);
	root.addEventListener("click", event => onHudClick(event, app, root), true);
});

Hooks.on("updateActor", actor => {
	for (const root of document.querySelectorAll(".pf2e-hud-element[data-vurs-hud-actor-uuid]")) {
		if (root.dataset.vursHudActorUuid !== actor.uuid) continue;
		formatHudBurstFireLabel(root, actor);
		allowNegativeHudHpInput(root, actor);
		if ((root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") &&
			!hudRootsWithScheduledRefresh.has(root)) {
			hudRootsWithScheduledRefresh.add(root);
			requestAnimationFrame(() => {
				hudRootsWithScheduledRefresh.delete(root);
				if (!root.isConnected) return;
				renderVursPlayResourcesHudPanel(root, actor, { refresh: true });
			});
		}
	}
});
