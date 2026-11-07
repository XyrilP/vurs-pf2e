import { actorUsesAgnosticVurs, actorUsesVursSystem } from "./systemModes.js";
import { getAttributePresentation } from "./consolidatedSkills.js";

const MODULE_ID = "vurs-pf2e";
const NPC_CONFIGURATION_PATH = "flags.vurs.npcConfiguration";
const FOLLOWER_OWNERSHIP_PATH = "flags.vurs.followerOwnershipPermissions";
const FOLLOWER_CONTROL_PATH = "flags.vurs.followerControl";
const FOLLOWER_CONTROL_SETTING = "allowPlayersToControlFollowers";
const PLAYER_TOKEN_RING_COLOR_SETTING = "colorTokenRingsByPlayer";
const MIN_NPC_LEVEL = -1;
const MAX_NPC_LEVEL = 100;
const OWNER_PERMISSION_LEVEL = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
const NPC_FOLLOWER_TRAIT_PATCH = Symbol.for(`${MODULE_ID}.npcFollowerTraitPatch`);
const NPC_RELATIONSHIP_PANEL_STATE = new Map();
const NPC_RELATIONSHIP_PANELS = new Map();
const SCHEDULED_FOLLOWER_SYNCS = new Map();
const FOLLOWER_ACTOR_OPERATION_QUEUES = new Map();
const GM_SELECTED_TOKEN_UUIDS = new Map();
const LOCAL_FOLLOWER_CONTROL_REQUESTS = new Map();
const LOCAL_FOLLOWER_CONTROL_RELEASES = new Set();
const FOLLOWER_CONTROL_RELEASE_TIMERS = new Map();
// libWrapper permits only one wrapper per module per target, and both this
// feature and the Negative HP preparation need NPC prepareDerivedData. All
// post-preparation logic joins this shared handler set; a single dispatcher
// wrapper registered on first use runs every handler in order.
const NPC_PREPARE_DERIVED_HANDLERS_KEY = Symbol.for(`${MODULE_ID}.npcPrepareDerivedDataHandlers`);
const NPC_PREPARE_DERIVED_DISPATCHER_KEY = Symbol.for(`${MODULE_ID}.npcPrepareDerivedDataDispatcher`);
const DIRECT_SCALING_STAT_PATHS = Object.freeze([
	"system.attributes.ac.value",
	"system.saves.fortitude.value",
	"system.saves.reflex.value",
	"system.saves.will.value",
	"system.perception.mod",
	"system.abilities.str.mod",
	"system.abilities.dex.mod",
	"system.abilities.con.mod",
	"system.abilities.int.mod",
	"system.abilities.wis.mod",
	"system.abilities.cha.mod"
]);
const NPC_CONFIGURATION_RESOURCES = Object.freeze([
	{ key: "staminaPoints", label: "Stamina Points" },
	{ key: "actionPoints", label: "Action Points" },
	{ key: "reactions", label: "Reactions" },
	{ key: "tacticPoints", label: "Tactic Points" },
	{ key: "styleRank", label: "Style Rank" },
	{ key: "karmaPoints", label: "Karma Points" },
	{ key: "budgetPoints", label: "Budget Points" },
	{ key: "magicPoints", label: "Magic Points" }
]);
const NPC_RELATIONSHIP_STATISTICS = Object.freeze([
	{ key: "bond", label: "Bond", attribute: "str", tooltip: "The strength and depth of the connection between this NPC and the other person." },
	{ key: "flexibility", label: "Flexibility", attribute: "dex", tooltip: "How readily this NPC adapts, compromises, and changes their approach in the relationship." },
	{ key: "loyalty", label: "Loyalty", attribute: "con", tooltip: "How dependable and committed this NPC is to the relationship and its people." },
	{ key: "cohesion", label: "Cohesion", attribute: "int", tooltip: "How well this NPC cooperates, communicates, and works in sync with the other person." },
	{ key: "affection", label: "Affection", attribute: "cha", tooltip: "The warmth, fondness, and care this NPC feels for the other person." },
	{ key: "hope", label: "Hope", attribute: "wis", tooltip: "How optimistic this NPC is about the relationship and its future." }
]);
const NPC_LEVEL_SCALING_GROUPS = Object.freeze([
	{
		key: "attacks",
		label: "Attacks",
		fields: [{ key: "strikeAttack", label: "Strike attack bonus", defaultValue: 1.45, legacyKey: "attack" }]
	},
	{
		key: "damage",
		label: "Damage",
		fields: [
			{ key: "damageDice", label: "Damage dice", defaultValue: 0.25 },
			{ key: "damageBonus", label: "Damage bonus", defaultValue: 1.4, legacyKey: "damage" }
		]
	},
	{
		key: "defenses",
		label: "Defenses",
		fields: [
			{ key: "ac", label: "Armor Class", defaultValue: 1.475 },
			{ key: "saveFortitude", label: "Fortitude", defaultValue: 1.4, legacyKey: "saves" },
			{ key: "saveReflex", label: "Reflex", defaultValue: 1.4, legacyKey: "saves" },
			{ key: "saveWill", label: "Will", defaultValue: 1.4, legacyKey: "saves" },
			{ key: "perception", label: "Perception", defaultValue: 1.4 }
		]
	},
	{
		key: "abilities",
		label: "Attributes",
		fields: [
			{ key: "abilityStr", label: "Strength", defaultValue: 0.3, legacyKey: "abilities" },
			{ key: "abilityDex", label: "Dexterity", defaultValue: 0.3, legacyKey: "abilities" },
			{ key: "abilityCon", label: "Constitution", defaultValue: 0.3, legacyKey: "abilities" },
			{ key: "abilityInt", label: "Intelligence", defaultValue: 0.3, legacyKey: "abilities" },
			{ key: "abilityWis", label: "Wisdom", defaultValue: 0.3, legacyKey: "abilities" },
			{ key: "abilityCha", label: "Charisma", defaultValue: 0.3, legacyKey: "abilities" }
		]
	},
	{
		key: "weaknessesAndResistances",
		label: "Weaknesses and Resistances",
		fields: [
			{ key: "weakness", label: "Weaknesses", defaultValue: 1.4, legacyKey: "damage" },
			{ key: "resistance", label: "Resistances", defaultValue: 1.4, legacyKey: "damage" }
		]
	},
	{
		key: "skills",
		label: "Skills",
		fields: []
	},
	{
		key: "inlineRolls",
		label: "Inline Rolls",
		fields: [
			{ key: "inlineDamage", label: "Inline damage", defaultValue: 1, toggleOnly: true },
			{ key: "inlineDc", label: "Inline DCs", defaultValue: 1, toggleOnly: true }
		]
	},
	{
		key: "health",
		label: "Health",
		fields: [
			{ key: "hp", label: "Hit Points %", defaultValue: 1.15 },
			{ key: "hpPerLevel", label: "Flat HP per Level", defaultValue: 0, defaultEnabled: false }
		]
	},
	{
		key: "spellcasting",
		label: "Spellcasting",
		fields: [
			{ key: "spellAttack", label: "Spell attack bonus", defaultValue: 1.35, legacyKey: "spellcasting" },
			{ key: "spellDc", label: "Spell DC", defaultValue: 1.35, legacyKey: "spellcasting" }
		]
	}
]);
const NPC_LEVEL_SCALING_FIELDS = Object.freeze(
	NPC_LEVEL_SCALING_GROUPS.flatMap(group => group.fields)
);

export function getNpcPlayResourceMaxFormula(actor, resourceKey) {
	if (!isNpcActor(actor)) return null;
	const formula = foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.formulas.${resourceKey}`);
	return typeof formula === "string" && formula.trim() ? formula.trim() : null;
}

export function evaluateNpcPlayResourceMaxFormula(actor, resourceKey, formula = getNpcPlayResourceMaxFormula(actor, resourceKey)) {
	if (!formula) return null;
	const roll = new Roll(formula, actor.getRollData());
	const total = roll.evaluateSync().total;
	if (!Number.isFinite(total)) {
		throw new Error(`NPC ${actor.name} has a non-finite ${resourceKey} maximum formula result.`);
	}
	const maximum = Math.floor(total);
	if (!Number.isSafeInteger(maximum)) {
		throw new Error(`NPC ${actor.name} has an unsafe ${resourceKey} maximum formula result.`);
	}
	return Math.max(0, maximum);
}

export function openNpcConfiguration(actor, selectedTab = "levels") {
	if (!isNpcActor(actor)) return;
	if (!actor.isOwner) {
		ui.notifications.warn("You do not have permission to configure this NPC.");
		return;
	}
	new NpcConfigurationApplication(actor, selectedTab).render({ force: true });
}

export function addNpcConfigurationButton(root, actor) {
	if (!(root instanceof HTMLElement) || !isNpcActor(actor)) return;
	const raritySizeControls = [...root.querySelectorAll(
		".rarity-size .tags.paizo-style, .npc-body > header .tags.paizo-style"
	)].find(controls => controls.querySelector("select.tag.rarity") &&
		controls.querySelector("select.tag.size"));
	if (!raritySizeControls || raritySizeControls.querySelector(".vurs-npc-configuration-launch")) return;
	const selector = document.createElement("select");
	selector.className = "tag vurs-npc-configuration-launch";
	selector.setAttribute("aria-label", "NPC Configuration");
	selector.innerHTML = `
		<option value="" selected disabled>NPC Configuration</option>
		<option value="levels">Leveled NPC</option>
		<option value="relationships">Relationship</option>
		<option value="follower">Follower</option>
		<option value="resources">Play Resources</option>
	`;
	selector.addEventListener("change", () => {
		if (!selector.value) return;
		openNpcConfiguration(actor, selector.value);
		selector.value = "";
	});
	raritySizeControls.append(selector);
}

export function renderNpcRelationshipStatistics(root, actor, app = null) {
	if (!(root instanceof HTMLElement) || !isNpcActor(actor)) return;
	const sheetWindow = root.closest(".window-app") ?? root;
	const actorKey = actor.uuid ?? actor.id;
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH) ?? {};
	const statistics = getRelationshipStatistics(configuration);
	let panel = NPC_RELATIONSHIP_PANELS.get(actorKey);
	if (!panel || panel.sheetWindow !== sheetWindow) {
		panel?.cleanup();
		const wrapper = document.createElement("div");
		wrapper.className = "vurs-npc-relationship-drawer";
		const section = document.createElement("section");
		section.className = "vurs-npc-relationship-statistics";
		const title = document.createElement("h2");
		title.textContent = "Relationship Statistics";
		const content = document.createElement("div");
		content.className = "vurs-npc-relationship-content";
		content.append(document.createElement("ul"));
		const rank = document.createElement("p");
		rank.className = "vurs-npc-relationship-rank";
		content.append(rank);
		section.append(title, content);
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = "vurs-npc-relationship-toggle";
		const setExpanded = expanded => {
			NPC_RELATIONSHIP_PANEL_STATE.set(actorKey, expanded);
			wrapper.classList.toggle("expanded", expanded);
			toggle.setAttribute("aria-expanded", String(expanded));
			toggle.setAttribute("aria-label", expanded ? "Hide Relationship Statistics" : "Show Relationship Statistics");
			const direction = wrapper.classList.contains("side-right")
				? expanded ? "right" : "left"
				: expanded ? "left" : "right";
			toggle.innerHTML = `<i class="fa-solid fa-chevron-${direction}" aria-hidden="true"></i><span>Relationship</span>`;
		};
		const closeWhenAnotherDrawerOpens = event => {
			if (event.detail === wrapper || NPC_RELATIONSHIP_PANEL_STATE.get(actorKey) !== true) return;
			setExpanded(false);
		};
		document.addEventListener("vurs:drawer-open", closeWhenAnotherDrawerOpens);
		toggle.addEventListener("click", () => {
			const expanded = NPC_RELATIONSHIP_PANEL_STATE.get(actorKey) !== true;
			if (expanded) document.dispatchEvent(new CustomEvent("vurs:drawer-open", { detail: wrapper }));
			setExpanded(expanded);
		});
		wrapper.append(section, toggle);
		document.body.append(wrapper);

		const updatePosition = () => {
			if (!sheetWindow.isConnected) {
				panel.cleanup();
				return;
			}
			const minimized = panel.app?._minimized === true || sheetWindow.classList.contains("minimized");
			wrapper.hidden = minimized;
			if (minimized) {
				setExpanded(false);
				return;
			}
			const bounds = sheetWindow.getBoundingClientRect();
			const sideRight = bounds.left < section.getBoundingClientRect().width + 36;
			wrapper.classList.toggle("side-right", sideRight);
			if (sideRight) {
				wrapper.style.left = "";
				wrapper.style.right = `${Math.max(0, window.innerWidth - bounds.right - 34)}px`;
			} else {
				wrapper.style.right = "";
				wrapper.style.left = `${bounds.left - 34}px`;
			}
			wrapper.style.top = `${Math.max(8, Math.min(bounds.top + 140, window.innerHeight - 190))}px`;
			const expanded = NPC_RELATIONSHIP_PANEL_STATE.get(actorKey) === true;
			const direction = sideRight
				? expanded ? "right" : "left"
				: expanded ? "left" : "right";
			toggle.innerHTML = `<i class="fa-solid fa-chevron-${direction}" aria-hidden="true"></i><span>Relationship</span>`;
			const sheetZIndex = Number.parseInt(getComputedStyle(sheetWindow).zIndex, 10);
			wrapper.style.zIndex = String(Number.isFinite(sheetZIndex) ? Math.max(1, sheetZIndex - 1) : 99);
		};
		const observer = new MutationObserver(updatePosition);
		observer.observe(sheetWindow, { attributes: true, attributeFilter: ["style", "class"] });
		const parentObserver = new MutationObserver(() => {
			if (!sheetWindow.isConnected) panel.cleanup();
		});
		if (sheetWindow.parentElement) parentObserver.observe(sheetWindow.parentElement, { childList: true });
		const resizeObserver = typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver(updatePosition);
		resizeObserver?.observe(sheetWindow);
		window.addEventListener("resize", updatePosition);
		panel = {
			app,
			sheetWindow,
			wrapper,
			updatePosition,
			relationshipSignature: null,
			cleanup() {
				observer.disconnect();
				parentObserver.disconnect();
				resizeObserver?.disconnect();
				window.removeEventListener("resize", updatePosition);
				document.removeEventListener("vurs:drawer-open", closeWhenAnotherDrawerOpens);
				wrapper.remove();
				NPC_RELATIONSHIP_PANELS.delete(actorKey);
			}
		};
		NPC_RELATIONSHIP_PANELS.set(actorKey, panel);
	}

	panel.app = app ?? panel.app;
	const { wrapper } = panel;
	applyNpcRelationshipDrawerTheme(panel, root);
	const section = wrapper.querySelector(".vurs-npc-relationship-statistics");
	const content = section.querySelector(".vurs-npc-relationship-content");
	const toggle = wrapper.querySelector(".vurs-npc-relationship-toggle");
	const expanded = NPC_RELATIONSHIP_PANEL_STATE.get(actorKey) === true;
	wrapper.classList.toggle("expanded", expanded);
	toggle.setAttribute("aria-expanded", String(expanded));
	toggle.setAttribute("aria-label", expanded ? "Hide Relationship Statistics" : "Show Relationship Statistics");
	const direction = wrapper.classList.contains("side-right")
		? expanded ? "right" : "left"
		: expanded ? "left" : "right";
	toggle.innerHTML = `<i class="fa-solid fa-chevron-${direction}" aria-hidden="true"></i><span>Relationship</span>`;

	const rows = NPC_RELATIONSHIP_STATISTICS.map(field => {
		const presentation = getAttributePresentation(field.attribute, actor);
		return {
			field,
			presentation,
			value: String(readFiniteNumber(statistics[field.key]) ?? 0)
		};
	});
	const relationshipSignature = JSON.stringify(rows.map(({ value, presentation }) => [
		value,
		presentation?.color,
		presentation?.icon
	]));
	if (panel.relationshipSignature !== relationshipSignature) {
		const list = content.querySelector("ul");
		list.replaceChildren(...rows.map(({ field, presentation, value: statValue }) => {
			const row = document.createElement("li");
			row.className = "vurs-npc-relationship-stat";
			row.dataset.tooltip = field.tooltip;
			const label = document.createElement("span");
			label.className = "vurs-npc-relationship-stat-label";
			if (presentation?.color) label.style.setProperty("--npc-config-attribute-color", presentation.color);
			if (presentation?.icon) {
				const icon = document.createElement("i");
				icon.className = `fa-solid fa-${presentation.icon}`;
				icon.setAttribute("aria-hidden", "true");
				label.append(icon);
			}
			label.append(document.createTextNode(field.label));
			const value = document.createElement("span");
			value.className = "vurs-npc-relationship-stat-value";
			value.textContent = statValue;
			row.append(label, value);
			return row;
		}));
		panel.relationshipSignature = relationshipSignature;
	}
	const relationshipRank = getRelationshipRank(statistics);
	const rankOutput = content.querySelector(".vurs-npc-relationship-rank");
	const rankText = `Relationship Rank: ${Number(relationshipRank.toFixed(2))}`;
	if (rankOutput.textContent !== rankText) rankOutput.textContent = rankText;
	panel.updatePosition();
}

function applyNpcRelationshipDrawerTheme(panel, root) {
	const find = (container, selector) => container?.matches?.(selector)
		? container
		: container?.querySelector?.(selector);
	const themeSource = find(root, "form.crb-style, form.actor, form")
		?? find(panel.sheetWindow, "form.crb-style, form.actor, form")
		?? panel.sheetWindow;
	const sidebar = find(panel.sheetWindow, "form .sidebar") ?? find(root, "form .sidebar");
	const computedTheme = getComputedStyle(themeSource);
	for (let index = 0; index < computedTheme.length; index += 1) {
		const property = computedTheme[index];
		if (property.startsWith("--")) {
			panel.wrapper.style.setProperty(property, computedTheme.getPropertyValue(property));
		}
	}

	const sidebarStyle = getComputedStyle(sidebar ?? themeSource);
	const bodyBackgroundColor = computedTheme.getPropertyValue("--bg").trim()
		|| getComputedStyle(panel.sheetWindow.querySelector(".window-content, .application-content") ?? panel.sheetWindow).backgroundColor;
	const bodyTextColor = computedTheme.getPropertyValue("--text-dark").trim()
		|| getComputedStyle(themeSource).color;
	const npcBackgroundStyle = getNpcSheetBackgroundStyle(panel.sheetWindow, themeSource);
	const hasSidebarBanner = sidebarStyle.backgroundImage !== "none";
	const sidebarBackgroundColor = hasSidebarBanner
		&& sidebarStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
		? sidebarStyle.backgroundColor
		: bodyBackgroundColor;
	const section = panel.wrapper.querySelector(".vurs-npc-relationship-statistics");
	const heading = section.querySelector("h2");
	const toggle = panel.wrapper.querySelector(".vurs-npc-relationship-toggle");
	section.style.backgroundColor = npcBackgroundStyle.backgroundColor !== "transparent"
		&& npcBackgroundStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
		? npcBackgroundStyle.backgroundColor
		: bodyBackgroundColor;
	section.style.backgroundImage = npcBackgroundStyle.backgroundImage;
	section.style.backgroundPosition = npcBackgroundStyle.backgroundPosition;
	section.style.backgroundRepeat = npcBackgroundStyle.backgroundRepeat;
	section.style.backgroundSize = npcBackgroundStyle.backgroundSize;
	section.style.backgroundAttachment = npcBackgroundStyle.backgroundAttachment;
	section.style.color = bodyTextColor;
	heading.style.color = bodyTextColor;
	section.style.fontFamily = computedTheme.getPropertyValue("--font-primary").trim()
		|| computedTheme.fontFamily;
	section.style.fontSize = computedTheme.getPropertyValue("--font-size-12").trim() || "0.75rem";
	toggle.style.backgroundImage = npcBackgroundStyle.backgroundImage;
	toggle.style.backgroundRepeat = "no-repeat";
	toggle.style.backgroundPosition = npcBackgroundStyle.backgroundPosition;
	toggle.style.backgroundSize = npcBackgroundStyle.backgroundSize;
	toggle.style.backgroundAttachment = npcBackgroundStyle.backgroundAttachment;
	toggle.style.backgroundColor = npcBackgroundStyle.backgroundColor !== "transparent"
		&& npcBackgroundStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
		? npcBackgroundStyle.backgroundColor
		: sidebarBackgroundColor;
	toggle.style.color = sidebarStyle.color;
	toggle.style.fontFamily = sidebarStyle.fontFamily;
	toggle.style.fontSize = sidebarStyle.fontSize;
	toggle.style.fontWeight = sidebarStyle.fontWeight;
	const npcHeading = find(themeSource, ".npc-body > header .name");
	const npcHeadingStyle = getComputedStyle(npcHeading ?? themeSource);
	toggle.style.fontFamily = npcHeadingStyle.fontFamily;
	toggle.style.fontSize = `${Math.min(Number.parseFloat(npcHeadingStyle.fontSize) || 16, 16)}px`;
	toggle.style.fontWeight = npcHeadingStyle.fontWeight;
	toggle.style.fontVariant = "small-caps";
	toggle.style.letterSpacing = "0.04em";
	toggle.style.borderColor = computedTheme.getPropertyValue("--faded-border-color").trim()
		|| computedTheme.getPropertyValue("--color-border-divider").trim();
}

function getNpcSheetBackgroundStyle(sheetWindow, themeSource) {
	let element = themeSource.querySelector(".npc-body") ?? themeSource;
	while (element && sheetWindow.contains(element)) {
		const style = getComputedStyle(element);
		if (style.backgroundImage !== "none" || (style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)")) {
			return style;
		}
		element = element.parentElement;
	}
	return getComputedStyle(sheetWindow.querySelector(".window-content, .application-content") ?? sheetWindow);
}

function isNpcActor(actor) {
	return Boolean(actor?.isOfType?.("npc") || actor?.type === "npc");
}

function getFollowerParty(uuid) {
	if (typeof uuid !== "string" || !uuid) return null;
	return game.actors?.contents?.find(actor => actor.uuid === uuid && actor.type === "party") ?? null;
}

function getFollowerPartyLevel(party) {
	const partyMembers = party?.system?.details?.members;
	const members = Array.isArray(partyMembers)
		? partyMembers.map(member => {
			const uuid = typeof member === "string" ? member : member?.uuid;
			return typeof uuid === "string"
				? game.actors?.contents?.find(actor => actor.uuid === uuid) ?? fromUuidSync(uuid)
				: null;
		})
		: party?.members ?? [];
	const memberLevels = members
		.filter(member => member?.type === "character")
		.map(member => readFiniteNumber(member.level)
			?? readFiniteNumber(foundry.utils.getProperty(member, "system.details.level.value")))
		.filter(level => Number.isSafeInteger(level));
	if (!memberLevels.length) return null;
	return Math.floor(memberLevels.reduce((sum, level) => sum + level, 0) / memberLevels.length);
}

function getFollowerLevelData(configuration, baseLevel) {
	const follower = configuration?.follower;
	const party = getFollowerParty(follower?.partyUuid);
	const partyLevel = getFollowerPartyLevel(party);
	const baseFollowerLevel = Number.isSafeInteger(Number(follower?.baseFollowerLevel))
		? Number(follower.baseFollowerLevel)
		: 0;
	const storedTargetLevel = readFiniteNumber(follower?.appliedTargetLevel);
	const active = typeof follower?.partyUuid === "string" && follower.partyUuid.length > 0;
	const targetLevel = partyLevel === null
		? active && Number.isSafeInteger(storedTargetLevel)
			? storedTargetLevel
			: null
		: partyLevel + baseFollowerLevel;
	return {
		active,
		party,
		partyLevel,
		baseFollowerLevel,
		targetLevel,
		addedLevels: Number.isSafeInteger(targetLevel) && Number.isSafeInteger(baseLevel)
			? targetLevel - baseLevel
			: Number(configuration?.addedLevels) || 0
	};
}

function clampNpcLevel(level) {
	return Math.min(MAX_NPC_LEVEL, Math.max(MIN_NPC_LEVEL, level));
}

function getFollowerLevelClampWarning(level) {
	if (!Number.isSafeInteger(level)) return "";
	if (level < MIN_NPC_LEVEL) {
		return `Follower level ${level} is below the minimum of ${MIN_NPC_LEVEL}; it will be adjusted to ${MIN_NPC_LEVEL}.`;
	}
	if (level > MAX_NPC_LEVEL) {
		return `Follower level ${level} is above the maximum of ${MAX_NPC_LEVEL}; it will be adjusted to ${MAX_NPC_LEVEL}.`;
	}
	return "";
}

function getEffectiveNpcAddedLevels(configuration, baseLevel) {
	const followerLevel = getFollowerLevelData(configuration, baseLevel);
	return followerLevel.active ? followerLevel.addedLevels : Number(configuration?.addedLevels) || 0;
}

function getFollowerPartyOptions(configuration) {
	const selectedPartyUuid = configuration?.follower?.partyUuid ?? "";
	const parties = (game.actors?.contents ?? [])
		.filter(actor => actor.type === "party")
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(party => ({
			uuid: party.uuid,
			name: party.name,
			selected: party.uuid === selectedPartyUuid
		}));
	if (selectedPartyUuid && !parties.some(party => party.selected)) {
		parties.unshift({
			uuid: selectedPartyUuid,
			name: "Unavailable Party",
			selected: true,
			unavailable: true
		});
	}
	return parties;
}

function shouldGrantFollowerPlayerOwnership(actor) {
	const follower = foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower`);
	if (typeof follower?.partyUuid !== "string" || !follower.partyUuid) return false;
	switch (follower.playerControlOverride) {
		case "allow":
			return true;
		case "deny":
			return false;
		default:
			return game.settings.get(MODULE_ID, FOLLOWER_CONTROL_SETTING) === true;
	}
}

