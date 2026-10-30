import {
	applyDamageInTransaction,
	getDamageRollOptions,
	getDamageSelectors,
	registerDamageTransactionFinalizer
} from "./lifesteal.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Collateral Damage";
const DAMAGE_HANDLER_KEY = Symbol.for(`${MODULE_ID}.applyDamageHandlers`);
const damageHandlers = globalThis[DAMAGE_HANDLER_KEY] ??= new Set();
const activeDamageParams = new WeakSet();
const collateralDamageApplications = new WeakSet();
const secretDamageActors = new Map();
const activeOverlays = new Map();
let CollateralDamageRuleElement = null;
let socketHandlerInstalled = false;
let secretDamageHookInstalled = false;
let groupedDamageUndoInstalled = false;

const OVERLAY_CHANNEL = `module.${MODULE_ID}`;
const OVERLAY_DURATION = 2000;
const AREA_TYPES = ["burst", "cone", "cube", "cylinder", "emanation", "line", "ring", "square"];

function registerCollateralDamageLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has(`PF2E.RuleElement.${RULE_KEY}`)) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerCollateralDamageRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const registry = system?.RuleElements;
	const RuleElement = system?.RuleElement;
	if (!RuleElement || !registry?.custom) {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system Rule Element API is unavailable`);
		return;
	}

	const ResolvableValueField = registry.builtin?.Resistance?.schema?.fields?.value?.constructor;
	if (typeof ResolvableValueField !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system resolvable-value field is unavailable`);
		return;
	}

	if (registry.custom[RULE_KEY]) {
		if (registry.custom[RULE_KEY] !== CollateralDamageRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	const damageTypes = CONFIG[game.system.id.toUpperCase()]?.damageTypes ?? CONFIG.PF2E?.damageTypes ?? {};
	const damageTypeChoices = Object.fromEntries([...Object.keys(damageTypes), "untyped"].map(type => [type, type]));
	CollateralDamageRuleElement = class CollateralDamageRuleElement extends RuleElement {
		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				value: new ResolvableValueField({ required: true, nullable: false }),
				type: new fields.StringField({
					required: true,
					nullable: false,
					choices: Object.fromEntries([...AREA_TYPES, "bounce"].map(type => [type, type]))
				}),
				distance: new ResolvableValueField({ required: true, nullable: false }),
				width: new ResolvableValueField({ required: false, nullable: false, initial: undefined }),
				collateralDamageThreshold: new ResolvableValueField({
					required: false,
					nullable: false,
					initial: 20
				}),
				mode: new fields.StringField({
					required: false,
					nullable: false,
					initial: "threshold",
					choices: { threshold: "Threshold", flat: "Flat", percent: "Percent" }
				}),
				bounceShots: new fields.NumberField({
					required: false,
					nullable: false,
					integer: true,
					min: 1,
					initial: 1
				}),
				bounceCount: new fields.NumberField({
					required: false,
					nullable: false,
					integer: true,
					min: 0
				}),
				bounceLimit: new fields.NumberField({
					required: false,
					nullable: false,
					integer: true,
					min: 0,
					initial: 1
				}),
				affects: new fields.StringField({
					required: false,
					nullable: false,
					initial: "hostile",
					choices: { allied: "Allied", neutral: "Neutral", hostile: "Hostile", all: "All" }
				}),
				affectsSelf: new fields.BooleanField({ required: false, nullable: false, initial: false }),
				divided: new fields.BooleanField({ required: false, nullable: false, initial: false }),
				beforeReduction: new fields.BooleanField({ required: false, nullable: false, initial: false }),
				damageType: new fields.StringField({
					required: false,
					nullable: true,
					initial: undefined,
					choices: damageTypeChoices
				}),
				placement: new fields.StringField({
					required: false,
					nullable: false,
					initial: "target",
					choices: { target: "Target", self: "Self" }
				}),
				selector: new fields.StringField({ required: false, nullable: true, initial: undefined })
			};
		}
	};

	registry.custom[RULE_KEY] = CollateralDamageRuleElement;
}

function currentHealthPool(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp) return null;

	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	return Number(hp.value ?? 0) + Number(hp.temp ?? 0) +
		(staminaEnabled ? Number(hp.sp?.value ?? 0) : 0);
}

function normalizeToken(token) {
	return token?.document ?? token ?? null;
}

function getTokenCenter(token) {
	const document = normalizeToken(token);
	if (!document) return null;
	const center = document.object?.getCenterPoint?.() ?? document.getCenterPoint?.();
	return center && { x: center.x, y: center.y };
}

function sameActor(left, right) {
	return Boolean(left && right && (
		left === right ||
		left.uuid === right.uuid ||
		left.id === right.id
	));
}

