import { actorUsesDicelessRolls, getActorSystemMode } from "./systemModes.js";
import { findActorInRollContext, getNestedRollDice } from "./diceless.js";
import { addNpcPrepareDerivedDataHandler } from "./npcConfiguration.js";

const MODULE_ID = "vurs-pf2e";
const HEROISM_FLAG = "heroism";
const HERO_POINTS_SLUG = "hero-points";
const MYTHIC_POINTS_SLUG = "mythic-points";
const NPC_CONFIG_RENDER_HOOK = `${MODULE_ID}.npcConfigurationRendered`;
const PENDING_NPC_REROLLS = [];
const PENDING_NPC_REROLL_TTL = 10000;
const PENDING_REROLL_REQUESTS = [];
const PENDING_REROLL_REQUEST_TTL = 10000;
const REROLL_TRACKER = Symbol("vurs-pf2e.heroismRerollTracker");
const PENDING_MYTHIC_DISPLAY = { oldRoll: null, newRoll: null };
const MYTHIC_NATURAL_BONUS = 10;
const VURS_MYTHIC_NATURAL_BONUS = Symbol("vurs-pf2e.mythicNaturalBonus");
const VURS_MYTHIC_ORIGINALS = Symbol("vurs-pf2e.mythicOriginals");

const HEROISM_STATE_CACHE = new Map();
const HEROISM_STATE_CACHE_LIMIT = 500;

function computeHeroismState(actor) {
	const mode = getActorSystemMode(actor);
	const settingEnabled = game.settings.get(MODULE_ID, "heroismInDefault") === true;
	return {
		mode,
		enabled: mode !== "default" || settingEnabled,
		settingDriven: mode === "default" && settingEnabled
	};
}

// Resolving the actor system mode scans actor flag sources several times, so
// the result is cached per actor and invalidated on actor updates and
// setting changes.
function resolveHeroismState(actor) {
	const key = actor?.uuid;
	if (!key) return computeHeroismState(actor);
	const cached = HEROISM_STATE_CACHE.get(key);
	if (cached) return cached;
	if (HEROISM_STATE_CACHE.size >= HEROISM_STATE_CACHE_LIMIT) HEROISM_STATE_CACHE.clear();
	const state = computeHeroismState(actor);
	HEROISM_STATE_CACHE.set(key, state);
	return state;
}

export function heroismEnabled(actor) {
	if (!actor) return false;
	return resolveHeroismState(actor).enabled;
}

// True only when Heroism is active through the heroismInDefault setting
// (Default mode). In VURS/Agnostic modes Heroism is locked on and pools keep
// their native defaults instead of starting disabled.
function heroismPoolsSettingDriven(actor) {
	return resolveHeroismState(actor).settingDriven;
}

Hooks.on("updateActor", actor => {
	if (actor?.uuid) HEROISM_STATE_CACHE.delete(actor.uuid);
});
Hooks.on("settingChanged", () => HEROISM_STATE_CACHE.clear());

function heroismData(actor) {
	const data = actor?.flags?.vurs?.[HEROISM_FLAG];
	return data && typeof data === "object" ? data : {};
}

function npcHeroPointsConfig(actor) {
	const config = heroismData(actor).npcHeroPoints;
	return config && typeof config === "object" ? config : null;
}

function npcHeroPointsEnabled(actor) {
	return npcHeroPointsConfig(actor)?.enabled === true;
}

function clampResourceInt(value, fallback, min, max) {
	const parsed = Math.floor(Number(value));
	const base = Number.isFinite(parsed) ? parsed : Math.floor(Number(fallback)) || 0;
	return Math.min(Math.max(base, min), max);
}

// Applies a configured max override (or the Heroism Hero Point default for
// Mythic characters) to a real system resource, restoring the persisted value
// that PF2e's native prepare-time clamp may have zeroed while max was 0.
function syncHeroismResource(actor, resources, key) {
	const resource = resources?.[key];
	if (!resource || typeof resource !== "object") return;
	const override = heroismData(actor).maxOverrides?.[key];
	const hasOverride = override !== undefined && override !== null && Number.isFinite(Number(override));
	const isCharacterHeroPoints = key === "heroPoints" && actor.isOfType?.("character");
	const currentMax = Number(resource.max) || 0;
	const desiredMax = hasOverride
		? Math.max(0, Math.floor(Number(override)))
		: heroismPoolsSettingDriven(actor)
			? 0
			: isCharacterHeroPoints && currentMax <= 0
				? 3
				: currentMax;
	const sourceValue = Number(actor._source?.system?.resources?.[key]?.value);
	resource.max = desiredMax;
	if (Number.isFinite(sourceValue)) {
		resource.value = Math.min(Math.max(0, Math.floor(sourceValue)), desiredMax);
	} else if (key === "mythicPoints" && desiredMax > 0) {
		resource.value = desiredMax;
	} else {
		resource.value = Math.min(Math.max(0, Number(resource.value) || 0), desiredMax);
	}
}

function syncNpcHeroPointsMirror(actor, resources) {
	const config = npcHeroPointsConfig(actor);
	if (!npcHeroPointsEnabled(actor)) {
		if ("heroPoints" in resources) delete resources.heroPoints;
		return;
	}
	const max = clampResourceInt(config?.max, 3, 0, 99);
	const value = clampResourceInt(config?.value, max, 0, max);
	resources.heroPoints = { value, max };
}

function heroismNpcPrepareDerivedDataHandler(actor, result) {
	if (!actor?.isOfType?.("npc")) return result;
	const resources = actor.system?.resources;
	if (!resources) return result;
	if (!heroismEnabled(actor)) {
		if ("heroPoints" in resources) delete resources.heroPoints;
		return result;
	}
	syncNpcHeroPointsMirror(actor, resources);
	syncHeroismResource(actor, resources, "mythicPoints");
	return result;
}

