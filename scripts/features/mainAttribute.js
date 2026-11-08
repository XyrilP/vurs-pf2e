import { actorUsesMainAttribute } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const MAIN_ATTRIBUTE_FLAG = "flags.vurs.mainAttribute";
const MAIN_ATTRIBUTE_SLUGS = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const MAIN_ATTRIBUTE_ABILITY_DOMAIN = new RegExp(
	`^(?:${[...MAIN_ATTRIBUTE_SLUGS].join("|")})-(?:attack|based)$`
);
const MAIN_ATTRIBUTE_LABELS = Object.freeze({
	str: "PF2E.AbilityStr",
	dex: "PF2E.AbilityDex",
	con: "PF2E.AbilityCon",
	int: "PF2E.AbilityInt",
	wis: "PF2E.AbilityWis",
	cha: "PF2E.AbilityCha"
});
const MAIN_ATTRIBUTE_TRANSLATIONS = Object.freeze({
	Label: "Main Attribute",
	ChooseHint: "Choose one attribute",
	StrikeHint: "This attribute is used for Strike attacks and damage."
});

function registerMainAttributeLocalization() {
	const translations = game.i18n?.translations;
	if (!translations) return;

	for (const [key, value] of Object.entries(MAIN_ATTRIBUTE_TRANSLATIONS)) {
		const path = `VURS.MainAttribute.${key}`;
		if (!game.i18n.has(path)) foundry.utils.setProperty(translations, path, value);
	}
}

function localizeMainAttribute(key, data = {}) {
	registerMainAttributeLocalization();
	const path = `VURS.MainAttribute.${key}`;
	const localized = game.i18n.localize(path);
	const template = localized === path ? MAIN_ATTRIBUTE_TRANSLATIONS[key] : localized;
	return Object.entries(data).reduce(
		(text, [name, value]) => text.replaceAll(`{${name}}`, value),
		template
	);
}

function getMainAttributeHint(attribute) {
	return attribute
		? game.i18n.localize(MAIN_ATTRIBUTE_LABELS[attribute])
		: localizeMainAttribute("ChooseHint");
}

export function getMainAttribute(actor) {
	const attribute = foundry.utils.getProperty(actor, MAIN_ATTRIBUTE_FLAG);
	return MAIN_ATTRIBUTE_SLUGS.has(attribute) ? attribute : null;
}

export function applyMainAttributeBoost(actor) {
	const attribute = getMainAttribute(actor);
	const ability = actor?.system?.abilities?.[attribute];
	if (!ability || !Number.isFinite(ability.mod)) return false;

	ability.mod = Math.min(10, ability.mod + 1);
	ability.base = Math.trunc(ability.mod);
	return true;
}

export function addMainAttributeIndicator(element, actor) {
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!root?.querySelectorAll || actor?.type !== "character") return;
	if (!root.querySelector(".subsection.attributes")) return;

	const jq = globalThis.jQuery ?? globalThis.$;
	const canCreateTooltips = typeof jq === "function" && typeof jq.fn?.tooltipster === "function";
	for (const indicator of root.querySelectorAll(".vurs-main-attribute-indicator")) {
		if (canCreateTooltips && indicator.classList.contains("tooltipstered")) {
			jq(indicator).tooltipster("destroy");
		}
		indicator.remove();
	}

	const attribute = actorUsesMainAttribute(actor) ? getMainAttribute(actor) : null;
	if (!attribute) return;

	const abbreviation = root.querySelector(
		`.subsection.attributes li.attribute[data-attribute="${attribute}"] h2.abbreviation`
	);
	if (!abbreviation) return;

	const indicator = document.createElement("i");
	indicator.className = "vurs-main-attribute-indicator fa-solid fa-star";
	indicator.setAttribute("aria-hidden", "true");
	abbreviation.append(indicator);
	if (canCreateTooltips) {
		jq(indicator).tooltipster({
			content: localizeMainAttribute("Label"),
			trigger: "hover",
			arrow: false,
			debug: false,
			side: ["top", "bottom"],
			theme: "crb-hover"
		});
	}
}

function refreshMainAttributeIndicators(actor) {
	for (const app of Object.values(actor?.apps ?? {})) {
		addMainAttributeIndicator(app?.element, actor);
	}
}

function rerenderMainAttributeActorSheet(actor) {
	const sheet = actor?.sheet;
	if (!sheet?.rendered || typeof sheet.render !== "function") return;

	const ApplicationV2 = foundry.applications?.api?.ApplicationV2;
	if (ApplicationV2 && sheet instanceof ApplicationV2) sheet.render({ force: true });
	else sheet.render(false);
}

function getActorModifier(actor, attribute) {
	const modifier = actor?.system?.abilities?.[attribute]?.mod;
	return Number.isFinite(modifier) ? modifier : null;
}