function getSceneTokenForActor(actor, scene, nearToken) {
	const targetCenter = getTokenCenter(nearToken);
	const actorToken = normalizeToken(actor.token);
	const tokens = [...(scene?.tokens ?? [])].filter(token =>
		sameActor(token.actor, actor) || token.id === actorToken?.id
	);
	if (!tokens.length) return null;
	if (!targetCenter) return tokens[0];
	return tokens.sort((left, right) => {
		const leftCenter = getTokenCenter(left);
		const rightCenter = getTokenCenter(right);
		return Math.hypot(leftCenter.x - targetCenter.x, leftCenter.y - targetCenter.y) -
			Math.hypot(rightCenter.x - targetCenter.x, rightCenter.y - targetCenter.y);
	})[0];
}

function getPlacementGeometry(placement, sourceToken, targetToken) {
	const sourceCenter = getTokenCenter(sourceToken);
	const targetCenter = getTokenCenter(targetToken);
	if (!sourceCenter || !targetCenter) return null;

	let dx = targetCenter.x - sourceCenter.x;
	let dy = targetCenter.y - sourceCenter.y;
	let length = Math.hypot(dx, dy);
	if (length === 0) {
		const fallbackAngle = Math.toRadians(normalizeToken(sourceToken).rotation ?? 0);
		dx = Math.cos(fallbackAngle);
		dy = Math.sin(fallbackAngle);
		length = 1;
	}
	const rotation = Math.toDegrees(Math.atan2(dy, dx));
	if (placement !== "self") return { x: targetCenter.x, y: targetCenter.y, rotation };

	const document = normalizeToken(sourceToken);
	const halfWidth = (document.width * canvas.dimensions.sizeX) / 2;
	const halfHeight = (document.height * canvas.dimensions.sizeY) / 2;
	const scale = Math.min(
		halfWidth / Math.abs(dx / length || Number.EPSILON),
		halfHeight / Math.abs(dy / length || Number.EPSILON)
	);
	return {
		x: sourceCenter.x + (dx / length) * scale,
		y: sourceCenter.y + (dy / length) * scale,
		rotation
	};
}

