import { actorUsesAgnosticVurs, actorUsesVursSystem, getActorSystemMode } from "./systemModes.js";

const CONSOLIDATED_SKILLS = Object.freeze({
  acrobatics: "mobility",
  computers: "crafting",
  stealth: "deception",
  medicine: "survival",
  piloting: "mobility",
  thievery: "crafting"
});
const MIRRORED_STATISTIC_SKILLS = Object.freeze({
  "fortitude-skill": { statistic: "fortitude", type: "save" },
  "reflex-skill": { statistic: "reflex", type: "save" },
  "will-skill": { statistic: "will", type: "save" },
  "perception-skill": { statistic: "perception", type: "perception" }
});
const SKILL_ATTRIBUTE_GROUPS = Object.freeze([
  { attribute: "str", label: "Strength", color: "#e74c3c" },
  { attribute: "dex", label: "Agility", color: "#2ecc71" },
  { attribute: "con", label: "Wealth", color: "#f1c40f" },
  { attribute: "int", label: "Intelligence", color: "#3498db" },
  { attribute: "cha", label: "Void", color: "#9b59b6" },
  { attribute: "wis", label: "Spirit", color: "#00bcd4" }
]);
const DEFAULT_SKILL_ATTRIBUTE_GROUPS = Object.freeze([
  { attribute: "str", label: "PF2E.AbilityStr", color: "#e74c3c" },
  { attribute: "dex", label: "PF2E.AbilityDex", color: "#2ecc71" },
  { attribute: "con", label: "PF2E.AbilityCon", color: "#f39c12" },
  { attribute: "int", label: "PF2E.AbilityInt", color: "#3498db" },
  { attribute: "wis", label: "PF2E.AbilityWis", color: "#00bcd4" },
  { attribute: "cha", label: "PF2E.AbilityCha", color: "#e84393" }
]);
const DEFAULT_SKILL_GROUPING_SETTING = "groupSkillsByAttributeInDefault";
const DEFAULT_ATTRIBUTE_MODIFIER_FRAMES_SETTING = "colorAttributeModifierFramesInDefault";
const DEFAULT_VURS_SKILLS_SETTING = "includeVursSkillsInDefault";
const DEFAULT_SAVE_SKILLS_SETTING = "addSaveSkillsInDefault";
const SKILL_ATTRIBUTE_GROUP_COLUMNS_FLAG = "sheet.groupedSkillsColumns";
const NESTED_SKILLS_VISIBLE_FLAG = "sheet.nestedSkills";
const VURS_HOMEBREW_SKILL_SLUGS = Object.freeze([
  "power",
  "dexterity-skill",
  "mobility",
  "acquisition",
  "strategy",
  "coolness",
  "romance",
  "soul",
  "fortitude-skill",
  "reflex-skill",
  "will-skill",
  "perception-skill"
]);
const SAVE_SKILL_SLUGS = new Set(Object.keys(MIRRORED_STATISTIC_SKILLS));
const SKILL_ATTRIBUTE_ALIASES = Object.freeze({
  strength: "str",
  agility: "dex",
  dexterity: "dex",
  wealth: "con",
  constitution: "con",
  intelligence: "int",
  void: "cha",
  charisma: "cha",
  spirit: "wis",
  wisdom: "wis"
});
const CONSOLIDATED_SKILLS_STYLE_ID = "vurs-pf2e-consolidated-skills-style";
const SKILL_ICONS = Object.freeze({
  athletics: "play",
  "fortitude-skill": "shield",
  fortitude: "shield",
  intimidation: "user-group",
  power: "hand-fist",
  deception: "user-group",
  stealth: "play",
  "dexterity-skill": "hand-fist",
  agility: "hand-fist",
  mobility: "play",
  acrobatics: "play",
  piloting: "play",
  "reflex-skill": "shield",
  reflex: "shield",
  acquisition: "shield",
  crafting: "brain",
  computer: "brain",
  computers: "brain",
  thievery: "play",
  diplomacy: "user-group",
  society: "user-group",
  arcana: "wand-magic-sparkles",
  performance: "user-group",
  strategy: "play",
  "will-skill": "shield",
  will: "shield",
  coolness: "play",
  occultism: "wand-magic-sparkles",
  "perception-skill": "shield",
  perception: "shield",
  romance: "user-group",
  nature: "wand-magic-sparkles",
  religion: "wand-magic-sparkles",
  soul: "shield",
  survival: "brain",
  medicine: "brain"
});
const SKILL_ATTRIBUTE_FALLBACK_ICONS = Object.freeze({
  str: { icon: "hand-back-fist" },
  dex: { icon: "socks" },
  con: { icon: "coins" },
  int: { icon: "certificate" },
  cha: { icon: "moon" },
  wis: { icon: "hands-praying" }
});
const DEFAULT_SKILL_ATTRIBUTE_ICONS = Object.freeze({
  ...SKILL_ATTRIBUTE_FALLBACK_ICONS,
  con: { icon: "heart" },
  wis: { icon: "eye" },
  cha: { icon: "lips" }
});
const PF2E_ELEGANT_SKILL_FRAME = `<svg xmlns="http://www.w3.org/2000/svg" width="33" height="33" overflow="scroll"><style>.st1{stroke:#231f20;stroke-miterlimit:10}.st1,.st2{fill:none}</style><g opacity=".25"><path class="st1" d="M.5 20v-7"/><path class="st2" d="M13 20v-7"/><path class="st1" d="M13 .5h7"/><path class="st2" d="M13 13h7"/><path class="st1" d="M32.5 13v7"/><path class="st2" d="M20 13v7"/><path class="st1" d="M20 32.5h-7"/><path class="st2" d="M20 20h-7"/><g><path class="st1" d="M.5.5h3.1v3.1H.5zM3.6 3.6h3.1v3.1H3.6zM6.8 3.6h3.1v3.1H6.8zM3.6 6.8h3.1v3.1H3.6zM3.6 6.8H.5V13M13 .5H6.8v3.1"/></g><g><path class="st1" d="M29.4.5h3.1v3.1h-3.1zM26.3 3.6h3.1v3.1h-3.1zM26.3 6.8h3.1v3.1h-3.1zM23.1 3.6h3.1v3.1h-3.1zM26.3 3.6V.5H20"/><path class="st1" d="M32.5 13V6.8h-3.1"/></g><g><path class="st1" d="M29.4 29.4h3.1v3.1h-3.1z"/><path class="st1" d="M26.3 26.3h3.1v3.1h-3.1zM23.1 26.3h3.1v3.1h-3.1zM26.3 23.1h3.1v3.1h-3.1zM29.4 26.3h3.1V20M20 32.5h6.3v-3.1"/></g><g><path class="st1" d="M.5 29.4h3.1v3.1H.5zM3.6 26.3h3.1v3.1H3.6zM3.6 23.1h3.1v3.1H3.6zM6.8 26.3h3.1v3.1H6.8z"/><path class="st1" d="M6.8 29.4v3.1H13M.5 20v6.3h3.1"/></g></g></svg>`;

