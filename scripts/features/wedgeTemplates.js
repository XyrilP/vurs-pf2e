const MODULE_ID = "vurs-pf2e";
const WEDGE_TYPE = "wedge";
const WEDGE_ANCHOR_CLASS = "vurs-wedge-template";
const WEDGE_ICON = "fa-solid fa-play";
const WEDGE_SHAPE_LABEL = "PF2E.Area.Shape.wedge";
let installed = false;

function parseTemplateParams(paramString) {
	const params = {};
	String(paramString ?? "").split("|").forEach((part, index) => {
		const trimmed = part.trim();
		if (!trimmed) return;
		const colon = trimmed.indexOf(":");
		if (colon < 0) {
			if (index === 0) params.type = trimmed;
			return;
		}
		params[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
	});
	return params;
}

function isWedgeTemplateMatch(match) {
	const [, tag, paramString] = match ?? [];
	return tag === "Template" && parseTemplateParams(paramString).type === WEDGE_TYPE;
}

function resolveTemplateNumber(raw, options) {
	if (typeof raw !== "string" || !raw) return NaN;
	if (!raw.startsWith("resolve")) return Number(raw);
	const match = raw.match(/resolve\((.+?)\)$/);
	const expression = match && match.length > 1 ? match[1] : "";
	try {
		const rawRollData = options?.rollData;
		const rollData = typeof rawRollData === "function" ? rawRollData() : rawRollData;
		const item = rollData?.item ?? null;
		const actor = rollData?.actor ?? item?.actor ?? null;
		const data = item?.getRollData?.() ?? actor?.getRollData?.() ?? rollData ?? {};
		return Number(Roll.safeEval(Roll.replaceFormulaData(expression, data)));
	} catch {
		return 0;
	}
}

function buildWedgeTemplateElement(match, options) {
	const [, , paramString, inlineLabel] = match;
	const params = parseTemplateParams(paramString);
	if (!params.type) {
		ui.notifications.error("PF2E.InlineTemplateErrors.TypeMissing", { localize: true });
		return null;
	}
	if (!params.distance) {
		ui.notifications.error("PF2E.InlineTemplateErrors.DistanceMissing", { localize: true });
		return null;
	}
	const distance = resolveTemplateNumber(params.distance, options);
	if (!Number.isFinite(distance) || distance < 0) {
		ui.notifications.error("PF2E.InlineTemplateErrors.DistanceInvalid", {
			format: { distance: params.distance }
		});
		return null;
	}
	let width = distance;
	if (params.width !== undefined && params.width !== "") {
		if (Number.isNaN(+params.width)) {
			ui.notifications.error("PF2E.InlineTemplateErrors.WidthNoNumber", {
				format: { width: params.width }
			});
			return null;
		}
		width = Number(params.width);
		if (!Number.isFinite(width) || width <= 0) {
			ui.notifications.error("VURS.Template.WidthInvalid");
			return null;
		}
	}

	const rawRollData = options?.rollData;
	const rollData = typeof rawRollData === "function" ? rawRollData() : rawRollData;
	const item = rollData?.item ?? null;
	const label = inlineLabel ?? game.i18n.format("PF2E.TemplateLabel", {
		size: distance,
		unit: game.i18n.localize("PF2E.Foot.Abbreviation"),
		shape: game.i18n.localize(WEDGE_SHAPE_LABEL)
	});

	const icon = document.createElement("i");
	icon.className = WEDGE_ICON;
	icon.inert = true;
	const anchor = document.createElement("a");
	anchor.className = `${WEDGE_ANCHOR_CLASS} effect-area`;
	anchor.append(icon, document.createTextNode(` ${label}`));
	anchor.dataset.vursWedge = "";
	anchor.dataset.distance = String(distance);
	anchor.dataset.width = String(width);
	anchor.dataset.traits = item?.system?.traits?.value?.toString() ?? "";
	if (item?.uuid) anchor.dataset.itemUuid = item.uuid;
	return anchor;
}

function wedgeMetrics(distanceFeet, widthFeet) {
	if (!canvas?.ready || !canvas.grid) return null;
	const pxPerFoot = canvas.grid.size / 5;
	return {
		length: distanceFeet * pxPerFoot,
		farHalf: (widthFeet * pxPerFoot) / 2,
		nearHalf: (widthFeet * pxPerFoot) / 4
	};
}

function wedgePoints(origin, metrics, angleDeg = 0) {
	const radians = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const local = [
		[0, -metrics.nearHalf],
		[metrics.length, -metrics.farHalf],
		[metrics.length, metrics.farHalf],
		[0, metrics.nearHalf]
	];
	const points = [];
	for (const [lx, ly] of local) {
		points.push(origin.x + lx * cos - ly * sin, origin.y + lx * sin + ly * cos);
	}
	return points;
}

function wedgePivotFromShape(shape) {
	// shape.origin is maintained by RegionShape#move as the near-edge midpoint
	// anchor; prefer it over point indices, which Foundry may re-seat.
	const origin = shape?.origin ?? shape?.document?.origin ?? shape?.source?.origin;
	if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
		return { x: origin.x, y: origin.y };
	}
	const points = shape?.points ?? shape?.document?.points ?? shape?.source?.points;
	if (Array.isArray(points) && points.length >= 8) {
		return { x: (points[0] + points[6]) / 2, y: (points[1] + points[7]) / 2 };
	}
	return null;
}