function getAreaShape(rule, geometry, originToken) {
	const distance = Number(rule.resolveValue(rule.distance, 5));
	const width = rule.width === undefined || rule.width === null
		? canvas.dimensions.distance
		: Number(rule.resolveValue(rule.width, canvas.dimensions.distance));
	if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(width) || width <= 0) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: area dimensions must resolve to positive numbers`);
		return null;
	}

	const pixelsPerDistance = canvas.dimensions.distancePixels;
	const radius = distance * pixelsPerDistance;
	const widthPixels = width * pixelsPerDistance;
	const common = { x: geometry.x, y: geometry.y };
	switch (rule.type ?? "burst") {
		case "burst":
		case "cylinder":
			return { type: "circle", ...common, radius };
		case "cone":
			return { type: "cone", ...common, radius, angle: 90, rotation: geometry.rotation, curvature: "round" };
		case "cube":
		case "square":
			return {
				type: "rectangle",
				...common,
				width: radius,
				height: radius,
				anchorX: 0,
				anchorY: 0.5,
				rotation: geometry.rotation
			};
		case "emanation": {
			const token = normalizeToken(originToken);
			if (!token) return null;
			return {
				type: "emanation",
				radius,
				base: {
					type: "token",
					x: token.x,
					y: token.y,
					width: token.width,
					height: token.height,
					shape: token.shape
				}
			};
		}
		case "line":
			return {
				type: "line",
				...common,
				length: radius,
				width: widthPixels,
				rotation: geometry.rotation
			};
		case "ring":
			return {
				type: "ring",
				...common,
				radius,
				innerWidth: widthPixels / 2,
				outerWidth: widthPixels / 2
			};
		default:
			console.error(`${MODULE_ID} | Unsupported ${RULE_KEY} area type: ${rule.type}`);
			return null;
	}
}

function getRelationship(sourceDisposition, targetDisposition) {
	const { NEUTRAL } = CONST.TOKEN_DISPOSITIONS;
	if (sourceDisposition === NEUTRAL || targetDisposition === NEUTRAL) return "neutral";
	return sourceDisposition === targetDisposition ? "allied" : "hostile";
}

function isAffectedByRule(rule, sourceToken, targetToken) {
	const sourceDisposition = normalizeToken(sourceToken)?.disposition;
	const targetDisposition = normalizeToken(targetToken)?.disposition;
	const affects = rule.affects ?? "all";
	return affects === "all" || affects === getRelationship(sourceDisposition, targetDisposition);
}

function getAreaTargets(region, sourceToken, primaryToken, rule) {
	const source = normalizeToken(sourceToken);
	const primary = normalizeToken(primaryToken);
	const targets = [];
	for (const token of region.parent.tokens) {
		if (token.id === primary?.id) continue;
		if (token.id === source?.id && !rule.affectsSelf) continue;
		if (sameActor(token.actor, source?.actor) && token.id !== source?.id) continue;
		if (!token.actor?.attributes?.hp) continue;
		if (!token.testInsideRegion(region)) continue;
		if (!isAffectedByRule(rule, source, token)) continue;
		targets.push(token);
	}
	return targets;
}

function calculateCollateralAmount(rule, beforeReduction, afterReduction) {
	const damage = rule.beforeReduction ? beforeReduction : afterReduction;
	if (!Number.isFinite(damage) || damage <= 0) return 0;
	const value = Number(rule.resolveValue(rule.value, 0));
	if (!Number.isFinite(value) || value <= 0) return 0;

	switch (rule.mode ?? "threshold") {
		case "flat":
			return Math.floor(value);
		case "percent":
			return Math.floor(damage * value);
		case "threshold": {
			const threshold = Number(rule.resolveValue(rule.collateralDamageThreshold ?? 20, 20));
			if (!Number.isFinite(threshold) || threshold <= 0) {
				console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: collateralDamageThreshold must resolve to a positive number`);
				return 0;
			}
			return Math.max(Math.floor((damage / threshold) * value), damage < threshold ? 1 : 0);
		}
		default:
			console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: unsupported mode "${rule.mode}"`);
			return 0;
	}
}

function selectorMatches(rule, selectors, rollOptions) {
	if (!rule.selector) return true;
	if (rule.selector !== "special-damage") return selectors.has(rule.selector);
	const options = rollOptions instanceof Set ? [...rollOptions] : [];
	const damageTypes = options
		.map(option => typeof option === "string" && option.replace(/^item:/, ""))
		.filter(option => option?.startsWith("damage:type:"))
		.map(option => option.slice("damage:type:".length));
	return damageTypes.some(type => !["physical", "bludgeoning", "piercing", "slashing"].includes(type));
}

function splitDamage(amount, damageRoll, overrideType) {
	const config = CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
	const validTypes = new Set([...Object.keys(config?.damageTypes ?? {}), "untyped"]);
	if (overrideType) {
		if (!validTypes.has(overrideType)) {
			console.error(`${MODULE_ID} | Skipping ${RULE_KEY}: unknown damage type "${overrideType}"`);
			return [];
		}
		return [{ type: overrideType, amount }];
	}

	const weights = new Map();
	for (const instance of damageRoll?.instances ?? []) {
		const weight = Number(instance.total);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		const type = validTypes.has(instance.type) ? instance.type : "untyped";
		weights.set(type, (weights.get(type) ?? 0) + weight);
	}
	if (!weights.size) weights.set("untyped", 1);

	const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
	const parts = [...weights].map(([type, weight]) => {
		const exact = (amount * weight) / totalWeight;
		const whole = Math.floor(exact);
		return { type, amount: whole, remainder: exact - whole };
	});
	let remaining = amount - parts.reduce((sum, part) => sum + part.amount, 0);
	parts.sort((left, right) => right.remainder - left.remainder || left.type.localeCompare(right.type));
	for (let index = 0; remaining > 0; index++, remaining--) parts[index % parts.length].amount++;
	return parts.filter(part => part.amount > 0);
}

function createCollateralDamageRoll(amount, damageRoll, damageType) {
	const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
	if (!DamageRoll) {
		console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: the system DamageRoll class is unavailable`);
		return null;
	}
	const parts = splitDamage(amount, damageRoll, damageType);
	if (!parts.length) return null;
	const formula = `{${parts.map(({ type, amount }) =>
		type === "untyped" ? `${amount}` : `${amount}[${type}]`
	).join(", ")}}`;
	try {
		return new DamageRoll(formula).evaluateSync();
	} catch (error) {
		console.error(`${MODULE_ID} | Could not create a damage roll for ${RULE_KEY}`, error);
		return null;
	}
}

function splitAmount(amount, count) {
	const base = Math.floor(amount / count);
	const remainder = amount % count;
	return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function getTokenDistance(left, right) {
	const from = getTokenCenter(left);
	const to = getTokenCenter(right);
	if (!from || !to) return Infinity;
	const measurement = canvas.grid.measurePath([from, to]);
	return Number(measurement?.distance ?? Infinity);
}

function getBounceTargets(scene, sourceToken, currentToken, rule, maxDistance, counts, limit) {
	const source = normalizeToken(sourceToken);
	const current = normalizeToken(currentToken);
	return [...scene.tokens].filter(token => {
		if (token.id === current.id || !token.actor?.attributes?.hp) return false;
		if (token.id === source.id && !rule.affectsSelf) return false;
		if (sameActor(token.actor, source.actor) && token.id !== source.id) return false;
		if (limit > 0 && (counts.get(token.id) ?? 0) >= limit) return false;
		if (!isAffectedByRule(rule, source, token)) return false;
		return getTokenDistance(current, token) <= maxDistance;
	});
}

function getRegionForShapes(scene, shapes) {
	try {
		return new CONFIG.Region.documentClass({
			name: "Collateral Damage",
			shapes: Array.isArray(shapes) ? shapes : [shapes],
			levels: [canvas.level.id],
			elevation: { bottom: null, top: null, topInclusive: true }
		}, { parent: scene });
	} catch (error) {
		console.error(`${MODULE_ID} | Could not create temporary ${RULE_KEY} area`, error);
		return null;
	}
}

function getEffectName(type) {
	switch (type) {
		case "collateral": return RULE_KEY;
		case "damage-return": return "Damage Return";
		case "lifesteal": return "Lifesteal";
		default: return "Additional effect";
	}
}

function createDamageRevertButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.classList.add("revert-damage");
	button.dataset.action = "revertDamage";
	button.dataset.tooltip = "PF2E.RevertDamage.ButtonTooltip";
	button.dataset.tooltipDirection = "UP";
	const icon = document.createElement("i");
	icon.classList.add("fa-solid", "fa-rotate-left");
	button.append(icon);
	return button;
}

