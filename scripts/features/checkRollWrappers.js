const MODULE_ID = "vurs-pf2e";
const CHECK_ROLL_WRAPPER = Symbol.for(`${MODULE_ID}.checkRollWrapper`);
const wrappers = new Map();

function installCheckRollWrapper({ quiet = false } = {}) {
	const system = game[game.system.id] ?? game.pf2e;
	const checkApi = system?.Check;
	if (!checkApi || typeof checkApi.roll !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not install PF2E Check.roll wrappers: the system Check API is unavailable`);
		return false;
	}
	if (checkApi[CHECK_ROLL_WRAPPER]) return true;

	if (typeof globalThis.libWrapper?.register !== "function") {
		if (!quiet) console.error(`${MODULE_ID} | Could not install PF2E Check.roll wrappers: libWrapper is unavailable`);
		return false;
	}

	const dispatcher = function (wrapped, ...args) {
		const entries = [...wrappers.values()];
		const invoke = (index, currentArgs) => {
			const handler = entries[index];
			if (!handler) return wrapped(...currentArgs);
			return handler((...nextArgs) => invoke(index + 1, nextArgs), ...currentArgs);
		};
		return invoke(0, args);
	};

	try {
		globalThis.libWrapper.register(
			MODULE_ID,
			`game.${game.system.id}.Check.roll`,
			dispatcher,
			"WRAPPER"
		);
		Object.defineProperty(checkApi, CHECK_ROLL_WRAPPER, { value: true });
		return true;
	} catch (error) {
		console.error(`${MODULE_ID} | Failed to install PF2E Check.roll wrappers`, error);
		return false;
	}
}

export function registerCheckRollWrapper(key, wrapper, { quiet = false } = {}) {
	if (!key || typeof wrapper !== "function") {
		console.error(`${MODULE_ID} | Could not register a PF2E Check.roll wrapper: a key and function are required`);
		return false;
	}

	wrappers.set(key, wrapper);
	return installCheckRollWrapper({ quiet });
}