function skillFrameDataUrl(color) {
  const tintedFrame = PF2E_ELEGANT_SKILL_FRAME
    .replaceAll("#231f20", color)
    .replace('opacity=".25"', 'opacity=".7"');
  return `url("data:image/svg+xml,${encodeURIComponent(tintedFrame)}")`;
}

export function colorVursAttributeModifierFrames(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;

  const colors = actorUsesVursSystem(actor)
    ? { str: "#e74c3c", dex: "#2ecc71", con: "#f1c40f", int: "#3498db", cha: "#9b59b6", wis: "#00bcd4" }
    : game.settings.get("vurs-pf2e", DEFAULT_ATTRIBUTE_MODIFIER_FRAMES_SETTING) === true
      ? { str: "#e74c3c", dex: "#2ecc71", con: "#f39c12", int: "#3498db", wis: "#00bcd4", cha: "#e84393" }
      : null;
  for (const item of root.querySelectorAll(".subsection.attributes li.attribute[data-attribute]")) {
    const modifier = item.querySelector(":scope > h3.modifier");
    if (!modifier) continue;
    const color = colors?.[item.dataset.attribute];
    if (color) modifier.style.borderImageSource = skillFrameDataUrl(color);
    else modifier.style.removeProperty("border-image-source");
  }
}

export function applyVursStatisticSkillMirrors(actor) {
  if (!actor?.isOfType?.("character") || !shouldMirrorSaveSkills(actor)) return;

  for (const [skillSlug, { statistic: statisticSlug, type }] of Object.entries(MIRRORED_STATISTIC_SKILLS)) {
    const statistic = type === "save" ? actor.saves?.[statisticSlug] : actor.perception;
    const skillData = actor.system?.skills?.[skillSlug];
    if (!statistic || !skillData || !actor.skills) continue;

    Object.assign(skillData, statistic.getTraceData(), {
      slug: skillSlug,
      label: CONFIG.PF2E.skills?.[skillSlug]?.label ?? skillData.label,
      attribute: statistic.attribute,
      rank: statistic.rank,
      lore: false
    });
    actor.skills[skillSlug] = statistic;

    if (actor.rollOptions?.all) {
      for (let rank = 0; rank <= 4; rank++) delete actor.rollOptions.all[`skill:${skillSlug}:rank:${rank}`];
      actor.rollOptions.all[`skill:${skillSlug}:rank:${statistic.rank}`] = true;
    }
  }
}

export function linkVursStatisticSkillControls(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character") || !shouldMirrorSaveSkills(actor)) return;

  for (const [skillSlug, { statistic: statisticSlug, type }] of Object.entries(MIRRORED_STATISTIC_SKILLS)) {
    const skillRow = root.querySelector(`.tab.proficiencies li[data-statistic="${skillSlug}"]`);
    const selector = skillRow?.querySelector("select.skill-proficiency");
    if (!selector) continue;

    const property = type === "save"
      ? `system.saves.${statisticSlug}.rank`
      : "system.perception.rank";
    selector.setAttribute("data-property", property);
    selector.setAttribute("data-rank", String(type === "save"
      ? actor.system.saves?.[statisticSlug]?.rank ?? 0
      : actor.system.perception?.rank ?? 0));
    selector.setAttribute("aria-label", `${CONFIG.PF2E.skills?.[skillSlug]?.label ?? skillSlug} proficiency (mirrors ${statisticSlug})`);
  }
}

function shouldMirrorSaveSkills(actor) {
  return actorUsesVursSystem(actor) || (
    getActorSystemMode(actor) === "default" &&
    game.settings.get("vurs-pf2e", DEFAULT_SAVE_SKILLS_SETTING) === true
  );
}

