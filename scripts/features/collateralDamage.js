import {
	applyDamageInTransaction,
	getDamageRollOptions,
	getDamageSelectors,
	getDamageModifierBreakdown,
	queueDamageTransactionApplication,
	queueDamageTransactionRequest,
	registerDamageTransactionFinalizer,
	runDamageTransactionActorOperation
} from "./lifesteal.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Collateral Damage";
const DAMAGE_HANDLER_KEY = Symbol.for(`${MODULE_ID}.applyDamageHandlers`);
const damageHandlers = globalThis[DAMAGE_HANDLER_KEY] ??= new Set();
const activeDamageParams = new WeakSet();
const collateralDamageApplications = new WeakSet();
const secretDamageActors = new Map();
const activeOverlays = new Map();
const pendingOverlays = new Map();
let CollateralDamageRuleElement = null;
let socketHandlerInstalled = false;
let secretDamageHookInstalled = false;
let groupedDamageUndoInstalled = false;
let elevationDistanceWarningShown = false;

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
				bounceShots: new ResolvableValueField({
					required: false,
					nullable: true,
					initial: 1
				}),
				bounceCount: new ResolvableValueField({
					required: false,
					nullable: false,
					initial: 1
				}),
				bounceLimit: new fields.NumberField({
					required: false,
					nullable: false,
					integer: true,
					min: 0,
					initial: 1
				}),
				bounceNearest: new fields.BooleanField({
					required: false,
					nullable: false,
					initial: true
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
				areaDamage: new fields.BooleanField({
					required: false,
					nullable: true,
					initial: undefined
				}),
				damageType: new fields.StringField({
					required: false,
					nullable: true,
					initial: undefined,
					choices: damageTypeChoices
				}),
				placement: new fields.StringField({
					required: false,
					nullable: false,
					initial: "self",
					choices: { target: "Target", self: "Self" }
				}),
				selector: new fields.StringField({ required: false, nullable: true, initial: undefined })
			};
		}
	};

	registry.custom[RULE_KEY] = CollateralDamageRuleElement;
}

