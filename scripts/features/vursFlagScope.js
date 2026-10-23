const VURS_FLAG_SCOPE = "vurs";
const INSTALLED = Symbol.for("vurs-pf2e.flagScopeInstalled");

/**
 * Register the shared `flags.vurs` namespace as a Foundry document flag scope.
 * The package's own scope is `vurs-pf2e`, but actor-facing VURS flags are
 * intentionally stored under `vurs` so other modules and rule elements can
 * address them consistently.
 */
function registerVursFlagScope() {
  const database = globalThis.CONFIG?.DatabaseBackend;
  if (!database || database[INSTALLED] || typeof database.getFlagScopes !== "function") return;

  const original = database.getFlagScopes;
  database.getFlagScopes = function (...args) {
    const scopes = original.apply(this, args);
    return scopes.includes(VURS_FLAG_SCOPE) ? scopes : [...scopes, VURS_FLAG_SCOPE];
  };

  Object.defineProperty(database, INSTALLED, { value: true });
}

Hooks.once("init", registerVursFlagScope);
Hooks.once("setup", registerVursFlagScope);
Hooks.once("ready", registerVursFlagScope);
