import {
	resolveRuleElementValue,
	testRuleElementPredicate
} from "./ruleElementResolvers.js";
import { localizeRuleElementFormText } from "./ruleElementFormLocalization.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Displacement";
const DISPLACEMENT_DIRECTIONS = ["push", "pull", "up", "down", "left", "right"];
const DISPLACEMENT_MOVEMENT_TYPE_FALLBACKS = {
	walk: "Walk",
	fly: "Fly",
	swim: "Swim",
	burrow: "Burrow",
	crawl: "Crawl",
	climb: "Climb",
	jump: "Jump",
	travel: "Travel",
	drive: "Drive",
	blink: "Blink",
	displace: "Displace"
};
const TOKEN_DISTANCE_PATTERN = /^@(self|target)$/i;
let DisplacementRuleElement = null;
let chatHookInstalled = false;
let displacementSocket = null;
// How many recent chat messages to scan when linking displacement records
// onto a damage-taken message.
const DISPLACEMENT_LINK_SCAN_LIMIT = 200;

function getDisplacementRuleSignature(rule) {
	return [
		rule.item?.uuid ?? "",
		rule.selector ?? "",
		rule.direction ?? "",
		rule.affects ?? "",
		rule.distance ?? "",
		rule.movementType ?? "",
		rule.antiAir ? "1" : ""
	].join("|");
}

function registerDisplacementLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has(`PF2E.RuleElement.${RULE_KEY}`)) return;
	foundry.utils.setProperty(translations, `PF2E.RuleElement.${RULE_KEY}`, RULE_KEY);
}

function registerDisplacementRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const registry = system?.RuleElements;
	const RuleElement = system?.RuleElement;
	const ResolvableValueField = registry?.builtin?.Resistance?.schema?.fields?.value?.constructor;
	if (!RuleElement || !registry?.custom || typeof ResolvableValueField !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: the system Rule Element API is unavailable`);
		return;
	}

	if (registry.custom[RULE_KEY]) {
		if (registry.custom[RULE_KEY] !== DisplacementRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	DisplacementRuleElement = class DisplacementRuleElement extends RuleElement {
		static autogenForms = true;

		resolveValue(value, fallback = 0, options = {}) {
			return resolveRuleElementValue(
				this,
				(value, fallbackValue, resolveOptions) =>
					super.resolveValue(value, fallbackValue, resolveOptions),
				value,
				fallback,
				options
			);
		}

		static defineSchema() {
			const fields = foundry.data.fields;
			return {
				...super.defineSchema(),
				selector: new fields.StringField({
					required: true,
					nullable: false,
					blank: false,
					label: localizeRuleElementFormText("Common.Selector", "Selector"),
					placeholder: "attack-roll"
				}),
				direction: new fields.StringField({
					required: true,
					nullable: false,
					initial: "push",
					label: localizeRuleElementFormText("Displacement.Direction", "Direction"),
					choices: Object.fromEntries(DISPLACEMENT_DIRECTIONS.map(direction => [
						direction,
						localizeRuleElementFormText(`Displacement.Directions.${direction}`, direction)
					]))
				}),
				affects: new fields.StringField({
					required: false,
					nullable: true,
					initial: null,
					label: localizeRuleElementFormText("Displacement.Affects", "Affects"),
					choices: {
						self: localizeRuleElementFormText("Displacement.AffectsTypes.Self", "Self"),
						target: localizeRuleElementFormText("Displacement.AffectsTypes.Target", "Target")
					},
					placeholder: localizeRuleElementFormText("Displacement.AffectsTypes.Target", "Target")
				}),
				distance: new ResolvableValueField({
					required: true,
					nullable: false,
					label: localizeRuleElementFormText("Displacement.Distance", "Distance"),
					placeholder: localizeRuleElementFormText(
						"Displacement.DistancePlaceholder",
						"@damage, @self, @target, or a value"
					)
				}),
				rounded: new fields.BooleanField({
					required: false,
					nullable: true,
					initial: true,
					label: localizeRuleElementFormText("Displacement.Rounded", "Round to Grid"),
					placeholder: localizeRuleElementFormText("Displacement.RoundedPlaceholder", "On")
				}),
				movementType: new fields.StringField({
					required: false,
					nullable: true,
					initial: null,
					label: localizeRuleElementFormText("Displacement.MovementType", "Movement Type"),
					// Lazy: PF2E registers travel/drive after our schema is
					// defined, so choices must resolve at render time.
					choices: () => getDisplacementMovementTypeChoices(),
					placeholder: localizeRuleElementFormText(
						"Displacement.MovementTypePlaceholder",
						"Travel"
					)
				}),
				antiAir: new fields.BooleanField({
					required: false,
					nullable: true,
					initial: false,
					label: localizeRuleElementFormText("Displacement.AntiAir", "Anti-Air"),
					placeholder: localizeRuleElementFormText("Displacement.AntiAirPlaceholder", "Off")
				}),
				outcome: new fields.SetField(
					new fields.StringField({
						required: true,
						choices: ["criticalFailure", "failure", "success", "criticalSuccess"]
					}),
					{
						initial: ["success", "criticalSuccess"],
						label: localizeRuleElementFormText("Displacement.Outcome", "Outcome")
					}
				)
			};
		}

		beforePrepareData() {
			if (this.ignored) return;
			if (!this.resolveInjectedProperties(this.selector)) {
				this.failValidation("selector is required");
				return;
			}
			if (!DISPLACEMENT_DIRECTIONS.includes(this.direction)) {
				this.failValidation("direction must be one of push, pull, up, down, left, right");
				return;
			}
			if (this.distance === null || this.distance === undefined || this.distance === "") {
				this.failValidation("distance is required");
			}
			if (this.movementType && !getDisplacementMovementTypeChoices()[this.movementType]) {
				this.failValidation("movementType must be a valid movement action");
			}
		}
	};

	registry.custom[RULE_KEY] = DisplacementRuleElement;
}

function normalizeDisplacementToken(token) {
	return token?.document ?? token ?? null;
}

function getDisplacementTokenCenter(token) {
	const document = normalizeDisplacementToken(token);
	if (!document) return null;
	const center = document.object?.getCenterPoint?.() ?? document.getCenterPoint?.();
	return center && { x: center.x, y: center.y };
}

function resolveDisplacementTokenDocument(value) {
	if (!value) return null;
	if (typeof value === "string") {
		try {
			return fromUuidSync(value) ?? canvas?.tokens?.get?.(value)?.document ?? null;
		} catch {
			return canvas?.tokens?.get?.(value)?.document ?? null;
		}
	}
	if (typeof value === "object") {
		if (value.document) return value.document;
		if (value.uuid) {
			try {
				return fromUuidSync(value.uuid) ?? null;
			} catch {
				return null;
			}
		}
		if (value.parent?.documentName === "Scene" && value.id) return value;
	}
	return null;
}

function getActorTokenDocument(actor, context) {
	const fromContext = resolveDisplacementTokenDocument(context?.origin?.token);
	if (fromContext?.actor?.uuid === actor?.uuid || fromContext?.actor === actor) {
		return fromContext;
	}
	// actor.token / getActiveTokens() can yield canvas Token objects rather
	// than documents — normalize so callers always get a TokenDocument.
	return resolveDisplacementTokenDocument(actor?.token)
		?? resolveDisplacementTokenDocument(actor?.getActiveTokens?.()?.[0])
		?? null;
}

function getDisplacementRules(message) {
	const system = game.system.id;
	const origin = message?.flags?.[system]?.origin;
	const itemUuid = origin?.uuid;
	const actorUuid = origin?.actor;
	if (!itemUuid && !actorUuid) return { rules: [], actor: null };

	let actor = null;
	if (actorUuid) {
		try {
			actor = fromUuidSync(actorUuid) ?? null;
		} catch {
			actor = null;
		}
	}
	let item = null;
	if (itemUuid) {
		try {
			item = fromUuidSync(itemUuid) ?? null;
		} catch {
			item = null;
		}
	}

	// PF2e rule elements apply by selector/predicate, not item identity: a
	// Displacement rule on any of the actor's items (feat, style, weapon)
	// fires on every matching roll. actor.rules already aggregates item
	// rules, but item.rules is kept as a fallback; dedupe on a content
	// signature since the two collections can hold distinct instances.
	const rules = [];
	const seen = new Set();
	for (const rule of [...(actor?.rules ?? []), ...(item?.rules ?? [])]) {
		if (rule?.key !== RULE_KEY || rule.ignored) continue;
		const signature = getDisplacementRuleSignature(rule);
		if (seen.has(signature)) continue;
		seen.add(signature);
		rules.push(rule);
	}
	return { rules, actor };
}

function getDisplacementSelectorSet(context) {
	const selectors = new Set();
	if (context?.type) selectors.add(context.type);
	for (const domain of context?.domains ?? []) {
		if (domain) selectors.add(domain);
	}
	for (const option of context?.options ?? []) {
		if (option) selectors.add(option);
	}
	return selectors;
}

function getMessageDamageTotal(message) {
	let total = 0;
	for (const roll of message?.rolls ?? []) {
		if (!Array.isArray(roll?.instances)) continue;
		total += Number(roll.total) || 0;
	}
	return total;
}

// Resolves the distance value: plain numbers, @-formulas (including @damage),
// and an optional resolve(...) wrapper — evaluated against the rule actor's
// roll data plus `damage` (the total damage rolled by the triggering message).
function resolveDisplacementDistance(rule, damageTotal) {
	const raw = rule.distance;
	if (typeof raw === "number") return raw;
	let text = rule.resolveInjectedProperties?.(raw) ?? raw;
	if (typeof text !== "string") return Number(text);
	text = text.trim();
	const wrapped = /^resolve\(([\s\S]+)\)$/.exec(text);
	const expression = wrapped ? wrapped[1] : text;
	const rollData = {
		...(rule.actor?.getRollData?.() ?? {}),
		item: rule.item,
		parent: rule.item?.parent?.toObject?.(),
		origin: rule.actor ?? null,
		damage: damageTotal
	};
	try {
		return Number(Roll.safeEval(Roll.replaceFormulaData(expression, rollData)));
	} catch {
		return Number.NaN;
	}
}

function getTokenFootprint(document) {
	return {
		x: document.x,
		y: document.y,
		w: document.width * canvas.grid.sizeX,
		h: document.height * canvas.grid.sizeY
	};
}

function footprintsOverlap(a, b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Finds the grid square nearest to the displaced token that sits directly
// adjacent to the reference token's footprint and isn't occupied by another
// token on the same level/elevation. Returns pixel top-left coordinates plus
// the reference's elevation/level for the destination waypoint.
function findNearestFreeSpace(referenceDocument, displacedDocument) {
	const sizeX = canvas.grid?.sizeX;
	const sizeY = canvas.grid?.sizeY;
	if (!sizeX || !sizeY || !referenceDocument || !displacedDocument) return null;
	const reference = getTokenFootprint(referenceDocument);
	const displacedCenter = getDisplacementTokenCenter(displacedDocument);
	if (!displacedCenter) return null;

	// Adjacent space must be on the reference's level at its elevation —
	// tokens on other levels or heights don't collide with the destination.
	const destinationLevelId = getTokenLevelId(referenceDocument) ?? undefined;
	const destinationElevation = Number(referenceDocument.elevation) || 0;
	const sceneTokens = [...(canvas.scene?.tokens ?? [])];
	const minCol = Math.floor((reference.x - sizeX) / sizeX);
	const maxCol = Math.floor((reference.x + reference.w) / sizeX);
	const minRow = Math.floor((reference.y - sizeY) / sizeY);
	const maxRow = Math.floor((reference.y + reference.h) / sizeY);

	let best = null;
	let bestDistance = Infinity;
	for (let col = minCol; col <= maxCol; col++) {
		for (let row = minRow; row <= maxRow; row++) {
			const square = { x: col * sizeX, y: row * sizeY, w: sizeX, h: sizeY };
			if (footprintsOverlap(square, reference)) continue;
			let occupied = false;
			for (const token of sceneTokens) {
				if (token.id === displacedDocument.id) continue;
				if (getTokenLevelId(token) !== destinationLevelId) continue;
				if (Math.abs((Number(token.elevation) || 0) - destinationElevation) > 0.001) continue;
				if (footprintsOverlap(square, getTokenFootprint(token))) {
					occupied = true;
					break;
				}
			}
			if (occupied) continue;
			const centerX = square.x + sizeX / 2;
			const centerY = square.y + sizeY / 2;
			const distance = Math.hypot(centerX - displacedCenter.x, centerY - displacedCenter.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = {
					x: square.x,
					y: square.y,
					centerX,
					centerY,
					elevation: destinationElevation,
					level: destinationLevelId
				};
			}
		}
	}
	return best;
}

async function moveTokenToFreeSpace(tokenDocument, referenceDocument, movementType = null) {
	if (!tokenDocument || !referenceDocument) return;
	if (typeof tokenDocument.move !== "function") {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: ${tokenDocument?.name ?? "?"} is not a token document — cannot move`);
		return;
	}
	const space = findNearestFreeSpace(referenceDocument, tokenDocument);
	if (!space) {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: no free space adjacent to ${referenceDocument.name}`);
		return;
	}
	const halfWidth = (tokenDocument.width * canvas.grid.sizeX) / 2;
	const halfHeight = (tokenDocument.height * canvas.grid.sizeY) / 2;
	const originWaypoint = {
		x: tokenDocument.x,
		y: tokenDocument.y,
		elevation: tokenDocument.elevation ?? 0,
		level: getTokenLevelId(tokenDocument) ?? undefined,
		action: getDisplacementMovementAction(tokenDocument, movementType),
		explicit: true
	};
	const destination = {
		x: space.centerX - halfWidth,
		y: space.centerY - halfHeight,
		elevation: space.elevation,
		action: getDisplacementMovementAction(tokenDocument, movementType),
		explicit: true
	};
	// Crossing onto the reference's Scene Level requires the destination
	// waypoint to name it, same as the vertical up/down path.
	if (space.level && space.level !== getTokenLevelId(tokenDocument)) {
		destination.level = space.level;
	}
	const movePromise = tokenDocument.move([originWaypoint, destination], {
		method: "dragging",
		showRuler: true,
		constrainOptions: { ignoreCost: true },
		animation: displacementAnimationOptions(getGridUnitsPerSquare() ?? 5)
	});
	scheduleDisplacementRuler(tokenDocument, originWaypoint, destination, movementType);
	const moved = await movePromise;
	logDisplacementMovement(tokenDocument, moved, "adjacency");
}

function logDisplacementMovement(tokenDocument, result, tag) {
	const mv = tokenDocument?.movement;
	console.log(`${MODULE_ID} | ${RULE_KEY}: ${tag} moved=${result} method=${mv?.method} showRuler=${mv?.showRuler} state=${mv?.state} animDur=${mv?.updateOptions?.animation?.duration}`);
}

// The built-in movement ruler doesn't render a path for programmatic
// single-destination moves, so drive the token's TokenRuler directly with an
// explicit [origin, destination] pair. Scheduled after Foundry's own ruler
// refresh (next frame) but while the movement animation is still running —
// #showRuler keeps the ruler visible for the animation's duration.
function scheduleDisplacementRuler(tokenDocument, origin, destination, movementType = null, delay = 120) {
	setTimeout(() => {
		try {
			// Bail if the movement already finished or never carried a ruler —
			// otherwise we'd leave a phantom line behind on a failed move.
			const movement = tokenDocument.movement;
			if (!movement?.showRuler || ["completed", "stopped"].includes(movement.state)) return;
			const tokenObject = tokenDocument.object;
			const ruler = tokenObject?.ruler;
			if (!ruler || typeof ruler.refresh !== "function") return;
			const waypoint = pos => ({
				x: pos.x,
				y: pos.y,
				elevation: pos.elevation ?? 0,
				width: tokenDocument.width,
				height: tokenDocument.height,
				depth: tokenDocument.depth ?? 1,
				shape: tokenDocument.shape ?? 0,
				level: pos.level ?? getTokenLevelId(tokenDocument) ?? undefined,
				action: getDisplacementMovementAction(tokenDocument, movementType),
				explicit: true,
				checkpoint: false,
				snapped: false,
				intermediate: false,
				cost: 0
			});
			ruler.refresh({
				passedWaypoints: [waypoint(origin), waypoint(destination)],
				pendingWaypoints: [],
				plannedMovement: {}
			});
		} catch (error) {
			console.warn(`${MODULE_ID} | ${RULE_KEY}: could not draw displacement ruler`, error);
		}
	}, delay);
}

// The movement ruler only renders while the movement animation plays, and a
// short displacement would finish in a few frames — enforce a minimum
// duration so the measured path is actually visible, while long moves keep
// drag-like speed (capped so huge displacements don't drag on forever).
function displacementAnimationOptions(distanceUnits) {
	const unitsPerSquare = getGridUnitsPerSquare() ?? 5;
	const speed = CONFIG?.Token?.movement?.defaultSpeed || 6;
	const seconds = Math.max(0.8, (distanceUnits / unitsPerSquare) / speed);
	return { duration: Math.min(Math.round(seconds * 1000), 3000) };
}

// Returns the measurement units per grid square, or null on gridless scenes.
function getGridUnitsPerSquare() {
	const grid = canvas.grid;
	if (!grid || grid.type === "gridless") return null;
	const units = Number(grid.distance);
	return Number.isFinite(units) && units > 0 ? units : null;
}

function axisFromCenters(sourceCenter, targetCenter) {
	if (!sourceCenter || !targetCenter) return null;
	const x = targetCenter.x - sourceCenter.x;
	const y = targetCenter.y - sourceCenter.y;
	const length = Math.hypot(x, y);
	if (length === 0) return { x: 1, y: 0 };
	return { x: x / length, y: y / length };
}

function displacementDirectionVector(direction, axis) {
	switch (direction) {
		case "push": return { x: axis.x, y: axis.y };
		case "pull": return { x: -axis.x, y: -axis.y };
		case "right": return { x: axis.y, y: -axis.x };
		case "left": return { x: -axis.y, y: axis.x };
		default: return null;
	}
}

function snapshotDisplacementToken(tokenDocument) {
	if (!tokenDocument?.uuid) return null;
	return {
		token: tokenDocument.uuid,
		actor: tokenDocument.actor?.uuid ?? null,
		x: tokenDocument.x,
		y: tokenDocument.y,
		elevation: tokenDocument.elevation ?? 0,
		level: tokenDocument._source?.level ?? tokenDocument.level ?? null
	};
}

// Stamp the pre-move position on the token so damage-time geometry (collateral
// areas, burst fire via getTokenCenter) resolves where the token was when it
// was hit — not the animated mid-flight or post-move position. Expires after
// 60s in collateralGeometry.js.
async function stampDisplacementOrigin(tokenDocument, snapshot) {
	if (!tokenDocument || !snapshot) return;
	try {
		await tokenDocument.setFlag("vurs", "displacementOrigin", {
			x: snapshot.x,
			y: snapshot.y,
			elevation: snapshot.elevation,
			level: snapshot.level ?? null,
			at: Date.now()
		});
		console.log(`${MODULE_ID} | ${RULE_KEY}: stamped pre-move origin on ${tokenDocument.name} (${snapshot.x}, ${snapshot.y})`);
	} catch (error) {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: could not stamp displacement origin on ${tokenDocument.name}`, error);
	}
}

