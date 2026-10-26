import { actorUsesAgnosticVurs, actorUsesVursSystem } from "./systemModes.js";

const PLAY_RESOURCES_PATH = "flags.vurs.playResources";
const DEFAULT_ACTION_POINTS_SETTING = "addActionPointsInDefault";
const STYLE_RANK_PHRASES = Object.freeze({
  1: ["Dull!", "Don't worry!", "Dope!", "Do it!", "Deadly!", "Dirty!", "Dismal!"],
  2: ["Cool!!", "Come on!!", "Crazy!!", "Carnage!!", "Cruel!!"],
  3: ["Bravo!!!", "Bingo!!!", "Blast!!!", "Big up!!!", "Brutal!!!", "Badass!!!"],
  4: ["Absolute!!!!", "Awesome!!!!", "Are you ready?!!!!", "Alright!!!!", "All that!!!!", "Atomic!!!!", "Anarchic!!!!", "Apocalyptic!!!!"],
  5: ["Stylish!!!!!", "Show Time!!!!!", "Sweet!!!!!", "Slammin' Beat!!!!!", "Smokin'!!!!!", "Savage!!!!!"]
});
const styleRankPhraseCache = new Map();
const PLAY_RESOURCE_DEFINITIONS = Object.freeze([
  { key: "staminaPoints", label: "Stamina Points", icon: true },
  { key: "actionPoints", label: "Action Points", icon: true },
  { key: "reactions", label: "Reactions", icon: true },
  { key: "tacticPoints", label: "Tactic Points", icon: true },
  { key: "styleRank", label: "Style Rank", icon: true },
  { key: "karmaPoints", label: "Karma Points", icon: true },
  { key: "budgetPoints", label: "Budget Points", hasMaxReduction: true },
  { key: "magicPoints", label: "Magic Points", hasMaxReduction: true, segmented: true }
]);

const PF2E_RESOURCE_FRAME = `<svg xmlns="http://www.w3.org/2000/svg" width="33" height="33" overflow="scroll"><style>.st1{stroke:#231f20;stroke-miterlimit:10}.st1,.st2{fill:none}</style><g opacity=".7"><path class="st1" d="M.5 20v-7"/><path class="st2" d="M13 20v-7"/><path class="st1" d="M13 .5h7"/><path class="st2" d="M13 13h7"/><path class="st1" d="M32.5 13v7"/><path class="st2" d="M20 13v7"/><path class="st1" d="M20 32.5h-7"/><path class="st2" d="M20 20h-7"/><g><path class="st1" d="M.5.5h3.1v3.1H.5zM3.6 3.6h3.1v3.1H3.6zM6.8 3.6h3.1v3.1H6.8zM3.6 6.8h3.1v3.1H3.6zM3.6 6.8H.5V13M13 .5H6.8v3.1"/></g><g><path class="st1" d="M29.4.5h3.1v3.1h-3.1zM26.3 3.6h3.1v3.1h-3.1zM26.3 6.8h3.1v3.1h-3.1zM23.1 3.6h3.1v3.1h-3.1zM26.3 3.6V.5H20"/><path class="st1" d="M32.5 13V6.8h-3.1"/></g><g><path class="st1" d="M29.4 29.4h3.1v3.1h-3.1z"/><path class="st1" d="M26.3 26.3h3.1v3.1h-3.1zM23.1 26.3h3.1v3.1h-3.1zM26.3 23.1h3.1v3.1h-3.1zM29.4 26.3V20M20 32.5h6.3v-3.1"/></g><g><path class="st1" d="M.5 29.4h3.1v3.1H.5zM3.6 26.3h3.1v3.1H3.6zM3.6 23.1h3.1v3.1H3.6zM6.8 26.3h3.1v3.1H6.8z"/><path class="st1" d="M6.8 29.4v3.1H13M.5 20v6.3h3.1"/></g></g></svg>`;

function resourceFrameDataUrl(color) {
  const frame = PF2E_RESOURCE_FRAME.replaceAll("#231f20", color);
  return `url("data:image/svg+xml,${encodeURIComponent(frame)}")`;
}

Hooks.on("combatStart", combat => {
  if (game.user?.isGM) void resetEncounterPlayResources(combat);
});

Hooks.on("preDeleteCombat", combat => {
  if (game.user?.isGM) void resetEncounterPlayResources(combat);
});

Hooks.on("updateCombat", (combat, changes) => {
  if (!game.user?.isGM || !combat.started || (changes.turn === undefined && changes.round === undefined)) return;
  const combatant = combat.combatant;
  if (combatant?.actor) void regenerateActorAtTurnStart(combatant.actor);
});