function ruleCountsAsAreaDamage(rule) {
	if (typeof rule.areaDamage === "boolean") return rule.areaDamage;
	const sourceRule = rule.item?.system?.rules?.[rule.sourceIndex];
	if (typeof sourceRule?.areaDamage === "boolean") return sourceRule.areaDamage;
	return rule.type !== "bounce";
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

function getPlacementGeometries(placement, sourceToken, targetToken) {
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
	const originToken = normalizeToken(placement === "self" ? sourceToken : targetToken);
	const center = placement === "self" ? sourceCenter : targetCenter;
	const direction = { x: dx / length, y: dy / length };
	const halfWidth = (originToken.width * canvas.grid.sizeX) / 2;
	const halfHeight = (originToken.height * canvas.grid.sizeY) / 2;
	const xDistance = halfWidth / Math.abs(direction.x || Number.EPSILON);
	const yDistance = halfHeight / Math.abs(direction.y || Number.EPSILON);
	const distanceToEdge = Math.min(xDistance, yDistance);
	const edgeX = center.x + direction.x * distanceToEdge;
	const edgeY = center.y + direction.y * distanceToEdge;
	const tolerance = 1;

	let corners;
	if (Math.abs(xDistance - yDistance) <= tolerance) {
		corners = [
			{
				x: center.x - Math.sign(direction.x) * halfWidth,
				y: edgeY
			},
			{
				x: edgeX,
				y: center.y - Math.sign(direction.y) * halfHeight
			}
		];
	} else if (xDistance < yDistance) {
		const x = center.x + Math.sign(direction.x) * halfWidth;
		corners = [
			{ x, y: center.y - halfHeight },
			{ x, y: center.y + halfHeight }
		];
	} else {
		const y = center.y + Math.sign(direction.y) * halfHeight;
		corners = [
			{ x: center.x - halfWidth, y },
			{ x: center.x + halfWidth, y }
		];
	}
	return corners.map(({ x, y }) => ({ x, y, rotation }));
}

function resolveCollateralDistance(rule, damageItem, damageSource) {
	const expression = String(rule.distance);
	if (!/\b(?:range-increment|range|reach)\b/.test(expression)) {
		return Number(rule.resolveValue(rule.distance, rule.type === "bounce" ? 0 : 5));
	}

	const range = damageItem?.range ?? damageItem?.system?.range;
	const variables = {
		range: range?.max,
		"range-increment": range?.increment,
		reach: damageSource?.getReach?.({ action: "attack", weapon: damageItem })
	};
	let missingVariable = null;
	const substitutedExpression = expression.replace(
		/(^|[^A-Za-z0-9_@.-])(range-increment|range|reach)(?=$|[^A-Za-z0-9_.-])/g,
		(match, prefix, variable) => {
			const value = Number(variables[variable]);
			if (!Number.isFinite(value) || value <= 0) {
				console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: the damage source's ${variable} is unavailable or not positive`);
				missingVariable = variable;
				return match;
			}
			return `${prefix}${value}`;
		}
	);
	if (missingVariable) return null;

	const resolvedExpression = rule.resolveValue(substitutedExpression, null);
	if (typeof resolvedExpression === "number") {
		if (!Number.isFinite(resolvedExpression) || resolvedExpression <= 0) {
			console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: distance must resolve to a positive number`);
			return null;
		}
		return resolvedExpression;
	}
	if (typeof resolvedExpression !== "string") return null;

	try {
		const distance = Number(Roll.safeEval(resolvedExpression));
		if (!Number.isFinite(distance) || distance <= 0) {
			console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: distance must resolve to a positive number`);
			return null;
		}
		return distance;
	} catch (error) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: could not evaluate distance formula`, error);
		return null;
	}
}

function getAreaShape(rule, geometry, originToken, distance) {
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

function isAreaPointHighlighted(region, center) {
	if (!center || !region.polygonTree) return false;
	if (region.polygonTree.testPoint(center)) return true;

	const origin = region.shapes[0];
	return Boolean(origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) &&
		Math.max(Math.abs(center.x - origin.x), Math.abs(center.y - origin.y)) < 1);
}

function isTokenCenterInArea(region, token) {
	return isAreaPointHighlighted(region, getTokenCenter(token));
}

function isTokenInAreaLevel(region, token) {
	const level = token.level ?? 0;
	if (region.includedInLevel && !region.includedInLevel(level)) return false;
	return true;
}

function getTokenDistanceWithElevation(originToken, targetToken) {
	const origin = normalizeToken(originToken)?.object;
	const target = normalizeToken(targetToken)?.object;
	if (typeof origin?.distanceTo !== "function" || !target) {
		if (!elevationDistanceWarningShown) {
			console.error(`${MODULE_ID} | Could not measure elevation-aware ${RULE_KEY} distance: the PF2e token distance API is unavailable`);
			elevationDistanceWarningShown = true;
		}
		return Infinity;
	}
	const distance = origin.distanceTo(target);
	return Number.isFinite(distance) ? distance : Infinity;
}

function getAreaTargets(region, sourceToken, primaryToken, placementToken, rule, maxDistance) {
	const source = normalizeToken(sourceToken);
	const primary = normalizeToken(primaryToken);
	const targets = [];
	for (const token of region.parent.tokens) {
		if (token.id === primary?.id) continue;
		if (token.id === source?.id && !rule.affectsSelf) continue;
		if (sameActor(token.actor, source?.actor) && token.id !== source?.id) continue;
		if (!token.actor?.attributes?.hp) continue;
		if (!isTokenCenterInArea(region, token)) continue;
		if (!isTokenInAreaLevel(region, token)) continue;
		if (getTokenDistanceWithElevation(placementToken, token) > maxDistance) continue;
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

function createDamageEffectIndicator(causes) {
	const indicator = document.createElement("span");
	indicator.classList.add("iwr", "vurs-damage-effect-indicator");
	indicator.dataset.visibility = "all";
	indicator.dataset.tooltipClass = "pf2e";
	const icon = document.createElement("i");
	icon.classList.add("fa-solid", "fa-circle-info", "small");
	indicator.append(icon);

	const tooltip = document.createElement("ul");
	for (const cause of causes) {
		const causeEntry = document.createElement("li");
		causeEntry.textContent = cause.label;
		tooltip.append(causeEntry);
		for (const modifier of cause.modifiers) {
			const modifierEntry = document.createElement("li");
			modifierEntry.textContent = modifier;
			tooltip.append(modifierEntry);
		}
	}
	indicator.dataset.tooltipHtml = tooltip.outerHTML;
	return indicator;
}

function getGroupedEntryEffects(entry) {
	return Array.isArray(entry.effects) ? entry.effects : [entry];
}

function getDamageEffectTargetKey(effect) {
	return effect.tokenId ?? effect.appliedDamage?.uuid ??
		effect.actorUuid ?? effect.actorId ?? effect.targetName;
}

function getDamageEffectCauses(effect) {
	if (Array.isArray(effect.sources)) {
		if (effect.fullHealth) {
			return effect.sources.map(source => ({
				label: `${source.label || effect.label || getEffectName(effect.type)}: Full HP`,
				modifiers: effect.modifiers ?? []
			}));
		}
		const isHealing = effect.appliedDamage?.isHealing || effect.type === "lifesteal";
		const amountKey = isHealing ? "healing" : "damage";
		return effect.sources.map(source => ({
			label: `${source.label || effect.label || getEffectName(effect.type)} ${
				isHealing ? "+" : "-"
			}${source[amountKey] ?? source.amount ?? 0}`,
			modifiers: effect.modifiers ?? []
		}));
	}
	return [{
		label: `${effect.label || getEffectName(effect.type)} ${
			effect.fullHealth
				? ": Full HP"
				: `${effect.appliedDamage?.isHealing || effect.type === "lifesteal" ? "+" : "-"}${effect.amount}`
		}`,
		modifiers: effect.modifiers ?? []
	}];
}

function groupDamageEffects(effects) {
	const grouped = new Map();
	for (const effect of effects) {
		const key = getDamageEffectTargetKey(effect);
		let entry = grouped.get(key);
		if (!entry) {
			entry = {
				actorUuid: effect.actorUuid,
				actorId: effect.actorId,
				tokenId: effect.tokenId,
				targetName: effect.targetName,
				hidden: Boolean(effect.hidden),
				effects: [],
				sourceIndexes: [],
				isReverted: false
			};
			grouped.set(key, entry);
		} else if (entry.hidden && !effect.hidden) {
			entry.targetName = effect.targetName;
		}
		entry.hidden &&= Boolean(effect.hidden);
		entry.effects.push(effect);
		if (Number.isInteger(effect.sourceIndex)) entry.sourceIndexes.push(effect.sourceIndex);
	}
	return [...grouped.values()];
}

function getVisibleGroupedDamageEntries(entries, primaryTokenId) {
	return entries
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => !(
			entry.tokenId === primaryTokenId &&
			getGroupedEntryEffects(entry).every(effect =>
				(effect.appliedDamage?.isHealing || effect.type === "lifesteal") &&
				!effect.fullHealth
			)
		))
		.filter(({ entry }) => getGroupedEntryEffects(entry).length > 0);
}

function renderGroupedDamageEffects(damageTaken, primaryTokenId, entries, primaryUndoButton, sceneId) {
	const visibleEntries = getVisibleGroupedDamageEntries(entries, primaryTokenId);
	const details = document.createElement("details");
	details.classList.add("vurs-damage-effects");
	const summary = document.createElement("summary");
	summary.textContent = `Affected creatures (${visibleEntries.length})`;
	details.append(summary);

	const list = document.createElement("ul");
	for (const { entry: groupedEntry, index } of visibleEntries) {
		const effects = getGroupedEntryEffects(groupedEntry);
		const activeEffects = effects.filter(effect => !effect.isReverted);
		const displayEffects = activeEffects.length ? activeEffects : effects;
		const damage = displayEffects.reduce((total, effect) =>
			total + (!effect.appliedDamage?.isHealing && effect.type !== "lifesteal"
				? Number(effect.amount) || 0
				: 0), 0);
		const healing = displayEffects.reduce((total, effect) =>
			total + (effect.appliedDamage?.isHealing || effect.type === "lifesteal"
				? Number(effect.amount) || 0
				: 0), 0);
		const causes = displayEffects.flatMap(getDamageEffectCauses);
		const amountParts = [];
		if (damage > 0) amountParts.push(`-${damage}`);
		if (healing > 0) amountParts.push(`+${healing}`);
		if (displayEffects.some(effect => effect.fullHealth)) amountParts.push("Full HP");
		const entry = document.createElement("li");
		const row = document.createElement("div");
		row.classList.add("vurs-damage-effect-row");
		const target = document.createElement("span");
		const tokenName = groupedEntry.tokenId
			? game.scenes?.get(sceneId)?.tokens.get(groupedEntry.tokenId)?.name
			: null;
		const targetName = tokenName ?? groupedEntry.targetName;
		if (groupedEntry.hidden) {
			target.textContent = "Hidden creature";
			const gmTarget = document.createElement("span");
			gmTarget.dataset.visibility = "gm";
			gmTarget.textContent = ` (${targetName})`;
			target.append(gmTarget);
		} else {
			target.textContent = targetName;
		}
		const effectLabel = document.createElement("span");
		effectLabel.classList.add("vurs-damage-effect-label");
		if (groupedEntry.isReverted) effectLabel.classList.add("reverted");
		effectLabel.append(target, document.createTextNode(
			` — ${amountParts.join(" / ") || "0"}`
		));
		row.append(effectLabel, createDamageEffectIndicator(causes));
		if (!groupedEntry.isReverted && activeEffects.some(effect => effect.appliedDamage)) {
			const undo = createDamageRevertButton();
			undo.dataset.vursUndoEntry = String(index);
			undo.dataset.visibility = groupedEntry.hidden ? "gm" : "owner";
			row.append(undo);
		}
		if (primaryUndoButton && effects.some(effect => effect.tokenId === primaryTokenId)) {
			row.append(primaryUndoButton);
		}
		entry.append(row);
		list.append(entry);
	}
	details.append(list);
	damageTaken.append(details);
}

function updateGroupedDamageTokenNames(message, html) {
	if (!foundry.utils.getProperty(message, `flags.${MODULE_ID}.damageEffects`)) return;
	const group = getGroupedDamageData(message);
	if (!group?.entries?.length) return;

	const list = html.querySelector(".vurs-damage-effects > ul");
	if (!list) return;
	const scene = game.scenes?.get(message.speaker?.scene);
	const entries = getVisibleGroupedDamageEntries(group.entries, group.primaryTokenId);
	for (const [index, listEntry] of [...list.children].entries()) {
		const groupedEntry = entries[index]?.entry;
		if (!groupedEntry?.tokenId) continue;
		const tokenName = scene?.tokens.get(groupedEntry.tokenId)?.name;
		if (!tokenName) continue;
		const target = listEntry.querySelector(".vurs-damage-effect-label")?.firstElementChild;
		if (!target) continue;
		if (groupedEntry.hidden) {
			const gmTarget = target.querySelector('[data-visibility="gm"]');
			if (gmTarget) gmTarget.textContent = ` (${tokenName})`;
		} else {
			target.textContent = tokenName;
		}
	}
}

function getOpenGroupedDamageDetails(message) {
	const messageElement = [...document.querySelectorAll(".message")]
		.find(element => element.dataset.messageId === message.id);
	return messageElement?.querySelector(".vurs-damage-effects")?.open ?? false;
}

function renderGroupedDamageSection(container, group, wasOpen, sceneId) {
	const damageTaken = container.querySelector(".damage-taken");
	if (!damageTaken) return null;
	const primaryStatement = damageTaken.querySelector(".statements");
	let primaryRow = damageTaken.querySelector(".vurs-primary-damage-row");
	if (!primaryRow && primaryStatement) {
		primaryRow = document.createElement("div");
		primaryRow.classList.add("vurs-primary-damage-row");
		primaryStatement.before(primaryRow);
		primaryRow.append(primaryStatement);
	}
	if (primaryStatement) {
		const isReverted = Boolean(group.primaryTargetReverted || group.primaryReverted);
		primaryStatement.classList.toggle("vurs-nested-damage-reverted", isReverted);
		primaryStatement.style.textDecorationLine = isReverted ? "line-through" : "";
	}
	let undoAll = damageTaken.querySelector(".revert-damage");
	if (!undoAll) undoAll = createDamageRevertButton();
	if (!group.isReverted) {
		undoAll.dataset.vursUndoGroup = "true";
		undoAll.dataset.visibility = group.entries.some(entry => entry.hidden) ? "gm" : "owner";
	} else {
		undoAll.remove();
		undoAll = null;
	}

	damageTaken.querySelector(".vurs-damage-effects")?.remove();
	renderGroupedDamageEffects(damageTaken, group.primaryTokenId, group.entries, undoAll, sceneId);
	const details = damageTaken.querySelector(".vurs-damage-effects");
	if (wasOpen) details?.setAttribute("open", "");
	if (undoAll && !undoAll.isConnected && primaryRow) primaryRow.append(undoAll);
	return damageTaken;
}

async function finalizeGroupedDamageCard(transaction) {
	if (!transaction.rootMessageId || !transaction.effects.length) return;
	const message = game.messages?.get(transaction.rootMessageId);
	if (!message) {
		console.error(`${MODULE_ID} | Could not find the primary damage card for grouped effects`);
		return;
	}
	const effects = transaction.effects.filter(effect =>
		(effect.appliedDamage || effect.fullHealth) &&
		!(effect.type === "lifesteal" && effect.amount <= 0 && !effect.fullHealth) &&
		!(effect.tokenId === transaction.rootTokenId && effect.appliedDamage?.isHealing)
	);
	if (!effects.length) return;

	const entries = groupDamageEffects(effects);
	const group = { entries, primaryTokenId: transaction.rootTokenId, isReverted: false };
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	const damageTaken = renderGroupedDamageSection(
		container,
		group,
		getOpenGroupedDamageDetails(message),
		message.speaker?.scene
	);
	if (!damageTaken) {
		console.error(`${MODULE_ID} | Could not group effects: the primary card has no damage-taken section`);
		return;
	}
	const nativeUndo = damageTaken.querySelector(".revert-damage");
	if (nativeUndo) {
		nativeUndo.dataset.vursUndoGroup = "true";
		if (entries.some(entry => entry.hidden)) nativeUndo.dataset.visibility = "gm";
	}

	await message.update({
		content: container.innerHTML,
		[`flags.${MODULE_ID}.damageEffects`]: {
			...group,
			entries: entries.map(entry => {
				const { sourceIndexes, ...stored } = foundry.utils.deepClone(entry);
				if (entry.hidden) stored.targetName = "Hidden creature";
				return stored;
			})
		}
	});
}

function getGroupedDamageData(message) {
	const group = foundry.utils.getProperty(message, `flags.${MODULE_ID}.damageEffects`);
	if (!group?.entries?.length) return group;
	if (group.entries.every(entry => Array.isArray(entry.effects))) return group;

	const effects = group.entries.flatMap((entry, sourceIndex) =>
		getGroupedEntryEffects(entry).map(effect => ({
			...effect,
			isReverted: Boolean(entry.isReverted || effect.isReverted),
			sourceIndex
		}))
	);
	const entries = groupDamageEffects(effects);
	for (const entry of entries) {
		entry.isReverted = entry.effects.every(effect => effect.isReverted);
	}
	return {
		...group,
		wasLegacy: true,
		primaryTokenId: group.primaryTokenId ?? message.speaker?.token,
		entries
	};
}

function getEffectDamageOperations(entry) {
	return getGroupedEntryEffects(entry)
		.filter(effect => !effect.isReverted && effect.appliedDamage)
		.map(effect => ({ record: effect.appliedDamage, effect }))
		.reverse();
}

function getUndoActor(record) {
	const actor = fromUuidSync(record?.uuid);
	if (!actor || typeof actor.undoDamage !== "function") {
		throw new Error(`Could not find the actor to undo damage for ${record?.uuid ?? "unknown actor"}`);
	}
	if (!game.user.isGM && !actor.isOwner) {
		throw new Error(`You do not have permission to undo damage for ${actor.name}`);
	}
	return actor;
}

async function undoDamageOperations(operations) {
	const byActor = new Map();
	for (const operation of operations) {
		const actor = getUndoActor(operation.record);
		const actorKey = actor.id ?? actor.uuid;
		const actorOperations = byActor.get(actorKey) ?? [];
		actorOperations.push({ ...operation, actor });
		byActor.set(actorKey, actorOperations);
	}

	const results = await Promise.all([...byActor.values()].map(async actorOperations => {
		for (const { actor, record, effect, primary } of actorOperations) {
			try {
				await actor.undoDamage(record);
				if (effect) effect.isReverted = true;
				if (primary) record.isReverted = true;
			} catch (error) {
				return error;
			}
		}
		return null;
	}));
	return results.find(Boolean) ?? null;
}

async function updateGroupedDamageState(
	message,
	group,
	{ primaryReverted = false, groupReverted = false } = {}
) {
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	if (primaryReverted) group.primaryReverted = true;
	if (groupReverted) group.isReverted = true;
	renderGroupedDamageSection(
		container,
		group,
		getOpenGroupedDamageDetails(message),
		message.speaker?.scene
	);
	const updates = {
		content: container.innerHTML,
		[`flags.${MODULE_ID}.damageEffects`]: (() => {
			const { wasLegacy, ...storedGroup } = group;
			return {
				...storedGroup,
				entries: group.entries.map(({ sourceIndexes, ...entry }) => entry)
			};
		})()
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
		const resolvedIndex = group.wasLegacy
			? group.entries.findIndex(entry => entry.sourceIndexes.includes(entryIndex))
			: entryIndex;
		const entry = group.entries[resolvedIndex];
		if (!entry || entry.isReverted) return;
		const error = await undoDamageOperations(getEffectDamageOperations(entry));
		entry.isReverted = getGroupedEntryEffects(entry).every(effect =>
			effect.isReverted || !effect.appliedDamage
		);
		group.primaryTargetReverted ||= entry.isReverted;
		await updateGroupedDamageState(message, group);
		if (error) throw error;
		return;
	}

	const primaryDamage = foundry.utils.getProperty(
		message,
		`flags.${game.system.id}.appliedDamage`
	);
	const operations = [
		...group.entries.slice().reverse().flatMap(getEffectDamageOperations),
		...(primaryDamage && !primaryDamage.isReverted
			? [{ record: primaryDamage, primary: true }]
			: [])
	];
	const unauthorizedOperation = operations.find(({ record }) => {
		const actor = fromUuidSync(record?.uuid);
		return !actor || typeof actor.undoDamage !== "function" ||
			(!game.user.isGM && !actor.isOwner);
	});
	if (unauthorizedOperation) {
		const actor = fromUuidSync(unauthorizedOperation.record?.uuid);
		ui.notifications.warn(`You do not have permission to undo all affected damage (${actor?.name ?? "an actor"}).`);
		return;
	}

	const error = await undoDamageOperations(operations);
	for (const entry of group.entries) {
		entry.isReverted = getGroupedEntryEffects(entry).every(effect =>
			effect.isReverted || !effect.appliedDamage
		);
	}
	group.isReverted = Boolean(primaryDamage?.isReverted) &&
		group.entries.every(entry => entry.isReverted);
	await updateGroupedDamageState(message, group, {
		primaryReverted: Boolean(primaryDamage?.isReverted),
		groupReverted: group.isReverted
	});
	if (error) throw error;
}

function installGroupedDamageUndo() {
	if (groupedDamageUndoInstalled) return;
	Hooks.on("renderChatMessageHTML", updateGroupedDamageTokenNames);
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

async function finalizeCollateralDamageApplications(transaction) {
	const applications = (transaction.collateralApplications ?? []).splice(0).flat();
	for (const application of applications) {
		const { actor, damageParams, effect, secret } = application;
		if (!queueDamageTransactionApplication(transaction.rootParams, {
			actor,
			damageParams,
			effect,
			secret,
			apply: (targetActor, params, rootParams, targetEffect) => {
				collateralDamageApplications.add(params);
				return applySecretDamageCard(targetActor, secret, () =>
					applyDamageInTransaction(targetActor, params, rootParams, targetEffect)
				).finally(() => collateralDamageApplications.delete(params));
			}
		})) {
			console.error(`${MODULE_ID} | Could not queue ${RULE_KEY} damage for ${application.targetName}`);
		}
	}
}

registerDamageTransactionFinalizer(finalizeCollateralDamageApplications, "prepare");
registerDamageTransactionFinalizer(finalizeGroupedDamageCard, "render");

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

function prepareCollateralDamageForTarget(
	target,
	amount,
	damageRollSource,
	damageType,
	sourceLabel,
	sourceParams,
	areaDamage
) {
	const damageRoll = createCollateralDamageRoll(amount, damageRollSource, damageType);
	if (!damageRoll) return null;
	if (typeof target.actor.applyDamage !== "function") {
		console.error(`${MODULE_ID} | Could not apply ${RULE_KEY} to ${target.name}: the Actor applyDamage method is unavailable`);
		return null;
	}

	const secret = target.hidden || target.object?.isVisible === false;
	const sourceRollOptions = sourceParams.rollOptions instanceof Set
		? sourceParams.rollOptions
		: Array.isArray(sourceParams.rollOptions) ? sourceParams.rollOptions : [];
	const rollOptions = new Set([
		...sourceRollOptions,
		...(target.actor.getSelfRollOptions?.() ?? [])
	]);
	rollOptions.delete("area-damage");
	rollOptions.delete("item:area-damage");
	if (areaDamage) rollOptions.add("area-damage");
	const modifiers = getDamageModifierBreakdown(
		damageRollSource,
		sourceParams.vursDamageModifiers
	);
	const damageParams = {
		damage: damageRoll,
		token: target.object ?? target,
		item: sourceParams.item,
		rollOptions,
		vursDamageModifiers: modifiers
	};
	const effect = {
		type: "collateral",
		label: sourceLabel,
		amount,
		targetName: target.name,
		hidden: secret,
		modifiers
	};
	return { actor: target.actor, damageParams, effect, secret, targetName: target.name };
}

async function applyPreparedCollateralDamage(application, sourceParams) {
	const { actor, damageParams, effect, secret, targetName } = application;
	try {
		const healthBefore = currentHealthPool(actor);
		collateralDamageApplications.add(damageParams);
		try {
			await applySecretDamageCard(actor, secret, () =>
				applyDamageInTransaction(actor, damageParams, sourceParams, effect)
			);
			const healthAfter = currentHealthPool(actor);
			if (healthBefore !== null && healthAfter !== null) {
				effect.amount = Math.max(0, healthBefore - healthAfter);
			}
		} finally {
			collateralDamageApplications.delete(damageParams);
		}
		return true;
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to apply ${RULE_KEY} to ${targetName}`, error);
		return false;
	}
}

