const MODULE_ID = "vurs-pf2e";

// During prepareDerivedData, hp.totalModifier is still the native
// Constitution-based value for Str-based actors (the Strength replacement in
// applyVursHitPoints has not run yet), so capping there would clamp the
// reduction to the wrong base. applyVursHitPoints floors the result at 0,
// making the uncapped value equivalent for preparation.
export function getVursStoredMaxHpReduction(actor) {
	const candidates = [
		foundry.utils.getProperty(actor, "_source.flags.vurs.hp.maxReduction"),
		foundry.utils.getProperty(actor, "document._source.flags.vurs.hp.maxReduction"),
		foundry.utils.getProperty(actor, "flags.vurs.hp.maxReduction"),
		// Read earlier module-scoped values during the one-time migration.
		foundry.utils.getProperty(actor, `_source.flags.${MODULE_ID}.hp.maxReduction`),
		foundry.utils.getProperty(actor, `flags.${MODULE_ID}.hp.maxReduction`),
		foundry.utils.getProperty(actor, `flags.${MODULE_ID}.hpReduction`)
	];
	const value = candidates.find(candidate => candidate !== undefined);
	const reduction = Number(value);
	return Number.isFinite(reduction) ? Math.trunc(reduction) : 0;
}

export function getVursMaxHpReduction(actor) {
	// The public flags object can lag behind a document update in some PF2e
	// preparation flows. Prefer persisted source data so partial damage reverts
	// immediately expose the restored reduction value to preparation and sheets.
	const normalized = getVursStoredMaxHpReduction(actor);
	if (normalized <= 0) return normalized;
	const preparedBaseMax = Number(actor?.system?.attributes?.hp?.totalModifier);
	return Number.isFinite(preparedBaseMax) ? Math.min(normalized, Math.max(0, preparedBaseMax)) : normalized;
}

export function getVursBaseMaxHp(actor) {
	const hp = actor?.system?.attributes?.hp;
	const preparedMaximum = Number(hp?.totalModifier);
	if (Number.isFinite(preparedMaximum)) return Math.max(0, preparedMaximum);
	const maximum = Number(hp?.max);
	const adjustment = getVursMaxHpReduction(actor);
	return Math.max(0, (Number.isFinite(maximum) ? maximum : 0) + adjustment);
}