function renderGroupedDamageEffects(damageTaken, primaryName, primaryUuid, effects) {
	const details = document.createElement("details");
	details.classList.add("vurs-damage-effects");
	const summary = document.createElement("summary");
	const recipients = new Set([primaryUuid, ...effects.map(effect =>
		effect.actorUuid ?? effect.targetName
	)]);
	summary.textContent = `Affected creatures (${recipients.size})`;
	details.append(summary);

	const list = document.createElement("ul");
	const primary = document.createElement("li");
	const primaryLabel = document.createElement("strong");
	primaryLabel.classList.add("statements", "vurs-damage-primary-label");
	primaryLabel.textContent = `${primaryName}: Primary damage`;
	primary.append(primaryLabel);
	const nestedEffects = document.createElement("ul");
	list.append(primary);
	for (const [index, effect] of effects.entries()) {
		const entry = document.createElement("li");
		const target = document.createElement("span");
		if (effect.hidden) {
			target.textContent = "Hidden creature";
			const gmTarget = document.createElement("span");
			gmTarget.dataset.visibility = "gm";
			gmTarget.textContent = ` (${effect.targetName})`;
			target.append(gmTarget);
		} else {
			target.textContent = effect.targetName;
		}
		const effectLabel = document.createElement("span");
		effectLabel.classList.add("vurs-damage-effect-label");
		effectLabel.append(target, document.createTextNode(
			` — ${getEffectName(effect.type)}${effect.label ? ` (${effect.label})` : ""}: ${effect.type === "lifesteal" ? "+" : "-"}${effect.amount}`
		));
		entry.append(effectLabel);
		const undo = createDamageRevertButton();
		undo.dataset.vursUndoEntry = String(index);
		undo.dataset.visibility = effect.hidden ? "gm" : "owner";
		entry.append(undo);
		nestedEffects.append(entry);
	}
	primary.append(nestedEffects);
	details.append(list);
	damageTaken.append(details);
}

async function finalizeGroupedDamageCard(transaction) {
	if (!transaction.rootMessageId || !transaction.effects.length) return;
	const message = game.messages?.get(transaction.rootMessageId);
	if (!message) {
		console.error(`${MODULE_ID} | Could not find the primary damage card for grouped effects`);
		return;
	}
	const effects = transaction.effects.filter(effect => effect.appliedDamage);
	if (!effects.length) return;

	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	const damageTaken = container.querySelector(".damage-taken");
	if (!damageTaken) {
		console.error(`${MODULE_ID} | Could not group effects: the primary card has no damage-taken section`);
		return;
	}
	const rootActor = fromUuidSync(transaction.rootActorUuid);
	renderGroupedDamageEffects(
		damageTaken,
		rootActor?.name ?? message.speaker?.alias ?? "Primary target",
		transaction.rootActorUuid,
		effects
	);
	const nativeUndo = damageTaken.querySelector(".revert-damage");
	if (nativeUndo) {
		nativeUndo.dataset.vursUndoGroup = "true";
		if (effects.some(effect => effect.hidden)) nativeUndo.dataset.visibility = "gm";
	} else {
		const undoAll = createDamageRevertButton();
		undoAll.dataset.vursUndoGroup = "true";
		undoAll.dataset.visibility = effects.some(effect => effect.hidden) ? "gm" : "owner";
		damageTaken.append(undoAll);
	}

	await message.update({
		content: container.innerHTML,
		[`flags.${MODULE_ID}.damageEffects`]: {
			entries: effects.map(effect => {
				const stored = foundry.utils.deepClone(effect);
				if (effect.hidden) {
					stored.targetName = "Hidden creature";
				}
				return stored;
			})
		}
	});
}

function getGroupedDamageData(message) {
	return foundry.utils.getProperty(message, `flags.${MODULE_ID}.damageEffects`);
}

function getEffectDamageRecord(entry) {
	return entry.appliedDamage;
}

