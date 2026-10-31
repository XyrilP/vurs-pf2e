import { getEffectiveStrikeMAP } from "./attackSpeed.js";
import { applyDamageInTransaction, runDamageTransaction } from "./lifesteal.js";
import { createVursPlayCostElement } from "./playCostIcons.js";
import {
	displayCollateralArea,
	getTokenCenter,
	getTokenDistance,
	getPlacementGeometries,
	getTokensInCollateralShape
} from "./collateralDamage.js";

const MODULE_ID = "vurs-pf2e";
const PREPARE_ATTACKS_WRAPPER = Symbol.for(`${MODULE_ID}.burstFirePrepareAttacks`);
const AUTOMATIC_TRAIT = "automatic";
const DEGREE_OF_SUCCESS = ["criticalFailure", "failure", "success", "criticalSuccess"];

const BURST_FIRE_TRANSLATIONS = {
	Title: "Burst-Fire",
	RateOfFire: "Rate of Fire",
	Recoil: "Recoil",
	AtMAP: "at MAP {map}",
	Description: "<p><strong>Cost</strong> 2 actions</p><p>Fire an automatic weapon repeatedly. Rate of Fire is 3 + (5 - MAP), to a minimum of 0 shots, and is capped by available ammunition. Each projectile uses the selected Strike's MAP, then increases MAP normally for later projectiles. Each projectile is a separate Strike and uses normal range-increment penalties. Subsequent Strikes and all damage resolve automatically after the first Strike.</p><p>The Recoil Area is a cone aimed at the target, with a distance equal to half the weapon's maximum range. Its spread is 5 degrees plus 5 degrees per Recoil. Recoil is 10 minus the weapon's Bulk (minimum 0), halved and rounded down for a weapon listed as two-handed.</p><p>On a miss, the projectile diverts to the nearest other creature in the cone, including allies, and deals half damage. Each possible secondary target is selected once before the burst cycles back to previously selected targets. A critical miss deals no secondary damage.</p>",
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
		RollFailed: "Burst-Fire stopped because one of its Strikes could not be completed."
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
	const effectiveMAP = getEffectiveStrikeMAP(strike, 1, actor);
	if (!Number.isFinite(effectiveMAP)) return null;
	return Math.max(0, Math.floor(3 + (5 - effectiveMAP)));
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

function getRecoil(weapon) {
	const bulk = Number(weapon.system.bulk?.value);
	const numericBulk = Number.isFinite(bulk) && bulk >= 1 ? Math.floor(bulk) : 0;
	const recoil = Math.max(0, 10 - numericBulk);
	const usage = weapon.usage?.value ?? weapon.system.usage?.value;
	return usage === "held-in-two-hands" ? Math.floor(recoil / 2) : recoil;
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
	return geometries.map(geometry => ({
		type: "cone",
		x: geometry.x,
		y: geometry.y,
		radius: (maxRange / 2) * distancePixels,
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
	const options = (checkContext.options ?? []).filter(option =>
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
	strike,
	target,
	mapIncreases,
	outcome,
	halfDamage,
	event,
	checkContext
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
		rollOptions: collectRollOptions(damageCheckContext, collectRollOptions(damageRoll)),
		outcome
	};
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

function getCurrentHealthPool(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp) return null;
	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	return Number(hp.value ?? 0) + Number(hp.temp ?? 0) +
		(staminaEnabled ? Number(hp.sp?.value ?? 0) : 0);
}

async function applyBurstFireDamage(applications) {
	if (applications.length === 0) return;
	const [root, ...nested] = applications;
	await runDamageTransaction(root.actor, root.damageParams, async rootParams => {
		await root.actor.applyDamage(rootParams);
		for (const application of nested) {
			const healthBefore = getCurrentHealthPool(application.actor);
			await applyDamageInTransaction(
				application.actor,
				application.damageParams,
				rootParams,
				application.effect
			);
			const healthAfter = getCurrentHealthPool(application.actor);
			if (healthBefore !== null && healthAfter !== null) {
				application.effect.amount = Math.max(0, healthBefore - healthAfter);
			}
		}
	});
}

async function renderShotResult(index, attackRoll, outcome, target, damageRoll, note) {
	const details = document.createElement("details");
	details.className = "vurs-burst-fire-shot";
	const summary = document.createElement("summary");
	summary.textContent = `${game.i18n.format("VURS.BurstFire.Notes.Shot", {
		number: index + 1,
		outcome: getOutcomeLabel(outcome),
		target: target?.name ?? game.i18n.localize("VURS.BurstFire.Notes.NoDamageTarget")
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

async function consumeOneRound(weapon) {
	const ammo = getWeaponAmmo(weapon);
	if (!ammo) return true;
	if (getAmmoCount(weapon) < 1) return false;
	if (typeof ammo.consume === "function") {
		await ammo.consume(1);
		return true;
	}
	if (ammo.type === "weapon" && typeof ammo.update === "function") {
		await ammo.update({ "system.quantity": Math.max(0, Number(ammo.quantity) - 1) });
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

	const visited = new Set();
	let secondaryTargets = null;
	const paths = [];
	const shotResults = [];
	const damageApplications = [];
	try {
		for (let shot = 0; shot < shotCount; shot++) {
			if (getAmmoCount(weapon) < 1) {
				ui.notifications.warn(game.i18n.localize("VURS.BurstFire.Warnings.NoShots"));
				break;
			}
			const mapIndex = Math.min(startingMAP + shot, strike.variants.length - 1);
			const variant = strike.variants[mapIndex];
			if (!variant?.roll) {
				console.error(`${MODULE_ID} | Could not roll Burst-Fire projectile: Strike MAP variant ${mapIndex} is unavailable`);
				break;
			}

			const rollEvent = shot === 0 ? options.event : getAutomaticRollEvent("check");
			let checkContext = null;
			const attackRoll = await variant.roll({
				event: rollEvent,
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
			if (!attackRoll) break;
			if (!checkContext) {
				console.error(`${MODULE_ID} | Burst-Fire Strike did not provide its check context; on-hit damage effects may not resolve for ${weapon.name}`);
			}
			if (!await consumeOneRound(weapon)) {
				ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.AmmoChanged"));
				console.error(`${MODULE_ID} | Burst-Fire projectile was rolled but ammunition could not be consumed`);
				break;
			}

			const degree = attackRoll.degreeOfSuccess ?? attackRoll.options?.degreeOfSuccess;
			const outcome = Number.isInteger(degree) ? DEGREE_OF_SUCCESS[degree] : degree;
			if (!["success", "criticalSuccess", "failure", "criticalFailure"].includes(outcome)) {
				throw new Error(`Unexpected Strike outcome: ${String(outcome)}`);
			}
			let damageTarget = null;
			let damageRoll = null;
			let damageApplication = null;
			let note = null;
			if (outcome === "success" || outcome === "criticalSuccess") {
				damageTarget = primaryToken;
				const damageResult = await applyStrikeDamage(
					strike,
					damageTarget,
					mapIndex,
					outcome,
					false,
					getAutomaticRollEvent("damage"),
					checkContext
				);
				damageRoll = damageResult?.damageRoll ?? null;
				damageApplication = damageResult?.application ?? null;
				const path = createPath(sourceToken, primaryToken, null, shapes);
				if (path) paths.push(path);
			} else if (outcome === "failure" || outcome === "criticalFailure") {
				secondaryTargets ??= getEligibleSecondaryTargets(shapes, sourceToken, primaryToken);
				const secondary = getNextSecondaryTarget(secondaryTargets, visited);
				const criticalMiss = outcome === "criticalFailure";
				if (secondary) damageTarget = secondary.object ?? secondary;
				const path = createPath(sourceToken, primaryToken, null, shapes, {
					continueToEdge: true,
					extendToEdge: true
				});
				if (path) paths.push(path);

				if (!secondary) {
					note = "VURS.BurstFire.Notes.NoSecondaryTarget";
				} else if (criticalMiss) {
					note = "VURS.BurstFire.Notes.CriticalMiss";
				} else {
					const damageResult = await applyStrikeDamage(
						strike,
						damageTarget,
						mapIndex,
						"success",
						true,
						getAutomaticRollEvent("damage"),
						checkContext
					);
					damageRoll = damageResult?.damageRoll ?? null;
					damageApplication = damageResult?.application ?? null;
					note = "VURS.BurstFire.Notes.HalfDamage";
				}
			}
			if (damageApplication) damageApplications.push(damageApplication);

			shotResults.push({
				attackRoll,
				outcome,
				damageRoll,
				target: getTokenDocument(damageTarget),
				note
			});
		}
	} catch (error) {
		console.error(`${MODULE_ID} | Burst-Fire stopped after an error for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.RollFailed"));
	} finally {
		if (paths.length > 0 || shapes.length > 0) displayCollateralArea(shapes, paths);
	}
	try {
		const shotHtml = await Promise.all(shotResults.map((result, index) =>
			renderShotResult(
				index,
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
		await createBurstFireChatMessage(
			actor,
			sourceToken,
			weapon,
			shotResults
		);
	} catch (error) {
		console.error(`${MODULE_ID} | Could not create the Burst-Fire chat card for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.ChatFailed"));
	}
	try {
		await applyBurstFireDamage(damageApplications);
	} catch (error) {
		console.error(`${MODULE_ID} | Could not apply Burst-Fire damage for ${weapon.name}`, error);
		ui.notifications.error(game.i18n.localize("VURS.BurstFire.Warnings.DamageFailed"));
	}
	return null;
}

function isAutomaticWeapon(item) {
	const traits = item?.system?.traits?.value ?? item?.traits?.value ?? [];
	return item?.type === "weapon" && traits.includes(AUTOMATIC_TRAIT);
}

function getWeaponRateOfFire(item) {
	const actor = item.actor ?? item.parent?.actor;
	const strike = Array.isArray(actor?.system?.actions)
		? actor.system.actions.find(action => action.type === "strike" && action.item?.id === item.id)
		: null;
	const effectiveMAP = strike ? getEffectiveStrikeMAP(strike, 1, actor) : 5;
	const map = Number.isFinite(effectiveMAP) ? effectiveMAP : 5;
	return {
		rateOfFire: Math.max(0, Math.floor(3 + (5 - map))),
		effectiveMAP: map
	};
}

function addBurstFireItemStats(app, element) {
	const item = app?.item ?? app?.object;
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!item) return;
	if (!isAutomaticWeapon(item)) {
		root?.querySelectorAll("[data-vurs-burst-fire-item-stat]").forEach(group => group.remove());
		return;
	}
	const basics = root?.querySelector(".tab.details fieldset.basics, .tab.details, .tab[data-tab='details']");
	if (!basics) return;

	const { rateOfFire, effectiveMAP } = getWeaponRateOfFire(item);
	const stats = [
		["rateOfFire", game.i18n.localize("VURS.BurstFire.RateOfFire"), `${rateOfFire} (${game.i18n.format("VURS.BurstFire.AtMAP", { map: effectiveMAP })})`],
		["recoil", game.i18n.localize("VURS.BurstFire.Recoil"), String(getRecoil(item))]
	];
	for (const [key, labelText, valueText] of stats) {
		let group = basics.querySelector(`[data-vurs-burst-fire-item-stat="${key}"]`);
		if (!group) {
			group = document.createElement("div");
			group.className = "form-group";
			group.dataset.vursBurstFireItemStat = key;
			const label = document.createElement("label");
			label.textContent = labelText;
			const fields = document.createElement("div");
			fields.className = "form-fields";
			const value = document.createElement("span");
			value.className = "vurs-burst-fire-item-stat";
			fields.append(value);
			group.append(label, fields);
			basics.append(group);
		}
		group.querySelector(".vurs-burst-fire-item-stat").textContent = valueText;
	}
}

function markBurstFireAlternateUsage(app, element) {
	const actor = app?.actor ?? app?.object;
	const root = element instanceof HTMLElement ? element : element?.[0];
	if (!actor || !root) return;

	for (const strikeElement of root.querySelectorAll("li.strike[data-action-index]")) {
		const strike = actor.system?.actions?.[Number(strikeElement.dataset.actionIndex)];
		const autoFireIndex = strike?.altUsages?.findIndex(usage => usage.type === "auto-fire") ?? -1;
		const burstFireIndex = strike?.altUsages?.findIndex(usage => usage.type === "burst-fire") ?? -1;
		if (autoFireIndex < 0 || burstFireIndex < 0) continue;

		const autoFire = strikeElement
			.querySelector(`[data-alt-usage="${autoFireIndex}"]`)
			?.closest(".alt-usage");
		const burstFire = strikeElement
			.querySelector(`[data-alt-usage="${burstFireIndex}"]`)
			?.closest(".alt-usage");
		if (!autoFire || !burstFire) continue;

		let usages = strikeElement.querySelector(":scope > section > .vurs-burst-fire-usages");
		if (!usages) {
			usages = document.createElement("div");
			usages.className = "vurs-burst-fire-usages";
			autoFire.before(usages);
		}
		usages.append(autoFire, burstFire);
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
		roll: options => rollBurstFire(actor, strike, 0, options)
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
	Hooks.on("renderItemSheet", (app, html) => addBurstFireItemStats(app, html));
});
Hooks.on("renderActorSheet", markBurstFireAlternateUsage);
