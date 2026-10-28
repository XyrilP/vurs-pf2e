import { actorHasDicelessFlag, actorUsesDicelessRolls, getSystemMode, isFullVursMode } from "./systemModes.js";
import { createVursPlayCostElement } from "./playCostIcons.js";

const MODULE_ID = "vurs-pf2e";
const VURS_DIE_RESULT = Symbol("vurs-pf2e.fixedDieResult");
export const VURS_CRITICAL_MAXIMUM_DIE = Symbol("vurs-pf2e.criticalMaximumDie");
const VURS_DAMAGE_ACTION_WRAPPED = Symbol("vurs-pf2e.damageActionContext");
const VURS_INLINE_DAMAGE_CONTEXT_PATCH = Symbol("vurs-pf2e.inlineDamageActorContext");
const activeVursCheckRolls = [];
const activeDamageActors = [];
function getCheckActor(check, options = {}) {
	return options.origin?.actor ?? options.actor ?? options.self?.actor ??
		options.token?.actor ?? options.item?.actor ?? check?.actor ?? check?.origin?.actor ??
		check?.statistic?.actor ?? check?.statistic?.parent?.actor ??
		findActorInRollContext(options) ?? findActorInRollContext(check);
}

function getDamageRollActor(roll) {
	const options = roll?.options ?? {};
	const damage = options.damage ?? {};
	const actor = damage.origin?.actor ?? damage.self?.actor ?? damage.actor ??
		options.origin?.actor ?? options.self?.actor ?? options.actor ??
		damage.item?.actor ?? options.item?.actor ?? roll?.actor ?? roll?.item?.actor ??
		roll?.parent?.actor ?? roll?.source?.actor ?? roll?.context?.actor ?? options.vursActorUuid;
	if (actor) return actor;

	return findActorInRollContext(roll) ?? findActorInRollContext(options);
}

export function getDamageRollActorForVurs(roll) {
	return getDamageRollActor(roll) ?? activeDamageActors.at(-1) ?? null;
}

function findActorInRollContext(value, seen = new WeakSet(), depth = 0) {
	if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
	seen.add(value);
	if (typeof value.isOfType === "function" && value.isOfType("character", "npc", "creature", "hazard")) return value;
	for (const key of ["actor", "actorId", "actorUuid", "sourceActor", "originActor", "origin", "self", "source", "item", "token", "damage", "context", "options"]) {
		const nested = value[key];
		if (!nested) continue;
		if (typeof nested === "string" && ["actor", "actorId", "actorUuid", "sourceActor", "originActor"].includes(key)) {
			let referencedActor = null;
			try { referencedActor = fromUuidSync(nested); } catch { /* Try the world actor collection below. */ }
			referencedActor ??= game.actors?.get(nested) ?? null;
			if (referencedActor?.isOfType?.("character", "npc", "creature", "hazard")) return referencedActor;
		}
		const found = Array.isArray(nested)
			? nested.map(entry => findActorInRollContext(entry, seen, depth + 1)).find(Boolean)
			: findActorInRollContext(nested, seen, depth + 1);
		if (found) return found;
	}
	return null;
}

export function installDicelessPatches() {
	installInlineDamageActorContext();
	installVursCheckRoll();
	installVursAverageDamage();
}

function installInlineDamageActorContext() {
	const textEditor = game.pf2e?.TextEditor;
	const original = textEditor?._onClickInlineRoll;
	if (typeof original !== "function" || textEditor[VURS_INLINE_DAMAGE_CONTEXT_PATCH]) return;

	textEditor._onClickInlineRoll = async function (event, ...args) {
		const anchor = event?.target?.closest?.("a");
		if (!anchor?.dataset?.formula || !("damageRoll" in anchor.dataset)) {
			return original.call(this, event, ...args);
		}

		const actor = getInlineDamageActor(anchor);
		if (!actor) return original.call(this, event, ...args);
		activeDamageActors.push(actor);
		try {
			return await original.call(this, event, ...args);
		} finally {
			const index = activeDamageActors.lastIndexOf(actor);
			if (index >= 0) activeDamageActors.splice(index, 1);
		}
	};
	Object.defineProperty(textEditor, VURS_INLINE_DAMAGE_CONTEXT_PATCH, { value: true });
}

