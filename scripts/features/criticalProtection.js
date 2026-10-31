import { MODIFIER_TYPES } from "./typedModifiers.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Critical Protection";
let CriticalProtectionRuleElement = null;

function registerCriticalProtectionLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has(`PF2E.RuleElement.${RULE_KEY}`)) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerCriticalProtectionRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const registry = system?.RuleElements;
	const RuleElement = system?.RuleElement;
	const ResolvableValueField = registry?.builtin?.Resistance?.schema?.fields?.value?.constructor;
	const PredicateField = registry?.builtin?.Immunity?.schema?.fields?.definition?.constructor;
	if (!RuleElement || !registry?.custom || typeof ResolvableValueField !== "function" ||
		typeof PredicateField !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system Rule Element API is unavailable`);
		return;
	}

	if (registry.custom[RULE_KEY]) {
		if (registry.custom[RULE_KEY] !== CriticalProtectionRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	CriticalProtectionRuleElement = class CriticalProtectionRuleElement extends RuleElement {
		static defineSchema() {
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({ required: true, nullable: false }),
				type: new foundry.data.fields.StringField({
					required: false,
					nullable: false,
					choices: MODIFIER_TYPES,
					initial: "untyped"
				}),
				definition: new PredicateField({ required: false, initial: undefined })
			};
		}

		beforePrepareData() {
			if (this.ignored) return;

			const value = Number(this.resolveValue(this.value));
			const type = this.type ?? "untyped";
			if (!Number.isInteger(value) || value < 0 || !MODIFIER_TYPES.includes(type)) {
				this.failValidation("value must resolve to a non-negative integer and type must be valid");
				return;
			}
			if (value === 0) return;

			const definition = this.definition
				? this.resolveInjectedProperties(this.definition)
				: null;
			(this.actor.synthetics.criticalProtections ??= []).push({
				value,
				type,
				label: this.label || this.item.name,
				definition
			});
		}
	};

	registry.custom[RULE_KEY] = CriticalProtectionRuleElement;
}

function initializeCriticalProtection() {
	registerCriticalProtectionLocalization();
	registerCriticalProtectionRuleElement();
}

Hooks.once("init", registerCriticalProtectionLocalization);
Hooks.once("init", () => registerCriticalProtectionRuleElement({ quiet: true }));
Hooks.once("setup", registerCriticalProtectionRuleElement);
Hooks.once("pf2e.systemReady", initializeCriticalProtection);
Hooks.once("sf2e.systemReady", initializeCriticalProtection);
Hooks.once("ready", initializeCriticalProtection);
