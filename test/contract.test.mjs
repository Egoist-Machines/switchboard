import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_SYNC_CAPABILITIES as SHARED_SYNC_CAPABILITIES,
  MEMORY_CATEGORIES as SHARED_MEMORY_CATEGORIES,
} from "./vendor-shared-contracts.js";
import { MEMORY_CATEGORIES, SYNC_CAPABILITIES } from "../src/constants.js";
import { LocalRepository } from "../src/repository.js";
import { temporaryHome } from "./helpers.mjs";

test("the local category vocabulary matches the shared contract", () => {
  assert.deepEqual(MEMORY_CATEGORIES, SHARED_MEMORY_CATEGORIES);
});

test("the client declares every closed sync capability", () => {
  assert.deepEqual(SYNC_CAPABILITIES, SHARED_SYNC_CAPABILITIES);
});

test("local events use the fixed v1 field set and keep content out of metadata", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = repository.addClient({ host: "codex", label: "Contract test" });
  const sentinel = "EVENT_PAYLOAD_MUST_NOT_CONTAIN_CONTENT";
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "event-contract",
    category: "fact",
    content: sentinel,
  });
  const event = repository.events().find((candidate) => candidate.save_id === "event-contract");
  assert.deepEqual(Object.keys(event), [
    "event_id",
    "format_version",
    "entity_id",
    "owner_id",
    "replica_id",
    "replica_seq",
    "entity_version",
    "op",
    "actor",
    "client_id",
    "occurred_at",
    "save_id",
    "payload",
  ]);
  assert.equal(event.format_version, 1);
  function containsSentinel(value) {
    if (typeof value === "string") return value.includes(sentinel);
    if (Array.isArray(value)) return value.some(containsSentinel);
    return value && typeof value === "object" && Object.values(value).some(containsSentinel);
  }
  assert.equal(containsSentinel(repository.events()), false);
  repository.close();
});
