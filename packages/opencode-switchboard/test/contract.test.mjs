import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeHostedPrefetch } from "../src/hostedTransport.js";

test("the shared agent prefetch contract loads through the hosted normalizer", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./vendor-agent-prefetch-response.json", import.meta.url), "utf8")
  );
  const outcome = normalizeHostedPrefetch(fixture, {
    categories: ["preference", "project", "fact", "instruction"],
    asOf: "2026-08-25T12:00:00.000Z",
  });

  assert.ok(outcome);
  assert.equal(outcome.status, "results");
  assert.deepEqual(outcome.rows, fixture.rows);
  assert.equal(outcome.rows[0].evidence_basis, null);
  assert.equal(outcome.rows[0].record_kind, null);
  assert.deepEqual(outcome.skipped_categories, fixture.skipped_categories);
});