export function addVursExtendedSaveRows(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character") || !actorUsesVursSystem(actor)) return;

  const list = root.querySelector("ul.saves");
  const template = list?.querySelector(":scope > li.roll-data[data-save]");
  if (!list || !template) return;
  list.style.display = "grid";
  list.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";

  const rows = [
    { slug: "perception", statistic: actor.perception },
    { slug: "acquisition", statistic: actor.skills?.acquisition },
    { slug: "soul", statistic: actor.skills?.soul }
  ];
  for (const { slug, statistic } of rows) {
    if (!statistic) continue;

    let row = list.querySelector(`:scope > li[data-vurs-extended-save="${slug}"]`);
    if (!row) {
      row = template.cloneNode(true);
      row.dataset.vursExtendedSave = slug;
      row.querySelectorAll(".modifiers-tooltip").forEach(tooltip => tooltip.remove());
      list.append(row);
    }

    const label = CONFIG.PF2E.skills?.[slug]?.label ?? statistic.label ?? slug;
    const localizedLabel = game.i18n.localize(label);
    row.dataset.save = slug;
    row.querySelector(".sidebar_label").textContent = localizedLabel;

    const rank = Number(statistic.rank) || 0;
    const rankElement = row.querySelector(".pf-rank");
    rankElement.dataset.rank = String(rank);
    rankElement.textContent = game.i18n.localize(`PF2E.ProficiencyLevel${rank}`);

    const roll = row.querySelector('[data-action="roll-check"]');
    roll.dataset.statistic = slug;
    roll.removeAttribute("data-save");

    const modifier = row.querySelector(".save-roll .modifier");
    // The row is cloned from a native save and may carry its tooltip marker,
    // but cloned DOM nodes do not inherit Tooltipster's event handlers.
    modifier.classList.remove("tooltipstered");
    const value = Number(statistic.totalModifier ?? statistic.mod ?? statistic.check?.mod ?? 0);
    modifier.textContent = `${value >= 0 ? "+" : ""}${Math.trunc(value)}`;
    // Keep this distinct from the skill's own Proficiencies-tab tooltip ID.
    const tooltipId = `${root.id}-vurs-sidebar-${slug}-modifiers`;
    modifier.setAttribute("data-tooltip-content", `#${tooltipId}`);
    let tooltip = row.querySelector(`#${CSS.escape(tooltipId)}`);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "hover-content modifiers-tooltip";
      tooltip.id = tooltipId;
      tooltip.dataset.stat = slug;
      tooltip.style.maxHeight = "50vh";
      tooltip.style.overflowY = "auto";
      tooltip.style.overscrollBehavior = "contain";
      const title = document.createElement("div");
      title.className = "sidebar_title";
      const heading = document.createElement("h2");
      heading.textContent = localizedLabel;
      title.append(heading);
      const modifiers = document.createElement("ul");
      modifiers.className = "modifier-list";
      for (const entry of statistic.modifiers ?? statistic._modifiers ?? []) {
        if (entry.enabled === false && entry.hideIfDisabled) continue;
        const item = document.createElement("li");
        item.className = `item${entry.enabled === false ? " no-effect" : ""}`;
        const type = document.createElement("span");
        type.className = "tag-legacy";
        type.textContent = game.i18n.localize(`PF2E.ModifierType.${entry.type ?? "untyped"}`);
        const name = document.createElement("span");
        name.className = "label";
        name.textContent = entry.label ?? entry.slug ?? "Modifier";
        const amount = document.createElement("span");
        amount.className = "data";
        const modifierValue = Number(entry.modifier ?? entry.value ?? 0);
        amount.textContent = `${modifierValue >= 0 ? "+" : ""}${Math.trunc(modifierValue)}`;
        item.append(type, name, amount);
        if (entry.custom && entry.slug) {
          const remove = document.createElement("i");
          remove.className = "fa-regular fa-circle-xmark remove-modifier";
          remove.dataset.action = "remove-modifier";
          remove.dataset.slug = entry.slug;
          remove.title = game.i18n.localize("PF2E.RemoveModifierTitle");
          remove.addEventListener("click", () => actor.removeCustomModifier(slug, entry.slug));
          item.append(remove);
        }
        modifiers.append(item);
      }
      if (actor.isOwner) {
        const add = document.createElement("li");
        add.className = "item add-modifier";
        const valueControls = document.createElement("div");
        valueControls.className = "add-modifier-value";
        const decrement = document.createElement("button");
        decrement.type = "button";
        decrement.dataset.action = "decrement";
        decrement.setAttribute("aria-label", game.i18n.localize("PF2E.ModifierDecrease"));
        decrement.innerHTML = '<i class="fa-solid fa-minus"></i>';
        const valueInput = document.createElement("input");
        valueInput.type = "number";
        valueInput.value = "1";
        valueInput.placeholder = "+1";
        valueInput.setAttribute("aria-label", game.i18n.localize("PF2E.Roll.Dialog.ModifierValue"));
        const increment = document.createElement("button");
        increment.type = "button";
        increment.dataset.action = "increment";
        increment.setAttribute("aria-label", game.i18n.localize("PF2E.ModifierIncrease"));
        increment.innerHTML = '<i class="fa-solid fa-plus"></i>';
        decrement.addEventListener("click", () => valueInput.stepDown());
        increment.addEventListener("click", () => valueInput.stepUp());
        valueControls.append(decrement, valueInput, increment);

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "add-modifier-name";
        nameInput.placeholder = game.i18n.localize("PF2E.ModifierNamePlaceholder");
        nameInput.setAttribute("aria-label", game.i18n.localize("PF2E.Roll.Dialog.ModifierName"));
        const typeSelect = document.createElement("select");
        typeSelect.className = "tag-legacy add-modifier-type";
        typeSelect.setAttribute("aria-label", game.i18n.localize("PF2E.Roll.Dialog.ModifierType"));
        const modifierTypes = ["", "ability", "proficiency", "item", "status", "circumstance", "untyped"];
        for (const typeValue of modifierTypes) {
          const option = document.createElement("option");
          option.value = typeValue;
          option.textContent = game.i18n.localize(typeValue
            ? `PF2E.ModifierType.${typeValue}`
            : "PF2E.ModifierTypeTitle");
          typeSelect.append(option);
        }
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "add-modifier-submit";
        submit.textContent = game.i18n.localize("PF2E.AddModifierTitle");
        submit.addEventListener("click", () => {
          const amount = Number.isFinite(valueInput.valueAsNumber) ? valueInput.valueAsNumber : 1;
          const label = nameInput.value.trim();
          const modifierType = typeSelect.value;
          if (!modifierType) {
            ui.notifications.error("Type is required.");
            return;
          }
          actor.addCustomModifier(slug, label || game.i18n.localize(`PF2E.ModifierType.${modifierType}`), amount, modifierType);
        });
        add.append(valueControls, nameInput, typeSelect, submit);
        modifiers.append(add);
      }
      tooltip.append(title, modifiers);
      row.append(tooltip);
    }
    const jq = globalThis.jQuery ?? globalThis.$;
    if (jq && !modifier.classList.contains("tooltipstered") && typeof jq(modifier).tooltipster === "function") {
      jq(modifier).tooltipster({
        trigger: "click",
        arrow: false,
        contentAsHTML: true,
        debug: false,
        interactive: true,
        side: ["right", "bottom"],
        theme: "crb-hover",
        minWidth: 120,
        content: tooltip
      });
    }
  }

  const order = ["fortitude", "reflex", "acquisition", "will", "perception", "soul"];
  for (const slug of order) {
    const row = list.querySelector(`:scope > li[data-save="${slug}"]`);
    if (row) list.append(row);
  }
  [...list.children].forEach((row, index) => {
    row.style.minWidth = "0";
    if (index % 3 === 0) row.style.borderLeft = "none";
  });
}

