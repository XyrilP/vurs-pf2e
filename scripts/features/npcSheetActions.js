const MODULE_ID = "vurs-pf2e";
const NPC_SHEET_CLASS = "pf2e.NPCSheetPF2e";
const ABILITY_SLUGS = new Set(["str", "dex", "con", "int", "wis", "cha"]);

export function addNpcRestButton(root, actor) {
	root = root instanceof HTMLElement ? root : root?.[0];
	if (!root || actor?.type !== "npc" || root.querySelector('[data-action="rest"]')) return;

	const healthHeader = root.querySelector(".subsection.health > header");
	if (!healthHeader) return;

	const button = document.createElement("a");
	button.className = "roll-icon rest vurs-npc-rest-button";
	button.dataset.action = "rest";
	button.dataset.tooltip = "PF2E.Actor.Character.Rest.Label";
	button.setAttribute("aria-label", game.i18n.localize("PF2E.Actor.Character.Rest.Label"));
	button.innerHTML = '<i class="fa-solid fa-bed"></i>';
	healthHeader.append(button);
}

export function installNpcSheetActions() {
	if (game.system.id !== "pf2e") return;

	const sheetClass = CONFIG.Actor.sheetClasses?.npc?.[NPC_SHEET_CLASS]?.cls;
	const prototype = sheetClass?.prototype;
	const original = prototype?.activateClickListener;
	if (typeof original !== "function") {
		console.error(`${MODULE_ID} | Could not install NPC sheet actions: PF2E NPC sheet click handler is unavailable`);
		return;
	}

	if (prototype.__vursNpcSheetActions) return;
	prototype.activateClickListener = function (...args) {
		const actions = original.apply(this, args);
		actions["roll-attribute"] = (event, element) => rollNpcAttributeCheck(this, event, element);
		actions.rest = () => restNpcForTheNight(this.actor);
		return actions;
	};
	Object.defineProperty(prototype, "__vursNpcSheetActions", { value: true });
}

function rollNpcAttributeCheck(sheet, event, element) {
	const actor = sheet.actor;
	const attribute = element?.parentElement?.dataset.attribute;
	const modifierValue = actor.system?.abilities?.[attribute]?.mod;
	const { Check, CheckModifier, Modifier } = game.pf2e ?? {};
	if (
		!ABILITY_SLUGS.has(attribute) ||
		typeof modifierValue !== "number" ||
		typeof Check?.roll !== "function" ||
		typeof CheckModifier !== "function" ||
		typeof Modifier !== "function"
	) {
		console.error(`${MODULE_ID} | Could not roll NPC attribute check: PF2E check data or API is unavailable`);
		return null;
	}

	const label = game.i18n.localize(`PF2E.AbilityCheck.${attribute}`);
	const modifier = new Modifier({
		slug: `ability-${attribute}`,
		label: `PF2E.Ability${attribute[0].toUpperCase()}${attribute.slice(1)}`,
		modifier: modifierValue,
		type: "ability",
		ability: attribute,
		domains: [`${attribute}-check`]
	});
	const check = new CheckModifier(`${attribute}-check`, { modifiers: [modifier] });
	return Check.roll(check, {
		actor,
		token: sheet.token,
		type: "check",
		title: label,
		identifier: `${attribute}-check`,
		options: new Set([`${attribute}-check`])
	}, event);
}

