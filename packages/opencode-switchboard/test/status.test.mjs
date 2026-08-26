import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { createAmbientHook } from "../src/context.js";
import { buildStatusReport, createStatusTracker, formatStatusReport, readStatusFile } from "../src/status.js";
import { memoryRow, readOutcome } from "./helpers.mjs";

test("status output is content-free and never contains a secret", () => {
  const secret = "status-must-not-print-this";
  const handoffSnapshot = "private handoff snapshot";
  const report = buildStatusReport({
    config: resolveConfig(),
    transportStatus: {
      transport: "local",
      discoveryFound: true,
      paired: true,
      lastOutcome: "results",
      lastReason: secret,
    },
    persisted: {
      transportKind: "local",
      ambient: { enabled: false, supported: true },
      handoff: {
        enabled: true,
        lastReason: "delivery_failed",
        counts: { claimed: 2, none: 1, disabled: 0, deliveryFailed: 1 },
        snapshot: handoffSnapshot,
      },
      categoriesRequested: ["preference", "fact", secret],
      lastOutcomeClass: secret,
      counts: { rows: 2, skippedCategories: 1 },
      secret,
      content: "private memory text",
    },
  });
  const text = formatStatusReport(report);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, /private memory text/);
  assert.doesNotMatch(text, new RegExp(handoffSnapshot));
  assert.match(text, /rows=2/);
  assert.match(text, /hand-offs: on; claimed=2, none=1, disabled=0, delivery_failed=1, reason=delivery_failed/);
  assert.match(text, /last outcome: results/);
  assert.deepEqual(report.categoriesRequested, ["preference", "fact"]);
  assert.deepEqual(report.handoff.counts, { claimed: 2, none: 1, disabled: 0, deliveryFailed: 1 });
});

test("an awaited status mutation is durable and stores only classes, categories, and counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-passport-status-"));
  const filePath = path.join(dir, "status.json");
  const tracker = createStatusTracker({
    filePath,
    config: resolveConfig(),
    ambientSupported: true,
    transportKind: "hosted",
  });
  await tracker.recordOutcome(
    readOutcome("results", { rows: [memoryRow({ content: "never persist this memory" })] })
  );
  await tracker.setAmbientSupported(false);
  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /never persist this memory/);
  const persisted = await readStatusFile(filePath);
  assert.equal(persisted.lastOutcomeClass, "results");
  assert.equal(persisted.transportKind, "hosted");
  assert.deepEqual(persisted.counts, { rows: 1, skippedCategories: 0 });
  assert.equal(persisted.ambient.supported, false);
  assert.deepEqual(persisted.handoff, {
    enabled: false,
    lastReason: null,
    counts: { claimed: 0, none: 0, disabled: 1, deliveryFailed: 0 },
  });
});

test("handoff status persists outcome counts without accepting snapshot content", async () => {
  const writes = [];
  const tracker = createStatusTracker({
    filePath: "/unused/status.json",
    config: resolveConfig({ handoff: { enabled: true } }),
    transportKind: "local",
    writeStatus: async (_path, value) => writes.push(structuredClone(value)),
  });
  await tracker.recordHandoffOutcome("claimed");
  await tracker.recordHandoffOutcome("none");
  await tracker.recordHandoffReason("missing_session_id");
  await tracker.recordHandoffDeliveryFailure();
  await tracker.settled();
  const raw = JSON.stringify(writes.at(-1));
  assert.deepEqual(tracker.snapshot().handoff, {
    enabled: true,
    lastReason: "delivery_failed",
    counts: { claimed: 1, none: 1, disabled: 0, deliveryFailed: 1 },
  });
  assert.doesNotMatch(raw, /snapshot|handoff content/);
});

test("ambient hook does not wait for delayed status persistence", async () => {
  let releaseWrite;
  const writeStarted = Promise.withResolvers();
  const writeReleased = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const tracker = createStatusTracker({
    filePath: "/unused/status.json",
    config: resolveConfig({ ambient: { enabled: true } }),
    writeStatus: async () => {
      writeStarted.resolve();
      await writeReleased;
    },
  });
  await writeStarted.promise;

  const hook = createAmbientHook({
    config: resolveConfig({ ambient: { enabled: true } }),
    read: async () => readOutcome("empty"),
    status: tracker,
  });
  const hookFinished = Promise.withResolvers();
  hook({}, { system: [] }).then(() => hookFinished.resolve());

  const resolvedBeforeWrite = await Promise.race([
    hookFinished.promise.then(() => true),
    new Promise((resolve) => setImmediate(resolve, false)),
  ]);
  assert.equal(resolvedBeforeWrite, true);
  assert.equal(tracker.snapshot().lastOutcomeClass, "empty");
  releaseWrite();
  await tracker.settled();
});

test("status keeps hosted active when local discovery appears after startup", () => {
  const report = buildStatusReport({
    config: resolveConfig({ hostedFallback: { enabled: true } }),
    transportStatus: { discoveryFound: true, paired: true },
    persisted: { transportKind: "hosted" },
  });
  assert.equal(report.transportKind, "hosted");
  assert.equal(report.wouldSelectOnRestart, "local");
  assert.match(formatStatusReport(report), /active transport: hosted/);
  assert.match(formatStatusReport(report), /would select on restart: local/);
});

test("status keeps local active when discovery vanishes during the run", () => {
  const report = buildStatusReport({
    config: resolveConfig({ hostedFallback: { enabled: true } }),
    transportStatus: { discoveryFound: false, paired: true },
    persisted: { transportKind: "local" },
  });
  assert.equal(report.transportKind, "local");
  assert.equal(report.wouldSelectOnRestart, "hosted");
  assert.match(formatStatusReport(report), /active transport: local/);
  assert.match(formatStatusReport(report), /would select on restart: hosted/);
});
