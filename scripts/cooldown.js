import {
  actorHasUsedNova,
  actorHasUsedSupernova,
  getVursEffectSourceItemUuid,
  itemHasNovaTrait,
  itemHasSupernovaTrait
} from "./features/disableConditions.js";
import { normalizeToken } from "./features/collateralGeometry.js";

const MODULE_ID = "vurs-pf2e";
const VURS_FLAG_SCOPE = "vurs";
const COOLDOWN_TRAIT = /^cooldown-(\d+)$/;
const RECHARGE_FLAG = /#Recharge\s+([^}\]]+)/i;
const DESCRIPTION_INLINE = /\[\[([\s\S]*?)\]\]/g;
const processingCooldownMessages = new Set();
const processingRechargeMessages = new Set();
const processingNovaMessages = new Set();
const processingSupernovaMessages = new Set();
const processingItems = new Set();
const pendingRecharges = new Map();
const RECHARGE_PENDING_TTL = 15 * 60 * 1000;
// The four createChatMessage handlers all need the same combatant/item for a
// message — resolve once per message instead of four times.
const messageContextCache = new Map();
const MESSAGE_CONTEXT_TTL = 60 * 1000;

function getMessageContext(message) {
  const cached = messageContextCache.get(message.id);
  if (cached) return cached;
  const promise = (async () => {
    const origin = message.flags?.[game.system.id]?.origin;
    const itemUuid = origin?.uuid ?? origin?.itemUuid;
    if (!itemUuid) return { itemUuid: null, combatant: null, actor: null, item: null };
    const combatant = getMessageCombatant(message);
    const actor = combatant?.actor ?? null;
    const item = await fromUuid(itemUuid);
    return { itemUuid, combatant, actor, item };
  })();
  messageContextCache.set(message.id, promise);
  setTimeout(() => messageContextCache.delete(message.id), MESSAGE_CONTEXT_TTL);
  return promise;
}

Hooks.on("createChatMessage", message => {
  if (!game.user.isGM || !game.system?.id || !game.combat?.started) return;
  if (game.users.activeGM && game.user.id !== game.users.activeGM.id) return;
  void applyCooldownFromMessage(message).catch(error => {
    console.error(`${MODULE_ID} | Failed to apply cooldown from chat message ${message.id}`, error);
  });
  void applyRechargeCooldownsFromMessage(message).catch(error => {
    console.error(`${MODULE_ID} | Failed to apply recharge cooldown from chat message ${message.id}`, error);
  });
  void applyNovaFromMessage(message).catch(error => {
    console.error(`${MODULE_ID} | Failed to apply Nova cooldown from chat message ${message.id}`, error);
  });
  void applySupernovaFromMessage(message).catch(error => {
    console.error(`${MODULE_ID} | Failed to apply Supernova cooldown from chat message ${message.id}`, error);
  });
});

function getMessageCombatant(message) {
  const speaker = message.speaker;
  return game.combat.combatants.find(candidate =>
    (speaker.token && candidate.tokenId === speaker.token) ||
    (!speaker.token && speaker.actor && candidate.actorId === speaker.actor)
  ) ?? null;
}

function hasCooldownEffect(actor, sourceItemUuid) {
  return actor.itemTypes.effect.some(effect =>
    getVursEffectSourceItemUuid(effect) === sourceItemUuid
  );
}

async function createCooldownEffect(actor, item, rounds, messageId, flagKey, initiative) {
  const sourceItemUuid = item.uuid;
  const processingItemKey = `${actor.uuid}:${sourceItemUuid}`;
  if (processingItems.has(processingItemKey)) return false;
  processingItems.add(processingItemKey);

  try {
    const effect = {
      name: `Cooldown: ${item.name}`,
      type: "effect",
      img: item.img || "icons/svg/daze.svg",
      system: {
        description: { value: `<p>${item.name} is cooling down and cannot be used for ${rounds} round${rounds === 1 ? "" : "s"}.</p>` },
        duration: { value: rounds, unit: "rounds", expiry: "turn-end" },
        start: { value: game.time.worldTime, initiative: initiative ?? 0 },
        tokenIcon: { show: true },
        rules: [],
        traits: { value: [], otherTags: [] }
      },
      flags: {
        vurs: {
          [flagKey]: messageId,
          sourceItemUuid
        }
      }
    };

    await actor.createEmbeddedDocuments("Item", [effect]);
    return true;
  } finally {
    processingItems.delete(processingItemKey);
  }
}

