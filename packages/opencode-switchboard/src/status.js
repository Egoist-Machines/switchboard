import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GOVERNED_CATEGORIES } from "./config.js";
import { PROPOSAL_STATUSES, READ_STATUSES } from "./outcomes.js";

const EMPTY_COUNTS = Object.freeze({ rows: 0, skippedCategories: 0 });
const EMPTY_HANDOFF_COUNTS = Object.freeze({ claimed: 0, none: 0, disabled: 0, deliveryFailed: 0 });
const HANDOFF_REASONS = new Set(["missing_session_id", "delivery_failed"]);

async function writeStatusFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function readStatusFile(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function createStatusTracker({
  filePath,
  config,
  ambientSupported = true,
  transportKind = "local",
  handoffEnabled = config.handoff.enabled && transportKind === "local",
  writeStatus = writeStatusFile,
}) {
  const activeMode = ["local", "hosted", "unavailable"].includes(transportKind) ? transportKind : "unavailable";
  let state = {
    ambient: { enabled: config.ambient.enabled, supported: ambientSupported },
    handoff: {
      enabled: handoffEnabled,
      lastReason: null,
      counts: { ...EMPTY_HANDOFF_COUNTS, disabled: handoffEnabled ? 0 : 1 },
    },
    categoriesRequested: [...config.categories],
    lastOutcomeClass: null,
    transportKind: activeMode,
    counts: { ...EMPTY_COUNTS },
  };
  let pending = Promise.resolve();

  const persist = () => {
    pending = pending.then(() => writeStatus(filePath, state)).catch(() => {});
    return pending;
  };
  persist();

  return {
    recordOutcome(outcome) {
      if (!outcome || typeof outcome.status !== "string") return;
      state = {
        ...state,
        lastOutcomeClass: outcome.status,
        counts: {
          rows: Array.isArray(outcome.rows) ? outcome.rows.length : 0,
          skippedCategories: Array.isArray(outcome.skipped_categories) ? outcome.skipped_categories.length : 0,
        },
      };
      return persist();
    },
    recordUnavailable() {
      state = {
        ...state,
        lastOutcomeClass: "unavailable",
        counts: { ...EMPTY_COUNTS },
      };
      return persist();
    },
    recordHandoffOutcome(outcome) {
      if (outcome !== "claimed" && outcome !== "none") return;
      state = {
        ...state,
        handoff: {
          ...state.handoff,
          counts: { ...state.handoff.counts, [outcome]: state.handoff.counts[outcome] + 1 },
        },
      };
      return persist();
    },
    recordHandoffReason(reason) {
      if (!HANDOFF_REASONS.has(reason)) return;
      state = { ...state, handoff: { ...state.handoff, lastReason: reason } };
      return persist();
    },
    recordHandoffDeliveryFailure() {
      state = {
        ...state,
        handoff: {
          ...state.handoff,
          lastReason: "delivery_failed",
          counts: { ...state.handoff.counts, deliveryFailed: state.handoff.counts.deliveryFailed + 1 },
        },
      };
      return persist();
    },
    setAmbientSupported(supported) {
      state = { ...state, ambient: { ...state.ambient, supported: Boolean(supported) } };
      return persist();
    },
    snapshot() {
      return structuredClone(state);
    },
    settled() {
      return pending;
    },
  };
}

export function buildStatusReport({ config, transportStatus, persisted }) {
  const knownOutcomes = new Set([...READ_STATUSES, ...PROPOSAL_STATUSES]);
  const persistedOutcome = knownOutcomes.has(persisted?.lastOutcomeClass) ? persisted.lastOutcomeClass : null;
  const transportOutcome = knownOutcomes.has(transportStatus?.lastOutcome) ? transportStatus.lastOutcome : null;
  const activeMode = ["local", "hosted", "unavailable"].includes(persisted?.transportKind)
    ? persisted.transportKind
    : "unavailable";
  const wouldSelectOnRestart = transportStatus?.discoveryFound
    ? "local"
    : config.hostedFallback.enabled
      ? "hosted"
      : "unavailable";
  const handoffEnabled = persisted?.handoff?.enabled ?? (config.handoff.enabled && activeMode === "local");
  const handoffCount = (name, fallback = 0) => {
    const value = persisted?.handoff?.counts?.[name];
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    transportKind: activeMode,
    wouldSelectOnRestart,
    discoveryRecord: transportStatus?.discoveryFound ? "found" : "missing",
    paired: Boolean(transportStatus?.paired),
    ambient: {
      enabled: persisted?.ambient?.enabled ?? config.ambient.enabled,
      supported: persisted?.ambient?.supported ?? true,
    },
    handoff: {
      enabled: handoffEnabled,
      lastReason: HANDOFF_REASONS.has(persisted?.handoff?.lastReason) ? persisted.handoff.lastReason : null,
      counts: {
        claimed: handoffCount("claimed"),
        none: handoffCount("none"),
        disabled: handoffCount("disabled", handoffEnabled ? 0 : 1),
        deliveryFailed: handoffCount("deliveryFailed"),
      },
    },
    categoriesRequested: Array.isArray(persisted?.categoriesRequested)
      ? persisted.categoriesRequested.filter((category) => GOVERNED_CATEGORIES.includes(category))
      : [...config.categories],
    lastOutcomeClass: persistedOutcome ?? transportOutcome,
    counts: {
      rows: Number.isInteger(persisted?.counts?.rows) && persisted.counts.rows >= 0 ? persisted.counts.rows : 0,
      skippedCategories: Number.isInteger(persisted?.counts?.skippedCategories) && persisted.counts.skippedCategories >= 0
        ? persisted.counts.skippedCategories
        : 0,
    },
  };
}

export function formatStatusReport(report) {
  return [
    `active transport: ${report.transportKind}`,
    `would select on restart: ${report.wouldSelectOnRestart}`,
    `discovery record: ${report.discoveryRecord}`,
    `paired: ${report.paired ? "yes" : "no"}`,
    `ambient: ${report.ambient.enabled ? "on" : "off"}, ${report.ambient.supported ? "supported" : "unsupported"}`,
    `hand-offs: ${report.handoff.enabled ? "on" : "off"}; claimed=${report.handoff.counts.claimed}, ` +
      `none=${report.handoff.counts.none}, disabled=${report.handoff.counts.disabled}, ` +
      `delivery_failed=${report.handoff.counts.deliveryFailed}, reason=${report.handoff.lastReason ?? "none"}`,
    `categories requested: ${report.categoriesRequested.join(", ")}`,
    `last outcome: ${report.lastOutcomeClass ?? "none"}`,
    `counts: rows=${report.counts.rows}, skipped_categories=${report.counts.skippedCategories}`,
  ].join("\n");
}
