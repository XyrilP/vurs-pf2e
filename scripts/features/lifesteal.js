import { getLifestealHealingEffectiveness } from "./healingEffectiveness.js";
import {
	resolveRuleElementValue,
	testRuleElementPredicate
} from "./ruleElementResolvers.js";

const MODULE_ID = "vurs-pf2e";
const RULE_KEY = "Lifesteal";
const registeredDamageTargets = new Set();
const activeDamageParams = new WeakSet();
const damageSelectorCache = new WeakMap();
const damageHandlers = globalThis[Symbol.for(`${MODULE_ID}.applyDamageHandlers`)] ??= new Set();
const damageTransactionState = globalThis[Symbol.for(`${MODULE_ID}.damageTransactions`)] ??= {
	params: new WeakMap(),
	active: new Set(),
	finalizers: new Set(),
	renderFinalizers: new Set(),
	finalizerOrder: new Map(),
	hooksInstalled: false
};
damageTransactionState.renderFinalizers ??= new Set();
damageTransactionState.finalizerOrder ??= new Map();
let LifestealRuleElement = null;

export function registerDamageTransactionFinalizer(finalizer, phase = "apply") {
	const finalizers = phase === "render"
		? damageTransactionState.renderFinalizers
		: damageTransactionState.finalizers;
	finalizers.add(finalizer);
	if (phase !== "render") {
		const order = { prepare: 0, apply: 1, heal: 2 };
		damageTransactionState.finalizerOrder.set(finalizer, order[phase] ?? order.apply);
	}
}

export function queueDamageTransactionRequest(parentParams, key, request) {
	const transaction = damageTransactionState.params.get(parentParams);
	if (!transaction?.rootMessageId) return false;
	transaction[key] ??= [];
	transaction[key].push(request);
	return true;
}

export function queueDamageTransactionApplication(parentParams, application) {
	return queueDamageTransactionRequest(parentParams, "damageApplications", application);
}

export function runDamageTransactionActorOperation(parentParams, actor, operation) {
	const transaction = damageTransactionState.params.get(parentParams);
	if (!transaction) return operation();

	transaction.actorOperations ??= new Map();
	const key = actor.uuid ?? actor.id;
	const previous = transaction.actorOperations.get(key) ?? Promise.resolve();
	const current = previous.then(operation);
	transaction.actorOperations.set(key, current.catch(() => {}));
	return current;
}

export async function applyDamageInTransaction(actor, damageParams, parentParams, effect) {
	const transaction = damageTransactionState.params.get(parentParams);
	if (!transaction?.rootMessageId) return actor.applyDamage(damageParams);

	const pendingEffect = Object.assign(effect, {
		actorUuid: actor.uuid,
		actorId: actor.id,
		tokenId: damageParams.token?.document?.id ?? damageParams.token?.id ?? null,
		appliedDamage: null
	});
	transaction.pending.push(pendingEffect);
	damageTransactionState.params.set(damageParams, transaction);
	try {
		return await actor.applyDamage(damageParams);
	} finally {
		damageTransactionState.params.delete(damageParams);
		const index = transaction.pending.indexOf(pendingEffect);
		if (index >= 0) transaction.pending.splice(index, 1);
	}
}

function getDamageApplicationBatchKey(application) {
	const { actor, damageParams, secret = false } = application;
	const rollOptions = damageParams.rollOptions instanceof Set
		? [...damageParams.rollOptions]
		: Array.isArray(damageParams.rollOptions) ? damageParams.rollOptions : [];
	return JSON.stringify([
		actor.uuid ?? actor.id,
		damageParams.token?.document?.id ?? damageParams.token?.id ?? null,
		damageParams.item?.uuid ?? null,
		rollOptions.map(String).sort(),
		damageParams.vursDamageModifiers ?? [],
		Boolean(damageParams.skipIWR),
		Boolean(secret)
	]);
}

function combineDamageRolls(rolls) {
	const DamageRoll = CONFIG.Dice?.rolls?.find(rollClass => rollClass.name === "DamageRoll");
	if (!DamageRoll) return null;

	const validTypes = new Set(Object.keys(
		CONFIG[game.system.id.toUpperCase()]?.damageTypes ?? CONFIG.PF2E?.damageTypes ?? {}
	));
	const totals = new Map();
	for (const roll of rolls) {
		for (const instance of roll?.instances ?? []) {
			const amount = Number(instance.total);
			if (!Number.isFinite(amount) || amount <= 0) continue;
			const type = validTypes.has(instance.type) ? instance.type : "untyped";
			totals.set(type, (totals.get(type) ?? 0) + amount);
		}
	}
	if (!totals.size) return null;

	const formula = `{${[...totals].map(([type, amount]) =>
		type === "untyped" ? `${amount}` : `${amount}[${type}]`
	).join(", ")}}`;
	return new DamageRoll(formula).evaluateSync();
}