function getFollowerControlActor(tokenOrDocument) {
	const tokenDocument = tokenOrDocument?.document ?? tokenOrDocument;
	const actor = tokenOrDocument?.actor ?? tokenDocument?.actor ?? tokenOrDocument;
	const actorId = tokenDocument?.actorId ?? actor?.id;
	return game.actors?.get(actorId) ?? actor?.baseActor ?? actor ?? null;
}

function getActiveFollowerController(actor) {
	if (!isNpcActor(actor) || !shouldGrantFollowerPlayerOwnership(actor)) return null;
	const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
	const controller = controlState?.userId ? game.users.get(controlState.userId) : null;
	if (!controller ||
		controller.isGM ||
		controller.active === false ||
		!Array.isArray(controlState.tokenUuids) ||
		controlState.tokenUuids.length === 0) {
		return null;
	}
	return controller;
}

async function syncFollowerPlayerOwnership(actor) {
	if (!game.user?.isGM || !isNpcActor(actor)) return;
	const ownership = actor.ownership ?? actor._source?.ownership ?? {};
	const savedPermissions = foundry.utils.getProperty(actor, FOLLOWER_OWNERSHIP_PATH) ?? {};
	const nextSavedPermissions = foundry.utils.deepClone(savedPermissions);
	const ownershipUpdates = {};
	const nextOwnership = foundry.utils.deepClone(ownership);
	let ownershipRequiresReplacement = false;
	const grantOwnership = shouldGrantFollowerPlayerOwnership(actor);
	const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
	const controller = controlState?.userId ? game.users.get(controlState.userId) : null;
	const activeControl = grantOwnership &&
		controller &&
		!controller.isGM &&
		controller.active !== false &&
		Array.isArray(controlState.tokenUuids) &&
		controlState.tokenUuids.length > 0
		? controlState
		: null;

	if (activeControl) return;

	if (controlState && !activeControl) {
		ownershipUpdates["flags.vurs.-=followerControl"] = null;
	}

	if (grantOwnership) {
		for (const user of game.users?.contents ?? []) {
			if (user.isGM) continue;
			if (!Object.hasOwn(nextSavedPermissions, user.id)) {
				nextSavedPermissions[user.id] = Object.hasOwn(ownership, user.id)
					? ownership[user.id]
					: null;
			}
			const targetPermission = OWNER_PERMISSION_LEVEL;
			if (nextOwnership[user.id] !== targetPermission) {
				nextOwnership[user.id] = targetPermission;
				ownershipUpdates[`ownership.${user.id}`] = targetPermission;
			}
		}
	} else {
		for (const [userId, previousPermission] of Object.entries(nextSavedPermissions)) {
			if (previousPermission === null) {
				if (Object.hasOwn(nextOwnership, userId)) {
					delete nextOwnership[userId];
					ownershipRequiresReplacement = true;
				}
			} else if (nextOwnership[userId] !== previousPermission) {
				nextOwnership[userId] = previousPermission;
				ownershipUpdates[`ownership.${userId}`] = previousPermission;
			}
			delete nextSavedPermissions[userId];
		}
	}

	if (ownershipRequiresReplacement) {
		for (const key of Object.keys(ownershipUpdates)) {
			if (key.startsWith("ownership.")) delete ownershipUpdates[key];
		}
		ownershipUpdates.ownership = nextOwnership;
	}
	if (JSON.stringify(savedPermissions) !== JSON.stringify(nextSavedPermissions)) {
		ownershipUpdates[FOLLOWER_OWNERSHIP_PATH] = nextSavedPermissions;
	}
	if (Object.keys(ownershipUpdates).length) {
		await actor.update(ownershipUpdates, {
			render: false,
			vursFollowerOwnershipUpdate: true,
			vursFollowerControlUpdate: true
		});
	}
}

