import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeReadOutcome } from "../src/outcomes.js";
import { memoryRow, readOutcome } from "./helpers.mjs";

test("shared hosted fixture row preserves nullable provenance and envelope fields", async () => {
  const fixturePath = new URL("./vendor-agent-prefetch-response.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const payload = readOutcome("results", { rows: [fixture.rows[0]] });

  const normalized = normalizeReadOutcome(payload, "local");

  assert.ok(normalized);
  assert.deepEqual(normalized.rows[0], fixture.rows[0]);
  assert.equal(normalized.rows[0].evidence_basis, null);
  assert.equal(normalized.rows[0].record_kind, null);
});

test("local owner row preserves a null client id", () => {
  const payload = readOutcome("results", { rows: [memoryRow({ client_id: null })] });

  const normalized = normalizeReadOutcome(payload, "local");

  assert.ok(normalized);
  assert.equal(normalized.rows[0].client_id, null);
});