function getNativeStrikeStrengthDamage(actor, item) {
	const isCharacter = actor?.isOfType?.("character") || actor?.type === "character";
	const isWeapon = item?.isOfType?.("weapon") || item?.type === "weapon";
	const traits = item?.system?.traits?.value ?? [];
	const isPropulsive = traits.includes("propulsive");
	const isThrown = item?.isThrown === true || traits.some(trait => trait.startsWith("thrown-"));
	const addsStrength = isCharacter && isWeapon &&
		(item.isMelee === true || isThrown || isPropulsive);
	if (!addsStrength) return 0;

	const strength = getActorModifier(actor, "str");
	if (strength === null) return 0;
	return isPropulsive && strength > 0 ? Math.floor(strength / 2) : strength;
}

export function registerMainAttributeDamageModifiers(actor) {
	const attribute = getMainAttribute(actor);
	if (!attribute) return false;
	if (getActorModifier(actor, attribute) === null) {
		console.error(`${MODULE_ID} | Could not apply Main Attribute damage: ${attribute} modifier is unavailable`);
		return false;
	}

	const Modifier = game.pf2e?.Modifier;
	if (typeof Modifier !== "function" || !actor?.synthetics?.modifiers) {
		console.error(`${MODULE_ID} | Could not apply Main Attribute damage: PF2e modifier or actor synthetics are unavailable`);
		return false;
	}

	const items = new Set((actor.system?.actions ?? [])
		.filter(action => action?.type === "strike" && action.item?.id)
		.map(action => action.item));
	for (const item of items) {
		const selector = `${item.id}-damage`;
		const modifiers = actor.synthetics.modifiers[selector] ??= [];
		if (!Array.isArray(modifiers)) {
			console.error(`${MODULE_ID} | Could not apply Main Attribute damage: ${selector} modifiers are not an array`);
			continue;
		}
		if (modifiers.some(modifier => modifier.vursMainAttributeDamage === true)) continue;

		const factory = () => {
			const mainModifier = getActorModifier(actor, attribute);
			if (mainModifier === null) {
				console.error(`${MODULE_ID} | Could not apply Main Attribute damage: ${attribute} modifier is unavailable`);
				return new Modifier({
					slug: "vurs-main-attribute-damage",
					label: localizeMainAttribute("Label"),
					modifier: 0,
					type: "untyped"
				});
			}
			return new Modifier({
				slug: "vurs-main-attribute-damage",
				label: localizeMainAttribute("Label"),
				modifier: mainModifier - getNativeStrikeStrengthDamage(actor, item),
				type: "untyped"
			});
		};
		factory.vursMainAttributeDamage = true;
		modifiers.push(factory);
	}
	return true;
}

export function applyMainAttributeToStrike(actor, strike, item, attribute) {
	if (!strike || !item?.system || !MAIN_ATTRIBUTE_SLUGS.has(attribute)) return strike;

	const mainModifier = getActorModifier(actor, attribute);
	if (mainModifier === null) {
		console.error(`${MODULE_ID} | Could not apply Main Attribute to ${item.name}'s Strike: ${attribute} modifier is unavailable`);
		return strike;
	}
	const abilityModifier = (strike.modifiers ?? []).find(modifier => modifier?.type === "ability");
	if (!abilityModifier) {
		console.error(`${MODULE_ID} | Could not apply Main Attribute to ${item.name}'s Strike: PF2e ability modifier is unavailable`);
		return strike;
	}
	abilityModifier.ability = attribute;
	abilityModifier.slug = `ability-${attribute}`;
	abilityModifier.label = game.i18n.localize(MAIN_ATTRIBUTE_LABELS[attribute]);
	abilityModifier.modifier = mainModifier;
	abilityModifier.enabled = true;
	abilityModifier.ignored = false;
	for (const modifier of strike.modifiers ?? []) {
		if (modifier?.type === "ability" && modifier !== abilityModifier) {
			modifier.enabled = false;
			modifier.ignored = true;
		}
	}

	if (Array.isArray(strike.domains)) {
		const retained = strike.domains.filter(domain => !MAIN_ATTRIBUTE_ABILITY_DOMAIN.test(domain));
		retained.push(`${attribute}-attack`, `${attribute}-based`);
		strike.domains.splice(0, strike.domains.length, ...new Set(retained));
	}
	if (strike.options instanceof Set) {
		for (const option of actor.getRollOptions?.([`${attribute}-attack`, `${attribute}-based`]) ?? []) {
			strike.options.add(option);
		}
	}

	if (Array.isArray(strike.modifiers)) {
		let totalModifier = 0;
		const breakdown = [];
		for (const modifier of strike.modifiers) {
			if (modifier?.enabled === false || modifier?.ignored === true) continue;
			totalModifier += modifier.modifier;
			breakdown.push(`${modifier.label ?? modifier.slug} ${modifier.signedValue ?? modifier.value}`);
		}
		strike.totalModifier = totalModifier;
		strike.breakdown = breakdown.join(", ");
	}

	return strike;
}