// Scenes have embedded Level documents, each owning an elevation range
// [bottom, top). A movement waypoint must carry the level containing the
// target elevation or the pipeline constrains the move to nothing.
function getLevelForElevation(tokenDocument, elevation) {
	const levels = tokenDocument?.parent?.levels?.contents
		?? tokenDocument?.parent?.levels
		?? [];
	const list = Array.isArray(levels) ? levels : [...levels];
	if (!list.length) return null;
	for (const level of list) {
		const { bottom, top } = level.elevation ?? {};
		if ((bottom === undefined || elevation >= bottom)
			&& (top === undefined || elevation < top)) return level;
	}
	// No level contains it — fall back to the nearest level base.
	let best = null;
	let bestDistance = Infinity;
	for (const level of list) {
		const base = level.elevation?.base ?? level.elevation?.bottom ?? 0;
		const distance = Math.abs(elevation - base);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = level;
		}
	}
	return best;
}

function getTokenLevelId(tokenDocument) {
	const level = tokenDocument?._source?.level ?? tokenDocument?.level;
	return typeof level === "string" ? level : level?.id ?? null;
}

// Lowest elevation bottom across the scene's levels — the floor displacement
// may descend to. Basement levels with negative elevation ranges are honored;
// scenes without finite level bounds keep the classic ground clamp at 0.
function getSceneElevationFloor(tokenDocument) {
	const levels = tokenDocument?.parent?.levels?.contents
		?? tokenDocument?.parent?.levels
		?? [];
	const list = Array.isArray(levels) ? levels : [...levels];
	let floor = null;
	for (const level of list) {
		const bottom = level.elevation?.bottom;
		if (typeof bottom === "number" && Number.isFinite(bottom)) {
			floor = floor === null ? bottom : Math.min(floor, bottom);
		}
	}
	return floor ?? 0;
}

