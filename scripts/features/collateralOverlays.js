import { AREA_TYPES, getRegionForShapes, isAreaPointHighlighted } from "./collateralGeometry.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Collateral Damage";
const OVERLAY_CHANNEL = `module.${MODULE_ID}`;
export const DEFAULT_OVERLAY_DURATION = 2000;
const MAX_OVERLAY_DURATION = 4000;
export const DEFAULT_PATH_SPEED_PIXELS_PER_SECOND = 600;
const PATH_LIFETIME_MS = 2000;
const MAX_PATH_DELAY_MS = 4000;
const activeOverlays = new Map();
const pendingOverlays = new Map();
let socketHandlerInstalled = false;

Hooks.on("canvasReady", canvas => drawPendingOverlays(canvas.scene?.id));
Hooks.on("canvasTearDown", () => {
	clearAllOverlays();
	for (const { timeout } of pendingOverlays.values()) clearTimeout(timeout);
	pendingOverlays.clear();
});

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
	const timeout = setTimeout(
		() => pendingOverlays.delete(data.id),
		data.durationMs + (Number(data.pathDelayMs) || 0)
	);
	pendingOverlays.set(data.id, { data, receivedAt, timeout });
}

function drawPendingOverlays(sceneId) {
	for (const [id, pending] of pendingOverlays) {
		clearTimeout(pending.timeout);
		pendingOverlays.delete(id);
		if (pending.data.sceneId !== sceneId) continue;
		const elapsed = performance.now() - pending.receivedAt;
		const remaining = Math.max(
			pending.data.durationMs,
			(Number(pending.data.pathDelayMs) || 0) + PATH_LIFETIME_MS
		) - elapsed;
		if (remaining > 0) {
			drawOverlay(pending.data, remaining, elapsed);
		}
	}
}

