const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Attack Speed";
const CHECK_WRAPPER = Symbol.for(`${MODULE_ID}.attackSpeedCheckWrapper`);
const STRIKE_DISPLAY_WRAPPER = Symbol.for(`${MODULE_ID}.attackSpeedStrikeDisplayWrapper`);
const MODIFIER_TYPES = Object.freeze([
	"ability",
	"circumstance",
	"item",
	"potency",
	"proficiency",
	"status",
	"untyped"
]);
let AttackSpeedRuleElement = null;

function registerAttackSpeedLocalization() {
	const translations = game.i18n?.translations;
	if (!translations) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerAttackSpeedRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const registry = system?.RuleElements;
	const RuleElement = system?.RuleElement;
	const ResolvableValueField = registry?.builtin?.Resistance?.schema?.fields?.value?.constructor;
	const Predicate = system?.Predicate;
	if (!RuleElement || !registry?.custom || typeof ResolvableValueField !== "function" ||
		typeof Predicate !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system Rule Element API is unavailable`);
		return;
	}

	if (registry.custom[RULE_KEY]) {
		if (registry.custom[RULE_KEY] !== AttackSpeedRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	AttackSpeedRuleElement = class AttackSpeedRuleElement extends RuleElement {
		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({ required: true, nullable: false }),
				selector: new fields.StringField({ required: true, nullable: false, blank: false }),
				type: new fields.StringField({
					required: false,
					nullable: false,
					choices: MODIFIER_TYPES,
					initial: "untyped"
				})
			};
		}

		beforePrepareData() {
			if (this.ignored) return;

			const selector = this.resolveInjectedProperties(this.selector);
			const value = Number(this.resolveValue(this.value));
			const type = this.type ?? "untyped";
			if (!selector || !Number.isInteger(value) || !MODIFIER_TYPES.includes(type)) {
				this.failValidation("selector and a valid type must be provided, and value must resolve to an integer");
				return;
			}
			if (value === 0) return;

			let predicate;
			const test = rollOptions => {
				predicate ??= new Predicate(
					this.resolveInjectedProperties(foundry.utils.deepClone([...(this.predicate ?? [])]))
				);
				const options = rollOptions instanceof Set ? [...rollOptions] : rollOptions ?? [];
				return predicate.test([...options, ...this.item.getRollOptions("parent")]);
			};

			const synthetics = this.actor.synthetics;
			(synthetics.attackSpeeds ??= {})[selector] ??= [];
			const slug = `${MODULE_ID}-attack-speed-${selector}-${synthetics.attackSpeeds[selector].length}`;
			synthetics.attackSpeeds[selector].push({
				slug,
				value,
				type,
				label: this.label || this.item.name,
				test
			});
		}
	};

	registry.custom[RULE_KEY] = AttackSpeedRuleElement;
}

function getAttackSpeedContributions(actor, domains, rollOptions) {
	const domainSet = new Set(domains ?? []);
	const options = rollOptions instanceof Set ? rollOptions : new Set(rollOptions ?? []);
	const matching = [];
	for (const [selector, adjustments] of Object.entries(actor?.synthetics?.attackSpeeds ?? {})) {
		if (!domainSet.has(selector)) continue;
		for (const adjustment of adjustments) {
			if (adjustment.test(options)) {
				matching.push({ ...adjustment, type: adjustment.type ?? "untyped" });
			}
		}
	}

	const selected = matching.filter(adjustment => adjustment.type === "untyped");
	const typed = new Map();
	for (const adjustment of matching) {
		if (adjustment.type === "untyped") continue;
		const buckets = typed.get(adjustment.type) ?? { positive: null, negative: null };
		if (adjustment.type === "ability") {
			if (!buckets.ability || adjustment.value > buckets.ability.value) {
				buckets.ability = adjustment;
			}
		} else if (adjustment.value > 0) {
			if (!buckets.positive || adjustment.value > buckets.positive.value) {
				buckets.positive = adjustment;
			}
		} else if (adjustment.value < 0) {
			if (!buckets.negative || adjustment.value < buckets.negative.value) {
				buckets.negative = adjustment;
			}
		}
		typed.set(adjustment.type, buckets);
	}

	for (const buckets of typed.values()) {
		if (buckets.ability) {
			selected.push(buckets.ability);
		} else {
			if (buckets.positive) selected.push(buckets.positive);
			if (buckets.negative) selected.push(buckets.negative);
		}
	}
	return selected;
}

function getAttackSpeed(actor, domains, rollOptions) {
	return getAttackSpeedContributions(actor, domains, rollOptions)
		.reduce((total, adjustment) => total + adjustment.value, 0);
}

function getEffectiveAttackSpeedDelta(modifiers, contributions, mapIncreases, rollOptions) {
	if (!contributions.length || mapIncreases < 1) return 0;

	const system = game[game.system.id] ?? game.pf2e;
	const StatisticModifier = system?.StatisticModifier;
	const Modifier = system?.Modifier;
	if (typeof StatisticModifier !== "function" || typeof Modifier !== "function") {
		console.error(`${MODULE_ID} | Could not calculate typed ${RULE_KEY} display: PF2E modifier API is unavailable`);
		return 0;
	}

	const options = rollOptions instanceof Set ? rollOptions : new Set(rollOptions ?? []);
	const baseModifiers = modifiers.map(modifier => modifier.clone());
	const adjustedModifiers = [
		...modifiers.map(modifier => modifier.clone()),
		...contributions.map(contribution => new Modifier({
			slug: contribution.slug,
			label: contribution.label,
			modifier: contribution.value * mapIncreases,
			type: contribution.type
		}))
	];
	const baseTotal = new StatisticModifier("attack-speed-display", baseModifiers, options).totalModifier;
	const adjustedTotal = new StatisticModifier("attack-speed-display", adjustedModifiers, options).totalModifier;
	return adjustedTotal - baseTotal;
}

function getCheckMapModifier(check) {
	return [...(check?.modifiers ?? [])].reverse().find(modifier =>
		modifier.slug === "multiple-attack-penalty" ||
		modifier.slug?.startsWith("map-") ||
		modifier.label === game.i18n.localize("PF2E.MultipleAttackPenalty")
	);
}

function installAttackSpeedCheckWrapper({ quiet = false } = {}) {
	const checkApi = (game[game.system.id] ?? game.pf2e)?.Check;
	if (!checkApi || typeof checkApi.roll !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply spell Attack Speed: PF2E Check.roll is unavailable`);
		return;
	}
	if (checkApi[CHECK_WRAPPER]) return;

	if (typeof globalThis.libWrapper?.register !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply spell Attack Speed: libWrapper is unavailable`);
		return;
	}

	const wrapper = async function (wrapped, check, options = {}, event = null, callback) {
		const item = options.item;
		const mapIncreases = Number(options.mapIncreases ?? 0);
		const actor = options.actor ?? options.origin?.actor ?? check?.actor ??
			check?.statistic?.actor ?? item?.actor;
		const domains = options.domains ?? [];
		const contributions = getAttackSpeedContributions(actor, domains, options.options);
		const mapModifier = getCheckMapModifier(check);
		if (contributions.length === 0 || mapIncreases < 1 || !mapModifier ||
			!Number.isFinite(mapModifier.modifier)) {
			return wrapped(check, options, event, callback);
		}

		const Modifier = (game[game.system.id] ?? game.pf2e)?.Modifier;
		if (typeof Modifier !== "function" || typeof check.push !== "function" ||
			typeof check.calculateTotal !== "function") {
			console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: PF2E check modifier API is unavailable`);
			return wrapped(check, options, event, callback);
		}

		const rollOptions = options.options instanceof Set
			? options.options
			: new Set(options.options ?? []);
		const addedModifiers = [];
		try {
			contributions.forEach((contribution, index) => {
				const modifier = new Modifier({
					slug: contribution.slug ?? `${MODULE_ID}-attack-speed-${index}`,
					label: contribution.label,
					modifier: contribution.value * mapIncreases,
					type: contribution.type
				});
				check.push(modifier);
				addedModifiers.push(modifier);
			});
			check.calculateTotal(rollOptions);
			return await wrapped(check, options, event, callback);
		} finally {
			for (const modifier of addedModifiers) check.delete(modifier);
			check.calculateTotal(rollOptions);
		}
	};

	try {
		globalThis.libWrapper.register(MODULE_ID, `game.${game.system.id}.Check.roll`, wrapper, "WRAPPER");
		Object.defineProperty(checkApi, CHECK_WRAPPER, { value: true });
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to apply spell Attack Speed`, error);
	}
}

function installAttackSpeedStrikeDisplayWrapper({ quiet = false } = {}) {
	const actorClasses = new Set([
		CONFIG.Actor?.documentClass,
		...(game.actors?.contents ?? []).map(actor => actor.constructor)
	]);
	const prototypes = new Set();
	for (const actorClass of actorClasses) {
		let prototype = actorClass?.prototype;
		while (prototype && !Object.prototype.hasOwnProperty.call(prototype, "prepareStrike")) {
			prototype = Object.getPrototypeOf(prototype);
		}
		if (typeof prototype?.prepareStrike === "function") prototypes.add(prototype);
	}

	if (prototypes.size === 0) {
		if (!quiet) console.error(`${MODULE_ID} | Could not update strike MAP labels: PF2E Actor.prepareStrike is unavailable`);
		return;
	}

	const wrapper = function (wrapped, ...args) {
		const actor = this;
		const strike = wrapped(...args);
		if (!strike?.variants?.length || !Array.isArray(strike.domains)) return strike;
		const rollOptions = new Set([
			...actor.getRollOptions?.(strike.domains) ?? [],
			...strike.options ?? [],
			...strike.item?.getRollOptions?.("item") ?? []
		]);

		for (const mapIncreases of [1, 2]) {
			const variant = strike.variants[mapIncreases];
			const penaltyDescriptor = Object.getOwnPropertyDescriptor(variant, "penalty");
			const labelDescriptor = Object.getOwnPropertyDescriptor(variant, "label");
			if (variant[STRIKE_DISPLAY_WRAPPER] || typeof penaltyDescriptor?.get !== "function" ||
				typeof labelDescriptor?.get !== "function") continue;

			const getOriginalPenalty = penaltyDescriptor.get;
			const getOriginalLabel = labelDescriptor.get;
			Object.defineProperty(variant, STRIKE_DISPLAY_WRAPPER, { value: true });
			Object.defineProperty(variant, "label", {
				configurable: true,
				get() {
					const contributions = getAttackSpeedContributions(
						actor,
						strike.domains,
						rollOptions
					);
					if (contributions.length === 0) return getOriginalLabel.call(this);

					const baseTotal = strike.totalModifier;
					const delta = getEffectiveAttackSpeedDelta(
						strike.modifiers,
						contributions,
						mapIncreases,
						rollOptions
					);
					const basePenalty = getOriginalPenalty.call(this);
					const displayedPenalty = basePenalty + delta;
					const value = baseTotal + delta + basePenalty;
					if (displayedPenalty === 0) {
						return `${value >= 0 ? "+" : ""}${value}`;
					}
					return game.i18n.format("PF2E.MAPAbbreviationValueLabel", {
						value: `${value >= 0 ? "+" : ""}${value}`,
						penalty: `${displayedPenalty >= 0 ? "+" : ""}${displayedPenalty}`
					});
				}
			});
		}
		return strike;
	};

	for (const prototype of prototypes) {
		if (prototype[STRIKE_DISPLAY_WRAPPER]) continue;

		const original = prototype.prepareStrike;
		Object.defineProperty(prototype, "prepareStrike", {
			configurable: true,
			writable: true,
			value: function (...args) {
				return wrapper.call(this, original.bind(this), ...args);
			}
		});
		Object.defineProperty(prototype, STRIKE_DISPLAY_WRAPPER, { value: true });
	}
}

function updateSpellAttackMapButtons(message, html) {
	const root = html instanceof HTMLElement ? html : html?.[0];
	const card = root?.querySelector(".chat-card.item-card[data-actor-id][data-item-id]");
	if (!card) return;

	const actor = game.actors?.get(card.dataset.actorId) ?? message.speakerActor;
	const item = actor?.items?.get(card.dataset.itemId);
	const statistic = item?.spellcasting?.statistic;
	if (!actor || !item?.isOfType?.("spell") || !statistic) return;

	const domains = statistic.check?.domains ?? statistic.domains ?? ["spell-attack-roll"];
	const rollOptions = statistic.createRollOptions(domains, { item });
	const contributions = getAttackSpeedContributions(actor, domains, rollOptions);
	if (contributions.length === 0) return;

	for (const button of card.querySelectorAll(
		'.spell-attack-buttons button[data-action="spell-attack-2"], .spell-attack-buttons button[data-action="spell-attack-3"]'
	)) {
		const penaltyMatch = button.textContent.match(/-?\d+/);
		if (!penaltyMatch) {
			console.warn(`${MODULE_ID} | Could not update a spell MAP button because its penalty could not be read`);
			continue;
		}
		const mapAttackIndex = Number(button.dataset.action.match(/\d+$/)?.[0]) - 1;
		const mapDelta = contributions.reduce(
			(total, contribution) => total + contribution.value,
			0
		) * mapAttackIndex;
		button.dataset.vursBasePenalty ??= penaltyMatch[0];
		button.textContent = button.textContent.replace(
			penaltyMatch[0],
			String(Number(button.dataset.vursBasePenalty) + mapDelta)
		);
	}
}

Hooks.once("init", registerAttackSpeedLocalization);
Hooks.once("init", () => registerAttackSpeedRuleElement({ quiet: true }));
Hooks.once("setup", registerAttackSpeedRuleElement);
Hooks.once("setup", () => installAttackSpeedCheckWrapper({ quiet: true }));
Hooks.once("setup", () => installAttackSpeedStrikeDisplayWrapper({ quiet: true }));
Hooks.once("pf2e.systemReady", () => {
	registerAttackSpeedLocalization();
	registerAttackSpeedRuleElement();
	installAttackSpeedCheckWrapper();
	installAttackSpeedStrikeDisplayWrapper();
});
Hooks.once("sf2e.systemReady", registerAttackSpeedLocalization);
Hooks.once("ready", () => {
	registerAttackSpeedLocalization();
	registerAttackSpeedRuleElement();
	installAttackSpeedCheckWrapper();
	installAttackSpeedStrikeDisplayWrapper();
});
Hooks.on("renderChatMessageHTML", updateSpellAttackMapButtons);