async function syncAllFollowerPlayerOwnership() {
	if (!game.user?.isGM) return;
	const actors = new Map();
	for (const actor of game.actors?.contents ?? []) actors.set(actor.uuid, actor);
	for (const scene of game.scenes?.contents ?? []) {
		for (const token of scene.tokens ?? []) {
			const actor = getFollowerControlActor(token);
			if (actor) actors.set(actor.uuid, actor);
		}
	}
	for (const actor of actors.values()) {
		const hasFollowerConfiguration = Boolean(
			foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`)
		);
		const hasSavedPermissions = Object.keys(
			foundry.utils.getProperty(actor, FOLLOWER_OWNERSHIP_PATH) ?? {}
		).length > 0;
		const hasControlClaim = Boolean(foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH));
		if (!isNpcActor(actor) ||
			(!hasFollowerConfiguration && !hasSavedPermissions && !hasControlClaim)) continue;
		try {
			await queueFollowerPlayerOwnershipSync(actor);
		} catch (error) {
			console.error(`vurs-pf2e | Failed to synchronize player ownership for follower ${actor.name}`, error);
			ui.notifications.error(`Could not synchronize player permissions for ${actor.name}. See the console for details.`);
		}
	}
}

function queueFollowerPlayerOwnershipSync(actor) {
	if (!game.user?.isGM || !isNpcActor(actor)) return Promise.resolve();
	return queueFollowerActorOperation(actor, () => syncFollowerPlayerOwnership(actor));
}

function queueFollowerActorOperation(actor, operation) {
	if (!game.user?.isGM || !isNpcActor(actor)) return Promise.resolve();
	const queueKey = actor.uuid ?? actor.id;
	const previous = FOLLOWER_ACTOR_OPERATION_QUEUES.get(queueKey) ?? Promise.resolve();
	const queued = previous.then(operation, operation);
	FOLLOWER_ACTOR_OPERATION_QUEUES.set(queueKey, queued);
	return queued.finally(() => {
		if (FOLLOWER_ACTOR_OPERATION_QUEUES.get(queueKey) === queued) {
			FOLLOWER_ACTOR_OPERATION_QUEUES.delete(queueKey);
		}
	});
}

async function handleFollowerControlRequest(tokenUuid, action) {
	const userId = this?.socketdata?.userId;
	const user = userId ? game.users.get(userId) : null;
	if (!user || user.isGM || typeof tokenUuid !== "string" ||
		!["acquire", "release"].includes(action)) {
		return { granted: false, reason: "invalid-request" };
	}

	const tokenDocument = await fromUuid(tokenUuid);
	const actor = getFollowerControlActor(tokenDocument);
	if (!actor || !isNpcActor(actor)) return { granted: false, reason: "not-follower" };

	return queueFollowerActorOperation(actor, async () => {
		let controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH) ?? {};
		if (action === "release") {
			if (controlState.userId !== userId ||
				!Array.isArray(controlState.tokenUuids) ||
				!controlState.tokenUuids.includes(tokenUuid)) {
				return { granted: false, reason: "not-controller" };
			}
			const tokenUuids = controlState.tokenUuids.filter(uuid => uuid !== tokenUuid);
			if (tokenUuids.length) {
				await actor.update({
					[FOLLOWER_CONTROL_PATH]: { ...controlState, tokenUuids }
				}, { render: false, vursFollowerControlUpdate: true });
			} else {
				await actor.update({
					"flags.vurs.-=followerControl": null
				}, { render: false, vursFollowerControlUpdate: true });
				await syncFollowerPlayerOwnership(actor);
			}
			return { granted: false, released: true };
		}

		if (!shouldGrantFollowerPlayerOwnership(actor)) {
			return { granted: false, reason: "player-control-disabled" };
		}
		const currentController = controlState.userId
			? game.users.get(controlState.userId)
			: null;
		const activeController = currentController &&
			currentController.active !== false &&
			!currentController.isGM &&
			Array.isArray(controlState.tokenUuids) &&
			controlState.tokenUuids.length > 0;
		if (controlState.userId && !activeController) {
			await actor.update({
				"flags.vurs.-=followerControl": null
			}, { render: false, vursFollowerControlUpdate: true });
			controlState = {};
		}
		if (controlState.userId && controlState.userId !== userId) {
			return {
				granted: false,
				reason: "already-controlled",
				controllerName: game.users.get(controlState.userId)?.name
			};
		}
		const tokenUuids = controlState.userId === userId && Array.isArray(controlState.tokenUuids)
			? [...new Set([...controlState.tokenUuids, tokenUuid])]
			: [tokenUuid];
		await actor.update({
			[FOLLOWER_CONTROL_PATH]: { userId, tokenUuids }
		}, { render: false, vursFollowerControlUpdate: true });
		return { granted: true };
	});
}

let followerControlSocket = null;

function registerFollowerControlSocket() {
	if (followerControlSocket) return;
	if (!globalThis.socketlib?.registerModule) {
		console.error(`${MODULE_ID} | SocketLib is required for exclusive follower control`);
		return;
	}
	const socket = globalThis.socketlib.registerModule(MODULE_ID);
	if (!socket || typeof socket.register !== "function") {
		console.error(`${MODULE_ID} | SocketLib did not register the module socket; enable "socket" in module.json and reload the world`);
		return;
	}
	followerControlSocket = socket;
	followerControlSocket.register("handleFollowerControlRequest", handleFollowerControlRequest);
	followerControlSocket.register("applyGMTokenSelection", applyGMTokenSelection);
	followerControlSocket.register("broadcastGMTokenSelection", broadcastGMTokenSelection);
}

function applyGMTokenSelection(userId, sceneId, tokenUuids) {
	const user = game.users?.get(userId);
	if (!user?.isGM || !Array.isArray(tokenUuids)) return;

	const selectedTokenUuids = new Set(tokenUuids.filter(uuid => typeof uuid === "string"));
	if (selectedTokenUuids.size && typeof sceneId === "string") {
		GM_SELECTED_TOKEN_UUIDS.set(userId, { sceneId, tokenUuids: selectedTokenUuids });
	} else {
		GM_SELECTED_TOKEN_UUIDS.delete(userId);
	}

	refreshTokenRingColors();
}

function broadcastGMTokenSelection() {
	if (!game.user?.isGM) return;

	const sceneId = canvas.scene?.id ?? null;
	const tokenUuids = (canvas.tokens?.controlled ?? [])
		.map(token => token.document?.uuid)
		.filter(uuid => typeof uuid === "string");
	applyGMTokenSelection(game.user.id, sceneId, tokenUuids);
	if (!followerControlSocket) return;

	void followerControlSocket.executeForEveryone(
		"applyGMTokenSelection",
		game.user.id,
		sceneId,
		tokenUuids
	).catch(error => {
		console.error(`${MODULE_ID} | Failed to synchronize GM token selection`, error);
	});
}

function requestGMTokenSelectionSync() {
	if (!followerControlSocket) return;
	if (game.user?.isGM) {
		broadcastGMTokenSelection();
		return;
	}

	void followerControlSocket.executeAsGM("broadcastGMTokenSelection").catch(error => {
		console.error(`${MODULE_ID} | Failed to request GM token selection`, error);
	});
}

function playerTokenRingColors(wrapped, ...args) {
	const colors = wrapped(...args);
	const color = getPlayerTokenRingColor(getFollowerControlActor(this), this);
	if (!color) return colors;
	return {
		...colors,
		ring: color,
		background: color
	};
}

function getUserTokenRingColor(user) {
	return user?.color ? Color.fromString(user.color.toString()) : null;
}

function getPlayerTokenRingColor(actor, token) {
	if (!actor || game.settings.get(MODULE_ID, PLAYER_TOKEN_RING_COLOR_SETTING) !== true) return null;

	if (game.user?.isGM && token?.controlled) {
		const selectedGMColor = getUserTokenRingColor(game.user);
		if (selectedGMColor) return selectedGMColor;
	}

	const tokenUuid = token?.document?.uuid;
	const selectedGM = [...GM_SELECTED_TOKEN_UUIDS.entries()]
		.find(([, selection]) =>
			selection.sceneId === canvas.scene?.id &&
			selection.tokenUuids.has(tokenUuid)
		);
	if (selectedGM) {
		const selectedGMColor = getUserTokenRingColor(game.users.get(selectedGM[0]));
		if (selectedGMColor) return selectedGMColor;
	}

	let assignedGM = null;
	for (const user of game.users?.contents ?? []) {
		if (!user.isGM || (user.character?.id ?? user.character) !== actor.id) continue;
		if (assignedGM) {
			assignedGM = null;
			break;
		}
		assignedGM = user;
	}
	const assignedGMColor = getUserTokenRingColor(assignedGM);
	if (assignedGMColor) return assignedGMColor;

	const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
	const controller = controlState?.userId ? game.users.get(controlState.userId) : null;
	if (controller &&
		!controller.isGM &&
		controller.active !== false &&
		Array.isArray(controlState.tokenUuids) &&
		controlState.tokenUuids.length > 0) {
		return getUserTokenRingColor(controller);
	}

	const users = game.users?.contents ?? [];
	let assignedPlayer = null;
	for (const user of users) {
		if (user.isGM || (user.character?.id ?? user.character) !== actor.id) continue;
		if (assignedPlayer) return null;
		assignedPlayer = user;
	}
	if (assignedPlayer) return getUserTokenRingColor(assignedPlayer);

	let owner = null;
	for (const user of users) {
		if (user.isGM || !actor.testUserPermission(user, OWNER_PERMISSION_LEVEL)) continue;
		if (owner) return null;
		owner = user;
	}
	return getUserTokenRingColor(owner);
}

function refreshTokenRingColors(actor) {
	for (const token of canvas.tokens?.placeables ?? []) {
		if (actor && getFollowerControlActor(token)?.uuid !== actor.uuid) continue;
		if (token.document.ring?.enabled) {
			token.renderFlags.set({ refreshRingVisuals: true });
		}
	}
}

function refreshAllTokenRingColors() {
	refreshTokenRingColors(null);
}

function registerFollowerTokenColorWrapper() {
	if (typeof globalThis.libWrapper?.register !== "function") {
		console.error(`${MODULE_ID} | libWrapper is required to apply player colors to token rings`);
		return;
	}
	if (typeof CONFIG.Token.objectClass?.prototype?.getRingColors !== "function") {
		console.error(`${MODULE_ID} | Foundry's Token.getRingColors method is unavailable; player token colors cannot be applied`);
		return;
	}
	try {
		globalThis.libWrapper.register(
			MODULE_ID,
			"CONFIG.Token.objectClass.prototype.getRingColors",
			playerTokenRingColors,
			"WRAPPER"
		);
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to register player token color wrapper`, error);
		ui.notifications.error("Could not register player token colors. See the console for details.");
	}
}

function getLocallyControlledFollowerTokens(tokens) {
	if (game.user?.isGM) return [];
	return tokens.filter(token => {
		const actor = getFollowerControlActor(token);
		if (!isNpcActor(actor) ||
			!foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`)) {
			return false;
		}
		const tokenUuid = token.document?.uuid;
		const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
		return Boolean(tokenUuid && (
			(controlState?.userId === game.user.id &&
				Array.isArray(controlState.tokenUuids) &&
				controlState.tokenUuids.includes(tokenUuid)) ||
			LOCAL_FOLLOWER_CONTROL_REQUESTS.has(tokenUuid)
		));
	});
}

function releaseFollowerTokens(tokens) {
	for (const token of tokens) {
		if (token.controlled) token.release();
	}
}

function ownsFollowerControlClaim(token) {
	const actor = getFollowerControlActor(token);
	const tokenUuid = token.document?.uuid;
	const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
	return Boolean(tokenUuid && (
		(controlState?.userId === game.user?.id &&
			Array.isArray(controlState.tokenUuids) &&
			controlState.tokenUuids.includes(tokenUuid)) ||
		LOCAL_FOLLOWER_CONTROL_REQUESTS.has(tokenUuid)
	));
}

function finishFollowerControlRelease(tokenUuid) {
	LOCAL_FOLLOWER_CONTROL_RELEASES.delete(tokenUuid);
}

function scheduleFollowerControlClaimRelease(token) {
	const tokenUuid = token.document?.uuid;
	if (!tokenUuid) return;
	const currentTimer = FOLLOWER_CONTROL_RELEASE_TIMERS.get(tokenUuid);
	if (currentTimer) clearTimeout(currentTimer);
	const timer = setTimeout(() => {
		if (FOLLOWER_CONTROL_RELEASE_TIMERS.get(tokenUuid) !== timer) return;
		FOLLOWER_CONTROL_RELEASE_TIMERS.delete(tokenUuid);
		if (!token.controlled) releaseFollowerControlClaim(token);
	}, 150);
	FOLLOWER_CONTROL_RELEASE_TIMERS.set(tokenUuid, timer);
}

function releaseFollowerControlClaim(token) {
	const actor = getFollowerControlActor(token);
	const tokenUuid = token.document?.uuid;
	if (!tokenUuid || game.user?.isGM) return;
	if (LOCAL_FOLLOWER_CONTROL_RELEASES.has(tokenUuid)) return;

	const request = LOCAL_FOLLOWER_CONTROL_REQUESTS.get(tokenUuid);
	if (request?.pending) {
		LOCAL_FOLLOWER_CONTROL_RELEASES.add(tokenUuid);
		request.released = true;
		return;
	}
	const controlState = foundry.utils.getProperty(actor, FOLLOWER_CONTROL_PATH);
	const ownsClaim = controlState?.userId === game.user.id &&
		Array.isArray(controlState.tokenUuids) &&
		controlState.tokenUuids.includes(tokenUuid);
	if ((!request && !ownsClaim) || LOCAL_FOLLOWER_CONTROL_RELEASES.has(tokenUuid)) return;
	LOCAL_FOLLOWER_CONTROL_REQUESTS.delete(tokenUuid);
	if (!followerControlSocket) {
		console.error(`${MODULE_ID} | Cannot release follower control because SocketLib is unavailable`);
		ui.notifications.error("Could not release follower control because SocketLib is unavailable.");
		return;
	}

	LOCAL_FOLLOWER_CONTROL_RELEASES.add(tokenUuid);
	void followerControlSocket.executeAsGM("handleFollowerControlRequest", tokenUuid, "release")
		.catch(error => {
			console.error(`${MODULE_ID} | Failed to release control of follower ${actor?.name ?? tokenUuid}`, error);
			ui.notifications.error(`Could not release control of ${actor?.name ?? "the follower"}. See the console for details.`);
		})
		.finally(() => finishFollowerControlRelease(tokenUuid));
}

function renderFollowerControlTokenHud(hud, html) {
	const root = html instanceof HTMLElement ? html : html?.[0];
	const token = hud.object;
	const actor = getFollowerControlActor(token);
	if (game.user?.isGM ||
		!isNpcActor(actor) ||
		!foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`) ||
		!ownsFollowerControlClaim(token)) return;

	const controls = root?.querySelector(".col.right") ?? root?.querySelector(".col") ?? root;
	if (!controls || controls.querySelector('[data-vurs-action="release-follower-control"]')) return;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "control-icon";
	button.dataset.vursAction = "release-follower-control";
	button.title = "Release follower control";
	button.setAttribute("aria-label", "Release follower control");
	button.innerHTML = '<i class="fa-solid fa-hand"></i>';
	button.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		releaseFollowerControlClaim(token);
		token.release();
	});
	controls.append(button);
}

function tokenBoundsOverlapSelection(token, selection) {
	const bounds = token.bounds;
	if (!bounds ||
		![selection.x, selection.y, selection.width, selection.height].every(Number.isFinite)) {
		return true;
	}
	const left = Math.min(selection.x, selection.x + selection.width);
	const right = Math.max(selection.x, selection.x + selection.width);
	const top = Math.min(selection.y, selection.y + selection.height);
	const bottom = Math.max(selection.y, selection.y + selection.height);
	return bounds.x <= right &&
		bounds.x + bounds.width >= left &&
		bounds.y <= bottom &&
		bounds.y + bounds.height >= top;
}

function preventControlOfPossessedFollower(wrapped, ...args) {
	const canControl = wrapped(...args);
	const requestingUser = args[0] ?? game.user;
	if (!canControl || !requestingUser || requestingUser.isGM) return canControl;
	const controller = getActiveFollowerController(getFollowerControlActor(this));
	return !controller || controller.id === requestingUser.id;
}

function releaseFollowerTokensControlledByOtherPlayer(actor) {
	if (game.user?.isGM) return;
	const controller = getActiveFollowerController(actor);
	if (!controller || controller.id === game.user?.id) return;
	for (const token of canvas.tokens?.placeables ?? []) {
		if (getFollowerControlActor(token)?.uuid === actor.uuid && token.controlled) {
			token.release();
		}
	}
}

function releaseFollowerTokensOutsideSelection(wrapped, ...args) {
	const result = wrapped(...args);
	const [selection = {}, options = {}] = args;
	if (options.releaseOthers === false) return result;
	const release = () => {
		if (this !== canvas.tokens) return;
		const selectedFollowers = getLocallyControlledFollowerTokens(this.controlled ?? []);
		releaseFollowerTokens(selectedFollowers.filter(token =>
			!tokenBoundsOverlapSelection(token, selection)
		));
	};
	if (result && typeof result.then === "function") {
		return result.then(value => {
			release();
			return value;
		});
	}
	queueMicrotask(release);
	return result;
}

function registerFollowerTokenControlWrappers() {
	if (typeof globalThis.libWrapper?.register !== "function") {
		console.error(`${MODULE_ID} | libWrapper is required to handle follower control`);
		return;
	}
	if (typeof CONFIG.Token.objectClass?.prototype?._canControl !== "function") {
		console.error(`${MODULE_ID} | Foundry's Token._canControl method is unavailable; possessed followers cannot be made unselectable`);
		ui.notifications.error("Could not register follower possession selection rules. See the console for details.");
		return;
	}
	const registrations = [
		[
			"CONFIG.Token.objectClass.prototype._canControl",
			preventControlOfPossessedFollower
		],
		[
			"foundry.canvas.layers.TokenLayer.prototype.selectObjects",
			releaseFollowerTokensOutsideSelection
		]
	];
	for (const [target, wrapper] of registrations) {
		try {
			globalThis.libWrapper.register(MODULE_ID, target, wrapper, "WRAPPER");
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to register follower control wrapper for ${target}`, error);
			ui.notifications.error("Could not register follower control behavior. See the console for details.");
		}
	}
}

function onFollowerTokenControl(token, controlled) {
	const actor = getFollowerControlActor(token);
	if (game.user?.isGM) {
		broadcastGMTokenSelection();
		return;
	}
	const controller = getActiveFollowerController(actor);
	if (controlled && controller && controller.id !== game.user?.id) {
		token.release();
		return;
	}
	const tokenUuid = token.document?.uuid;
	if (!tokenUuid) return;

	if (controlled) {
		const releaseTimer = FOLLOWER_CONTROL_RELEASE_TIMERS.get(tokenUuid);
		if (releaseTimer) {
			clearTimeout(releaseTimer);
			FOLLOWER_CONTROL_RELEASE_TIMERS.delete(tokenUuid);
		}
		const existingRequest = LOCAL_FOLLOWER_CONTROL_REQUESTS.get(tokenUuid);
		if (existingRequest?.pending) {
			existingRequest.released = false;
			LOCAL_FOLLOWER_CONTROL_RELEASES.delete(tokenUuid);
			return;
		}
		if (LOCAL_FOLLOWER_CONTROL_RELEASES.has(tokenUuid)) {
			token.release();
			return;
		}
		if (!isNpcActor(actor) ||
			!foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`) ||
			!shouldGrantFollowerPlayerOwnership(actor)) {
			return;
		}
		if (!followerControlSocket) {
			token.release();
			ui.notifications.error("Exclusive follower control is unavailable because SocketLib is not ready.");
			return;
		}
		if (existingRequest) {
			return;
		}

		const request = { pending: true, released: false };
		LOCAL_FOLLOWER_CONTROL_REQUESTS.set(tokenUuid, request);
		void followerControlSocket.executeAsGM("handleFollowerControlRequest", tokenUuid, "acquire")
			.then(result => {
				if (!result?.granted) {
					if (LOCAL_FOLLOWER_CONTROL_REQUESTS.get(tokenUuid) === request) {
						LOCAL_FOLLOWER_CONTROL_REQUESTS.delete(tokenUuid);
					}
					LOCAL_FOLLOWER_CONTROL_RELEASES.delete(tokenUuid);
					if (token.controlled) token.release();
					if (result?.reason === "already-controlled") {
						ui.notifications.warn(`${actor.name} is currently controlled by ${result.controllerName ?? "another player"}.`);
					} else if (result?.reason === "player-control-disabled") {
						ui.notifications.warn(`Player control is disabled for ${actor.name}.`);
					} else if (result?.reason === "not-follower") {
						ui.notifications.warn(`${actor.name} is no longer configured as a follower.`);
					}
					return;
				}
				request.pending = false;
				if (request.released || !token.controlled) {
					LOCAL_FOLLOWER_CONTROL_REQUESTS.delete(tokenUuid);
					return followerControlSocket.executeAsGM("handleFollowerControlRequest", tokenUuid, "release")
						.finally(() => finishFollowerControlRelease(tokenUuid));
				}
			})
			.catch(error => {
				if (LOCAL_FOLLOWER_CONTROL_REQUESTS.get(tokenUuid) === request) {
					LOCAL_FOLLOWER_CONTROL_REQUESTS.delete(tokenUuid);
				}
				LOCAL_FOLLOWER_CONTROL_RELEASES.delete(tokenUuid);
				if (token.controlled) token.release();
				console.error(`${MODULE_ID} | Failed to acquire control of follower ${actor.name}`, error);
				ui.notifications.error(`Could not acquire control of ${actor.name}. See the console for details.`);
			});
		return;
	}

	scheduleFollowerControlClaimRelease(token);
}

