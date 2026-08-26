import os from "node:os";
import path from "node:path";

export const GOVERNED_CATEGORIES = Object.freeze([
  "preference",
  "fact",
  "project",
  "relationship",
  "instruction",
  "event",
  "purchase",
  "claim",
  "other",
]);

export const WRITABLE_CATEGORIES = Object.freeze(GOVERNED_CATEGORIES.filter((category) => category !== "claim"));
export const CODING_PROFILE_DEFAULT_CATEGORIES = Object.freeze(["preference", "fact", "project", "instruction"]);

export const DEFAULTS = Object.freeze({
  categories: CODING_PROFILE_DEFAULT_CATEGORIES,
  ambient: Object.freeze({
    enabled: false,
    maxRows: 6,
    maxChars: 2000,
    timeoutMs: 1500,
  }),
  handoff: Object.freeze({ enabled: false }),
  hostedFallback: Object.freeze({ enabled: false }),
});

const boolean = (value, fallback) => (typeof value === "boolean" ? value : fallback);

const bounded = (value, { min, max, fallback }) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

export function resolveConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ambient = source.ambient && typeof source.ambient === "object" && !Array.isArray(source.ambient) ? source.ambient : {};
  const handoff =
    source.handoff && typeof source.handoff === "object" && !Array.isArray(source.handoff) ? source.handoff : {};
  const hostedFallback =
    source.hostedFallback && typeof source.hostedFallback === "object" && !Array.isArray(source.hostedFallback)
      ? source.hostedFallback
      : {};
  const declared = Array.isArray(source.categories) ? source.categories : [];
  const categories = [...new Set(declared.filter((category) => GOVERNED_CATEGORIES.includes(category)))];

  return {
    categories: categories.length ? categories : [...DEFAULTS.categories],
    ambient: {
      enabled: boolean(ambient.enabled, DEFAULTS.ambient.enabled),
      maxRows: bounded(ambient.maxRows, { min: 1, max: 50, fallback: DEFAULTS.ambient.maxRows }),
      maxChars: bounded(ambient.maxChars, { min: 400, max: 20_000, fallback: DEFAULTS.ambient.maxChars }),
      timeoutMs: bounded(ambient.timeoutMs, { min: 200, max: 10_000, fallback: DEFAULTS.ambient.timeoutMs }),
    },
    handoff: {
      enabled: boolean(handoff.enabled, DEFAULTS.handoff.enabled),
    },
    hostedFallback: {
      enabled: boolean(hostedFallback.enabled, DEFAULTS.hostedFallback.enabled),
    },
  };
}

export function opencodeStateDir(env = process.env, home = os.homedir()) {
  const explicit = typeof env.OPENCODE_STATE_DIR === "string" ? env.OPENCODE_STATE_DIR.trim() : "";
  if (explicit) return explicit;
  const dataHome = typeof env.XDG_DATA_HOME === "string" ? env.XDG_DATA_HOME.trim() : "";
  return path.join(dataHome || path.join(home, ".local", "share"), "opencode");
}

export function passportPaths({ env = process.env, home = os.homedir() } = {}) {
  const stateDir = opencodeStateDir(env, home);
  return {
    discoveryPath: path.join(home, ".switchboard", "runtime.json"),
    credentialsPath: path.join(stateDir, "switchboard-credentials.json"),
    hostedCredentialsPath: path.join(stateDir, "ai-passport-credentials-hosted.json"),
    statusPath: path.join(stateDir, "ai-passport-status.json"),
  };
}
