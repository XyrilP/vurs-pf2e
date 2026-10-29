import { getDamageRollOptions, getDamageSelectors } from "./lifesteal.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Damage Return";
const activeDamageParams = new WeakSet();
const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
let DamageReturnRuleElement = null;

function registerDamageReturnLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has("PF2E.RuleElement.Damage Return")) return;
	foundry.utils.setProperty(translations, "PF2E.RuleElement.Damage Return", "Damage Return");
}

function registerDamageReturnRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const RuleElement = system?.RuleElement;
	const registry = system?.RuleElements;
	if (!RuleElement || !registry?.custom) {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system Rule Element API is unavailable`);
		return;
	}
	const ResolvableValueField = registry.builtin?.Resistance?.schema?.fields?.value?.constructor;
	if (typeof ResolvableValueField !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system resolvable-value field is unavailable`);
		return;
	}

	if (registry.custom[RULE_KEY]) {
		if (registry.custom[RULE_KEY] !== DamageReturnRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	DamageReturnRuleElement = class DamageReturnRuleElement extends RuleElement {
		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({
					required: true,
					nullable: false,
					initial: 1
				}),
				damageReturnThreshold: new ResolvableValueField({
					required: false,
					nullable: false,
					initial: 20
				}),
				mode: new fields.StringField({
					required: false,
					nullable: false,
					initial: "threshold",
					choices: {
						threshold: "Threshold",
						flat: "Flat",
						percent: "Percent"
					}
				}),
				beforeReduction: new fields.BooleanField({
					required: false,
					nullable: false,
					initial: true
				}),
				selector: new fields.StringField({
					required: false,
					nullable: true,
					initial: undefined
				})
			};
		}
	};

	registry.custom[RULE_KEY] = DamageReturnRuleElement;
}

function currentHealthPool(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp) return null;

	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	const stamina = staminaEnabled ? Number(hp.sp?.value ?? 0) : 0;
	return Number(hp.value ?? 0) + Number(hp.temp ?? 0) + stamina;
}

function hasSpecialDamageOption(options) {
	const values = options instanceof Set ? [...options] : Array.isArray(options) ? options :
		typeof options === "string" ? [options] : [];
	const damageOptions = values
		.filter(option => typeof option === "string")
		.map(option => option.startsWith("item:damage:") ? option.slice("item:".length) : option);
	const hasDamageOption = damageOptions.includes("damage") || damageOptions.some(option =>
		option.startsWith("damage:type:") || option.startsWith("damage:category:")
	);
	if (!hasDamageOption) return false;

	const damageTypeOptions = damageOptions.filter(option => option.startsWith("damage:type:"));
	const damageCategoryOptions = damageOptions.filter(option => option.startsWith("damage:category:"));
	const excludedTypes = ["physical", "bludgeoning", "slashing", "piercing"];
	if (
		damageTypeOptions.some(option => !excludedTypes.some(type => option === `damage:type:${type}`)) ||
		damageCategoryOptions.some(option => option !== "damage:category:physical")
	) {
		return true;
	}

	return damageTypeOptions.length === 0 &&
		damageCategoryOptions.length === 0;
}