async function undoDamageRecord(record) {
	const actor = fromUuidSync(record?.uuid);
	if (!actor || typeof actor.undoDamage !== "function") {
		throw new Error(`Could not find the actor to undo damage for ${record?.uuid ?? "unknown actor"}`);
	}
	if (!game.user.isGM && !actor.isOwner) {
		throw new Error(`You do not have permission to undo damage for ${actor.name}`);
	}
	await actor.undoDamage(record);
}

async function updateGroupedDamageState(
	message,
	group,
	{ primaryReverted = false, groupReverted = false } = {}
) {
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	for (const [index, entry] of group.entries.entries()) {
		if (!entry.isReverted) continue;
		const button = container.querySelector(`[data-vurs-undo-entry="${index}"]`);
		const row = button?.closest("li");
		button?.remove();
		row?.querySelector(".vurs-damage-effect-label")?.classList.add("reverted");
	}
	if (primaryReverted || groupReverted) {
		const button = container.querySelector("[data-vurs-undo-group]");
		button?.remove();
		container.querySelector(".vurs-damage-primary-label")?.classList.add("reverted");
	}
	const updates = {
		content: container.innerHTML,
		[`flags.${MODULE_ID}.damageEffects`]: group
	};
	if (primaryReverted) {
		updates[`flags.${game.system.id}.appliedDamage.isReverted`] = true;
	}
	await message.update(updates);
}

async function undoGroupedDamage(message, entryIndex = null) {
	const group = foundry.utils.deepClone(getGroupedDamageData(message));
	if (!group?.entries?.length || group.isReverted) return;
	if (entryIndex !== null) {
		const entry = group.entries[entryIndex];
		if (!entry || entry.isReverted) return;
		await undoDamageRecord(getEffectDamageRecord(entry));
		entry.isReverted = true;
		await updateGroupedDamageState(message, group);
		return;
	}

	const primaryDamage = foundry.utils.getProperty(
		message,
		`flags.${game.system.id}.appliedDamage`
	);
	const records = [
		...group.entries.filter(entry => !entry.isReverted).map(getEffectDamageRecord).reverse(),
		...(primaryDamage && !primaryDamage.isReverted ? [primaryDamage] : [])
	];
	const unauthorizedIndex = records.findIndex(record => {
		const actor = fromUuidSync(record?.uuid);
		return !actor || (!game.user.isGM && !actor.isOwner);
	});
	if (unauthorizedIndex >= 0) {
		const unauthorized = fromUuidSync(records[unauthorizedIndex]?.uuid);
		ui.notifications.warn(`You do not have permission to undo all affected damage (${unauthorized?.name ?? "an actor"}).`);
		return;
	}

	for (const entry of [...group.entries].reverse()) {
		if (entry.isReverted) continue;
		await undoDamageRecord(getEffectDamageRecord(entry));
		entry.isReverted = true;
		await updateGroupedDamageState(message, group);
	}
	if (primaryDamage && !primaryDamage.isReverted) {
		await undoDamageRecord(primaryDamage);
		group.isReverted = true;
		await updateGroupedDamageState(message, group, { primaryReverted: true, groupReverted: true });
		return;
	}
	group.isReverted = true;
	await updateGroupedDamageState(message, group, { groupReverted: true });
}

