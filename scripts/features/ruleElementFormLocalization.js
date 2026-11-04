const RULE_ELEMENT_FORM_TRANSLATIONS = {
	Common: {
		Value: "Value",
		Selector: "Selector",
		Mode: "Mode",
		ModifierType: "Modifier Type",
		BeforeReduction: "Calculate Before Reduction",
		DefaultWhenOmitted: "When omitted: {value}",
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

function addRuleElementDefaultPlaceholders(app, html) {
	const root = html?.[0] ?? html;
	if (!root?.querySelectorAll) return;

	const system = game[game.system.id] ?? game.pf2e;
	for (const form of root.querySelectorAll(".rule-form[data-key]")) {
		const schema = system?.RuleElements?.all?.[form.dataset.key]?.schema;
		if (!schema) continue;

		for (const input of form.querySelectorAll("[name^='system.rules.']")) {
			const fieldName = input.name.split(".").at(-1);
			const placeholder = schema.fields?.[fieldName]?.placeholder;
			if (placeholder === null || placeholder === undefined || placeholder === "") continue;

			if (input instanceof HTMLSelectElement) {
				const blankOption = input.querySelector('option[value=""]');
				if (blankOption) blankOption.textContent = game.i18n.format(
					"VURS.RuleElements.Common.DefaultWhenOmitted",
					{ value: placeholder }
				);
			} else if (input instanceof HTMLInputElement && input.type === "checkbox") {
				const group = input.closest(".form-group");
				if (!group || group.dataset.vursDefaultHint === "true") continue;
				const hint = document.createElement("p");
				hint.className = "hint";
				hint.textContent = game.i18n.format(
					"VURS.RuleElements.Common.DefaultWhenOmitted",
					{ value: placeholder }
				);
				group.append(hint);
				group.dataset.vursDefaultHint = "true";
			} else {
				input.placeholder = String(placeholder);
			}
		}
	}
}

Hooks.on("renderItemSheet", addRuleElementDefaultPlaceholders);

registerRuleElementFormLocalization();
Hooks.once("init", registerRuleElementFormLocalization);
Hooks.once("ready", registerRuleElementFormLocalization);