export function applyHeroismCharacterPreparation(actor) {
	if (!actor?.isOfType?.("character") || !heroismEnabled(actor)) return;
	const resources = actor.system?.resources;
	if (!resources) return;
	syncHeroismResource(actor, resources, "heroPoints");
	syncHeroismResource(actor, resources, "mythicPoints");
}

Hooks.once("ready", () => {
	addNpcPrepareDerivedDataHandler(heroismNpcPrepareDerivedDataHandler);
	installHeroismMythicNaturalBonus();
	trackRerollRequests();
});

// --- Hero Point rerolls behave as Fortune rerolls (keep the higher result) ---

// rerollFromMessage receives the chat message, but the pf2e.preReroll /
// pf2e.reroll hooks only receive the roll objects, which carry no actor
// reference. Tracking the request lets the hooks recover the actor (and the
// requested resource) from the originating message.
function trackRerollRequests() {
	const check = game.pf2e?.Check;
	if (typeof check?.rerollFromMessage !== "function" || check.rerollFromMessage[REROLL_TRACKER]) return;
	const original = check.rerollFromMessage;
	const wrapped = function (message, options = {}) {
		PENDING_REROLL_REQUESTS.push({
			messageId: message?.id ?? null,
			resource: options?.resource ?? null,
			expires: Date.now() + PENDING_REROLL_REQUEST_TTL
		});
		while (PENDING_REROLL_REQUESTS.length > 20) PENDING_REROLL_REQUESTS.shift();
		return original.call(this, message, options);
	};
	wrapped[REROLL_TRACKER] = true;
	check.rerollFromMessage = wrapped;
	if (typeof check.renderReroll === "function" && !check.renderReroll[REROLL_TRACKER]) {
		const originalRender = check.renderReroll;
		const wrappedRender = async function (roll, options = {}) {
			const pending = PENDING_MYTHIC_DISPLAY;
			const isPendingOld = pending.oldRoll && roll === pending.oldRoll;
			// When the rerolled roll wins, the stored original is discarded and
			// should display its raw natural result rather than the +10 bonus.
			if (options?.isOld && isPendingOld && !(pending.oldRoll.total > pending.newRoll.total)) {
				return renderRollWithRawMythicNatural(roll, () => originalRender.call(this, roll, options));
			}
			return originalRender.call(this, roll, options);
		};
		wrappedRender[REROLL_TRACKER] = true;
		check.renderReroll = wrappedRender;
	}
}

// Applies the Mythic Point +10 to an already-evaluated roll's d20 dice,
// recording the pre-bonus values for the breakdown label.
function boostRollNaturalBonus(roll) {
	const Die = foundry.dice?.terms?.Die;
	if (!roll || typeof roll !== "object" || !Die) return 0;
	let delta = 0;
	for (const die of getNestedRollDice(roll)) {
		if (!(die instanceof Die) || Number(die.faces) !== 20) continue;
		const originals = (die[VURS_MYTHIC_ORIGINALS] ??= []);
		for (const [index, entry] of (die.results ?? []).entries()) {
			const value = Number(entry?.result);
			if (!Number.isFinite(value)) continue;
			originals.push({ value, bonus: MYTHIC_NATURAL_BONUS });
			const boosted = Math.min(value + MYTHIC_NATURAL_BONUS, Number(die.faces));
			delta += boosted - value;
			entry.result = boosted;
		}
	}
	if (delta) roll._total = (Number(roll._total) || 0) + delta;
	return delta;
}

// Temporarily restores a boosted roll's raw natural results so a discarded
// original renders truthfully, then re-applies the bonus.
async function renderRollWithRawMythicNatural(roll, render) {
	const saved = [];
	const savedOriginals = [];
	let rawDelta = 0;
	for (const die of getNestedRollDice(roll)) {
		const originals = die?.[VURS_MYTHIC_ORIGINALS];
		if (!Array.isArray(originals) || !originals.length) continue;
		savedOriginals.push([die, originals]);
		die[VURS_MYTHIC_ORIGINALS] = [];
		for (const [index, entry] of (die.results ?? []).entries()) {
			const original = originals[Math.min(index, originals.length - 1)];
			const boosted = Number(entry?.result);
			const raw = Number(original?.value);
			if (!Number.isFinite(boosted) || !Number.isFinite(raw)) continue;
			saved.push([entry, boosted]);
			rawDelta += boosted - raw;
			entry.result = raw;
		}
	}
	const boostedTotal = Number(roll._total) || 0;
	roll._total = boostedTotal - rawDelta;
	try {
		return await render();
	} finally {
		for (const [entry, boosted] of saved) entry.result = boosted;
		for (const [die, originals] of savedOriginals) die[VURS_MYTHIC_ORIGINALS] = originals;
		roll._total = boostedTotal;
	}
}

function mythicCompareTotal(roll) {
	const Die = foundry.dice?.terms?.Die;
	if (!roll || !Die) return roll?.total ?? 0;
	let delta = 0;
	for (const die of getNestedRollDice(roll)) {
		if (!(die instanceof Die) || Number(die.faces) !== 20) continue;
		const originals = die[VURS_MYTHIC_ORIGINALS];
		const results = die.results;
		if (!Array.isArray(originals) || !originals.length || !results?.length) continue;
		const stored = Number(results.at(-1)?.result);
		const base = Number(originals.at(-1));
		if (Number.isFinite(stored) && Number.isFinite(base)) delta += stored - base;
	}
	return (roll.total ?? 0) - delta;
}

function shadowRollTotalForComparison(roll, compareTotal) {
	if (!roll || !Number.isFinite(compareTotal)) return;
	const realTotal = roll.total;
	let reads = 0;
	Object.defineProperty(roll, "total", {
		configurable: true,
		get() {
			reads += 1;
			return reads === 1 ? compareTotal : realTotal;
		}
	});
}

function rollHasMythicBonus(roll) {
	const Die = foundry.dice?.terms?.Die;
	if (!roll || !Die) return false;
	for (const die of getNestedRollDice(roll)) {
		if (die instanceof Die && Number(die.faces) === 20 &&
			Array.isArray(die[VURS_MYTHIC_ORIGINALS]) && die[VURS_MYTHIC_ORIGINALS].length) return true;
	}
	return false;
}