function getBatchedDamageEffect(applications) {
	if (applications.length === 1) return applications[0].effect;
	const effects = applications.map(application => application.effect);
	const sources = effects.flatMap(effect =>
		Array.isArray(effect.sources)
			? effect.sources.map(source => ({
				...source,
				damage: source.damage ?? source.amount ?? effect.amount
			}))
			: [{ label: effect.label, damage: effect.amount }]
	);
	return {
		...effects[0],
		label: effects.map(effect => effect.label).filter(Boolean).join(", "),
		amount: effects.reduce((total, effect) => total + (Number(effect.amount) || 0), 0),
		sources,
		hidden: effects.some(effect => effect.hidden),
		modifiers: [...new Set(effects.flatMap(effect => effect.modifiers ?? []))]
	};
}

async function applyDamageApplicationBatch(applications, parentParams) {
	const first = applications[0];
	const { actor } = first;
	let damageParams = first.damageParams;
	if (applications.length > 1) {
		const combinedDamage = combineDamageRolls(applications.map(application =>
			application.damageParams.damage
		));
		if (!combinedDamage) {
			console.error(`${MODULE_ID} | Could not combine compatible damage applications to ${actor.name}; applying them individually`);
			for (const application of applications) {
				try {
					await applyDamageApplicationBatch([application], parentParams);
				} catch (error) {
					console.error(`${MODULE_ID} | Failed to apply grouped damage to ${actor.name}`, error);
				}
			}
			return;
		}
		damageParams = { ...damageParams, damage: combinedDamage };
	}

	const effect = getBatchedDamageEffect(applications);
	const healthBefore = currentHealthPool(actor);
	const apply = first.apply ?? ((targetActor, params, rootParams, targetEffect) =>
		applyDamageInTransaction(targetActor, params, rootParams, targetEffect));
	await apply(actor, damageParams, parentParams, effect);
	const healthAfter = currentHealthPool(actor);
	if (healthBefore !== null && healthAfter !== null) {
		effect.amount = Math.max(0, healthBefore - healthAfter);
	}
}

async function finalizeQueuedDamageApplications(transaction) {
	const applications = (transaction.damageApplications ?? []).splice(0);
	if (!applications.length) return;

	const byActor = new Map();
	for (const application of applications) {
		const actorKey = application.actor.uuid ?? application.actor.id;
		const actorApplications = byActor.get(actorKey) ?? [];
		const key = getDamageApplicationBatchKey(application);
		const lastBatch = actorApplications.at(-1);
		if (lastBatch?.key === key) {
			lastBatch.applications.push(application);
		} else {
			actorApplications.push({ key, applications: [application] });
		}
		byActor.set(actorKey, actorApplications);
	}

	await Promise.all([...byActor.values()].map(async batches => {
		const actor = batches[0].applications[0].actor;
		for (const batch of batches) {
			try {
				await runDamageTransactionActorOperation(transaction.rootParams, actor, () =>
					applyDamageApplicationBatch(batch.applications, transaction.rootParams)
				);
			} catch (error) {
				console.error(`${MODULE_ID} | Failed to apply grouped damage to ${actor.name}`, error);
			}
		}
	}));
}

function getDamageMessageTokenId(message, data, appliedDamage) {
	const speakerTokenId = data.speaker?.token ?? message.speaker?.token;
	if (speakerTokenId) return speakerTokenId;
	return /\.Token\.([^.]+)\.Actor\./.exec(appliedDamage?.uuid ?? "")?.[1] ?? null;
}

function getDamageMessageToken(message, appliedDamage) {
	const tokenId = getDamageMessageTokenId(message, message, appliedDamage);
	if (!tokenId) return null;
	const sceneId = message.speaker?.scene ??
		/^Scene\.([^.]+)\.Token\./.exec(appliedDamage?.uuid ?? "")?.[1];
	return game.scenes?.get(sceneId)?.tokens.get(tokenId) ??
		(canvas.scene?.tokens.get(tokenId) ?? null);
}

