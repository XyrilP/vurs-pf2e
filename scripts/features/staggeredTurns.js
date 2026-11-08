import { getActorSystemMode, isAgnosticVursMode } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const STAGGERED_SLUG = "staggered";
const APPLIED_FLAG = "applied";
const UNTIL_ROUND_FLAG = "untilRound";
const ITEM_ID_FLAG = "itemId";

const STAGGERED_SETTING_KEYS = Object.freeze({
	default: "staggeredTurnDelayInDefault",
	vurs: "staggeredTurnDelayInVurs",
	agnostic: "staggeredTurnDelayInAgnostic"
});

export function staggeredTurnDelayEnabled(actor) {
	const mode = getActorSystemMode(actor);
	const key = mode === "vurs"
		? STAGGERED_SETTING_KEYS.vurs
		: isAgnosticVursMode(mode)
			? STAGGERED_SETTING_KEYS.agnostic
			: STAGGERED_SETTING_KEYS.default;
	return game.settings.get(MODULE_ID, key) === true;
}

// VURS Staggered ships as a compendium "effect" item (and may also appear as
// a "condition"). Match by slug first, then by name as a fallback for items
// that don't carry system.slug.
function isStaggeredItem(item) {
	if (!item || (item.type !== "condition" && item.type !== "effect")) return false;
	if (item.system?.slug === STAGGERED_SLUG) return true;
	return typeof item.name === "string" && item.name.toLowerCase().includes(STAGGERED_SLUG);
}

function findStaggeredConditionItem(actor) {
	return actor?.items?.find(isStaggeredItem) ??
		actor?.conditions?.bySlug?.(STAGGERED_SLUG)?.[0] ?? null;
}

function getStaggeredCondition(actor) {
	const item = findStaggeredConditionItem(actor);
	if (!item) return null;
	const badgeValue = Number(item.system?.badge?.value);
	const raw = Number.isInteger(badgeValue) && badgeValue > 0
		? badgeValue
		: item.system?.value?.value;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) return null;
	return { item, value };
}

// Presence check — the staggered condition remains on the actor (with a spent
// badge) until their delayed turn starts.
export function actorHasStaggeredCondition(actor) {
	return findStaggeredConditionItem(actor) !== null;
}

function getActorCombatant(combat, actor) {
	const combatants = combat?.combatants ?? [];
	// Prefer exact and token-scoped matches: with multiple tokens of the same
	// actor, a bare actor.id match can resolve the wrong combatant.
	return combatants.find(candidate =>
		candidate.actor === actor || candidate.actor?.uuid === actor?.uuid
	) ?? combatants.find(candidate =>
		candidate.token?.actor === actor || candidate.token?.actor?.uuid === actor?.uuid
	) ?? combatants.find(candidate =>
		candidate.actor?.id === actor?.id || candidate.token?.actor?.id === actor?.id
	) ?? null;
}

function getStaggeredFlags(actor) {
	const flags = foundry.utils.getProperty(actor, "flags.vurs.staggered") ?? {};
	return {
		applied: Number.isInteger(Number(flags[APPLIED_FLAG])) && Number(flags[APPLIED_FLAG]) > 0
			? Number(flags[APPLIED_FLAG])
			: 0,
		untilRound: Number.isInteger(Number(flags[UNTIL_ROUND_FLAG]))
			? Number(flags[UNTIL_ROUND_FLAG])
			: 0,
		itemId: typeof flags[ITEM_ID_FLAG] === "string" ? flags[ITEM_ID_FLAG] : null
	};
}

