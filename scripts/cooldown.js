const MODULE_ID = "vurs-pf2e";
const COOLDOWN_TRAIT = /^cooldown-(\d+)$/;

Hooks.on("createChatMessage", message => {
  if (!game.user.isGM || game.system.id !== "pf2e" || !game.combat?.started) return;
  void applyCooldownFromMessage(message);
});

async function applyCooldownFromMessage(message) {
  const itemUuid = message.flags?.pf2e?.origin?.uuid;
  if (!itemUuid) return;

  const speaker = message.speaker;
  const combatant = game.combat.combatants.find(candidate =>
    (speaker.token && candidate.tokenId === speaker.token) ||
    (!speaker.token && speaker.actor && candidate.actorId === speaker.actor)
  );
  if (!combatant?.actor) return;

  const item = await fromUuid(itemUuid);
  if (!item || (item.actor && item.actor.id !== combatant.actor.id)) return;

  const cooldownTrait = item.system?.traits?.value?.find(trait => COOLDOWN_TRAIT.test(trait));
  const match = cooldownTrait?.match(COOLDOWN_TRAIT);
  if (!match) return;
  const rounds = Number(match[1]);
  if (!Number.isInteger(rounds) || rounds < 1) return;

  const actor = combatant.actor;
  const effectKey = `cooldownMessageId`;
  if (actor.itemTypes.effect.some(effect => effect.getFlag(MODULE_ID, effectKey) === message.id)) return;

  const effect = {
    name: `Cooldown: ${item.name}`,
    type: "effect",
    img: item.img || "icons/svg/daze.svg",
    system: {
      description: { value: `<p>${item.name} is cooling down and cannot be used for ${rounds} round${rounds === 1 ? "" : "s"}.</p>` },
      duration: { value: rounds, unit: "rounds", expiry: "turn-end" },
      start: { value: game.time.worldTime, initiative: combatant.initiative ?? 0 },
      tokenIcon: { show: true },
      rules: [],
      traits: { value: [], otherTags: [] }
    },
    flags: {
      [MODULE_ID]: {
        [effectKey]: message.id,
        sourceItemUuid: item.uuid
      }
    }
  };

  await actor.createEmbeddedDocuments("Item", [effect]);
}