function getDamageReturnAmount(actor, damageBeforeReduction, damageAfterReduction, rollOptions, selectors) {
	const seenSlugs = new Set();
	const sources = [];
	for (const rule of Array.isArray(actor?.rules) ? actor.rules : []) {
		const selectorMatches = !rule.selector ||
			selectors.has(rule.selector) ||
			(rule.selector === "special-damage" && hasSpecialDamageOption(rollOptions));
		if (
			rule.key !== RULE_KEY ||
			rule.ignored ||
			!selectorMatches ||
			!(rule.predicate?.test?.(rollOptions) ?? true)
		) {
			continue;
		}

		const damage = rule.beforeReduction === false ? damageAfterReduction : damageBeforeReduction;
		if (!Number.isFinite(damage) || damage <= 0) continue;

		const slug = typeof rule.slug === "string" ? rule.slug.trim() : "";
		if (slug && seenSlugs.has(slug)) continue;
		const value = Number(rule.resolveValue(rule.value, 0));
		if (!Number.isFinite(value) || value <= 0) continue;

		let returned;
		switch (rule.mode ?? "threshold") {
			case "flat":
				returned = value;
				break;
			case "percent":
				returned = Math.floor(damage * value);
				break;
			case "threshold":
			default: {
				const threshold = Number(rule.resolveValue(rule.damageReturnThreshold ?? 20, 20));
				if (!Number.isFinite(threshold) || threshold <= 0) {
					console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: damageReturnThreshold must resolve to a positive number`);
					continue;
				}
				returned = Math.max(
					Math.floor(Math.floor(damage / threshold) * value),
					damage < threshold ? 1 : 0
				);
			}
		}
		if (returned <= 0) continue;

		if (slug) seenSlugs.add(slug);
		const sourceRule = rule.item?.system?.rules?.[rule.sourceIndex];
		const label = typeof sourceRule?.label === "string" && sourceRule.label.trim()
			? sourceRule.label.trim()
			: rule.item?.name ?? rule.label ?? "Damage Return";
		sources.push({ label, damage: returned });
	}

	return {
		total: sources.reduce((total, source) => total + source.damage, 0),
		sources
	};
}

function getDamageReturnParts(damageRoll, amount, rollOptions) {
	const config = CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
	const validTypes = new Set(Object.keys(config?.damageTypes ?? {}));
	const weights = new Map();
	for (const instance of damageRoll?.instances ?? []) {
		const weight = Number(instance.total);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		const type = validTypes.has(instance.type) ? instance.type : "untyped";
		weights.set(type, (weights.get(type) ?? 0) + weight);
	}

	if (weights.size === 0) {
		const options = rollOptions instanceof Set ? [...rollOptions] : Array.isArray(rollOptions) ? rollOptions : [];
		for (const option of options) {
			const match = typeof option === "string" && /^(?:item:)?damage:type:([\w-]+)$/.exec(option);
			if (!match) continue;
			const type = validTypes.has(match[1]) ? match[1] : "untyped";
			weights.set(type, (weights.get(type) ?? 0) + 1);
		}
	}
	if (weights.size === 0) weights.set("untyped", 1);

	const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
	const parts = [...weights].map(([type, weight]) => {
		const exact = amount * weight / totalWeight;
		const whole = Math.floor(exact);
		return { type, amount: whole, remainder: exact - whole };
	});
	const remaining = amount - parts.reduce((sum, part) => sum + part.amount, 0);
	parts.sort((left, right) => right.remainder - left.remainder || left.type.localeCompare(right.type));
	for (let index = 0; index < remaining; index++) parts[index].amount++;
	return parts.filter(part => part.amount > 0);
}

function createDamageReturnRoll(damageRoll, amount, rollOptions) {
	const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
	if (!DamageRoll) {
		console.error(`${MODULE_ID} | Could not create returned damage: the system DamageRoll class is unavailable`);
		return null;
	}

	const parts = getDamageReturnParts(damageRoll, amount, rollOptions);
	const formula = `{${parts.map(({ type, amount }) =>
		type === "untyped" ? `${amount}` : `${amount}[${type}]`
	).join(", ")}}`;
	return new DamageRoll(formula).evaluateSync();
}

function getReturnedDamageOptions(actor) {
	return new Set(actor.getSelfRollOptions?.() ?? []);
}

function findDamageReturnCard(previousMessageIds, actor) {
	return [...(game.messages?.contents ?? [])]
		.filter(message => {
			if (
				previousMessageIds.has(message.id) ||
				foundry.utils.getProperty(message, `flags.${game.system.id}.context.type`) !== "damage-taken"
			) {
				return false;
			}

			const appliedActorUuid = foundry.utils.getProperty(
				message,
				`flags.${game.system.id}.appliedDamage.uuid`
			);
			return appliedActorUuid === actor.uuid || message.speaker?.actor === actor.id;
		})
		.sort((left, right) => right.timestamp - left.timestamp)[0] ?? null;
}

async function addDamageReturnTooltip(message, sources) {
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	const damageTaken = container.querySelector(".damage-taken");
	if (!damageTaken) {
		console.error(`${MODULE_ID} | Could not add Damage Return tooltip: damage card has no damage-taken section`);
		return;
	}

	let indicator = damageTaken.querySelector(".damage-return-iwr");
	if (!indicator) {
		indicator = document.createElement("span");
		indicator.classList.add("iwr", "damage-return-iwr");
		indicator.dataset.visibility = "all";
		const icon = document.createElement("i");
		icon.classList.add("fa-solid", "fa-circle-info", "small");
		indicator.append(icon);
	}

	indicator.dataset.tooltipClass = "pf2e";
	const tooltip = document.createElement("ul");
	for (const source of sources) {
		const entry = document.createElement("li");
		entry.textContent = `${source.label}: +${source.damage}`;
		tooltip.append(entry);
	}
	indicator.dataset.tooltipHtml = tooltip.outerHTML;
	const revertButton = damageTaken.querySelector(".revert-damage");
	if (revertButton) {
		damageTaken.insertBefore(indicator, revertButton);
	} else {
		damageTaken.append(indicator);
	}

	await message.update({ content: container.innerHTML });
}

async function applyDamageReturn(actor, wrapped, args) {
	const params = args[0];
	if (!params || typeof params !== "object" || activeDamageParams.has(params)) {
		return wrapped(...args);
	}

	const damage = typeof params.damage === "number" ? params.damage : params.damage?.total;
	const damageDealer = params.item?.actor ?? params.item?.parent;
	if (typeof damage !== "number" || damage <= 0 || !damageDealer || damageDealer === actor) {
		return wrapped(...args);
	}

	activeDamageParams.add(params);
	try {
		const targetActor = params.token?.actor ?? actor;
		const healthBefore = currentHealthPool(targetActor);
		const result = await wrapped(...args);
		const healthAfter = currentHealthPool(targetActor);
		if (healthBefore === null || healthAfter === null) return result;

		const damageApplied = Math.max(0, healthBefore - healthAfter);
		const rollOptions = getDamageRollOptions(params.damage, params.rollOptions);
		const { total: amount, sources } = getDamageReturnAmount(
			actor,
			damage,
			damageApplied,
			rollOptions,
			getDamageSelectors(params.damage, params.item)
		);
		if (amount <= 0) return result;

		const returnedDamage = createDamageReturnRoll(params.damage, amount, rollOptions);
		const token = damageDealer.token ?? damageDealer.getActiveTokens?.()[0]?.document;
		if (!returnedDamage || !token || typeof damageDealer.applyDamage !== "function") {
			console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: the damage-dealer token or applyDamage method is unavailable`);
			return result;
		}

		const previousMessageIds = new Set((game.messages?.contents ?? []).map(message => message.id));
		await damageDealer.applyDamage({
			damage: returnedDamage,
			token,
			rollOptions: getReturnedDamageOptions(damageDealer)
		});
		const card = findDamageReturnCard(previousMessageIds, damageDealer);
		if (card) await addDamageReturnTooltip(card, sources);
		return result;
	} finally {
		activeDamageParams.delete(params);
	}
}

damageHandlers.add(applyDamageReturn);

function initializeDamageReturn() {
	registerDamageReturnLocalization();
	registerDamageReturnRuleElement();
}

Hooks.once("init", registerDamageReturnLocalization);
Hooks.once("init", () => registerDamageReturnRuleElement({ quiet: true }));
Hooks.once("setup", registerDamageReturnRuleElement);
Hooks.once("pf2e.systemReady", registerDamageReturnLocalization);
Hooks.once("sf2e.systemReady", registerDamageReturnLocalization);
Hooks.once("pf2e.systemReady", initializeDamageReturn);
Hooks.once("sf2e.systemReady", initializeDamageReturn);
Hooks.once("ready", initializeDamageReturn);
