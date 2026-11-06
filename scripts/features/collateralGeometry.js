export const AREA_TYPES = ["burst", "cone", "cube", "cylinder", "emanation", "line", "ring", "square"];

export function normalizeToken(token) {
	return token?.document ?? token ?? null;
}

export function getTokenCenter(token) {
	const document = normalizeToken(token);
	if (!document) return null;
	const center = document.object?.getCenterPoint?.() ?? document.getCenterPoint?.();
	return center && { x: center.x, y: center.y };
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
		isTokenCenterInArea(region, token) &&
		isTokenInAreaLevel(region, token)
	);
}
