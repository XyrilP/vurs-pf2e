import { actorCanOverheal } from "./systemModes.js";

const MODULE_ID = "vurs-pf2e";
const OVERHEAL_FLAG = "overheal";
const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
const damageTransactions = () =>
	globalThis[Symbol.for(`${MODULE_ID}.damageTransactions`)] ?? null;

const OVERHEAL_EFFECT_TYPES = new Set(["character", "npc", "familiar"]);

function getHealingAmount(damage) {
	const amount = typeof damage === "number" ? damage : Number(damage?.total);
	return Number.isFinite(amount) ? amount : null;
}

function resolveOverhealHealer(params) {
	const item = params?.item;
	const healer = item?.actor ?? item?.parent ?? null;
	if (healer) return healer;

	// Sub-heals (Lifesteal, collateral) carry no item of their own; the damage
	// transaction's root params still identify the actor that caused them.
	const transaction = damageTransactions()?.params?.get(params);
	const rootItem = transaction?.rootParams?.item;
	return rootItem?.actor ?? rootItem?.parent ?? null;
}

function createOverhealEffectData(amount) {
	return {
		name: "Overhealing",
		type: "effect",
		img: "modules/game-icons-net/blackbackground/health-increase.svg",
		system: {
			description: {
				value: `<p>Temporary Hit Points from Overhealing.</p>`
			},
			duration: { value: 1, unit: "rounds", expiry: "turn-start" },
			rules: [
				{
					key: "TempHP",
					slug: "overheal",
					label: "Overhealing",
					predicate: [],
					value: amount,
					events: { onCreate: true, onTurnStart: false }
				}
			],
			traits: { value: [], otherTags: [] }
		},
		flags: {
			vurs: { [OVERHEAL_FLAG]: true }
		}
	};
}

async function applyOverhealing(actor, wrapped, args) {
	const params = args[0];
	if (!params || typeof params !== "object" || params.vursOverhealProcessed) {
		return wrapped(...args);
	}
	params.vursOverhealProcessed = true;

	const requestedHealing = getHealingAmount(params.damage);
	if (requestedHealing === null || requestedHealing >= 0) {
		return wrapped(...args);
	}

	const healer = resolveOverhealHealer(params);
	if (!actorCanOverheal(healer)) {
		return wrapped(...args);
	}

	const hp = actor?.system?.attributes?.hp;
	const hpBefore = Number(hp?.value);
	const hpMax = Number(hp?.max);
	if (!Number.isFinite(hpBefore) || !Number.isFinite(hpMax)) {
		return wrapped(...args);
	}

	const result = await wrapped(...args);

	// Read the damage again after the wrapped chain: inner handlers (Healing
	// Effectiveness, received-healing reductions) may have adjusted it.
	const finalHealing = Math.abs(getHealingAmount(params.damage) ?? 0);
	const overheal = Math.trunc(finalHealing - Math.max(0, hpMax - hpBefore));
	if (overheal <= 0 || !OVERHEAL_EFFECT_TYPES.has(actor?.type)) {
		return result;
	}

	try {
		await actor.createEmbeddedDocuments("Item", [createOverhealEffectData(overheal)]);
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to apply Overhealing to ${actor.name}`, error);
	}
	return result;
}

damageHandlers.add(applyOverhealing);

// PF2E only deletes expired effects when its removeEffects automation is on.
// When it is off, the TempHP rule's onDelete never runs and hp.temp would
// linger, so sweep our flagged effects on combat boundaries ourselves.
Hooks.on("updateCombat", (combat, changes) => {
	if (changes?.turn === undefined && changes?.round === undefined) return;
	for (const actor of game.actors?.contents ?? []) {
		const expired = (actor.itemTypes?.effect ?? []).filter(item =>
			item.flags?.vurs?.[OVERHEAL_FLAG] === true && item.remainingDuration?.expired === true
		);
		if (expired.length === 0) continue;
		actor.deleteEmbeddedDocuments("Item", expired.map(item => item.id)).catch(error =>
			console.error(`${MODULE_ID} | Failed to remove expired Overhealing effect from ${actor.name}`, error)
		);
	}
});
