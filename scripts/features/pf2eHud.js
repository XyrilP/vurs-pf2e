import { getRateOfFire, handleBurstFireHudClick } from "./burstFire.js";
import { renderVursPlayResourcesHudPanel } from "./playResources.js";

const HUD_MODULE_ID = "pf2e-hud";
const hudRootsWithBurstFireHandlers = new WeakSet();

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

function onHudClick(event, app, root) {
	if (!(event.target instanceof Element)) return;
	const target = event.target.closest('[data-action="strike-attack"]');
	if (!target || !root.contains(target)) return;
	const actor = getHudActor(app)
		?? game.actors?.get(root.dataset.vursHudActorUuid);
	if (actor) handleBurstFireHudClick(event, actor, target, root);
}

function formatHudBurstFireLabel(root, actor) {
	for (const strikeElement of root.querySelectorAll(".item.attack[data-index][data-item-id]")) {
		const strike = actor.system?.actions?.find(action => action.item?.id === strikeElement.dataset.itemId);
		if (!strike) continue;

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
			button.replaceChildren(
				actionGlyph,
				document.createTextNode(` Burst-Fire (${rateLabel})`)
			);
			button.setAttribute(
				"aria-label",
				`2 AP Burst-Fire (${rateLabel}) — ${strike.item.name}`
			);
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
		if (root.id === "pf2e-hud-persistent" || root.id === "pf2e-hud-token") {
			renderVursPlayResourcesHudPanel(root, actor, { refresh: true });
		}
	}
});
