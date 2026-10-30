import { AGNOSTIC_VURS_MODE } from "./modes/agnosticVurs.js";
import { FULL_VURS_MODE } from "./modes/fullVurs.js";

const MODULE_ID = "vurs-pf2e";
const SETTING_KEY = "systemMode";
const MODE_PROFILES = [FULL_VURS_MODE, AGNOSTIC_VURS_MODE];

function getModeProfile(mode = getSystemMode()) {
  const normalized = String(mode).trim().toLowerCase();
  if (normalized === "agnostic-vurs") return AGNOSTIC_VURS_MODE;
  return MODE_PROFILES.find(profile => profile.id === normalized) ?? null;
}

export function getSystemMode() {
  return game.settings.get(MODULE_ID, SETTING_KEY) ?? "default";
}

export function isFullVursMode(mode = getSystemMode()) {
  return String(mode).trim().toLowerCase() === FULL_VURS_MODE.id;
}

export function isAgnosticVursMode(mode = getSystemMode()) {
  const normalized = String(mode).trim().toLowerCase();
  return normalized === AGNOSTIC_VURS_MODE.id || normalized === "agnostic-vurs";
}

export function isAnyVursMode(mode = getSystemMode()) {
  return getModeProfile(mode) !== null;
}

function resolveActor(actor) {
  if (actor?.actor?.documentName === "Actor") actor = actor.actor;
  if (typeof actor !== "string") return actor;
  const reference = actor;
  try { actor = fromUuidSync(reference); } catch { actor = null; }
  return actor ?? game.actors?.get(reference) ?? null;
}

function readActorFlagValue(actor, path) {
  actor = resolveActor(actor);
  let serializedActor;
  try { serializedActor = actor?.toObject?.(); } catch { serializedActor = null; }
  const sources = new Set([
    actor,
    actor?._source,
    actor?.document,
    actor?.document?._source,
    actor?.flags,
    actor?.document?.flags,
    serializedActor,
    serializedActor?.document
  ].filter(Boolean));
  for (const source of sources) {
    // Read the established VURS namespace first. The package namespace is a
    // read-only fallback for actors saved by earlier module builds.
    const currentFlag = foundry.utils.getProperty(source, `flags.vurs.${path}`) ??
      foundry.utils.getProperty(source, `vurs.${path}`);
    const flag = currentFlag !== undefined
      ? currentFlag
      : foundry.utils.getProperty(source, `flags.${MODULE_ID}.${path}`);
    if (flag === 1 || flag === "1" || flag === true) return 1;
    if (flag === 0 || flag === "0" || flag === false) return 0;
  }
  return null;
}

export function actorHasVursSystemFlag(actor) {
  return readActorFlagValue(actor, "vursSystem") === 1;
}

export function actorHasAgnosticSystemFlag(actor) {
  return readActorFlagValue(actor, "agnosticSystem") === 1;
}

export function getActorSystemMode(actor) {
  const defaultFlag = readActorFlagValue(actor, "defaultSystem");
  const fullFlag = readActorFlagValue(actor, "vursSystem");
  const agnosticFlag = readActorFlagValue(actor, "agnosticSystem");

  // This explicit actor override always selects ordinary PF2e behavior.
  if (defaultFlag === 1) return "default";

  // Explicitly clearing both flags opts an actor into ordinary PF2e behavior,
  // even when the world has selected a VURS profile.
  if (fullFlag === 0 && agnosticFlag === 0) return "default";

  if (isFullVursMode()) {
    return agnosticFlag === 1 ? AGNOSTIC_VURS_MODE.id : FULL_VURS_MODE.id;
  }
  if (isAgnosticVursMode()) {
    return fullFlag === 1 ? FULL_VURS_MODE.id : AGNOSTIC_VURS_MODE.id;
  }
  if (fullFlag === 1) return FULL_VURS_MODE.id;
  if (agnosticFlag === 1) return AGNOSTIC_VURS_MODE.id;
  return "default";
}

export function actorUsesAgnosticVurs(actor) {
  return getActorSystemMode(actor) === AGNOSTIC_VURS_MODE.id;
}

export function actorHasDicelessFlag(actor) {
  return readActorFlagValue(actor, "diceless") === 1;
}

export function actorUsesVursSystem(actor) {
  return getModeProfile(getActorSystemMode(actor)) !== null;
}

export function actorUsesVursHpRules(actor) {
  const mode = getActorSystemMode(actor);
  if (getModeProfile(mode)?.systemWideNegativeHp) return true;
  return game.settings.get(MODULE_ID, "negativeHpInDefault") === true;
}

export function actorUsesDicelessRolls(actor) {
  const mode = getActorSystemMode(actor);
  if (getModeProfile(mode)?.systemWideDiceless) return true;
  if (actorHasDicelessFlag(actor)) return true;

  if (mode !== "default" && mode !== AGNOSTIC_VURS_MODE.id) return false;
  if (mode === "default") {
    return game.settings.get(MODULE_ID, "dicelessInDefault") === true;
  }
  return game.settings.get(MODULE_ID, "dicelessInAgnostic") === true;
}