export function hideVursPerceptionSidebarSection(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;

  const section = root.querySelector(".sidebar section.perception");
  const header = section?.previousElementSibling;
  if (!section || header?.tagName !== "HEADER") return;

  const shouldHide = actorUsesVursSystem(actor);
  for (const element of [header, section]) {
    if (shouldHide) {
      element.hidden = true;
      element.dataset.vursHiddenPerception = "true";
    } else if (element.dataset.vursHiddenPerception === "true") {
      element.hidden = false;
      delete element.dataset.vursHiddenPerception;
    }
  }
}

export function relabelVursDexteritySkill(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;

  const labelText = actorUsesVursSystem(actor) ? "Dexterity" : "Agility";
  for (const label of root.querySelectorAll('.tab.proficiencies li[data-statistic="dexterity-skill"] .name')) {
    if (label.textContent.trim() !== labelText) label.textContent = labelText;
  }
}

export function relabelVursCoreSkills(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;

  const renamedSkills = {
    arcana: ["PF2E.TraitArcane", "PF2E.Skill.Arcana", "Arcane", "Arcana"],
    occultism: ["PF2E.TraitOccult", "PF2E.Skill.Occultism", "Occult", "Occultism"],
    nature: ["PF2E.TraitPrimal", "PF2E.Skill.Nature", "Primal", "Nature"],
    religion: ["PF2E.TraitDivine", "PF2E.Skill.Religion", "Divine", "Religion"]
  };
  const usesVurs = actorUsesVursSystem(actor);
  for (const [slug, [vursKey, defaultKey, vursFallback, defaultFallback]] of Object.entries(renamedSkills)) {
    const key = usesVurs ? vursKey : defaultKey;
    const fallback = usesVurs ? vursFallback : defaultFallback;
    const localized = game.i18n.localize(key);
    const label = localized && localized !== key ? localized : fallback;
    for (const element of root.querySelectorAll(`.tab.proficiencies li[data-statistic="${slug}"] .name`)) {
      if (element.textContent.trim() !== label) element.textContent = label;
    }
  }
}

export function groupVursSkillsByAttribute(root, actor, localizeDefault = key => game.i18n.localize(key)) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;

  const list = root.querySelector('.tab.proficiencies ul.proficiencies-list:not(.lores-list)');
  if (!list) return;
  ensureConsolidatedSkillStyles();

  // Unwrap prior groups first so sheet rerenders and mode changes remain idempotent.
  for (const group of list.querySelectorAll(":scope > li.vurs-skill-attribute-group")) {
    const innerList = group.querySelector(":scope > ul.vurs-skill-attribute-group-list");
    for (const row of [...(innerList?.children ?? [])]) list.append(row);
    group.remove();
  }
  const defaultActor = getActorSystemMode(actor) === "default";
  const showAllVursSkills = actorUsesVursSystem(actor) || (
    defaultActor &&
    game.settings.get("vurs-pf2e", DEFAULT_VURS_SKILLS_SETTING) === true
  );
  const showSaveSkills = defaultActor &&
    game.settings.get("vurs-pf2e", DEFAULT_SAVE_SKILLS_SETTING) === true;
  for (const row of list.querySelectorAll(":scope > li[data-statistic]")) {
    if (!VURS_HOMEBREW_SKILL_SLUGS.includes(row.dataset.statistic)) continue;
    row.hidden = !showAllVursSkills && !(showSaveSkills && SAVE_SKILL_SLUGS.has(row.dataset.statistic));
  }

  const usesVurs = actorUsesVursSystem(actor);
  const isDefaultGrouping = !usesVurs && (
    defaultActor &&
    game.settings.get("vurs-pf2e", DEFAULT_SKILL_GROUPING_SETTING) === true
  );
  const shouldGroup = usesVurs || isDefaultGrouping;
  const attributeGroups = isDefaultGrouping ? DEFAULT_SKILL_ATTRIBUTE_GROUPS : SKILL_ATTRIBUTE_GROUPS;
  const attributeIcons = isDefaultGrouping ? DEFAULT_SKILL_ATTRIBUTE_ICONS : SKILL_ATTRIBUTE_FALLBACK_ICONS;
  list.classList.toggle("vurs-attribute-group-layout", shouldGroup);
  if (!shouldGroup) {
    list.style.removeProperty("--vurs-skill-attribute-columns");
    list.classList.remove("vurs-skill-layout-two-columns");
    list.classList.remove("vurs-hide-nested-skills");
    list.previousElementSibling?.querySelector?.(":scope > .controls > .vurs-skill-column-count, :scope > .controls > .vurs-skill-nesting-toggle")?.remove();
    disableSkillNameHoverScroll(list);
    return;
  }
  const configuredColumns = Number(foundry.utils.getProperty(actor.flags?.vurs, SKILL_ATTRIBUTE_GROUP_COLUMNS_FLAG));
  const columns = configuredColumns === 2 ? 2 : 3;
  list.style.setProperty("--vurs-skill-attribute-columns", String(columns));
  list.classList.toggle("vurs-skill-layout-two-columns", columns === 2);
  const allowHideNested = usesVurs && !actorUsesAgnosticVurs(actor);
  const showNestedSkills = foundry.utils.getProperty(actor.flags?.vurs, NESTED_SKILLS_VISIBLE_FLAG) !== false;
  addSkillGroupColumnsControl(list, columns, actor, allowHideNested, showNestedSkills);

  const rowsByAttribute = new Map(attributeGroups.map(({ attribute }) => [attribute, []]));
  const ungroupedRows = [];
  for (const row of [...list.querySelectorAll(":scope > li[data-statistic]")]) {
    const slug = row.dataset.statistic;
    // Prepared system data is authoritative here: VURS can reassign a skill's
    // attribute while the original Statistic instance still holds its PF2e one.
    const rawAttribute = actor.system?.skills?.[slug]?.attribute ??
      actor.skills?.[slug]?.attribute ??
      CONFIG.PF2E.skills?.[slug]?.attribute;
    const attribute = SKILL_ATTRIBUTE_ALIASES[rawAttribute] ?? rawAttribute;
    if (attribute) row.dataset.vursSkillAttribute = attribute;
    if (rowsByAttribute.has(attribute)) rowsByAttribute.get(attribute).push(row);
    else ungroupedRows.push(row);
  }

  sortSkillRowsByLabel(ungroupedRows);
  for (const row of ungroupedRows) list.append(row);
  for (const { attribute, label, color } of attributeGroups) {
    const rows = rowsByAttribute.get(attribute);
    if (!rows?.length) continue;
    sortSkillRowsByLabel(rows);

    const group = document.createElement("li");
    group.className = "vurs-skill-attribute-group";
    group.dataset.attribute = attribute;
    group.style.setProperty("--vurs-skill-attribute-color", color);
    group.style.setProperty("--vurs-skill-attribute-frame", skillFrameDataUrl(color));
    const heading = document.createElement("h3");
    heading.className = "vurs-skill-attribute-group-title";
    const localizedLabel = isDefaultGrouping ? localizeDefault(label) : game.i18n.localize(label);
    const attributeIcon = attributeIcons[attribute];
    if (attributeIcon) {
      const icon = document.createElement("i");
      icon.className = `fa-solid fa-${attributeIcon.icon} vurs-skill-attribute-header-icon`;
      icon.setAttribute("aria-hidden", "true");
      heading.append(icon, document.createTextNode(localizedLabel));
    } else {
      heading.textContent = localizedLabel;
    }
    const innerList = document.createElement("ul");
    innerList.className = "vurs-skill-attribute-group-list";
    for (const row of rows) innerList.append(row);
    group.append(heading, innerList);
    list.append(group);
  }
  applyVursSkillIcons(list, attributeIcons);
  enableSkillNameHoverScroll(list);
  applySkillNameScaling(list);
}