// Highest elevation top across the scene's levels — the ceiling "up"
// displacement may reach. If any level extends upward without bound the
// ceiling is Infinity (no clamp); scenes without level data are unclamped.
function getSceneElevationCeiling(tokenDocument) {
	const levels = tokenDocument?.parent?.levels?.contents
		?? tokenDocument?.parent?.levels
		?? [];
	const list = Array.isArray(levels) ? levels : [...levels];
	let ceiling = -Infinity;
	for (const level of list) {
		const top = level.elevation?.top;
		if (top === undefined || top === null || !Number.isFinite(top)) return Infinity;
		ceiling = Math.max(ceiling, top);
	}
	return list.length ? ceiling : Infinity;
}

// The rule's movementType picks any registered movement action; when omitted
// it defaults to "travel" (PF2E's overland movement mode), falling back to
// the token's configured movement action, then "walk".
function getDisplacementMovementAction(tokenDocument, movementType) {
	const actions = CONFIG?.Token?.movement?.actions ?? {};
	if (movementType && actions[movementType]) return movementType;
	if (actions.travel) return "travel";
	const action = tokenDocument?.movementAction;
	return action && actions[action] ? action : "walk";
}

// Movement types come from Foundry's Token movement actions (walk, fly,
// swim, burrow, crawl, climb, jump, plus PF2E's travel/drive and the
// teleport utilities blink/displace) — every registered action is offered.
function getDisplacementMovementTypeChoices() {
	const actions = CONFIG?.Token?.movement?.actions ?? {};
	return Object.fromEntries(
		Object.entries(actions)
			.filter(([, action]) => action)
			.sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
			.map(([key, action]) => {
				const localized = game.i18n?.localize(action.label) ?? action.label;
				const label = localized && localized !== action.label
					? localized
					: (DISPLACEMENT_MOVEMENT_TYPE_FALLBACKS[key] ?? key);
				return [key, label];
			})
	);
}

