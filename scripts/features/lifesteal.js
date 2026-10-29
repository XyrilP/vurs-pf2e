const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Lifesteal";
const registeredDamageTargets = new Set();
const activeDamageParams = new WeakSet();
const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
let LifestealRuleElement = null;

function registerLifestealLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has("PF2E.RuleElement.Lifesteal")) return;
	foundry.utils.setProperty(translations, "PF2E.RuleElement.Lifesteal", "Lifesteal");
}

function getSystemConfig() {
	return CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
}

function registerLifestealRuleElement({ quiet = false } = {}) {
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
		if (registry.custom[RULE_KEY] !== LifestealRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	LifestealRuleElement = class LifestealRuleElement extends RuleElement {
		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({
					required: true,
					nullable: false,
					initial: 1
				}),
				lifestealThreshold: new ResolvableValueField({
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
				selector: new fields.StringField({
					required: false,
					nullable: true,
					initial: undefined
				})
			};
		}
	};

	registry.custom[RULE_KEY] = LifestealRuleElement;
}

function currentHealthPool(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp) return null;

	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	const stamina = staminaEnabled ? Number(hp.sp?.value ?? 0) : 0;
	return Number(hp.value ?? 0) + Number(hp.temp ?? 0) + stamina;
}

export function getDamageSelectors(damage) {
	const selectors = new Set(["damage-received"]);
	const modifiers = damage?.options?.damage?.modifiers;
	if (Array.isArray(modifiers)) {
		for (const modifier of modifiers) {
			if (Array.isArray(modifier.domains)) {
				for (const selector of modifier.domains) selectors.add(selector);
			}
		}
	}

	const sourceMessage = [...(game.messages?.contents ?? [])]
		.find(message => message.rolls?.includes(damage));
	const domains = foundry.utils.getProperty(
		sourceMessage,
		`flags.${game.system.id}.context.domains`
	);
	if (Array.isArray(domains)) {
		for (const selector of domains) selectors.add(selector);
	}

	return selectors;
}