function sortSkillRowsByLabel(rows) {
  const collator = new Intl.Collator(game.i18n.lang, { sensitivity: "base", numeric: true });
  const getLabel = row => row.querySelector(":scope > .name, :scope > .vurs-skill-parent-row > .name")
    ?.textContent?.replace(/\s+/g, " ").trim() ?? row.dataset.statistic ?? "";
  rows.sort((left, right) => collator.compare(getLabel(left), getLabel(right)) ||
    String(left.dataset.statistic ?? "").localeCompare(String(right.dataset.statistic ?? "")));
}

function addSkillGroupColumnsControl(list, selectedColumns, actor, allowHideNested, showNestedSkills) {
  const header = list.previousElementSibling;
  if (!(header instanceof HTMLElement) || header.tagName !== "HEADER") return;
  let controls = header.querySelector(":scope > .controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "controls";
    header.append(controls);
  }
  controls.querySelector(":scope > .vurs-skill-nesting-toggle")?.remove();

  let select = controls.querySelector(":scope > .vurs-skill-column-count");
  if (!select) {
    select = document.createElement("select");
    select.className = "vurs-skill-column-count";
    select.setAttribute("aria-label", "Core Skills column layout and nested skill visibility");
    select.title = "Choose columns and whether to show nested skills";
    select.addEventListener("change", async () => {
      const selected = parseSkillGroupConfiguration(select.value);
      const previousColumns = Number(foundry.utils.getProperty(actor.flags?.vurs, SKILL_ATTRIBUTE_GROUP_COLUMNS_FLAG)) === 2 ? 2 : 3;
      const previousShowNested = foundry.utils.getProperty(actor.flags?.vurs, NESTED_SKILLS_VISIBLE_FLAG) !== false;
      const canHideNested = select.querySelector('option[value$="-hide"]') !== null;
      setSkillGroupConfiguration(list, selected.columns, selected.showNested);
      try {
        const updates = { [`flags.vurs.${SKILL_ATTRIBUTE_GROUP_COLUMNS_FLAG}`]: selected.columns };
        if (canHideNested) updates[`flags.vurs.${NESTED_SKILLS_VISIBLE_FLAG}`] = selected.showNested;
        await actor.update(updates);
      } catch (error) {
        const previousValue = formatSkillGroupConfiguration(previousColumns, previousShowNested, allowHideNested);
        select.value = previousValue;
        setSkillGroupConfiguration(list, previousColumns, previousShowNested);
        console.error("vurs-pf2e | Could not update the Core Skills column layout", error);
      }
    });
  }
  select.replaceChildren();
  for (const columns of [2, 3]) {
    for (const showNested of (allowHideNested ? [true, false] : [true])) {
      const option = document.createElement("option");
      option.value = formatSkillGroupConfiguration(columns, showNested, allowHideNested);
      option.textContent = `${columns} Columns${showNested ? "" : " — Hide Nested"}`;
      select.append(option);
    }
  }
  select.value = formatSkillGroupConfiguration(selectedColumns, showNestedSkills, allowHideNested);
  controls.prepend(select);
}

function parseSkillGroupConfiguration(value) {
  const hideNested = String(value).endsWith("-hide");
  return { columns: String(value).startsWith("2") ? 2 : 3, showNested: !hideNested };
}

function formatSkillGroupConfiguration(columns, showNested, allowHideNested) {
  return `${columns}${allowHideNested && !showNested ? "-hide" : ""}`;
}

function setSkillGroupConfiguration(list, columns, showNested) {
  list.style.setProperty("--vurs-skill-attribute-columns", String(columns));
  list.classList.toggle("vurs-skill-layout-two-columns", columns === 2);
  list.classList.toggle("vurs-hide-nested-skills", !showNested);
  const control = list.previousElementSibling?.querySelector?.(":scope > .controls > .vurs-skill-column-count");
  if (control) control.value = formatSkillGroupConfiguration(columns, showNested, control.querySelector('option[value$="-hide"]') !== null);
  applySkillNameScaling(list);
}