async function moveDisplacedToken(tokenDocument, direction, distance, sourceDocument, movementType = null) {
	if (!tokenDocument) return;
	if (typeof tokenDocument.move !== "function") {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: ${tokenDocument?.name ?? "?"} is not a token document — cannot move`);
		return;
	}
	// `distance` is in the scene's measurement units (e.g. feet); elevation is
	// stored in those same units, so up/down need no conversion.
	if (direction === "up" || direction === "down") {
		const current = Number(tokenDocument.elevation) || 0;
		// Down stops at the deepest level floor and up at the highest level
		// ceiling (basements included); unclamped when levels are unbounded.
		const next = direction === "up"
			? Math.min(getSceneElevationCeiling(tokenDocument), current + distance)
			: Math.max(getSceneElevationFloor(tokenDocument), current - distance);
		if (next === current) return;
		// Route through move() so the launch animates with a ruler like a
		// manual drag. The waypoint must carry the scene Level containing the
		// target elevation — without it the movement pipeline constrains the
		// move to nothing and we fall back to an instant update.
		const targetLevel = getLevelForElevation(tokenDocument, next);
		const targetLevelId = targetLevel?.id ?? null;
		const currentLevelId = getTokenLevelId(tokenDocument);
		const levelChanged = !!targetLevelId && targetLevelId !== currentLevelId;
		const waypoint = {
			x: tokenDocument.x,
			y: tokenDocument.y,
			elevation: next,
			action: getDisplacementMovementAction(tokenDocument, movementType),
			explicit: true
		};
		if (levelChanged) waypoint.level = targetLevelId;
		// Submit [origin, destination] so the movement ruler has a real
		// segment to draw — a lone destination waypoint produces no ray.
		const originWaypoint = {
			x: tokenDocument.x,
			y: tokenDocument.y,
			elevation: tokenDocument.elevation ?? 0,
			level: currentLevelId ?? undefined,
			action: getDisplacementMovementAction(tokenDocument, movementType),
			explicit: true
		};
		let moved = false;
		try {
			const movePromise = tokenDocument.move([originWaypoint, waypoint], {
				method: "dragging",
				showRuler: true,
				constrainOptions: { ignoreWalls: true, ignoreCost: true },
				animation: displacementAnimationOptions(distance)
			});
			scheduleDisplacementRuler(tokenDocument, originWaypoint, waypoint, movementType);
			moved = await movePromise;
		} catch (error) {
			console.warn(`${MODULE_ID} | ${RULE_KEY}: animated elevation move failed for ${tokenDocument.name}`, error);
		}
		logDisplacementMovement(tokenDocument, moved, "elevation");
		if (!moved) {
			await tokenDocument.update({
				elevation: next,
				...(levelChanged ? { level: targetLevelId } : {})
			});
		}
		return;
	}

	const axis = axisFromCenters(
		getDisplacementTokenCenter(sourceDocument),
		getDisplacementTokenCenter(tokenDocument)
	);
	const vector = axis && displacementDirectionVector(direction, axis);
	if (!vector) {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: no reference token for "${direction}" displacement of ${tokenDocument.name}`);
		return;
	}
	// distancePixels is pixels-per-distance-unit — the conversion Foundry
	// itself uses for elevation and area radii.
	const pixelsPerUnit = canvas.dimensions?.distancePixels;
	if (!pixelsPerUnit) return;
	const offset = distance * pixelsPerUnit;
	const destination = {
		x: tokenDocument.x + vector.x * offset,
		y: tokenDocument.y + vector.y * offset,
		action: getDisplacementMovementAction(tokenDocument, movementType),
		explicit: true
	};
	// Pulling toward the source should also close the vertical gap — match
	// the source's elevation (and Scene Level when it changes) so the mover
	// actually reaches an elevated opponent instead of sliding underneath.
	if (direction === "pull" && sourceDocument) {
		const sourceElevation = Number(sourceDocument.elevation) || 0;
		if (sourceElevation !== (Number(tokenDocument.elevation) || 0)) {
			destination.elevation = sourceElevation;
			const destinationLevelId = getLevelForElevation(tokenDocument, sourceElevation)?.id
				?? getTokenLevelId(sourceDocument);
			if (destinationLevelId && destinationLevelId !== getTokenLevelId(tokenDocument)) {
				destination.level = destinationLevelId;
			}
		}
	}
	const originWaypoint = {
		x: tokenDocument.x,
		y: tokenDocument.y,
		elevation: tokenDocument.elevation ?? 0,
		level: getTokenLevelId(tokenDocument) ?? undefined,
		action: getDisplacementMovementAction(tokenDocument, movementType),
		explicit: true
	};
	const movePromise = tokenDocument.move([originWaypoint, destination], {
		method: "dragging",
		showRuler: true,
		constrainOptions: { maxDistance: offset, ignoreCost: true },
		animation: displacementAnimationOptions(distance)
	});
	scheduleDisplacementRuler(tokenDocument, originWaypoint, destination, movementType);
	const moved = await movePromise;
	logDisplacementMovement(tokenDocument, moved, "horizontal");
}