async function applyStaggeredReposition(actor, count, applyRound = null, resolvedCombatant = null, endedOwnTurn = false) {
	const combat = game.combat;
	if (!combat?.started || count < 1) return;
	const combatant = resolvedCombatant ?? getActorCombatant(combat, actor);
	if (!combatant) return;

	// combat.turns is a plain Array of Combatant documents sorted by initiative,
	// but it is only rebuilt by setupTurns() — refresh it first so the index
	// math reflects the live order rather than a stale snapshot.
	combat.setupTurns?.();
	const turns = combat.turns ?? [];
	const length = turns.length;
	const index = turns.indexOf(combatant);
	if (index < 0 || length < 2) return;
	// Snapshot the pointer while indices are still consistent — used below to
	// tell whether this combatant already acted this round.
	const turnIndexAtApply = combat.turn;

	// The actor acts `count` combatants later: they land immediately after the
	// combatant `count` slots ahead in the cyclic order. Without a wrap that is
	// insertion index `index + count`; with a wrap the followed combatant keeps
	// its index (the actor's removal doesn't shift it), so the insertion index
	// is one higher — landing before it would act too early.
	const cyclicIndex = index + count;
	const wrapped = cyclicIndex >= length;
	const targetIndex = Math.min(
		wrapped ? (cyclicIndex % length) + 1 : cyclicIndex,
		length - 1
	);

	const rest = turns.filter(turn => turn.id !== combatant.id);
	const above = rest[targetIndex - 1];
	const below = rest[targetIndex];

	// PF2e breaks initiative ties through flags.pf2e.overridePriority, keyed by
	// the initiative value (EncounterPF2e._sortCombatants) — the same mechanism
	// the combat tracker's drag reorder uses. Slot the combatant into the anchor
	// initiative's tie group instead of inventing fractional initiatives.
	const currentCombatantId = combat.combatant?.id;
	const numeric = value => typeof value === "number" && Number.isFinite(value);

	const belowInit = below && numeric(below.initiative) ? below.initiative : null;
	const aboveInit = above && numeric(above.initiative) ? above.initiative : null;
	let anchor = null;
	if (belowInit !== null) {
		anchor = belowInit;
	} else if (aboveInit !== null) {
		// Last place: share the lowest initiative, sorted after its group.
		anchor = aboveInit;
	}
	if (anchor === null) return;

	// Every combatant sharing the anchor initiative forms a contiguous tie
	// group. Partition it at the insertion point so the staggered combatant
	// lands at exactly targetIndex — inside the group for ties, before it for
	// distinct neighbors, last for bottom slots — then renumber the group's
	// priorities 0..n-1 in that order, mirroring the tracker's drag reorder.
	const before = [];
	const after = [];
	rest.forEach((turn, i) => {
		if (numeric(turn.initiative) && turn.initiative === anchor) {
			(i < targetIndex ? before : after).push(turn);
		}
	});
	const ordered = [...before, combatant, ...after];
	// Changing initiative re-sorts combat.turns and can shift the turn index
	// off the active combatant — re-pin it below, mirroring setMultipleInitiatives.
	await combat.updateEmbeddedDocuments("Combatant", ordered.map((turn, rank) => ({
		_id: turn.id,
		...(turn.id === combatant.id ? { initiative: anchor } : {}),
		flags: { pf2e: { overridePriority: { [anchor]: rank } } }
	})));
	// combat.turn is an index into the sorted turns array — after the resort the
	// same index can point at a different combatant. Force a synchronous
	// re-sort before locating the current combatant, otherwise a stale
	// combat.turns can make the re-pin a no-op and skip a turn.
	if (currentCombatantId != null) {
		combat.setupTurns?.();
		const newIndex = combat.turns?.findIndex(turn => turn.id === currentCombatantId) ?? -1;
		if (newIndex >= 0 && newIndex !== combat.turn) {
			// turnEvents: false — the index shift is bookkeeping, not a real turn
			// change; without it Foundry re-fires end/start turn events and can
			// end the current combatant's turn early.
			await combat.update({ turn: newIndex }, { turnEvents: false });
		}
	}
	combat.setupTurns?.();

	const staggeredItem = findStaggeredConditionItem(actor);
	const updates = {
		[`flags.vurs.staggered.${APPLIED_FLAG}`]: getStaggeredFlags(actor).applied + count,
		[`flags.vurs.staggered.${ITEM_ID_FLAG}`]: staggeredItem?.id ?? null
	};
	// Sit out the rest of the round when the delayed slot would be reached again
	// this round: always on a wrap, and whenever the combatant already acted
	// earlier this round (index at/before the pointer). Exception: when the
	// stagger ended their own turn, the delayed turn is still owed this round —
	// they act at their new slot after the intervening combatants.
	const alreadyActed = Number.isInteger(turnIndexAtApply) && index <= turnIndexAtApply;
	if (wrapped || (alreadyActed && !endedOwnTurn)) {
		updates[`flags.vurs.staggered.${UNTIL_ROUND_FLAG}`] = combat.round + 1;
	}
	await actor.update(updates);

	// The reposition consumes the stagger — the badge shows 0 while the
	// condition itself remains until the actor's delayed turn starts.
	if (staggeredItem) {
		// Zero whichever field carries the displayed count — badge.value is the
		// preferred read, but valued items may also surface system.value.value.
		// Separate updates so an invalid path on one can't reject the other.
		for (const path of ["system.badge.value", "system.value.value"]) {
			void staggeredItem.update({ [path]: 0 }).catch(error =>
				console.error(`${MODULE_ID} | Failed to clear Staggered ${path}`, error)
			);
		}
	}
}

