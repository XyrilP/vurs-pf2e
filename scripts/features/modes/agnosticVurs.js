export const AGNOSTIC_VURS_MODE = Object.freeze({
  id: "vurs-agnostic",
  systemWideDiceless: false,
  systemWideMainAttribute: false,
  systemWideNegativeHp: true
});

const AGNOSTIC_VURS_SKILL_ATTRIBUTES = Object.freeze({
  computers: "con",
  computer: "con",
  thievery: "con"
});

export function applyAgnosticVursSkillAttributes(actor) {
  const skills = actor?.system?.skills;
  if (!skills) return;
  for (const [slug, attribute] of Object.entries(AGNOSTIC_VURS_SKILL_ATTRIBUTES)) {
    if (skills[slug]) skills[slug].attribute = attribute;
  }
}