async function restNpcForTheNight(actor) {
	if (actor?.type !== "npc") return;

	const prompt = game.i18n.localize("PF2E.Action.RestForTheNight.Prompt");
	const confirmed = await foundry.applications.api.DialogV2.confirm({
		window: { title: game.i18n.localize("PF2E.Action.RestForTheNight.Label") },
		content: `<p>${foundry.utils.escapeHTML(prompt)}</p>`,
		yes: { default: true }
	});
	if (!confirmed) return;

	const messages = [];
	const hp = actor.system.attributes.hp;
	const hpValue = Number(hp.value) || 0;
	const hpMax = Number(hp.max) || 0;
	const level = Number(actor.level ?? actor.system.details?.level?.value) || 0;
	const constitution = Number(actor.system.abilities?.con?.mod) || 0;
	const actorUpdates = {};
	const useStamina = game.pf2e.settings.variants.stamina;
	const recoveryMultiplier = Number.isFinite(hp.recoveryMultiplier)
		? hp.recoveryMultiplier
		: 1;
	const recoveryAddend = Number.isFinite(hp.recoveryAddend)
		? hp.recoveryAddend
		: 0;
	const healing = Math.min(
		Math.max(0, hpMax - hpValue),
		Math.max(0, Math.max(constitution, 1) * level * recoveryMultiplier + recoveryAddend)
	);
	if (healing > 0) {
		actorUpdates["system.attributes.hp.value"] = hpValue + healing;
		const key = healing === 1
			? "PF2E.Action.RestForTheNight.Message.HitPointsSingle"
			: "PF2E.Action.RestForTheNight.Message.HitPoints";
		messages.push(game.i18n.format(key, { hitPoints: healing }));
	}
	if (useStamina) {
		const stamina = actor.system.attributes.hp.sp;
		const resolve = actor.system.resources.resolve;
		if (stamina && stamina.value < stamina.max) {
			actorUpdates["system.attributes.hp.sp.value"] = stamina.max;
			messages.push(restMessage("StaminaPoints"));
		}
		if (resolve && resolve.value < resolve.max) {
			actorUpdates["system.resources.resolve.value"] = resolve.max;
			messages.push(restMessage("Resolve"));
		}
	}
	if (actor.flags?.pf2e?.dailyCraftingComplete) {
		actorUpdates["flags.pf2e.dailyCraftingComplete"] = false;
	}
	const infusedReagents = actor.system.resources?.crafting?.infusedReagents;
	if (infusedReagents && infusedReagents.value < infusedReagents.max) {
		actorUpdates["system.resources.crafting.infusedReagents.value"] = infusedReagents.max;
		messages.push(restMessage("InfusedReagents"));
	}
	if (Object.keys(actorUpdates).length > 0) await actor.update(actorUpdates);

	const conditionChanges = {};
	if (actor.hasCondition("fatigued")) {
		await actor.decreaseCondition("fatigued");
		conditionChanges.fatigued = "removed";
	}
	for (const slug of ["doomed", "drained"]) {
		const condition = actor.getCondition(slug);
		if (!condition) continue;
		const value = (condition.value ?? 1) - 1;
		await actor.decreaseCondition(slug);
		conditionChanges[slug] = value <= 0 ? "removed" : "reduced";
	}
	if (actor.hasCondition("wounded") && hpValue + healing >= hpMax) {
		await actor.decreaseCondition("wounded", { forceRemove: true });
		conditionChanges.wounded = "removed";
	}

	const wandUpdates = actor.itemTypes.consumable
		.filter(item => item.category === "wand" && item.uses && item.uses.value < item.uses.max)
		.map(item => ({ _id: item.id, "system.uses.value": item.uses.max }));
	if (wandUpdates.length > 0) {
		await actor.updateEmbeddedDocuments("Item", wandUpdates);
		messages.push(restMessage("WandsCharges"));
	}

	const expiredItems = await actor.inventory.deleteTemporaryItems({ render: false });
	if (expiredItems.length > 0) messages.push(restMessage("TemporaryItems"));

	const recharge = await actor.recharge({ duration: "day" });
	if (recharge.affected.frequencies) messages.push(restMessage("Frequencies"));
	if (recharge.affected.spellSlots) messages.push(restMessage("SpellSlots"));
	for (const slug of recharge.affected.resources) {
		if (slug === "focus") messages.push(restMessage("FocusPoints"));
		else {
			const name = actor.synthetics.resources[slug]?.label;
			if (name) messages.push(game.i18n.format(
				"PF2E.Action.RestForTheNight.Message.Resource",
				{ name: game.i18n.localize(name) }
			));
		}
	}

	const dailyCrafting = actor.crafting?.abilities?.filter(
		ability => ability.isDailyPrep && ability.preparedFormulaData.some(formula => formula.expended)
	) ?? [];
	for (const ability of dailyCrafting) {
		await ability.updateFormulas(
			ability.preparedFormulaData.map(formula => ({ ...formula, expended: false })),
			{ render: false }
		);
	}
	if (dailyCrafting.length > 0) messages.push(restMessage("CraftingSlots"));

	for (const [slug, change] of Object.entries(conditionChanges)) {
		const { name } = game.pf2e.ConditionManager.getCondition(slug);
		const key = change === "removed" ? "ConditionRemoved" : "ConditionReduced";
		messages.push(game.i18n.format(
			`PF2E.Action.RestForTheNight.Message.${key}`,
			{ condition: game.i18n.localize(name) }
		));
	}

	const awakening = document.createElement("p");
	awakening.innerText = game.i18n.format(
		"PF2E.Action.RestForTheNight.Message.Awakens",
		{ actor: actor.name }
	);
	const list = document.createElement("ul");
	for (const message of messages) {
		const item = document.createElement("li");
		item.innerText = message;
		list.append(item);
	}
	Hooks.callAll("pf2e.restForTheNight", actor);
	await ChatMessage.createDocuments([{
		author: game.user.id,
		content: `${awakening.outerHTML}\n${list.outerHTML}`,
		speaker: ChatMessage.getSpeaker({ actor })
	}], { restForTheNight: true });
}

function restMessage(key) {
	return game.i18n.localize(`PF2E.Action.RestForTheNight.Message.${key}`);
}