// Displacement moves tokens the attacker may not control (enemy NPCs), so a
// non-GM author relays the message to the GM via SocketLib — the same pattern
// collateralDamage/npcConfiguration use. GM authors (or worlds without
// SocketLib) execute locally.
async function applyDisplacementRules(message) {
	// Foundry V13+ ChatMessage stores the author in `author` — a foreign
	// document reference that may resolve to a User document, not a bare id.
	// Check both fields and normalize object forms for older versions too.
	const author = message?.author ?? message?.userId;
	const authorId = typeof author === "string" ? author : (author?.id ?? author?._id ?? null);
	const isAuthor = author === game.user
		|| authorId === game.user.id
		|| author?.uuid === game.user.uuid
		|| authorId === game.user.uuid;
	if (!isAuthor) return;
	const { rules } = getDisplacementRules(message);
	if (!rules.length) return;
	if (!game.user.isGM && displacementSocket) {
		console.log(`${MODULE_ID} | ${RULE_KEY}: relaying message ${message.id} (${rules.length} rule(s)) to GM`);
		displacementSocket.executeAsGM("executeDisplacement", { messageId: message.id });
		return;
	}
	console.log(`${MODULE_ID} | ${RULE_KEY}: executing locally for message ${message.id} (${rules.length} rule(s), isGM=${game.user.isGM}, socket=${!!displacementSocket})`);
	await executeDisplacementForMessage(message);
}

async function executeDisplacementAsGM({ messageId } = {}) {
	const message = game.messages?.get?.(messageId);
	if (!message || !game.user.isGM) {
		console.log(`${MODULE_ID} | ${RULE_KEY}: GM relay dropped (messageId=${messageId}, isGM=${game.user.isGM})`);
		return;
	}
	console.log(`${MODULE_ID} | ${RULE_KEY}: GM relay received for message ${messageId}`);
	await executeDisplacementForMessage(message);
}

