import { registerCheckRollWrapper } from "./checkRollWrappers.js";
import { MODIFIER_TYPES, selectTypedModifiers } from "./typedModifiers.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Critical Rate";
const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];
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
			if (!selector || !Number.isFinite(value) || !MODIFIER_TYPES.includes(type)) {
				this.failValidation("selector and a valid type must be provided, and value must resolve to a number");
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
			this.actor.synthetics.criticalRates[selector].push({
				value,
				type,
				label: this.label || this.item.name,
				test
			});
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
	const matching = [];
	for (const [selector, adjustments] of Object.entries(actor?.synthetics?.criticalRates ?? {})) {
		if (!domainSet.has(selector)) continue;
		for (const adjustment of adjustments) {
			if (adjustment.test(options)) matching.push(adjustment);
		}
	}
	return selectTypedModifiers(matching);
}

function getCriticalProtection(actor, { domains, rollOptions, total, dc, natural }) {
	const protections = actor?.synthetics?.criticalProtections ?? [];
	if (protections.length === 0) return [];

	const options = new Set([
		...actor.getRollOptions?.(domains ?? []) ?? [],
		...(rollOptions ?? [])
	]);
	options.add(`check:total:${total}`);
	options.add(`check:total:natural:${natural}`);
	options.add(`check:roll:total:natural:${natural}`);
	options.add(`check:total:delta:${total - dc}`);

	return selectTypedModifiers(protections.filter(protection =>
		!protection.definition || protection.definition.test(options)
	));
}

function getBaseDegreeOfSuccess(total, dc, natural, criticalThreshold = 10) {
	const margin = total - dc;
	let degree = margin >= criticalThreshold ? 3 : margin <= -10 ? 0 : margin >= 0 ? 2 : 1;
	if (natural === 20) degree = Math.min(3, degree + 1);
	else if (natural === 1) degree = Math.max(0, degree - 1);
	return degree;
}

function getRollOptionNumber(options, expression) {
	for (const option of options) {
		const match = expression.exec(option);
		if (match) return Number(match[1]);
	}
	return null;
}

function getExistingDegreeAdjustments(entries, postRollOptions, rollOptions) {
	const adjustments = {};
	for (const entry of entries) {
		if (!entry) continue;
		const options = entry.options
			? new Set([...postRollOptions, ...entry.options])
			: new Set([...postRollOptions, ...rollOptions]);
		if (!(entry.predicate?.test(options) ?? true)) continue;
		for (const outcome of ["all", ...OUTCOMES]) {
			if (entry.adjustments?.[outcome]) {
				adjustments[outcome] = foundry.utils.deepClone(entry.adjustments[outcome]);
			}
		}
	}
	return adjustments;
}

function getDegreeAdjustment(degree, adjustments) {
	for (const outcome of ["all", ...OUTCOMES]) {
		const adjustment = adjustments[outcome];
		if (!adjustment?.label || !adjustment.amount) continue;
		if (degree === 3 && adjustment.amount === 1) continue;
		if (degree === 0 && adjustment.amount === -1) continue;
		if (outcome === "all" || OUTCOMES.indexOf(outcome) === degree) return adjustment;
	}
	return null;
}

function applyDegreeAdjustment(degree, adjustment) {
	if (!adjustment) return degree;
	if (typeof adjustment.amount === "string") {
		const adjustedDegree = OUTCOMES.indexOf(adjustment.amount);
		return adjustedDegree >= 0 ? adjustedDegree : degree;
	}
	return Math.clamp(degree + adjustment.amount, 0, 3);
}