function getInlineDamageActor(anchor) {
	const messageElement = anchor.closest("li.chat-message");
	const message = game.messages?.get(messageElement?.dataset.messageId ?? "");
	if (message?.speakerActor) return message.speakerActor;

	const appElement = anchor.closest(".sheet");
	const v2App = appElement?.id ? foundry.applications?.instances?.get(appElement.id) : null;
	const appId = Number(appElement?.dataset.appid);
	const app = v2App ?? (Number.isFinite(appId) ? ui.windows?.[appId] : null);
	if (app?.actor) return app.actor;
	if (app?.item?.actor) return app.item.actor;

	const itemUuid = anchor.closest("[data-item-uuid]")?.dataset.itemUuid;
	if (!itemUuid || itemUuid.startsWith("Compendium.")) return null;
	try { return fromUuidSync(itemUuid)?.actor ?? null; } catch { return null; }
}

export function installActorDamageActionContext(actor) {
	if (!actor?.isOfType?.("character", "npc", "creature")) return;
	const actions = actor.system?.actions;
	if (!Array.isArray(actions)) return;

	for (const action of actions) {
		for (const method of ["damage", "critical"]) {
			const original = action?.[method];
			if (typeof original !== "function" || original[VURS_DAMAGE_ACTION_WRAPPED]) continue;
			const wrapped = async function (...args) {
				activeDamageActors.push(actor);
				try {
					return await original.apply(this, args);
				} finally {
					const index = activeDamageActors.lastIndexOf(actor);
					if (index >= 0) activeDamageActors.splice(index, 1);
				}
			};
			Object.defineProperty(wrapped, VURS_DAMAGE_ACTION_WRAPPED, { value: true });
			action[method] = wrapped;
		}
	}
}