function installDamageTransactionHooks() {
	if (damageTransactionState.hooksInstalled) return;
	Hooks.on("renderChatMessageHTML", (message, html) => {
		if (
			foundry.utils.getProperty(message, `flags.${game.system.id}.context.type`) !== "damage-taken" ||
			!(html instanceof HTMLElement)
		) return;
		const appliedDamage = foundry.utils.getProperty(
			message,
			`flags.${game.system.id}.appliedDamage`
		);
		const token = getDamageMessageToken(message, appliedDamage);
		const targetName = html.querySelector(".damage-taken .statements .target-name");
		if (token && targetName) targetName.textContent = token.name;
	});

	Hooks.on("preCreateChatMessage", (message, data) => {
		const systemFlags = data.flags?.[game.system.id];
		if (systemFlags?.context?.type !== "damage-taken") return;
		const appliedDamage = systemFlags.appliedDamage;
		const actorUuid = appliedDamage?.uuid;
		const actorId = data.speaker?.actor ?? message.speaker?.actor;
		const tokenId = getDamageMessageTokenId(message, data, appliedDamage);

		const activeTransactions = [...damageTransactionState.active];
		for (const transaction of activeTransactions) {
			const pendingEffects = transaction.rootMessageId
				? [...transaction.pending].reverse().filter(effect =>
					Boolean(tokenId) && effect.tokenId === tokenId
				)
				: [];
			const actorMatches = !tokenId
				? [...transaction.pending].reverse().filter(effect =>
					Boolean(actorUuid) && effect.actorUuid === actorUuid ||
					Boolean(actorId) && effect.actorId === actorId
				)
				: [];
			const pendingEffect = pendingEffects.length === 1
				? pendingEffects[0]
				: pendingEffects.length === 0 && actorMatches.length === 1
					? actorMatches[0]
					: null;
			if (pendingEffect) {
				if (appliedDamage) {
					const privateCard = pendingEffect.hidden || data.blind ||
						(Array.isArray(data.whisper) && data.whisper.length > 0);
					if (privateCard) {
						pendingEffect.hidden = true;
					}
					pendingEffect.appliedDamage = foundry.utils.deepClone(appliedDamage);
					if (!transaction.effects.includes(pendingEffect)) {
						transaction.effects.push(pendingEffect);
					}
				}
				return false;
			}
		}

		const unassignedTransactions = activeTransactions.filter(transaction => !transaction.rootMessageId);
		const rootCandidates = unassignedTransactions.filter(transaction =>
			(Boolean(tokenId) && transaction.rootTokenId === tokenId) ||
			(!tokenId &&
				((Boolean(actorUuid) && transaction.rootActorUuid === actorUuid) ||
					(Boolean(actorId) && transaction.rootActorId === actorId)))
		);
		const transaction = rootCandidates.length === 1
			? rootCandidates[0]
			: rootCandidates.length === 0 && unassignedTransactions.length === 1
				? unassignedTransactions[0]
				: null;
		if (transaction) {
			transaction.rootMessageId = message.id ?? data._id;
			transaction.rootMessagePending = true;
			transaction.primaryDamage = appliedDamage ? foundry.utils.deepClone(appliedDamage) : null;
		}
	});

	Hooks.on("createChatMessage", message => {
		if (foundry.utils.getProperty(message, `flags.${game.system.id}.context.type`) !== "damage-taken") return;
		const activeTransactions = [...damageTransactionState.active].filter(transaction =>
			transaction.rootMessagePending
		);
		if (!activeTransactions.length) return;

		const appliedDamage = foundry.utils.getProperty(
			message,
			`flags.${game.system.id}.appliedDamage`
		);
		const actorUuid = appliedDamage?.uuid;
		const actorId = message.speaker?.actor;
		const tokenId = getDamageMessageTokenId(message, message, appliedDamage);
		const rootCandidates = activeTransactions.filter(transaction => tokenId
			? transaction.rootTokenId === tokenId
			: (Boolean(actorUuid) && transaction.rootActorUuid === actorUuid) ||
				(Boolean(actorId) && transaction.rootActorId === actorId)
		);
		const transaction = rootCandidates.length === 1
			? rootCandidates[0]
			: rootCandidates.length === 0 && activeTransactions.length === 1
				? activeTransactions[0]
				: null;
		if (!transaction) return;

		transaction.rootMessageId = message.id;
		transaction.rootMessagePending = false;
		transaction.primaryDamage = appliedDamage ? foundry.utils.deepClone(appliedDamage) : null;
	});

	damageTransactionState.hooksInstalled = true;
}

