import { getEffectiveStrikeMAP } from "./attackSpeed.js";
import { getDamageModifierBreakdown } from "./lifesteal.js";
import { createVursPlayCostElement } from "./playCostIcons.js";
import {
	displayCollateralArea,
	getTokenCenter,
	getTokenDistance,
	getPlacementGeometries,
	getTokensInCollateralShape,
	prepareBurstFireDamage,
} from "./collateralDamage.js";

const MODULE_ID = "vurs-pf2e";
const PREPARE_ATTACKS_WRAPPER = Symbol.for(`${MODULE_ID}.burstFirePrepareAttacks`);
const AUTOMATIC_TRAIT = "automatic";
const BURST_FIRE_ROLL_CONCURRENCY = 4;
const DEGREE_OF_SUCCESS = ["criticalFailure", "failure", "success", "criticalSuccess"];
const preparedBurstFires = new Map();
const actorSheetRoots = new WeakSet();
const weaponSheetRoots = new WeakSet();

const BURST_FIRE_TRANSLATIONS = {
	Title: "Burst-Fire",
	Prepared: "Burst-Fire prepared. Select this weapon's Strike and MAP to fire.",
	MAPLabel: "Burst-Fire (MAP {modifier})",
	RateOfFireShort: "RoF {shots}",
	RateOfFire: "Rate of Fire",
	Recoil: "Recoil",
	Calculated: "Calculated",
	Base: "Base",
	Adjustment: "Adjustment",
	AtMAP: "at MAP {map}",
	Description: "<p><strong>Cost</strong> 2 actions</p><p>Click Burst-Fire to prepare it, then click this weapon's Strike at the desired MAP to fire. Click Burst-Fire again to cancel. Rate of Fire is 3 + (5 - MAP), to a minimum of 0 shots, and is capped by available ammunition. Each projectile uses the selected Strike's MAP, then increases MAP normally for later projectiles. Each projectile is a separate Strike and uses normal range-increment penalties. Subsequent Strikes resolve automatically after the first Strike; all damage is calculated first and requires the GM to click Apply All Damage.</p><p>The Recoil Area is a cone aimed at the target, with a distance equal to the weapon's maximum range. Its spread is 5 degrees plus 5 degrees per Recoil. Recoil is 10 minus the weapon's Bulk (minimum 0), halved and rounded down for a weapon listed as two-handed.</p><p>On a miss, the projectile diverts to the nearest other creature in the cone, including allies, and deals half damage. Each possible secondary target is selected once before the burst cycles back to previously selected targets. A critical miss deals no secondary damage.</p>",
	VariantLabel: "Burst-Fire (RoF {shots})",
	Warnings: {
		SelectTarget: "Select a target to direct the Burst-Fire cone.",
		NoSourceToken: "A source token is required to use Burst-Fire.",
		InvalidArea: "Could not determine the Burst-Fire cone. Check the weapon's range and the scene grid.",
		InvalidMAP: "Could not determine Rate of Fire from the weapon's MAP.",
		NoShots: "No Burst-Fire shots are available. Rate of Fire may be 0 or the weapon may have no ammunition.",
		AmmoChanged: "Burst-Fire ammunition changed before the projectile could be expended.",
		ChatFailed: "Could not create the Burst-Fire chat card.",
		DamageFailed: "Could not generate or apply Burst-Fire damage.",
		RollFailed: "Burst-Fire stopped because one of its Strikes could not be completed.",
		InvalidStat: "Rate of Fire and Recoil must be non-negative whole numbers.",
		StatUpdateFailed: "Could not update Burst-Fire {stat}."
	},
	Notes: {
		Shot: "Strike {number}: {outcome} — {target}",
		NoDamageTarget: "No damage target",
		HalfDamage: "Diverted; half damage",
		CriticalMiss: "Critical miss; no damage",
		NoSecondaryTarget: "No secondary target; no damage"
	}
};

function registerBurstFireLocalization() {
	const translations = game.i18n?.translations;
	if (!translations) return;

	const register = (entries, prefix) => {
		for (const [key, value] of Object.entries(entries)) {
			const path = `${prefix}.${key}`;
			if (value && typeof value === "object") register(value, path);
			else if (!game.i18n.has(path)) foundry.utils.setProperty(translations, path, value);
		}
	};
	register(BURST_FIRE_TRANSLATIONS, "VURS.BurstFire");
}

async function mapConcurrent(values, concurrency, callback) {
	const results = new Array(values.length);
	let nextIndex = 0;
	await Promise.all(Array.from(
		{ length: Math.min(concurrency, values.length) },
		async () => {
			while (nextIndex < values.length) {
				const index = nextIndex++;
				results[index] = await callback(values[index], index);
			}
		}
	));
	return results;
}

function updatePreparedBurstFireButton(root, strikeElement, isPrepared, actor) {
	if (!root?.isConnected || !strikeElement?.isConnected) return;
	const button = strikeElement.querySelector(".vurs-burst-fire-trigger")
		?? root.querySelector(
			`.vurs-burst-fire-trigger[data-action-index="${strikeElement.dataset.actionIndex}"]`
		);
	if (button) {
		button.classList.toggle("vurs-burst-fire-prepared", isPrepared);
		button.setAttribute("aria-pressed", String(isPrepared));
		if (isPrepared) button.dataset.tooltip = game.i18n.localize("VURS.BurstFire.Prepared");
		else delete button.dataset.tooltip;
	}
	if (actor?.type === "npc") return;

	const attackGroup = strikeElement.querySelector(":scope > section > .button-group.tags")
		?? strikeElement.querySelector(":scope > .button-group");
	if (!attackGroup) return;
	attackGroup.classList.toggle("vurs-burst-fire-armed", isPrepared);
	for (const attackButton of attackGroup.querySelectorAll('button[data-action="strike-attack"]')) {
		if (!attackButton.dataset.vursOriginalLabel) {
			attackButton.dataset.vursOriginalLabel = attackButton.innerHTML;
			attackButton.dataset.vursOriginalAriaLabelSet = String(attackButton.hasAttribute("aria-label"));
			if (attackButton.hasAttribute("aria-label")) {
				attackButton.dataset.vursOriginalAriaLabel = attackButton.getAttribute("aria-label");
			}
		}
		const variantIndex = Number(attackButton.dataset.variantIndex ?? 0);
		if (!isPrepared) {
			attackButton.innerHTML = attackButton.dataset.vursOriginalLabel;
			attackButton.classList.remove("vurs-burst-fire-variant");
			if (attackButton.dataset.vursOriginalAriaLabelSet === "true") {
				attackButton.setAttribute("aria-label", attackButton.dataset.vursOriginalAriaLabel);
			} else {
				attackButton.removeAttribute("aria-label");
			}
			continue;
		}

		const actionIndex = Number(strikeElement.dataset.actionIndex);
		const strike = actor?.system?.actions?.[actionIndex];
		const variant = strike?.variants?.[variantIndex];
		const baseLabel = game.i18n.localize("PF2E.WeaponStrikeLabel");
		const labelRemainder = String(variant?.label ?? "").replace(baseLabel, "").trim();
		const modifier = labelRemainder.match(/^[+-]?\d+/)?.[0] ?? labelRemainder;
		const effectiveMAP = variantIndex > 0
			? getEffectiveStrikeMAP(strike, variantIndex, actor)
			: 0;
		const label = variantIndex === 0
			? game.i18n.localize("VURS.BurstFire.Title")
			: game.i18n.format("VURS.BurstFire.MAPLabel", {
				modifier: effectiveMAP === 0 ? "0" : `-${effectiveMAP}`
			});
		attackButton.replaceChildren();
		if (variantIndex === 0) {
			const name = document.createElement("span");
			name.className = "name";
			name.textContent = label;
			const glyph = document.createElement("span");
			glyph.className = "action-glyph";
			glyph.textContent = "2";
			attackButton.append(name, document.createTextNode(" "), glyph, document.createTextNode(` ${modifier}`));
		} else {
			attackButton.textContent = `${modifier} ${label}`;
		}
		attackButton.classList.add("vurs-burst-fire-variant");
		attackButton.setAttribute("aria-label", `${label} ${modifier}`);
	}
}

