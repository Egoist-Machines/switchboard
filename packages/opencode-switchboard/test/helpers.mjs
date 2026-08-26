import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function localFixture({ secret = "secret-value" } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-passport-test-"));
  const bin = path.join(dir, "switchboard-fixture");
  const source = await readFile(new URL("./fixtures/fake-switchboard-bin.mjs", import.meta.url), "utf8");
  await writeFile(bin, source, { mode: 0o755 });
  const discoveryPath = path.join(dir, "runtime.json");
  const credentialsPath = path.join(dir, "credentials.json");
  await writeFile(discoveryPath, `${JSON.stringify({ bin })}\n`);
  await writeFile(credentialsPath, `${JSON.stringify({ client_id: "opencode-client", client_secret: secret })}\n`, {
    mode: 0o600,
  });
  return { dir, bin, discoveryPath, credentialsPath, secret };
}

function chain() {
  const value = {
    optional: () => value,
    describe: () => value,
    min: () => value,
    max: () => value,
    int: () => value,
    regex: () => value,
  };
  return value;
}

export function fakeTool(input) {
  return input;
}

fakeTool.schema = {
  string: chain,
  number: chain,
  array: chain,
  enum: chain,
};

export function fakeStatus() {
  const outcomes = [];
  const handoffOutcomes = [];
  const handoffReasons = [];
  return {
    outcomes,
    handoffOutcomes,
    handoffReasons,
    handoffDeliveryFailures: 0,
    ambientSupported: true,
    async recordOutcome(outcome) {
      outcomes.push(outcome);
    },
    async recordUnavailable(transport) {
      outcomes.push({ status: "unavailable", transport });
    },
    async recordHandoffOutcome(outcome) {
      handoffOutcomes.push(outcome);
    },
    async recordHandoffReason(reason) {
      handoffReasons.push(reason);
    },
    async recordHandoffDeliveryFailure() {
      this.handoffDeliveryFailures += 1;
    },
    async setAmbientSupported(supported) {
      this.ambientSupported = supported;
    },
  };
}

export function memoryRow(overrides = {}) {
  return {
    memory_id: "memory-1",
    content: "Prefers dark roast coffee",
    source: "opencode",
    created_at: "2026-08-24T12:00:00.000Z",
    occurred_at: null,
    category: "preference",
    client_id: "opencode-client",
    evidence_basis: "direct_user_save",
    record_kind: "memory",
    verified_issuer: null,
    verified_at: null,
    ...overrides,
  };
}

export function readOutcome(status, overrides = {}) {
  return {
    status,
    transport: "local",
    connectivity: status === "unavailable" ? "offline" : "online",
    freshness: status === "unavailable" ? "stale" : "fresh",
    as_of: status === "unavailable" ? null : "2026-08-24T12:00:00.000Z",
    rows: status === "results" ? [memoryRow()] : [],
    skipped_categories: [],
    ...overrides,
  };
}
