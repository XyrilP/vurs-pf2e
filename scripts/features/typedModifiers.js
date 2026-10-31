export const MODIFIER_TYPES = Object.freeze([
	"ability",
	"circumstance",
	"item",
	"potency",
	"proficiency",
	"status",
	"untyped"
]);

export function selectTypedModifiers(modifiers) {
	const selected = modifiers.filter(modifier => (modifier.type ?? "untyped") === "untyped");
	const typed = new Map();
	for (const modifier of modifiers) {
		const type = modifier.type ?? "untyped";
		if (type === "untyped") continue;
		const buckets = typed.get(type) ?? { positive: null, negative: null };
		if (type === "ability") {
			if (!buckets.ability || modifier.value > buckets.ability.value) {
				buckets.ability = modifier;
			}
		} else if (modifier.value > 0) {
			if (!buckets.positive || modifier.value > buckets.positive.value) {
				buckets.positive = modifier;
			}
		} else if (modifier.value < 0) {
			if (!buckets.negative || modifier.value < buckets.negative.value) {
				buckets.negative = modifier;
			}
		}
		typed.set(type, buckets);
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
