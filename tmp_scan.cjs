const c = require("fs").readFileSync("F:/FoundryVTT/FoundryVTT User Data/Data/systems/pf2e/pf2e.mjs", "utf8");
let i = -1, n = 0;
while ((i = c.indexOf("linkedWeapon", i + 1)) >= 0 && n < 15) {
	console.log(c.slice(Math.max(0, i - 200), i + 250).replace(/\s+/g, " "));
	console.log("---");
	n++;
}