function pendingRerollRequest() {
	const now = Date.now();
	for (let i = PENDING_REROLL_REQUESTS.length - 1; i >= 0; i--) {
		const entry = PENDING_REROLL_REQUESTS[i];
		if (entry.expires < now) {
			PENDING_REROLL_REQUESTS.splice(i, 1);
			continue;
		}
		return entry;
	}
	return null;
}

function coerceRollActor(value) {
	if (!value) return null;
	if (typeof value === "object") {
		if (typeof value.isOfType === "function" &&
			value.isOfType("character", "npc", "creature", "hazard")) return value;
		return value.actor ?? null;
	}
	if (typeof value === "string") {
		try { return fromUuidSync(value); } catch { return game.actors?.get(value) ?? null; }
	}
	return null;
}

function resolveRerollActor(originalRoll) {
	const request = pendingRerollRequest();
	const messageActor = request?.messageId ? game.messages.get(request.messageId)?.actor : null;
	// options.actor resolves cheaply for most check rolls; the deep context
	// traversal is only a fallback.
	let actor = messageActor ??
		coerceRollActor(originalRoll?.options?.actor) ??
		findActorInRollContext(originalRoll) ??
		findActorInRollContext(originalRoll?.options);
	if (actor?.isOfType?.("familiar") && actor.master) actor = actor.master;
	return actor;
}

function signedModifierString(value) {
	if (value === 0) return "";
	return value > 0 ? `+${value}` : `${value}`;
}

// Rebuilds the reroll as a normal check roll (undoing PF2e's native Mythic
// Point proficiency swap) and flags it so the d20 natural result gains +10,
// clamped at 20, during evaluation.
function prepareHeroismMythicReroll(originalRoll, newRoll) {
	if (!newRoll || typeof newRoll !== "object") return;
	const dice = originalRoll?.options?.dice;
	const totalModifier = Number(originalRoll?.options?.totalModifier);
	// Rebuilding is only required to undo PF2e's character-only proficiency
	// swap. When the roll options lack the data (for example NPC attack
	// rolls), flag the roll as-is so the natural-roll bonus still applies.
	if (typeof dice === "string" && Number.isFinite(totalModifier) && typeof newRoll.constructor === "function") {
		const replacement = new newRoll.constructor(
			`${dice}${signedModifierString(totalModifier)}`,
			newRoll.data,
			{ ...newRoll.options, totalModifier, vursHeroismMythicBonus: true }
		);
		Object.assign(newRoll, replacement);
		return;
	}
	newRoll.options = { ...(newRoll.options ?? {}), vursHeroismMythicBonus: true };
}

// Stamps Mythic Point rerolls so each d20 Die returns min(natural + 10, 20),
// changing the natural roll itself like the Buildup mechanic does.
function installHeroismMythicNaturalBonus() {
	const Die = foundry.dice?.terms?.Die;
	const Roll = foundry.dice?.Roll ?? globalThis.Roll;
	if (!Die?.prototype || !Roll?.prototype) return;
	if (!Die.prototype.__vursHeroismDieInstalled) {
		const originalDieRoll = Die.prototype._roll;
		Die.prototype._roll = async function (...args) {
			const result = await originalDieRoll.apply(this, args);
			const bonus = this[VURS_MYTHIC_NATURAL_BONUS];
			if (!Number.isFinite(bonus) || bonus === 0) return result;
			const value = Number(result);
			const faces = Number(this.faces);
			if (!Number.isFinite(value) || !Number.isFinite(faces) || faces <= 0) return result;
			(this[VURS_MYTHIC_ORIGINALS] ??= []).push({ value, bonus });
			return Math.min(value + bonus, faces);
		};

		Object.defineProperty(Die.prototype, "__vursHeroismDieInstalled", { value: true });
	}
	// Digital fulfillment makes _roll return undefined and roll() falls back
	// to randomFace(), so the bonus must be applied there as well.
	if (!Die.prototype.__vursHeroismFaceInstalled) {
		const originalRandomFace = Die.prototype.randomFace;
		Die.prototype.randomFace = function (...args) {
			const face = originalRandomFace.apply(this, args);
			const bonus = this[VURS_MYTHIC_NATURAL_BONUS];
			if (!Number.isFinite(bonus) || bonus === 0) return face;
			const value = Number(face);
			const faces = Number(this.faces);
			if (!Number.isFinite(value) || !Number.isFinite(faces) || faces <= 0) return face;
			(this[VURS_MYTHIC_ORIGINALS] ??= []).push({ value, bonus });
			return Math.min(value + bonus, faces);
		};
		Object.defineProperty(Die.prototype, "__vursHeroismFaceInstalled", { value: true });
	}
	// Show the pre-bonus natural result in the breakdown (e.g. "6+10→16").
	if (!Die.prototype.__vursHeroismLabelInstalled) {
		const originalLabel = Die.prototype.getResultLabel;
		Die.prototype.getResultLabel = function (result) {
			const originals = this[VURS_MYTHIC_ORIGINALS];
			if (Array.isArray(originals) && originals.length) {
				const index = Math.max(0, this.results?.indexOf(result) ?? 0);
				const resultCount = Math.max(1, this.results?.length ?? 1);
				const entry = originals[Math.min(Math.max(0, originals.length - resultCount + index), originals.length - 1)];
				if (entry) return `${entry.value}+${entry.bonus}→${result.result}`;
			}
			return originalLabel.call(this, result);
		};
		Object.defineProperty(Die.prototype, "__vursHeroismLabelInstalled", { value: true });
	}
	if (!Roll.prototype.__vursHeroismRollInstalled) {
		const originalEvaluate = Roll.prototype.evaluate;
		Roll.prototype.evaluate = async function (...args) {
			const stamped = [];
			if (this.options?.vursHeroismMythicBonus === true) {
				for (const die of getNestedRollDice(this)) {
					if (die instanceof Die && Number(die.faces) === 20) {
						die[VURS_MYTHIC_NATURAL_BONUS] = MYTHIC_NATURAL_BONUS;
						stamped.push(die);
					}
				}
			}
			try {
				return await originalEvaluate.apply(this, args);
			} finally {
				for (const die of stamped) delete die[VURS_MYTHIC_NATURAL_BONUS];
			}
		};
		Object.defineProperty(Roll.prototype, "__vursHeroismRollInstalled", { value: true });
	}
}