function releaseLocalFollowerControlClaims() {
	for (const [tokenUuid, request] of LOCAL_FOLLOWER_CONTROL_REQUESTS) {
		if (request.pending) {
			request.released = true;
			continue;
		}
		LOCAL_FOLLOWER_CONTROL_REQUESTS.delete(tokenUuid);
		if (!followerControlSocket) continue;
		void followerControlSocket.executeAsGM("handleFollowerControlRequest", tokenUuid, "release")
			.catch(error => {
				console.error(`${MODULE_ID} | Failed to release follower control during canvas teardown`, error);
				ui.notifications.error("Could not release follower control while changing scenes. See the console for details.");
			});
	}
}

function refreshFollowerTokenColors(actor) {
	for (const token of canvas.tokens?.placeables ?? []) {
		if (getFollowerControlActor(token)?.uuid !== actor.uuid) continue;
		token.refresh();
		token.ring?.configureVisuals();
	}
}

function refreshFollowerTokenColorsForUser(userId) {
	for (const token of canvas.tokens?.placeables ?? []) {
		if (foundry.utils.getProperty(getFollowerControlActor(token), `${FOLLOWER_CONTROL_PATH}.userId`) === userId) {
			token.ring?.configureVisuals();
		}
	}
}

function isFollowerControlStateChange(path) {
	return path === FOLLOWER_CONTROL_PATH ||
		path.startsWith(`${FOLLOWER_CONTROL_PATH}.`) ||
		path === "flags.vurs.-=followerControl";
}

async function releaseFollowerClaimsForUser(userId) {
	if (!game.user?.isGM || !userId) return;
	const actors = new Map();
	for (const actor of game.actors?.contents ?? []) actors.set(actor.uuid, actor);
	for (const scene of game.scenes?.contents ?? []) {
		for (const token of scene.tokens ?? []) {
			const actor = getFollowerControlActor(token);
			if (actor) actors.set(actor.uuid, actor);
		}
	}
	for (const actor of actors.values()) {
		if (foundry.utils.getProperty(actor, `${FOLLOWER_CONTROL_PATH}.userId`) !== userId) continue;
		try {
			await queueFollowerActorOperation(actor, async () => {
				await actor.update({ "flags.vurs.-=followerControl": null }, {
					render: false,
					vursFollowerControlUpdate: true
				});
				await syncFollowerPlayerOwnership(actor);
			});
		} catch (error) {
			console.error(`${MODULE_ID} | Failed to release follower control for ${actor.name}`, error);
			ui.notifications.error(`Could not release follower control for ${actor.name}. See the console for details.`);
		}
	}
}

function getNpcPlayResourceDerivedFormula(actor, resourceKey) {
	const agnostic = actorUsesAgnosticVurs(actor);
	const usesVurs = actorUsesVursSystem(actor);
	if (!usesVurs) {
		if (game.settings.get(MODULE_ID, "addActionPointsInDefault") === true) {
			if (resourceKey === "actionPoints") return "3 (fixed default)";
			if (resourceKey === "reactions") return "1 (fixed default)";
		}
		return resourceKey === "magicPoints"
			? "Stored MP maximum, plus active contributions and extra"
			: "No derived maximum in the current system mode";
	}
	if (resourceKey === "reactions") return agnostic ? "1 (fixed)" : "No derived maximum";
	if (resourceKey === "magicPoints") return "Stored MP maximum, plus active contributions and extra";

	const resourceSkills = {
		staminaPoints: "athletics",
		actionPoints: "mobility",
		tacticPoints: "strategy",
		styleRank: "coolness",
		karmaPoints: "soul",
		budgetPoints: "acquisition"
	};
	const skill = resourceSkills[resourceKey];
	if (!skill) return "No derived maximum";
	const skillIsVisible = actor.system?.skills?.[skill]?.visible === true;
	if (!skillIsVisible && !(agnostic && resourceKey === "actionPoints")) {
		return "No derived maximum while the associated skill is hidden";
	}

	const rank = `floor(@skills.${skill}.mod / 7)`;
	switch (resourceKey) {
		case "actionPoints":
			return `max(${agnostic ? 3 : 2}, 2 + min(@abilities.dex.mod, ${rank}))`;
		case "staminaPoints":
			return `max(0, min(@abilities.str.mod, ${rank}))`;
		case "tacticPoints":
			return `max(0, min(@abilities.int.mod, ${rank})${agnostic ? " - 1" : ""})`;
		case "styleRank":
			return `5 when min(@abilities.cha.mod, ${rank}) > 0; otherwise 0`;
		case "karmaPoints":
			return `max(0, min(@abilities.wis.mod, ${rank}))`;
		case "budgetPoints":
			return `max(0, 5 + @abilities.con.mod + 2 * ${rank})`;
		default:
			return "No derived maximum";
	}
}

function getCurrentNpcLevel(actor) {
	const level = Number(foundry.utils.getProperty(actor._source, "system.details.level.value"));
	if (!Number.isInteger(level)) {
		throw new Error(`Could not read the native NPC level for ${actor.name}.`);
	}
	return level;
}

function evaluateFormula(actor, resourceKey, formula) {
	const roll = new Roll(formula, actor.getRollData());
	const total = roll.evaluateSync().total;
	if (!Number.isFinite(total) || !Number.isSafeInteger(Math.floor(total))) {
		throw new Error(`${resourceKey} maximum formula must produce a safe, finite number.`);
	}
	return total;
}

function isNpcConfigurationLevelItem(item) {
	return item?.flags?.vurs?.npcConfigurationLevelScaling === true;
}

function readFiniteNumber(value) {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function setUpdateValue(changes, path, value) {
	if (Object.hasOwn(changes, path)) changes[path] = value;
	else foundry.utils.setProperty(changes, path, value);
}

function getOriginalItemValue(value, adjustment) {
	if (adjustment && typeof adjustment === "object" && Object.hasOwn(adjustment, "set")) {
		const numericValue = readFiniteNumber(value);
		const delta = readFiniteNumber(adjustment.delta) ?? 0;
		return numericValue === null ? value : numericValue - delta;
	}
	if (typeof adjustment === "number") {
		const numericValue = readFiniteNumber(value);
		return numericValue === null ? value : numericValue - adjustment;
	}
	return value;
}

function getAdjustmentData(adjustments, path) {
	if (Object.hasOwn(adjustments, path)) {
		return { found: true, value: adjustments[path] };
	}
	const value = foundry.utils.getProperty(adjustments, path);
	return { found: value !== undefined, value };
}

function getNpcLevelScalingGroups(originalSystem = {}, scaling = {}, actor = null) {
	const originalSkills = { ...(originalSystem.skills ?? {}) };
	if (actorUsesVursSystem(actor)) {
		for (const slug of ["acquisition", "soul"]) {
			const skill = actor.system?.skills?.[slug];
			if (!Object.hasOwn(originalSkills, slug) && readFiniteNumber(skill?.base) !== null) {
				originalSkills[slug] = skill;
			}
		}
	}
	const skillFields = Object.entries(originalSkills)
		.filter(([, skill]) => readFiniteNumber(skill?.base) !== null)
		.map(([slug, skill]) => ({
			key: `skill_${slug}`,
			legacyKey: "skills",
			label: skill.label ?? slug.replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase()),
			defaultValue: 1.4,
			group: ["acquisition", "soul"].includes(slug) &&
				(actorUsesVursSystem(actor) || actorUsesAgnosticVurs(actor))
				? "defenses"
				: "skills"
		}));
	const vursAttributeLabels = {
		str: "Strength",
		dex: "Agility",
		con: "Wealth",
		int: "Intelligence",
		wis: "Spirit",
		cha: "Void"
	};
	return NPC_LEVEL_SCALING_GROUPS.map(group => ({
		...group,
		fields: [
			...group.fields,
			...skillFields.filter(field => field.group === group.key)
		].map(field => {
			const setting = getScalingSetting(scaling, field);
			return {
				...field,
				label: field.key.startsWith("ability") && actorUsesVursSystem(actor)
					? vursAttributeLabels[field.key.slice("ability".length).toLowerCase()]
					: field.label,
				value: setting.multiplier,
					enabled: setting.enabled,
					defaultEnabled: field.defaultEnabled !== false
			};
		})
	}));
}

function getScalingSetting(scaling = {}, field) {
	const configured = Object.hasOwn(scaling, field.key)
		? scaling[field.key]
		: field.legacyKey && Object.hasOwn(scaling, field.legacyKey)
			? scaling[field.legacyKey]
			: undefined;
	if (configured && typeof configured === "object") {
		const multiplier = readFiniteNumber(configured.multiplier);
		return {
			multiplier: multiplier !== null && multiplier >= 0 ? multiplier : field.defaultValue,
			enabled: configured.enabled === undefined
				? field.defaultEnabled !== false
				: configured.enabled !== false
		};
	}
	const multiplier = readFiniteNumber(configured);
	return {
		multiplier: multiplier !== null && multiplier >= 0 ? multiplier : field.defaultValue,
		enabled: configured === undefined ? field.defaultEnabled !== false : true
	};
}

function getScalingMultiplier(scaling, key, legacyKey = key, defaultValue = 0) {
	const field = NPC_LEVEL_SCALING_FIELDS.find(candidate => candidate.key === key)
		?? { key, legacyKey, defaultValue };
	const setting = getScalingSetting(scaling, field);
	return setting.enabled ? setting.multiplier : 0;
}

function addNpcFollowerTraitRule(rules, actor) {
	if (!isNpcActor(actor) ||
		!foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`)) {
		return rules;
	}
	const followerRule = {
		key: "ActorTraits",
		add: ["follower"],
		remove: [],
		priority: 51,
		ignored: false,
		actor,
		onApplyActiveEffects() {
			const traits = actor.system?.traits?.value;
			if (!Array.isArray(traits)) return;
			if (!traits.includes("follower")) {
				traits.push("follower");
				actor.rollOptions.all["self:trait:follower"] = true;
			}
		}
	};
	return [...rules, followerRule].sort((left, right) => left.priority - right.priority);
}

function applyNpcLevelDcAdjustment(actor) {
	const prototype = actor?.constructor?.prototype;
	if (!prototype) return;
	if (!prototype[NPC_FOLLOWER_TRAIT_PATCH]) {
		const originalPrepareRuleElements = prototype.prepareRuleElements;
		if (typeof originalPrepareRuleElements !== "function") {
			console.error(`${MODULE_ID} | Could not install follower trait Rule Element: NPC rule preparation is unavailable.`);
		} else {
			Object.defineProperty(prototype, NPC_FOLLOWER_TRAIT_PATCH, { value: true });
			prototype.prepareRuleElements = function (...args) {
				const rules = originalPrepareRuleElements.apply(this, args);
				return addNpcFollowerTraitRule(rules, this);
			};
		}
	}
	addNpcPrepareDerivedDataHandler(npcLevelDcPrepareDerivedHandler);
}

function npcLevelDcPrepareDerivedHandler(actor, result) {
	if (!isNpcActor(actor)) return result;
	applyNpcConfigurationSkillScaling(actor);
	const dcAdjustment = getNpcConfigurationDcAdjustment(actor);
	const Modifier = game.pf2e?.Modifier;
	if (!dcAdjustment) return result;
	if (typeof Modifier !== "function") {
		console.error(`${MODULE_ID} | Could not apply NPC area-fire DC scaling: the PF2e Modifier API is unavailable.`);
		return result;
	}

	for (const selector of ["area-fire-dc", "auto-fire-dc"]) {
		const modifiers = actor.synthetics.modifiers[selector] ??= [];
		if (modifiers.some(modifier => modifier.vursNpcLevelScaling)) continue;
		const modifier = () => new Modifier({
			slug: "vurs-npc-level-dc",
			label: "Leveled NPC DC",
			modifier: dcAdjustment,
			type: "untyped"
		});
		modifier.vursNpcLevelScaling = true;
		modifiers.push(modifier);
	}
	return result;
}

export function addNpcPrepareDerivedDataHandler(handler) {
	if (typeof handler !== "function") return;
	const handlers = globalThis[NPC_PREPARE_DERIVED_HANDLERS_KEY] ??= new Set();
	handlers.add(handler);
	ensureNpcPrepareDerivedDataDispatcher();
}

function ensureNpcPrepareDerivedDataDispatcher() {
	if (globalThis[NPC_PREPARE_DERIVED_DISPATCHER_KEY]) return;
	const target = "CONFIG.PF2E.Actor.documentClasses.npc.prototype.prepareDerivedData";
	if (typeof CONFIG.PF2E?.Actor?.documentClasses?.npc?.prototype?.prepareDerivedData !== "function") {
		console.error(`${MODULE_ID} | Could not install NPC prepareDerivedData handlers: the NPC preparation method is unavailable.`);
		return;
	}
	if (typeof globalThis.libWrapper?.register !== "function") {
		console.error(`${MODULE_ID} | Could not install NPC prepareDerivedData handlers: libWrapper is unavailable.`);
		return;
	}
	try {
		globalThis.libWrapper.register(
			MODULE_ID,
			target,
			function (wrapped, ...args) {
				let result = wrapped(...args);
				for (const handler of globalThis[NPC_PREPARE_DERIVED_HANDLERS_KEY] ?? []) {
					result = handler(this, result, args) ?? result;
				}
				return result;
			},
			"WRAPPER"
		);
		globalThis[NPC_PREPARE_DERIVED_DISPATCHER_KEY] = true;
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to register NPC prepareDerivedData dispatcher for ${target}`, error);
	}
}

function applyNpcConfigurationSkillScaling(actor) {
	if (!actorUsesVursSystem(actor)) return;
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
	const originalSkills = configuration?.originalData?.system?.skills ?? {};
	for (const slug of ["acquisition", "soul"]) {
		if (Object.hasOwn(originalSkills, slug)) continue;
		const statistic = actor.skills?.[slug];
		const systemSkill = actor.system?.skills?.[slug];
		const base = readFiniteNumber(systemSkill?.base);
		if (!statistic || !systemSkill || base === null) continue;
		const adjustment = getNpcConfigurationLevelAdjustment(
			actor,
			`skill_${slug}`,
			"skills",
			1.4
		);
		if (!adjustment) continue;
		const data = foundry.utils.deepClone(statistic.data);
		data.modifiers = (data.modifiers ?? []).filter(modifier =>
			modifier.slug !== "vurs-npc-level-skill"
		);
		const Modifier = game.pf2e?.Modifier;
		if (typeof Modifier !== "function") {
			console.error(`${MODULE_ID} | Could not apply NPC skill scaling: the PF2e Modifier API is unavailable.`);
			continue;
		}
		data.modifiers.push(new Modifier({
			slug: "vurs-npc-level-skill",
			label: "Leveled NPC",
			modifier: adjustment,
			type: "untyped"
		}));
		const adjustedStatistic = new statistic.constructor(actor, data, statistic.config);
		actor.skills[slug] = adjustedStatistic;
		Object.assign(systemSkill, adjustedStatistic.getTraceData(), {
			attribute: adjustedStatistic.attribute ?? systemSkill.attribute,
			rank: adjustedStatistic.rank,
			mod: adjustedStatistic.check.mod
		});
	}
}

function getNpcConfigurationDcAdjustment(actor) {
	return getNpcConfigurationLevelAdjustment(actor, "spellDc");
}

function getNpcConfigurationLevelAdjustment(
	actor,
	scalingField,
	legacyKey = "spellcasting",
	defaultValue = 1.35
) {
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
	if (!configuration?.originalData?.system) return 0;
	const statistics = getRelationshipStatistics(configuration);
	const relationshipAdjustment = configuration.relationshipStatistics
		? getRelationshipLevelAdjustment(getRelationshipRank(statistics))
		: Number(configuration.affection) || 0;
	const baseLevel = Number(foundry.utils.getProperty(
		configuration,
		"originalData.system.details.level.value"
	));
	const addedLevels = getEffectiveNpcAddedLevels(configuration, baseLevel) + relationshipAdjustment;
	if (!addedLevels) return 0;
	return getLevelScalingAdjustment(
		baseLevel + addedLevels,
		addedLevels,
		getScalingMultiplier(configuration.scaling, scalingField, legacyKey, defaultValue)
	);
}