async function placeWedgeRegion({
	distance,
	width = distance,
	actor = null,
	item = null,
	traits = null,
	messageId = null,
	name = null
} = {}) {
	if (!canvas?.ready) return null;
	const metrics = wedgeMetrics(distance, width);
	if (!metrics) return null;

	const { x, y } = canvas.mousePosition;
	const origin = { x, y };
	const aim = canvas.grid?.type === CONST.GRID_TYPES.SQUARE;
	const state = { aiming: false, pivot: null, metrics };

	const flags = {
		pf2e: { areaShape: WEDGE_TYPE, messageId },
		vurs: { templateWedge: true }
	};
	if (item?.isOfType?.("physical", "spell", "action", "feat")) {
		flags.pf2e.origin = {
			name: item.name,
			slug: item.slug,
			traits: foundry.utils.deepClone(item.system?.traits?.value ?? []),
			...item.getOriginData?.()
		};
	} else {
		flags.pf2e.origin = {
			actor: actor?.uuid ?? null,
			traits: traits ?? item?.system?.traits?.value?.toString?.().split(",") ?? []
		};
	}

	const shape = {
		type: "polygon",
		points: wedgePoints(origin, metrics, 0),
		origin: { ...origin }
	};

	const callbacks = {};
	if (aim) {
		// RegionLayerPF2e.placeRegion overwrites onMove/preConfirm/preSkip with
		// handlers that only aim cone/line shapes, so wedge placement calls the
		// base RegionLayer implementation directly and replicates its snapping.
		callbacks.onMove = ({ event, position, preview, shape: previewShape, snap }) => {
			if (canvas.grid.type !== CONST.GRID_TYPES.SQUARE) return;
			if (state.aiming) {
				if (!previewShape || !state.pivot) return;
				let angle = Math.atan2(position.y - state.pivot.y, position.x - state.pivot.x) * 180 / Math.PI;
				if (!(event.ctrlKey || event.metaKey)) angle = Math.round(angle / 45) * 45;
				previewShape.updateSource({
					points: wedgePoints(state.pivot, state.metrics, angle),
					origin: { x: state.pivot.x, y: state.pivot.y }
				});
				return false;
			}
			if (!snap) return;
			const { x: sx, y: sy } = canvas.grid.getSnappedPoint(position, { mode: preview?.snappingMode });
			position.x = sx;
			position.y = sy;
		};
		callbacks.preConfirm = ({ event, shape: previewShape }) => {
			if (state.aiming || event.shiftKey) return;
			state.aiming = true;
			state.pivot = wedgePivotFromShape(previewShape) ?? { ...origin };
			return false;
		};
		callbacks.preSkip = () => {
			if (state.aiming) {
				state.aiming = false;
				return false;
			}
		};
	}

	const regionLayer = canvas.regions;
	const baseRegionLayer = Object.getPrototypeOf(Object.getPrototypeOf(regionLayer));
	const placeRegion = typeof baseRegionLayer?.placeRegion === "function"
		? baseRegionLayer.placeRegion
		: regionLayer.placeRegion;

	return placeRegion.call(regionLayer, {
		name: name ?? item?.name ?? game.i18n.localize("VURS.Template.Wedge"),
		shapes: [shape],
		levels: canvas.level ? [canvas.level.id] : [],
		color: game.user.color.toString(),
		highlightMode: "coverage",
		displayMeasurements: true,
		visibility: CONST.REGION_VISIBILITY.ALWAYS,
		ownership: { [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
		flags
	}, callbacks);
}

async function onWedgeTemplateClick(event) {
	const anchor = event.target?.closest?.(`a.${WEDGE_ANCHOR_CLASS}`);
	if (!anchor || !canvas?.ready) return;
	event.preventDefault();

	const distance = Number(anchor.dataset.distance);
	const width = Number(anchor.dataset.width) || distance;

	let item = null;
	if (anchor.dataset.itemUuid) {
		try {
			item = await fromUuid(anchor.dataset.itemUuid);
		} catch {
			item = null;
		}
	}
	const actor = item?.actor ?? game.user.character ?? null;
	const traits = anchor.dataset.traits ? anchor.dataset.traits.split(",") : null;
	const message = anchor.closest(".chat-message");

	await placeWedgeRegion({
		distance,
		width,
		actor,
		item,
		traits,
		messageId: message?.dataset?.messageId ?? null,
		name: item?.name
	});
}

function onPlaceAreaTemplateCapture(event) {
	const button = event.target?.closest?.(`[data-action="place-area-template"]`);
	if (!button) return;
	const messageEl = button.closest(".chat-message");
	const message = messageEl ? game.messages.get(messageEl.dataset.messageId) : null;
	const context = message?.flags?.pf2e?.context;
	const area = (context?.type === "area-fire" || context?.type === "auto-fire")
		? context.area
		: null;
	if (area?.type !== WEDGE_TYPE) return;

	event.preventDefault();
	event.stopPropagation();

	const distance = Number(area.value);
	if (!Number.isFinite(distance) || distance <= 0) return;
	const item = message.item ?? null;
	placeWedgeRegion({
		distance,
		width: distance,
		actor: item?.actor ?? game.user.character ?? null,
		item,
		messageId: message.id,
		name: item?.name
	});
}

function addWedgeAreaShapeOption(data) {
	const list = data?.areaShapes;
	if (Array.isArray(list) &&
		!list.some((entry) => (Array.isArray(entry) ? entry[0] : entry?.value) === WEDGE_TYPE)) {
		list.push([WEDGE_TYPE, WEDGE_SHAPE_LABEL]);
	}
	return data;
}

function wrapPrototypeMethod(prototype, name, wrapper, marker) {
	const original = prototype?.[name];
	if (typeof original !== "function" || original[marker]) return;
	const wrapped = wrapper(original);
	wrapped[marker] = true;
	prototype[name] = wrapped;
}

function installWedgeAreaIntegration() {
	for (const type of ["spell", "melee"]) {
		const documentClass = CONFIG.Item?.dataModels?.[type]?.documentClass;
		wrapPrototypeMethod(
			documentClass?.prototype,
			"getData",
			(original) => async function (...args) {
				return addWedgeAreaShapeOption(await Reflect.apply(original, this, args));
			},
			"_vursWedgeGetData"
		);
	}

	const spellClass = CONFIG.Item?.dataModels?.spell?.documentClass;
	wrapPrototypeMethod(
		spellClass?.prototype,
		"placeTemplate",
		(original) => async function (message) {
			const area = this.system?.area;
			if (area?.type !== WEDGE_TYPE) {
				return Reflect.apply(original, this, [message]);
			}
			const distance = Number(area.value);
			if (!Number.isFinite(distance) || distance <= 0) return null;
			return placeWedgeRegion({
				distance,
				width: distance,
				actor: this.actor ?? null,
				item: this,
				messageId: message?.id ?? message ?? null,
				name: this.name
			});
		},
		"_vursWedgePlaceTemplate"
	);
}

function installWedgeTemplates() {
	if (installed) return;
	const TextEditorPF2e = foundry.applications.ux?.TextEditor?.implementation;
	if (typeof TextEditorPF2e?.enrichString !== "function") return;
	installed = true;

	const originalEnrichString = TextEditorPF2e.enrichString;
	TextEditorPF2e.enrichString = async function (...args) {
		if (isWedgeTemplateMatch(args[0])) {
			return buildWedgeTemplateElement(args[0], args[1]);
		}
		return Reflect.apply(originalEnrichString, this ?? TextEditorPF2e, args);
	};

	document.addEventListener("click", onWedgeTemplateClick);
	document.addEventListener("click", onPlaceAreaTemplateCapture, true);

	// RegionPF2e.snappingMode only special-cases burst/cone/line; give wedge
	// the same snapping modes as cone so it can be placed at face centers.
	const regionClass = CONFIG.Region?.objectClass;
	const descriptor = regionClass &&
		Object.getOwnPropertyDescriptor(regionClass.prototype, "snappingMode");
	if (descriptor?.get && !descriptor.get._vursWedgePatched) {
		const original = descriptor.get;
		const patched = function () {
			if (this.areaShape === WEDGE_TYPE) {
				const modes = CONST.GRID_SNAPPING_MODES;
				return modes.CENTER | modes.VERTEX | modes.EDGE_MIDPOINT;
			}
			return original.call(this);
		};
		patched._vursWedgePatched = true;
		Object.defineProperty(regionClass.prototype, "snappingMode", {
			get: patched,
			configurable: true
		});
	}

	installWedgeAreaIntegration();
}

Hooks.once("init", () => {
	installWedgeTemplates();
	installWedgeAreaIntegration();
});
Hooks.once("ready", () => {
	installWedgeTemplates();
	installWedgeAreaIntegration();
});