function clearPreparedBurstFire(key) {
	const prepared = preparedBurstFires.get(key);
	if (!prepared) return false;
	preparedBurstFires.delete(key);
	updatePreparedBurstFireButton(prepared.root, prepared.strikeElement, false, prepared.actor);
	return true;
}

function displayBurstFireRecoilArea(actor, strike) {
	const targetToken = getTargetToken(game.user.targets.first());
	const scene = canvas.scene;
	if (!targetToken || getTokenDocument(targetToken).parent !== scene) return;

	const sourceToken = getSceneTokenForActor(actor, scene, targetToken);
	if (!sourceToken) return;

	const shapes = getBurstFireShapes(sourceToken, targetToken, strike.item);
	if (shapes) displayCollateralArea(shapes, [], 4000);
}

function prepareBurstFire(actor, strike, root, strikeElement) {
	const key = actor.uuid ?? actor.id;
	const current = preparedBurstFires.get(key);
	if (current?.itemId === strike.item.id) {
		clearPreparedBurstFire(key);
		updatePreparedBurstFireButton(root, strikeElement, false, actor);
		return;
	}
	if (current) clearPreparedBurstFire(key);
	preparedBurstFires.set(key, { itemId: strike.item.id, actor, root, strikeElement });
	updatePreparedBurstFireButton(root, strikeElement, true, actor);
	displayBurstFireRecoilArea(actor, strike);
}

function clearPreparedBurstFireForItem(item) {
	const actor = item?.actor ?? item?.parent;
	if (!actor) return;
	const key = actor.uuid ?? actor.id;
	if (preparedBurstFires.get(key)?.itemId === item.id) clearPreparedBurstFire(key);
}

