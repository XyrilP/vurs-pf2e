export const AREA_TYPES = ["burst", "cone", "cube", "cylinder", "emanation", "line", "ring", "square", "wedge"];

export function normalizeToken(token) {
	return token?.document ?? token ?? null;
}

// Freshness window for flags.vurs.displacementOrigin — the pre-move position
// stamped by Displacement so damage-time geometry (collateral areas, burst
// fire) resolves where the token was when it was hit, not mid-animation or
// post-move. See displacement.js stampDisplacementOrigin.
const DISPLACEMENT_ORIGIN_TTL_MS = 60 * 1000;

function getDisplacementOriginCenter(document) {
	const origin = document?.flags?.vurs?.displacementOrigin;
	if (!origin) return null;
	if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
	if (Date.now() - (origin.at ?? 0) > DISPLACEMENT_ORIGIN_TTL_MS) return null;
	const grid = canvas.grid;
	const center = {
		x: (origin.x + document.width / 2) * grid.sizeX,
		y: (origin.y + document.height / 2) * grid.sizeY
	};
	console.log(`vurs-pf2e | Collateral Damage: using pre-displacement origin for ${document.name} (${center.x}, ${center.y})`);
	return center;
}

export function getTokenCenter(token) {
	const document = normalizeToken(token);
	if (!document) return null;
	const displaced = getDisplacementOriginCenter(document);
	if (displaced) return displaced;
	const center = document.object?.getCenterPoint?.() ?? document.getCenterPoint?.();
	return center && { x: center.x, y: center.y };
}

// Single origin point for a Collateral Damage area: the midpoint of the
// origin token's edge on the side the attacker→target direction exits.
// placement "self" puts it on the edge facing the target; "target" puts it
// on the edge facing away from the damage source.
export function getPlacementAreaOrigin(placement, sourceToken, targetToken) {
	const sourceCenter = getTokenCenter(sourceToken);
	const targetCenter = getTokenCenter(targetToken);
	if (!sourceCenter || !targetCenter) return null;

	let dx = targetCenter.x - sourceCenter.x;
	let dy = targetCenter.y - sourceCenter.y;
	const length = Math.hypot(dx, dy);
	let rotation;
	if (length === 0) {
		const fallback = normalizeToken(sourceToken).rotation ?? 0;
		const fallbackAngle = Math.toRadians(fallback);
		dx = Math.cos(fallbackAngle);
		dy = Math.sin(fallbackAngle);
		rotation = fallback;
	} else {
		rotation = Math.toDegrees(Math.atan2(dy, dx));
		dx /= length;
		dy /= length;
	}

	const originToken = normalizeToken(placement === "self" ? sourceToken : targetToken);
	const center = placement === "self" ? sourceCenter : targetCenter;
	const halfWidth = (originToken.width * canvas.grid.sizeX) / 2;
	const halfHeight = (originToken.height * canvas.grid.sizeY) / 2;
	const point = Math.abs(dx) >= Math.abs(dy)
		? { x: center.x + Math.sign(dx) * halfWidth, y: center.y }
		: { x: center.x, y: center.y + Math.sign(dy) * halfHeight };
	return { ...point, rotation };
}

export function getPlacementGeometries(placement, sourceToken, targetToken) {
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

export function getTokenDistance(left, right) {
	const from = getTokenCenter(left);
	const to = getTokenCenter(right);
	if (!from || !to) return Infinity;
	const measurement = canvas.grid.measurePath([from, to]);
	return Number(measurement?.distance ?? Infinity);
}

export function isAreaPointHighlighted(region, center) {
	if (!center || !region.polygonTree) return false;
	if (region.polygonTree.testPoint(center)) return true;

	const origin = region.shapes[0];
	return Boolean(origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) &&
		Math.max(Math.abs(center.x - origin.x), Math.abs(center.y - origin.y)) < 1);
}

export function isTokenCenterInArea(region, token) {
	return isAreaPointHighlighted(region, getTokenCenter(token));
}

function getTokenBoundsRect(token) {
	const document = normalizeToken(token);
	const center = getTokenCenter(document);
	if (!document || !center) return null;
	const halfWidth = (document.width * canvas.grid.sizeX) / 2;
	const halfHeight = (document.height * canvas.grid.sizeY) / 2;
	return {
		left: center.x - halfWidth,
		right: center.x + halfWidth,
		top: center.y - halfHeight,
		bottom: center.y + halfHeight
	};
}

function isPointInRect(point, rect) {
	return Boolean(point) &&
		point.x >= rect.left && point.x <= rect.right &&
		point.y >= rect.top && point.y <= rect.bottom;
}

function getRegionShapePoints(shape) {
	const points = [];
	if (Number.isFinite(shape?.x) && Number.isFinite(shape?.y)) {
		points.push({ x: shape.x, y: shape.y });
	}
	const base = shape?.base;
	if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
		points.push({ x: base.x, y: base.y });
	}
	return points;
}

// True token/area overlap: any of the token's bounds sample points inside the
// region, or any region shape origin inside the token's bounds (covers a
// small area fully contained within a large token).
export function isTokenInArea(region, token) {
	if (!region?.polygonTree) return false;
	const rect = getTokenBoundsRect(token);
	if (!rect) return false;
	const midX = (rect.left + rect.right) / 2;
	const midY = (rect.top + rect.bottom) / 2;
	const samples = [
		{ x: midX, y: midY },
		{ x: rect.left, y: rect.top },
		{ x: rect.right, y: rect.top },
		{ x: rect.left, y: rect.bottom },
		{ x: rect.right, y: rect.bottom },
		{ x: midX, y: rect.top },
		{ x: midX, y: rect.bottom },
		{ x: rect.left, y: midY },
		{ x: rect.right, y: midY }
	];
	if (samples.some(point => region.polygonTree.testPoint(point))) return true;
	for (const shape of region.shapes ?? []) {
		if (getRegionShapePoints(shape).some(point => isPointInRect(point, rect))) return true;
	}
	return false;
}

export function isTokenInAreaLevel(region, token) {
	const level = token.level ?? 0;
	if (region.includedInLevel && !region.includedInLevel(level)) return false;
	return true;
}

export function getRegionForShapes(scene, shapes, name = "Collateral Damage") {
	try {
		return new CONFIG.Region.documentClass({
			name,
			shapes: Array.isArray(shapes) ? shapes : [shapes],
			levels: [canvas.level.id],
			elevation: { bottom: null, top: null, topInclusive: true }
		}, { parent: scene });
	} catch (error) {
		console.error(`vurs-pf2e | Could not create temporary ${name} area`, error);
		return null;
	}
}

export function getTokensInCollateralShape(shape) {
	const scene = canvas.scene;
	if (!scene) return [];
	const region = getRegionForShapes(scene, shape, "Burst-Fire");
	if (!region) return [];
	return [...scene.tokens].filter(token =>
		token.actor?.attributes?.hp &&
		isTokenInArea(region, token) &&
		isTokenInAreaLevel(region, token)
	);
}