export function getDamageRollOptions(damage, rollOptions) {
	const options = rollOptions instanceof Set
		? new Set(rollOptions)
		: Array.isArray(rollOptions)
			? new Set(rollOptions)
			: new Set();
	for (const instance of damage?.instances ?? []) {
		if (typeof instance.type === "string" && instance.type.length > 0) {
			options.add(`damage:type:${instance.type}`);
		}
		if (instance.formalDescription && Symbol.iterator in Object(instance.formalDescription)) {
			for (const option of instance.formalDescription) {
				if (typeof option === "string") options.add(option);
			}
		}
	}
	return options;
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

function getLifestealHealing(attacker, damage, rollOptions, selectors) {
	if (damage <= 0) return { healing: 0, sources: [] };

	const seenSlugs = new Set();
	const sources = [];
	for (const rule of Array.isArray(attacker?.rules) ? attacker.rules : []) {
		const selectorMatches = rule.selector === "special-damage"
			? hasSpecialDamageOption(rollOptions)
			: !rule.selector || selectors.has(rule.selector);
		if (
			rule.key !== RULE_KEY ||
			rule.ignored ||
			!selectorMatches ||
			!(rule.predicate?.test?.(rollOptions) ?? true)
		) {
			continue;
		}

		const slug = typeof rule.slug === "string" ? rule.slug.trim() : "";
		if (slug && seenSlugs.has(slug)) continue;
		const value = Number(rule.resolveValue(rule.value, 0));
		if (!Number.isFinite(value) || value <= 0) continue;

		let healing;
		switch (rule.mode ?? "threshold") {
			case "flat":
				healing = value;
				break;
			case "percent":
				healing = Math.floor(damage * value);
				break;
			case "threshold":
			default: {
				const threshold = Number(rule.resolveValue(rule.lifestealThreshold ?? 20, 20));
				if (!Number.isFinite(threshold) || threshold <= 0) {
					console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: lifestealThreshold must resolve to a positive number`);
					continue;
				}
				healing = Math.max(Math.floor(damage / threshold) * value, damage < threshold ? 1 : 0);
			}
		}
		if (!Number.isFinite(healing) || healing <= 0) continue;

		if (slug) seenSlugs.add(slug);
		const sourceRule = rule.item?.system?.rules?.[rule.sourceIndex];
		const label = typeof sourceRule?.label === "string" && sourceRule.label.trim()
			? sourceRule.label.trim()
			: rule.item?.name ?? rule.label ?? "Lifesteal";
		sources.push({ label, healing });
	}

	return {
		healing: sources.reduce((total, source) => total + source.healing, 0),
		sources
	};
}

function findHealingCard(previousMessageIds, attacker) {
	return [...(game.messages?.contents ?? [])]
		.filter(message => {
			if (
				previousMessageIds.has(message.id) ||
				foundry.utils.getProperty(message, "flags.pf2e.context.type") !== "damage-taken"
			) {
				return false;
			}

			const appliedActorUuid = foundry.utils.getProperty(message, "flags.pf2e.appliedDamage.uuid");
			return (
				appliedActorUuid === attacker.uuid ||
				message.speaker?.actor === attacker.id
			);
		})
		.sort((left, right) => right.timestamp - left.timestamp)[0] ?? null;
}

async function addLifestealTooltip(message, sources) {
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	const damageTaken = container.querySelector(".damage-taken");
	if (!damageTaken) {
		console.error(`${MODULE_ID} | Could not add Lifesteal tooltip: healing card has no damage-taken section`);
		return;
	}

	let indicator = damageTaken.querySelector(".lifesteal-iwr");
	if (!indicator) {
		indicator = document.createElement("span");
		indicator.classList.add("iwr", "lifesteal-iwr");
		indicator.dataset.visibility = "all";
		const icon = document.createElement("i");
		icon.classList.add("fa-solid", "fa-circle-info", "small");
		indicator.append(icon);
	}

	indicator.dataset.tooltipClass = "pf2e";
	const tooltip = document.createElement("ul");
	for (const source of sources) {
		const entry = document.createElement("li");
		entry.textContent = `${source.label}: +${source.healing}`;
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

async function healDamageDealer(attacker, amount) {
	const hp = attacker?.attributes?.hp;
	if (!hp || amount <= 0) return { healing: 0, card: null };

	const healing = Math.min(amount, Math.max(hp.max - hp.value, 0));
	if (healing <= 0) return { healing: 0, card: null };

	const token = attacker.token ?? attacker.getActiveTokens?.()[0]?.document;
	if (!token || typeof attacker.applyDamage !== "function") {
		await attacker.update({ "system.attributes.hp.value": hp.value + healing });
		return { healing, card: null };
	}

	const previousMessageIds = new Set((game.messages?.contents ?? []).map(message => message.id));
	await attacker.applyDamage({
		damage: -healing,
		token,
		skipIWR: true
	});
	return { healing, card: findHealingCard(previousMessageIds, attacker) };
}

async function applyLifesteal(actor, wrapped, args) {
	const params = args[0];
	if (!params || typeof params !== "object" || activeDamageParams.has(params)) {
		return wrapped(...args);
	}

	const damage = typeof params?.damage === "number" ? params.damage : params?.damage?.total;
	const attacker = params?.item?.actor ?? params?.item?.parent;
	if (typeof damage !== "number" || damage <= 0 || !attacker) {
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
		if (damageApplied === 0) return result;

		const rollOptions = getDamageRollOptions(params.damage, params.rollOptions);
		const selectors = getDamageSelectors(params.damage);
		const { healing, sources } = getLifestealHealing(attacker, damageApplied, rollOptions, selectors);
		const { healing: healed, card } = await healDamageDealer(attacker, healing);
		if (healed > 0 && card) {
			let remainingHealing = healed;
			const appliedSources = sources
				.map(source => {
					const healing = Math.min(source.healing, remainingHealing);
					remainingHealing -= healing;
					return { ...source, healing };
				})
				.filter(source => source.healing > 0);
			await addLifestealTooltip(card, appliedSources);
		}
		return result;
	} finally {
		activeDamageParams.delete(params);
	}
}

damageHandlers.add(applyLifesteal);

function applyDamageHandlers(actor, wrapped, args) {
	const handlers = [...damageHandlers];
	const dispatch = (index, forwardedArgs) => {
		const handler = handlers[index];
		return handler
			? handler(actor, (...nextArgs) => dispatch(index + 1, nextArgs), forwardedArgs)
			: wrapped(...forwardedArgs);
	};
	return dispatch(0, args);
}

function installLifestealDamageHandling() {
	const config = getSystemConfig();
	const actorClasses = config?.Actor?.documentClasses ?? {};
	const actorClass = CONFIG.Actor?.documentClass;
	const candidates = new Set([
		actorClass,
		...Object.values(actorClasses)
	].filter(candidate => typeof candidate?.prototype?.applyDamage === "function"));

	for (const candidate of candidates) {
		const actorType = Object.entries(actorClasses).find(([, value]) => value === candidate)?.[0];
		const target = actorType
			? `CONFIG.${game.system.id.toUpperCase()}.Actor.documentClasses.${actorType}.prototype.applyDamage`
			: candidate === actorClass
				? "CONFIG.Actor.documentClass.prototype.applyDamage"
				: null;
		if (!target || registeredDamageTargets.has(target)) continue;

		try {
			if (globalThis.libWrapper?.register) {
				globalThis.libWrapper.register(
					MODULE_ID,
					target,
					function (wrapped, ...args) {
						return applyDamageHandlers(this, wrapped, args);
					},
					"WRAPPER"
				);
			} else {
				const prototype = candidate.prototype;
				const original = prototype.applyDamage;
				prototype.applyDamage = function (...args) {
					return applyDamageHandlers(
						this,
						(...wrappedArgs) => original.apply(this, wrappedArgs),
						args
					);
				};
			}
			registeredDamageTargets.add(target);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to install Lifesteal damage handling for ${target}`, error);
		}
	}
}

function initializeLifesteal() {
	registerLifestealLocalization();
	registerLifestealRuleElement();
	installLifestealDamageHandling();
}

Hooks.once("init", registerLifestealLocalization);
Hooks.once("init", () => registerLifestealRuleElement({ quiet: true }));
Hooks.once("setup", registerLifestealRuleElement);
Hooks.once("pf2e.systemReady", registerLifestealLocalization);
Hooks.once("sf2e.systemReady", registerLifestealLocalization);
Hooks.once("pf2e.systemReady", initializeLifesteal);
Hooks.once("sf2e.systemReady", initializeLifesteal);
Hooks.once("ready", initializeLifesteal);