Hooks.on("pf2e.preReroll", (originalRoll, newRoll, resource, rerollOptions = {}) => {
	// Resolve the pool slug before touching the actor: most rerolls are
	// native non-resource rerolls that Heroism never applies to.
	let slug = resource?.slug ?? pendingRerollRequest()?.resource ?? null;
	let actor = null;
	if (slug === null && PENDING_NPC_REROLLS.length > 0) {
		// NPC pools may not resolve through getResource if the in-memory
		// mirror was stripped; the pending menu request identifies the pool.
		actor = resolveRerollActor(originalRoll);
		if (actor?.isOfType?.("npc")) slug = peekPendingNpcReroll(actor);
	}
	if (slug !== HERO_POINTS_SLUG && slug !== MYTHIC_POINTS_SLUG) return;
	actor ??= resolveRerollActor(originalRoll);
	if (!actor || !heroismEnabled(actor) || actorUsesDicelessRolls(actor)) return;
	rerollOptions.keep = "higher";
	if (slug === MYTHIC_POINTS_SLUG) {
		prepareHeroismMythicReroll(originalRoll, newRoll);
	}
});

// PF2e only spends Hero/Mythic Points for characters inside rerollFromMessage.
// NPC pools live in flags.vurs.heroism (Hero Points) or the real
// system.resources.mythicPoints field (Mythic Points), so spend them here.
Hooks.on("pf2e.reroll", (originalRoll, result, resource, rerollOptions = {}) => {
	const request = pendingRerollRequest();
	let slug = resource?.slug ?? request?.resource ?? null;
	let actor = null;
	if (slug === null && PENDING_NPC_REROLLS.length > 0) {
		actor = resolveRerollActor(originalRoll);
		if (actor?.isOfType?.("npc")) slug = consumePendingNpcReroll(actor);
	}
	if (slug !== HERO_POINTS_SLUG && slug !== MYTHIC_POINTS_SLUG) return;
	actor ??= resolveRerollActor(originalRoll);
	if (!actor || !heroismEnabled(actor)) return;
	if (slug === MYTHIC_POINTS_SLUG) {
		// Boost the stored original roll as well, but only when the new roll
		// actually carries the bonus (preReroll skips diceless actors), so
		// the keep-higher comparison always runs on equal footing.
		const flagged = result?.options?.vursHeroismMythicBonus === true;
		const liveOld = flagged && request?.messageId
			? game.messages.get(request.messageId)?.rolls?.[0]
			: null;
		if (liveOld && liveOld !== result) {
			// Only boost a raw original; an already-boosted roll keeps its
			// single +10 so repeat Mythic rerolls don't stack the bonus.
			if (!rollHasMythicBonus(liveOld)) boostRollNaturalBonus(liveOld);
			// PF2e keeps the old roll only when c.total > m.total, and ties
			// keep the new roll. Shadow total so the first comparison read
			// uses pre-bonus totals (raw naturals decide the winner); every
			// later read (degree, render, serialize) sees the boosted total.
			shadowRollTotalForComparison(liveOld, mythicCompareTotal(liveOld));
			shadowRollTotalForComparison(result, mythicCompareTotal(result));
			PENDING_MYTHIC_DISPLAY.oldRoll = liveOld;
			PENDING_MYTHIC_DISPLAY.newRoll = result;
		}
	}
	if (!actor.isOfType?.("npc")) return;
	if (slug === HERO_POINTS_SLUG) {
		const config = npcHeroPointsConfig(actor);
		if (!npcHeroPointsEnabled(actor)) return;
		const max = clampResourceInt(config?.max, 3, 0, 99);
		const current = clampResourceInt(config?.value, max, 0, max);
		if (current <= 0) return;
		void updateHeroismData(actor, data => {
			const next = { ...(data.npcHeroPoints ?? {}) };
			next.enabled = true;
			next.max = max;
			next.value = current - 1;
			data.npcHeroPoints = next;
			return data;
		}).catch(error => console.error(`${MODULE_ID} | Failed to spend NPC Hero Point`, error));
	} else {
		const current = Number(actor.system?.resources?.mythicPoints?.value) || 0;
		if (current <= 0) return;
		void actor.update({ "system.resources.mythicPoints.value": current - 1 })
			.catch(error => console.error(`${MODULE_ID} | Failed to spend NPC Mythic Point`, error));
	}
});

function peekPendingNpcReroll(actor) {
	const now = Date.now();
	for (let i = PENDING_NPC_REROLLS.length - 1; i >= 0; i--) {
		const entry = PENDING_NPC_REROLLS[i];
		if (entry.expires < now) {
			PENDING_NPC_REROLLS.splice(i, 1);
			continue;
		}
		if (entry.actorUuid === actor.uuid) return entry.slug;
	}
	return null;
}

function consumePendingNpcReroll(actor) {
	const now = Date.now();
	for (let i = PENDING_NPC_REROLLS.length - 1; i >= 0; i--) {
		const entry = PENDING_NPC_REROLLS[i];
		if (entry.expires < now) {
			PENDING_NPC_REROLLS.splice(i, 1);
			continue;
		}
		if (entry.actorUuid === actor.uuid) {
			PENDING_NPC_REROLLS.splice(i, 1);
			return entry.slug;
		}
	}
	return null;
}

// --- Chat card reroll entries for NPC Hero/Mythic Points ---

function npcRerollContext(element) {
	const message = game.messages.get(element?.dataset?.messageId, { strict: true });
	let actor = message?.actor ?? null;
	if (actor?.isOfType?.("familiar")) actor = actor.master ?? actor;
	if (!message?.isRerollable || !actor?.isOfType?.("npc") || !heroismEnabled(actor)) return null;
	return { message, actor };
}