function installVursCheckRoll() {
	const checkApi = game.pf2e?.Check;
	if (!checkApi || typeof checkApi.roll !== "function" || checkApi.__vursCheckRollInstalled) return;

	const wrapper = async function (wrapped, check, options = {}, event = null, callback) {
		const actor = getCheckActor(check, options);
		const actorDiceless = actorHasDicelessFlag(actor);
		if (!actorUsesDicelessRolls(actor)) return wrapped(check, options, event, callback);

		const context = { ...options, vursBuildupEnabled: true };
		const state = { buildup: 0, context, actor, actorDiceless };
		// Keep this state out of PF2e's serialized check context while making it
		// available to the dialog and the die-roll adapter.
		Object.defineProperty(context, "__vursCheckState", { value: state });
		if (context.type === "flat-check") {
			const buildup = await chooseFlatCheckBuildup();
			if (buildup === null) return null;
			state.buildup = buildup;
			context.skipDialog = true;
		}

		// Respect PF2e's quick-roll preference. If it skips the dialog, Buildup
		// stays at 0 and the check still uses a fixed VURS base of 8.
		activeVursCheckRolls.push(state);
		try {
			return await wrapped(check, context, event, callback);
		} finally {
			const index = activeVursCheckRolls.lastIndexOf(state);
			if (index >= 0) activeVursCheckRolls.splice(index, 1);
		}
	};
	if (typeof globalThis.libWrapper?.register !== "function") {
		console.warn(`${MODULE_ID} | libWrapper is unavailable; skipping the VURS Check.roll wrapper`);
		return;
	}
	try {
		globalThis.libWrapper.register(MODULE_ID, "game.pf2e.Check.roll", wrapper, "WRAPPER");
		Object.defineProperty(checkApi, "__vursCheckRollInstalled", { value: true });
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to register libWrapper for game.pf2e.Check.roll`, error);
	}
}

Hooks.on("renderCheckModifiersDialog", (app, html) => {
	if (!app.context?.vursBuildupEnabled) return;
	if (!(app.options?.classes ?? []).includes("roll-modifiers-dialog")) return;

	const root = html instanceof HTMLElement ? html : html?.[0];
	const form = root?.querySelector("form.check-modifiers-content");
	if (!form || form.querySelector(".vurs-buildup-selector")) return;

	const group = document.createElement("div");
	group.className = "form-group vurs-buildup-selector";
	const buildupValues = [0, 2, 5, 10];
	const buildupCosts = ["", "1 AP or TP", "2 AP or TP combined", "3 AP or TP combined"];
	const label = document.createElement("span");
	label.className = "vurs-buildup-label";
	label.setAttribute("aria-live", "polite");
	const labelTitle = document.createElement("span");
	const labelModifier = document.createElement("span");
	labelModifier.className = "vurs-buildup-modifier";
	label.append(labelTitle, labelModifier);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "vurs-buildup-choice";
	const cost = document.createElement("span");
	cost.className = "vurs-buildup-cost";
	group.append(label, button, cost);
	const updateBuildupDisplay = () => {
		const state = app.context.__vursCheckState;
		const level = Math.max(0, buildupValues.indexOf(state?.buildup ?? 0));
		const modifier = buildupValues[level];
		const base = getAdjustedVursBase(8 + modifier, getVursCheckEffect(app.context));
		button.textContent = String(base);
		button.setAttribute("aria-label", `Buildup level ${level} of 3`);
		button.title = "Left-click or scroll up to increase; right-click or scroll down to decrease";
		labelTitle.textContent = "Buildup";
		labelModifier.textContent = `+${modifier}`;
		label.classList.toggle("off", level === 0);
		cost.replaceChildren();
		if (level > 0) cost.append(createVursPlayCostElement(`+${buildupCosts[level]}`, "top"));
	};
	updateBuildupDisplay();
	placeBuildupSelector(form, group);

	// PF2e refreshes the modifier form after some modifier changes. Keep the
	// selected buttons alive and move this same group into the refreshed form.
	const restoreChoices = () => {
		const currentForm = root.querySelector("form.check-modifiers-content");
		if (!currentForm) return;
		if (!currentForm.contains(group)) {
			placeBuildupSelector(currentForm, group);
			updateBuildupDisplay();
		}
		requestAnimationFrame(() => expandCheckDialog(currentForm, app, root));
	};
	const observer = new MutationObserver(restoreChoices);
	observer.observe(root, { childList: true, subtree: true });
	root.addEventListener("change", updateBuildupDisplay);
	root.addEventListener("click", event => {
		if (event.target.closest("[data-roll-twice]")) requestAnimationFrame(updateBuildupDisplay);
	});
	// Recalculate the dialog height once after inserting the extra row.
	app.options.height = "auto";
	requestAnimationFrame(() => expandCheckDialog(form, app, root));

	const changeBuildup = amount => {
		const state = app.context.__vursCheckState;
		if (!state) return;
		const currentLevel = Math.max(0, buildupValues.indexOf(state.buildup));
		const nextLevel = Math.clamp(currentLevel + amount, 0, buildupValues.length - 1);
		state.buildup = buildupValues[nextLevel];
		updateBuildupDisplay();
	};
	button.addEventListener("click", () => changeBuildup(1));
	button.addEventListener("contextmenu", event => {
		event.preventDefault();
		changeBuildup(-1);
	});
	button.addEventListener("wheel", event => {
		if (event.deltaY === 0) return;
		event.preventDefault();
		changeBuildup(event.deltaY < 0 ? 1 : -1);
	}, { passive: false });

	form.addEventListener("change", updateBuildupDisplay);
	form.addEventListener("click", event => {
		if (event.target.closest("[data-roll-twice]")) requestAnimationFrame(updateBuildupDisplay);
	});

});

function placeBuildupSelector(form, group) {
	const submitButton = form.querySelector('button[type="submit"]');
	if (!submitButton) {
		form.append(group);
		return;
	}
	const footer = submitButton.closest(".vurs-check-roll-footer");
	if (footer) {
		footer.insertBefore(group, submitButton);
		return;
	}
	const rollFooter = document.createElement("div");
	rollFooter.className = "vurs-check-roll-footer";
	submitButton.before(rollFooter);
	rollFooter.append(group, submitButton);
}

function expandCheckDialog(form, app, root) {
	if (!form?.isConnected) return;
	const appElement = app.element instanceof HTMLElement ? app.element : root.closest(".app");
	const content = appElement?.querySelector(".window-content") ?? root;
	const overflow = content.scrollHeight - content.clientHeight;
	if (overflow <= 0) return;

	const currentHeight = appElement?.getBoundingClientRect().height ?? app.position?.height ?? 0;
	// Grow by the exact clipped amount plus a small border allowance. This
	// keeps the dialog's own content area tall enough after each modifier edit.
	app.setPosition({ height: Math.ceil(currentHeight + overflow + 4) });
}

// Preserve VURS roll data when PF2e rerolls a check from its chat card.
// Rerolling for a new result (including a Hero Point) raises the base by 50%;
// keep-higher/lower rerolls continue to use Fortune/Misfortune rules.
Hooks.on("pf2e.preReroll", (originalRoll, newRoll, resource, rerollOptions = {}) => {
	const actor = findActorInRollContext(originalRoll?.options) ?? originalRoll?.options?.actor;
	const wasVursCheck = originalRoll?.options?.vursDiceless === true || actorUsesDicelessRolls(actor);
	if (!wasVursCheck || !Number.isFinite(originalRoll?.options?.vursRawBase)) return;
	newRoll.options.vursDiceless = true;
	newRoll.options.vursReroll = true;
	newRoll.options.vursBuildup = originalRoll.options.vursBuildup ?? 0;
	newRoll.options.vursRawBase = originalRoll.options.vursRawBase;
	newRoll.options.vursFixedBase = originalRoll.options.vursFixedBase;
	newRoll.options.vursRerollKeep = rerollOptions.keep ?? "new";
});

function chooseFlatCheckBuildup() {
	return foundry.applications.api.DialogV2.wait({
		window: { title: "VURS Check" },
		content: "Choose a Buildup value for this check.",
		rejectClose: false,
		buttons: [
			{ action: "base", label: "None (8)", default: true, callback: () => 0 },
			{ action: "two", label: "+2 (10)", callback: () => 2 },
			{ action: "five", label: "+5 (13)", callback: () => 5 },
			{ action: "ten", label: "+10 (18)", callback: () => 10 },
			{ action: "cancel", label: "Cancel", callback: () => null }
		]
	}).then(result => typeof result === "number" ? result : null);
}

/**
	* In full VURS, use the mathematical average for dice that belong to PF2e
	* damage rolls. This covers strike damage, spell damage, and PF2e inline
	* @Damage[] rolls, all of which use PF2e's DamageRoll class. Generic Foundry
	* Roll instances (including /r) are deliberately left random.
*/
function installVursAverageDamage() {
	const Die = foundry.dice?.terms?.Die;
	const Roll = foundry.dice?.Roll ?? globalThis.Roll;
	if (Die?.prototype && !Die.prototype.__vursResultInstalled) {
		const originalDieRoll = Die.prototype._roll;
		Die.prototype._roll = async function (...args) {
			if (this[VURS_CRITICAL_MAXIMUM_DIE]) return Number(this.faces);
			// The roll evaluator only stamps this temporary value for a VURS-mode
			// roll or a roll belonging to an actor with the diceless flag.
			if (Number.isFinite(this[VURS_DIE_RESULT])) {
				return this[VURS_DIE_RESULT];
			}
			return originalDieRoll.apply(this, args);
		};
		Object.defineProperty(Die.prototype, "__vursResultInstalled", { value: true });
	}

	if (Roll?.prototype && !Roll.prototype.__vursRollEvaluationInstalled) {
		const originalEvaluate = Roll.prototype.evaluate;
		Roll.prototype.evaluate = async function (...args) {
			const mode = getSystemMode();
			const rollClass = this.constructor?.name;
			const pendingCheck = activeVursCheckRolls.at(-1);
			const looksLikePf2eCheckRoll = rollClass === "CheckRoll" || (
				pendingCheck && typeof this.options?.dice === "string" && Number.isFinite(this.options?.totalModifier)
			);
			// The pending Check.roll wrapper is authoritative. PF2e can alter the
			// concrete CheckRoll class name or its serialized options between
			// system builds, so don't let those details disable the fixed result.
			const isPendingCheckRoll = Boolean(
				pendingCheck && !pendingCheck.rollApplied && looksLikePf2eCheckRoll
			);
			const checkActor = pendingCheck?.actor ?? this.options?.actor;
			const actorDiceless = pendingCheck?.actorDiceless || this.options.vursDiceless === true || actorUsesDicelessRolls(checkActor);
			const dicelessEnabled = checkActor ? actorDiceless : isFullVursMode(mode);
			const isVursCheckRoll = dicelessEnabled && (
				isPendingCheckRoll ||
				(!pendingCheck && looksLikePf2eCheckRoll) ||
				Number.isFinite(this.options?.vursFixedBase)
			);
			const activeState = isVursCheckRoll ? pendingCheck : null;
			const rawCheckBase = activeState
				? 8 + activeState.buildup
				: (isVursCheckRoll ? this.options.vursRawBase ?? this.options.vursFixedBase : null);
			let fixedCheckBase = activeState ? getVursCheckBase(activeState) : (isVursCheckRoll ? this.options.vursFixedBase : null);
			if (isVursCheckRoll && !activeState && Number.isFinite(rawCheckBase) &&
				(this.options.vursReroll || this.options.isReroll)) {
				const keep = this.options.vursRerollKeep ?? "new";
				fixedCheckBase = getAdjustedVursBase(rawCheckBase, keep === "lower" ? "misfortune" : "fortune");
			}
			const damageActor = getDamageRollActor(this) ?? activeDamageActors.at(-1);
			const damageActorDiceless = this.options?.vursDiceless === true || actorUsesDicelessRolls(damageActor);
			const damageDicelessEnabled = damageActor ? damageActorDiceless : isFullVursMode(mode);
			const isDamageRoll = damageDicelessEnabled && (
				["DamageRoll", "DamageInstance"].includes(rollClass) ||
				this.options?.type === "damage-roll" ||
				Boolean(this.options?.damage)
			);
			const previousResults = [];

			if ((isVursCheckRoll && Number.isFinite(fixedCheckBase)) || isDamageRoll) {
				if (isVursCheckRoll && activeState) {
					activeState.rollApplied = true;
					this.options.vursBuildup = activeState.buildup;
					this.options.vursRawBase = rawCheckBase;
					this.options.vursFixedBase = fixedCheckBase;
					this.options.vursFortuneState = getVursCheckEffect(activeState.context);
					this.options.vursDiceless = true;
				}
				if (isDamageRoll && damageActorDiceless) this.options.vursDiceless = true;
				for (const die of getNestedRollDice(this)) {
					if (!(die instanceof Die)) continue;
					previousResults.push([die, die[VURS_DIE_RESULT]]);
					if (isVursCheckRoll) die[VURS_DIE_RESULT] = fixedCheckBase;
					else {
						const faces = Number(die.faces);
						if (Number.isFinite(faces) && faces > 0) {
							die[VURS_DIE_RESULT] = Math.ceil((faces + 1) / 2);
						}
					}
				}
			}

			try {
				const result = await originalEvaluate.apply(this, args);

				return result;
			} finally {
				for (const [die, oldResult] of previousResults) {
					if (oldResult === undefined) delete die[VURS_DIE_RESULT];
					else die[VURS_DIE_RESULT] = oldResult;
				}
			}
		};
		Object.defineProperty(Roll.prototype, "__vursRollEvaluationInstalled", { value: true });
	}
}

function getNestedRollDice(roll) {
	const Die = foundry.dice?.terms?.Die;
	const dice = new Set();
	const visited = new WeakSet();
	const visit = value => {
		if (!value || typeof value !== "object") return;
		if (Die && value instanceof Die) {
			dice.add(value);
			return;
		}
		if (visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		for (const [key, nested] of Object.entries(value)) {
			if (["options", "actor", "parent", "_source", "results", "_formula"].includes(key)) continue;
			visit(nested);
		}
	};
	visit(roll?.terms);
	// The top-level terms of a PF2e DamageRoll are pools whose actual dice are
	// nested inside their instances and component rolls.
	visit(roll?.instances);
	visit(roll?.rolls);
	return [...dice];
}

function getVursCheckBase(state) {
	return getAdjustedVursBase(8 + state.buildup, getVursCheckEffect(state.context));
}

function getVursCheckEffect(context) {
	const options = context.options instanceof Set ? context.options : new Set(context.options ?? []);
	const selectedSubstitutions = (context.substitutions ?? []).filter(substitution => substitution.selected);
	const fortune = options.has("fortune") || context.rollTwice === "keep-higher" || selectedSubstitutions.some(substitution => substitution.effectType === "fortune");
	const misfortune = options.has("misfortune") || context.rollTwice === "keep-lower" || selectedSubstitutions.some(substitution => substitution.effectType === "misfortune");
	if (fortune === misfortune) return "none";
	return fortune ? "fortune" : "misfortune";
}

function getAdjustedVursBase(base, effect) {
	if (effect === "fortune") base = Math.floor(base * 1.5);
	else if (effect === "misfortune") base = Math.floor(base * 0.5);
	return Math.max(1, Math.min(20, base));
}
