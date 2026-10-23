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

function readActorFlag(actor, path) {
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
    if (flag === 1 || (typeof flag === "string" && flag.trim() === "1")) return true;
  }
  return false;
}

export function actorHasVursSystemFlag(actor) {
  return readActorFlag(actor, "vursSystem");
}

export function actorHasAgnosticSystemFlag(actor) {
  return readActorFlag(actor, "agnosticSystem");
}

export function actorUsesAgnosticVurs(actor) {
  // A world-wide Full VURS selection takes precedence. Otherwise the actor
  // flag opts that actor into the Agnostic profile when the world is Default.
  return !isFullVursMode() && (isAgnosticVursMode() || actorHasAgnosticSystemFlag(actor));
}

export function actorHasDicelessFlag(actor) {
  return readActorFlag(actor, "diceless");
}

export function actorUsesVursSystem(actor) {
  return Boolean(getModeProfile()) || actorHasVursSystemFlag(actor) || actorHasAgnosticSystemFlag(actor);
}

export function actorUsesMainAttribute(actor) {
  // The actor-level VURS opt-in enables Main in Default mode, while the
  // Agnostic VURS world mode intentionally leaves this full-VURS feature off.
  if (isFullVursMode()) return true;
  if (actorUsesAgnosticVurs(actor)) return false;
  return actorHasVursSystemFlag(actor);
}

export function actorUsesVursHpRules(actor) {
  const mode = getSystemMode();
  if (getModeProfile(mode)?.systemWideNegativeHp) return true;
  if (mode === "default") {
    return game.settings.get(MODULE_ID, "negativeHpInDefault") === true ||
      actorHasVursSystemFlag(actor) || actorHasAgnosticSystemFlag(actor);
  }
  return actorHasVursSystemFlag(actor) || actorHasAgnosticSystemFlag(actor);
}

export function actorUsesDicelessRolls(actor) {
  return Boolean(getModeProfile()?.systemWideDiceless) || actorHasDicelessFlag(actor) || actorHasVursSystemFlag(actor);
}
