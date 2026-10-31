import { getDamageRollOptions, getDamageSelectors } from "./lifesteal.js";
import { resolveRuleElementValue, testRuleElementPredicate } from "./ruleElementResolvers.js";
import { MODIFIER_TYPES, selectTypedModifiers } from "./typedModifiers.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Healing Effectiveness";
const ROLL_MESSAGE_WRAPPER = Symbol.for(`${MODULE_ID}.healingEffectivenessRollMessageWrapper`);
const CHAT_CREATE_WRAPPER = Symbol.for(`${MODULE_ID}.healingEffectivenessChatCreateWrapper`);
const activeHealingParams = new WeakSet();
const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
let HealingEffectivenessRuleElement = null;

function registerHealingEffectivenessLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has(`PF2E.RuleElement.${RULE_KEY}`)) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerHealingEffectivenessRuleElement({ quiet = false } = {}) {
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
		if (registry.custom[RULE_KEY] !== HealingEffectivenessRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	HealingEffectivenessRuleElement = class HealingEffectivenessRuleElement extends RuleElement {
		resolveValue(value, fallback = 0, options = {}) {
			return resolveRuleElementValue(
				this,
				(value, fallbackValue, resolveOptions) =>
					super.resolveValue(value, fallbackValue, resolveOptions),
				value,
				fallback,
				options
			);
		}

		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({
					required: true,
					nullable: false,
					initial: 1
				}),
				type: new fields.StringField({
					required: false,
					nullable: false,
					choices: MODIFIER_TYPES,
					initial: "untyped"
				}),
				healingEffectivenessThreshold: new ResolvableValueField({
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

	registry.custom[RULE_KEY] = HealingEffectivenessRuleElement;
}

function getHealingEffectiveness(
	actor,
	baseHealing,
	rollOptions,
	selectors,
	{ negativeOnly = false, positiveOnly = false } = {}
) {
	const seenSlugs = new Set();
	const sources = [];
	for (const rule of Array.isArray(actor?.rules) ? actor.rules : []) {
		if (
			rule.key !== RULE_KEY ||
			rule.ignored ||
			(rule.selector && !selectors.has(rule.selector)) ||
			!testRuleElementPredicate(rule, rollOptions)
		) {
			continue;
		}

		const slug = typeof rule.slug === "string" ? rule.slug.trim() : "";
		if (slug && seenSlugs.has(slug)) continue;
		const value = Number(rule.resolveValue(rule.value, 0));
		const type = rule.type ?? "untyped";
		if (!Number.isFinite(value) || value === 0 ||
			(negativeOnly && value > 0) || (positiveOnly && value < 0) ||
			!MODIFIER_TYPES.includes(type)) continue;

		const direction = Math.sign(value);
		const magnitude = Math.abs(value);
		let bonus;
		switch (rule.mode ?? "threshold") {
			case "flat":
				bonus = value;
				break;
			case "percent":
				bonus = direction * Math.floor(baseHealing * magnitude);
				break;
			case "threshold":
			default: {
				const threshold = Number(
					rule.resolveValue(rule.healingEffectivenessThreshold ?? 20, 20)
				);
				if (!Number.isFinite(threshold) || threshold <= 0) {
					console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: healingEffectivenessThreshold must resolve to a positive number`);
					continue;
				}
				bonus = direction * Math.max(
					Math.floor(Math.floor(baseHealing / threshold) * magnitude),
					baseHealing < threshold ? 1 : 0
				);
			}
		}
		if (bonus === 0) continue;

		if (slug) seenSlugs.add(slug);
		const sourceRule = rule.item?.system?.rules?.[rule.sourceIndex];
		const label = typeof sourceRule?.label === "string" && sourceRule.label.trim()
			? sourceRule.label.trim()
			: rule.item?.name ?? rule.label ?? RULE_KEY;
		sources.push({ label, type, value: bonus });
	}

	const selectedSources = selectTypedModifiers(sources);
	return {
		total: selectedSources.reduce((total, source) => total + source.value, 0),
		sources: selectedSources.map(({ label, type, value }) => ({
			label,
			type,
			bonus: value
		}))
	};
}

export function getLifestealHealingEffectiveness(actor, baseHealing, rollOptions, selectors) {
	const options = new Set([
		...(rollOptions instanceof Set || Array.isArray(rollOptions) ? rollOptions : []),
		...(actor?.getRollOptions?.("all") ?? []),
		...(actor?.getSelfRollOptions?.() ?? [])
	]);
	const healingSelectors = new Set([
		...(selectors instanceof Set || Array.isArray(selectors) ? selectors : []),
		"healing",
		"healing-received"
	]);
	const outgoing = getHealingEffectiveness(
		actor,
		baseHealing,
		options,
		healingSelectors,
		{ positiveOnly: true }
	);
	const receivedBase = Math.max(0, baseHealing + outgoing.total);
	const received = getHealingEffectiveness(
		actor,
		receivedBase,
		options,
		healingSelectors,
		{ negativeOnly: true }
	);

	return {
		total: Math.max(0, receivedBase + received.total),
		sources: [...outgoing.sources, ...received.sources]
	};
}

function getHealingRollInstances(roll) {
	const pool = roll?.terms?.find(term => Array.isArray(term.rolls));
	return Array.isArray(roll?.instances)
		? roll.instances.filter((instance, index) =>
			instance.kinds?.has?.("healing") && pool?.results?.[index]?.active !== false
		)
		: [];
}

function getRollActor(messageData) {
	const actorId = messageData?.flags?.pf2e?.context?.actor ??
		messageData?.speaker?.actor;
	return typeof actorId === "string" ? game.actors?.get(actorId) ?? null : null;
}

function getHealingRollContext(roll, messageData, actor) {
	const context = messageData?.flags?.pf2e?.context ?? {};
	const actorOptions = actor?.getRollOptions?.("all") ?? [];
	const selfOptions = actor?.getSelfRollOptions?.() ?? [];
	const options = new Set([
		...(Array.isArray(context.options) ? context.options : []),
		...(Array.isArray(actorOptions) ? actorOptions : []),
		...(Array.isArray(selfOptions) ? selfOptions : [])
	]);
	const rollOptions = getDamageRollOptions(roll, options);
	const selectors = new Set([
		...(Array.isArray(context.domains) ? context.domains : []),
		"healing",
		"healing-received"
	]);
	return { rollOptions, selectors };
}

function addHealingRollModifier(instance, amount) {
	const originalTotal = instance.total;
	const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
	const template = DamageRoll?.parse("{(1d2+1)[healing]}")?.[0]?.rolls?.[0];
	const templateGroup = template?.terms?.find(term => term.term);
	const expressionConstructor = templateGroup?.term?.constructor;
	const groupConstructor = templateGroup?.constructor;
	if (typeof expressionConstructor !== "function" || typeof groupConstructor !== "function") {
		console.error(`${MODULE_ID} | Could not add ${RULE_KEY} to the healing roll: PF2E roll terms are unavailable`);
		return false;
	}

	let group = instance.terms.find(term => term.term);
	let expression = group?.term ?? instance.terms[0];
	const modifier = new foundry.dice.terms.NumericTerm({
		number: Math.abs(amount),
		options: { flavor: RULE_KEY }
	});
	const adjustedExpression = new expressionConstructor({
		operator: amount > 0 ? "+" : "-",
		operands: [expression, modifier],
		options: {}
	});
	adjustedExpression._evaluated = true;
	if (!group) {
		group = new groupConstructor({
			term: adjustedExpression.toJSON(),
			options: { flavor: "healing" }
		});
		instance.terms = [group];
	} else {
		group.term = adjustedExpression;
	}
	group._evaluated = true;
	instance._total = Math.max(0, originalTotal + amount);
	instance._formula = instance.formula;
	return true;
}

function appendHealingModifierLabels(flavor, sources) {
	const container = document.createElement("div");
	container.className = "tags modifiers";
	for (const source of sources) {
		const tag = document.createElement("span");
		tag.className = "tag tag_transparent";
		tag.textContent = `${source.label} ${source.bonus > 0 ? "+" : ""}${source.bonus}`;
		container.append(tag);
	}
	return `${flavor ?? ""}${container.outerHTML}`;
}

function applyHealingEffectivenessToRoll(roll, actor, messageData) {
	if (roll.options?.vursHealingEffectivenessApplied) return [];
	const instances = getHealingRollInstances(roll);
	if (instances.length === 0) return [];

	const baseHealing = instances.reduce((total, instance) => total + Math.max(0, instance.total), 0);
	if (baseHealing <= 0) return [];
	const originalRollTotal = roll.total;

	const { rollOptions, selectors } = getHealingRollContext(roll, messageData, actor);
	const { total, sources } = getHealingEffectiveness(actor, baseHealing, rollOptions, selectors);
	if (sources.length === 0) return [];

	let remaining = Math.max(-baseHealing, total);
	if (remaining > 0) {
		if (!addHealingRollModifier(instances[0], remaining)) return [];
	} else {
		remaining = -remaining;
		for (const instance of instances) {
			const reduction = Math.min(remaining, Math.max(0, instance.total));
			if (reduction > 0 && !addHealingRollModifier(instance, -reduction)) return [];
			remaining -= reduction;
			if (remaining === 0) break;
		}
	}

	const pool = roll.terms.find(term => Array.isArray(term.rolls));
	if (pool) {
		pool.terms = pool.rolls.map(instance => instance._formula);
		pool.results = pool.rolls.map((instance, index) => ({
			...pool.results[index],
			result: instance.total,
			active: pool.results[index]?.active ?? true
		}));
	}
	roll._total = originalRollTotal + Math.max(-baseHealing, total);
	roll._formula = `{${pool?.terms.join(", ") ?? roll.formula}}`;
	roll.options.vursHealingEffectivenessApplied = true;
	return sources;
}

function getHealingApplicationContext(healingRoll, params, actor) {
	const rollOptions = getDamageRollOptions(healingRoll, params.rollOptions);
	for (const option of actor?.getRollOptions?.("all") ?? []) rollOptions.add(option);
	for (const option of actor?.getSelfRollOptions?.() ?? []) rollOptions.add(option);
	for (const option of params.item?.getRollOptions?.("item") ?? []) {
		rollOptions.add(option);
	}

	const selectors = new Set(["healing", "healing-received"]);
	if (typeof healingRoll === "object") {
		for (const selector of getDamageSelectors(healingRoll, params.item)) {
			selectors.add(selector);
		}
	}

	const itemUuid = params.item?.uuid;
	if (itemUuid) {
		const sourceMessage = [...(game.messages?.contents ?? [])]
			.filter(message => message.item?.uuid === itemUuid)
			.filter(message => message.rolls?.some(roll =>
				roll.instances?.some(instance => instance.kinds?.has?.("healing"))
			))
			.sort((left, right) => right.timestamp - left.timestamp)[0];
		const context = sourceMessage?.flags?.[game.system.id]?.context;
		for (const selector of context?.domains ?? []) selectors.add(selector);
		for (const option of context?.options ?? []) rollOptions.add(option);
	}

	return { rollOptions, selectors };
}

async function applyReceivedHealingEffectiveness(actor, wrapped, args) {
	const params = args[0];
	if (
		!params ||
		typeof params !== "object" ||
		params.vursHealingEffectivenessApplied ||
		activeHealingParams.has(params)
	) {
		return wrapped(...args);
	}

	const healingRoll = params.damage;
	const damage = typeof healingRoll === "number" ? healingRoll : healingRoll?.total;
	if (typeof damage !== "number" || damage >= 0) return wrapped(...args);

	activeHealingParams.add(params);
	try {
		const { rollOptions, selectors } = getHealingApplicationContext(healingRoll, params, actor);
		const { total, sources } = getHealingEffectiveness(
			actor,
			Math.abs(damage),
			rollOptions,
			selectors,
			{ negativeOnly: true }
		);
		if (total < 0) {
			params.damage = Math.min(0, damage - total);
			params.breakdown ??= [];
			params.breakdown.push(...sources.map(source =>
				`${source.label} ${source.bonus}`
			));
		}
		return await wrapped(...args);
	} finally {
		activeHealingParams.delete(params);
	}
}

damageHandlers.add(applyReceivedHealingEffectiveness);

function installHealingEffectivenessRollWrapper() {
	const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
	if (!DamageRoll) {
		console.error(`${MODULE_ID} | Could not install ${RULE_KEY} roll handling: PF2E DamageRoll is unavailable`);
		return;
	}
	if (DamageRoll.prototype[ROLL_MESSAGE_WRAPPER]) return;

	const originalToMessage = DamageRoll.prototype.toMessage;
	if (typeof originalToMessage !== "function") {
		console.error(`${MODULE_ID} | Could not install ${RULE_KEY} roll handling: DamageRoll.toMessage is unavailable`);
		return;
	}

	DamageRoll.prototype.toMessage = async function (messageData = {}, options = {}) {
		if (!this._evaluated) {
			let messageMode = options.messageMode;
			if (!messageMode && options.rollMode) {
				messageMode = DamageRoll._mapLegacyRollMode?.(options.rollMode);
			}
			await this.evaluate({
				allowInteractive: (messageMode ?? game.settings.get("core", "messageMode")) !== "blind"
			});
		}
		const actor = getRollActor(messageData);
		if (actor) {
			const sources = applyHealingEffectivenessToRoll(this, actor, messageData);
			if (sources.length > 0) {
				messageData.flavor = appendHealingModifierLabels(messageData.flavor, sources);
			}
		}
		return originalToMessage.call(this, messageData, options);
	};
	Object.defineProperty(DamageRoll.prototype, ROLL_MESSAGE_WRAPPER, { value: true });
}

function installHealingEffectivenessChatCreateWrapper() {
	const ChatMessage = CONFIG.ChatMessage?.documentClass;
	if (!ChatMessage || typeof ChatMessage.create !== "function") {
		console.error(`${MODULE_ID} | Could not install ${RULE_KEY} Fast Healing handling: ChatMessage class is unavailable`);
		return;
	}
	if (ChatMessage[CHAT_CREATE_WRAPPER]) return;

	const originalCreate = ChatMessage.create;
	ChatMessage.create = function (data, ...args) {
		const actor = getRollActor(data);
		if (actor && Array.isArray(data?.rolls)) {
			const RollClass = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
			if (RollClass) {
				data.rolls = data.rolls.map(serializedRoll => {
					if (
						!(serializedRoll instanceof RollClass) &&
						serializedRoll?.class !== RollClass.name
					) {
						return serializedRoll;
					}
					const roll = serializedRoll instanceof RollClass
						? serializedRoll
						: RollClass.fromData(serializedRoll);
					const sources = applyHealingEffectivenessToRoll(roll, actor, data);
					if (sources.length > 0) {
						data.flavor = appendHealingModifierLabels(data.flavor, sources);
						return roll.toJSON();
					}
					return serializedRoll;
				});
			}
		}
		return originalCreate.call(this, data, ...args);
	};
	Object.defineProperty(ChatMessage, CHAT_CREATE_WRAPPER, { value: true });
}

function installHealingEffectivenessRollHandling() {
	installHealingEffectivenessRollWrapper();
	installHealingEffectivenessChatCreateWrapper();
}

function initializeHealingEffectiveness() {
	registerHealingEffectivenessLocalization();
	registerHealingEffectivenessRuleElement();
	installHealingEffectivenessRollHandling();
}

Hooks.once("init", registerHealingEffectivenessLocalization);
Hooks.once("init", () => registerHealingEffectivenessRuleElement({ quiet: true }));
Hooks.once("setup", registerHealingEffectivenessRuleElement);
Hooks.once("pf2e.systemReady", registerHealingEffectivenessLocalization);
Hooks.once("sf2e.systemReady", registerHealingEffectivenessLocalization);
Hooks.once("pf2e.systemReady", initializeHealingEffectiveness);
Hooks.once("ready", installHealingEffectivenessRollHandling);