async function executeDisplacementForMessage(message) {
	const { rules, actor } = getDisplacementRules(message);
	if (!rules.length) return;

	const context = message.flags?.[game.system.id]?.context ?? {};
	const selectorSet = getDisplacementSelectorSet(context);
	const rollOptions = new Set(Array.isArray(context.options) ? context.options : []);
	const contextOutcome = context.outcome ?? context.unadjustedOutcome ?? null;
	const selfToken = actor ? getActorTokenDocument(actor, context) : null;
	// The attacked target is stored on the message ({actor, token} uuids in
	// flags.pf2e.target / context.target) — game.user.targets is per-user and
	// empty on the GM client that executes relayed displacements.
	const messageTargetDocument = resolveDisplacementTokenDocument(
		context?.target?.token ?? message?.flags?.[game.system.id]?.target?.token
	) ?? [...(game.user.targets ?? [])][0]?.document ?? null;
	const opponentDocument = messageTargetDocument;
	const damageTotal = getMessageDamageTotal(message);
	console.log(`${MODULE_ID} | ${RULE_KEY}: outcome=${contextOutcome ?? "none"}, self=${selfToken?.name ?? "none"}, target=${messageTargetDocument?.name ?? "none"}`);

	// Positions captured before each move so a later damage undo can restore
	// them — persisted on the message under flags.vurs.displacement.
	const applied = [];

	for (const rule of rules) {
		const selector = rule.resolveInjectedProperties?.(rule.selector) ?? rule.selector;
		if (!selector || !selectorSet.has(selector)) {
			console.log(`${MODULE_ID} | ${RULE_KEY}: skipped "${rule.item?.name ?? "?"}" — selector "${selector}" not in roll domains`);
			continue;
		}
		if (!testRuleElementPredicate(rule, rollOptions)) {
			console.log(`${MODULE_ID} | ${RULE_KEY}: skipped "${rule.item?.name ?? "?"}" — predicate failed (options: ${[...rollOptions].join(", ") || "none"})`);
			continue;
		}
		const outcomes = rule.outcome?.size ? [...rule.outcome] : [];
		if (contextOutcome && outcomes.length && !outcomes.includes(contextOutcome)) {
			console.log(`${MODULE_ID} | ${RULE_KEY}: skipped "${rule.item?.name ?? "?"}" — outcome ${contextOutcome} not in [${outcomes}]`);
			continue;
		}
		console.log(`${MODULE_ID} | ${RULE_KEY}: applying "${rule.item?.name ?? "?"}" direction=${rule.direction} distance=${rule.distance} affects=${rule.affects ?? "target"} antiAir=${rule.antiAir === true}`);

		// Anti-Air overrides direction/distance entirely: the affected token
		// drops straight down a fixed 600 units. @self/@target adjacency and
		// distance resolution are skipped — the fall is unconditional.
		const antiAir = rule.antiAir === true;
		const direction = antiAir ? "down" : rule.direction;
		const affectsSelf = (rule.affects ?? "target") === "self";
		const tokenMatch = antiAir ? null
			: typeof rule.distance === "string"
				? TOKEN_DISTANCE_PATTERN.exec(rule.distance.trim())
				: null;

		try {
			if (tokenMatch) {
				// @self / @target: move the affected token(s) to the nearest
				// unoccupied space adjacent to the referenced token.
				const reference = tokenMatch[1].toLowerCase() === "self" ? selfToken : opponentDocument;
				if (!reference) continue;
				const mover = affectsSelf ? selfToken : messageTargetDocument;
				const snapshot = mover ? snapshotDisplacementToken(mover) : null;
				await stampDisplacementOrigin(mover, snapshot);
				if (affectsSelf) {
					if (selfToken) await moveTokenToFreeSpace(selfToken, reference, rule.movementType);
				} else if (messageTargetDocument?.actor) {
					await moveTokenToFreeSpace(messageTargetDocument, reference, rule.movementType);
				}
				if (snapshot) applied.push(snapshot);
				continue;
			}

			let distance = antiAir ? 600 : resolveDisplacementDistance(rule, damageTotal);
			if (!Number.isFinite(distance) || distance <= 0) {
				console.log(`${MODULE_ID} | ${RULE_KEY}: skipped "${rule.item?.name ?? "?"}" — distance "${rule.distance}" resolved to ${distance} (damageTotal=${damageTotal})`);
				continue;
			}
			// "Round to Grid" floors the distance to whole grid squares
			// (multiples of the grid's units-per-square measurement).
			const unitsPerSquare = !antiAir && rule.rounded !== false ? getGridUnitsPerSquare() : null;
			if (unitsPerSquare) {
				distance = Math.floor(distance / unitsPerSquare) * unitsPerSquare;
				if (distance <= 0) continue;
			}
			const mover = affectsSelf ? selfToken : messageTargetDocument;
			if (affectsSelf ? !selfToken : !messageTargetDocument?.actor) continue;
			const snapshot = snapshotDisplacementToken(mover);
			await stampDisplacementOrigin(mover, snapshot);
			if (affectsSelf) {
				await moveDisplacedToken(selfToken, direction, distance, opponentDocument, rule.movementType);
			} else {
				await moveDisplacedToken(messageTargetDocument, direction, distance, selfToken, rule.movementType);
			}
			if (snapshot) applied.push(snapshot);
		} catch (error) {
			console.warn(`${MODULE_ID} | ${RULE_KEY} failed for ${rule.item?.name ?? "unknown item"}`, error);
		}
	}

	if (applied.length) {
		try {
			await message.update({ "flags.vurs.displacement": applied });
		} catch (error) {
			console.warn(`${MODULE_ID} | ${RULE_KEY}: could not record displacement on message ${message.id}`, error);
		}
	}
}

