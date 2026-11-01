import { registerCheckRollWrapper } from "./checkRollWrappers.js";
import {
	getRuleElementPredicateOptions,
	isNpcActorSkillFormula,
	resolveRuleElementValue
} from "./ruleElementResolvers.js";
import {
	localizeRuleElementFormText,
	localizeRuleElementModifierTypes
} from "./ruleElementFormLocalization.js";
import { MODIFIER_TYPES, selectTypedModifiers } from "./typedModifiers.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Critical Rate";
const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const TOTAL_OPTION_PATTERN = /^check:total:(-?\d+(?:\.\d+)?)$/;
const MARGIN_OPTION_PATTERN = /^check:total:delta:(-?\d+(?:\.\d+)?)$/;
const NATURAL_OPTION_PATTERN = /^check:total:natural:(-?\d+|null)$/;
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
		static autogenForms = true;

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
					label: localizeRuleElementFormText("Common.Value", "Value")
				}),
				selector: new fields.StringField({
					required: true,
					nullable: false,
					blank: false,
					label: localizeRuleElementFormText("Common.Selector", "Selector")
				}),
				type: new fields.StringField({
					required: false,
					nullable: false,
					label: localizeRuleElementFormText("Common.ModifierType", "Modifier Type"),
					choices: localizeRuleElementModifierTypes(MODIFIER_TYPES),
					initial: "untyped"
				})
			};
		}

		beforePrepareData() {
			if (this.ignored) return;

			const selector = this.resolveInjectedProperties(this.selector);
			const deferredSkillFormula = isNpcActorSkillFormula(this, this.value);
			const value = deferredSkillFormula ? null : Number(this.resolveValue(this.value));
			const type = this.type ?? "untyped";
			if (!selector || (!deferredSkillFormula && !Number.isFinite(value)) ||
				!MODIFIER_TYPES.includes(type)) {
				this.failValidation("selector and a valid type must be provided, and value must resolve to a number");
				return;
			}
			if (value === 0) return;

			let predicate;
			const test = rollOptions => {
				predicate ??= new Predicate(
					this.resolveInjectedProperties(foundry.utils.deepClone([...(this.predicate ?? [])]))
				);
				return predicate.test(getRuleElementPredicateOptions(this.item, rollOptions));
			};

			(this.actor.synthetics.criticalRates ??= {})[selector] ??= [];
			this.actor.synthetics.criticalRates[selector].push({
				value: value ?? 0,
				resolveValue: deferredSkillFormula
					? () => Number(this.resolveValue(this.value))
					: null,
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
			if (!adjustment.test(options)) continue;
			const value = adjustment.resolveValue
				? adjustment.resolveValue()
				: adjustment.value;
			if (!Number.isFinite(value)) {
				console.error(`${MODULE_ID} | Could not resolve ${RULE_KEY} value for ${adjustment.label}`);
				continue;
			}
			if (value !== 0) matching.push({ ...adjustment, value });
		}
	}
	return selectTypedModifiers(matching);
}

function hasCriticalRateAdjustments(adjustments) {
	if (!adjustments) return false;
	for (const selector in adjustments) {
		if (Object.hasOwn(adjustments, selector) && adjustments[selector]?.length > 0) return true;
	}
	return false;
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

	const matching = protections.filter(protection =>
		protection.test?.(options) ??
			(!protection.definition || protection.definition.test(options))
	);
	const resolved = [];
	for (const protection of matching) {
		const value = protection.resolveValue
			? protection.resolveValue()
			: protection.value;
		if (!Number.isInteger(value)) {
			console.error(`${MODULE_ID} | Could not resolve Critical Protection value for ${protection.label}`);
			continue;
		}
		if (value !== 0) resolved.push({ ...protection, value });
	}
	return selectTypedModifiers(resolved);
}