function applyVursSkillIcons(list, attributeIcons = SKILL_ATTRIBUTE_FALLBACK_ICONS) {
  for (const row of list.querySelectorAll("li[data-statistic]")) {
    const slug = row.dataset.statistic;
    const explicitIcon = SKILL_ICONS[slug];
    const attribute = row.dataset.vursSkillAttribute ?? row.closest(".vurs-skill-attribute-group")?.dataset.attribute;
    const fallback = attributeIcons[attribute];
    const icon = explicitIcon ?? fallback?.icon;
    const name = row.querySelector(":scope > .name, :scope > .vurs-skill-parent-row > .name");
    const roll = row.querySelector(":scope > a.d20, :scope > .vurs-skill-parent-row > a.d20");
    if (!name || !roll) continue;
    name.querySelector(":scope > .vurs-skill-name-icon")?.remove();
    const existing = roll.querySelector(":scope > .vurs-skill-roll-icon");
    if (!icon) {
      existing?.remove();
      continue;
    }
    if (existing?.classList.contains(`fa-${icon}`) && !existing.classList.contains("vurs-skill-icon-hollow")) continue;
    existing?.remove();
    const iconElement = document.createElement("i");
    iconElement.className = `fa-solid fa-${icon} vurs-skill-roll-icon`;
    iconElement.setAttribute("aria-hidden", "true");
    roll.append(iconElement);
  }
}

function enableSkillNameHoverScroll(list) {
  for (const name of list.querySelectorAll(".vurs-skill-attribute-group-list .name")) {
    let text = name.querySelector(":scope > .vurs-skill-name-text");
    if (!text) {
      text = document.createElement("span");
      text.className = "vurs-skill-name-text";
      text.append(...[...name.childNodes].filter(node => !node.matches?.(".vurs-skill-name-icon")));
      name.append(text);
    }
  }

  if (list._vursSkillNameHoverScrollHandlers) return;
  const onPointerOver = event => {
    if (!(event.target instanceof Element)) return;
    const name = event.target.closest(".vurs-skill-attribute-group-list .name");
    if (!name || !list.contains(name) || name.classList.contains("vurs-skill-name-scrolling")) return;
    const text = name.querySelector(":scope > .vurs-skill-name-text");
    if (!text?.textContent?.trim()) return;

    // Restore the normal font size while hovered. This lets the original-size
    // label scroll even when scaling had reduced it enough to appear to fit.
    const scaledFontSize = text.style.fontSize;
    text.style.removeProperty("font-size");
    const fontSize = Number.parseFloat(getComputedStyle(text).fontSize);
    const overflow = measureSkillNameWidth(text, fontSize) - name.clientWidth;
    if (overflow <= 1) {
      if (scaledFontSize) text.style.fontSize = scaledFontSize;
      return;
    }

    name.style.setProperty("--vurs-skill-name-offset", `${-overflow}px`);
    name.style.setProperty("--vurs-skill-name-duration", "2s");
    name.classList.add("vurs-skill-name-scrolling");
  };
  const onPointerOut = event => {
    if (!(event.target instanceof Element)) return;
    const name = event.target.closest(".vurs-skill-attribute-group-list .name");
    if (!name || name.contains(event.relatedTarget)) return;
    name.classList.remove("vurs-skill-name-scrolling");
    name.style.removeProperty("--vurs-skill-name-offset");
    name.style.removeProperty("--vurs-skill-name-duration");
    applySkillNameScaling(list);
  };
  list._vursSkillNameHoverScrollHandlers = { onPointerOver, onPointerOut };
  list.addEventListener("pointerover", onPointerOver);
  list.addEventListener("pointerout", onPointerOut);
}

function measureSkillNameWidth(text, fontSize) {
  const computed = getComputedStyle(text);
  const measure = document.createElement("span");
  Object.assign(measure.style, {
    display: "inline-block",
    fontFamily: computed.fontFamily,
    fontSize: `${fontSize}px`,
    fontStyle: computed.fontStyle,
    fontVariant: computed.fontVariant,
    fontWeight: computed.fontWeight,
    letterSpacing: computed.letterSpacing,
    position: "fixed",
    textTransform: computed.textTransform,
    visibility: "hidden",
    whiteSpace: "nowrap",
    width: "max-content"
  });
  measure.textContent = text.textContent;
  document.body.append(measure);
  const width = measure.getBoundingClientRect().width;
  measure.remove();
  return width;
}

function applySkillNameScaling(list) {
  const twoColumns = list.classList.contains("vurs-skill-layout-two-columns");
  for (const name of list.querySelectorAll(".vurs-skill-attribute-group-list .name")) {
    const text = name.querySelector(":scope > .vurs-skill-name-text");
    if (!text) continue;
    if (twoColumns) {
      text.style.removeProperty("font-size");
      continue;
    }
    if (name.classList.contains("vurs-skill-name-scrolling")) continue;
    text.style.removeProperty("font-size");

    const baseSize = Number.parseFloat(getComputedStyle(name).fontSize);
    const availableWidth = name.clientWidth;
    if (!Number.isFinite(baseSize) || availableWidth <= 0) continue;
    const fullWidth = measureSkillNameWidth(text, baseSize);
    if (fullWidth <= availableWidth || fullWidth <= 0) continue;

    // Three-column labels shrink by at most 33%. Hover scrolling handles
    // any remaining overflow at that readable minimum size.
    const scale = Math.max(0.67, availableWidth / fullWidth);
    text.style.fontSize = `${baseSize * scale}px`;
  }

  if (typeof ResizeObserver === "undefined") return;
  if (!list._vursSkillNameScaleObserver) {
    list._vursSkillNameScaleObserver = new ResizeObserver(() => applySkillNameScaling(list));
    list._vursSkillNameScaleObserver.observe(list);
  }
}