function npcPoolValue(actor, slug) {
	if (slug === HERO_POINTS_SLUG) {
		if (!npcHeroPointsEnabled(actor)) return 0;
		const config = npcHeroPointsConfig(actor);
		const max = clampResourceInt(config?.max, 3, 0, 99);
		return clampResourceInt(config?.value, max, 0, max);
	}
	return Number(actor.system?.resources?.mythicPoints?.value) || 0;
}

function heroismChatMenuEntries() {
	return [
		{
			label: game.i18n.localize("VURS.Heroism.RerollHeroPoint"),
			icon: "fa-solid fa-circle-h",
			visible: element => {
				const context = npcRerollContext(element);
				return !!context && npcPoolValue(context.actor, HERO_POINTS_SLUG) > 0;
			},
			onClick: (event, element) => {
				const context = npcRerollContext(element);
				if (context) triggerNpcResourceReroll(context.message, context.actor, HERO_POINTS_SLUG);
			}
		},
		{
			label: game.i18n.localize("VURS.Heroism.RerollMythicPoint"),
			icon: "fa-solid fa-circle-m",
			visible: element => {
				const context = npcRerollContext(element);
				return !!context && npcPoolValue(context.actor, MYTHIC_POINTS_SLUG) > 0;
			},
			onClick: (event, element) => {
				const context = npcRerollContext(element);
				if (context) triggerNpcResourceReroll(context.message, context.actor, MYTHIC_POINTS_SLUG);
			}
		}
	];
}

function triggerNpcResourceReroll(message, actor, slug) {
	PENDING_NPC_REROLLS.push({ actorUuid: actor.uuid, slug, expires: Date.now() + PENDING_NPC_REROLL_TTL });
	while (PENDING_NPC_REROLLS.length > 20) PENDING_NPC_REROLLS.shift();
	// rerollFromMessage is a static on PF2e's Check class (game.pf2e.Check)
	// and uses private statics, so it must be invoked as a method on the class.
	if (typeof game.pf2e?.Check?.rerollFromMessage === "function") {
		void game.pf2e.Check.rerollFromMessage(message, { resource: slug });
		return;
	}
	console.error(`${MODULE_ID} | PF2e Check.rerollFromMessage unavailable`);
}

// The chat-card context menu items are collected once when the ChatLog
// first renders, so they are added through Foundry's official hook rather
// than by patching the ChatLog prototype.
Hooks.on("getChatMessageContextOptions", (chatLog, menuItems) => {
	if (Array.isArray(menuItems)) menuItems.push(...heroismChatMenuEntries());
});

// --- Sheet UI: Heroism section on the Biography (character) / Notes (NPC) tab ---

const HEROISM_POOL_KEYS = {
	heroPoints: "heroPoints",
	mythicPoints: "mythicPoints"
};

function heroismPoolState(actor, pool) {
	if (actor.isOfType?.("npc") && pool === "mythicPoints") {
		const resource = actor.system?.resources?.mythicPoints;
		const max = Number(resource?.max) || 0;
		return {
			enabled: max > 0,
			value: Number(resource?.value) || 0,
			max: max > 0 ? max : 3
		};
	}
	if (pool === "heroPoints" && actor.isOfType?.("npc")) {
		const config = npcHeroPointsConfig(actor);
		const enabled = npcHeroPointsEnabled(actor);
		const max = clampResourceInt(config?.max, 3, 0, 99);
		return {
			enabled,
			value: clampResourceInt(config?.value, max, 0, max),
			max
		};
	}
	const resource = actor.system?.resources?.[HEROISM_POOL_KEYS[pool]];
	const max = Number(resource?.max) || 0;
	return {
		enabled: max > 0,
		value: Number(resource?.value) || 0,
		max: max > 0 ? max : 3
	};
}

function heroismPoolLabel(pool) {
	return pool === "heroPoints"
		? game.i18n.localize("PF2E.Actor.Resource.HeroPoints")
		: game.i18n.localize("PF2E.Actor.Resource.MythicPoints");
}

function appendHeroismNumberInput(row, pool, part, label, state) {
	const field = document.createElement("label");
	field.className = "vurs-heroism-field";
	const caption = document.createElement("span");
	caption.textContent = label;
	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.value = String(state[part] ?? 0);
	input.dataset.vursHeroismPool = pool;
	input.dataset.vursHeroismPart = part;
	field.append(caption, input);
	row.append(field);
}

function buildHeroismPoolRow(actor, pool, editable) {
	const state = heroismPoolState(actor, pool);
	const isNpc = actor.isOfType?.("npc");
	const row = document.createElement("div");
	row.className = "vurs-heroism-pool";
	const name = document.createElement("span");
	name.className = "vurs-heroism-pool-name";
	name.textContent = heroismPoolLabel(pool);
	row.append(name);
	{
		const enabledField = document.createElement("label");
		enabledField.className = "vurs-heroism-field vurs-heroism-enabled";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = state.enabled;
		checkbox.dataset.vursHeroismPool = pool;
		checkbox.dataset.vursHeroismPart = "enabled";
		const caption = document.createElement("span");
		caption.textContent = game.i18n.localize("VURS.Heroism.Enabled");
		enabledField.append(checkbox, caption);
		row.append(enabledField);
	}
	const controls = document.createElement("span");
	controls.className = "vurs-heroism-controls";
	row.append(controls);
	const valueState = { value: state.value };
	const maxState = { max: state.max };
	appendHeroismNumberInput(controls, pool, "value",
		game.i18n.localize("VURS.Heroism.Value"), valueState);
	appendHeroismNumberInput(controls, pool, "max",
		game.i18n.localize("VURS.Heroism.Max"), maxState);
	if (!editable) {
		row.querySelectorAll("input").forEach(input => { input.disabled = true; });
	} else if (!state.enabled) {
		row.querySelectorAll('input[type="number"]').forEach(input => { input.disabled = true; });
	}
	return row;
}