export function renderVursPlayResources(root, actor) {
  if (!(root instanceof HTMLElement) || !actor?.isOfType?.("character")) return;
  const sidebar = root.matches(".sidebar") ? root : root.querySelector(".sidebar[data-tab='sidebar'], aside > .sidebar");
  if (!sidebar) return;
  renderStyleRankOverlay(root, actor);

  let section = sidebar.querySelector(":scope > .vurs-play-resources");
  const hasDefaultPlayResources = getFullVursDefaultMax(actor, "reactions") > 0 ||
    getFullVursDefaultMax(actor, "actionPoints") > 0;
  if (!actorUsesVursSystem(actor) && !hasDefaultPlayResources) {
    section?.remove();
    return;
  }

  const entries = getPlayResourceEntries(actor);

  if (!entries.length) {
    section?.remove();
    return;
  }

  if (!section) {
    section = document.createElement("section");
    section.className = "vurs-play-resources";
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = "Play";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vurs-play-reset";
    const resetIcon = document.createElement("i");
    resetIcon.className = "fa-solid fa-arrow-rotate-right";
    resetIcon.setAttribute("aria-hidden", "true");
    reset.append(resetIcon);
    reset.title = "Recalculate maximums and refill all Play resources";
    reset.setAttribute("aria-label", "Recalculate maximums and refill all Play resources");
    reset.addEventListener("click", () => void resetPlayResources(root, actor, reset));
    const modifiers = document.createElement("button");
    modifiers.type = "button";
    modifiers.className = "vurs-play-modifiers";
    modifiers.classList.add("hover");
    modifiers.textContent = "Modifiers";
    modifiers.title = "Show Play regeneration modifiers";
    modifiers.addEventListener("click", event => {
      event.preventDefault();
      void togglePlayRegenerationTooltip(section, actor, modifiers);
    });
    const controls = document.createElement("span");
    controls.className = "vurs-play-header-controls";
    controls.append(reset, modifiers);
    header.append(title, controls);
    section.append(header, document.createElement("ol"));
  }

  const list = section.querySelector("ol");
  list.replaceChildren(...entries.map(resource => createPlayResourceRow(resource, actor)));
  const headers = [...sidebar.querySelectorAll(":scope > header")];
  const resourceLabels = new Set([
    normalizeLabel("Resources"),
    normalizeLabel(game.i18n.localize("PF2E.Actor.Resources"))
  ]);
  const perceptionLabels = new Set([
    normalizeLabel("Perception"),
    normalizeLabel(game.i18n.localize("PF2E.PerceptionHeader"))
  ]);
  const resourceHeader = headers.find(header => resourceLabels.has(normalizeLabel(header.querySelector("h2")?.textContent)));
  const perceptionHeader = headers.find(header => perceptionLabels.has(normalizeLabel(header.querySelector("h2")?.textContent)));
  const anchor = resourceHeader ?? perceptionHeader;
  if (anchor) sidebar.insertBefore(section, anchor);
  else if (!section.isConnected) sidebar.append(section);
}

async function togglePlayRegenerationTooltip(section, actor, button) {
  const existing = button._vursPlayModifiersTooltip;
  if (existing && button._vursPlayModifiersTooltipOpen) {
    existing.close();
    button._vursPlayModifiersTooltipOpen = false;
    button.setAttribute("aria-expanded", "false");
    return;
  }
  if (existing) {
    existing.open();
    button._vursPlayModifiersTooltipOpen = true;
    button.setAttribute("aria-expanded", "true");
    return;
  }
  const resources = foundry.utils.getProperty(actor, PLAY_RESOURCES_PATH) ?? {};
  const rows = [];
  for (const definition of PLAY_RESOURCE_DEFINITIONS) {
    if (definition.key === "reactions" && actorUsesVursSystem(actor) && !actorUsesAgnosticVurs(actor)) continue;
    const resource = resources[definition.key] && typeof resources[definition.key] === "object"
      ? resources[definition.key]
      : {};
    const regeneration = getPlayResourceRegeneration(actor, definition.key, resource);
    if (regeneration) rows.push({ label: `${getPlayResourceShortLabel(actor, definition.key)} Regen`, modifier: regeneration });
  }
  try {
    for (const source of collectHealingSources(actor)) rows.unshift(source);
  } catch (error) {
    console.warn("vurs-pf2e | Failed to collect healing sources for Play modifiers", error);
  }
  const tooltipId = `${section.closest("form")?.id ?? "vurs-play"}-play-modifiers`;
  const rendered = await foundry.applications.handlebars.renderTemplate(
    "systems/pf2e/templates/actors/partials/modifiers-tooltip.hbs",
    { title: "Play", modifiers: rows.map(row => ({ ...row, type: "untyped", enabled: true })), editable: false, options: { id: tooltipId }, slug: "play" }
  );
  const content = document.createRange().createContextualFragment(rendered).firstElementChild;
  if (!content) return;
  content.classList.add("vurs-play-modifiers-tooltip");
  section.append(content);
  button.dataset.tooltipContent = `#${content.id}`;
  const closeOnOutsideClick = event => {
    if (event.target instanceof Node && !button.contains(event.target) && !content.contains(event.target)) {
      instance.close();
      button._vursPlayModifiersTooltipOpen = false;
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", closeOnOutsideClick, true);
    }
  };
  const instance = $(button).tooltipster({
    content,
    contentAsHTML: true,
    interactive: true,
    minWidth: 120,
    side: ["right", "bottom"],
    theme: "crb-hover",
    trigger: "custom",
    triggerClose: { originClick: true, mouseleave: false },
    functionReady: () => document.addEventListener("click", closeOnOutsideClick, true),
    functionAfter: () => document.removeEventListener("click", closeOnOutsideClick, true)
  }).tooltipster("instance");
  button._vursPlayModifiersTooltip = instance;
  button._vursPlayModifiersTooltipOpen = true;
  instance.open();
  button.setAttribute("aria-expanded", "true");
}