function createCriticalAdjustmentEntry({
	dc,
	domains,
	rateAdjustments,
	target,
	rollOptions,
	existingAdjustments,
	tooltipSources
}) {
	let combinedAdjustments = {};
	const predicate = {
		test(postRollOptions) {
			const total = getRollOptionNumber(postRollOptions, /^check:total:(-?\d+(?:\.\d+)?)$/);
			const margin = getRollOptionNumber(postRollOptions, /^check:total:delta:(-?\d+(?:\.\d+)?)$/);
			const naturalToken = [...postRollOptions]
				.map(option => /^check:total:natural:(-?\d+|null)$/.exec(option))
				.find(Boolean);
			if (total === null || margin === null || !naturalToken) return false;

			const natural = naturalToken[1] === "null" ? null : Number(naturalToken[1]);
			const protectionAdjustments = getCriticalProtection(target, {
				domains,
				rollOptions,
				total,
				dc,
				natural
			});
			const rate = rateAdjustments.reduce((sum, adjustment) => sum + adjustment.value, 0);
			const protection = protectionAdjustments.reduce((sum, adjustment) => sum + adjustment.value, 0);
			const netRate = rate - protection;

			const baseDegree = getBaseDegreeOfSuccess(total, dc, natural);
			const rateAdjustedDegree = getBaseDegreeOfSuccess(total, dc, natural, 10 - rate);
			const netAdjustedDegree = getBaseDegreeOfSuccess(total, dc, natural, 10 - netRate);
			if (baseDegree === rateAdjustedDegree && baseDegree === netAdjustedDegree) return false;

			const currentAdjustments = getExistingDegreeAdjustments(
				existingAdjustments,
				postRollOptions,
				rollOptions
			);
			const currentAdjustment = getDegreeAdjustment(baseDegree, currentAdjustments);
			const currentDegree = applyDegreeAdjustment(baseDegree, currentAdjustment);
			const adjustedDegree = netRate === 0
				? currentDegree
				: Math.clamp(currentDegree + netAdjustedDegree - baseDegree, 0, 3);
			const rateCounteracted = rateAdjustedDegree !== baseDegree && netAdjustedDegree === baseDegree;
			if (adjustedDegree === currentDegree && !rateCounteracted) return false;

			const rateSources = [...new Set(rateAdjustments.map(adjustment => adjustment.label).filter(Boolean))];
			const protectionSources = [...new Set(protectionAdjustments.map(adjustment => adjustment.label).filter(Boolean))];
			const sources = [
				...rateAdjustments.map(({ label, type, value }) => ({ label, type: type ?? "untyped", value })),
				...protectionAdjustments.map(({ label, type, value }) => ({ label, type: type ?? "untyped", value: -value }))
			].filter(source => source.label);
			tooltipSources.splice(0, tooltipSources.length, ...sources);
			const formatSources = sources => sources.length > 1
				? `(${sources.join(", ")})`
				: sources[0] ?? null;
			const sourceCredit = [
				formatSources(rateSources),
				formatSources(protectionSources)
			].filter(Boolean).join(" - ");
			const labels = [currentAdjustment?.label, sourceCredit].filter(Boolean);

			combinedAdjustments = {
				all: {
					label: labels.join(" / "),
					amount: OUTCOMES[adjustedDegree],
					tooltipSources
				}
			};
			return true;
		}
	};

	return {
		predicate,
		get adjustments() {
			return combinedAdjustments;
		}
	};
}