function injectHeroismSection(host, actor) {
	host.querySelectorAll(":scope > .vurs-heroism, :scope > header.vurs-heroism-header")
		.forEach(el => el.remove());
	const editable = actor.isOwner === true || game.user?.isGM === true;
	const isNpc = actor.isOfType?.("npc");
	const titleText = game.i18n.localize("VURS.Heroism.Title");

	const pools = document.createElement("div");
	pools.className = "vurs-heroism-pools";
	pools.append(
		buildHeroismPoolRow(actor, "heroPoints", editable),
		buildHeroismPoolRow(actor, "mythicPoints", editable)
	);

	const bindChanges = element => {
		element.addEventListener("change", event => {
			const input = event.target?.closest?.("[data-vurs-heroism-pool]");
			if (!input) return;
			void handleHeroismFieldChange(actor, input);
		});
	};

	if (isNpc) {
		// NPC Notes tab sections are .notes-section blocks with an <h4> title.
		const section = document.createElement("div");
		section.className = "notes-section vurs-heroism";
		const heading = document.createElement("h4");
		heading.textContent = titleText;
		section.append(heading, pools);
		bindChanges(section);
		host.prepend(section);
		return;
	}

	// Character Biography tab sections use a direct-child <header><span>.
	const header = document.createElement("header");
	header.className = "vurs-heroism-header";
	const title = document.createElement("span");
	title.textContent = titleText;
	header.append(title);
	const section = document.createElement("section");
	section.className = "vurs-heroism";
	section.append(pools);
	bindChanges(section);
	host.prepend(header, section);
}

// NPC sheets only show Mythic Points natively (when max > 0). Inject a
// Hero Points row into the sidebar resources list, flag-backed so it never
// touches the NPC resource schema.
function fixNpcMythicPipIcons(root) {
	const pips = root.querySelector('.subsection.resources .pips[data-resource="mythic-points"]');
	if (!pips || pips.dataset.vursHeroismMythicIcons) return;
	pips.dataset.vursHeroismMythicIcons = "true";
	for (const icon of pips.querySelectorAll("i.fa-solid.fa-circle")) {
		icon.classList.remove("fa-circle");
		icon.classList.add("fa-circle-m");
	}
}

function injectNpcHeroismSidebar(root, actor) {
	if (!actor.isOfType?.("npc") || !npcHeroPointsEnabled(actor)) return;
	const sidebar = root.querySelector(".sidebar");
	if (!sidebar) return;
	const config = npcHeroPointsConfig(actor);
	const max = clampResourceInt(config?.max, 3, 0, 99);
	const value = clampResourceInt(config?.value, max, 0, max);

	let list = sidebar.querySelector(".subsection.resources:not([data-vurs-heroism-resources]) ol");
	if (!list) {
		const existing = sidebar.querySelector(".subsection.resources");
		if (existing?.dataset.vursHeroismResources) return;
		const subsection = document.createElement("div");
		subsection.className = "subsection resources";
		subsection.dataset.vursHeroismResources = "true";
		const header = document.createElement("header");
		const label = document.createElement("label");
		const icon = document.createElement("i");
		icon.className = "fa-solid fa-toolbox fa-fw";
		const title = document.createElement("span");
		title.textContent = game.i18n.localize("PF2E.Actor.Resources");
		label.append(icon, title);
		header.append(label);
		const ol = document.createElement("ol");
		subsection.append(header, ol);
		const anchor = sidebar.querySelector(".subsection.iwr") ?? null;
		if (anchor) sidebar.insertBefore(subsection, anchor);
		else sidebar.append(subsection);
		list = ol;
	}
	if (sidebar.querySelector("[data-vurs-heroism-pips]")) return;

	const item = document.createElement("li");
	item.className = "special-resource";
	const name = document.createElement("span");
	name.className = "label";
	name.textContent = game.i18n.localize("PF2E.Actor.Resource.HeroPoints");
	const pips = document.createElement("span");
	pips.className = "pips";
	pips.dataset.vursHeroismPips = "heroPoints";
	for (let index = 0; index < max; index++) {
		const icon = document.createElement("i");
		icon.className = value > index ? "fa-solid fa-circle-h" : "fa-regular fa-circle";
		pips.append(icon);
	}
	item.append(name, pips);
	list.append(item);

	if (!sidebar.dataset.vursHeroismPipsBound) {
		sidebar.dataset.vursHeroismPipsBound = "true";
		sidebar.addEventListener("click", event => adjustNpcHeroPointsPips(actor, event, 1));
		sidebar.addEventListener("contextmenu", event => {
			event.preventDefault();
			adjustNpcHeroPointsPips(actor, event, -1);
		});
	}
}

function adjustNpcHeroPointsPips(actor, event, delta) {
	const pips = event.target?.closest?.("[data-vurs-heroism-pips]");
	if (!pips || pips.dataset.vursHeroismPips !== "heroPoints") return;
	event.preventDefault();
	event.stopPropagation();
	const config = npcHeroPointsConfig(actor);
	const max = clampResourceInt(config?.max, 3, 0, 99);
	const current = clampResourceInt(config?.value, max, 0, max);
	const next = Math.min(Math.max(current + delta, 0), max);
	void updateHeroismData(actor, data => {
		const hp = { ...(data.npcHeroPoints ?? {}) };
		hp.enabled = true;
		hp.max = max;
		hp.value = next;
		data.npcHeroPoints = hp;
		return data;
	});
}