function installGroupedDamageUndo() {
	if (groupedDamageUndoInstalled) return;
	document.addEventListener("click", event => {
		const button = event.target?.closest?.("[data-vurs-undo-group], [data-vurs-undo-entry]");
		if (!button) return;
		const messageElement = button.closest(".message");
		const message = game.messages?.get(messageElement?.dataset.messageId);
		if (!message || !getGroupedDamageData(message)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const index = button.dataset.vursUndoEntry;
		void undoGroupedDamage(message, index === undefined ? null : Number(index))
			.catch(error => {
				console.error(`${MODULE_ID} | Failed to undo grouped damage`, error);
				ui.notifications.error(error.message);
			});
	}, true);
	groupedDamageUndoInstalled = true;
}

registerDamageTransactionFinalizer(finalizeGroupedDamageCard);

function applySecretDamageCard(actor, secret, callback) {
	if (!secret) return callback();
	const count = secretDamageActors.get(actor.uuid) ?? 0;
	secretDamageActors.set(actor.uuid, count + 1);
	return Promise.resolve()
		.then(callback)
		.finally(() => {
			const activeCount = secretDamageActors.get(actor.uuid) ?? 0;
			if (activeCount <= 1) secretDamageActors.delete(actor.uuid);
			else secretDamageActors.set(actor.uuid, activeCount - 1);
		});
}

async function applyCollateralDamageToTarget(target, amount, damageRollSource, damageType, sourceLabel, sourceParams) {
	const damageRoll = createCollateralDamageRoll(amount, damageRollSource, damageType);
	if (!damageRoll) return false;
	if (typeof target.actor.applyDamage !== "function") {
		console.error(`${MODULE_ID} | Could not apply ${RULE_KEY} to ${target.name}: the Actor applyDamage method is unavailable`);
		return false;
	}

	try {
		const secret = target.hidden || target.object?.isVisible === false;
		const sourceRollOptions = sourceParams.rollOptions instanceof Set
			? sourceParams.rollOptions
			: Array.isArray(sourceParams.rollOptions) ? sourceParams.rollOptions : [];
		const rollOptions = new Set([
			...sourceRollOptions,
			...(target.actor.getSelfRollOptions?.() ?? [])
		]);
		const healthBefore = currentHealthPool(target.actor);
		const damageParams = {
			damage: damageRoll,
			token: target.object ?? target,
			item: sourceParams.item,
			rollOptions
		};
		const effect = {
			type: "collateral",
			label: sourceLabel,
			amount,
			targetName: target.name,
			hidden: secret
		};
		collateralDamageApplications.add(damageParams);
		try {
			await applySecretDamageCard(target.actor, secret, () =>
				applyDamageInTransaction(target.actor, damageParams, sourceParams, effect)
			);
			const healthAfter = currentHealthPool(target.actor);
			if (healthBefore !== null && healthAfter !== null) {
				effect.amount = Math.max(0, healthBefore - healthAfter);
			}
		} finally {
			collateralDamageApplications.delete(damageParams);
		}
		return true;
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to apply ${RULE_KEY} to ${target.name}`, error);
		return false;
	}
}

async function applyBounceDamage(rule, scene, sourceToken, primaryToken, amount, damageRoll, sourceParams) {
	const maxDistance = Number(rule.resolveValue(rule.distance, 0));
	const bounceShots = Number(rule.bounceShots ?? 1);
	const bounceCount = Number(rule.bounceCount ?? 1);
	const bounceLimit = Number(rule.bounceLimit ?? 1);
	if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: distance must resolve to a positive number`);
		return [];
	}
	if (
		!Number.isInteger(bounceShots) || bounceShots < 1 ||
		!Number.isInteger(bounceCount) || bounceCount < 0 ||
		!Number.isInteger(bounceLimit) || bounceLimit < 0
	) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: bounceShots must be a positive integer; bounceCount and bounceLimit must be non-negative integers`);
		return [];
	}

	const counts = new Map();
	if (bounceLimit > 0) counts.set(primaryToken.id, 1);
	const initialTargets = new Set();
	const paths = [];
	const sourceLabel = rule.item?.name ?? rule.label ?? RULE_KEY;
	for (let shot = 0; shot < bounceShots; shot++) {
		const path = [getTokenCenter(primaryToken)].filter(Boolean);
		let currentToken = primaryToken;
		for (let bounce = 0; bounce < bounceCount; bounce++) {
			const candidates = getBounceTargets(scene, sourceToken, currentToken, rule, maxDistance, counts, bounceLimit)
				.filter(token => bounce > 0 || !initialTargets.has(token.id));
			if (!candidates.length) break;
			const target = candidates[Math.floor(Math.random() * candidates.length)];
			if (!await applyCollateralDamageToTarget(
				target, amount, damageRoll, rule.damageType, sourceLabel, sourceParams
			)) break;
			if (bounce === 0) initialTargets.add(target.id);
			counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
			const center = getTokenCenter(target);
			if (center) path.push(center);
			currentToken = target;
		}
		if (path.length > 1) paths.push(path);
	}
	return paths;
}

function installSecretDamageCardHook() {
	if (secretDamageHookInstalled) return;
	Hooks.on("preCreateChatMessage", (message, data) => {
		if (foundry.utils.getProperty(data, "flags.pf2e.context.type") !== "damage-taken") return;
		const actorUuid = foundry.utils.getProperty(data, "flags.pf2e.appliedDamage.uuid");
		if (!secretDamageActors.has(actorUuid)) return;
		const recipients = ChatMessage.getWhisperRecipients("GM").map(user => user.id);
		data.whisper = recipients.length ? recipients : [game.user.id];
		data.blind = true;
	});
	secretDamageHookInstalled = true;
}

function clearOverlay(id) {
	const overlay = activeOverlays.get(id);
	if (!overlay) return;
	clearTimeout(overlay.timeout);
	for (const timeout of overlay.segmentTimeouts) clearTimeout(timeout);
	overlay.destroy();
	activeOverlays.delete(id);
}

function clearAllOverlays() {
	for (const id of activeOverlays.keys()) clearOverlay(id);
}

function drawOverlay({ id, sceneId, shapes, paths, expiresAt, color }) {
	if (!canvas.ready || canvas.scene?.id !== sceneId) return;
	if (activeOverlays.has(id)) return;
	const validShapes = (Array.isArray(shapes) ? shapes : []).filter(shape =>
		shape && typeof shape.type === "string" && AREA_TYPES.some(type =>
			(type === "burst" || type === "cylinder") ? shape.type === "circle" :
			(type === "cube" || type === "square") ? shape.type === "rectangle" :
			shape.type === type
		)
	);
	const validPaths = (Array.isArray(paths) ? paths : []).filter(path =>
		Array.isArray(path) && path.length > 1 &&
		path.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
	);
	if (!validShapes.length && !validPaths.length) return;
	const colorValue = PIXI.utils.string2hex(color);
	const destroyers = [];
	const progressiveSegments = [];
	if (validShapes.length) {
		const region = getRegionForShapes(canvas.scene, validShapes);
		if (region && canvas.grid.isGridless) {
			const graphics = new PIXI.Graphics();
			graphics.eventMode = "none";
			graphics.lineStyle({ width: Math.max(2, canvas.dimensions.uiScale * 2), color: colorValue, alpha: 0.9 });
			graphics.beginFill(colorValue, 0.18);
			for (const shape of region.shapes) shape.drawShape(graphics);
			graphics.endFill();
			canvas.interface.addChild(graphics);
			destroyers.push(() => {
				graphics.parent?.removeChild(graphics);
				graphics.destroy();
			});
		} else if (region) {
			const layerName = `vurs-collateral-${id}`;
			canvas.interface.grid.addHighlightLayer(layerName);
			const bounds = region.polygonTree.bounds.clone().fit(canvas.dimensions.rect).pad(1);
			const [i0, j0, i1, j1] = canvas.grid.getOffsetRange(bounds);
			const dx = canvas.grid.sizeX / 2;
			const dy = canvas.grid.sizeY / 2;
			for (let i = i0; i < i1; i++) {
				for (let j = j0; j < j1; j++) {
					const offset = { i, j };
					const center = canvas.grid.getCenterPoint(offset);
					center.x = Math.round(center.x - dx) + dx;
					center.y = Math.round(center.y - dy) + dy;
					const origin = region.shapes[0];
					const containsOriginCell =
						Math.max(Math.abs(center.x - origin.x), Math.abs(center.y - origin.y)) < 1;
					if (!containsOriginCell && !region.polygonTree.testPoint(center)) continue;
					const { x, y } = canvas.grid.getTopLeftPoint(offset);
					canvas.interface.grid.highlightPosition(layerName, {
						x,
						y,
						color: colorValue,
						border: colorValue,
						alpha: 0.25
					});
				}
			}
			destroyers.push(() => canvas.interface.grid.destroyHighlightLayer(layerName));
		}
	}
	if (validPaths.length) {
		for (const path of validPaths) {
			for (let index = 1; index < path.length; index++) {
				const graphics = new PIXI.Graphics();
				graphics.eventMode = "none";
				graphics.lineStyle({
					width: Math.max(3, canvas.dimensions.uiScale * 3),
					color: colorValue,
					alpha: 0.95
				});
				graphics.moveTo(path[index - 1].x, path[index - 1].y);
				graphics.lineTo(path[index].x, path[index].y);
				canvas.interface.addChild(graphics);
				let destroyed = false;
				const destroySegment = () => {
					if (destroyed) return;
					destroyed = true;
					graphics.parent?.removeChild(graphics);
					graphics.destroy();
				};
				destroyers.push(destroySegment);
				progressiveSegments.push(destroySegment);
			}
		}
	}
	if (!destroyers.length) return;

	const duration = Math.min(OVERLAY_DURATION, Math.max(0, expiresAt - Date.now()));
	const segmentTimeouts = [];
	const timeout = setTimeout(() => clearOverlay(id), duration);
	activeOverlays.set(id, {
		destroy: () => destroyers.forEach(destroy => destroy()),
		segmentTimeouts,
		timeout
	});
	progressiveSegments.forEach((destroy, index) => {
		segmentTimeouts.push(setTimeout(
			destroy,
			duration * (index + 1) / progressiveSegments.length
		));
	});
}

function installOverlaySocket() {
	if (socketHandlerInstalled || !game.socket) return;
	game.socket.on(OVERLAY_CHANNEL, data => {
		if (
			!data ||
			data.type !== "collateral-damage-area" ||
			typeof data.id !== "string" ||
			typeof data.sceneId !== "string" ||
			typeof data.color !== "string" ||
			!/^#[\da-f]{6}$/i.test(data.color) ||
			!Number.isFinite(data.expiresAt) ||
			data.expiresAt <= Date.now() ||
			data.senderId === game.user.id
		) return;
		try {
			drawOverlay(data);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to render a received ${RULE_KEY} area`, error);
		}
	});
	socketHandlerInstalled = true;
}

