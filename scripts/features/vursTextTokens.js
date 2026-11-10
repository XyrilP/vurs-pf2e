import { appendVursPlayCostIcons, createVursPlayCostElement } from "./playCostIcons.js";

const MODULE_ID = "vurs-pf2e";

export function normalizeVursPlayCost(value) {
	if (typeof value !== "string" && typeof value !== "number") return "";
	return String(value)
		.split(";")
		.map(entry => entry.trim())
		.filter(Boolean)
		.join("; ");
}

export function replaceVursPlayCostTokensOnActorSheet(root, actor) {
	// Runs on every sheet refresh pass; once tokens are replaced the literal
	// text is gone, so skip the item scan entirely when nothing remains.
	if (!root?.textContent?.includes("VURS.PlayCost")) return;
	for (const itemElement of root.querySelectorAll("[data-item-id]")) {
		const item = actor?.items?.get(itemElement.dataset.itemId);
		const playCost = normalizeVursPlayCost(foundry.utils.getProperty(item, "flags.vurs.playCost"));
		if (!playCost) continue;
		replaceVursPlayCostToken(itemElement, playCost);
	}
}

export function replaceVursPlayCostToken(description, playCost) {
	if (!description?.textContent?.includes("VURS.PlayCost")) return;
	const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	for (const node of nodes) {
		if (!node.nodeValue.includes("VURS.PlayCost")) continue;
		const tokens = [...node.nodeValue.matchAll(/VURS\.PlayCost(Top|Bottom)?/g)];
		const fragment = document.createDocumentFragment();
		let offset = 0;
		for (const token of tokens) {
			fragment.append(document.createTextNode(node.nodeValue.slice(offset, token.index)));
			fragment.append(createVursPlayCostElement(playCost, token[1]?.toLowerCase() ?? "inline"));
			offset = token.index + token[0].length;
		}
		fragment.append(document.createTextNode(node.nodeValue.slice(offset)));
		node.replaceWith(fragment);
	}
}

export function replaceVursPlayResourceTokens(description, actor) {
	// Runs on every sheet/HUD refresh; skip the TreeWalker when neither token
	// type nor the "or more" rewrite can match anything in the subtree.
	const content = description?.textContent;
	if (!content || (!content.includes("VURS.PlayResource") && !/\bor more\b/i.test(content))) return;
	const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	const aliases = { One: 1, Two: 2, Three: 3, Longer: 4 };
	const resources = {
		AP: "AP", SP: "SP", TP: "TP", BP: "BP", MP: "MP", KP: "KP", SR: "SR",
		actionPoints: "AP", staminaPoints: "SP", tacticPoints: "TP", budgetPoints: "BP",
		magicPoints: "MP", karmaPoints: "KP", styleRank: "SR", reactions: "REACTION", free: "FREE"
	};
	for (const node of nodes) {
		const resolvedText = node.nodeValue
			.replace(/VURS\.PlayResource\.\[\[(.+?)\]\](AP|SP|TP|BP|MP|KP|SR)/gi,
				(match, formula, resource) => `VURS.PlayResource.${resolveVursPlayCostRolls(`[[${formula}]]`, actor)}${resource}`)
			.replace(/\b(\d+)\s+or more\s+(AP|SP|TP|BP|MP|KP|SR|RP|actions?|reactions?)\b/gi, "$1+ $2");
		if (resolvedText !== node.nodeValue) node.nodeValue = resolvedText;
		const matches = [...node.nodeValue.matchAll(/VURS\.PlayResource\.((?:(\d+)|(One|Two|Three|Longer))?(AP|SP|TP|BP|MP|KP|SR|actionPoints|staminaPoints|tacticPoints|budgetPoints|magicPoints|karmaPoints|styleRank|reactions|reaction|free))/gi)];
		if (!matches.length) continue;
		const fragment = document.createDocumentFragment();
		let offset = 0;
		for (const match of matches) {
			fragment.append(document.createTextNode(node.nodeValue.slice(offset, match.index)));
			const amount = match[2] ? Number(match[2]) : (aliases[match[3]] ?? 1);
			const resourceKey = Object.keys(resources).find(key => key.toLowerCase() === match[4].toLowerCase());
			const resource = resources[resourceKey];
			const rendered = document.createElement("span");
			rendered.className = "vurs-play-resource-token";
			if (amount === 0 && resource === "AP") {
				rendered.title = "Free Action";
				const icon = document.createElement("img");
				icon.src = "modules/vurs-pf2e/assets/custom-icons/resource-icons/FreeAction.svg";
				icon.alt = "Free Action";
				icon.draggable = false;
				rendered.append(icon);
				fragment.append(rendered);
				offset = match.index + match[0].length;
				continue;
			}
			rendered.title = `${amount === 4 ? "4+" : amount} ${resource}`;
			appendVursPlayCostIcons(rendered, `${amount} ${resource}`);
			fragment.append(rendered);
			offset = match.index + match[0].length;
		}
		fragment.append(document.createTextNode(node.nodeValue.slice(offset)));
		node.replaceWith(fragment);
	}
}

// Replaces every VURS text token inside an arbitrary container (pf2e-hud item
// summaries, NPC notes popups, etc.). `item` supplies VURS.PlayCost; `actor`
// resolves [[ ]] formulas inside VURS.PlayResource tokens.
export function replaceVursTextTokens(container, actor, item = null) {
	if (!container) return;
	const playCost = item
		? resolveVursPlayCostRolls(
			normalizeVursPlayCost(foundry.utils.getProperty(item, "flags.vurs.playCost")),
			actor
		)
		: "";
	if (playCost) replaceVursPlayCostToken(container, playCost);
	replaceVursPlayResourceTokens(container, actor);
}

export function resolveVursPlayCostRolls(playCost, actor) {
	const RollClass = globalThis.Roll ?? foundry?.dice?.Roll;
	if (!playCost.includes("[[") || !RollClass) return playCost;
	const rollData = actor?.getRollData?.() ?? {};
	if (actor && !rollData.actor) rollData.actor = actor.getRollData?.() ?? actor;
	return playCost.replace(/\[\[\s*([^\]]+)\s*\]\]/g, (match, formula) => {
		try {
			const roll = RollClass.create(formula, rollData);
			roll.evaluate({ async: false });
			return String(Number.isFinite(roll.total) ? roll.total : 0);
		} catch (error) {
			console.warn(`${MODULE_ID} | Failed to evaluate Play Cost inline roll`, formula, error);
			return match;
		}
	});
}