function drawOverlay(
	{ id, sceneId, shapes, paths, durationMs, color, pathDelayMs = 0, pathSpeedPixelsPerSecond = DEFAULT_PATH_SPEED_PIXELS_PER_SECOND },
	remainingDuration = durationMs,
	elapsedDuration = 0
) {
	if ((canvas.scene && canvas.scene.id !== sceneId) || remainingDuration <= 0) return;
	if (!canvas.ready) {
		queuePendingOverlay({
			id,
			sceneId,
			shapes,
			paths,
			durationMs: remainingDuration,
			color,
			pathDelayMs: Math.max(0, pathDelayMs - elapsedDuration)
		});
		return;
	}
	if (activeOverlays.has(id)) return;
	const validShapes = (Array.isArray(shapes) ? shapes : []).filter(shape =>
		shape && typeof shape.type === "string" && AREA_TYPES.some(type =>
			(type === "burst" || type === "cylinder") ? shape.type === "circle" :
				(type === "cube" || type === "square") ? shape.type === "rectangle" :
					type === "wedge" ? shape.type === "polygon" :
						shape.type === type
		)
	);
	const validPaths = (Array.isArray(paths) ? paths : [])
		.map(path => Array.isArray(path) ? { points: path } : path)
		.filter(path =>
			Array.isArray(path?.points) && path.points.length > 1 &&
			path.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
		);
	if (!validShapes.length && !validPaths.length) return;
	const colorValue = PIXI.utils.string2hex(color);
	const destroyers = [];
	let duration = Math.min(MAX_OVERLAY_DURATION, remainingDuration);
	const pathDelay = Math.max(0, pathDelayMs - elapsedDuration);
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
		const graphics = new PIXI.Graphics();
		graphics.eventMode = "none";
		canvas.interface.addChild(graphics);
		const pathData = validPaths.map(({ points }) => ({
			points,
			length: points.slice(1).reduce((total, point, index) =>
				total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0),
			delay: pathDelay,
			travelMs: 0,
			lifetimeMs: 0
		}));
		for (const path of pathData) {
			path.travelMs = path.length / pathSpeedPixelsPerSecond * 1000;
			path.lifetimeMs = Math.max(PATH_LIFETIME_MS, path.travelMs);
		}
		const pathsDuration = Math.max(...pathData.map(path => path.delay + path.lifetimeMs));
		const renderDuration = Math.max(duration, pathsDuration);
		const startTime = performance.now();
		const drawPaths = () => {
			graphics.clear();
			const now = performance.now();
			for (const pathDataEntry of pathData) {
				const pathElapsed = now - startTime - pathDataEntry.delay;
				if (pathElapsed < 0 || pathElapsed > pathDataEntry.lifetimeMs) continue;
				graphics.lineStyle({
					width: Math.max(3, canvas.dimensions.uiScale * 3),
					color: colorValue,
					alpha: 0.95
				});
				const path = pathDataEntry.points;
				graphics.moveTo(path[0].x, path[0].y);
				let remainingToDraw = Math.min(pathDataEntry.length, pathElapsed * pathSpeedPixelsPerSecond / 1000);
				for (let index = 1; index < path.length; index++) {
					const start = path[index - 1];
					const end = path[index];
					const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
					if (remainingToDraw >= segmentLength) {
						graphics.lineTo(end.x, end.y);
						remainingToDraw -= segmentLength;
						continue;
					}
					const segmentProgress = segmentLength > 0 ? remainingToDraw / segmentLength : 0;
					graphics.lineTo(
						start.x + (end.x - start.x) * segmentProgress,
						start.y + (end.y - start.y) * segmentProgress
					);
					break;
				}
			}
		};
		let destroyed = false;
		let animate;
		const destroyPaths = () => {
			if (destroyed) return;
			destroyed = true;
			if (animate && ticker) ticker.remove(animate);
			graphics.parent?.removeChild(graphics);
			graphics.destroy();
		};
		destroyers.push(destroyPaths);
		if (ticker && renderDuration > 0 && pathData.some(path => path.length > 0)) {
			animate = () => {
				drawPaths();
			};
			ticker.add(animate);
			animate();
		} else {
			for (const path of pathData) path.delay = 0;
			drawPaths();
		}
		if (renderDuration > duration) duration = renderDuration;
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
			data.durationMs > MAX_OVERLAY_DURATION ||
			(data.pathDelayMs !== undefined && (
				!Number.isFinite(data.pathDelayMs) ||
				data.pathDelayMs < 0 ||
				data.pathDelayMs > MAX_PATH_DELAY_MS
			)) ||
			(data.pathSpeedPixelsPerSecond !== undefined && (
				!Number.isFinite(data.pathSpeedPixelsPerSecond) ||
				data.pathSpeedPixelsPerSecond <= 0
			)) ||
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

function displayArea(
	shapes,
	paths,
	durationMs = DEFAULT_OVERLAY_DURATION,
	pathDelayMs = 0,
	pathSpeedPixelsPerSecond = DEFAULT_PATH_SPEED_PIXELS_PER_SECOND
) {
	if (!canvas.scene || (!shapes.length && !paths.length)) return;
	const data = {
		type: "collateral-damage-area",
		id: foundry.utils.randomID(),
		sceneId: canvas.scene.id,
		shapes: shapes.map(shape => foundry.utils.deepClone(shape)),
		paths: paths.map(path => path.map(point => ({ ...point }))),
		color: game.user.color.toString(),
		durationMs: Math.min(MAX_OVERLAY_DURATION, Math.max(1, durationMs)),
		pathDelayMs: Math.min(MAX_PATH_DELAY_MS, Math.max(0, pathDelayMs)),
		pathSpeedPixelsPerSecond,
		senderId: game.user.id
	};
	drawOverlay(data);
	game.socket?.emit(OVERLAY_CHANNEL, data);
}

export function displayCollateralPaths(
	paths,
	durationMs = DEFAULT_OVERLAY_DURATION,
	pathDelayMs = 0,
	pathSpeedPixelsPerSecond = DEFAULT_PATH_SPEED_PIXELS_PER_SECOND
) {
	displayArea([], paths, durationMs, pathDelayMs, pathSpeedPixelsPerSecond);
}

export function displayCollateralArea(
	shapes,
	paths,
	durationMs = DEFAULT_OVERLAY_DURATION,
	pathDelayMs = 0,
	pathSpeedPixelsPerSecond = DEFAULT_PATH_SPEED_PIXELS_PER_SECOND
) {
	displayArea(shapes, paths, durationMs, pathDelayMs, pathSpeedPixelsPerSecond);
}

export function initializeCollateralOverlays() {
	installOverlaySocket();
}