function handleBurstFireSheetClick(actor, root, event) {
	const button = event.target?.closest?.(
		"button.vurs-burst-fire-trigger, button[data-action='strike-attack']"
	);
	if (!button || !root.contains(button)) return;
	const strikeElement = button.classList.contains("vurs-burst-fire-trigger")
		? button.closest(
			'li.strike[data-action-index], li.item.action[data-strike][data-action-index]'
		) ?? root.querySelector(
			`li.item.action[data-strike][data-action-index="${button.dataset.actionIndex}"]`
		)
		: button.closest(
			'li.strike[data-action-index], li.item.action[data-strike][data-action-index]'
		);
	if (!strikeElement) return;
	const actionIndex = Number(strikeElement.dataset.actionIndex);
	const strike = actor.system?.actions?.[actionIndex];
	if (!strike) return;

	if (button.classList.contains("vurs-burst-fire-trigger")) {
		event.preventDefault();
		event.stopImmediatePropagation();
		prepareBurstFire(actor, strike, root, strikeElement);
		return;
	}
	const key = actor.uuid ?? actor.id;
	const prepared = preparedBurstFires.get(key);
	if (!prepared || button.hasAttribute("data-alt-usage")) return;
	if (prepared.itemId !== strike.item?.id) {
		clearPreparedBurstFire(key);
		return;
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	clearPreparedBurstFire(key);
	updatePreparedBurstFireButton(root, strikeElement, false, actor);
	const variantIndex = Number(button.dataset.variantIndex ?? 0);
	void rollBurstFire(actor, strike, variantIndex, { event }).catch(error => {
		console.error(`${MODULE_ID} | Could not confirm prepared Burst-Fire for ${strike.item.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.RollFailed"));
	});
}

function getTokenDocument(token) {
	return token?.document ?? token ?? null;
}

function getWeaponAmmo(weapon) {
	if (!weapon.system.expend || weapon.system.ammo?.builtIn) return null;
	return weapon.ammo ?? null;
}

function getAmmoCount(weapon) {
	const ammo = getWeaponAmmo(weapon);
	if (!ammo) return Infinity;
	const uses = ammo.system?.uses;
	if (ammo.isOfType?.("ammo") && Number(uses?.max) > 1) {
		const remaining = Number(uses.value);
		return Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
	}
	const quantity = Number(ammo.quantity);
	return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

function getAutomaticRollEvent(type) {
	const showRollDialogs = Boolean(
		type === "damage"
			? game.user.settings.showDamageDialogs
			: game.user.settings.showCheckDialogs
	);
	return {
		ctrlKey: false,
		metaKey: false,
		shiftKey: showRollDialogs
	};
}

function getRateOfFire(actor, strike) {
	const mapIndex = Math.min(1, (strike?.variants?.length ?? 0) - 1);
	const effectiveMAP = mapIndex >= 0
		? getEffectiveStrikeMAP(strike, mapIndex, actor)
		: null;
	if (!Number.isFinite(effectiveMAP)) return null;
	const base = getBaseRateOfFire(strike?.item, effectiveMAP);
	return Math.max(0, base + getBurstFireAdjustment(strike?.item, "rateOfFire"));
}

function getWeaponMaxRange(weapon) {
	const values = [
		weapon.maxRange,
		weapon.range?.max,
		weapon.system.maxRange,
		Number(weapon.system.range?.value ?? weapon.system.range) * 6
	];
	return values.map(Number).find(value => Number.isFinite(value) && value > 0) ?? null;
}

function getBurstFirePathSpeed(weapon) {
	const maxRange = getWeaponMaxRange(weapon);
	const distancePixels = Number(canvas.dimensions?.distancePixels);
	if (!maxRange || !Number.isFinite(distancePixels) || distancePixels <= 0) return null;
	return (maxRange * distancePixels) / 2;
}

function getRecoil(weapon) {
	return Math.max(
		0,
		getBaseRecoil(weapon) + getBurstFireAdjustment(weapon, "recoil")
	);
}

function getTargetToken(target) {
	const document = getTokenDocument(target);
	const token = target?.document ? target : document?.object;
	return document?.actor && token ? token : null;
}

function getSceneTokenForActor(actor, scene, nearToken) {
	if (!getTokenCenter(nearToken)) return null;
	return [...scene.tokens]
		.filter(token => token.actor?.uuid === actor.uuid)
		.sort((left, right) =>
			getTokenDistance(left, nearToken) - getTokenDistance(right, nearToken) ||
			left.id.localeCompare(right.id)
		)[0] ?? null;
}

function getBurstFireShapes(sourceToken, targetToken, weapon) {
	const maxRange = getWeaponMaxRange(weapon);
	if (!maxRange || !getTokenCenter(sourceToken) || !getTokenCenter(targetToken)) return null;

	const distancePixels = Number(canvas.dimensions?.distancePixels);
	if (!Number.isFinite(distancePixels) || distancePixels <= 0) return null;
	const recoil = getRecoil(weapon);
	const geometries = getPlacementGeometries("self", sourceToken, targetToken);
	if (!geometries?.length) return null;
	const areaGeometries = geometries.length === 2
		? [
			...geometries,
			{
				x: (geometries[0].x + geometries[1].x) / 2,
				y: (geometries[0].y + geometries[1].y) / 2,
				rotation: geometries[0].rotation
			}
		]
		: geometries;
	return areaGeometries.map(geometry => ({
		type: "cone",
		x: geometry.x,
		y: geometry.y,
		radius: maxRange * distancePixels,
		angle: 5 + (5 * recoil),
		rotation: geometry.rotation,
		curvature: "round"
	}));
}

function getConeEdge(sourceToken, targetToken, shapes) {
	const source = getTokenCenter(sourceToken);
	const origin = shapes[0];
	const target = getTokenCenter(targetToken);
	if (!source || !origin || !target) return null;
	const length = Math.hypot(target.x - source.x, target.y - source.y);
	if (length === 0) return null;
	return {
		x: origin.x + ((target.x - source.x) / length) * origin.radius,
		y: origin.y + ((target.y - source.y) / length) * origin.radius
	};
}

function getNextSecondaryTarget(candidates, visited) {
	let target = candidates.find(candidate => !visited.has(candidate.id)) ?? null;
	if (!target && visited.size > 0) {
		visited.clear();
		target = candidates[0] ?? null;
	}
	if (target) visited.add(target.id);
	return target;
}

function getEligibleSecondaryTargets(shapes, sourceToken, primaryToken) {
	return getTokensInCollateralShape(shapes)
		.filter(token => token.id !== sourceToken.id && token.id !== primaryToken.id)
		.map(token => ({ token, distance: getTokenDistance(token, primaryToken) }))
		.sort((left, right) =>
			left.distance - right.distance ||
			left.token.id.localeCompare(right.token.id)
		)
		.map(({ token }) => token);
}

function createPath(
	sourceToken,
	primaryToken,
	secondaryToken,
	shape,
	{ continueToEdge = false, extendToEdge = false } = {}
) {
	const source = getTokenCenter(sourceToken);
	const primary = getTokenCenter(primaryToken);
	const edge = getConeEdge(sourceToken, primaryToken, shape);
	if (!source || !primary) return null;

	const path = [source, primary];
	if (secondaryToken) {
		const secondary = getTokenCenter(secondaryToken);
		if (secondary) path.push(secondary);
	}
	const primaryInCone = shape.some(cone => Math.hypot(
		primary.x - cone.x,
		primary.y - cone.y
	) <= cone.radius);
	if (extendToEdge && edge && !primaryInCone) return [source, edge];
	if ((continueToEdge || extendToEdge) && edge && primaryInCone) {
		path.push(edge);
	}
	return path;
}

function getBurstFireTraceDelay(sourceToken, targetToken, pathSpeedPixelsPerSecond) {
	const source = getTokenCenter(sourceToken);
	const target = getTokenCenter(targetToken);
	if (!source || !target || !Number.isFinite(pathSpeedPixelsPerSecond) || pathSpeedPixelsPerSecond <= 0) return 0;
	return Math.hypot(target.x - source.x, target.y - source.y) /
		pathSpeedPixelsPerSecond * 1000;
}

function getOutcomeLabel(outcome) {
	const keys = {
		criticalSuccess: "PF2E.Check.Result.Degree.Attack.criticalSuccess",
		success: "PF2E.Check.Result.Degree.Attack.success",
		failure: "PF2E.Check.Result.Degree.Attack.failure",
		criticalFailure: "PF2E.Check.Result.Degree.Attack.criticalFailure"
	};
	return game.i18n.localize(keys[outcome] ?? "PF2E.Check.Result.Degree.Attack.failure");
}

function collectRollOptions(rollOrOptions, result = new Set(), depth = 0) {
	if (depth > 2 || !rollOrOptions) return result;
	if (rollOrOptions instanceof Set || Array.isArray(rollOrOptions)) {
		for (const option of rollOrOptions) {
			if (typeof option === "string") result.add(option);
		}
		return result;
	}
	if (typeof rollOrOptions !== "object") return result;
	collectRollOptions(rollOrOptions.options, result, depth + 1);
	collectRollOptions(rollOrOptions.rollOptions, result, depth + 1);
	return result;
}

function getSuccessfulHitContext(checkContext) {
	if (!checkContext) return null;
	const existingOptions = checkContext.options instanceof Set
		? [...checkContext.options]
		: Array.isArray(checkContext.options) ? checkContext.options : [];
	const options = existingOptions.filter(option =>
		typeof option !== "string" || !option.startsWith("check:outcome:")
	);
	options.push("check:outcome:success");
	return {
		...checkContext,
		options,
		outcome: "success",
		unadjustedOutcome: "success"
	};
}

async function applyStrikeDamage(
	actor,
	strike,
	target,
	mapIncreases,
	outcome,
	halfDamage,
	event,
	checkContext,
	traceDelayMs = 0,
	traceSpeedPixelsPerSecond
) {
	const damageCheckContext = halfDamage
		? getSuccessfulHitContext(checkContext)
		: checkContext;
	const damageFunction = outcome === "criticalSuccess" ? strike.critical : strike.damage;
	if (typeof damageFunction !== "function") {
		console.error(`${MODULE_ID} | Could not apply Burst-Fire damage: the Strike damage function is unavailable`);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.DamageFailed"));
		return null;
	}

	let damageRoll = await damageFunction({
		target,
		mapIncreases,
		event,
		options: damageCheckContext?.options ?? [],
		checkContext: damageCheckContext,
		createMessage: false
	});
	if (!damageRoll) {
		console.error(`${MODULE_ID} | Could not generate damage for a Burst-Fire Strike against ${getTokenDocument(target)?.name ?? "target"}`);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.DamageFailed"));
		return null;
	}
	if (halfDamage) damageRoll = damageRoll.alter(0.5, 0);

	const targetToken = getTokenDocument(target);
	const targetActor = targetToken?.actor;
	if (!targetActor || typeof targetActor.applyDamage !== "function") {
		console.error(`${MODULE_ID} | Could not apply Burst-Fire damage: target actor is unavailable`);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.DamageFailed"));
		return null;
	}
	const damageParams = {
		damage: damageRoll,
		token: target,
		item: strike.item,
		vursDamageDealer: actor,
		rollOptions: collectRollOptions(damageCheckContext, collectRollOptions(damageRoll)),
		outcome,
		checkContext: damageCheckContext,
		vursBurstFireDivertedDamage: halfDamage
	};
	damageParams.vursBurstFireTraceDelayMs = traceDelayMs;
	damageParams.vursBurstFireTraceSpeedPixelsPerSecond = traceSpeedPixelsPerSecond;
	const targetName = targetToken?.name ?? targetActor.name;
	return {
		damageRoll,
		application: {
			actor: targetActor,
			damageParams,
			effect: {
				type: "burst-fire",
				label: game.i18n.localize("VURS.BurstFire.Title"),
				amount: damageRoll.total,
				targetName,
				hidden: Boolean(targetToken?.hidden || target?.isVisible === false)
			}
		}
	};
}

async function renderShotResult(index, attackRoll, outcome, target, damageRoll, note) {
	const details = document.createElement("details");
	details.className = "vurs-burst-fire-shot";
	const summary = document.createElement("summary");
	summary.textContent = `${game.i18n.format("VURS.BurstFire.Notes.Shot", {
		number: index + 1,
		outcome: getOutcomeLabel(outcome),
		target: target?.hidden || target?.object?.isVisible === false
			? "Hidden creature"
			: target?.name ?? game.i18n.localize("VURS.BurstFire.Notes.NoDamageTarget")
	})}`;
	details.append(summary);

	const attackContent = document.createElement("div");
	attackContent.className = "vurs-burst-fire-attack";
	attackContent.innerHTML = await attackRoll.render();
	details.append(attackContent);

	if (damageRoll) {
		const damageContent = document.createElement("div");
		damageContent.className = "vurs-burst-fire-damage";
		damageContent.innerHTML = await damageRoll.render();
		damageContent.querySelector(".damage-application")?.remove();
		details.append(damageContent);
	}
	if (note) {
		const noteElement = document.createElement("p");
		noteElement.textContent = game.i18n.localize(note);
		details.append(noteElement);
	}
	return details.outerHTML;
}

async function createBurstFireChatMessage(actor, sourceToken, weapon, results) {
	if (results.length === 0) return null;
	const content = document.createElement("section");
	content.className = "pf2e chat-card action-card vurs-burst-fire-card";
	const header = document.createElement("header");
	header.className = "card-header flexrow";
	const image = document.createElement("img");
	image.src = weapon.img;
	image.alt = weapon.name;
	const title = document.createElement("h3");
	title.textContent = game.i18n.localize("VURS.BurstFire.Title");
	header.append(image, title);
	const cardContent = document.createElement("div");
	cardContent.className = "card-content";
	cardContent.append(createVursPlayCostElement("2 AP"));
	const shots = document.createElement("div");
	shots.className = "vurs-burst-fire-shots";
	for (const result of results) shots.insertAdjacentHTML("beforeend", result.html);
	content.append(header, cardContent, shots);

	const speaker = ChatMessage.getSpeaker({
		actor,
		token: sourceToken.object ?? sourceToken
	});
	return ChatMessage.create({
		speaker,
		flavor: game.i18n.localize("VURS.BurstFire.Title"),
		content: content.outerHTML,
		rolls: results.flatMap(result =>
			[result.attackRoll, result.damageRoll].filter(Boolean)
		)
	});
}

async function consumeRounds(weapon, amount) {
	if (amount < 1) return true;
	const ammo = getWeaponAmmo(weapon);
	if (!ammo) return true;
	if (getAmmoCount(weapon) < amount) return false;
	if (typeof ammo.consume === "function") {
		await ammo.consume(amount);
		return true;
	}
	if (ammo.type === "weapon" && typeof ammo.update === "function") {
		await ammo.update({ "system.quantity": Math.max(0, Number(ammo.quantity) - amount) });
		return true;
	}
	console.error(`${MODULE_ID} | Could not consume Burst-Fire ammunition: unsupported ammunition item`, ammo);
	return false;
}

async function rollBurstFire(actor, strike, startingMAP, options = {}) {
	const weapon = strike.item;
	const primaryToken = getTargetToken(options.target ?? game.user.targets.first());
	const scene = canvas.scene;
	if (!primaryToken || getTokenDocument(primaryToken).parent !== scene) {
		ui.notifications.warn(game.i18n.localize("VURS.BurstFire.Warnings.SelectTarget"));
		return null;
	}

	const sourceToken = getSceneTokenForActor(actor, scene, primaryToken);
	if (!sourceToken) {
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.NoSourceToken"));
		console.error(`${MODULE_ID} | Could not start Burst-Fire: no source token for ${actor.name}`);
		return null;
	}

	const shapes = getBurstFireShapes(sourceToken, primaryToken, weapon);
	if (!shapes) {
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.InvalidArea"));
		console.error(`${MODULE_ID} | Could not create Burst-Fire cone for ${weapon.name}`);
		return null;
	}

	const rateOfFire = getRateOfFire(actor, strike);
	if (rateOfFire === null) {
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.InvalidMAP"));
		console.error(`${MODULE_ID} | Could not calculate Burst-Fire MAP for ${weapon.name}`);
		return null;
	}
	const shotCount = Math.min(rateOfFire, getAmmoCount(weapon));
	if (shotCount < 1) {
		ui.notifications.warn(game.i18n.localize("VURS.BurstFire.Warnings.NoShots"));
		return null;
	}
	const pathSpeedPixelsPerSecond = getBurstFirePathSpeed(weapon);
	if (!pathSpeedPixelsPerSecond) {
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.InvalidArea"));
		console.error(`${MODULE_ID} | Could not calculate Burst-Fire line speed for ${weapon.name}`);
		return null;
	}

	const visited = new Set();
	let secondaryTargets = null;
	const paths = [];
	const shotResults = [];
	const damageApplications = [];
	let roundsFired = 0;
	let attackFailed = false;
	const attacks = await mapConcurrent(
		Array.from({ length: shotCount }, (_, shot) => shot),
		BURST_FIRE_ROLL_CONCURRENCY,
		async shot => {
			if (roundsFired >= getAmmoCount(weapon)) return { shot, skipped: true };
			const mapIndex = Math.min(startingMAP + shot, strike.variants.length - 1);
			const variant = strike.variants[mapIndex];
			if (!variant?.roll) {
				return {
					shot,
					mapIndex,
					error: new Error(`Strike MAP variant ${mapIndex} is unavailable`)
				};
			}

			let checkContext = null;
			try {
				const attackRoll = await variant.roll({
					event: shot === 0 ? options.event : getAutomaticRollEvent("check"),
					target: primaryToken,
					consumeAmmo: false,
					createMessage: false,
					callback: (_roll, _outcome, message) => {
						checkContext = foundry.utils.getProperty(
							message,
							`flags.${game.system.id}.context`
						) ?? null;
					}
				});
				if (attackRoll) roundsFired++;
				return { shot, mapIndex, attackRoll, checkContext };
			} catch (error) {
				return { shot, mapIndex, error };
			}
		}
	);

	const damagePlans = [];
	for (const attack of attacks) {
		if (attack.skipped) {
			ui.notifications.warn(game.i18n.localize("VURS.BurstFire.Warnings.NoShots"));
			continue;
		}
		if (attack.error || !attack.attackRoll) {
			attackFailed = true;
			console.error(
				`${MODULE_ID} | Could not roll Burst-Fire projectile ${attack.shot + 1} for ${weapon.name}`,
				attack.error ?? "The Strike roll returned no result"
			);
			continue;
		}
		if (!attack.checkContext) {
			console.error(`${MODULE_ID} | Burst-Fire Strike did not provide its check context; on-hit damage effects may not resolve for ${weapon.name}`);
		}
		const degree = attack.attackRoll.degreeOfSuccess ??
			attack.attackRoll.options?.degreeOfSuccess;
		const outcome = Number.isInteger(degree) ? DEGREE_OF_SUCCESS[degree] : degree;
		if (!["success", "criticalSuccess", "failure", "criticalFailure"].includes(outcome)) {
			attackFailed = true;
			console.error(`${MODULE_ID} | Unexpected Burst-Fire Strike outcome: ${String(outcome)}`);
			continue;
		}

		let damageTarget = null;
		let halfDamage = false;
		let note = null;
		if (outcome === "success" || outcome === "criticalSuccess") {
			damageTarget = primaryToken;
			const path = createPath(sourceToken, primaryToken, null, shapes);
			if (path) paths.push(path);
		} else {
			secondaryTargets ??= getEligibleSecondaryTargets(shapes, sourceToken, primaryToken);
			const secondary = getNextSecondaryTarget(secondaryTargets, visited);
			const criticalMiss = outcome === "criticalFailure";
			if (secondary) damageTarget = secondary.object ?? secondary;
			const path = createPath(sourceToken, secondary ?? primaryToken, null, shapes, {
				continueToEdge: criticalMiss || !secondary,
				extendToEdge: criticalMiss || !secondary
			});
			if (path) paths.push(path);

			if (!secondary) {
				note = "VURS.BurstFire.Notes.NoSecondaryTarget";
			} else if (criticalMiss) {
				note = "VURS.BurstFire.Notes.CriticalMiss";
			} else {
				halfDamage = true;
				note = "VURS.BurstFire.Notes.HalfDamage";
			}
		}
		damagePlans.push({
			shot: attack.shot,
			attackRoll: attack.attackRoll,
			mapIndex: attack.mapIndex,
			checkContext: attack.checkContext,
			outcome,
			damageTarget,
			halfDamage,
			note
		});
	}

	const damageResults = await mapConcurrent(
		damagePlans,
		BURST_FIRE_ROLL_CONCURRENCY,
		async plan => {
			if (!plan.damageTarget) return { plan, damageResult: null };
			try {
				const damageResult = await applyStrikeDamage(
					actor,
					strike,
					plan.damageTarget,
					plan.mapIndex,
					plan.halfDamage ? "success" : plan.outcome,
					plan.halfDamage,
					getAutomaticRollEvent("damage"),
					plan.checkContext,
					getBurstFireTraceDelay(sourceToken, plan.damageTarget, pathSpeedPixelsPerSecond),
					pathSpeedPixelsPerSecond
				);
				return { plan, damageResult };
			} catch (error) {
				return { plan, error };
			}
		}
	);
	for (const { plan, damageResult, error } of damageResults) {
		if (error) {
			attackFailed = true;
			console.error(`${MODULE_ID} | Could not roll Burst-Fire damage for Strike ${plan.shot + 1} with ${weapon.name}`, error);
			shotResults.push({
				shot: plan.shot,
				attackRoll: plan.attackRoll,
				outcome: plan.outcome,
				target: getTokenDocument(plan.damageTarget),
				note: "VURS.BurstFire.Warnings.DamageFailed"
			});
			continue;
		}
		if (plan.damageTarget && !damageResult) attackFailed = true;
		const damageRoll = damageResult?.damageRoll ?? null;
		const damageApplication = damageResult?.application ?? null;
		if (damageApplication) damageApplications.push(damageApplication);
		shotResults.push({
			shot: plan.shot,
			attackRoll: plan.attackRoll,
			outcome: plan.outcome,
			damageRoll,
			target: getTokenDocument(plan.damageTarget),
			note: plan.damageTarget && !damageRoll
				? "VURS.BurstFire.Warnings.DamageFailed"
				: plan.note
		});
	}

	if (attackFailed) {
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.RollFailed"));
	}
	if (paths.length > 0 || shapes.length > 0) {
		const traceStartedAt = performance.now();
		displayCollateralArea(shapes, paths, 4000, 0, pathSpeedPixelsPerSecond);
		for (const application of damageApplications) {
			application.damageParams.vursBurstFireTraceStartedAt = traceStartedAt;
		}
	}
	try {
		if (!await consumeRounds(weapon, roundsFired)) {
			ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.AmmoChanged"));
			console.error(`${MODULE_ID} | Could not consume ${roundsFired} Burst-Fire rounds; ammunition changed during the burst`);
		}
	} catch (error) {
		console.error(`${MODULE_ID} | Could not consume Burst-Fire ammunition for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.AmmoChanged"));
	}
	try {
		const shotHtml = await Promise.all(shotResults.map((result, index) =>
			renderShotResult(
				result.shot ?? index,
				result.attackRoll,
				result.outcome,
				result.target,
				result.damageRoll,
				result.note
			)
		));
		shotResults.forEach((result, index) => {
			result.html = shotHtml[index];
		});
	} catch (error) {
		console.error(`${MODULE_ID} | Could not render Burst-Fire results for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.ChatFailed"));
	}
	try {
		const message = await createBurstFireChatMessage(
			actor,
			sourceToken,
			weapon,
			shotResults
		);
		await prepareBurstFireDamage(message, damageApplications);
	} catch (error) {
		console.error(`${MODULE_ID} | Could not create the Burst-Fire chat card for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.ChatFailed"));
	}
	return null;
}

function isAutomaticWeapon(item) {
	const traits = item?.system?.traits?.value ?? item?.traits?.value ?? [];
	return item?.type === "weapon" && traits.includes(AUTOMATIC_TRAIT);
}

function isAutomaticStrike(strike) {
	const traits = strike?.item?.system?.traits?.value ?? strike?.item?.traits?.value ?? [];
	return strike?.type === "strike" && traits.includes(AUTOMATIC_TRAIT);
}

function getBurstFireBaseOverride(item, stat) {
	const burstFire = foundry.utils.getProperty(item, `flags.${MODULE_ID}.burstFire`) ?? {};
	const baseKey = `base${stat[0].toUpperCase()}${stat.slice(1)}`;
	const legacyKey = stat;
	const value = Object.hasOwn(burstFire, baseKey)
		? burstFire[baseKey]
		: burstFire[legacyKey];
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function getBurstFireAdjustment(item, stat) {
	const value = foundry.utils.getProperty(
		item,
		`flags.${MODULE_ID}.burstFire.${stat}Adjustment`
	);
	return Number.isInteger(value) ? value : 0;
}

function getBaseRateOfFire(item, effectiveMAP = null) {
	const actor = item.actor ?? item.parent?.actor;
	const strike = Array.isArray(actor?.system?.actions)
		? actor.system.actions.find(action => action.type === "strike" && action.item?.id === item.id)
		: null;
	const map = Number.isFinite(effectiveMAP)
		? effectiveMAP
		: strike
			? getEffectiveStrikeMAP(strike, 1, actor)
			: 5;
	return getBurstFireBaseOverride(item, "rateOfFire") ??
		Math.max(0, Math.floor(3 + (5 - (Number.isFinite(map) ? map : 5))));
}

function getBaseRecoil(weapon) {
	const override = getBurstFireBaseOverride(weapon, "recoil");
	if (override !== null) return override;
	const bulk = Number(weapon.system.bulk?.value);
	const numericBulk = Number.isFinite(bulk) && bulk >= 1 ? Math.floor(bulk) : 0;
	const recoil = Math.max(0, 10 - numericBulk);
	const usage = weapon.usage?.value ?? weapon.system.usage?.value;
	return usage === "held-in-two-hands" ? Math.floor(recoil / 2) : recoil;
}

function getWeaponRateOfFire(item) {
	const actor = item.actor ?? item.parent?.actor;
	const strike = Array.isArray(actor?.system?.actions)
		? actor.system.actions.find(action => action.type === "strike" && action.item?.id === item.id)
		: null;
	const effectiveMAP = strike ? getEffectiveStrikeMAP(strike, 1, actor) : 5;
	const map = Number.isFinite(effectiveMAP) ? effectiveMAP : 5;
	const baseRateOfFire = getBaseRateOfFire(item, map);
	const rateOfFireAdjustment = getBurstFireAdjustment(item, "rateOfFire");
	return {
		rateOfFire: Math.max(0, baseRateOfFire + rateOfFireAdjustment),
		baseRateOfFire,
		rateOfFireAdjustment,
		baseRecoil: getBaseRecoil(item),
		recoilAdjustment: getBurstFireAdjustment(item, "recoil"),
		recoil: getRecoil(item),
		effectiveMAP: map
	};
}

function addBurstFireWeaponSection(app, element) {
	const item = app?.item ?? app?.object;
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!item || !root) return;
	if (!weaponSheetRoots.has(root)) {
		root.addEventListener("change", async event => {
			const input = event.target?.closest?.(
				"input[data-vurs-burst-fire-stat]"
			);
			if (!input || !root.contains(input)) return;
			const field = input.dataset.vursBurstFireStat;
			const rawValue = input.value.trim();
			const value = rawValue === "" ? null : Number(rawValue);
			const allowsNegative = field.endsWith("Adjustment");
			if (value !== null &&
				(!Number.isInteger(value) || (!allowsNegative && value < 0))) {
				ui.notifications.warn(game.i18n.localize("VURS.BurstFire.Warnings.InvalidStat"));
				addBurstFireWeaponSection(app, root);
				return;
			}

			input.disabled = true;
			try {
				await item.update({
					[`flags.${MODULE_ID}.burstFire.${field}`]: value === null
						? new foundry.data.operators.ForcedDeletion()
						: value
				});
				addBurstFireWeaponSection(app, root);
			} catch (error) {
				console.error(
					`${MODULE_ID} | Could not update Burst-Fire ${field} for ${item.name}`,
					error
				);
				ui.notifications.error(game.i18n.format(
					"VURS.BurstFire.Warnings.StatUpdateFailed",
					{
						stat: game.i18n.localize(
							`VURS.BurstFire.${field.toLowerCase().includes("rateoffire") ? "RateOfFire" : "Recoil"}`
						)
					}
				));
				addBurstFireWeaponSection(app, root);
			} finally {
				if (input.isConnected) input.disabled = false;
			}
		});
		weaponSheetRoots.add(root);
	}

	if (!isAutomaticWeapon(item)) {
		root.querySelector("[data-vurs-burst-fire-section]")?.remove();
		return;
	}
	const details = root?.querySelector(".tab.details, .tab[data-tab='details']");
	if (!details) return;

	const stats = getWeaponRateOfFire(item);
	let section = details.querySelector("[data-vurs-burst-fire-section]");
	if (!section) {
		section = document.createElement("fieldset");
		section.className = "vurs-burst-fire-item-settings";
		section.dataset.vursBurstFireSection = "true";
		const legend = document.createElement("legend");
		legend.textContent = game.i18n.localize("VURS.BurstFire.Title");
		section.append(legend);
		details.append(section);
	}

	const rows = [
		{
			key: "rateOfFire",
			label: game.i18n.localize("VURS.BurstFire.RateOfFire"),
			calculated: stats.rateOfFire,
			base: stats.baseRateOfFire,
			adjustment: stats.rateOfFireAdjustment,
			derivedBase: getBurstFireBaseOverride(item, "rateOfFire") === null
				? stats.baseRateOfFire
				: null
		},
		{
			key: "recoil",
			label: game.i18n.localize("VURS.BurstFire.Recoil"),
			calculated: stats.recoil,
			base: stats.baseRecoil,
			adjustment: stats.recoilAdjustment,
			derivedBase: getBurstFireBaseOverride(item, "recoil") === null
				? stats.baseRecoil
				: null
		}
	];
	for (const row of rows) {
		let group = section.querySelector(`[data-vurs-burst-fire-item-stat="${row.key}"]`);
		if (!group) {
			group = document.createElement("div");
			group.className = "form-group";
			group.dataset.vursBurstFireItemStat = row.key;
			const label = document.createElement("label");
			label.textContent = row.label;
			const fields = document.createElement("div");
			fields.className = "form-fields vurs-burst-fire-stat-fields";
			const calculated = document.createElement("output");
			calculated.className = "vurs-burst-fire-calculated";
			calculated.dataset.vursBurstFireCalculated = row.key;
			label.append(document.createTextNode(" "), calculated);
			const makeInput = (field, labelKey, min) => {
				const wrapper = document.createElement("label");
				wrapper.className = "vurs-burst-fire-stat-input";
				const caption = document.createElement("span");
				caption.textContent = game.i18n.localize(`VURS.BurstFire.${labelKey}`);
				const input = document.createElement("input");
				input.type = "number";
				if (min !== null) input.min = String(min);
				input.step = "1";
				input.dataset.vursBurstFireStat = field;
				if (labelKey === "Base") input.placeholder = String(row.base);
				input.setAttribute(
					"aria-label",
					`${row.label} ${game.i18n.localize(`VURS.BurstFire.${labelKey}`)}`
				);
				wrapper.append(caption, input);
				return wrapper;
			};
			fields.append(
				makeInput(`base${row.key[0].toUpperCase()}${row.key.slice(1)}`, "Base", 0),
				makeInput(`${row.key}Adjustment`, "Adjustment", null)
			);
			group.append(label, fields);
			section.append(group);
		}
		const calculated = group.querySelector(
			`[data-vurs-burst-fire-calculated="${row.key}"]`
		);
		const statLabel = group.querySelector(":scope > label");
		if (calculated.parentElement !== statLabel) {
			statLabel.append(document.createTextNode(" "), calculated);
		}
		calculated.textContent = String(row.calculated);
		group.querySelector(
			`input[data-vurs-burst-fire-stat="base${row.key[0].toUpperCase()}${row.key.slice(1)}"]`
		).value = row.derivedBase === null ? String(row.base) : "";
		group.querySelector(
			`input[data-vurs-burst-fire-stat="base${row.key[0].toUpperCase()}${row.key.slice(1)}"]`
		).placeholder = String(row.base);
		group.querySelector(
			`input[data-vurs-burst-fire-stat="${row.key}Adjustment"]`
		).value = String(row.adjustment);
		group.title = row.key === "rateOfFire"
			? game.i18n.format("VURS.BurstFire.AtMAP", { map: stats.effectiveMAP })
			: "";
	}

	const damageSection = [...details.querySelectorAll(":scope > fieldset")].find(fieldset =>
		fieldset.querySelector(":scope > legend")?.textContent.trim() ===
			game.i18n.localize("PF2E.DamageLabel")
	);
	if (damageSection && section.nextElementSibling !== damageSection) {
		details.insertBefore(section, damageSection);
	}
}

function markBurstFireAlternateUsage(app, element) {
	const actor = app?.actor ?? app?.document?.actor ?? app?.object;
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!actor || !root) return;
	const key = actor.uuid ?? actor.id;
	const prepared = preparedBurstFires.get(key);
	if (prepared && !actor.items?.get(prepared.itemId)) clearPreparedBurstFire(key);
	if (!actorSheetRoots.has(root)) {
		root.addEventListener("click", event => handleBurstFireSheetClick(actor, root, event), true);
		actorSheetRoots.add(root);
	}

	if (actor.type === "npc") {
		root.querySelectorAll(".vurs-npc-burst-fire-actions").forEach(actions => actions.remove());
		const automaticStrikes = [];
		for (const strikeElement of root.querySelectorAll(
			"li.item.action[data-strike][data-action-index]"
		)) {
			const strike = actor.system?.actions?.[Number(strikeElement.dataset.actionIndex)];
			if (!isAutomaticStrike(strike)) continue;
			const attackSubsection = strikeElement.querySelector(".button-group > .subsection.attack");
			if (!attackSubsection) continue;
			automaticStrikes.push({ strike, strikeElement, attackSubsection });
			if (prepared?.itemId === strike.item?.id) {
				prepared.root = root;
				prepared.strikeElement = strikeElement;
			}
		}

		for (const { strike, strikeElement, attackSubsection } of automaticStrikes) {
			const button = attackSubsection.querySelector(".vurs-burst-fire-trigger")
				?? document.createElement("button");
			button.type = "button";
			button.className = "attack-button vurs-burst-fire-trigger";
			button.dataset.action = "strike-attack";
			button.dataset.variantIndex = "0";
			button.dataset.actionIndex = strikeElement.dataset.actionIndex;
			button.replaceChildren();
			const rateOfFire = getRateOfFire(actor, strike) ?? 0;
			const label = game.i18n.localize("VURS.BurstFire.Title");
			const rateLabel = game.i18n.format("VURS.BurstFire.RateOfFireShort", {
				shots: rateOfFire
			});
			const name = document.createElement("span");
			name.className = "name";
			name.textContent = label;
			const glyph = document.createElement("span");
			glyph.className = "action-glyph";
			glyph.textContent = "2";
			button.append(name, document.createTextNode(" "), glyph, document.createTextNode(" "));
			const rate = document.createElement("span");
			rate.className = "vurs-burst-fire-rate-of-fire";
			rate.textContent = `(${rateLabel})`;
			button.append(rate);
			button.setAttribute(
				"aria-label",
				`${label} 2 (${rateLabel}) — ${strike.item.name}`
			);
			button.dataset.tooltip = strike.item.name;
			if (!button.isConnected || button.parentElement !== attackSubsection) {
				attackSubsection.append(button);
			}
			updatePreparedBurstFireButton(
				root,
				strikeElement,
				prepared?.itemId === strike.item?.id,
				actor
			);
		}
		return;
	}

	for (const strikeElement of root.querySelectorAll("li.strike[data-action-index]")) {
		const strike = actor.system?.actions?.[Number(strikeElement.dataset.actionIndex)];
		const autoFireIndex = strike?.altUsages?.findIndex(usage => usage.type === "auto-fire") ?? -1;
		const burstFireIndex = strike?.altUsages?.findIndex(usage => usage.type === "burst-fire") ?? -1;
		if (autoFireIndex < 0 || burstFireIndex < 0) continue;

		const controlsAlreadyPlaced = strikeElement.querySelector(":scope > section > .vurs-burst-fire-controls");
		if (controlsAlreadyPlaced) {
			if (prepared?.itemId === strike.item?.id) {
				prepared.root = root;
				prepared.strikeElement = strikeElement;
			}
			updatePreparedBurstFireButton(root, strikeElement, prepared?.itemId === strike.item?.id, actor);
			continue;
		}
		const autoFireUsage = strikeElement
			.querySelector(`[data-alt-usage="${autoFireIndex}"]`)
			?.closest(".alt-usage");
		const burstFireUsage = strikeElement
			.querySelector(`[data-alt-usage="${burstFireIndex}"]`)
			?.closest(".alt-usage");
		const buttonGroup = strikeElement.querySelector(":scope > section > .button-group.tags");
		if (!autoFireUsage || !burstFireUsage || !buttonGroup) continue;

		const autoFireButton = autoFireUsage.querySelector('button[data-action="strike-attack"]');
		const burstFireButton = burstFireUsage.querySelector('button[data-action="strike-attack"]');
		const damageButton = buttonGroup.querySelector('button[data-action="strike-damage"]');
		const criticalButton = buttonGroup.querySelector('button[data-action="strike-critical"]');
		if (!autoFireButton || !burstFireButton || !damageButton || !criticalButton) continue;

		burstFireButton.classList.add("vurs-burst-fire-trigger");
		const controls = document.createElement("div");
		controls.className = "button-group tags vurs-burst-fire-controls";
		controls.dataset.tooltipDirection = "UP";
		for (const button of [autoFireButton, burstFireButton, damageButton, criticalButton]) {
			controls.append(button);
		}
		buttonGroup.after(controls);
		autoFireUsage.remove();
		burstFireUsage.remove();
		if (prepared?.itemId === strike.item?.id) {
			prepared.root = root;
			prepared.strikeElement = strikeElement;
		}
		updatePreparedBurstFireButton(root, strikeElement, prepared?.itemId === strike.item?.id, actor);
	}
}

function getDisplayItem(item) {
	return new Proxy(item, {
		get(target, property) {
			if (property === "dealsDamage") return false;
			return Reflect.get(target, property, target);
		}
	});
}

function createBurstFireUsage(actor, strike, autoFire) {
	const base = autoFire ?? strike;
	const variants = [{
		label: game.i18n.format("VURS.BurstFire.VariantLabel", {
			shots: getRateOfFire(actor, strike) ?? 0
		}),
		roll: () => null
	}];
	return {
		...base,
		slug: `${strike.item.id}.${strike.item.slug ?? "weapon"}.burst-fire`,
		type: "burst-fire",
		attackRollType: "VURS.BurstFire.Title",
		label: strike.item.name,
		title: game.i18n.localize("VURS.BurstFire.Title"),
		description: game.i18n.localize("VURS.BurstFire.Description"),
		glyph: "2",
		actionCost: { type: "action", value: 2 },
		item: getDisplayItem(strike.item),
		statistic: strike.statistic ?? base.statistic,
		modifiers: strike.modifiers ?? base.modifiers ?? [],
		handsAvailable: strike.handsAvailable ?? base.handsAvailable,
		altUsages: [],
		traits: strike.traits ?? base.traits ?? [],
		weaponTraits: strike.weaponTraits ?? base.weaponTraits ?? [],
		ammunition: strike.ammunition ?? base.ammunition,
		ready: strike.ready,
		canAttack: true,
		variants
	};
}

function installBurstFirePrepareAttacks({ quiet = false } = {}) {
	const actorClasses = new Set([
		CONFIG.Actor?.documentClass,
		...(game.actors?.contents ?? []).map(actor => actor.constructor)
	]);
	const prototypes = new Set();
	for (const actorClass of actorClasses) {
		let prototype = actorClass?.prototype;
		while (prototype && !Object.prototype.hasOwnProperty.call(prototype, "prepareAttacks")) {
			prototype = Object.getPrototypeOf(prototype);
		}
		if (typeof prototype?.prepareAttacks === "function") prototypes.add(prototype);
	}

	if (prototypes.size === 0) {
		if (!quiet) console.error(`${MODULE_ID} | Could not add Burst-Fire: PF2E Actor.prepareAttacks is unavailable`);
		return;
	}

	for (const prototype of prototypes) {
		if (prototype[PREPARE_ATTACKS_WRAPPER]) continue;
		const original = prototype.prepareAttacks;
		Object.defineProperty(prototype, "prepareAttacks", {
			configurable: true,
			writable: true,
			value: function (...args) {
				const actions = original.apply(this, args);
				if (!Array.isArray(actions)) return actions;
				for (const strike of actions) {
					const traits = strike.item?.system?.traits?.value ?? strike.item?.traits?.value ?? [];
					if (strike.type !== "strike" || !traits.includes(AUTOMATIC_TRAIT)) continue;
					try {
						strike.altUsages ??= [];
						if (strike.altUsages.some(usage => usage.type === "burst-fire")) continue;
						const autoFire = strike.altUsages.find(usage => usage.type === "auto-fire");
						const burstFire = createBurstFireUsage(this, strike, autoFire);
						const autoFireIndex = strike.altUsages.indexOf(autoFire);
						strike.altUsages.splice(autoFireIndex >= 0 ? autoFireIndex + 1 : strike.altUsages.length, 0, burstFire);
					} catch (error) {
						console.error(`${MODULE_ID} | Could not add Burst-Fire to ${strike.item?.name ?? "weapon"}; keeping its Strike entry`, error);
					}
				}
				return actions;
			}
		});
		Object.defineProperty(prototype, PREPARE_ATTACKS_WRAPPER, { value: true });
	}
}

Hooks.once("init", registerBurstFireLocalization);
Hooks.once("setup", () => installBurstFirePrepareAttacks({ quiet: true }));
Hooks.once("pf2e.systemReady", () => installBurstFirePrepareAttacks());
Hooks.once("ready", () => {
	registerBurstFireLocalization();
	installBurstFirePrepareAttacks();
	Hooks.on("renderItemSheet", (app, html) => addBurstFireWeaponSection(app, html));
	Hooks.on("updateItem", clearPreparedBurstFireForItem);
	Hooks.on("deleteItem", clearPreparedBurstFireForItem);
});
Hooks.on("renderActorSheet", markBurstFireAlternateUsage);
