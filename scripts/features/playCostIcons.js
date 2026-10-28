const RESOURCE_ICON_BASE = "modules/vurs-pf2e/assets/custom-icons/resource-icons/";

export function appendVursPlayCostIcons(container, playCost) {
    if (!container.title) container.title = playCost;
    const entries = playCost.split(/\s*(;|,|\+|\band\b|\bor\b|\bcombined\b)\s*/i).filter(Boolean);
    let lastAmount = 1;
    let lastOperator = null;
    for (const entry of entries) {
        const operator = /^(;|,|\+|and|or|combined)$/i.test(entry) ? entry.toLowerCase() : null;
        if (operator) {
            lastOperator = operator;
            const separator = document.createElement("span");
            separator.className = "vurs-play-cost-inline-separator";
            separator.textContent = operator === "+" ? "+" : operator === "or" || operator === "," ? "/" : operator === "and" ? " + " : operator === "combined" ? " combined " : "; ";
            container.append(separator);
            continue;
        }
        const match = entry.match(/^(\d+)?\s*(AP|SP|TP|BP|MP|RP|REACTIONS?|FREE)$/i);
        if (!match) {
            container.append(document.createTextNode(entry));
            continue;
        }
        const amount = Math.max(1, Number(match[1] ?? (lastOperator === "or" ? lastAmount : 1)));
        const resource = /^(RP|REACTIONS?)$/i.test(match[2]) ? "REACTION" : /^(FREE)$/i.test(match[2]) ? "FREE" : match[2].toUpperCase();
        if (resource === "BP") {
            const stacks = document.createElement("span");
            stacks.className = `vurs-play-cost-resource-stacks vurs-play-cost-${resource.toLowerCase()}-stacks`;
            const iconTypes = resource === "MP"
                ? [...Array(Math.floor(amount / 5)).fill("mp-diamond-star-5"), ...Array(amount % 5).fill("mp-diamond-arm")]
                : Array(amount).fill("coin");
            const iconCount = iconTypes.length;
            const stackSize = resource === "BP" ? 5 : 2;
            for (let offset = 0; offset < iconCount; offset += stackSize) {
                const stack = document.createElement("span");
                stack.className = "vurs-play-cost-resource-stack";
                for (let index = 0; index < Math.min(stackSize, iconCount - offset); index += 1) {
                    const iconType = iconTypes[offset + index];
                    const icon = iconType.startsWith("mp-diamond-") ? document.createElement("img") : document.createElement("i");
                    if (icon instanceof HTMLImageElement) {
                        icon.src = `${RESOURCE_ICON_BASE}${iconType === "mp-diamond-star-5" ? "MP-Diamond-Star-5" : "MP-Diamond-Arm"}.svg`;
                        icon.alt = `${amount} MP`;
                    } else icon.className = `fa-solid fa-${iconType}`;
                    icon.style.setProperty("--stack-index", String(index));
                    icon.setAttribute("aria-hidden", "true");
                    stack.append(icon);
                }
                stacks.append(stack);
            }
            container.append(stacks);
            lastAmount = amount;
            continue;
        }
        if (resource === "MP") {
            container.classList.add("vurs-play-cost-mp-stars");
            for (let index = 0; index < amount; index += 1) {
                const icon = document.createElement("i");
                icon.className = "fa-solid fa-star vurs-play-cost-mp-star";
                icon.setAttribute("aria-hidden", "true");
                container.append(icon);
            }
            lastAmount = amount;
            continue;
        }
        if (resource === "REACTION") {
            for (let index = 0; index < amount; index += 1) {
                const icon = document.createElement("img");
                icon.src = `${RESOURCE_ICON_BASE}Reaction.svg`;
                icon.alt = "Reaction";
                icon.draggable = false;
                container.append(icon);
            }
            lastAmount = amount;
            continue;
        }
        if (resource === "FREE") {
            const icon = document.createElement("img");
            icon.src = `${RESOURCE_ICON_BASE}FreeAction.svg`;
            icon.alt = "Free Action";
            icon.draggable = false;
            container.append(icon);
            lastAmount = amount;
            continue;
        }
        const iconName = amount === 1 ? `One${resource}`
            : amount === 2 ? `Two${resource}`
                : amount === 3 ? `Three${resource}` : `Longer${resource}`;
        const icon = document.createElement("img");
        icon.src = `${RESOURCE_ICON_BASE}${iconName}.svg`;
        icon.alt = entry;
        icon.draggable = false;
        container.append(icon);
        lastAmount = amount;
    }
}