// When PF2E applies damage it creates a "damage-taken" message whose
// flags.pf2e.appliedDamage is the undo handle — a different message than the
// damage-roll message displacement ran on. Scan recent messages for stored
// displacement records, match by roll-option overlap (plus the damaged actor
// when known), copy the best match onto the damage-taken message, and clear
// the source so it can't be linked twice. Stateless, so it works on whichever
// client creates the damage-taken message.
async function maybeLinkDisplacementToDamageMessage(message) {
	const appliedDamage = message?.flags?.pf2e?.appliedDamage;
	if (!appliedDamage?.uuid) return;

	const messageOptions = new Set(
		Array.isArray(message?.flags?.pf2e?.context?.options)
			? message.flags.pf2e.context.options
			: []
	);
	const damagedActorUuid = appliedDamage.uuid;

	const candidates = [];
	const messages = game.messages?.contents ?? [];
	for (let i = messages.length - 1; i >= 0 && candidates.length < DISPLACEMENT_LINK_SCAN_LIMIT; i--) {
		const candidate = messages[i];
		if (candidate.id === message.id) continue;
		const records = candidate.flags?.vurs?.displacement;
		if (!Array.isArray(records) || !records.length) continue;
		candidates.push(candidate);
	}
	if (!candidates.length) return;

	let best = null;
	let bestScore = -1;
	for (const candidate of candidates) {
		const records = candidate.flags.vurs.displacement;
		const candidateOptions = new Set(
			Array.isArray(candidate.flags?.[game.system.id]?.context?.options)
				? candidate.flags[game.system.id].context.options
				: []
		);
		let score = 0;
		for (const option of candidateOptions) {
			if (messageOptions.has(option)) score++;
		}
		if (records.some(r => r.actor === damagedActorUuid)) score += 1000;
		// Prefer the most recent candidate on ties.
		score += Number(candidate.timestamp ?? 0) / 1e15;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	if (!best) return;

	const records = best.flags.vurs.displacement;
	try {
		await best.update({ "flags.vurs.displacement": [] });
	} catch (error) {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: could not clear displacement records on message ${best.id}`, error);
	}
	try {
		await message.update({ "flags.vurs.displacement": records });
		console.log(`${MODULE_ID} | ${RULE_KEY}: linked ${records.length} displacement record(s) from message ${best.id} onto damage-taken message ${message.id}`);
	} catch (error) {
		console.warn(`${MODULE_ID} | ${RULE_KEY}: could not link displacement records onto message ${message.id}`, error);
	}
}

// PF2E's damage undo flips flags.pf2e.appliedDamage.isReverted on the chat
// message — restore every token position recorded when the displacement ran.
// Non-damage selectors never produce appliedDamage, so they can't be undone
// this way (there is no damage application to revert).
async function revertDisplacements(message, records) {
	for (const record of records) {
		try {
			const token = resolveDisplacementTokenDocument(record.token);
			if (token) {
				const update = { x: record.x, y: record.y, elevation: record.elevation };
				if (record.level != null) update.level = record.level;
				await token.update(update);
			}
		} catch (error) {
			console.warn(`${MODULE_ID} | ${RULE_KEY}: could not revert displacement on ${record.token}`, error);
		}
	}
	try {
		await message.update({ "flags.vurs.displacement": [] });
	} catch {
		// Best effort — stale records are harmless since isReverted stays set.
	}
}

function installDisplacementChatHook() {
	if (chatHookInstalled) return;
	Hooks.on("updateChatMessage", (message, change) => {
		const isReverted = change?.["flags.pf2e.appliedDamage.isReverted"] === true
			|| foundry.utils.getProperty(change, "flags.pf2e.appliedDamage.isReverted") === true;
		if (!isReverted) return;
		const records = message?.flags?.vurs?.displacement;
		if (!Array.isArray(records) || !records.length) return;
		console.log(`${MODULE_ID} | ${RULE_KEY}: reverting ${records.length} displacement record(s) on message ${message.id}`);
		revertDisplacements(message, records).catch(error =>
			console.error(`${MODULE_ID} | ${RULE_KEY} displacement revert failed`, error)
		);
	});
	Hooks.on("createChatMessage", message => {
		maybeLinkDisplacementToDamageMessage(message).catch(error =>
			console.error(`${MODULE_ID} | ${RULE_KEY} damage-message link failed`, error)
		);
		applyDisplacementRules(message).catch(error =>
			console.error(`${MODULE_ID} | ${RULE_KEY} chat hook failed`, error)
		);
	});
	chatHookInstalled = true;
}

function registerDisplacementSocket() {
	if (displacementSocket) return;
	if (!globalThis.socketlib?.registerModule) return;
	const socket = globalThis.socketlib.registerModule(MODULE_ID);
	if (!socket || typeof socket.register !== "function") return;
	displacementSocket = socket;
	displacementSocket.register("executeDisplacement", executeDisplacementAsGM);
}

let socketHookInstalled = false;
function installDisplacementSocketHook() {
	if (socketHookInstalled) return;
	socketHookInstalled = true;
	// SocketLib loads after module init — mirror collateralDamage's pattern.
	Hooks.once("socketlib.ready", registerDisplacementSocket);
	registerDisplacementSocket();
}

function initializeDisplacement({ quiet = false } = {}) {
	console.log(`${MODULE_ID} | ${RULE_KEY} initialized`);
	registerDisplacementRuleElement({ quiet });
	registerDisplacementLocalization();
	installDisplacementChatHook();
	installDisplacementSocketHook();
}

Hooks.once("init", () => initializeDisplacement({ quiet: true }));
Hooks.once("setup", () => initializeDisplacement());
Hooks.once("ready", () => initializeDisplacement());