function installCriticalRateCheckWrapper({ quiet = false } = {}) {
	const checkApi = (game[game.system.id] ?? game.pf2e)?.Check;
	if (!checkApi || typeof checkApi.roll !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: PF2E Check.roll is unavailable`);
		return;
	}
	const wrapper = async function (wrapped, check, options = {}, event = null, callback) {
		const actor = getCheckActor(check, options);
		const domains = options.domains ?? [];
		const rollOptions = options.options instanceof Set ? options.options : new Set(options.options ?? []);
		const rateAdjustments = getCriticalRate(actor, domains, rollOptions);
		const target = options.target?.actor ?? null;
		if (rateAdjustments.length === 0 && !target?.synthetics?.criticalProtections?.length) {
			return wrapped(check, options, event, callback);
		}

		const dc = Number(options.dc?.value ?? options.dc);
		if (!Number.isFinite(dc)) return wrapped(check, options, event, callback);

		const existingAdjustments = [...(options.dosAdjustments ?? [])];
		const tooltipSources = [];
		const contextOptions = {
			...options,
			dosAdjustments: [...existingAdjustments],
			vursCriticalTooltipSources: tooltipSources
		};
		contextOptions.dosAdjustments.push(createCriticalAdjustmentEntry({
			dc,
			domains,
			rateAdjustments,
			target,
			rollOptions,
			existingAdjustments,
			tooltipSources
		}));
		return wrapped(check, contextOptions, event, callback);
	};

	registerCheckRollWrapper("critical-rate", wrapper, { quiet });
}

function updateCriticalSourceTooltip(message, html) {
	const root = html instanceof HTMLElement ? html : html?.[0];
	const jq = globalThis.jQuery ?? globalThis.$;
	const context = message.flags?.pf2e?.context;
	let sources = context?.vursCriticalTooltipSources ?? context?.dosAdjustments?.all?.tooltipSources;
	const result = root?.querySelector(".target-dc-result .result.degree-of-success");
	if (!result || !Array.isArray(sources) || sources.length === 0 ||
		typeof jq !== "function" || typeof jq.fn?.tooltipster !== "function" ||
		result.classList.contains("tooltipstered")) return;

	if (sources.some(source => !Number.isFinite(source.value))) {
		const actor = game.actors.get(context.actor) ?? globalThis.fromUuidSync?.(context.origin?.actor);
		const target = context.target?.actor ? globalThis.fromUuidSync?.(context.target.actor) : null;
		const domains = context.domains ?? [];
		const rollOptions = new Set(context.options ?? []);
		const rateSources = getCriticalRate(actor, domains, rollOptions)
			.map(({ label, type, value }) => ({ label, type: type ?? "untyped", value }));
		const postRollOptions = context.contextualOptions?.postRoll ?? [];
		const total = getRollOptionNumber(postRollOptions, /^check:total:(-?\d+(?:\.\d+)?)$/);
		const natural = getRollOptionNumber(postRollOptions, /^check:total:natural:(-?\d+)$/);
		const dc = Number(context.dc?.value);
		const protectionSources = target && Number.isFinite(total) && Number.isFinite(dc)
			? getCriticalProtection(target, {
				domains,
				rollOptions,
				total,
				dc,
				natural
			}).map(({ label, type, value }) => ({ label, type: type ?? "untyped", value: -value }))
			: [];
		const resolvedSources = [...rateSources, ...protectionSources];
		sources = sources.map(source => {
			const index = resolvedSources.findIndex(candidate =>
				candidate.label === source.label && candidate.type === (source.type ?? "untyped")
			);
			return index >= 0 ? resolvedSources.splice(index, 1)[0] : source;
		});
	}
	sources = sources.filter(source => Number.isFinite(source.value));
	if (sources.length === 0) return;

	const tooltip = document.createElement("div");
	tooltip.className = "hover-content modifiers-tooltip vurs-modifier-tooltip";
	const title = document.createElement("div");
	title.className = "sidebar_title";
	const heading = document.createElement("h2");
	heading.textContent = `${game.i18n.localize("PF2E.RuleElement.Critical Rate")} / ${game.i18n.localize("PF2E.RuleElement.Critical Protection")}`;
	title.append(heading);
	const list = document.createElement("ul");
	list.className = "modifier-list";
	for (const source of sources) {
		const entry = document.createElement("li");
		entry.className = "item";
		const amount = document.createElement("span");
		amount.className = "data";
		amount.textContent = `${source.value >= 0 ? "+" : ""}${source.value}`;
		const label = document.createElement("span");
		label.className = "label";
		label.textContent = source.label === RULE_KEY || source.label === "Critical Protection"
			? game.i18n.localize(`PF2E.RuleElement.${source.label}`)
			: source.label;
		const type = document.createElement("small");
		type.className = "tag-legacy";
		const typeKey = `PF2E.ModifierType.${source.type ?? "untyped"}`;
		type.textContent = game.i18n.localize(typeKey) === typeKey
			? source.type ?? "untyped"
			: game.i18n.localize(typeKey);
		entry.append(amount, label, type);
		list.append(entry);
	}
	tooltip.append(title, list);

	jq(result).tooltipster({
		trigger: "hover",
		arrow: false,
		contentAsHTML: true,
		debug: false,
		side: ["top", "bottom"],
		theme: "crb-hover",
		functionReady(instance, helper) {
			expandCriticalTooltip(helper);
		},
		content: tooltip
	});
}

function expandCriticalTooltip(helper) {
	const root = helper.tooltip instanceof HTMLElement ? helper.tooltip : helper.tooltip?.[0];
	if (!root) return;
	for (const element of [root, ...root.querySelectorAll(".tooltipster-box, .tooltipster-content")]) {
		element.style.setProperty("max-height", "none", "important");
		element.style.setProperty("height", "auto", "important");
		element.style.setProperty("overflow", "visible", "important");
	}
}

function initializeCriticalRate() {
	registerCriticalRateLocalization();
	registerCriticalRateRuleElement();
	installCriticalRateCheckWrapper();
}

Hooks.once("init", registerCriticalRateLocalization);
Hooks.once("init", () => registerCriticalRateRuleElement({ quiet: true }));
Hooks.once("setup", registerCriticalRateRuleElement);
Hooks.once("setup", () => installCriticalRateCheckWrapper({ quiet: true }));
Hooks.once("pf2e.systemReady", initializeCriticalRate);
Hooks.once("sf2e.systemReady", initializeCriticalRate);
Hooks.once("ready", initializeCriticalRate);
Hooks.on("renderChatMessageHTML", updateCriticalSourceTooltip);
