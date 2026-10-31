function getRuleElementOrigin(item) {
	const origin = item?.origin ?? item?.system?.context?.origin;
	if (origin && typeof origin === "object") {
		return origin;
	}

	const uuid = typeof origin === "string" ? origin : origin?.uuid;
	if (!uuid) return null;

	let document = null;
	try {
		document = globalThis.fromUuidSync?.(uuid) ?? null;
	} catch (error) {
		console.warn(`vurs-pf2e | Could not resolve Rule Element origin "${uuid}" by UUID`, error);
	}

	if (document) return document.actor ?? document;

	const tokenActorMatch = /^Scene\.([^.]+)\.Token\.([^.]+)\.Actor(?:\.([^.]+))?$/.exec(uuid);
	if (tokenActorMatch) {
		const [, sceneId, tokenId, actorId] = tokenActorMatch;
		const tokenActor = game.scenes?.get(sceneId)?.tokens?.get(tokenId)?.actor;
		if (tokenActor && (!actorId || tokenActor.id === actorId)) {
			return tokenActor;
		}
	}

	const worldActorMatch = /^Actor\.([^.]+)$/.exec(uuid);
	return worldActorMatch ? game.actors?.get(worldActorMatch[1]) ?? null : null;
}

export function resolveRuleElementValue(rule, resolveValue, value, fallback, options = {}) {
	const item = rule.item;
	const parent = item?.parent;
	const origin = getRuleElementOrigin(rule.item);
	const resolvables = options.resolvables ?? {};

	return resolveValue(value, fallback, {
		...options,
		resolvables: {
			...resolvables,
			parent: parent || resolvables.parent
				? {
					...parent?.toObject?.(),
					...resolvables.parent,
					origin: origin ?? resolvables.parent?.origin ?? parent?.origin
				}
				: resolvables.parent,
			origin: origin ?? resolvables.origin
		}
	});
}

export function getRuleElementPredicateOptions(item, rollOptions) {
	const options = rollOptions instanceof Set
		? new Set(rollOptions)
		: new Set(Array.isArray(rollOptions) ? rollOptions : []);
	for (const option of item?.getRollOptions?.("parent") ?? []) {
		options.add(option);
	}
	return options;
}

export function testRuleElementPredicate(rule, rollOptions) {
	if (typeof rule?.test === "function") return rule.test(rollOptions);
	return rule?.predicate?.test?.(
		getRuleElementPredicateOptions(rule?.item, rollOptions)
	) ?? true;
}