async function applyCooldownFromMessage(message) {
  const messageId = message.id;
  if (!messageId || processingCooldownMessages.has(messageId)) return;
  if (message.getFlag(VURS_FLAG_SCOPE, "cooldownApplied")) return;
  processingCooldownMessages.add(messageId);

  try {
    const { itemUuid, combatant, actor, item } = await getMessageContext(message);
    if (!itemUuid || !combatant || !actor || !item || (item.actor && item.actor.id !== actor.id)) return;

    const cooldownTrait = item.system?.traits?.value?.find(trait => COOLDOWN_TRAIT.test(trait));
    const match = cooldownTrait?.match(COOLDOWN_TRAIT);
    if (!match) return;
    const rounds = Number(match[1]);
    if (!Number.isInteger(rounds) || rounds < 1) return;

    if (hasCooldownEffect(actor, item.uuid)) return;

    const created = await createCooldownEffect(actor, item, rounds, messageId, "cooldownMessageId", combatant.initiative);
    if (created) await message.setFlag(VURS_FLAG_SCOPE, "cooldownApplied", true);
  } finally {
    processingCooldownMessages.delete(messageId);
  }
}

// Nova is once per encounter per actor: the first Nova-traited item used in
// combat marks the actor, and every Nova-traited item is disabled until the
// encounter ends (see applyCooldownChargeUpState / HUD pass).
async function applyNovaFromMessage(message) {
  const messageId = message.id;
  if (!messageId || processingNovaMessages.has(messageId)) return;
  if (message.getFlag(VURS_FLAG_SCOPE, "novaApplied")) return;
  processingNovaMessages.add(messageId);

  try {
    const { itemUuid, combatant, actor, item } = await getMessageContext(message);
    if (!itemUuid || !combatant || !actor || !item || !itemHasNovaTrait(item) || (item.actor && item.actor.id !== actor.id)) return;
    if (actorHasUsedNova(actor)) return;

    const processingKey = `${actor.uuid}:nova`;
    if (processingItems.has(processingKey)) return;
    processingItems.add(processingKey);

    try {
      await actor.createEmbeddedDocuments("Item", [{
        name: "Nova Used",
        type: "effect",
        img: item.img || "icons/svg/daze.svg",
        system: {
          description: { value: `<p>${item.name} was used. No other Nova can be used this encounter.</p>` },
          duration: { value: 0, unit: "encounter", expiry: null },
          rules: [],
          traits: { value: [], otherTags: [] }
        },
        flags: {
          vurs: {
            novaUsed: messageId
          }
        }
      }]);
      await message.setFlag(VURS_FLAG_SCOPE, "novaApplied", true);
    } finally {
      processingItems.delete(processingKey);
    }
  } finally {
    processingNovaMessages.delete(messageId);
  }
}

// Supernovas count as Novas: permanently add the "nova" trait to any item
// carrying "supernova" so every Nova check (per-actor lockout, cooldown
// display, glow) applies to it automatically.
function ensureNovaTraitOnSupernova(item) {
  const traits = item?.system?.traits?.value;
  if (!Array.isArray(traits) || !traits.includes("supernova") || traits.includes("nova")) return;
  item.update({ "system.traits.value": [...traits, "nova"] }).catch(error =>
    console.error(`${MODULE_ID} | Failed to add Nova trait to ${item.name}`, error)
  );
}

Hooks.on("createItem", ensureNovaTraitOnSupernova);
Hooks.on("updateItem", ensureNovaTraitOnSupernova);
Hooks.once("ready", () => {
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) ensureNovaTraitOnSupernova(item);
  }
});

