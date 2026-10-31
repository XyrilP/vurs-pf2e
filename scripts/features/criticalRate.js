const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Critical Rate";
const CHECK_WRAPPER = Symbol.for(`${MODULE_ID}.criticalRateCheckWrapper`);
const ROLL_PATCH = Symbol.for(`${MODULE_ID}.criticalRateRollPatch`);
const activeChecks = [];
let CriticalRateRuleElement = null;

function registerCriticalRateLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has(`PF2E.RuleElement.${RULE_KEY}`)) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerCriticalRateRuleElement({ quiet = false } = {}) {
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
		if (registry.custom[RULE_KEY] !== CriticalRateRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	CriticalRateRuleElement = class CriticalRateRuleElement extends RuleElement {
		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({ required: true, nullable: false }),
				selector: new fields.StringField({ required: true, nullable: false, blank: false })
			};
		}

		beforePrepareData() {
			if (this.ignored) return;

			const selector = this.resolveInjectedProperties(this.selector);
			const value = Number(this.resolveValue(this.value));
			if (!selector || !Number.isFinite(value)) {
				this.failValidation("selector must be provided and value must resolve to a number");
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

			(this.actor.synthetics.criticalRates ??= {})[selector] ??= [];
			this.actor.synthetics.criticalRates[selector].push({ value, test });
		}
	};

	registry.custom[RULE_KEY] = CriticalRateRuleElement;
}

function getCheckActor(check, options) {
	return options.actor ?? options.origin?.actor ?? check?.actor ?? check?.statistic?.actor ??
		check?.parent?.actor ?? options.item?.actor ?? null;
}

function getCriticalRate(actor, domains, rollOptions) {
	const domainSet = new Set(domains ?? []);
	const options = rollOptions instanceof Set ? rollOptions : new Set(rollOptions ?? []);
	let value = 0;
	for (const [selector, adjustments] of Object.entries(actor?.synthetics?.criticalRates ?? {})) {
		if (!domainSet.has(selector)) continue;
		for (const adjustment of adjustments) {
			if (adjustment.test(options)) value += adjustment.value;
		}
	}
	return value;
}

function getCriticalProtection(actor, { domains, ...options }) {
	const protections = actor?.synthetics?.criticalProtections ?? [];
	if (protections.length === 0) return 0;

	const rollOptions = new Set([
		...actor.getRollOptions?.(domains ?? []) ?? [],
		...options.rollOptions
	]);
	const total = options.roll.total;
	const dc = options.dc;
	const natural = options.natural;
	rollOptions.add(`check:total:${total}`);
	rollOptions.add(`check:total:natural:${natural}`);
	rollOptions.add(`check:roll:total:natural:${natural}`);
	rollOptions.add(`check:total:delta:${total - dc}`);

	return protections.reduce((value, protection) => {
		if (!protection.definition || protection.definition.test(rollOptions)) {
			return value + protection.value;
		}
		return value;
	}, 0);
}

function getBaseDegreeOfSuccess(total, dc, natural, criticalThreshold = 10) {
	const margin = total - dc;
	let degree = margin >= criticalThreshold ? 3 : margin <= -10 ? 0 : margin >= 0 ? 2 : 1;
	if (natural === 20) degree = Math.min(3, degree + 1);
	else if (natural === 1) degree = Math.max(0, degree - 1);
	return degree;
}

function applyCriticalAdjustments(roll, context) {
	const dc = context.options.dc?.value;
	if (!Number.isFinite(dc)) return;

	const natural = roll.dice
		.map(die => die.results.find(result => result.active && !result.discarded)?.result ?? null)
		.find(Number.isFinite);
	const total = roll.total;
	const baseDegree = getBaseDegreeOfSuccess(total, dc, natural);
	const protection = getCriticalProtection(context.target, {
		domains: context.domains,
		dc,
		natural,
		roll: { total },
		rollOptions: context.rollOptions
	});

	const threshold = 10 - context.threshold + protection;
	const degree = getBaseDegreeOfSuccess(total, dc, natural, threshold);

	const amount = degree - baseDegree;
	if (amount === 0) return;

	const outcome = ["criticalFailure", "failure", "success", "criticalSuccess"][baseDegree];
	context.options.dosAdjustments.push({
		adjustments: {
			[outcome]: {
				label: [
					context.threshold !== 0 ? RULE_KEY : null,
					protection > 0 ? "Critical Protection" : null
				].filter(Boolean).join(" / "),
				amount
			}
		}
	});
}

function installCriticalRateRollPatch({ quiet = false } = {}) {
	const Roll = foundry.dice?.Roll ?? globalThis.Roll;
	const prototype = Roll?.prototype;
	const originalEvaluate = prototype?.evaluate;
	if (typeof originalEvaluate !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: the Roll API is unavailable`);
		return;
	}
	if (prototype[ROLL_PATCH]) return;

	prototype.evaluate = async function (...args) {
		const result = await originalEvaluate.apply(this, args);
		const context = activeChecks.at(-1);
		if (this.constructor?.name === "CheckRoll" && context) applyCriticalAdjustments(this, context);
		return result;
	};
	Object.defineProperty(prototype, ROLL_PATCH, { value: true });
}

function installCriticalRateCheckWrapper({ quiet = false } = {}) {
	const checkApi = (game[game.system.id] ?? game.pf2e)?.Check;
	if (!checkApi || typeof checkApi.roll !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: PF2E Check.roll is unavailable`);
		return;
	}
	if (checkApi[CHECK_WRAPPER]) return;

	if (typeof globalThis.libWrapper?.register !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: libWrapper is unavailable`);
		return;
	}

	const wrapper = async function (wrapped, check, options = {}, event = null, callback) {
		const actor = getCheckActor(check, options);
		const domains = options.domains ?? [];
		const rollOptions = options.options instanceof Set ? options.options : new Set(options.options ?? []);
		const threshold = getCriticalRate(actor, domains, rollOptions);
		const target = options.target?.actor ?? null;
		if (threshold === 0 && !target?.synthetics?.criticalProtections?.length) {
			return wrapped(check, options, event, callback);
		}

		const contextOptions = {
			...options,
			dosAdjustments: [...(options.dosAdjustments ?? [])]
		};
		const context = { options: contextOptions, threshold, target, domains, rollOptions };
		activeChecks.push(context);
		try {
			return await wrapped(check, contextOptions, event, callback);
		} finally {
			const index = activeChecks.lastIndexOf(context);
			if (index >= 0) activeChecks.splice(index, 1);
		}
	};

	try {
		globalThis.libWrapper.register(MODULE_ID, `game.${game.system.id}.Check.roll`, wrapper, "WRAPPER");
		Object.defineProperty(checkApi, CHECK_WRAPPER, { value: true });
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to apply ${RULE_KEY}`, error);
	}
}

function initializeCriticalRate() {
	registerCriticalRateLocalization();
	registerCriticalRateRuleElement();
	installCriticalRateRollPatch();
	installCriticalRateCheckWrapper();
}

Hooks.once("init", registerCriticalRateLocalization);
Hooks.once("init", () => registerCriticalRateRuleElement({ quiet: true }));
Hooks.once("setup", registerCriticalRateRuleElement);
Hooks.once("setup", () => {
	installCriticalRateRollPatch({ quiet: true });
	installCriticalRateCheckWrapper({ quiet: true });
});
Hooks.once("pf2e.systemReady", initializeCriticalRate);
Hooks.once("sf2e.systemReady", initializeCriticalRate);
Hooks.once("ready", initializeCriticalRate);
