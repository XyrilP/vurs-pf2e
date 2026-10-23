export const FULL_VURS_MODE = Object.freeze({
  id: "vurs",
  systemWideDiceless: true,
  systemWideMainAttribute: true,
  systemWideNegativeHp: true
});

const FULL_VURS_SKILL_ATTRIBUTES = Object.freeze({
  crafting: "con",
  deception: "dex",
  diplomacy: "con",
  intimidation: "str",
  occultism: "cha",
  performance: "int",
  society: "con"
});

export function applyFullVursSkillAttributes(actor) {
  const skills = actor?.system?.skills;
  if (!skills) return;
  for (const [slug, attribute] of Object.entries(FULL_VURS_SKILL_ATTRIBUTES)) {
    if (skills[slug]) skills[slug].attribute = attribute;
  }
}

/**
 * Replace PF2e's Constitution-based HP modifier with Strength for actors using
 * VURS. Always retarget the modifier, even when the current values are equal,
 * so Wealth cannot become the HP source again on a later preparation.
 *
 * The caller supplies the actor's persisted max-HP reduction because that
 * value is managed alongside the VURS HP controls and damage updates.
 */
export function applyVursHitPoints(actor, maxHpReduction, strengthLabel = "Strength", useStrengthForHp = true) {
  const abilities = actor.system?.abilities;
  const hp = actor.system?.attributes?.hp;
  if (!abilities || !hp) return;
  const level = Math.max(Number(actor.level) || 1, 1);
  const strengthModifier = abilities.str?.mod;
  const constitutionModifier = abilities.con?.mod;
  let adjustment = 0;
  if (useStrengthForHp && Number.isFinite(strengthModifier) && Number.isFinite(constitutionModifier)) {
    adjustment = (strengthModifier - constitutionModifier) * level;
    const hpModifier = hp.modifiers?.find(modifier => modifier?.slug === "hp-con" || modifier?.ability === "con");
    if (hpModifier && Number.isFinite(hpModifier.modifier)) {
      const replacement = strengthModifier * level;
      const modifierAdjustment = replacement - hpModifier.modifier;
      hpModifier.modifier = replacement;
      hpModifier.ability = "str";
      hpModifier.label = strengthLabel;
      if (Number.isFinite(hp.totalModifier)) hp.totalModifier += modifierAdjustment;
      if (Number.isFinite(hp.totalModifier)) hp.max = hp.totalModifier;
      else if (Number.isFinite(hp.max)) hp.max += modifierAdjustment;
    } else if (adjustment !== 0) {
      if (Number.isFinite(hp.totalModifier)) {
        hp.totalModifier += adjustment;
        hp.max = hp.totalModifier;
      } else if (Number.isFinite(hp.max)) {
        hp.max += adjustment;
      }
    }
  }

  // PF2e may have clamped HP against its Constitution-based maximum earlier
  // in preparation. Restore the persisted value before applying the VURS max.
  const sourceHpValue = foundry.utils.getProperty(actor, "_source.system.attributes.hp.value");
  const currentHp = Number.isFinite(sourceHpValue) ? sourceHpValue : hp.value;
  const reduction = Number.isFinite(Number(maxHpReduction)) ? Math.trunc(Number(maxHpReduction)) : 0;
  if (Number.isFinite(hp.max) && reduction !== 0) hp.max = Math.max(0, hp.max - reduction);
  if (Number.isFinite(currentHp) && Number.isFinite(hp.max)) hp.value = Math.min(currentHp, hp.max);

  if (Array.isArray(hp.modifiers)) {
    hp.breakdown = hp.modifiers.filter(modifier => modifier?.enabled !== false && Number.isFinite(modifier?.modifier))
      .map(modifier => `${modifier.label ?? modifier.slug ?? "Modifier"} ${modifier.modifier < 0 ? "" : "+"}${modifier.modifier}`)
      .join(", ");
  }

  const stamina = hp.sp;
  if (useStrengthForHp && adjustment !== 0 && stamina && Number.isFinite(stamina.max)) {
    stamina.max += adjustment;
    const sourceStaminaValue = foundry.utils.getProperty(actor, "_source.system.attributes.hp.sp.value");
    const currentStamina = Number.isFinite(sourceStaminaValue) ? sourceStaminaValue : stamina.value;
    if (Number.isFinite(currentStamina)) stamina.value = Math.min(currentStamina, stamina.max);
  }
}