// PF2e's character header only renders one resource (Mythic Points win when
// both pools exist). Inject a companion Hero Points pip row so both appear.
function injectHeroismHeaderResource(root, actor) {
	if (!actor.isOfType?.("character")) return;
	const resources = actor.system?.resources;
	const mythic = resources?.mythicPoints;
	const hero = resources?.heroPoints;
	if (!(Number(mythic?.max) > 0) || !(Number(hero?.max) > 0)) return;
	const details = root.querySelector("header.char-header .char-details");
	if (!details || details.querySelector("[data-vurs-heroism-resource]")) return;

	const dots = document.createElement("div");
	dots.className = "dots";
	dots.dataset.vursHeroismResource = "hero-points";
	const label = document.createElement("span");
	label.className = "label";
	label.textContent = game.i18n.localize("PF2E.Actor.Resource.HeroPoints");
	const pips = document.createElement("span");
	pips.className = "pips";
	// PF2e binds adjust-resource listeners directly at render time, so injected
	// pips need their own handlers calling updateResource natively.
	pips.dataset.vursHeroismPips = "hero-points";
	pips.dataset.tooltip = game.i18n.format("PF2E.Actor.ResourceRatio", {
		value: hero.value,
		max: hero.max,
		resource: game.i18n.localize("PF2E.Actor.Resource.HeroPoints")
	});
	const adjustHeroPoints = delta => {
		const current = Number(actor.system?.resources?.heroPoints?.value) || 0;
		const max = Number(actor.system?.resources?.heroPoints?.max) || 0;
		void actor.updateResource("hero-points", Math.min(Math.max(current + delta, 0), max))
			.catch(error => console.error(`${MODULE_ID} | Failed to adjust Hero Points`, error));
	};
	pips.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		adjustHeroPoints(1);
	});
	pips.addEventListener("contextmenu", event => {
		event.preventDefault();
		event.stopPropagation();
		adjustHeroPoints(-1);
	});
	const max = Math.floor(Number(hero.max));
	const value = Number(hero.value) || 0;
	for (let index = 0; index < max; index++) {
		const icon = document.createElement("i");
		icon.className = value > index ? "fa-solid fa-circle-h" : "fa-regular fa-circle";
		pips.append(icon);
	}
	dots.append(label, pips);
	details.append(dots);
}

Hooks.on("renderActorSheet", (app, html) => {
	const actor = app?.actor;
	if (!heroismEnabled(actor)) return;
	const root = html instanceof HTMLElement ? html : html?.[0];
	if (!(root instanceof HTMLElement)) return;
	injectHeroismHeaderResource(root, actor);
	if (actor.isOfType?.("npc")) fixNpcMythicPipIcons(root);
	injectNpcHeroismSidebar(root, actor);
	const selector = actor.isOfType?.("character")
		? "section.tab.biography"
		: actor.isOfType?.("npc")
			? "div.tab.notes"
			: null;
	if (!selector) return;
	const host = root.querySelector(selector);
	if (host) injectHeroismSection(host, actor);
});

// --- NPC Configuration: Hero Points block in the Resources panel ---

function injectNpcConfigHeroism(panel, actor) {
	panel.querySelectorAll(":scope > .vurs-heroism-config").forEach(el => el.remove());
	const block = document.createElement("div");
	block.className = "npc-config-fieldset vurs-heroism-config";
	const heading = document.createElement("h4");
	heading.textContent = game.i18n.localize("VURS.Heroism.Title");
	block.append(heading);
	const config = npcHeroPointsConfig(actor);
	const enabled = npcHeroPointsEnabled(actor);
	const max = clampResourceInt(config?.max, 3, 0, 99);
	const value = clampResourceInt(config?.value, max, 0, max);

	const enabledField = document.createElement("label");
	enabledField.className = "form-group";
	const enabledInput = document.createElement("input");
	enabledInput.type = "checkbox";
	enabledInput.checked = enabled;
	enabledInput.dataset.vursNpcHeroism = "enabled";
	const enabledLabel = document.createElement("span");
	enabledLabel.textContent = `${heroismPoolLabel("heroPoints")} — ${game.i18n.localize("VURS.Heroism.Enabled")}`;
	enabledField.append(enabledInput, enabledLabel);
	block.append(enabledField);

	for (const [part, label, current] of [
		["value", game.i18n.localize("VURS.Heroism.Value"), value],
		["max", game.i18n.localize("VURS.Heroism.Max"), max]
	]) {
		const field = document.createElement("label");
		field.className = "form-group";
		const caption = document.createElement("span");
		caption.textContent = `${heroismPoolLabel("heroPoints")} ${label}`;
		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.value = String(current);
		input.dataset.vursNpcHeroism = part;
		field.append(caption, input);
		block.append(field);
	}
	block.addEventListener("change", event => {
		const input = event.target?.closest?.("[data-vurs-npc-heroism]");
		if (!input) return;
		void handleNpcConfigHeroismChange(actor, input);
	});
	panel.append(block);
	panel.append(buildNpcConfigMythicBlock(actor));
}

function buildNpcConfigMythicBlock(actor) {
	const block = document.createElement("div");
	block.className = "npc-config-fieldset vurs-heroism-config";
	const heading = document.createElement("h4");
	heading.textContent = heroismPoolLabel("mythicPoints");
	block.append(heading);
	const resource = actor.system?.resources?.mythicPoints;
	const state = heroismPoolState(actor, "mythicPoints");

	const enabledField = document.createElement("label");
	enabledField.className = "form-group";
	const enabledInput = document.createElement("input");
	enabledInput.type = "checkbox";
	enabledInput.checked = state.enabled;
	enabledInput.dataset.vursNpcMythic = "enabled";
	const enabledLabel = document.createElement("span");
	enabledLabel.textContent = game.i18n.localize("VURS.Heroism.Enabled");
	enabledField.append(enabledInput, enabledLabel);
	block.append(enabledField);

	for (const [part, label, current] of [
		["value", game.i18n.localize("VURS.Heroism.Value"), state.value],
		["max", game.i18n.localize("VURS.Heroism.Max"), state.max]
	]) {
		const field = document.createElement("label");
		field.className = "form-group";
		const caption = document.createElement("span");
		caption.textContent = label;
		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.value = String(current);
		input.dataset.vursNpcMythic = part;
		field.append(caption, input);
		block.append(field);
	}
	block.addEventListener("change", event => {
		const input = event.target?.closest?.("[data-vurs-npc-mythic]");
		if (!input) return;
		void handleNpcConfigMythicChange(actor, input);
	});
	return block;
}