function displayArea(shapes, paths) {
	if (!canvas.scene || (!shapes.length && !paths.length)) return;
	const data = {
		type: "collateral-damage-area",
		id: foundry.utils.randomID(),
		sceneId: canvas.scene.id,
		shapes: shapes.map(shape => foundry.utils.deepClone(shape)),
		paths: paths.map(path => path.map(point => ({ ...point }))),
		color: game.user.color.toString(),
		expiresAt: Date.now() + OVERLAY_DURATION,
		senderId: game.user.id
	};
	drawOverlay(data);
	game.socket?.emit(OVERLAY_CHANNEL, data);
}

async function applyCollateralDamage(actor, params, beforeReduction, afterReduction) {
	const damageDealer = params.item?.actor ?? params.item?.parent;
	const targetToken = normalizeToken(params.token);
	const scene = targetToken?.parent ?? canvas.scene;
	if (!damageDealer || !targetToken || !scene || scene !== canvas.scene) {
		return { shapes: [], paths: [] };
	}

	const sourceToken = getSceneTokenForActor(damageDealer, scene, targetToken);
	if (!sourceToken) {
		console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: no source token for ${damageDealer.name} in the current scene`);
		return { shapes: [], paths: [] };
	}

	const rollOptions = getDamageRollOptions(params.damage, params.rollOptions);
	const selectors = getDamageSelectors(params.damage, params.item);
	const seenSlugs = new Set();
	const shapes = [];
	const paths = [];
	for (const rule of damageDealer.rules ?? []) {
		if (
			rule.key !== RULE_KEY ||
			rule.ignored ||
			!selectorMatches(rule, selectors, rollOptions) ||
			!(rule.predicate?.test?.(rollOptions) ?? true)
		) continue;

		const slug = typeof rule.slug === "string" ? rule.slug.trim() : "";
		if (slug && seenSlugs.has(slug)) continue;
		const amount = calculateCollateralAmount(rule, beforeReduction, afterReduction);
		if (amount <= 0) continue;

		if (rule.type === "bounce") {
			paths.push(...await applyBounceDamage(
				rule, scene, sourceToken, targetToken, amount, params.damage, params
			));
			if (slug) seenSlugs.add(slug);
			continue;
		}

		const geometry = getPlacementGeometry(rule.placement ?? "target", sourceToken, targetToken);
		if (!geometry) {
			console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: source and target positions are unavailable`);
			continue;
		}
		const originToken = rule.placement === "self" ? sourceToken : targetToken;
		const shape = getAreaShape(rule, geometry, originToken);
		if (!shape) continue;
		const region = getRegionForShapes(scene, shape);
		if (!region) continue;
		shapes.push(shape);
		if (slug) seenSlugs.add(slug);

		const targets = getAreaTargets(region, sourceToken, targetToken, rule);
		if (!targets.length) continue;
		const amounts = rule.divided ? splitAmount(amount, targets.length) : targets.map(() => amount);
		const sourceLabel = rule.item?.name ?? rule.label ?? RULE_KEY;
		for (const [index, target] of targets.entries()) {
			if (amounts[index] <= 0) continue;
			await applyCollateralDamageToTarget(
				target, amounts[index], params.damage, rule.damageType, sourceLabel, params
			);
		}
	}
	return { shapes, paths };
}