function numericScale(level, multiplier) {
	return level > 1 ? level * multiplier : 0;
}

function floorScale(level, multiplier) {
	return Math.floor(numericScale(level, multiplier));
}

function getLevelScalingAdjustment(level, levelAdjustment, multiplier) {
	if (levelAdjustment > 0) return floorScale(level, multiplier);
	if (levelAdjustment < 0) return -Math.floor(Math.abs(levelAdjustment) * multiplier);
	return 0;
}

function getRelationshipStatistics(configuration = {}) {
	const statistics = { ...(configuration.relationshipStatistics ?? {}) };
	if (!Object.hasOwn(statistics, "affection") && configuration.affection) {
		statistics.affection = configuration.affection;
	}
	if (!Object.hasOwn(statistics, "flexibility") && Object.hasOwn(statistics, "honor")) {
		statistics.flexibility = statistics.honor;
	}
	if (!Object.hasOwn(statistics, "loyalty")) {
		if (Object.hasOwn(statistics, "code")) statistics.loyalty = statistics.code;
		else if (Object.hasOwn(statistics, "obligation")) statistics.loyalty = statistics.obligation;
	}
	return statistics;
}

function formatScale(value) {
	return String(Number(value.toFixed(2)));
}

function scaleDamageFormula(formula, bonusDice, bonusDamage, includeDice) {
	let scaled = String(formula ?? "").trim();
	if (!scaled) return scaled;
	const die = scaled.match(/(\d*)d(\d+)/i);
	if (includeDice && bonusDice > 0 && die) {
		scaled += ` + ${bonusDice}d${die[2]}`;
	} else if (includeDice && bonusDice < 0 && die) {
		const adjustedDice = Math.max(0, Number(die[1] || 1) + bonusDice);
		scaled = scaled.replace(die[0], `${adjustedDice}d${die[2]}`);
	}
	if (bonusDamage > 0) scaled += ` + ${formatScale(bonusDamage)}`;
	else if (bonusDamage < 0) scaled += ` - ${formatScale(Math.abs(bonusDamage))}`;
	return scaled;
}

function findInlineMacroEnd(text, openingBracket) {
	let depth = 0;
	for (let index = openingBracket; index < text.length; index += 1) {
		if (text[index] === "[") depth += 1;
		else if (text[index] === "]" && --depth === 0) return index;
	}
	return -1;
}

function findInlineOptionSeparator(body) {
	let depth = 0;
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "[") depth += 1;
		else if (body[index] === "]") depth -= 1;
		else if (body[index] === "|" && depth === 0) return index;
	}
	return -1;
}

function getInlineDamageTerms(formula, adjustment) {
	const terms = [];
	const diceDelta = readFiniteNumber(adjustment.diceDelta) ?? 0;
	const die = formula.match(/d(\d+)/i);
	if (diceDelta > 0 && die ||
		diceDelta < 0 && die && adjustment.diceDeltaMode !== "count") {
		const damageType = formula.match(/\[([a-z][a-z-]*)\]/i)?.[1];
		terms.push({
			operator: diceDelta > 0 ? "+" : "-",
			value: `${Math.abs(diceDelta)}d${die[1]}${damageType ? `[${damageType}]` : ""}`
		});
	}
	const damageBonus = readFiniteNumber(adjustment.damageBonus) ?? 0;
	if (damageBonus) {
		terms.push({
			operator: damageBonus > 0 ? "+" : "-",
			value: formatScale(Math.abs(damageBonus))
		});
	}
	return terms;
}

function adjustInlineDamageDiceCount(formula, diceDelta) {
	if (!diceDelta) return formula;
	return formula.replace(/(\d*)d(\d+)/i, (die, count, sides) =>
		`${Math.max(0, Number(count || 1) + diceDelta)}d${sides}`
	);
}

function adjustInlineDamageFormula(formula, adjustment) {
	if (/\[(?:healing|temp-healing)\]/i.test(formula)) return formula;
	const terms = getInlineDamageTerms(formula, adjustment);
	const diceDelta = readFiniteNumber(adjustment.diceDelta) ?? 0;
	const adjustedFormula = adjustment.diceDeltaMode === "count" && diceDelta < 0
		? adjustInlineDamageDiceCount(formula, diceDelta)
		: formula;
	return terms.reduce((result, term) => `${result} ${term.operator} ${term.value}`, adjustedFormula);
}

function restoreInlineDamageFormula(formula, adjustment) {
	if (/\[(?:healing|temp-healing)\]/i.test(formula)) return formula;
	const diceDelta = readFiniteNumber(adjustment.diceDelta) ?? 0;
	const restoredFormula = adjustment.diceDeltaMode === "count" && diceDelta < 0
		? adjustInlineDamageDiceCount(formula, -diceDelta)
		: formula;
	return getInlineDamageTerms(formula, adjustment).reverse().reduce((result, term) => {
		const suffix = ` ${term.operator} ${term.value}`;
		return result.endsWith(suffix) ? result.slice(0, -suffix.length) : result;
	}, restoredFormula);
}

function adjustInlineDc(value, bonus, restore = false) {
	if (!bonus || value === "@self.level") return value;
	const sign = restore ? -1 : 1;
	const numericValue = readFiniteNumber(value);
	if (numericValue !== null) return String(numericValue + sign * bonus);
	if (!value.startsWith("resolve(") || !value.endsWith(")")) return value;

	const expression = value.slice("resolve(".length, -1);
	const suffix = ` ${bonus > 0 ? "+" : "-"} ${Math.abs(bonus)}`;
	if (restore) {
		if (!expression.endsWith(suffix)) return value;
		const restored = expression.slice(0, -suffix.length);
		return `resolve(${restored})`;
	}
	return `resolve(${expression}${suffix})`;
}