async function handleStaggeredItem(item) {
	if (!isStaggeredItem(item)) return;
	const actor = item.actor ?? item.parent;
	if (!actor || actor.documentName !== "Actor") return;
	if (!staggeredTurnDelayEnabled(actor)) return;
	const staggered = getStaggeredCondition(actor);
	if (!staggered) return;
	const combat = game.combat;
	const staggeredCombatant = getActorCombatant(combat, actor);
	if (!combat?.started || !staggeredCombatant) return;

	const flags = getStaggeredFlags(actor);
	// `applied` only counts toward the item instance it was recorded for — a
	// removed-then-reapplied Staggered starts fresh even if the flag cleanup
	// hasn't run yet.
	const applied = flags.itemId && flags.itemId === staggered.item.id ? flags.applied : 0;
	const delta = staggered.value - applied;
	if (delta <= 0) return;

	// Staggered during their own turn ends the turn before the order moves.
	// Compare combatants, not actors — multiple tokens can share an actor.
	const applyRound = combat.round;
	const endOwnTurn = combat.combatant?.id === staggeredCombatant.id;
	if (endOwnTurn) {
		await combat.nextTurn();
		// Turn events are dispatched asynchronously after nextTurn() resolves
		// (_manageTurnEvents is not awaited by the combat update). Wait for
		// combatTurnChange — fired only after all turn events finish — so the
		// initiative move can't race the new combatant's turn-start processing.
		await new Promise(resolve => {
			const handler = () => {
				Hooks.off("combatTurnChange", handler);
				resolve();
			};
			Hooks.on("combatTurnChange", handler);
			setTimeout(() => {
				Hooks.off("combatTurnChange", handler);
				resolve();
			}, 3000);
		});
	}
	// Defer the initiative move until the turn change has fully settled —
	// repositioning while the turn update is still processing can leave
	// combat.turn pointing at the wrong combatant.
	await new Promise(resolve => setTimeout(resolve, 0));
	await applyStaggeredReposition(actor, delta, applyRound, staggeredCombatant, endOwnTurn);
}

// createItem and updateItem can both fire for one application, and the async
// reposition must not interleave — serialize handling per actor so the second
// call observes the first call's `applied` bookkeeping instead of racing it.
const staggeredItemQueues = new Map();