async function finalizeDamageTransaction(transaction) {
	const applyFinalizers = [...damageTransactionState.finalizers].sort((left, right) =>
		(damageTransactionState.finalizerOrder.get(left) ?? 0) -
		(damageTransactionState.finalizerOrder.get(right) ?? 0)
	);
	for (let pass = 0; pass < 2; pass++) {
		for (const finalizer of applyFinalizers) {
			try {
				await finalizer(transaction);
			} catch (error) {
				console.error(`${MODULE_ID} | Failed to apply a grouped damage effect`, error);
			}
		}
		if (pass === 0 && !transaction.collateralApplications?.length &&
			!transaction.damageReturnRequests?.length && !transaction.lifestealRequests?.length &&
			!transaction.damageApplications?.length) {
			break;
		}
	}

	await Promise.all([...damageTransactionState.renderFinalizers].map(async finalizer => {
		try {
			await finalizer(transaction);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to finalize a grouped damage card`, error);
		}
	}));
}

registerDamageTransactionFinalizer(finalizeQueuedDamageApplications, "apply");

async function finalizeLifestealHealing(transaction) {
	if (!transaction.lifestealRequests?.length) return;

	const requestsByActor = new Map();
	for (const request of transaction.lifestealRequests.splice(0)) {
		const requests = requestsByActor.get(request.attacker.uuid) ?? [];
		requests.push(request);
		requestsByActor.set(request.attacker.uuid, requests);
	}

	await Promise.all([...requestsByActor.values()].map(async requests => {
		const attacker = requests[0].attacker;
		const healing = requests.reduce((total, request) => total + request.healing, 0);
		const sources = requests.flatMap(request => request.sources);
		const modifiers = [...new Set(requests.flatMap(request => request.modifiers))];
		const healingEffectiveness = requests.flatMap(request => request.healingEffectiveness ?? []);
		await runDamageTransactionActorOperation(transaction.rootParams, attacker, () =>
			healDamageDealer(attacker, healing, transaction.rootParams, sources, {
				findCard: false,
				modifiers,
				healingEffectiveness
			})
		);
	}));
}

registerDamageTransactionFinalizer(finalizeLifestealHealing, "heal");

function registerLifestealLocalization() {
	const translations = game.i18n?.translations;
	if (!translations || game.i18n.has("PF2E.RuleElement.Lifesteal")) return;
	foundry.utils.setProperty(translations, "PF2E.RuleElement.Lifesteal", "Lifesteal");
}

function getSystemConfig() {
	return CONFIG[game.system.id.toUpperCase()] ?? CONFIG.PF2E;
}

function registerLifestealRuleElement({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const RuleElement = system?.RuleElement;
	const registry = system?.RuleElements;
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
		if (registry.custom[RULE_KEY] !== LifestealRuleElement) {
			console.error(`${MODULE_ID} | Could not register ${RULE_KEY}: that custom Rule Element key is already in use`);
		}
		return;
	}

	LifestealRuleElement = class LifestealRuleElement extends RuleElement {
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
				value: new ResolvableValueField({
					required: true,
					nullable: false,
					initial: 1
				}),
				lifestealThreshold: new ResolvableValueField({
					required: false,
					nullable: false,
					initial: 20
				}),
				mode: new fields.StringField({
					required: false,
					nullable: false,
					initial: "threshold",
					choices: {
						threshold: "Threshold",
						flat: "Flat",
						percent: "Percent"
					}
				}),
				selector: new fields.StringField({
					required: false,
					nullable: true,
					initial: undefined
				})
			};
		}
	};

	registry.custom[RULE_KEY] = LifestealRuleElement;
}

function currentHealthPool(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp) return null;

	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	const stamina = staminaEnabled ? Number(hp.sp?.value ?? 0) : 0;
	return Number(hp.value ?? 0) + Number(hp.temp ?? 0) + stamina;
}

function isAtFullHealth(actor) {
	const hp = actor?.attributes?.hp;
	if (!hp || Number(hp.value ?? 0) < Number(hp.max ?? 0)) return false;
	const staminaEnabled =
		game[game.system.id]?.settings?.variants?.stamina ?? game.pf2e?.settings?.variants?.stamina;
	return !staminaEnabled || !hp.sp ||
		Number(hp.sp.value ?? 0) >= Number(hp.sp.max ?? Number.NaN);
}

export function getDamageSelectors(damage, item = null) {
	const cached = damage && typeof damage === "object"
		? damageSelectorCache.get(damage)
		: null;
	if (cached?.item === item) return new Set(cached.selectors);

	const selectors = new Set(["damage-received"]);
	if (item?.isOfType?.("weapon", "melee")) selectors.add("strike-damage");
	const modifiers = damage?.options?.damage?.modifiers;
	if (Array.isArray(modifiers)) {
		for (const modifier of modifiers) {
			if (Array.isArray(modifier.domains)) {
				for (const selector of modifier.domains) selectors.add(selector);
			}
		}
	}

	let sourceMessage = null;
	let latestMatchingMessage = null;
	for (const message of game.messages?.contents ?? []) {
		if (message.rolls?.includes(damage)) {
			sourceMessage = message;
			break;
		}
		if (
			item?.uuid &&
			message.item?.uuid === item.uuid &&
			message.rolls?.some(roll => roll?.constructor === damage?.constructor) &&
			(!latestMatchingMessage || message.timestamp > latestMatchingMessage.timestamp)
		) {
			latestMatchingMessage = message;
		}
	}
	sourceMessage ??= latestMatchingMessage;
	const domains = foundry.utils.getProperty(
		sourceMessage,
		`flags.${game.system.id}.context.domains`
	);
	if (Array.isArray(domains)) {
		for (const selector of domains) selectors.add(selector);
	}

	if (sourceMessage && damage && typeof damage === "object") {
		damageSelectorCache.set(damage, { item, selectors: new Set(selectors) });
	}
	return selectors;
}

export function getDamageRollOptions(damage, rollOptions) {
	const options = rollOptions instanceof Set
		? new Set(rollOptions)
		: Array.isArray(rollOptions)
			? new Set(rollOptions)
			: new Set();
	for (const instance of damage?.instances ?? []) {
		if (typeof instance.type === "string" && instance.type.length > 0) {
			options.add(`damage:type:${instance.type}`);
		}
		if (instance.formalDescription && Symbol.iterator in Object(instance.formalDescription)) {
			for (const option of instance.formalDescription) {
				if (typeof option === "string") options.add(option);
			}
		}
	}
	return options;
}

export function getDamageModifierBreakdown(damageRoll, fallback = []) {
	const breakdown = damageRoll?.options?.damage?.breakdown;
	if (!breakdown || typeof breakdown !== "object") return fallback;
	const degree = damageRoll.options.degreeOfSuccess;
	const outcome = ["criticalFailure", "failure", "success", "criticalSuccess"][degree] ?? "success";
	const entries = breakdown[outcome] ?? breakdown.success ?? [];
	if (!Array.isArray(entries)) return fallback;
	const modifiers = entries.filter(entry =>
		typeof entry === "string" && entry.trim() && !/^\(?\d*d\d+/i.test(entry.trim())
	);
	return modifiers.length ? modifiers : fallback;
}

function hasSpecialDamageOption(options) {
	const values = options instanceof Set ? [...options] : Array.isArray(options) ? options :
		typeof options === "string" ? [options] : [];
	const damageOptions = values
		.filter(option => typeof option === "string")
		.map(option => option.startsWith("item:damage:") ? option.slice("item:".length) : option);
	const hasDamageOption = damageOptions.includes("damage") || damageOptions.some(option =>
		option.startsWith("damage:type:") || option.startsWith("damage:category:")
	);
	if (!hasDamageOption) return false;

	const damageTypeOptions = damageOptions.filter(option => option.startsWith("damage:type:"));
	const damageCategoryOptions = damageOptions.filter(option => option.startsWith("damage:category:"));
	const excludedTypes = ["physical", "bludgeoning", "slashing", "piercing"];
	if (
		damageTypeOptions.some(option => !excludedTypes.some(type => option === `damage:type:${type}`)) ||
		damageCategoryOptions.some(option => option !== "damage:category:physical")
	) {
		return true;
	}

	return damageTypeOptions.length === 0 &&
		damageCategoryOptions.length === 0;
}

function getLifestealHealing(attacker, damageRoll, damage, rollOptions, selectors) {
	if (damage <= 0) return { healing: 0, sources: [] };

	const instances = Array.isArray(damageRoll?.instances) ? damageRoll.instances : null;
	const instanceTotal = instances?.reduce((total, instance) => {
		const value = Number(instance.total);
		return Number.isFinite(value) && value > 0 ? total + value : total;
	}, 0) ?? 0;
	const damageScale = instanceTotal > 0 ? damage / instanceTotal : 1;
	const physicalDamageTypes = new Set(["physical", "bludgeoning", "piercing", "slashing"]);
	const seenSlugs = new Set();
	const sources = [];
	for (const rule of Array.isArray(attacker?.rules) ? attacker.rules : []) {
		const selectorMatches = rule.selector === "special-damage"
			? hasSpecialDamageOption(rollOptions)
			: !rule.selector || selectors.has(rule.selector);
		if (
			rule.key !== RULE_KEY ||
			rule.ignored ||
			!selectorMatches ||
			!testRuleElementPredicate(rule, rollOptions)
		) {
			continue;
		}

		const damageByType = new Map();
		if (instances?.length > 0) {
			for (const instance of instances) {
				const instanceDamage = Number(instance.total);
				if (!Number.isFinite(instanceDamage) || instanceDamage <= 0) continue;
				const isSpecial = !physicalDamageTypes.has(instance.type);
				if (rule.selector === "special-damage" ? !isSpecial : rule.selector && isSpecial) continue;
				damageByType.set(
					instance.type,
					(damageByType.get(instance.type) ?? 0) + instanceDamage * damageScale
				);
			}
		} else {
			damageByType.set("untyped", damage);
		}
		if (damageByType.size === 0) continue;

		const slug = typeof rule.slug === "string" ? rule.slug.trim() : "";
		if (slug && seenSlugs.has(slug)) continue;
		const value = Number(rule.resolveValue(rule.value, 0));
		if (!Number.isFinite(value) || value <= 0) continue;

		let healing;
		switch (rule.mode ?? "threshold") {
			case "flat":
				healing = value;
				break;
			case "percent":
				healing = [...damageByType.values()].reduce(
					(total, typeDamage) => total + Math.floor(typeDamage * value),
					0
				);
				break;
			case "threshold":
			default: {
				const threshold = Number(rule.resolveValue(rule.lifestealThreshold ?? 20, 20));
				if (!Number.isFinite(threshold) || threshold <= 0) {
					console.error(`${MODULE_ID} | Skipping ${RULE_KEY} on ${rule.item?.name ?? "unknown item"}: lifestealThreshold must resolve to a positive number`);
					continue;
				}
				healing = [...damageByType.values()].reduce((total, typeDamage) =>
					total + Math.max(
						Math.floor((typeDamage / threshold) * value),
						typeDamage < threshold ? 1 : 0
					), 0);
			}
		}
		if (!Number.isFinite(healing) || healing <= 0) continue;

		if (slug) seenSlugs.add(slug);
		const sourceRule = rule.item?.system?.rules?.[rule.sourceIndex];
		const label = typeof sourceRule?.label === "string" && sourceRule.label.trim()
			? sourceRule.label.trim()
			: rule.item?.name ?? rule.label ?? "Lifesteal";
		sources.push({ label, healing });
	}

	return {
		healing: sources.reduce((total, source) => total + source.healing, 0),
		sources
	};
}

function findHealingCard(previousMessageIds, attacker) {
	return [...(game.messages?.contents ?? [])]
		.filter(message => {
			if (
				previousMessageIds.has(message.id) ||
				foundry.utils.getProperty(message, "flags.pf2e.context.type") !== "damage-taken"
			) {
				return false;
			}

			const appliedActorUuid = foundry.utils.getProperty(message, "flags.pf2e.appliedDamage.uuid");
			return (
				appliedActorUuid === attacker.uuid ||
				message.speaker?.actor === attacker.id
			);
		})
		.sort((left, right) => right.timestamp - left.timestamp)[0] ?? null;
}

async function addLifestealTooltip(message, sources, healingEffectiveness = []) {
	const container = document.createElement("div");
	container.innerHTML = message.content ?? "";
	const damageTaken = container.querySelector(".damage-taken");
	if (!damageTaken) {
		console.error(`${MODULE_ID} | Could not add Lifesteal tooltip: healing card has no damage-taken section`);
		return;
	}

	let indicator = damageTaken.querySelector(".lifesteal-iwr");
	if (!indicator) {
		indicator = document.createElement("span");
		indicator.classList.add("iwr", "lifesteal-iwr");
		indicator.dataset.visibility = "all";
		const icon = document.createElement("i");
		icon.classList.add("fa-solid", "fa-circle-info", "small");
		indicator.append(icon);
	}

	indicator.dataset.tooltipClass = "pf2e";
	const tooltip = document.createElement("ul");
	for (const source of sources) {
		const entry = document.createElement("li");
		entry.textContent = `${source.label}: +${source.healing}`;
		tooltip.append(entry);
	}
	for (const source of healingEffectiveness) {
		const entry = document.createElement("li");
		entry.textContent = `${source.label} ${source.bonus > 0 ? "+" : ""}${source.bonus}`;
		tooltip.append(entry);
	}
	indicator.dataset.tooltipHtml = tooltip.outerHTML;
	const revertButton = damageTaken.querySelector(".revert-damage");
	if (revertButton) {
		damageTaken.insertBefore(indicator, revertButton);
	} else {
		damageTaken.append(indicator);
	}

	await message.update({ content: container.innerHTML });
}

async function healDamageDealer(
	attacker,
	amount,
	parentParams,
	sources,
	{ findCard = true, modifiers = [], healingEffectiveness = [] } = {}
) {
	const hp = attacker?.attributes?.hp;
	if (!hp || !Number.isFinite(amount) || amount < 0) return { healing: 0, card: null };

	const token = attacker.token ?? attacker.getActiveTokens?.()[0]?.document;
	if (!token || typeof attacker.applyDamage !== "function") {
		const healing = Math.min(amount, Math.max(hp.max - hp.value, 0));
		if (healing <= 0) {
			if (isAtFullHealth(attacker) || healingEffectiveness.length > 0) {
				const effect = {
					type: "lifesteal",
					label: sources.map(source => source.label).join(", "),
					amount: 0,
					sources: sources.map(source => ({ ...source, healing: 0 })),
					healingEffectiveness,
					targetName: attacker.name,
					actorUuid: attacker.uuid,
					actorId: attacker.id,
					tokenId: null,
					fullHealth: isAtFullHealth(attacker),
					modifiers
				};
				const transaction = damageTransactionState.params.get(parentParams);
				if (transaction && !transaction.effects.includes(effect)) transaction.effects.push(effect);
			}
			return { healing: 0, card: null };
		}
		await attacker.update({ "system.attributes.hp.value": hp.value + healing });
		if (healingEffectiveness.length > 0) {
			const transaction = damageTransactionState.params.get(parentParams);
			if (transaction) {
				let remainingHealing = healing;
				const appliedSources = sources
					.map(source => {
						const sourceHealing = Math.min(source.healing, remainingHealing);
						remainingHealing -= sourceHealing;
						return { ...source, healing: sourceHealing };
					})
					.filter(source => source.healing > 0);
				transaction.effects.push({
					type: "lifesteal",
					label: sources.map(source => source.label).join(", "),
					amount: healing,
					sources: appliedSources,
					healingEffectiveness,
					targetName: attacker.name,
					actorUuid: attacker.uuid,
					actorId: attacker.id,
					tokenId: null,
					modifiers
				});
			}
		}
		return { healing, card: null };
	}

	const healthBefore = currentHealthPool(attacker);
	const previousMessageIds = findCard
		? new Set((game.messages?.contents ?? []).map(message => message.id))
		: null;
	const effect = {
		type: "lifesteal",
		label: sources.map(source => source.label).join(", "),
		amount,
		sources: sources.map(source => ({ ...source })),
		healingEffectiveness,
		targetName: token.name,
		modifiers
	};
	const transaction = damageTransactionState.params.get(parentParams);
	if (
		healingEffectiveness.length > 0 &&
		transaction &&
		!transaction.effects.includes(effect)
	) {
		transaction.effects.push(effect);
	}
	await applyDamageInTransaction(attacker, {
		damage: -amount,
		token,
		skipIWR: true,
		vursHealingEffectivenessApplied: true
	}, parentParams, effect);
	const healthAfter = currentHealthPool(attacker);
	const healing = healthBefore !== null && healthAfter !== null
		? Math.max(0, healthAfter - healthBefore)
		: 0;
	effect.amount = healing;
	effect.fullHealth = healing === 0 && isAtFullHealth(attacker);
	if (effect.fullHealth) effect.appliedDamage = null;
	let remainingHealing = healing;
	effect.sources = sources
		.map(source => {
			const sourceHealing = Math.min(source.healing, remainingHealing);
			remainingHealing -= sourceHealing;
			return { ...source, healing: sourceHealing };
		})
		.filter(source => source.healing > 0);
	if (effect.fullHealth) {
		effect.sources = sources.map(source => ({ ...source, healing: 0 }));
		const transaction = damageTransactionState.params.get(parentParams);
		if (transaction && !transaction.effects.includes(effect)) {
			effect.actorUuid = attacker.uuid;
			effect.actorId = attacker.id;
			effect.tokenId = token.document?.id ?? token.id ?? null;
			transaction.effects.push(effect);
		}
	}
	return { healing, card: previousMessageIds ? findHealingCard(previousMessageIds, attacker) : null };
}

async function applyLifesteal(actor, wrapped, args) {
	const params = args[0];
	if (!params || typeof params !== "object" || activeDamageParams.has(params)) {
		return wrapped(...args);
	}

	const damage = typeof params?.damage === "number" ? params.damage : params?.damage?.total;
	const attacker = params?.item?.actor ?? params?.item?.parent;
	if (typeof damage !== "number" || damage <= 0 || !attacker) {
		return wrapped(...args);
	}

	activeDamageParams.add(params);
	try {
		const targetActor = params.token?.actor ?? actor;
		const healthBefore = currentHealthPool(targetActor);
		const result = await wrapped(...args);
		const healthAfter = currentHealthPool(targetActor);
		if (healthBefore === null || healthAfter === null) return result;

		const damageApplied = Math.max(0, healthBefore - healthAfter);
		if (damageApplied === 0) return result;

		const rollOptions = getDamageRollOptions(params.damage, params.rollOptions);
		const selectors = getDamageSelectors(params.damage, params.item);
		const { healing, sources } = getLifestealHealing(
			attacker,
			params.damage,
			damage,
			rollOptions,
			selectors
		);
		if (healing <= 0) return result;

		const healingEffectiveness = getLifestealHealingEffectiveness(
			attacker,
			healing,
			rollOptions,
			selectors
		);
		const healingEffectivenessSources = healingEffectiveness.sources.map(source => ({
			label: source.label,
			bonus: source.bonus
		}));
		const adjustedHealing = healingEffectiveness.total;
		const modifiers = getDamageModifierBreakdown(params.damage, params.vursDamageModifiers);
		const transaction = damageTransactionState.params.get(params);
		if (transaction) {
			transaction.lifestealRequests ??= [];
			transaction.lifestealRequests.push({
				attacker,
				healing: adjustedHealing,
				sources,
				modifiers,
				healingEffectiveness: healingEffectivenessSources
			});
			return result;
		}

		const { healing: healed, card } = await healDamageDealer(
			attacker,
			adjustedHealing,
			params,
			sources,
			{ modifiers, healingEffectiveness: healingEffectivenessSources }
		);
		if (healed > 0 && card) {
			let remainingHealing = healed;
			const appliedSources = sources
				.map(source => {
					const healing = Math.min(source.healing, remainingHealing);
					remainingHealing -= healing;
					return { ...source, healing };
				})
				.filter(source => source.healing > 0);
			await addLifestealTooltip(card, appliedSources, healingEffectivenessSources);
		}
		return result;
	} finally {
		activeDamageParams.delete(params);
	}
}

damageHandlers.add(applyLifesteal);

function applyDamageHandlers(actor, wrapped, args) {
	const handlers = [...damageHandlers];
	const params = args[0];
	let transaction = params && typeof params === "object"
		? damageTransactionState.params.get(params)
		: null;
	const isRoot = !transaction;
	if (isRoot && params && typeof params === "object") {
		const rootActor = params.token?.actor ?? actor;
		const rootTokenId = params.token?.document?.id ?? params.token?.id ?? null;
		transaction = {
			rootActorUuid: rootActor?.uuid,
			rootActorId: rootActor?.id,
			rootTokenId,
			rootMessageId: null,
			rootMessagePending: false,
			primaryDamage: null,
			pending: [],
			effects: [],
			rootParams: params,
			lifestealRequests: []
		};
		damageTransactionState.params.set(params, transaction);
		damageTransactionState.active.add(transaction);
	}
	const dispatch = (index, forwardedArgs) => {
		const handler = handlers[index];
		return handler
			? handler(actor, (...nextArgs) => dispatch(index + 1, nextArgs), forwardedArgs)
			: wrapped(...forwardedArgs);
	};
	let result;
	try {
		result = dispatch(0, args);
	} catch (error) {
		if (isRoot && transaction) {
			damageTransactionState.active.delete(transaction);
			damageTransactionState.params.delete(params);
		}
		throw error;
	}
	if (!isRoot || !transaction) return result;
	return Promise.resolve(result).finally(async () => {
		try {
			await finalizeDamageTransaction(transaction);
		} finally {
			damageTransactionState.active.delete(transaction);
			damageTransactionState.params.delete(params);
		}
	});
}

function installLifestealDamageHandling() {
	installDamageTransactionHooks();
	const config = getSystemConfig();
	const actorClasses = config?.Actor?.documentClasses ?? {};
	const actorClass = CONFIG.Actor?.documentClass;
	const candidates = new Set([
		actorClass,
		...Object.values(actorClasses)
	].filter(candidate => typeof candidate?.prototype?.applyDamage === "function"));

	for (const candidate of candidates) {
		const actorType = Object.entries(actorClasses).find(([, value]) => value === candidate)?.[0];
		const target = actorType
			? `CONFIG.${game.system.id.toUpperCase()}.Actor.documentClasses.${actorType}.prototype.applyDamage`
			: candidate === actorClass
				? "CONFIG.Actor.documentClass.prototype.applyDamage"
				: null;
		if (!target || registeredDamageTargets.has(target)) continue;

		try {
			if (globalThis.libWrapper?.register) {
				globalThis.libWrapper.register(
					MODULE_ID,
					target,
					function (wrapped, ...args) {
						return applyDamageHandlers(this, wrapped, args);
					},
					"WRAPPER"
				);
			} else {
				const prototype = candidate.prototype;
				const original = prototype.applyDamage;
				prototype.applyDamage = function (...args) {
					return applyDamageHandlers(
						this,
						(...wrappedArgs) => original.apply(this, wrappedArgs),
						args
					);
				};
			}
			registeredDamageTargets.add(target);
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to install Lifesteal damage handling for ${target}`, error);
		}
	}
}

function initializeLifesteal() {
	registerLifestealLocalization();
	registerLifestealRuleElement();
	installLifestealDamageHandling();
}

Hooks.once("init", registerLifestealLocalization);
Hooks.once("init", () => registerLifestealRuleElement({ quiet: true }));
Hooks.once("setup", registerLifestealRuleElement);
Hooks.once("pf2e.systemReady", registerLifestealLocalization);
Hooks.once("sf2e.systemReady", registerLifestealLocalization);
Hooks.once("pf2e.systemReady", initializeLifesteal);
Hooks.once("sf2e.systemReady", initializeLifesteal);
Hooks.once("ready", initializeLifesteal);