function disableSkillNameHoverScroll(list) {
  const handlers = list._vursSkillNameHoverScrollHandlers;
  if (handlers) {
    list.removeEventListener("pointerover", handlers.onPointerOver);
    list.removeEventListener("pointerout", handlers.onPointerOut);
    delete list._vursSkillNameHoverScrollHandlers;
  }
  for (const name of list.querySelectorAll(".name")) {
    name.classList.remove("vurs-skill-name-scrolling");
    name.style.removeProperty("--vurs-skill-name-offset");
    name.style.removeProperty("--vurs-skill-name-duration");
    name.style.removeProperty("font-size");
    delete name.dataset.vursSkillBaseFontSize;
    name.style.removeProperty("font-size");
    delete name.dataset.vursSkillBaseFontSize;
    const text = name.querySelector(":scope > .vurs-skill-name-text");
    if (text) {
      text.style.removeProperty("font-size");
      text.style.removeProperty("transition");
      text.style.removeProperty("transform");
      name.append(...text.childNodes);
      text.remove();
    }
    const row = name.closest("li[data-statistic]");
    row?.querySelector(":scope > a.d20, :scope > .vurs-skill-parent-row > a.d20")
      ?.querySelector(":scope > .vurs-skill-roll-icon")?.remove();
  }
  list._vursSkillNameScaleObserver?.disconnect();
  delete list._vursSkillNameScaleObserver;
  for (const row of list.querySelectorAll("li[data-statistic]")) delete row.dataset.vursSkillAttribute;
}

export function applyVursConsolidatedSkillAttributes(actor) {
  if (!actor?.isOfType?.("character") || !actorUsesVursSystem(actor) || actorUsesAgnosticVurs(actor)) return;

  for (const [childSlug, parentSlug] of Object.entries(CONSOLIDATED_SKILLS)) {
    const child = actor.skills?.[childSlug];
    const parent = actor.skills?.[parentSlug];
    if (!child || !parent) continue;

    const effectiveRank = Math.max(Number(child.rank) || 0, Number(parent.rank) || 0);
    const previousAttribute = child.attribute;
    const data = foundry.utils.deepClone(child.data);
    data.rank = effectiveRank;
    // Statistic.data includes the already-generated proficiency modifier. If
    // retained, PF2e will reuse its old value instead of recalculating it for
    // this effective rank.
    data.modifiers = (data.modifiers ?? []).filter(modifier => modifier.type !== "proficiency");
    if (parent.attribute && child.attribute !== parent.attribute) {
      data.attribute = parent.attribute;
      data.domains = (data.domains ?? []).filter(domain => domain !== `${previousAttribute}-based`);
      data.modifiers = (data.modifiers ?? []).filter(modifier =>
        modifier.type !== "ability" || modifier.ability === parent.attribute
      );
    }

    const consolidated = new child.constructor(actor, data, child.config);
    actor.skills[childSlug] = consolidated;
    Object.assign(actor.system.skills[childSlug], consolidated.getTraceData(), {
      attribute: parent.attribute ?? child.attribute,
      rank: effectiveRank,
      mod: consolidated.check.mod
    });

    if (actor.rollOptions?.all) {
      for (let rank = 0; rank <= 4; rank++) delete actor.rollOptions.all[`skill:${childSlug}:rank:${rank}`];
      actor.rollOptions.all[`skill:${childSlug}:rank:${effectiveRank}`] = true;
    }
  }
}

export function nestVursConsolidatedSkills(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character") ||
    !actorUsesVursSystem(actor) || actorUsesAgnosticVurs(actor)) return;

  const list = root.querySelector('.tab.proficiencies ul.proficiencies-list:not(.lores-list)');
  if (!list) return;
  ensureConsolidatedSkillStyles();

  const showNestedSkills = foundry.utils.getProperty(actor.flags?.vurs, NESTED_SKILLS_VISIBLE_FLAG) !== false;
  list.classList.toggle("vurs-hide-nested-skills", !showNestedSkills);

  for (const [childSlug, parentSlug] of Object.entries(CONSOLIDATED_SKILLS)) {
    const parentRow = list.querySelector(`:scope > li[data-statistic="${parentSlug}"]`);
    const childRow = list.querySelector(`:scope > li[data-statistic="${childSlug}"]`) ??
      root.querySelector(`.vurs-consolidated-subskills li[data-statistic="${childSlug}"]`);
    if (!parentRow || !childRow || childRow.parentElement?.classList.contains("vurs-consolidated-subskills")) continue;

    let inner = parentRow.querySelector(":scope > .vurs-skill-parent-row");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "vurs-skill-parent-row";
      for (const node of [...parentRow.childNodes]) inner.append(node);
      parentRow.append(inner);
      parentRow.classList.add("vurs-consolidated-parent");
    }
    const nested = document.createElement("ul");
    nested.className = "vurs-consolidated-subskills";
    nested.setAttribute("aria-label", `${parentRow.querySelector(".name")?.textContent?.trim() ?? parentSlug} subskills`);
    const selector = childRow.querySelector("select.skill-proficiency");
    if (selector) {
      selector.disabled = false;
      selector.removeAttribute("disabled");
      selector.setAttribute("aria-label", `${childRow.querySelector(".name")?.textContent?.trim() ?? childSlug}; uses the higher rank of this skill and ${parentSlug}`);
    }
    nested.append(childRow);
    parentRow.append(nested);
  }
}