function collectHealingSources(actor) {
  const sources = [];
  const seen = new Set();
  const add = (label, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount === 0) return;
    const key = `${label}|${amount}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ label, modifier: amount });
  };
  const scan = (value, sourceLabel, path = "") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === "number" && /fast.?healing/i.test(key)) add(`Fast Healing (${sourceLabel})`, child);
      else if (typeof child === "number" && /(?:hp\.)?(?:regeneration|regen)/i.test(childPath)) add(`HP Regeneration (${sourceLabel})`, child);
      else if (child && typeof child === "object") scan(child, sourceLabel, childPath);
    }
  };
  scan(actor.system, actor.name ?? "Actor");
  scan(actor.flags, actor.name ?? "Actor");
  const items = actor.items?.contents ?? actor.items ?? [];
  for (const item of items) {
    scan(item.system, item.name ?? "Item");
    scan(item.flags, item.name ?? "Item");
    for (const effect of item.effects ?? []) scan(effect.changes, item.name ?? "Item");
  }
  return sources;
}

function getPlayResourceShortLabel(actor, key) {
  if (key === "staminaPoints") return "SP";
  if (key === "actionPoints") return actorUsesVursSystem(actor) ? "AP" : "Actions";
  if (key === "tacticPoints") return "TP";
  if (key === "reactions") return "Reactions";
  return PLAY_RESOURCE_DEFINITIONS.find(definition => definition.key === key)?.label ?? key;
}

function formatSignedModifier(value) {
  const number = finiteResourceNumber(value);
  return `${number >= 0 ? "+" : "âˆ’"}${formatResourceNumber(Math.abs(number))}`;
}

function getPlayResourceEntries(actor) {
  const resources = foundry.utils.getProperty(actor, PLAY_RESOURCES_PATH) ?? {};
  return PLAY_RESOURCE_DEFINITIONS.flatMap(definition => {
    if (definition.key === "reactions" && actorUsesVursSystem(actor) && !actorUsesAgnosticVurs(actor)) return [];
    const resource = resources[definition.key] ?? {};
    if (typeof resource !== "object") return [];
    const defaultMax = getFullVursDefaultMax(actor, definition.key);
    // Full VURS defaults are derived from current stats and ranks, so an old
    // stored max must not freeze them when the actor improves.
    const baseMax = finiteResourceNumber(defaultMax ?? resource.max);
    if (baseMax <= 0) return [];

    const maxReduction = definition.hasMaxReduction ? finiteResourceNumber(resource.maxReduction) : 0;
    const max = Math.max(0, baseMax - maxReduction);
    // Keep editable maxima visible at zero so they can be recovered from an
    // accidental reduction down to their base maximum.
    if (max <= 0 && !definition.hasMaxReduction) return [];
    const value = Math.clamp(finiteResourceNumber(resource.value), 0, max);
    const label = definition.key === "actionPoints" && !actorUsesVursSystem(actor)
      ? "Actions"
      : definition.label;
    return [{ ...definition, label, value, max, baseMax, maxReduction }];
  });
}

async function resetPlayResources(root, actor, button) {
  const resources = foundry.utils.getProperty(actor, PLAY_RESOURCES_PATH) ?? {};
  const updates = {};
  for (const definition of PLAY_RESOURCE_DEFINITIONS) {
    const resource = resources[definition.key] ?? {};
    const defaultMax = getFullVursDefaultMax(actor, definition.key);
    const baseMax = finiteResourceNumber(defaultMax ?? resource.max);
    const maxReduction = definition.hasMaxReduction ? finiteResourceNumber(resource.maxReduction) : 0;
    const value = ["styleRank", "karmaPoints"].includes(definition.key)
      ? 0
      : Math.max(0, baseMax - maxReduction);
    updates[`${PLAY_RESOURCES_PATH}.${definition.key}.value`] = value;
  }
  button.disabled = true;
  try {
    await actor.update(updates, { render: false });
    renderVursPlayResources(root, actor);
  } catch (error) {
    console.error("vurs-pf2e | Failed to reset Play resources", error);
  } finally {
    button.disabled = false;
  }
}

async function resetEncounterPlayResources(combat) {
  const actors = new Set(combat?.combatants?.contents?.map(combatant => combatant.actor).filter(Boolean) ?? []);
  for (const actor of actors) {
    if (!actorUsesVursSystem(actor)) continue;
    const resources = foundry.utils.getProperty(actor, PLAY_RESOURCES_PATH) ?? {};
    const updates = {};
    for (const resourceKey of ["actionPoints", "staminaPoints", "tacticPoints"]) {
      const resource = resources[resourceKey] ?? {};
      const baseMax = finiteResourceNumber(getFullVursDefaultMax(actor, resourceKey) ?? resource.max);
      updates[`${PLAY_RESOURCES_PATH}.${resourceKey}.value`] = Math.max(0, baseMax);
    }
    updates[`${PLAY_RESOURCES_PATH}.styleRank.value`] = 0;
    updates[`${PLAY_RESOURCES_PATH}.karmaPoints.value`] = 0;
    try {
      await actor.update(updates, { render: false });
    } catch (error) {
      console.error(`vurs-pf2e | Failed to reset Play resources for ${actor.name} at encounter transition`, error);
    }
  }
}

function getFullVursDefaultMax(actor, resourceKey) {
  if (!actorUsesVursSystem(actor) && getSystemModeForPlayResource(actor) !== "default") return undefined;
  // Agnostic VURS does not derive Action Points from VURS attributes and
  // skills. Preserve an explicitly stored maximum (which may be above 3),
  // and use the standard three-point pool only when no maximum is configured.
  if (actorUsesAgnosticVurs(actor)) {
    if (resourceKey === "actionPoints") {
      const storedMax = foundry.utils.getProperty(actor, `${PLAY_RESOURCES_PATH}.actionPoints.max`);
      if (storedMax !== undefined && storedMax !== null && storedMax !== "" && Number.isFinite(Number(storedMax))) {
        return Math.max(0, Number(storedMax));
      }
      return 3;
    }
    if (resourceKey === "reactions") return 1;
    return undefined;
  }
  if (getSystemModeForPlayResource(actor) === "default") {
    if (game.settings.get("vurs-pf2e", DEFAULT_ACTION_POINTS_SETTING) !== true) return undefined;
    if (resourceKey === "actionPoints") return 3;
    if (resourceKey === "reactions") return 1;
    return undefined;
  }
  const system = actor.system;
  const attributeModifier = slug => finiteResourceNumber(system?.abilities?.[slug]?.mod);
  const skillRank = slug => finiteResourceNumber(system?.skills?.[slug]?.rank);

  switch (resourceKey) {
    case "actionPoints":
      return Math.max(2, 2 + Math.min(attributeModifier("dex"), skillRank("mobility")));
    case "staminaPoints":
      return Math.max(0, Math.min(attributeModifier("str"), skillRank("athletics")));
    case "tacticPoints":
      return Math.max(0, Math.min(attributeModifier("int"), skillRank("strategy")));
    case "styleRank":
      return Math.min(attributeModifier("cha"), skillRank("coolness")) > 0 ? 5 : 0;
    case "karmaPoints":
      return Math.max(0, Math.min(attributeModifier("wis"), skillRank("soul")));
    case "budgetPoints":
      return Math.max(0, 5 + finiteResourceNumber(system?.abilities?.con?.mod) + 2 * skillRank("acquisition"));
    case "magicPoints":
      return getMagicPointContributions(actor).reduce((total, contribution) => total + contribution.value, 0);
    default:
      return undefined;
  }
}

function getSystemModeForPlayResource(actor) {
  return actorUsesAgnosticVurs(actor) ? "agnostic" : actorUsesVursSystem(actor) ? "vurs" : "default";
}

async function regenerateActorAtTurnStart(actor) {
  if (!actorUsesVursSystem(actor)) return;
  const resources = foundry.utils.getProperty(actor, PLAY_RESOURCES_PATH) ?? {};
  const updates = {};
  for (const definition of PLAY_RESOURCE_DEFINITIONS) {
    const resource = resources[definition.key];
    if (!resource || typeof resource !== "object") continue;
    const regeneration = getPlayResourceRegeneration(actor, definition.key, resource);
    if (!regeneration) continue;
    const entry = getPlayResourceEntries(actor).find(candidate => candidate.key === definition.key);
    if (!entry) continue;
    const current = finiteResourceNumber(resource.value);
    updates[`${PLAY_RESOURCES_PATH}.${definition.key}.value`] = Math.clamp(current + regeneration, 0, entry.max);
  }

  const hp = actor.system?.attributes?.hp;
  const hpRegeneration = finiteResourceNumber(foundry.utils.getProperty(actor, "flags.vurs.hp.regeneration"));
  if (hp && hpRegeneration) {
    updates["system.attributes.hp.value"] = Math.clamp(
      finiteResourceNumber(hp.value) + hpRegeneration,
      0,
      finiteResourceNumber(hp.max)
    );
  }
  if (Object.keys(updates).length) await actor.update(updates, { render: true });
}

function getPlayResourceRegeneration(actor, key, resource) {
  if (resource.regeneration !== undefined && resource.regeneration !== null) {
    return finiteResourceNumber(resource.regeneration);
  }
  if (resource.regeneration === null) return 0;
  if (!actorUsesVursSystem(actor)) {
    if (game.settings.get("vurs-pf2e", DEFAULT_ACTION_POINTS_SETTING) !== true) return 0;
    return { actionPoints: 3, reactions: 1 }[key] ?? 0;
  }
  const regeneration = { staminaPoints: 1, actionPoints: 3, tacticPoints: 1 }[key] ?? 0;
  if (key === "reactions" && actorUsesAgnosticVurs(actor)) return 1;
  return regeneration;
}

function createPlayResourceRow(resource, actor) {
  const row = document.createElement("li");
  row.className = "vurs-play-resource";
  row.dataset.resource = resource.key;
  if (resource.key === "budgetPoints") row.classList.add("budget-points");
  if (resource.key === "magicPoints") row.classList.add("magic-points");
  if (resource.key === "budgetPoints") {
    row.style.setProperty("--vurs-resource-frame", resourceFrameDataUrl("#f1c40f"));
  } else if (resource.key === "magicPoints") {
    row.style.setProperty("--vurs-resource-frame", resourceFrameDataUrl("#3498db"));
  }

  const value = document.createElement("span");
  value.className = "value";
  value.textContent = `${formatResourceNumber(resource.value)} / ${formatResourceNumber(resource.max)}`;

  if (resource.icon) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "vurs-play-resource-control";
    control.title = resource.label;
    control.setAttribute("aria-label", `${resource.label}: ${formatResourceNumber(resource.value)} of ${formatResourceNumber(resource.max)}. Left click to increase; right click to decrease.`);
    const icon = document.createElement("img");
    const iconFile = getResourceIcon(resource).replace(/\.webp$/i, ".svg");
    icon.src = `modules/vurs-pf2e/assets/custom-icons/resource-icons/${iconFile}`;
    icon.alt = "";
    icon.draggable = false;
    control.append(icon, value);
    control.addEventListener("click", event => {
      event.preventDefault();
      void adjustPlayResource(actor, resource, 1, control);
    });
    control.addEventListener("contextmenu", event => {
      event.preventDefault();
      void adjustPlayResource(actor, resource, -1, control);
    });
    row.append(control);
  } else if (resource.key === "budgetPoints") {
    const frame = document.createElement("div");
    frame.className = "vurs-play-resource-frame";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "BP";
    label.title = resource.label;
    frame.append(label);
    const bar = document.createElement("div");
    bar.className = "vurs-play-resource-segments vurs-budget-points-bar";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(resource.max));
    bar.setAttribute("aria-valuenow", String(resource.value));
    bar.title = `${resource.label}: click to increase; right-click to decrease; Ctrl-right-click to apply maximum reduction; Ctrl-click to increase the maximum.`;
    bar.setAttribute("aria-label", `${resource.label}: ${formatResourceNumber(resource.value)} of ${formatResourceNumber(resource.max)}. Click to increase; right-click to decrease; Ctrl-right-click to apply maximum reduction; Ctrl-click to increase the maximum.`);
    addPlayResourceControlHandlers(bar, actor, resource);
    bar.append(createBudgetCoinStacks(resource));
    const fields = document.createElement("span");
    fields.className = "vurs-play-resource-segment-values vurs-play-resource-edit-values";
    fields.append(...createEditableResourceFields(resource, actor));
    frame.append(bar, fields);
    row.append(frame);
  } else if (resource.key === "magicPoints") {
    const frame = document.createElement("div");
    frame.className = "vurs-play-resource-frame";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "MP";
    label.title = resource.label;
    frame.append(label);

    const bar = document.createElement("div");
    bar.className = "vurs-play-resource-segments";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", resource.label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(resource.max));
    bar.setAttribute("aria-valuenow", String(resource.value));
    bar.title = `${resource.label}: click to increase; right-click to decrease; Ctrl-right-click to apply maximum reduction; Ctrl-click to increase the maximum.`;
    bar.setAttribute("aria-label", `${resource.label}: ${formatResourceNumber(resource.value)} of ${formatResourceNumber(resource.max)}. Click to increase; right-click to decrease; Ctrl-right-click to apply maximum reduction; Ctrl-click to increase the maximum.`);
    addPlayResourceControlHandlers(bar, actor, resource);
    for (const segmentData of getMagicPointSegments(actor, resource)) {
      for (let index = 0; index < Math.max(0, Math.floor(segmentData.size)); index += 1) {
        const star = document.createElement("i");
        const filled = segmentData.start + index < resource.value;
        star.className = `${filled ? "fa-solid" : "fa-regular"} fa-star vurs-mp-star ${filled ? "is-filled" : "is-empty"}`;
        star.style.setProperty("--segment-color", segmentData.color);
        star.title = segmentData.label ?? resource.label;
        bar.append(star);
      }
    }
    const fields = document.createElement("span");
    fields.className = "vurs-play-resource-segment-values vurs-play-resource-edit-values";
    fields.append(...createEditableResourceFields(resource, actor));
    frame.append(bar, fields);
    row.append(frame);
  }

  if (resource.hasMaxReduction && resource.maxReduction !== 0 && resource.key !== "budgetPoints") {
    const reduction = document.createElement("span");
    reduction.className = "vurs-play-resource-max-reduction";
    if (resource.maxReduction < 0) reduction.classList.add("is-increase");
    const adjustment = resource.maxReduction > 0
      ? `âˆ’${formatResourceNumber(resource.maxReduction)}`
      : `+${formatResourceNumber(Math.abs(resource.maxReduction))}`;
    reduction.textContent = adjustment;
    reduction.setAttribute("aria-label", `Maximum reduced by ${formatResourceNumber(resource.maxReduction)}`);
    reduction.title = `Maximum reduced by ${formatResourceNumber(resource.maxReduction)}`;
    value.append(" ", reduction);
  }

  if (resource.segmented && resource.key !== "magicPoints") {
    const bar = document.createElement("div");
    bar.className = "vurs-play-resource-segments";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", resource.label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(resource.max));
    bar.setAttribute("aria-valuenow", String(resource.value));
    const segmentCount = Math.min(200, Math.max(1, Math.ceil(resource.max)));
    const segmentSize = resource.max / segmentCount;
    for (let index = 0; index < segmentCount; index++) {
      const segment = document.createElement("span");
      segment.className = "segment";
      const fill = Math.clamp((resource.value - index * segmentSize) / segmentSize, 0, 1);
      segment.style.setProperty("--segment-fill", `${fill * 100}%`);
      bar.append(segment);
    }
    row.append(bar);
  }

  return row;
}

function getMagicPointContributions(actor) {
  const abilities = actor.system?.abilities ?? {};
  const skills = actor.system?.skills ?? {};
  const modifier = slug => finiteResourceNumber(abilities[slug]?.mod);
  const rank = slug => finiteResourceNumber(skills[slug]?.rank);
  const localize = (key, fallback) => {
    const label = game.i18n.localize(key);
    return label && label !== key ? label : fallback;
  };
  const abilityLabel = (key, vursLabel, fallback) => {
    if (actorUsesVursSystem(actor) && ["Void", "Spirit"].includes(vursLabel)) return vursLabel;
    return localize(key, fallback);
  };
  return [
    {
      label: `${abilityLabel("PF2E.AbilityInt", "Intelligence", "Intelligence")} (${localize("PF2E.TraitArcane", "Arcane")})`,
      color: "#3498db",
      value: 2 * Math.min(modifier("int"), rank("arcana"))
    },
    {
      label: `${abilityLabel("PF2E.AbilityCha", "Void", "Charisma")} (${localize("PF2E.TraitOccult", "Occult")})`,
      color: "#9b59b6",
      value: Math.min(modifier("cha"), rank("occultism"))
    },
    {
      label: `${abilityLabel("PF2E.AbilityWis", "Spirit", "Wisdom")} (${localize("PF2E.TraitDivine", "Divine")})`,
      color: "#00bcd4",
      value: Math.min(modifier("wis"), rank("religion"))
    },
    {
      label: `${abilityLabel("PF2E.AbilityWis", "Spirit", "Wisdom")} (${localize("PF2E.TraitPrimal", "Primal")})`,
      color: "#2ecc71",
      value: Math.min(modifier("wis"), rank("nature"))
    }
  ];
}

function getMagicPointSegments(actor, resource) {
  const remainingMaximum = Math.max(0, resource.max);
  const segments = [];
  let remaining = remainingMaximum;
  let start = 0;

  for (const contribution of getMagicPointContributions(actor)) {
    const capacity = Math.min(remaining, Math.max(0, contribution.value));
    let contributionRemaining = capacity;
    while (contributionRemaining > 0 && segments.length < 200) {
      const size = Math.min(1, contributionRemaining);
      segments.push({ start, size, color: contribution.color, label: contribution.label });
      start += size;
      contributionRemaining -= size;
    }
    remaining -= capacity;
    if (remaining <= 0 || segments.length >= 200) break;
  }

  // If the editable maximum exceeds the formula, retain the extra capacity
  // with the yellow overflow color instead of leaving a gap in the bar.
  while (remaining > 0 && segments.length < 200) {
    const size = Math.min(1, remaining);
    segments.push({ start, size, color: "#f1c40f", label: "Magic Points (extra)" });
    start += size;
    remaining -= size;
  }

  if (!segments.length) segments.push({ start: 0, size: 0, color: "#f1c40f", label: "Magic Points" });
  return segments;
}

function createEditableResourceFields(resource, actor) {
  const currentValue = document.createElement("input");
  currentValue.className = "vurs-play-resource-edit";
  currentValue.type = "number";
  currentValue.min = "0";
  currentValue.max = String(resource.max);
  currentValue.step = "1";
  currentValue.value = String(resource.value);
  sizeNumberField(currentValue, resource.value);
  currentValue.setAttribute("aria-label", `${resource.label} current value`);
  currentValue.title = resource.label;
  currentValue.addEventListener("change", () => {
    const next = Math.clamp(finiteResourceNumber(currentValue.value), 0, resource.max);
    currentValue.value = String(next);
    sizeNumberField(currentValue, next);
    void savePlayResourceValue(actor, resource.key, next, currentValue);
  });

  const maximum = document.createElement("input");
  maximum.className = "vurs-play-resource-edit";
  maximum.type = "number";
  maximum.min = "0";
  maximum.step = "1";
  maximum.value = String(resource.max);
  sizeNumberField(maximum, resource.max);
  maximum.setAttribute("aria-label", `${resource.label} maximum`);
  maximum.title = resource.label;
  maximum.addEventListener("change", () => {
    const nextMax = Math.max(0, finiteResourceNumber(maximum.value));
    maximum.value = String(nextMax);
    sizeNumberField(maximum, nextMax);
    const maxReduction = resource.baseMax - nextMax;
    void savePlayResourceFlag(actor, `${resource.key}.maxReduction`, maxReduction, maximum);
  });

  const maximumDisplay = document.createElement("span");
  maximumDisplay.className = "vurs-play-resource-maximum";
  maximumDisplay.append(maximum);
  if (resource.maxReduction !== 0) {
    const delta = document.createElement("span");
    delta.className = "vurs-play-resource-max-reduction-delta";
    if (resource.maxReduction < 0) delta.classList.add("is-increase");
    delta.textContent = resource.maxReduction > 0
      ? `âˆ’${formatResourceNumber(resource.maxReduction)}`
      : `+${formatResourceNumber(Math.abs(resource.maxReduction))}`;
    delta.title = `Maximum adjustment: ${delta.textContent}`;
    maximumDisplay.append(delta);
  }

  return [currentValue, " / ", maximumDisplay];
}

function createBudgetCoinStacks(resource) {
  const coins = document.createElement("span");
  coins.className = "vurs-budget-coin-stacks";
  coins.setAttribute("aria-hidden", "true");
  const count = Math.min(200, Math.max(0, Math.ceil(resource.max)));
  for (let offset = 0; offset < count; offset += 5) {
    const stack = document.createElement("span");
    stack.className = "vurs-budget-coin-stack";
    const stackSize = Math.min(5, count - offset);
    for (let index = 0; index < stackSize; index++) {
      const coin = document.createElement("i");
      const coinValue = offset + index;
      coin.className = `fa-solid fa-coin coin ${coinValue < resource.value ? "is-filled" : "is-empty"}`;
      coin.style.setProperty("--coin-index", String(index));
      stack.append(coin);
    }
    coins.append(stack);
  }
  return coins;
}

function addPlayResourceControlHandlers(control, actor, resource) {
  control.addEventListener("click", event => {
    event.preventDefault();
    if (control.dataset.updating || event.target?.closest?.("input")) return;
    if (event.ctrlKey) void adjustPlayResourceMaxReduction(actor, resource, -1, control);
    else void adjustPlayResource(actor, resource, 1, control);
  });
  control.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (control.dataset.updating || event.target?.closest?.("input")) return;
    if (event.ctrlKey) void adjustPlayResourceMaxReduction(actor, resource, 1, control);
    else void adjustPlayResource(actor, resource, -1, control);
  });
}

async function adjustPlayResource(actor, resource, amount, control) {
  const current = finiteResourceNumber(foundry.utils.getProperty(actor, `${PLAY_RESOURCES_PATH}.${resource.key}.value`));
  const next = Math.clamp(current + amount, 0, resource.max);
  if (next === current) return;
  await savePlayResourceValue(actor, resource.key, next, control);
}

async function adjustPlayResourceMaxReduction(actor, resource, amount, control) {
  const path = `${PLAY_RESOURCES_PATH}.${resource.key}.maxReduction`;
  const current = finiteResourceNumber(foundry.utils.getProperty(actor, path));
  await savePlayResourceFlag(actor, `${resource.key}.maxReduction`, current + amount, control);
}

async function savePlayResourceValue(actor, resourceKey, value, control) {
  await savePlayResourceFlag(actor, `${resourceKey}.value`, value, control);
}

async function savePlayResourceFlag(actor, resourcePath, value, control) {
  await savePlayResourceFlags(actor, { [resourcePath]: value }, control);
}

async function savePlayResourceFlags(actor, updates, control) {
  const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [`${PLAY_RESOURCES_PATH}.${key}`, value]));
  // Keep a stable reference to the resource section and key: the optimistic
  // refresh replaces the clicked control, so the original control is detached
  // by the time the asynchronous Actor update finishes.
  const originalRow = control?.closest?.("li.vurs-play-resource");
  const section = originalRow?.closest?.(".vurs-play-resources");
  const resourceKey = originalRow?.dataset.resource;
  const disableable = control instanceof HTMLButtonElement || control instanceof HTMLInputElement;
  if (disableable) control.disabled = true;
  else control.dataset.updating = "true";
  // Update the visible control immediately. Waiting for actor.update() before
  // touching the DOM made every click feel delayed by document preparation and
  // update hooks. The persisted update still runs normally in the background.
  refreshPlayResourceRow(control, actor, updates, true);
  try {
    // Play resources are self-contained UI state. Suppress VURS's broad
    // updateActor refresh; only this row and the Style Rank overlay are updated.
    await actor.update(changes, { render: false, vursPlayResourceOnly: true });
    // The optimistic row already shows the saved value. Just unlock its
    // current control instead of rebuilding the row a second time; replacing
    // DOM nodes again here causes avoidable style/layout recalculation.
    finishCurrentPlayResourceRow(section, resourceKey);
  } catch (error) {
    console.error("vurs-pf2e | Failed to update play resources", error);
    // Restore the display from the actor's last successfully saved state.
    refreshCurrentPlayResourceRow(section, resourceKey, actor);
  }
}

function getCurrentPlayResourceControl(section, resourceKey) {
  if (!section?.isConnected || !resourceKey) return null;
  const row = [...section.querySelectorAll("li.vurs-play-resource")]
    .find(candidate => candidate.dataset.resource === resourceKey);
  return row?.querySelector(".vurs-play-resource-control, .vurs-play-resource-segments, input") ?? null;
}

function finishCurrentPlayResourceRow(section, resourceKey) {
  const currentControl = getCurrentPlayResourceControl(section, resourceKey);
  if (!currentControl) return;
  delete currentControl.dataset.updating;
  if (currentControl instanceof HTMLButtonElement || currentControl instanceof HTMLInputElement) {
    currentControl.disabled = false;
  }
}

function refreshCurrentPlayResourceRow(section, resourceKey, actor) {
  const currentControl = getCurrentPlayResourceControl(section, resourceKey);
  if (currentControl) refreshPlayResourceRow(currentControl, actor);
}

function refreshPlayResourceRow(control, actor, pendingUpdates = null, pending = false) {
  const row = control?.closest?.("li.vurs-play-resource");
  const section = row?.closest?.(".vurs-play-resources");
  if (!row || !section || !row.isConnected) return;

  const resourceKey = row.dataset.resource;
  const resource = getPlayResourceEntries(actor).find(entry => entry.key === resourceKey);
  if (!resource) {
    row.remove();
    return;
  }

  // Apply the pending value to the UI before awaiting Foundry's actor update.
  // This is a display-only optimistic update; actor data is still persisted by
  // actor.update() and the row is reconciled from saved data afterward.
  if (pendingUpdates) {
    for (const [path, value] of Object.entries(pendingUpdates)) {
      const [key, property] = path.split(".");
      if (key !== resourceKey) continue;
      if (property === "value") resource.value = Math.clamp(finiteResourceNumber(value), 0, resource.max);
      if (property === "maxReduction") {
        resource.maxReduction = Math.max(0, finiteResourceNumber(value));
        resource.max = Math.max(0, resource.baseMax - resource.maxReduction);
        resource.value = Math.clamp(resource.value, 0, resource.max);
      }
    }
  }

  const replacement = createPlayResourceRow(resource, actor);
  if (pending) {
    const replacementControl = replacement.querySelector(".vurs-play-resource-control, input");
    if (replacementControl) {
      replacementControl.dataset.updating = "true";
      if (replacementControl instanceof HTMLButtonElement || replacementControl instanceof HTMLInputElement) {
        replacementControl.disabled = true;
      }
    }
  }
  row.replaceWith(replacement);
  if (resourceKey === "styleRank") {
    const sheet = replacement.closest(".actor.sheet.character") ?? replacement.closest("form");
    if (sheet) renderStyleRankOverlay(sheet, actor, pendingUpdates?.["styleRank.value"]);
  }
}

function getResourceIcon(resource) {
  const value = Math.floor(resource.value);
  if (resource.key === "styleRank") {
    if (value <= 0) return "PassiveSR.webp";
    if (value === 1) return "OneSR.webp";
    if (value === 2) return "TwoSR.webp";
    if (value === 3) return "ThreeSR.webp";
    return "LongerSR.webp";
  }
  if (value <= 0) {
    const depletedIcons = {
      staminaPoints: "PassiveSP.webp",
      tacticPoints: "PassiveTP.webp",
      karmaPoints: "PassiveKP.webp"
    };
    return depletedIcons[resource.key] ?? "Passive.webp";
  }
  if (resource.key === "actionPoints") {
    if (value === 1) return "OneAction.webp";
    if (value === 2) return "TwoActions.webp";
    if (value === 3) return "ThreeActions.webp";
    if (value === 4) return "OneAP.webp";
    if (value === 5) return "TwoAP.webp";
    if (value === 6) return "ThreeAP.webp";
    return "LongerAP.webp";
  }
  const suffix = {
    staminaPoints: "SP",
    tacticPoints: "TP",
    styleRank: "SR",
    karmaPoints: "KP"
  }[resource.key] ?? "TP";
  if (resource.key === "reactions") return "Reaction.svg";
  if (value === 1) return `One${suffix}.webp`;
  if (value === 2) return `Two${suffix}.webp`;
  if (value === 3) return `Three${suffix}.webp`;
  return `Longer${suffix}.webp`;
}

function finiteResourceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function renderStyleRankOverlay(root, actor, rankOverride = undefined) {
  const sheet = root.matches(".actor.sheet.character")
    ? root
    : root.closest(".actor.sheet.character") ?? root.querySelector(".actor.sheet.character");
  if (!sheet) return;
  const host = sheet.querySelector(".window-content, .application-content") ?? sheet;
  host.classList.add("vurs-style-rank-host");
  const existing = host.querySelector(":scope > .vurs-style-rank-overlay");
  if (!actorUsesVursSystem(actor)) {
    existing?.remove();
    return;
  }
  const rank = Math.clamp(Math.floor(finiteResourceNumber(
    rankOverride ?? foundry.utils.getProperty(actor, `${PLAY_RESOURCES_PATH}.styleRank.value`)
  )), 0, 5);
  if (rank === 0) {
    existing?.remove();
    styleRankPhraseCache.delete(actor.uuid ?? actor.id ?? "actor");
    return;
  }

  const overlay = existing ?? document.createElement("aside");
  overlay.className = `vurs-style-rank-overlay rank-${rank}${rank === 5 ? " rank-s" : ""}`;
  const rankCode = [null, "1D", "2C", "3B", "4A", "5S"][rank];
  const icon = document.createElement("img");
  icon.src = `modules/vurs-pf2e/assets/custom-icons/resource-icons/Style-Rank_${rankCode}.svg`;
  icon.alt = `Style Rank ${rankCode}`;
  const caption = document.createElement("span");
  caption.className = "vurs-style-rank-caption";
  caption.textContent = getStyleRankPhrase(actor, rank);
  overlay.replaceChildren(icon, caption);
  if (!existing) host.append(overlay);
}

function getStyleRankPhrase(actor, rank) {
  const key = actor.uuid ?? actor.id ?? "actor";
  const current = styleRankPhraseCache.get(key);
  if (current?.rank !== rank) {
    const phrases = STYLE_RANK_PHRASES[rank];
    styleRankPhraseCache.set(key, {
      rank,
      phrase: phrases[Math.floor(Math.random() * phrases.length)]
    });
  }
  return styleRankPhraseCache.get(key).phrase;
}

function formatResourceNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function sizeNumberField(input, value) {
  input.style.width = `${Math.max(1, String(value).length)}ch`;
}

function normalizeLabel(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleUpperCase();
}