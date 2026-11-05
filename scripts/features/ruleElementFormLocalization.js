const RULE_ELEMENT_FORM_TRANSLATIONS = {
	Common: {
		Value: "Value",
		Selector: "Selector",
		Mode: "Mode",
		ModifierType: "Modifier Type",
		BeforeReduction: "Calculate Before Reduction",
		DefaultWhenOmitted: "When omitted: {value}",
		RequiredWithoutDefault: "Required: enter a value; no default is provided.",
		Modes: {
			Threshold: "Threshold",
			Flat: "Flat",
			Percent: "Percent"
		}
	},
	CriticalProtection: {
		Definition: "Definition",
		DefinitionPlaceholder: "No condition (always applies)"
	},
	HealingEffectiveness: {
		Threshold: "Healing Effectiveness Threshold"
	},
	Lifesteal: {
		Threshold: "Lifesteal Threshold"
	},
	DamageReturn: {
		Threshold: "Damage Return Threshold",
		ReflectDamage: "Reflect Damage"
	},
	CollateralDamage: {
		AreaType: "Area Shape",
		AreaTypes: {
			burst: "Burst",
			cone: "Cone",
			cube: "Cube",
			cylinder: "Cylinder",
			emanation: "Emanation",
			line: "Line",
			ring: "Ring",
			square: "Square",
			bounce: "Bounce"
		},
		Tabs: {
			General: "General",
			Area: "Area",
			Damage: "Damage",
			Bounce: "Bounce"
		},
		Distance: "Distance",
		Within: "Within",
		NoLimit: "No limit",
		Width: "Width",
		Threshold: "Collateral Damage Threshold",
		BounceShots: "Bounce Shots",
		BounceCount: "Bounce Count",
		BounceLimit: "Bounce Limit",
		BounceNearest: "Bounce to Nearest",
		Affects: "Affects",
		AffectsTypes: {
			Allied: "Allied",
			Neutral: "Neutral",
			Hostile: "Hostile",
			All: "All"
		},
		AffectsSelf: "Affects Self",
		Divided: "Divide Damage",
		AreaDamage: "Area Damage",
		DamageType: "Damage Type",
		SourceDamageType: "Use source damage type",
		Placement: "Placement",
		Placements: {
			Target: "Target",
			Self: "Self"
		}
	}
};
const VURS_CUSTOM_RULE_ELEMENT_KEYS = new Set([
	"Attack Speed",
	"Critical Rate",
	"Critical Protection",
	"Healing Effectiveness",
	"Lifesteal",
	"Damage Return",
	"Collateral Damage"
]);

function registerRuleElementFormTranslations(entries, prefix) {
	const translations = game.i18n?.translations;
	if (!translations) return;

	for (const [key, value] of Object.entries(entries)) {
		const path = `${prefix}.${key}`;
		if (value && typeof value === "object") {
			registerRuleElementFormTranslations(value, path);
		} else if (!game.i18n.has(path)) {
			foundry.utils.setProperty(translations, path, value);
		}
	}
}

export function registerRuleElementFormLocalization() {
	registerRuleElementFormTranslations(RULE_ELEMENT_FORM_TRANSLATIONS, "VURS.RuleElements");
}

export function localizeRuleElementFormText(key, fallback) {
	registerRuleElementFormLocalization();
	const localizationKey = `VURS.RuleElements.${key}`;
	const localized = game.i18n.localize(localizationKey);
	return localized === localizationKey ? fallback : localized;
}

export function localizeRuleElementModifierTypes(types) {
	return Object.fromEntries(types.map(type => {
		const key = `PF2E.ModifierType.${type}`;
		const localized = game.i18n.localize(key);
		return [type, localized === key ? type : localized];
	}));
}

function addRuleElementFormHints(app, html) {
	const root = html?.[0] ?? html;
	if (!root?.querySelectorAll) return;

	const system = game[game.system.id] ?? game.pf2e;
	for (const form of root.querySelectorAll(".rule-form[data-key]")) {
		const schema = system?.RuleElements?.all?.[form.dataset.key]?.schema;
		if (!schema) continue;
		const isVursCustomRuleElement = VURS_CUSTOM_RULE_ELEMENT_KEYS.has(form.dataset.key);

		for (const input of form.querySelectorAll("[name^='system.rules.']")) {
			const fieldName = input.name.split(".").at(-1);
			const field = schema.fields?.[fieldName];
			if (!field) continue;
			const placeholder = field.placeholder;

			if (placeholder !== null && placeholder !== undefined && placeholder !== "") {
				if (input instanceof HTMLSelectElement) {
					const blankOption = input.querySelector('option[value=""]');
					if (blankOption) blankOption.textContent = game.i18n.format(
						"VURS.RuleElements.Common.DefaultWhenOmitted",
						{ value: placeholder }
					);
				} else if (input instanceof HTMLInputElement && input.type === "checkbox") {
					const group = input.closest(".form-group");
					if (group && group.dataset.vursDefaultHint !== "true") {
						const hint = document.createElement("p");
						hint.className = "hint";
						hint.textContent = game.i18n.format(
							"VURS.RuleElements.Common.DefaultWhenOmitted",
							{ value: placeholder }
						);
						group.append(hint);
						group.dataset.vursDefaultHint = "true";
					}
				} else if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
					input.placeholder = String(placeholder);
				}
			}

			const hasDefault = (
				field.initial !== undefined &&
				(field.initial !== null || field.nullable === true) &&
				field.initial !== ""
			) || (placeholder !== null && placeholder !== undefined && placeholder !== "");
			if (
				!isVursCustomRuleElement ||
				field.required !== true ||
				hasDefault ||
				(input instanceof HTMLInputElement && input.type === "hidden")
			) {
				continue;
			}

			const group = input.closest(".form-group");
			if (!group) continue;
			let warning = group.querySelector(":scope > .vurs-required-field-warning");
			if (!warning) {
				warning = document.createElement("p");
				warning.className = "hint warning vurs-required-field-warning";
				warning.setAttribute("aria-live", "polite");
				warning.textContent = game.i18n.localize("VURS.RuleElements.Common.RequiredWithoutDefault");
				group.append(warning);
			}

			const updateRequiredFieldWarning = () => {
				const value = input instanceof HTMLInputElement && input.type === "checkbox"
					? String(input.checked)
					: String(input.value ?? "").trim();
				const isMissing = value === "";
				warning.hidden = !isMissing;
				if (isMissing) input.setAttribute("aria-invalid", "true");
				else input.removeAttribute("aria-invalid");
			};
			if (input.dataset.vursRequiredFieldWarningBound !== "true") {
				input.addEventListener("input", updateRequiredFieldWarning);
				input.addEventListener("change", updateRequiredFieldWarning);
				input.dataset.vursRequiredFieldWarningBound = "true";
			}
			updateRequiredFieldWarning();
		}
	}
}

Hooks.on("renderItemSheet", addRuleElementFormHints);

registerRuleElementFormLocalization();
Hooks.once("init", registerRuleElementFormLocalization);
Hooks.once("ready", registerRuleElementFormLocalization);