function getBaseDegreeOfSuccess(total, dc, natural, criticalThreshold = 10) {
	const margin = total - dc;
	let degree = margin >= criticalThreshold ? 3 : margin <= -10 ? 0 : margin >= 0 ? 2 : 1;
	if (natural === 20) degree = Math.min(3, degree + 1);
	else if (natural === 1) degree = Math.max(0, degree - 1);
	return degree;
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

function getCriticalTooltipSources(context) {
	const directSources = context?.vursCriticalTooltipSources;
	if (Array.isArray(directSources) && directSources.length > 0) return directSources;

	const adjustments = context?.dosAdjustments;
	if (!adjustments || typeof adjustments !== "object") return [];
	return Object.values(adjustments)
		.flatMap(adjustment => Array.isArray(adjustment?.tooltipSources) ? adjustment.tooltipSources : []);
}

function deferNativeAdjustmentTooltip(element) {
	if (element.dataset.vursDeferredTooltip) return;
	const text = element.dataset.tooltip;
	if (!text) return;

	element.dataset.vursDeferredTooltip = text;
	element.removeAttribute("data-tooltip");
	let timeout;
	element.addEventListener("pointerenter", () => {
		window.clearTimeout(timeout);
		timeout = window.setTimeout(() => {
			if (element.matches(":hover") && game.tooltip) {
				game.tooltip.activate(element, { text });
			}
		}, 600);
	});
	element.addEventListener("pointerleave", () => {
		window.clearTimeout(timeout);
		if (game.tooltip?.element === element) game.tooltip.deactivate();
	});
}

function updateCriticalSourceTooltip(message, html) {
	const root = html instanceof HTMLElement ? html : html?.[0];
	if (!root) return;

	const context = message?.flags?.[game.system.id]?.context;
	const sources = getCriticalTooltipSources(context);
	for (const result of root.querySelectorAll(".target-dc-result .result.degree-of-success")) {
		for (const adjusted of result.querySelectorAll(".adjusted[data-tooltip]")) {
			if (sources.length > 0) {
				adjusted.removeAttribute("data-tooltip");
				delete adjusted.dataset.vursDeferredTooltip;
			} else {
				deferNativeAdjustmentTooltip(adjusted);
			}
		}
	}
	if (sources.length === 0) return;

	const jq = globalThis.jQuery ?? globalThis.$;
	if (typeof jq !== "function" || typeof jq.fn?.tooltipster !== "function") return;

	for (const result of root.querySelectorAll(".target-dc-result .result.degree-of-success")) {
		if (result.classList.contains("tooltipstered")) continue;

		const tooltip = document.createElement("div");
		tooltip.className = "hover-content modifiers-tooltip vurs-modifier-tooltip";
		const title = document.createElement("div");
		title.className = "sidebar_title";
		const heading = document.createElement("h2");
		heading.textContent = "Critical Threshold";
		title.append(heading);
		tooltip.append(title);

		const list = document.createElement("ul");
		list.className = "modifier-list";
		for (const source of sources) {
			const item = document.createElement("li");
			item.className = "item";
			if (Number.isFinite(Number(source.value))) {
				const amount = document.createElement("span");
				amount.className = "data";
				const delta = Number(source.value) * (source.group === "protection" ? -1 : 1);
				amount.textContent = `${delta >= 0 ? "+" : ""}${delta}`;
				item.append(amount);
			}
			const sourceLabel = document.createElement("span");
			sourceLabel.className = "label";
			sourceLabel.textContent = source.label ?? "";
			const type = document.createElement("small");
			type.className = "tag-legacy";
			type.textContent = game.i18n.localize(`PF2E.ModifierType.${source.type ?? "untyped"}`);
			item.append(sourceLabel, type);
			list.append(item);
		}
		tooltip.append(list);

		jq(result).tooltipster({
			trigger: "hover",
			arrow: false,
			contentAsHTML: true,
			debug: false,
			side: ["top", "bottom"],
			theme: "crb-hover",
			content: tooltip
		});
	}
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
			let total = null;
			let margin = null;
			let naturalToken = null;
			for (const option of postRollOptions ?? []) {
				let match = TOTAL_OPTION_PATTERN.exec(option);
				if (match && total === null) {
					total = Number(match[1]);
					continue;
				}
				match = MARGIN_OPTION_PATTERN.exec(option);
				if (match && margin === null) {
					margin = Number(match[1]);
					continue;
				}
				match = NATURAL_OPTION_PATTERN.exec(option);
				if (match && naturalToken === null) naturalToken = match[1];
				if (total !== null && margin !== null && naturalToken !== null) break;
			}
			if (total === null || margin === null || naturalToken === null) return false;

			const natural = naturalToken === "null" ? null : Number(naturalToken);
			const protectionAdjustments = getCriticalProtection(target, {
				domains,
				rollOptions,
				total,
				dc,
				natural
			});
			const criticalSources = [
				...rateAdjustments.map(source => ({
					group: "rate",
					value: source.value,
					type: source.type ?? "untyped",
					label: source.label
				})),
				...protectionAdjustments.map(source => ({
					group: "protection",
					value: source.value,
					type: source.type ?? "untyped",
					label: source.label
				}))
			];
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

			tooltipSources.splice(0, tooltipSources.length, ...criticalSources);
			combinedAdjustments = {
				all: {
					label: "Critical Threshold",
					amount: OUTCOMES[adjustedDegree],
					tooltipSources: criticalSources
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
		const target = options.target?.actor ?? null;
		const criticalRates = actor?.synthetics?.criticalRates;
		const hasRateEntries = hasCriticalRateAdjustments(criticalRates);
		const hasProtections = (target?.synthetics?.criticalProtections?.length ?? 0) > 0;
		if (!hasRateEntries && !hasProtections) {
			return wrapped(check, options, event, callback);
		}

		const domains = options.domains ?? [];
		const rollOptions = options.options instanceof Set
			? options.options
			: hasRateEntries
				? new Set(options.options ?? [])
				: options.options ?? [];
		const rateAdjustments = hasRateEntries ? getCriticalRate(actor, domains, rollOptions) : [];
		if (rateAdjustments.length === 0 && !hasProtections) {
			return wrapped(check, options, event, callback);
		}

		const dc = Number(options.dc?.value ?? options.dc);
		if (!Number.isFinite(dc)) return wrapped(check, options, event, callback);

		const existingAdjustments = [...(options.dosAdjustments ?? [])];
		const contextOptions = {
			...options,
			dosAdjustments: [...existingAdjustments],
			vursCriticalTooltipSources: []
		};
		contextOptions.dosAdjustments.push(createCriticalAdjustmentEntry({
			dc,
			domains,
			rateAdjustments,
			target,
			rollOptions,
			existingAdjustments,
			tooltipSources: contextOptions.vursCriticalTooltipSources
		}));
		return wrapped(check, contextOptions, event, callback);
	};

	registerCheckRollWrapper("critical-rate", wrapper, { quiet });
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