function createAttributeButton(attribute, selected) {
	const column = document.createElement("div");
	column.className = "row-column svelte-8m1dup";

	const button = document.createElement("button");
	button.type = "button";
	button.className = `attribute-button boost svelte-1rh7kd0${selected ? " selected" : ""}`;
	button.dataset.vursMainAttribute = attribute;
	button.setAttribute("aria-label", `${game.i18n.localize("PF2E.Actor.Character.AttributeBuilder.Boost")} ${game.i18n.localize(MAIN_ATTRIBUTE_LABELS[attribute])}`);
	button.setAttribute("aria-pressed", String(selected));
	button.textContent = game.i18n.localize("PF2E.Actor.Character.AttributeBuilder.Boost");
	column.append(button);
	return column;
}

export function addMainAttributeBuilderControl(app, root, actor) {
	if (app?.id !== "attribute-builder" ||
		actor?.type !== "character") return;

	const builder = root?.matches?.(".attribute-rows")
		? root
		: root?.querySelector?.(".attribute-rows");
	if (!builder || builder.querySelector(".vurs-main-attribute-row")) return;

	const row = document.createElement("section");
	row.className = "row vurs-main-attribute-row svelte-8m1dup";
	row.setAttribute("role", "group");
	row.dataset.section = "vurs-main-attribute";

	const heading = document.createElement("div");
	heading.className = "row-heading svelte-8m1dup";
	const label = document.createElement("div");
	label.className = "label svelte-8m1dup";
	const title = document.createElement("div");
	title.className = "title svelte-8m1dup";
	title.textContent = localizeMainAttribute("Label");
	const description = document.createElement("div");
	description.className = "description svelte-8m1dup";
	description.textContent = getMainAttributeHint(getMainAttribute(actor));
	const jq = globalThis.jQuery ?? globalThis.$;
	if (typeof jq === "function" && typeof jq.fn?.tooltipster === "function") {
		jq(description).tooltipster({
			content: localizeMainAttribute("StrikeHint"),
			trigger: "hover",
			arrow: false,
			debug: false,
			side: ["top", "bottom"],
			theme: "crb-hover"
		});
	}
	label.append(title, description);
	heading.append(label);

	const attributes = document.createElement("div");
	attributes.className = "attributes svelte-8m1dup";
	const selectedAttribute = getMainAttribute(actor);
	for (const attribute of MAIN_ATTRIBUTE_SLUGS) {
		attributes.append(createAttributeButton(attribute, attribute === selectedAttribute));
	}
	row.append(heading, attributes);

	const classSection = builder.querySelector(':scope > section:not([data-section])');
	if (classSection) classSection.after(row);
	else builder.append(row);

	row.addEventListener("click", async event => {
		const button = event.target instanceof Element
			? event.target.closest("button[data-vurs-main-attribute]")
			: null;
		const attribute = button?.dataset.vursMainAttribute;
		if (!MAIN_ATTRIBUTE_SLUGS.has(attribute)) return;

		const buttons = [...row.querySelectorAll("button[data-vurs-main-attribute]")];
		const previousAttribute = getMainAttribute(actor);
		const nextAttribute = attribute === previousAttribute ? null : attribute;
		for (const candidate of buttons) {
			const selected = candidate.dataset.vursMainAttribute === nextAttribute;
			candidate.classList.toggle("selected", selected);
			candidate.setAttribute("aria-pressed", String(selected));
		}
		description.textContent = getMainAttributeHint(nextAttribute);

		try {
			const update = nextAttribute
				? { [MAIN_ATTRIBUTE_FLAG]: nextAttribute }
				: { "flags.vurs.mainAttribute": new foundry.data.operators.ForcedDeletion() };
			await actor.update(update, { render: false });
			refreshMainAttributeIndicators(actor);
			rerenderMainAttributeActorSheet(actor);
			await app.render();
		} catch (error) {
			refreshMainAttributeIndicators(actor);
			for (const candidate of buttons) {
				const selected = candidate.dataset.vursMainAttribute === previousAttribute;
				candidate.classList.toggle("selected", selected);
				candidate.setAttribute("aria-pressed", String(selected));
			}
			description.textContent = getMainAttributeHint(previousAttribute);
			console.error(`${MODULE_ID} | Failed to update ${actor.name}'s Main Attribute`, error);
		}
	});
}