// Supernova is once per encounter per allegiance group: using one marks every
// combatant actor sharing the user's token disposition, disabling their
// Supernova-traited items until the encounter ends.
async function applySupernovaFromMessage(message) {
  const messageId = message.id;
  if (!messageId || processingSupernovaMessages.has(messageId)) return;
  if (message.getFlag(VURS_FLAG_SCOPE, "supernovaApplied")) return;
  processingSupernovaMessages.add(messageId);

  try {
    const { itemUuid, combatant, actor, item } = await getMessageContext(message);
    if (!itemUuid || !combatant || !actor || !item || !itemHasSupernovaTrait(item) || (item.actor && item.actor.id !== actor.id)) return;

    const disposition = normalizeToken(combatant.token)?.disposition;
    const groupActors = new Map();
    for (const member of game.combat?.combatants ?? []) {
      if (!member.actor) continue;
      const memberDisposition = normalizeToken(member.token)?.disposition;
      if (memberDisposition === undefined || memberDisposition !== disposition) continue;
      groupActors.set(member.actor.uuid ?? member.actor.id, member.actor);
    }
    if (!groupActors.size) groupActors.set(actor.uuid ?? actor.id, actor);

    const targets = [...groupActors.values()];
    if (targets.some(target => actorHasUsedSupernova(target))) {
      await message.setFlag(VURS_FLAG_SCOPE, "supernovaApplied", true);
      return;
    }

    const processingKey = `${actor.uuid}:supernova`;
    if (processingItems.has(processingKey)) return;
    processingItems.add(processingKey);

    try {
      for (const target of targets) {
        await target.createEmbeddedDocuments("Item", [{
          name: "Supernova Used",
          type: "effect",
          img: item.img || "icons/svg/daze.svg",
          system: {
            description: { value: `<p>${item.name} was used. No other Supernova can be used by ${actor.name}'s allies this encounter.</p>` },
            duration: { value: 0, unit: "encounter", expiry: null },
            rules: [],
            traits: { value: [], otherTags: [] }
          },
          flags: {
            vurs: {
              supernovaUsed: messageId
            }
          }
        }]);
      }
      await message.setFlag(VURS_FLAG_SCOPE, "supernovaApplied", true);
    } finally {
      processingItems.delete(processingKey);
    }
  } finally {
    processingSupernovaMessages.delete(messageId);
  }
}

function isActiveGmClient() {
  return game.user.isGM && (!game.users.activeGM || game.user.id === game.users.activeGM.id);
}

// The Nova marker uses PF2e's "encounter" duration, but PF2e only auto-removes
// such effects when its removeEffects automation is enabled — clear it
// explicitly on encounter end / combat deletion as a guarantee.
function clearNovaEffectsForCombat(combat) {
  if (!isActiveGmClient()) return;
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    const effectIds = (actor.itemTypes?.effect ?? [])
      .filter(effect => effect.getFlag?.(VURS_FLAG_SCOPE, "novaUsed") || effect.getFlag?.(VURS_FLAG_SCOPE, "supernovaUsed"))
      .map(effect => effect.id);
    if (!effectIds.length) continue;
    actor.deleteEmbeddedDocuments("Item", effectIds).catch(error =>
      console.error(`${MODULE_ID} | Failed to clear Nova effects for ${actor.name}`, error)
    );
  }
}

Hooks.on("updateCombat", (combat, changes) => {
  if (changes?.started === false) clearNovaEffectsForCombat(combat);
});

Hooks.on("deleteCombat", clearNovaEffectsForCombat);

function normalizeItemName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeFormula(formula) {
  return String(formula ?? "").toLowerCase().replace(/\s+/g, "");
}

function findItemByName(actor, name) {
  const target = normalizeItemName(name);
  if (!target) return null;
  const items = actor.items.filter(item => !item.disabled);
  const exact = items.find(item => normalizeItemName(item.name) === target);
  if (exact) return exact;
  return items.find(item => {
    const candidate = normalizeItemName(item.name);
    return candidate && (candidate.includes(target) || target.includes(candidate));
  }) ?? null;
}

function getItemDescription(item) {
  return item?.system?.description?.value ?? item?.system?.description ?? "";
}

// Returns [{ name, formula }] for each #Recharge inline found in the item
// description, in document order.
function extractRechargeInlines(description) {
  const recharges = [];
  DESCRIPTION_INLINE.lastIndex = 0;
  let match;
  while ((match = DESCRIPTION_INLINE.exec(description)) !== null) {
    const inner = match[1];
    const flagMatch = inner.match(RECHARGE_FLAG);
    if (!flagMatch) continue;

    // Strip chat command prefix (e.g. "/br ") and the #flag suffix to get the dice formula.
    let formula = inner.split("#")[0].trim();
    formula = formula.replace(/^\/\S+\s+/, "").trim();

    recharges.push({
      name: flagMatch[1].trim(),
      formula: normalizeFormula(formula)
    });
  }
  return recharges;
}