async function applyCollateralDamageHandler(actor, wrapped, args) {
	const params = args[0];
	if (params && collateralDamageApplications.has(params)) return wrapped(...args);
	if (!params || typeof params !== "object" || activeDamageParams.has(params)) return wrapped(...args);
	const damage = typeof params.damage === "number" ? params.damage : params.damage?.total;
	if (typeof damage !== "number" || damage <= 0 || !params.item) return wrapped(...args);

	activeDamageParams.add(params);
	try {
		const targetActor = params.token?.actor ?? actor;
		const healthBefore = currentHealthPool(targetActor);
		const result = await wrapped(...args);
		const healthAfter = currentHealthPool(targetActor);
		if (healthBefore === null || healthAfter === null) return result;

		const damageApplied = Math.max(0, healthBefore - healthAfter);
		const { shapes, paths } = await applyCollateralDamage(actor, params, damage, damageApplied);
		try {
			displayArea(shapes, paths);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to display the temporary ${RULE_KEY} area`, error);
		}
		return result;
	} finally {
		activeDamageParams.delete(params);
	}
}

damageHandlers.add(applyCollateralDamageHandler);

function initializeCollateralDamage() {
	registerCollateralDamageLocalization();
	registerCollateralDamageRuleElement();
	installSecretDamageCardHook();
	installGroupedDamageUndo();
	installOverlaySocket();
}

Hooks.once("init", registerCollateralDamageLocalization);
Hooks.once("init", () => registerCollateralDamageRuleElement({ quiet: true }));
Hooks.once("setup", registerCollateralDamageRuleElement);
Hooks.once("pf2e.systemReady", initializeCollateralDamage);
Hooks.once("sf2e.systemReady", initializeCollateralDamage);
Hooks.once("ready", initializeCollateralDamage);
Hooks.on("canvasTearDown", clearAllOverlays);