async function applyPreparedCollateralDamageBatch(applications, sourceParams) {
	const byActor = new Map();
	for (const application of applications) {
		const key = application.actor.uuid;
		const actorApplications = byActor.get(key) ?? [];
		actorApplications.push(application);
		byActor.set(key, actorApplications);
	}
	await Promise.all([...byActor.values()].map(async actorApplications => {
		for (const application of actorApplications) {
			await runDamageTransactionActorOperation(sourceParams, application.actor, () =>
				applyPreparedCollateralDamage(application, sourceParams)
			);
		}
	}));
}

function prepareBounceDamage(rule, scene, sourceToken, primaryToken, maxDistance, amount, damageRoll, sourceParams) {
	const bounceShots = Number(rule.resolveValue(rule.bounceShots ?? 1, 1));
	const bounceCount = Number(rule.resolveValue(rule.bounceCount ?? 1, 1));
	const bounceLimit = Number(rule.bounceLimit ?? 1);
	if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: distance must resolve to a positive number`);
		return { paths: [], applications: [] };
	}
	if (
		!Number.isInteger(bounceShots) || bounceShots < 1 ||
		!Number.isInteger(bounceCount) || bounceCount < 0 ||
		!Number.isInteger(bounceLimit) || bounceLimit < 0
	) {
		console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: bounceShots must be a positive integer; bounceCount and bounceLimit must be non-negative integers`);
		return { paths: [], applications: [] };
	}

	const counts = new Map();
	if (bounceLimit > 0) counts.set(primaryToken.id, 1);
	const initialTargets = new Set();
	const paths = [];
	const applications = [];
	const sourceLabel = rule.item?.name ?? rule.label ?? RULE_KEY;
	for (let shot = 0; shot < bounceShots; shot++) {
		const path = [getTokenCenter(primaryToken)].filter(Boolean);
		let currentToken = primaryToken;
		for (let bounce = 0; bounce < bounceCount; bounce++) {
			let candidates = getBounceTargets(scene, sourceToken, currentToken, rule, maxDistance, counts, bounceLimit)
				.filter(token => bounce > 0 || !initialTargets.has(token.id));
			if (!candidates.length) break;
			let target;
			if (rule.bounceNearest ?? true) {
				candidates = candidates.sort((left, right) =>
					getTokenDistance(currentToken, left) - getTokenDistance(currentToken, right) ||
					left.id.localeCompare(right.id)
				);
				target = candidates[0];
			} else {
				target = candidates[Math.floor(Math.random() * candidates.length)];
			}
			const application = prepareCollateralDamageForTarget(
				target,
				amount,
				damageRoll,
				rule.damageType,
				sourceLabel,
				sourceParams,
				ruleCountsAsAreaDamage(rule)
			);
			if (!application) break;
			applications.push(application);
			if (bounce === 0) initialTargets.add(target.id);
			counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
			const center = getTokenCenter(target);
			if (center) path.push(center);
			currentToken = target;
		}
		if (path.length > 1) paths.push(path);
	}
	return { paths, applications };
}