function transformInlineRollText(text, adjustment, restore = false) {
	if (typeof text !== "string" || !adjustment?.inlineRolls) return text;
	const dcBonus = readFiniteNumber(adjustment.dcBonus) ?? 0;
	const macroPattern = /@(Damage|Check)\[/g;
	let result = "";
	let cursor = 0;
	let match;
	while ((match = macroPattern.exec(text))) {
		const openingBracket = macroPattern.lastIndex - 1;
		const closingBracket = findInlineMacroEnd(text, openingBracket);
		if (closingBracket < 0) break;
		result += text.slice(cursor, openingBracket + 1);
		let body = text.slice(openingBracket + 1, closingBracket);
		if (match[1] === "Damage") {
			const optionSeparator = findInlineOptionSeparator(body);
			const formula = optionSeparator < 0 ? body : body.slice(0, optionSeparator);
			const options = optionSeparator < 0 ? "" : body.slice(optionSeparator);
			const adjustedFormula = restore
				? restoreInlineDamageFormula(formula, adjustment)
				: adjustInlineDamageFormula(formula, adjustment);
			body = `${adjustedFormula}${options}`;
		} else if (dcBonus && !/(^|\|)type:flat(?:\||$)/.test(body)) {
			const dcMatch = /(^|\|)dc:([^|]+)/.exec(body);
			if (dcMatch) {
				const valueStart = dcMatch.index + dcMatch[1].length + "dc:".length;
				const valueEnd = valueStart + dcMatch[2].length;
				const adjustedDc = adjustInlineDc(dcMatch[2], dcBonus, restore);
				body = `${body.slice(0, valueStart)}${adjustedDc}${body.slice(valueEnd)}`;
			}
		}
		result += `${body}]`;
		cursor = closingBracket + 1;
		macroPattern.lastIndex = cursor;
	}
	return cursor === 0 ? text : result + text.slice(cursor);
}

// Mirror PF2e's weapon-to-NPC-Strike level-based attack calculation.
function getNpcGeneratedAttack(level) {
	return Math.round(1.5 * level + 7);
}

function getRelationshipRank(statistics = {}) {
	const total = NPC_RELATIONSHIP_STATISTICS.reduce(
		(sum, { key }) => sum + (readFiniteNumber(statistics[key]) ?? 0),
		0
	);
	return total / NPC_RELATIONSHIP_STATISTICS.length;
}

function getRelationshipLevelAdjustment(rank) {
	return Number.isSafeInteger(rank) ? rank : 0;
}

function getNpcActorLevel(level, actor) {
	if (actor?.isElite) return level < 1 ? level + 2 : level + 1;
	if (actor?.isWeak) return level === 1 ? level - 2 : level - 1;
	return level;
}

function applyNpcGeneratedDamageAdjustment(formula, adjustment) {
	const original = String(formula ?? "").trim();
	const die = original.match(/(\d*)d(\d+)/i);
	if (!die) {
		return scaleDamageFormula(
			original,
			adjustment.bonusDice,
			adjustment.bonusDamage,
			adjustment.includeDice
		);
	}

	const diceDelta = readFiniteNumber(adjustment.diceDelta) ?? 0;
	const adjustedDice = Math.max(0, Math.min(12, Number(die[1] || 1) + diceDelta));
	let scaled = diceDelta
		? original.replace(die[0], `${adjustedDice}d${die[2]}`)
		: original;
	const modifierDelta = readFiniteNumber(adjustment.modifierDelta) ?? 0;
	if (modifierDelta) scaled += ` + ${formatScale(modifierDelta)}`;
	return scaled;
}

function getItemAdjustmentData(itemSource, level, addedLevels, scaling, context = {}) {
	const adjustments = {};
	const damageBonusScale = getScalingMultiplier(scaling, "damageBonus", "damage", 1.4);
	const damageDiceScale = getScalingMultiplier(scaling, "damageDice", "damageDice", 0.25);
	const spellDcScale = getScalingMultiplier(scaling, "spellDc", "spellcasting", 1.35);
	const inlineDamageEnabled = getScalingSetting(
		scaling,
		NPC_LEVEL_SCALING_FIELDS.find(field => field.key === "inlineDamage")
	).enabled;
	const inlineDcEnabled = getScalingSetting(
		scaling,
		NPC_LEVEL_SCALING_FIELDS.find(field => field.key === "inlineDc")
	).enabled;
	const inlineDamageBonus = !inlineDamageEnabled
		? 0
		: addedLevels > 0
			? numericScale(level, damageBonusScale)
			: addedLevels < 0
				? -Math.abs(addedLevels) * damageBonusScale
				: 0;
	const inlineAdjustment = {
		inlineRolls: true,
		diceDelta: inlineDamageEnabled
			? getLevelScalingAdjustment(level, addedLevels, damageDiceScale)
			: 0,
		diceDeltaMode: "count",
		damageBonus: inlineDamageBonus,
		dcBonus: inlineDcEnabled && spellDcScale
			? getLevelScalingAdjustment(level, addedLevels, spellDcScale)
			: 0
	};
	if (/@(?:Damage|Check)\[/.test(itemSource.system?.description?.value ?? "")) {
		adjustments["system.description.value"] = inlineAdjustment;
	}

	if (itemSource.type === "melee" || itemSource.type === "weapon") {
		const attackBonus = readFiniteNumber(itemSource.system?.bonus?.value);
		const strikeRules = itemSource.type === "weapon"
			? (itemSource.system.rules ?? [])
				.map((rule, index) => ({ rule, index }))
				.filter(({ rule }) => rule?.key === "Strike")
			: [];
		if (attackBonus !== null && strikeRules.length === 0) {
			const attackScale = getScalingMultiplier(scaling, "strikeAttack", "attack", 1.45);
			adjustments["system.bonus.value"] = !attackScale
				? 0
				: addedLevels > 0
					? Math.max(attackBonus, 5) + floorScale(level, attackScale) - attackBonus
					: getLevelScalingAdjustment(level, addedLevels, attackScale);
		}
		if (itemSource.type === "weapon") {
			const dice = readFiniteNumber(itemSource.system?.damage?.dice);
			if (dice !== null) {
				const diceAdjustment = getLevelScalingAdjustment(
					level,
					addedLevels,
					damageDiceScale
				);
				adjustments["system.damage.dice"] = Math.max(0, dice + diceAdjustment) - dice;
			}
			const modifier = readFiniteNumber(itemSource.system?.damage?.modifier);
			if (modifier !== null) {
				adjustments["system.damage.modifier"] = getLevelScalingAdjustment(
					level,
					addedLevels,
					damageBonusScale
				);
			}
			for (const { rule: strikeRule, index: strikeRuleIndex } of strikeRules) {
				const sourceAttack = readFiniteNumber(strikeRule.attackModifier);
				const baseAttack = sourceAttack ?? Math.round(1.5 * (level - addedLevels) + 7);
				const attackScale = getScalingMultiplier(scaling, "strikeAttack", "attack", 1.45);
				if (attackScale || sourceAttack !== null) {
					const adjustedAttack = !attackScale
						? sourceAttack
						: addedLevels > 0
							? Math.max(baseAttack, 5) + floorScale(level, attackScale)
							: addedLevels < 0
								? baseAttack + getLevelScalingAdjustment(level, addedLevels, attackScale)
								: sourceAttack;
					adjustments[`system.rules.${strikeRuleIndex}.attackModifier`] = {
						set: adjustedAttack,
						delta: adjustedAttack === null ? 0 : adjustedAttack - baseAttack
					};
				}
				const baseDice = readFiniteNumber(strikeRule.damage?.base?.dice);
				if (baseDice !== null) {
					const diceAdjustment = getLevelScalingAdjustment(level, addedLevels, damageDiceScale);
					adjustments[`system.rules.${strikeRuleIndex}.damage.base.dice`] =
						Math.max(0, baseDice + diceAdjustment) - baseDice;
				}
				const baseDamageModifier = readFiniteNumber(strikeRule.damage?.base?.modifier);
				if (baseDamageModifier !== null) {
					adjustments[`system.rules.${strikeRuleIndex}.damage.base.modifier`] =
						getLevelScalingAdjustment(level, addedLevels, damageBonusScale);
				}
			}
		}
		if (itemSource.type === "melee") {
			const baseLevel = level - addedLevels;
			const actor = context.actor;
			const baseActorLevel = getNpcActorLevel(baseLevel, actor);
			const effectiveActorLevel = readFiniteNumber(actor?.level)
				?? getNpcActorLevel(level, actor);
			const baseAttack = getNpcGeneratedAttack(baseActorLevel);
			const effectiveAttack = getNpcGeneratedAttack(effectiveActorLevel);
			if (attackBonus !== null) {
				adjustments["system.bonus.value"] = addedLevels !== 0 &&
					getScalingMultiplier(scaling, "strikeAttack", "attack", 1.45)
					? effectiveAttack - baseAttack
					: 0;
			}

			const damageRolls = Object.entries(itemSource.system?.damageRolls ?? {});
			const baseRoll = damageRolls.find(([, roll]) => !roll?.category) ?? damageRolls[0];
			if (baseRoll && typeof baseRoll[1]?.damage === "string") {
				const bonusDice = getLevelScalingAdjustment(level, addedLevels, damageDiceScale);
				const bonusDamage = addedLevels > 0
					? numericScale(level, damageBonusScale)
					: addedLevels < 0
						? -Math.abs(addedLevels) * damageBonusScale
						: 0;
				adjustments[`system.damageRolls.${baseRoll[0]}.damage`] = {
					bonusDice,
					bonusDamage,
					includeDice: true
				};
			}
		}
	} else if (itemSource.type === "spellcastingEntry") {
		for (const key of ["value", "dc"]) {
			if (readFiniteNumber(itemSource.system?.spelldc?.[key]) !== null) {
				const scaleKey = key === "value" ? "spellAttack" : "spellDc";
				adjustments[`system.spelldc.${key}`] =
					getLevelScalingAdjustment(
						level,
						addedLevels,
						getScalingMultiplier(scaling, scaleKey, "spellcasting", 1.35)
					);
			}
		}
	}
	return adjustments;
}

function applyItemAdjustments(originalSystem, adjustments = {}) {
	const adjustedSystem = foundry.utils.deepClone(originalSystem);
	for (const [path, adjustment] of Object.entries(adjustments)) {
		const systemPath = path.replace(/^system\./, "");
		const originalValue = foundry.utils.getProperty(originalSystem, systemPath);
		if (adjustment && typeof adjustment === "object" && Object.hasOwn(adjustment, "set")) {
			foundry.utils.setProperty(adjustedSystem, systemPath, adjustment.set);
		} else if (typeof adjustment === "number") {
			const value = readFiniteNumber(originalValue);
			if (value !== null) foundry.utils.setProperty(adjustedSystem, systemPath, value + adjustment);
		} else if (typeof originalValue === "string" && adjustment && typeof adjustment === "object") {
			foundry.utils.setProperty(
				adjustedSystem,
				systemPath,
				adjustment.inlineRolls
					? transformInlineRollText(originalValue, adjustment)
					: adjustment.pf2eGenerated
					? applyNpcGeneratedDamageAdjustment(originalValue, adjustment)
					: scaleDamageFormula(originalValue, adjustment.bonusDice, adjustment.bonusDamage, adjustment.includeDice)
			);
		}
	}
	return adjustedSystem;
}

function captureOriginalSystem(actor, existingOriginal, legacyScaling, baseLevel) {
	const originalSystem = existingOriginal
		? foundry.utils.deepClone(existingOriginal)
		: foundry.utils.deepClone(actor._source.system);
	if (existingOriginal) return originalSystem;
	for (const path of DIRECT_SCALING_STAT_PATHS) {
		const value = readFiniteNumber(foundry.utils.getProperty(legacyScaling?.baseStats, path));
		if (value !== null) {
			foundry.utils.setProperty(originalSystem, path.replace(/^system\./, ""), value);
		}
	}
	for (const [slug, value] of Object.entries(legacyScaling?.baseStats?.skills ?? {})) {
		const baseValue = readFiniteNumber(value);
		if (baseValue !== null) foundry.utils.setProperty(originalSystem, `skills.${slug}.base`, baseValue);
	}
	const baseHp = readFiniteNumber(legacyScaling?.baseStats?.hpMaximum);
	if (baseHp !== null) foundry.utils.setProperty(originalSystem, "attributes.hp.max", baseHp);
	if (Number.isInteger(baseLevel)) {
		foundry.utils.setProperty(originalSystem, "details.level.value", baseLevel);
	}
	return originalSystem;
}

function captureOriginalItemSystem(item, storedOriginal, legacyBase) {
	const originalSystem = storedOriginal
		? foundry.utils.deepClone(storedOriginal)
		: foundry.utils.deepClone(item._source.system);
	if (storedOriginal || !legacyBase) return originalSystem;
	if (readFiniteNumber(legacyBase.attackBonus) !== null) {
		foundry.utils.setProperty(originalSystem, "bonus.value", legacyBase.attackBonus);
	}
	if (legacyBase.damageRolls) {
		foundry.utils.setProperty(originalSystem, "damageRolls", foundry.utils.deepClone(legacyBase.damageRolls));
	}
	for (const key of ["value", "dc"]) {
		const value = readFiniteNumber(legacyBase.spellDc?.[key]);
		if (value !== null) foundry.utils.setProperty(originalSystem, `spelldc.${key}`, value);
	}
	return originalSystem;
}

function calculateActorAdjustments(originalSystem, effectiveLevel, addedLevels, scaling) {
	const adjustments = { "details.level.value": addedLevels };
	for (const path of DIRECT_SCALING_STAT_PATHS) {
		let scalingKey;
		let legacyKey;
		let defaultValue;
		if (path === "system.attributes.ac.value") {
			scalingKey = "ac";
			defaultValue = 1.475;
		} else if (path.startsWith("system.saves.")) {
			scalingKey = `save${path.split(".")[2].replace(/\b\w/g, letter => letter.toUpperCase())}`;
			legacyKey = "saves";
			defaultValue = 1.4;
		} else if (path === "system.perception.mod") {
			scalingKey = "perception";
			defaultValue = 1.4;
		} else if (path.startsWith("system.abilities.")) {
			const ability = path.split(".")[2];
			scalingKey = `ability${ability[0].toUpperCase()}${ability.slice(1)}`;
			legacyKey = "abilities";
			defaultValue = 0.3;
		}
		const bonus = getLevelScalingAdjustment(
			effectiveLevel,
			addedLevels,
			getScalingMultiplier(scaling, scalingKey, legacyKey, defaultValue)
		);
		const systemPath = path.slice("system.".length);
		if (readFiniteNumber(foundry.utils.getProperty(originalSystem, systemPath)) !== null) {
			adjustments[systemPath] = bonus;
		}
	}
	for (const attribute of ["weaknesses", "resistances"]) {
		const scalingKey = attribute === "weaknesses" ? "weakness" : "resistance";
		for (const [index, entry] of (originalSystem.attributes?.[attribute] ?? []).entries()) {
			if (readFiniteNumber(entry?.value) !== null) {
				adjustments[`attributes.${attribute}.${index}.value`] = getLevelScalingAdjustment(
					effectiveLevel,
					addedLevels,
					getScalingMultiplier(scaling, scalingKey, "damage", 1.4)
				);
			}
		}
	}
	const damageBonusScale = getScalingMultiplier(scaling, "damageBonus", "damage", 1.4);
	const damageDiceScale = getScalingMultiplier(scaling, "damageDice", "damageDice", 0.25);
	const spellDcScale = getScalingMultiplier(scaling, "spellDc", "spellcasting", 1.35);
	const inlineDamageEnabled = getScalingSetting(
		scaling,
		NPC_LEVEL_SCALING_FIELDS.find(field => field.key === "inlineDamage")
	).enabled;
	const inlineDcEnabled = getScalingSetting(
		scaling,
		NPC_LEVEL_SCALING_FIELDS.find(field => field.key === "inlineDc")
	).enabled;
	const inlineDamageBonus = !inlineDamageEnabled
		? 0
		: addedLevels > 0
			? numericScale(effectiveLevel, damageBonusScale)
			: addedLevels < 0
				? -Math.abs(addedLevels) * damageBonusScale
				: 0;
	const inlineAdjustment = {
		inlineRolls: true,
		diceDelta: inlineDamageEnabled
			? getLevelScalingAdjustment(effectiveLevel, addedLevels, damageDiceScale)
			: 0,
		diceDeltaMode: "count",
		damageBonus: inlineDamageBonus,
		dcBonus: inlineDcEnabled
			? getLevelScalingAdjustment(effectiveLevel, addedLevels, spellDcScale)
			: 0
	};
	for (const path of ["details.publicNotes", "details.privateNotes"]) {
		const notes = foundry.utils.getProperty(originalSystem, path);
		if (typeof notes === "string" && /@(?:Damage|Check)\[/.test(notes)) {
			adjustments[path] = inlineAdjustment;
		}
	}
	for (const [slug, skill] of Object.entries(originalSystem.skills ?? {})) {
		if (readFiniteNumber(skill?.base) !== null) {
			const scalingKey = `skill_${slug}`;
			adjustments[`skills.${slug}.base`] = getLevelScalingAdjustment(
				effectiveLevel,
				addedLevels,
				getScalingMultiplier(scaling, scalingKey, "skills", 1.4)
			);
		}
	}
	if (readFiniteNumber(originalSystem.attributes?.hp?.max) !== null) {
		const hpScale = getScalingMultiplier(scaling, "hp", "hp", 1.15);
		const percentAdjustment = addedLevels > 0
			? effectiveLevel > 1
				? effectiveLevel * floorScale(effectiveLevel, hpScale)
				: 0
			: addedLevels < 0
				? -Math.abs(addedLevels) * Math.floor(Math.abs(addedLevels) * hpScale)
				: 0;
		const flatAdjustment = addedLevels *
			getScalingMultiplier(scaling, "hpPerLevel", "hpPerLevel", 0);
		adjustments["attributes.hp.max"] = percentAdjustment + flatAdjustment;
	}
	return adjustments;
}

function buildAdjustedActorData(originalSystem, adjustments) {
	const updates = {};
	for (const [systemPath, adjustment] of Object.entries(adjustments)) {
		if (/^attributes\.(?:weaknesses|resistances)\.\d+\.value$/.test(systemPath)) continue;
		const original = foundry.utils.getProperty(originalSystem, systemPath);
		if (adjustment && typeof adjustment === "object" && adjustment.inlineRolls && typeof original === "string") {
			updates[`system.${systemPath}`] = transformInlineRollText(original, adjustment);
			continue;
		}
		const originalValue = readFiniteNumber(original);
		if (originalValue !== null) {
			const bonus = readFiniteNumber(adjustment) ?? 0;
			const adjustedValue = originalValue + bonus;
			updates[`system.${systemPath}`] = systemPath === "attributes.hp.max"
				? Math.max(0, adjustedValue)
				: adjustedValue;
		}
	}
	for (const attribute of ["weaknesses", "resistances"]) {
		const entries = originalSystem.attributes?.[attribute];
		if (!Array.isArray(entries)) continue;
		const adjustedEntries = foundry.utils.deepClone(entries);
		let changed = false;
		for (const [index, entry] of entries.entries()) {
			const adjustment = readFiniteNumber(
				adjustments[`attributes.${attribute}.${index}.value`]
			);
			const originalValue = readFiniteNumber(entry?.value);
			if (adjustment === null || originalValue === null) continue;
			adjustedEntries[index].value = Math.max(0, originalValue + adjustment);
			changed = true;
		}
		if (changed) updates[`system.attributes.${attribute}`] = adjustedEntries;
	}
	return updates;
}

function buildItemUpdate(itemId, system, currentSystem, originalSystem, adjustments) {
	const update = { _id: itemId };
	const currentSystemData = foundry.utils.flattenObject(currentSystem);
	for (const [path, value] of Object.entries(foundry.utils.flattenObject(system))) {
		if (JSON.stringify(currentSystemData[path]) !== JSON.stringify(value)) {
			update[`system.${path}`] = value;
		}
	}
	update["flags.vurs.npcConfiguration.originalData.system"] = originalSystem;
	update["flags.vurs.npcConfiguration.adjustments"] = adjustments;
	return update;
}

function getLinkedAttackSignature(item) {
	const system = item.system ?? {};
	const range = system.range
		? [system.range.increment ?? null, system.range.max ?? null]
		: null;
	return JSON.stringify([
		item.name,
		system.action,
		range
	]);
}

function buildLinkedAttackUpdate(item, generatedData) {
	const currentSystem = item._source.system;
	const generatedSystem = foundry.utils.deepClone(generatedData.system);
	const currentDamageRolls = Object.entries(currentSystem.damageRolls ?? {});
	const generatedDamageRolls = Object.entries(generatedSystem.damageRolls ?? {});
	const stableDamageRolls = {};
	generatedDamageRolls.forEach(([, roll], index) => {
		const key = currentDamageRolls[index]?.[0] ?? generatedDamageRolls[index][0];
		stableDamageRolls[key] = roll;
	});
	generatedSystem.damageRolls = stableDamageRolls;

	const update = { _id: item.id };
	const currentSystemData = foundry.utils.flattenObject(currentSystem);
	const generatedSystemData = foundry.utils.flattenObject(generatedSystem);
	for (const [path, value] of Object.entries(generatedSystemData)) {
		if (JSON.stringify(currentSystemData[path]) !== JSON.stringify(value)) {
			update[`system.${path}`] = value;
		}
	}
	for (const [key] of currentDamageRolls.slice(generatedDamageRolls.length)) {
		update[`system.damageRolls.-=${key}`] = null;
	}
	if (item.flags?.pf2e?.linkedWeapon !== generatedData.flags?.pf2e?.linkedWeapon) {
		update["flags.pf2e.linkedWeapon"] = generatedData.flags?.pf2e?.linkedWeapon;
	}
	return update;
}

function isGeneratedNpcWeapon(item) {
	return item?.type === "weapon" &&
		typeof item.flags?.vurs?.npcConfiguration?.generatedFromMelee === "string";
}

async function refreshLinkedWeaponAttacks(actor) {
	const updates = [];
	const linkedAttacksByWeapon = new Map();
	for (const item of actor.items) {
		if (item.type !== "melee") continue;
		const weaponId = item.flags?.pf2e?.linkedWeapon;
		if (!weaponId) continue;
		const attacks = linkedAttacksByWeapon.get(weaponId) ?? [];
		attacks.push(item);
		linkedAttacksByWeapon.set(weaponId, attacks);
	}

	for (const weapon of actor.items.filter(item => item.type === "weapon")) {
		if (isGeneratedNpcWeapon(weapon)) continue;
		const linkedAttacks = linkedAttacksByWeapon.get(weapon.id) ?? [];
		if (!linkedAttacks.length) continue;

		const generatedAttacks = weapon.toNPCAttacks().map(attack => attack.toObject());
		if (generatedAttacks.length !== linkedAttacks.length) {
			throw new Error(
				`Expected ${generatedAttacks.length} linked attacks for ${weapon.name}, found ${linkedAttacks.length}.`
			);
		}
		const unmatchedAttacks = [...linkedAttacks];
		for (const generatedAttack of generatedAttacks) {
			const index = unmatchedAttacks.findIndex(
				attack => getLinkedAttackSignature(attack._source) === getLinkedAttackSignature(generatedAttack)
			);
			if (index < 0) {
				throw new Error(`Could not match a regenerated linked attack for ${weapon.name}.`);
			}
			updates.push(buildLinkedAttackUpdate(unmatchedAttacks.splice(index, 1)[0], generatedAttack));
		}
	}

	if (updates.length) {
		await actor.updateEmbeddedDocuments("Item", updates, {
			render: false,
			vursNpcConfigurationUpdate: true
		});
	}
}

class NpcConfigurationApplication extends foundry.applications.api.HandlebarsApplicationMixin(
	foundry.applications.api.ApplicationV2
) {
	static DEFAULT_OPTIONS = {
		id: `${MODULE_ID}-npc-configuration`,
		classes: [MODULE_ID, "vurs-npc-configuration"],
		tag: "form",
		position: { width: 560 },
		window: { title: "NPC Configuration", resizable: true },
		form: { submitOnChange: false, closeOnSubmit: false }
	};

	static PARTS = {
		form: { template: `modules/${MODULE_ID}/templates/npcConfiguration.hbs` }
	};

	constructor(actor, selectedTab = "levels") {
		super({ id: `${MODULE_ID}-npc-configuration-${actor.id}` });
		this.actor = actor;
		this.selectedTab = selectedTab;
	}

	async _prepareContext() {
		const configuration = foundry.utils.getProperty(this.actor, NPC_CONFIGURATION_PATH) ?? {};
		const addedLevels = Number.isInteger(Number(configuration.addedLevels))
			? Number(configuration.addedLevels)
			: 0;
		const relationshipStatistics = getRelationshipStatistics(configuration);
		const relationshipRank = getRelationshipRank(relationshipStatistics);
		const relationshipLevelAdjustment = getRelationshipLevelAdjustment(relationshipRank);
		const originalLevel = Number(foundry.utils.getProperty(
			configuration,
			"originalData.system.details.level.value"
		));
		const storedBaseLevel = Number(configuration.baseLevel);
		const baseLevel = Number.isInteger(originalLevel)
			? originalLevel
			: Number.isInteger(storedBaseLevel)
				? storedBaseLevel
				: getCurrentNpcLevel(this.actor) - addedLevels
					- (configuration.relationshipStatistics
						? relationshipLevelAdjustment
						: Number(configuration.affection) || 0);
		const followerLevel = getFollowerLevelData(configuration, baseLevel);
		const finalLevel = baseLevel
			+ (followerLevel.active ? followerLevel.addedLevels : addedLevels)
			+ relationshipLevelAdjustment;
		const followerLevelWarning = followerLevel.active
			? getFollowerLevelClampWarning(finalLevel)
			: "";
		return {
			actorName: this.actor.name,
			addedLevels,
			followerActive: followerLevel.active,
			followerBaseLevel: followerLevel.baseFollowerLevel,
			followerPlayerControlOptions: [
				{ value: "inherit", label: "Use module setting" },
				{ value: "allow", label: "Always allow player control" },
				{ value: "deny", label: "Never allow player control" }
			].map(option => ({
				...option,
				selected: (configuration.follower?.playerControlOverride ?? "inherit") === option.value
			})),
			followerParties: getFollowerPartyOptions(configuration),
			followerPartyLevelLabel: followerLevel.partyLevel === null
				? "Unavailable"
				: String(followerLevel.partyLevel),
			followerTargetLevelLabel: followerLevel.targetLevel === null
				? "Unavailable"
				: String(followerLevel.targetLevel),
			followerStatus: !followerLevel.active
				? "This NPC is not currently assigned to a party."
				: followerLevel.partyLevel === null
					? "No valid player-character members are available. The last applied follower level is preserved."
					: "The party average is rounded down before applying the Base Follower Level.",
			relationshipFields: NPC_RELATIONSHIP_STATISTICS.map(field => ({
				...field,
				...getAttributePresentation(field.attribute, this.actor),
				value: readFiniteNumber(relationshipStatistics[field.key]) ?? 0
			})),
			relationshipStatistics,
			relationshipRank,
			relationshipLevelAdjustment,
			baseLevel,
			finalLevel: followerLevel.active ? clampNpcLevel(finalLevel) : finalLevel,
			followerLevelWarning,
			scalingGroups: getNpcLevelScalingGroups(
				configuration.originalData?.system ?? this.actor._source.system,
				configuration.scaling,
				this.actor
			),
			resources: NPC_CONFIGURATION_RESOURCES.map(resource => ({
				...resource,
				formula: configuration.formulas?.[resource.key] ?? "",
				derivedFormula: getNpcPlayResourceDerivedFormula(this.actor, resource.key)
			})),
			editable: this.actor.isOwner
		};
	}

	_onRender(context, options) {
		super._onRender(context, options);
		const form = this.element?.matches("form")
			? this.element
			: this.element?.querySelector("form");
		if (!form || form.dataset.vursNpcConfigurationHandlers) return;
		form.dataset.baseLevel = String(context.baseLevel);
		form.dataset.followerAppliedTarget = String(
			foundry.utils.getProperty(this.actor, `${NPC_CONFIGURATION_PATH}.follower.appliedTargetLevel`) ?? ""
		);
		form.dataset.vursNpcConfigurationHandlers = "true";
		form.addEventListener("submit", event => {
			event.preventDefault();
			void this.#save(form);
		});
		form.querySelectorAll("[data-npc-config-tab]").forEach(button => {
			button.addEventListener("click", () => {
				const tabName = button.dataset.npcConfigTab;
				this.selectedTab = tabName;
				form.querySelectorAll("[data-npc-config-tab]").forEach(tab => {
					const selected = tab === button;
					tab.classList.toggle("active", selected);
					tab.setAttribute("aria-selected", String(selected));
				});
				form.querySelectorAll("[data-npc-config-panel]").forEach(panel => {
					panel.hidden = panel.dataset.npcConfigPanel !== tabName;
				});
			});
		});
		form.querySelector(`[data-npc-config-tab="${this.selectedTab}"]`)?.click();
		form.querySelector("[data-npc-config-reset-levels]")?.addEventListener("click", () => {
			form.elements.namedItem("addedLevels").value = "0";
			form.querySelectorAll(".npc-config-scaling-field input[type='number']").forEach(input => {
				input.value = input.dataset.defaultValue;
			});
			form.querySelectorAll(".npc-config-scaling-field input[type='checkbox']").forEach(input => {
				input.checked = input.dataset.defaultEnabled !== "false";
			});
		});
		form.addEventListener("input", () => this.#updateRelationshipSummary(form));
		form.addEventListener("change", () => this.#updateRelationshipSummary(form));
		this.#updateRelationshipSummary(form);
	}

	#updateRelationshipSummary(form) {
		const statistics = Object.fromEntries(NPC_RELATIONSHIP_STATISTICS.map(({ key }) => [
			key,
			Number(form.elements.namedItem(`relationshipStatistics.${key}`)?.value) || 0
		]));
		const rank = getRelationshipRank(statistics);
		const levelAdjustment = getRelationshipLevelAdjustment(rank);
		const baseLevel = Number(form.dataset.baseLevel);
		const addedLevels = Number(form.elements.namedItem("addedLevels")?.value) || 0;
		const selectedParty = getFollowerParty(form.elements.namedItem("follower.partyUuid")?.value);
		const partyLevel = getFollowerPartyLevel(selectedParty);
		const followerOffset = Number(form.elements.namedItem("follower.baseLevel")?.value) || 0;
		const followerTarget = partyLevel === null ? null : partyLevel + followerOffset;
		const storedTarget = readFiniteNumber(form.dataset.followerAppliedTarget);
		const partyUuid = form.elements.namedItem("follower.partyUuid")?.value;
		const followerActive = Boolean(partyUuid);
		const effectiveLevel = followerTarget ?? (
			Number.isSafeInteger(storedTarget) ? storedTarget : baseLevel + addedLevels
		);
		const calculatedFinalLevel = followerActive
			? effectiveLevel + levelAdjustment
			: baseLevel + addedLevels + levelAdjustment;
		const followerLevelWarning = followerActive
			? getFollowerLevelClampWarning(calculatedFinalLevel)
			: "";
		const rankOutput = form.querySelector("[data-relationship-rank]");
		if (rankOutput) rankOutput.textContent = Number(rank.toFixed(2)).toString();
		form.querySelectorAll("[data-relationship-level-adjustment]").forEach(output => {
			output.textContent = String(levelAdjustment);
		});
		const finalLevelOutput = form.querySelector("[data-final-level]");
		if (finalLevelOutput) {
			finalLevelOutput.textContent = String(
				followerActive ? clampNpcLevel(calculatedFinalLevel) : calculatedFinalLevel
			);
		}
		const followerLevelWarningOutput = form.querySelector("[data-follower-level-warning]");
		if (followerLevelWarningOutput) {
			followerLevelWarningOutput.textContent = followerLevelWarning;
			followerLevelWarningOutput.hidden = !followerLevelWarning;
		}
		const partyLevelOutput = form.querySelector("[data-follower-party-level]");
		if (partyLevelOutput) partyLevelOutput.textContent = partyLevel === null ? "Unavailable" : String(partyLevel);
		const targetLevelOutput = form.querySelector("[data-follower-target-level]");
		if (targetLevelOutput) {
			targetLevelOutput.textContent = partyLevel === null
				? Number.isSafeInteger(storedTarget) ? String(storedTarget) : "Unavailable"
				: String(followerTarget);
		}
		const status = form.querySelector("[data-follower-status]");
		if (status) {
			const partyUuid = form.elements.namedItem("follower.partyUuid")?.value;
			status.textContent = !partyUuid
				? "This NPC is not currently assigned to a party."
				: partyLevel === null
					? "No valid player-character members are available. The last applied follower level is preserved."
					: "The party average is rounded down before applying the Base Follower Level.";
		}
	}

	async synchronizeFollowerLevel() {
		await this.#save(null, true);
	}

	async #save(form, synchronizeFollower = false) {
		if (!this.actor.isOwner) {
			if (!synchronizeFollower) ui.notifications.warn("You do not have permission to configure this NPC.");
			return;
		}
		if (!form && !synchronizeFollower) return;
		const saveButton = form?.querySelector('[type="submit"]');
		if (saveButton?.disabled) return;
		if (saveButton) saveButton.disabled = true;
		let actorUpdateSucceeded = false;
		let followerPermissionsSynchronized = true;
		try {
			const formData = form ? new FormData(form) : null;
			const currentConfiguration = foundry.utils.getProperty(this.actor, NPC_CONFIGURATION_PATH) ?? {};
			const addedLevelsValue = String(
				synchronizeFollower
					? currentConfiguration.addedLevels ?? 0
					: formData.get("addedLevels") ?? ""
			).trim();
			const addedLevels = Number(addedLevelsValue);
			if (!addedLevelsValue || !Number.isSafeInteger(addedLevels)) {
				if (!synchronizeFollower) ui.notifications.warn("Adjusted Level must be a whole number.");
				return;
			}
			const relationshipStatistics = {};
			for (const { key, label } of NPC_RELATIONSHIP_STATISTICS) {
				const valueString = String(
					synchronizeFollower
						? getRelationshipStatistics(currentConfiguration)[key]
						: formData.get(`relationshipStatistics.${key}`) ?? ""
				).trim();
				const value = Number(valueString);
				if (!valueString || !Number.isSafeInteger(value)) {
					if (!synchronizeFollower) ui.notifications.warn(`${label} must be a whole number.`);
					return;
				}
				relationshipStatistics[key] = value;
			}
			const relationshipRank = getRelationshipRank(relationshipStatistics);
			const relationshipLevelAdjustment = getRelationshipLevelAdjustment(relationshipRank);

			const previousAddedLevels = Number.isInteger(Number(currentConfiguration.addedLevels))
				? Number(currentConfiguration.addedLevels)
				: 0;
			const previousRelationshipStatistics = getRelationshipStatistics(currentConfiguration);
			const previousRelationshipLevelAdjustment = currentConfiguration.relationshipStatistics
				? getRelationshipLevelAdjustment(getRelationshipRank(previousRelationshipStatistics))
				: Number(currentConfiguration.affection) || 0;
			const previousScaling = currentConfiguration.levelScaling ?? {};
			const savedScaling = currentConfiguration.scaling ?? {};
			const priorOriginalLevel = Number(foundry.utils.getProperty(
				currentConfiguration,
				"originalData.system.details.level.value"
			));
			const storedBaseLevel = Number(currentConfiguration.baseLevel);
			const baseLevel = Number.isInteger(priorOriginalLevel)
				? priorOriginalLevel
				: Number.isInteger(storedBaseLevel)
					? storedBaseLevel
					: getCurrentNpcLevel(this.actor) - previousAddedLevels - previousRelationshipLevelAdjustment;
			const originalSystem = captureOriginalSystem(
				this.actor,
				currentConfiguration.originalData?.system,
				previousScaling,
				baseLevel
			);
			const followerPartyUuid = String(
				synchronizeFollower
					? currentConfiguration.follower?.partyUuid ?? ""
					: formData.get("follower.partyUuid") ?? ""
			).trim();
			const baseFollowerLevelValue = String(
				synchronizeFollower
					? currentConfiguration.follower?.baseFollowerLevel ?? 0
					: formData.get("follower.baseLevel") ?? 0
			).trim();
			const baseFollowerLevel = Number(baseFollowerLevelValue);
			if (!baseFollowerLevelValue || !Number.isSafeInteger(baseFollowerLevel)) {
				if (!synchronizeFollower) ui.notifications.warn("Base Follower Level must be a whole number.");
				return;
			}
			const playerControlOverride = String(
				synchronizeFollower
					? currentConfiguration.follower?.playerControlOverride ?? "inherit"
					: formData.get("follower.playerControlOverride") ?? "inherit"
			);
			if (!["inherit", "allow", "deny"].includes(playerControlOverride)) {
				if (!synchronizeFollower) ui.notifications.warn("Choose a valid follower player-control override.");
				return;
			}
			const followerParty = getFollowerParty(followerPartyUuid);
			const followerPartyLevel = getFollowerPartyLevel(followerParty);
			const priorFollower = currentConfiguration.follower ?? {};
			const priorFollowerTarget = readFiniteNumber(priorFollower.appliedTargetLevel);
			const preservedFollowerTarget = Number.isSafeInteger(priorFollowerTarget)
				? priorFollowerTarget
				: baseLevel + getEffectiveNpcAddedLevels(currentConfiguration, baseLevel);
			const followerTargetLevel = followerPartyUuid
				? followerPartyLevel === null
					? preservedFollowerTarget
					: followerPartyLevel + baseFollowerLevel
				: null;
			if (followerPartyUuid && !Number.isSafeInteger(followerTargetLevel)) {
				if (!synchronizeFollower) ui.notifications.warn("The resulting follower target level must be a safe whole number.");
				return;
			}
			if (synchronizeFollower) {
				if (!followerPartyUuid || followerPartyLevel === null || followerTargetLevel === priorFollowerTarget) return;
			} else if (followerPartyUuid && followerPartyLevel === null) {
				ui.notifications.warn("No player characters with valid levels are in the assigned Party. The last applied follower level will be preserved.");
			}
			const effectiveAddedLevels = followerPartyUuid && Number.isSafeInteger(followerTargetLevel)
				? followerTargetLevel - baseLevel
				: addedLevels;
			const totalLevelBonus = effectiveAddedLevels + relationshipLevelAdjustment;
			const calculatedEffectiveLevel = Number(foundry.utils.getProperty(originalSystem, "details.level.value")) + totalLevelBonus;
			if (!Number.isSafeInteger(calculatedEffectiveLevel)) {
				if (!synchronizeFollower) {
					ui.notifications.warn(`The resulting NPC level must be between ${MIN_NPC_LEVEL} and ${MAX_NPC_LEVEL}.`);
				}
				return;
			}
			const effectiveLevel = followerPartyUuid
				? clampNpcLevel(calculatedEffectiveLevel)
				: calculatedEffectiveLevel;
			if (!followerPartyUuid &&
				(effectiveLevel < MIN_NPC_LEVEL || effectiveLevel > MAX_NPC_LEVEL)) {
				if (!synchronizeFollower) {
					ui.notifications.warn(`The resulting NPC level must be between ${MIN_NPC_LEVEL} and ${MAX_NPC_LEVEL}.`);
				}
				return;
			}
			const scaling = {};
			const scalingGroups = getNpcLevelScalingGroups(originalSystem, {}, this.actor);
			for (const { fields } of scalingGroups) {
				for (const { key, label, defaultValue, defaultEnabled } of fields) {
					const storedSetting = savedScaling[key];
					const value = String(
						synchronizeFollower
							? storedSetting?.multiplier ?? defaultValue
							: formData.get(`scaling.${key}`) ?? ""
					).trim();
					const multiplier = value ? Number(value) : defaultValue;
					if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
						if (!synchronizeFollower) ui.notifications.warn(`${label} scaling must be between 0 and 100.`);
						return;
					}
					scaling[key] = {
						multiplier,
						enabled: synchronizeFollower
							? storedSetting
								? storedSetting.enabled !== false
								: defaultEnabled !== false
							: formData.get(`scalingEnabled.${key}`) === "on"
					};
				}
			}
			const formulas = {};
			for (const { key } of NPC_CONFIGURATION_RESOURCES) {
				const formula = String(
					synchronizeFollower
						? currentConfiguration.formulas?.[key] ?? ""
						: formData.get(`formulas.${key}`) ?? ""
				).trim();
				if (!formula) continue;
				evaluateFormula(this.actor, key, formula);
				formulas[key] = formula;
			}

			const adjustmentSystem = calculateActorAdjustments(
				originalSystem,
				effectiveLevel,
				totalLevelBonus,
				scaling
			);
			const actorUpdates = buildAdjustedActorData(originalSystem, adjustmentSystem);
			const savedFormulas = { ...formulas };
			for (const resourceKey of Object.keys(currentConfiguration.formulas ?? {})) {
				if (!Object.hasOwn(formulas, resourceKey)) {
					savedFormulas[resourceKey] = new foundry.data.operators.ForcedDeletion();
				}
			}
			const configuration = {
				formulas: savedFormulas,
				addedLevels,
				follower: {
					partyUuid: followerPartyUuid,
					baseFollowerLevel,
					playerControlOverride,
					...(followerPartyUuid
						? { appliedTargetLevel: followerTargetLevel }
						: Number.isSafeInteger(priorFollowerTarget)
							? { appliedTargetLevel: priorFollowerTarget }
							: {})
				},
				relationshipStatistics,
				baseLevel,
				scaling,
				originalData: { system: originalSystem },
				adjustmentData: { system: adjustmentSystem, items: {} }
			};
			await this.actor.update({
				...actorUpdates,
				[NPC_CONFIGURATION_PATH]: configuration
			}, { render: false, vursNpcConfigurationUpdate: true });
			actorUpdateSucceeded = true;

			const adjustmentItems = {};
			const itemUpdates = [];
			for (const item of this.actor.items) {
				if (isGeneratedNpcWeapon(item)) continue;
				const legacyItemData = previousScaling.baseItems?.[item.id];
				const originalItemSystem = captureOriginalItemSystem(
					item,
					item.flags?.vurs?.npcConfiguration?.originalData?.system,
					legacyItemData
				);
				const itemSource = { type: item.type, system: originalItemSystem };
				const isLinkedWeaponAttack = item.type === "melee" &&
					Boolean(item.linkedWeapon) &&
					!isGeneratedNpcWeapon(item.linkedWeapon);
				const itemAdjustment = getItemAdjustmentData(
					itemSource,
					effectiveLevel,
					totalLevelBonus,
					scaling,
					{
						actor: this.actor
					}
				);
				if (isLinkedWeaponAttack) {
					for (const path of Object.keys(itemAdjustment)) {
						if (path !== "system.description.value") delete itemAdjustment[path];
					}
				}
				if (!Object.keys(itemAdjustment).length &&
					!item.flags?.vurs?.npcConfiguration?.originalData?.system &&
					!legacyItemData) continue;
				adjustmentItems[item.id] = itemAdjustment;
				itemUpdates.push(buildItemUpdate(
					item.id,
					applyItemAdjustments(originalItemSystem, itemAdjustment),
					item._source.system,
					originalItemSystem,
					itemAdjustment
				));
			}
			if (itemUpdates.length) {
				await this.actor.updateEmbeddedDocuments("Item", itemUpdates, {
					render: false,
					vursNpcConfigurationUpdate: true
				});
			}
			await refreshLinkedWeaponAttacks(this.actor);
			await this.actor.update({
				[`${NPC_CONFIGURATION_PATH}.adjustmentData.items`]: adjustmentItems
			}, { render: false, vursNpcConfigurationUpdate: true });

			const legacyScalingItems = this.actor.items.filter(isNpcConfigurationLevelItem);
			if (legacyScalingItems.length) {
				await this.actor.deleteEmbeddedDocuments(
					"Item",
					legacyScalingItems.map(item => item.id),
					{ render: false }
				);
			}
			followerPermissionsSynchronized = false;
			await queueFollowerPlayerOwnershipSync(this.actor);
			followerPermissionsSynchronized = true;
			if (this.actor.sheet?.rendered) {
				await this.actor.sheet.render(true);
			}
			if (form) {
				await new Promise(resolve => requestAnimationFrame(resolve));
				this.bringToFront();
			}
		} catch (error) {
			console.error(
				`vurs-pf2e | Failed to ${synchronizeFollower
					? "synchronize follower level"
					: !followerPermissionsSynchronized
						? "synchronize follower player permissions"
						: "save NPC configuration"} for ${this.actor.name}`,
				error
			);
			const message = !followerPermissionsSynchronized
				? `NPC configuration was saved for ${this.actor.name}, but player permissions could not be synchronized. See the console for details.`
				: synchronizeFollower
				? actorUpdateSucceeded
					? `Follower stats were updated for ${this.actor.name}, but an embedded item or linked strike could not be updated. Check the console and retry after correcting the issue.`
					: `Could not synchronize the follower level for ${this.actor.name}. See the console for details.`
				: actorUpdateSucceeded
					? `NPC stats were updated for ${this.actor.name}, but an embedded item or linked strike could not be updated. Save again to retry.`
					: `Could not save NPC configuration for ${this.actor.name}. See the console for details.`;
			ui.notifications.error(message);
		} finally {
			if (saveButton?.isConnected) saveButton.disabled = false;
		}
	}
}

function scheduleFollowerLevelSync(actor) {
	if (!game.user?.isGM || !isNpcActor(actor)) return;
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
	if (!configuration?.follower?.partyUuid || SCHEDULED_FOLLOWER_SYNCS.has(actor.uuid)) return;
	const timeout = setTimeout(async () => {
		const startingConfiguration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
		const startingFollower = startingConfiguration?.follower;
		const startingPartyLevel = getFollowerPartyLevel(getFollowerParty(startingFollower?.partyUuid));
		const startingExpectedLevel = startingPartyLevel === null
			? null
			: startingPartyLevel + Number(startingFollower?.baseFollowerLevel);
		try {
			await new NpcConfigurationApplication(actor).synchronizeFollowerLevel();
		} catch (error) {
			console.error(`vurs-pf2e | Failed to synchronize follower level for ${actor.name}`, error);
		} finally {
			SCHEDULED_FOLLOWER_SYNCS.delete(actor.uuid);
			const currentConfiguration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
			const follower = currentConfiguration?.follower;
			const party = getFollowerParty(follower?.partyUuid);
			const partyLevel = getFollowerPartyLevel(party);
			const expectedLevel = partyLevel === null
				? null
				: partyLevel + Number(follower?.baseFollowerLevel);
			if (Number.isSafeInteger(expectedLevel) &&
				expectedLevel !== startingExpectedLevel) {
				scheduleFollowerLevelSync(actor);
			}
		}
	}, 0);
	SCHEDULED_FOLLOWER_SYNCS.set(actor.uuid, timeout);
}

function scheduleFollowerPartySync(party) {
	if (party?.type !== "party") return;
	for (const actor of game.actors?.contents ?? []) {
		if (foundry.utils.getProperty(actor, `${NPC_CONFIGURATION_PATH}.follower.partyUuid`) === party.uuid) {
			scheduleFollowerLevelSync(actor);
		}
	}
}

function scheduleAllFollowerLevelSyncs() {
	for (const actor of game.actors?.contents ?? []) scheduleFollowerLevelSync(actor);
}

Hooks.once("init", () => {
	registerFollowerTokenColorWrapper();
	registerFollowerTokenControlWrappers();
});
Hooks.once("socketlib.ready", registerFollowerControlSocket);

Hooks.once("ready", () => {
	registerFollowerControlSocket();
	scheduleAllFollowerLevelSyncs();
	void syncAllFollowerPlayerOwnership();
	requestGMTokenSelectionSync();
});

Hooks.on(`${MODULE_ID}.followerPlayerControlChanged`, () => {
	void syncAllFollowerPlayerOwnership();
});

Hooks.on("createUser", () => {
	void syncAllFollowerPlayerOwnership();
	refreshAllTokenRingColors();
});

Hooks.on(`${MODULE_ID}.playerTokenRingColorsChanged`, refreshAllTokenRingColors);

Hooks.on("updateUser", (user, changes = {}) => {
	void syncAllFollowerPlayerOwnership();
	refreshFollowerTokenColorsForUser(user.id);
	const changedUserPaths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
	if (changedUserPaths.some(path =>
		path === "color" ||
		path.startsWith("color.") ||
		path === "character" ||
		path.startsWith("character.")
	)) {
		refreshAllTokenRingColors();
	}
	if (game.user?.isGM && user.active === false) {
		void releaseFollowerClaimsForUser(user.id);
	}
	if (user.isGM && user.active === false && GM_SELECTED_TOKEN_UUIDS.delete(user.id)) {
		refreshAllTokenRingColors();
	}
});

Hooks.on("deleteUser", user => {
	GM_SELECTED_TOKEN_UUIDS.delete(user.id);
	refreshAllTokenRingColors();
	if (!game.user?.isGM) return;
	void releaseFollowerClaimsForUser(user.id);
});

Hooks.on("controlToken", onFollowerTokenControl);
Hooks.on("canvasReady", requestGMTokenSelectionSync);
Hooks.on("renderTokenHUD", renderFollowerControlTokenHud);
Hooks.on("canvasTearDown", releaseLocalFollowerControlClaims);

Hooks.on("createActor", actor => {
	if (isNpcActor(actor)) {
		void queueFollowerPlayerOwnershipSync(actor).catch(error => {
			console.error(`vurs-pf2e | Failed to synchronize player ownership for follower ${actor.name}`, error);
			ui.notifications.error(`Could not synchronize player permissions for ${actor.name}. See the console for details.`);
		});
	}
});

Hooks.on("updateActor", (actor, changes, options = {}) => {
	const changedPaths = Object.keys(foundry.utils.flattenObject(changes));
	if (changedPaths.some(path => path === "ownership" || path.startsWith("ownership."))) {
		refreshTokenRingColors(actor);
	}
	if (isNpcActor(actor) &&
		changedPaths.some(isFollowerControlStateChange)) {
		refreshFollowerTokenColors(actor);
		releaseFollowerTokensControlledByOtherPlayer(actor);
	}
	if (!game.user?.isGM) return;
	if (isNpcActor(actor) &&
		!options.vursFollowerOwnershipUpdate &&
		!options.vursFollowerControlUpdate &&
		changedPaths.some(path => path === NPC_CONFIGURATION_PATH || path.startsWith(`${NPC_CONFIGURATION_PATH}.`))) {
		void queueFollowerPlayerOwnershipSync(actor).catch(error => {
			console.error(`vurs-pf2e | Failed to synchronize player ownership for follower ${actor.name}`, error);
			ui.notifications.error(`Could not synchronize player permissions for ${actor.name}. See the console for details.`);
		});
	}
	if (options.vursNpcConfigurationUpdate || options.vursFollowerOwnershipUpdate) return;
	if (actor.type === "party") {
		if (changedPaths.some(path => path.startsWith("system.details.members"))) {
			scheduleFollowerPartySync(actor);
		}
		return;
	}
	if (actor.type !== "character" ||
		!changedPaths.some(path => path === "system.details.level.value" || path.startsWith("system.details.level."))) {
		return;
	}
	for (const party of game.actors?.contents ?? []) {
		if (party.type !== "party") continue;
		const members = party.system?.details?.members ?? [];
		if (members.some(member => (typeof member === "string" ? member : member?.uuid) === actor.uuid)) {
			scheduleFollowerPartySync(party);
		}
	}
});

Hooks.on("updateToken", (tokenDocument, changes, options = {}) => {
	const actor = getFollowerControlActor(tokenDocument);
	if (!options.vursFollowerControlUpdate || !isNpcActor(actor)) return;
	refreshFollowerTokenColors(actor);
});

Hooks.on("createActor", actor => {
	if (actor.type === "party") scheduleFollowerPartySync(actor);
});

Hooks.on("deleteActor", () => {
	scheduleAllFollowerLevelSyncs();
});

Hooks.on("preUpdateActor", (actor, changes, options = {}) => {
	if (!isNpcActor(actor) || options.vursNpcConfigurationUpdate) return;
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
	const storedSystem = configuration?.originalData?.system;
	if (!storedSystem) return;
	const flatChanges = foundry.utils.flattenObject(changes);
	const systemChanges = Object.entries(flatChanges).filter(([path]) => path.startsWith("system."));
	if (!systemChanges.length) return;
	const originalSystem = foundry.utils.deepClone(storedSystem);
	const adjustments = configuration.adjustmentData?.system ?? {};
	let updatedAdjustments = null;
	for (const [path, value] of systemChanges) {
		const systemPath = path.slice("system.".length);
		const weaknessOrResistance = /^attributes\.(weaknesses|resistances)$/.exec(systemPath);
		if (weaknessOrResistance && Array.isArray(value)) {
			const [, attribute] = weaknessOrResistance;
			const nextAdjustments = foundry.utils.deepClone(updatedAdjustments ?? adjustments);
			for (const adjustmentPath of Object.keys(nextAdjustments)) {
				if (new RegExp(`^attributes\\.${attribute}\\.\\d+\\.value$`).test(adjustmentPath)) {
					delete nextAdjustments[adjustmentPath];
				}
			}
			const originalEntries = foundry.utils.deepClone(value);
			const adjustedEntries = foundry.utils.deepClone(value);
			for (const [index, entry] of value.entries()) {
				const inputValue = readFiniteNumber(entry?.value);
				if (inputValue === null) continue;
				const adjustmentPath = `attributes.${attribute}.${index}.value`;
				const savedAdjustment = getAdjustmentData(adjustments, adjustmentPath);
				const adjustment = savedAdjustment.found
					? readFiniteNumber(savedAdjustment.value) ?? 0
					: getNpcConfigurationLevelAdjustment(actor, "damage");
				const originalValue = inputValue - (savedAdjustment.found
					? readFiniteNumber(savedAdjustment.value) ?? 0
					: 0);
				originalEntries[index].value = originalValue;
				adjustedEntries[index].value = Math.max(0, originalValue + adjustment);
				nextAdjustments[adjustmentPath] = adjustment;
			}
			setUpdateValue(changes, path, adjustedEntries);
			foundry.utils.setProperty(originalSystem, systemPath, originalEntries);
			updatedAdjustments = nextAdjustments;
			continue;
		}

		const adjustmentData = getAdjustmentData(adjustments, systemPath);
		const adjustment = adjustmentData.value;
		if (typeof value === "string" && adjustment?.inlineRolls) {
			const originalValue = restoreInlineRollText(value, adjustment);
			setUpdateValue(changes, path, transformInlineRollText(originalValue, adjustment));
			foundry.utils.setProperty(originalSystem, systemPath, originalValue);
			continue;
		}
		const numericValue = readFiniteNumber(value);
		const newIwrValue = /^(attributes\.(?:weaknesses|resistances)\.\d+\.value)$/.exec(systemPath);
		const numericAdjustment = readFiniteNumber(adjustment) ?? (newIwrValue && !adjustmentData.found
			? getNpcConfigurationLevelAdjustment(actor, "damage")
			: 0);
		const originalValue = numericValue === null ? value : numericValue - numericAdjustment;
		if (numericValue !== null && newIwrValue && !adjustmentData.found) {
			setUpdateValue(changes, path, Math.max(0, originalValue + numericAdjustment));
			(updatedAdjustments ??= foundry.utils.deepClone(adjustments))[systemPath] = numericAdjustment;
		}
		foundry.utils.setProperty(originalSystem, systemPath, originalValue);
	}
	foundry.utils.setProperty(
		changes,
		`${NPC_CONFIGURATION_PATH}.originalData.system`,
		originalSystem
	);
	if (updatedAdjustments) {
		foundry.utils.setProperty(
			changes,
			`${NPC_CONFIGURATION_PATH}.adjustmentData.system`,
			updatedAdjustments
		);
	}
});

Hooks.once("ready", () => {
	const npcActor = game.actors?.contents?.find(isNpcActor);
	if (npcActor) {
		applyNpcLevelDcAdjustment(npcActor);
		return;
	}
	Hooks.on("createActor", actor => {
		if (isNpcActor(actor)) applyNpcLevelDcAdjustment(actor);
	});
});

Hooks.on("preUpdateItem", (item, changes, options = {}) => {
	if (options.vursNpcConfigurationUpdate || !isNpcActor(item.parent)) return;
	const itemConfiguration = item.flags?.vurs?.npcConfiguration;
	const storedSystem = itemConfiguration?.originalData?.system;
	if (!storedSystem) return;
	const flatChanges = foundry.utils.flattenObject(changes);
	const systemChanges = Object.entries(flatChanges).filter(([path]) => path.startsWith("system."));
	if (!systemChanges.length) return;
	const originalSystem = foundry.utils.deepClone(storedSystem);
	const adjustments = itemConfiguration.adjustments
		?? foundry.utils.getProperty(item.parent, `${NPC_CONFIGURATION_PATH}.adjustmentData.items.${item.id}`)
		?? {};
	for (const [path, value] of systemChanges) {
		const systemPath = path.slice("system.".length);
		const adjustmentData = getAdjustmentData(adjustments, path);
		const adjustment = adjustmentData.value;
		if (path === "system.rules" && Array.isArray(value)) {
			const originalRules = foundry.utils.deepClone(value);
			const ruleAdjustments = {};
			for (const [adjustmentPath, ruleAdjustment] of Object.entries(adjustments)) {
				const rulePath = /^system\.rules\.(\d+)\.(.+)$/.exec(adjustmentPath);
				if (rulePath) {
					foundry.utils.setProperty(
						ruleAdjustments,
						`${rulePath[1]}.${rulePath[2]}`,
						ruleAdjustment
					);
				}
			}
			for (const [ruleIndex, fields] of Object.entries(ruleAdjustments)) {
				const rule = originalRules[Number(ruleIndex)];
				if (!rule) continue;
				if (fields.attackModifier) {
					rule.attackModifier = getOriginalItemValue(rule.attackModifier, fields.attackModifier);
				}
				if (!rule.damage?.base) continue;
				for (const field of ["dice", "modifier"]) {
					const adjustmentValue = fields.damage?.base?.[field];
					if (typeof adjustmentValue === "number") {
						rule.damage.base[field] = getOriginalItemValue(
							rule.damage?.base?.[field],
							adjustmentValue
						);
					}
				}
			}
			foundry.utils.setProperty(originalSystem, systemPath, originalRules);
			continue;
		} else if (adjustmentData.found &&
			typeof adjustment === "object" && adjustment !== null && typeof value === "string") {
			const originalValue = adjustment.inlineRolls
				? restoreInlineRollText(value, adjustment)
				: value;
			setUpdateValue(changes, path, adjustment.inlineRolls
				? transformInlineRollText(originalValue, adjustment)
				: adjustment.pf2eGenerated
					? applyNpcGeneratedDamageAdjustment(value, adjustment)
				: scaleDamageFormula(
					value,
					adjustment.bonusDice,
					adjustment.bonusDamage,
					adjustment.includeDice
				));
			foundry.utils.setProperty(originalSystem, systemPath, originalValue);
			continue;
		}
		const originalValue = getOriginalItemValue(value, adjustment);
		foundry.utils.setProperty(originalSystem, systemPath, originalValue);
	}
	foundry.utils.setProperty(
		changes,
		"flags.vurs.npcConfiguration.originalData.system",
		originalSystem
	);
});

Hooks.on("preCreateItem", (item, data, options = {}) => {
	const actor = item.parent;
	if (!isNpcActor(actor) || options.vursNpcConfigurationUpdate) return;
	const configuration = foundry.utils.getProperty(actor, NPC_CONFIGURATION_PATH);
	if (!configuration?.originalData?.system) return;
	const originalSystem = foundry.utils.deepClone(data.system ?? item._source.system);
	const relationshipStatistics = getRelationshipStatistics(configuration);
	const relationshipLevelAdjustment = configuration.relationshipStatistics
		? getRelationshipLevelAdjustment(getRelationshipRank(relationshipStatistics))
		: Number(configuration.affection) || 0;
	const baseLevel = Number(foundry.utils.getProperty(
		configuration,
		"originalData.system.details.level.value"
	));
	const addedLevels = getEffectiveNpcAddedLevels(configuration, baseLevel);
	const totalLevelBonus = addedLevels + relationshipLevelAdjustment;
	const effectiveLevel = baseLevel + totalLevelBonus;
	const adjustments = getItemAdjustmentData(
		{ type: data.type ?? item.type, system: originalSystem },
		effectiveLevel,
		totalLevelBonus,
		configuration.scaling,
		{
			actor
		}
	);
	foundry.utils.setProperty(data, "system", applyItemAdjustments(originalSystem, adjustments));
	foundry.utils.setProperty(data, "flags.vurs.npcConfiguration.originalData.system", originalSystem);
	foundry.utils.setProperty(data, "flags.vurs.npcConfiguration.adjustments", adjustments);
});