function ensureConsolidatedSkillStyles() {
  const style = document.getElementById(CONSOLIDATED_SKILLS_STYLE_ID) ?? document.createElement("style");
  style.id = CONSOLIDATED_SKILLS_STYLE_ID;
  style.textContent = `
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-attribute-group-layout {
      align-items: stretch !important;
      grid-template-columns: repeat(var(--vurs-skill-attribute-columns, 3), minmax(0, 1fr)) !important;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list > li.vurs-consolidated-parent {
      align-items: stretch !important;
      display: flex !important;
      flex-direction: column !important;
      grid-column: auto !important;
      padding: var(--space-4) !important;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-parent-row {
      align-items: center !important;
      display: flex !important;
      min-height: 1.35rem;
      width: 100%;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-consolidated-subskills {
      border-left: 1px dotted var(--color-border-light-tertiary);
      display: flex !important;
      flex-direction: column !important;
      gap: 0;
      list-style: none;
      margin: 0 0 var(--space-2) var(--space-16);
      padding: 0 0 0 var(--space-10);
      width: auto;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-consolidated-subskills > li {
      align-items: center !important;
      background: transparent !important;
      border: 0 !important;
      border-image: none !important;
      box-shadow: none !important;
      display: flex !important;
      flex: 0 0 auto;
      min-height: 1.1rem !important;
      min-width: 0;
      padding: 0 !important;
      position: relative;
      width: 100%;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-consolidated-subskills > li::before {
      border-top: 1px dotted var(--color-border-light-tertiary);
      content: "";
      left: calc(-1 * var(--space-10));
      position: absolute;
      top: 50%;
      width: var(--space-10);
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list > li.vurs-skill-attribute-group {
      align-self: stretch;
      align-items: stretch !important;
      border-image-repeat: repeat !important;
      border-image-slice: 11 !important;
      border-image-source: var(--vurs-skill-attribute-frame) !important;
      border-image-width: 14px !important;
      border-style: double !important;
      box-sizing: border-box;
      display: flex !important;
      flex-direction: column !important;
      grid-column: auto !important;
      min-width: 0;
      padding: var(--space-2) !important;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-attribute-group-title {
      align-items: center;
      color: var(--vurs-skill-attribute-color);
      display: flex;
      font-size: var(--font-size-14);
      font-family: var(--serif);
      font-weight: 600;
      gap: var(--space-2);
      justify-content: center;
      line-height: 1.1;
      margin: 0 0 var(--space-2);
      text-align: center;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-attribute-header-icon {
      font-size: 0.8em;
    }
    .actor.sheet.character .tab.proficiencies > header .controls .vurs-skill-column-count {
      flex: 0 0 auto;
      font-size: var(--font-size-12);
      height: 1.6em;
      min-width: 6.5em;
      width: auto;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list {
      align-items: stretch;
      display: grid !important;
      gap: var(--space-2);
      grid-auto-rows: min-content;
      grid-template-columns: minmax(0, 1fr);
      list-style: none;
      margin: 0;
      min-width: 0;
      padding: 0;
      width: 100%;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li {
      align-self: stretch;
      align-items: center !important;
      border: 0 !important;
      border-image: none !important;
      box-shadow: none !important;
      box-sizing: border-box;
      font-size: var(--font-size-14);
      min-height: 1.2rem !important;
      min-width: 0;
      overflow: hidden;
      padding: 0 1px !important;
      width: 100%;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li a.d20 {
      flex: 0 0 0.95rem;
      padding: 0;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li .modifier {
      flex: 0 0 auto;
      font-size: var(--font-size-14);
      margin-right: var(--space-2);
      min-width: 1.1rem;
      white-space: nowrap;
      width: auto;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li .name {
      flex: 1 1 0;
      font-size: var(--font-size-14);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-name-text {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      white-space: nowrap;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li a.d20 {
      position: relative;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-roll-icon {
      color: var(--vurs-skill-attribute-color);
      font-size: 0.65rem;
      left: 50%;
      pointer-events: none;
      position: absolute;
      text-shadow: 0 0 2px var(--color-shadow-dark), 0 0 3px var(--color-shadow-dark);
      top: 50%;
      transform: translate(-50%, -50%);
      z-index: 1;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-name-scrolling {
      z-index: 1;
    }
    .actor.sheet.character .tab.proficiencies .vurs-skill-name-scrolling .vurs-skill-name-text {
      animation: vurs-skill-name-scroll var(--vurs-skill-name-duration) linear 0.25s forwards;
      max-width: none;
      overflow: visible;
      text-overflow: clip;
    }
    @keyframes vurs-skill-name-scroll {
      to { transform: translateX(var(--vurs-skill-name-offset)); }
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list:not(.vurs-skill-layout-two-columns) ul.vurs-skill-attribute-group-list > li select.pf-rank {
      flex: 0 0 3.1rem;
      font-size: 8px;
      height: 0.85rem;
      min-width: 0;
      padding: 0 1px;
      width: 3.1rem;
    }
    .actor.sheet.character .tab.proficiencies ul.vurs-skill-attribute-group-list > li.vurs-consolidated-parent {
      align-items: stretch !important;
      display: flex !important;
      flex-direction: column !important;
      grid-column: auto !important;
      min-height: max-content;
      padding: var(--space-4) !important;
    }
    .actor.sheet.character .tab.proficiencies .vurs-consolidated-subskills .name {
      flex: 1;
      font-size: var(--font-size-14);
    }
    .actor.sheet.character .tab.proficiencies .vurs-consolidated-subskills select.skill-proficiency {
      display: inline-block !important;
      visibility: visible !important;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-skill-attribute-group-list > li {
      font-size: var(--font-size-16);
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-skill-attribute-group-list > li {
      min-height: 2.25rem !important;
      padding: 0 var(--space-8) 0 var(--space-4) !important;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-skill-attribute-group-list > li a.d20 {
      flex: 0 0 auto;
      padding: var(--space-4);
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-skill-attribute-group-list > li .modifier {
      flex: 0 0 1.75rem;
      font-size: var(--font-size-16);
      margin-right: var(--space-4);
      width: 1.75rem;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-skill-attribute-group-list > li .name,
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns .vurs-consolidated-subskills .name {
      font-size: var(--font-size-14);
      line-height: 0.9;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns .vurs-skill-name-text {
      display: inline;
      max-width: none;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
    }
    .actor.sheet.character .tab.proficiencies ul.proficiencies-list.vurs-skill-layout-two-columns ul.vurs-consolidated-subskills > li {
      min-height: 2.25rem !important;
    }
  `;
  if (!style.isConnected) document.head.append(style);
}