function getMessageActor(message) {
  const combatant = getMessageCombatant(message);
  if (combatant?.actor) return combatant.actor;
  const actorId = message.speaker?.actor;
  if (actorId) {
    const actor = game.actors.get(actorId);
    if (actor) return actor;
  }
  const tokenId = message.speaker?.token;
  if (tokenId) {
    const token = canvas?.tokens?.get(tokenId) ?? canvas?.scene?.tokens?.get(tokenId);
    if (token?.actor) return token.actor;
  }
  return null;
}

function prunePendingRecharges(actorUuid) {
  const entries = pendingRecharges.get(actorUuid);
  if (!entries) return [];
  const now = Date.now();
  const fresh = entries.filter(entry => now - entry.ts < RECHARGE_PENDING_TTL);
  if (fresh.length) pendingRecharges.set(actorUuid, fresh);
  else pendingRecharges.delete(actorUuid);
  return fresh;
}

// A deferred inline roll (e.g. [[/br 1d4 #Recharge X]]) only evaluates when
// clicked, producing a plain roll chat message with no origin flag. Consume a
// pending recharge registered by the originating action card.
async function tryConsumePendingRecharge(message) {
  const rolls = message.rolls;
  if (!Array.isArray(rolls) || !rolls.length) return false;

  // Action cards carry their own evaluated rolls; only plain roll-result
  // messages (no origin) can satisfy a pending recharge.
  const origin = message.flags?.[game.system.id]?.origin;
  if (origin?.uuid ?? origin?.itemUuid) return false;

  const actor = getMessageActor(message);
  if (!actor) return false;

  const pending = prunePendingRecharges(actor.uuid);
  if (!pending.length) return false;

  for (const roll of rolls) {
    const formula = normalizeFormula(String(roll?.formula ?? "").split("#")[0]);
    const total = roll?.total;
    if (!formula || !Number.isFinite(total)) continue;

    const index = pending.findIndex(entry => entry.formula === formula);
    if (index === -1) continue;

    const [entry] = pending.splice(index, 1);
    if (!pending.length) pendingRecharges.delete(actor.uuid);
    else pendingRecharges.set(actor.uuid, pending);

    const rounds = Math.round(total);
    if (!Number.isFinite(rounds) || rounds < 1) return true;

    const target = findItemByName(actor, entry.name);
    if (!target || hasCooldownEffect(actor, target.uuid)) return true;

    await createCooldownEffect(actor, target, rounds, message.id, "rechargeMessageId", game.combat?.combatants?.find(c => c.actor === actor)?.initiative);
    return true;
  }

  return false;
}

async function applyRechargeCooldownsFromMessage(message) {
  const messageId = message.id;
  if (!messageId || processingRechargeMessages.has(messageId)) return;
  if (message.getFlag(VURS_FLAG_SCOPE, "rechargeCooldownApplied")) return;

  processingRechargeMessages.add(messageId);

  try {
    if (await tryConsumePendingRecharge(message)) {
      await message.setFlag(VURS_FLAG_SCOPE, "rechargeCooldownApplied", true);
      return;
    }

    const { itemUuid, combatant, actor, item } = await getMessageContext(message);
    if (!itemUuid || !combatant || !actor || !item || (item.actor && item.actor.id !== actor.id)) return;

    const recharges = extractRechargeInlines(getItemDescription(item));
    if (!recharges.length) return;

    const entries = pendingRecharges.get(actor.uuid) ?? [];
    const now = Date.now();
    for (const recharge of recharges) {
      entries.push({ name: recharge.name, formula: recharge.formula, ts: now });
    }
    pendingRecharges.set(actor.uuid, entries.slice(-20));

    await message.setFlag(VURS_FLAG_SCOPE, "rechargeCooldownApplied", true);
  } finally {
    processingRechargeMessages.delete(messageId);
  }
}
