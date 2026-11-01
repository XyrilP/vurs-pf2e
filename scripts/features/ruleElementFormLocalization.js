const RULE_ELEMENT_FORM_TRANSLATIONS = {
	Common: {
		Value: "Value",
		Selector: "Selector",
		Mode: "Mode",
		ModifierType: "Modifier Type",
		BeforeReduction: "Calculate Before Reduction",
		Modes: {
			Threshold: "Threshold",
			Flat: "Flat",
			Percent: "Percent"
		}
	},
	CriticalProtection: {
		Definition: "Definition"
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
		Distance: "Distance",
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

registerRuleElementFormLocalization();
Hooks.once("init", registerRuleElementFormLocalization);
Hooks.once("ready", registerRuleElementFormLocalization);