function installSecretDamageCardHook() {
	if (secretDamageHookInstalled) return;
	Hooks.on("preCreateChatMessage", (message, data) => {
		if (foundry.utils.getProperty(data, "flags.pf2e.context.type") !== "damage-taken") return;
		const speaker = data.speaker;
		const appliedDamageUuid = foundry.utils.getProperty(data, "flags.pf2e.appliedDamage.uuid");
		const tokenId = speaker?.token ?? /\.Token\.([^.]+)\.Actor\./.exec(appliedDamageUuid ?? "")?.[1];
		const sceneId = speaker?.scene ?? /^Scene\.([^.]+)\.Token\./.exec(appliedDamageUuid ?? "")?.[1];
		const token = tokenId
			? game.scenes?.get(sceneId)?.tokens.get(tokenId) ?? canvas.scene?.tokens.get(tokenId)
			: null;
		if (token) {
			if (speaker) speaker.alias = token.name;
			if (typeof data.content === "string") {
				const template = document.createElement("template");
				template.innerHTML = data.content;
				const targetName = template.content.querySelector(
					".damage-taken .statements .target-name"
				);
				if (targetName) {
					targetName.textContent = token.name;
					data.content = template.innerHTML;
				}
			}
		}

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
	overlay.destroy();
	activeOverlays.delete(id);
}

function clearAllOverlays() {
	for (const id of activeOverlays.keys()) clearOverlay(id);
}

function addOverlayGraphics(graphics, destroyers) {
	destroyers.push(() => {
		graphics.parent?.removeChild(graphics);
		graphics.destroy();
	});
}

function queuePendingOverlay(data) {
	if (pendingOverlays.has(data.id)) return;
	const receivedAt = performance.now();
	const timeout = setTimeout(() => pendingOverlays.delete(data.id), data.durationMs);
	pendingOverlays.set(data.id, { data, receivedAt, timeout });
}

function drawPendingOverlays(sceneId) {
	for (const [id, pending] of pendingOverlays) {
		clearTimeout(pending.timeout);
		pendingOverlays.delete(id);
		if (pending.data.sceneId !== sceneId) continue;
		const remaining = pending.data.durationMs - (performance.now() - pending.receivedAt);
		if (remaining > 0) drawOverlay(pending.data, remaining);
	}
}

function drawOverlay({ id, sceneId, shapes, paths, durationMs, color }, remainingDuration = durationMs) {
	if ((canvas.scene && canvas.scene.id !== sceneId) || remainingDuration <= 0) return;
	if (!canvas.ready) {
		queuePendingOverlay({ id, sceneId, shapes, paths, durationMs: remainingDuration, color });
		return;
	}
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
	const duration = Math.min(OVERLAY_DURATION, remainingDuration);
	if (validShapes.length) {
		const region = getRegionForShapes(canvas.scene, validShapes);
		if (region) {
			const graphics = new PIXI.Graphics();
			graphics.eventMode = "none";
			if (canvas.grid.isGridless) {
				graphics.lineStyle({ width: Math.max(2, canvas.dimensions.uiScale * 2), color: colorValue, alpha: 0.9 });
				graphics.beginFill(colorValue, 0.18);
				for (const shape of region.shapes) shape.drawShape(graphics);
				graphics.endFill();
			} else {
				const bounds = region.polygonTree.bounds.clone().fit(canvas.dimensions.rect).pad(1);
				const [i0, j0, i1, j1] = canvas.grid.getOffsetRange(bounds);
				const dx = canvas.grid.sizeX / 2;
				const dy = canvas.grid.sizeY / 2;
				const cellShape = canvas.grid.getShape();
				graphics.beginFill(colorValue, 0.25);
				for (let i = i0; i < i1; i++) {
					for (let j = j0; j < j1; j++) {
						const offset = { i, j };
						const center = canvas.grid.getCenterPoint(offset);
						center.x = Math.round(center.x - dx) + dx;
						center.y = Math.round(center.y - dy) + dy;
						if (!isAreaPointHighlighted(region, center)) continue;
						graphics.drawPolygon(cellShape.map(point => ({
							x: center.x + point.x,
							y: center.y + point.y
						})));
					}
				}
				graphics.endFill();
			}
			canvas.interface.addChild(graphics);
			addOverlayGraphics(graphics, destroyers);
		}
	}
	if (validPaths.length) {
		const ticker = canvas.app?.ticker;
		for (const path of validPaths) {
			const graphics = new PIXI.Graphics();
			graphics.eventMode = "none";
			canvas.interface.addChild(graphics);
			const totalLength = path.slice(1).reduce((total, point, index) => {
				const previous = path[index];
				return total + Math.hypot(point.x - previous.x, point.y - previous.y);
			}, 0);
			const drawRemainingPath = removedLength => {
				graphics.clear();
				graphics.lineStyle({
					width: Math.max(3, canvas.dimensions.uiScale * 3),
					color: colorValue,
					alpha: 0.95
				});
				let remainingToRemove = removedLength;
				let started = false;
				for (let index = 1; index < path.length; index++) {
					const start = path[index - 1];
					const end = path[index];
					const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
					if (remainingToRemove >= segmentLength) {
						remainingToRemove -= segmentLength;
						continue;
					}
					const segmentStart = remainingToRemove > 0
						? {
							x: start.x + (end.x - start.x) * (remainingToRemove / segmentLength),
							y: start.y + (end.y - start.y) * (remainingToRemove / segmentLength)
						}
						: start;
					remainingToRemove = 0;
					if (!started) {
						graphics.moveTo(segmentStart.x, segmentStart.y);
						started = true;
					}
					graphics.lineTo(end.x, end.y);
				}
			};
			drawRemainingPath(0);

			let destroyed = false;
			let animate;
			const destroyPath = () => {
				if (destroyed) return;
				destroyed = true;
				if (animate && ticker) ticker.remove(animate);
				graphics.parent?.removeChild(graphics);
				graphics.destroy();
			};
			destroyers.push(destroyPath);
			if (ticker && duration > 0 && totalLength > 0) {
				const startTime = performance.now();
				animate = () => {
					const progress = Math.min(1, (performance.now() - startTime) / duration);
					drawRemainingPath(totalLength * progress);
				};
				ticker.add(animate);
			} else if (!ticker) {
				console.error(`${MODULE_ID} | Could not animate the ${RULE_KEY} bounce path: the canvas ticker is unavailable`);
			}
		}
	}
	if (!destroyers.length) return;

	const timeout = setTimeout(() => clearOverlay(id), duration);
	activeOverlays.set(id, {
		destroy: () => destroyers.forEach(destroy => destroy()),
		timeout
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
			!Number.isFinite(data.durationMs) ||
			data.durationMs <= 0 ||
			data.durationMs > OVERLAY_DURATION ||
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
		durationMs: OVERLAY_DURATION,
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
	const applications = [];
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

		const distance = resolveCollateralDistance(rule, params.item, damageDealer);
		if (distance === null) continue;

		if (rule.type === "bounce") {
			const bounce = prepareBounceDamage(
				rule, scene, sourceToken, targetToken, distance, amount, params.damage, params
			);
			paths.push(...bounce.paths);
			applications.push(...bounce.applications);
			if (slug) seenSlugs.add(slug);
			continue;
		}

		const geometries = getPlacementGeometries(rule.placement ?? "target", sourceToken, targetToken);
		if (!geometries?.length) {
			console.error(`${MODULE_ID} | Could not apply ${RULE_KEY}: source and target positions are unavailable`);
			continue;
		}
		const originToken = rule.placement === "self" ? sourceToken : targetToken;
		const shapeGeometries = rule.type === "emanation" ? geometries.slice(0, 1) : geometries;
		const areaShapes = shapeGeometries
			.map(geometry => getAreaShape(rule, geometry, originToken, distance))
			.filter(Boolean);
		if (!areaShapes.length) continue;
		const region = getRegionForShapes(scene, areaShapes);
		if (!region) continue;
		shapes.push(...areaShapes);
		if (slug) seenSlugs.add(slug);

		const targets = getAreaTargets(region, sourceToken, targetToken, originToken, rule, distance);
		if (!targets.length) continue;
		const amounts = rule.divided ? splitAmount(amount, targets.length) : targets.map(() => amount);
		const sourceLabel = rule.item?.name ?? rule.label ?? RULE_KEY;
		for (const [index, target] of targets.entries()) {
			if (amounts[index] <= 0) continue;
			const application = prepareCollateralDamageForTarget(
				target,
				amounts[index],
				params.damage,
				rule.damageType,
				sourceLabel,
				params,
				ruleCountsAsAreaDamage(rule)
			);
			if (application) applications.push(application);
		}
	}
	return { shapes, paths, applications };
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
		const { shapes, paths, applications } = await applyCollateralDamage(actor, params, damage, damageApplied);
		if (applications.length && !queueDamageTransactionRequest(
			params,
			"collateralApplications",
			applications
		)) {
			await applyPreparedCollateralDamageBatch(applications, params);
		}
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
Hooks.on("canvasReady", canvas => drawPendingOverlays(canvas.scene?.id));
Hooks.on("canvasTearDown", () => {
	clearAllOverlays();
	for (const { timeout } of pendingOverlays.values()) clearTimeout(timeout);
	pendingOverlays.clear();
});