function queueStaggeredItem(item) {
	const actor = item.actor ?? item.parent;
	const key = actor?.id ?? item.id;
	if (!key) return;
	const previous = staggeredItemQueues.get(key) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(() => handleStaggeredItem(item))
		.catch(error =>
			console.error(`${MODULE_ID} | Failed to apply Staggered turn delay`, error)
		)
		.finally(() => {
			if (staggeredItemQueues.get(key) === next) staggeredItemQueues.delete(key);
		});
	staggeredItemQueues.set(key, next);
}

Hooks.on("createItem", item => {
	if (isStaggeredItem(item)) queueStaggeredItem(item);
});

Hooks.on("updateItem", (item, changes) => {
	if (!isStaggeredItem(item)) return;
	if (!foundry.utils.hasProperty(changes ?? {}, "system.value.value") &&
		!foundry.utils.hasProperty(changes ?? {}, "system.value") &&
		!foundry.utils.hasProperty(changes ?? {}, "system.badge.value") &&
		!foundry.utils.hasProperty(changes ?? {}, "system.badge")) return;
	// Our own badge-consumption write (and any external zeroing) never needs a
	// reposition.
	if (foundry.utils.getProperty(changes, "system.badge.value") === 0 &&
		!foundry.utils.hasProperty(changes, "system.value")) return;
	queueStaggeredItem(item);
});

// Removing the Staggered item by any means (manual delete, rest, another
// module) must also clear the reposition bookkeeping, or a later Staggered
// computes its delta against a stale `applied` value.
Hooks.on("deleteItem", item => {
	if (!isStaggeredItem(item)) return;
	const actor = item.actor ?? item.parent;
	if (!actor?.id) return;
	void actor.update({
		"flags.vurs.staggered": new foundry.data.operators.ForcedDeletion()
	}).catch(error =>
		console.error(`${MODULE_ID} | Failed to clear Staggered bookkeeping`, error)
	);
});

function clearStaggeredFlagsForCombat(combat) {
	for (const combatant of combat?.combatants ?? []) {
		const actor = combatant.actor;
		if (!actor?.id || !foundry.utils.getProperty(actor, "flags.vurs.staggered")) continue;
		void actor.update({
			"flags.vurs.staggered": new foundry.data.operators.ForcedDeletion()
		}).catch(() => {});
	}
}

Hooks.on("deleteCombat", clearStaggeredFlagsForCombat);

Hooks.on("updateCombat", (combat, changes) => {
	if (changes?.started === false) {
		clearStaggeredFlagsForCombat(combat);
		return;
	}
	if (!combat?.started || (changes?.turn === undefined && changes?.round === undefined)) return;
	const actor = combat.combatant?.actor;
	if (!actor) return;
	const staggeredItem = findStaggeredConditionItem(actor);
	if (!staggeredItem) return;

	// untilRound only applies to the item instance it was written for — a stale
	// value from an earlier Staggered must not skip a later round's turn.
	const flags = getStaggeredFlags(actor);
	const untilRound = flags.itemId && flags.itemId === staggeredItem.id ? flags.untilRound : 0;
	if (untilRound > combat.round) {
		// Wrapped/already-acted stagger: the actor sits out the rest of this round.
		// Defer nextTurn() — calling it synchronously inside updateCombat nests a
		// combat.update inside the turn-change update currently being processed,
		// which can lose the skip.
		setTimeout(() => {
			const stillCurrent = combat.combatant?.actor;
			const stillStaggered = stillCurrent && findStaggeredConditionItem(stillCurrent);
			if (!combat.started || !stillStaggered) return;
			void Promise.resolve(combat.nextTurn())
				.catch(error =>
					console.error(`${MODULE_ID} | Failed to skip Staggered turn`, error)
				);
		}, 0);
		return;
	}

	void actor.deleteEmbeddedDocuments("Item", [staggeredItem.id])
		.then(() => actor.update({
			"flags.vurs.staggered": new foundry.data.operators.ForcedDeletion()
		}))
		.catch(error =>
			console.error(`${MODULE_ID} | Failed to remove Staggered condition at turn start`, error)
		);
});