Hooks.on(NPC_CONFIG_RENDER_HOOK, app => {
	const actor = app?.actor;
	if (!actor?.isOfType?.("npc") || !heroismEnabled(actor)) return;
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	const panel = root?.querySelector?.('[data-npc-config-panel="resources"]');
	if (panel) injectNpcConfigHeroism(panel, actor);
});

// --- Flag writes ---

async function updateHeroismData(actor, updater) {
	const current = heroismData(actor);
	const next = updater(foundry.utils.deepClone(current)) ?? current;
	await actor.setFlag("vurs", HEROISM_FLAG, next);
}

async function handleHeroismFieldChange(actor, input) {
	const pool = input.dataset.vursHeroismPool;
	const part = input.dataset.vursHeroismPart;
	const isNpc = actor.isOfType?.("npc");
	const systemKey = HEROISM_POOL_KEYS[pool];
	if (!systemKey || !part) return;

	if (part === "enabled") {
		const enabled = input.checked === true;
		if (pool === "heroPoints" && isNpc) {
			await updateHeroismData(actor, data => {
				const next = { ...(data.npcHeroPoints ?? {}) };
				next.enabled = enabled;
				if (enabled && next.max === undefined) next.max = 3;
				if (enabled && next.value === undefined) next.value = next.max;
				data.npcHeroPoints = next;
				return data;
			});
			return;
		}
		const state = heroismPoolState(actor, pool);
		await updateHeroismData(actor, data => {
			data.maxOverrides ??= {};
			data.maxOverrides[systemKey] = enabled ? (Number(state.max) || 3) : 0;
			return data;
		});
		return;
	}

	const raw = input.value.trim();
	const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
	if (parsed !== null && !Number.isFinite(parsed)) return;

	if (pool === "heroPoints" && isNpc) {
		await updateHeroismData(actor, data => {
			const next = { ...(data.npcHeroPoints ?? {}) };
			next.enabled = npcHeroPointsEnabled(actor);
			if (next.enabled) {
				if (part === "value") next.value = parsed ?? next.value ?? next.max ?? 3;
				if (part === "max") {
					next.max = parsed ?? 3;
					if (next.value === undefined || (parsed !== null && next.value > next.max)) next.value = next.max;
				}
			}
			data.npcHeroPoints = next;
			return data;
		});
		return;
	}

	if (part === "value") {
		const value = parsed ?? 0;
		await actor.update({ [`system.resources.${systemKey}.value`]: value })
			.catch(error => console.error(`${MODULE_ID} | Failed to update ${pool} value`, error));
		return;
	}

	await updateHeroismData(actor, data => {
		data.maxOverrides ??= {};
		if (parsed === null) delete data.maxOverrides[systemKey];
		else data.maxOverrides[systemKey] = parsed;
		if (Object.keys(data.maxOverrides).length === 0) delete data.maxOverrides;
		return data;
	});
}

async function handleNpcConfigMythicChange(actor, input) {
	const part = input.dataset.vursNpcMythic;
	if (part === "enabled") {
		const enabled = input.checked === true;
		const state = heroismPoolState(actor, "mythicPoints");
		await updateHeroismData(actor, data => {
			data.maxOverrides ??= {};
			data.maxOverrides.mythicPoints = enabled ? (Number(state.max) || 3) : 0;
			return data;
		});
		return;
	}
	const raw = input.value.trim();
	const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
	if (parsed !== null && !Number.isFinite(parsed)) return;
	if (part === "value") {
		await actor.update({ "system.resources.mythicPoints.value": parsed ?? 0 })
			.catch(error => console.error(`${MODULE_ID} | Failed to update Mythic Points value`, error));
		return;
	}
	if (part === "max") {
		await updateHeroismData(actor, data => {
			data.maxOverrides ??= {};
			if (parsed === null) delete data.maxOverrides.mythicPoints;
			else data.maxOverrides.mythicPoints = parsed;
			if (Object.keys(data.maxOverrides).length === 0) delete data.maxOverrides;
			return data;
		});
	}
}

async function handleNpcConfigHeroismChange(actor, input) {
	const part = input.dataset.vursNpcHeroism;
	if (part === "enabled") {
		await updateHeroismData(actor, data => {
			const next = { ...(data.npcHeroPoints ?? {}) };
			next.enabled = input.checked === true;
			if (next.enabled && next.max === undefined) next.max = 3;
			if (next.enabled && next.value === undefined) next.value = next.max;
			data.npcHeroPoints = next;
			return data;
		});
		return;
	}
	const raw = input.value.trim();
	const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
	if (parsed !== null && !Number.isFinite(parsed)) return;
	await updateHeroismData(actor, data => {
		const next = { ...(data.npcHeroPoints ?? {}) };
		next.enabled = npcHeroPointsEnabled(actor);
		if (part === "value") next.value = parsed ?? next.value ?? next.max ?? 3;
		if (part === "max") {
			next.max = parsed ?? 3;
			if (next.value === undefined || (parsed !== null && Number(next.value) > next.max)) next.value = next.max;
		}
		data.npcHeroPoints = next;
		return data;
	});
}

// Minimal styling so the injected section matches sheet density.
const HEROISM_STYLE = document.createElement("style");
HEROISM_STYLE.textContent = `
	.vurs-heroism { margin-top: 1rem; }
	.vurs-heroism-header { margin-top: 1rem; }
	.vurs-heroism-pools { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.25rem; }
	.vurs-heroism-pool { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
	.vurs-heroism-pool-name { font-weight: 600; min-width: 8rem; }
	.vurs-heroism-controls { display: flex; gap: 0.75rem; }
	.vurs-heroism-field { display: flex; align-items: center; gap: 0.35rem; }
	.vurs-heroism-field input[type="number"] { width: 4rem; }
	.vurs-heroism-enabled input { margin: 0; }
	.vurs-heroism-config { margin-top: 0.75rem; }
`;
document.head.append(HEROISM_STYLE);
