import assert from "node:assert/strict";
import test from "node:test";

import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, SCHEMA_VERSION } from "../src/constants.js";
import { LocalRepository, screenContent, unsupportedSchemaVersionMessage } from "../src/repository.js";
import { RecallIndex, tokenize } from "../src/recallIndex.js";
import { temporaryHome } from "./helpers.mjs";

function pair(repository, label = "Agent A") {
  return repository.addClient({ host: "codex", label });
}

function proposal(client, overrides = {}) {
  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: crypto.randomUUID(),
    category: "project",
    content: "Builds the Switchboard runtime",
    ...overrides,
  };
}

function syncedEvent(overrides = {}) {
  return {
    format_version: 1,
    event_id: "event-001",
    entity_id: "entity-001",
    owner_id: "owner-convergence",
    replica_id: "replica-source",
    replica_seq: 1,
    entity_version: 1,
    op: "memory_deleted",
    actor: "owner",
    client_id: null,
    occurred_at: "2026-08-24T12:00:00.000Z",
    save_id: null,
    payload: {},
    ...overrides,
  };
}

function seededShuffle(values, seed) {
  const shuffled = [...values];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
  }
  return shuffled;
}

test("the offline loop persists across repository instances and deletes content", (t) => {
  const home = temporaryHome(t);
  let repository = new LocalRepository({ home });
  const client = pair(repository);
  repository.addGrant({ clientId: client.client_id, profile: "coding" });
  const saved = repository.propose(proposal(client));
  assert.equal(saved.disposition, "auto_approved");
  const memoryId = repository.listMemories()[0].memory_id;
  repository.close();

  repository = new LocalRepository({ home });
  const recalled = repository.read({
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["project"],
    query: "local runtime",
  });
  assert.equal(recalled.status, "results");
  assert.equal(recalled.rows[0].content, "Builds the Switchboard runtime");
  assert.equal(repository.deleteMemory(memoryId).status, "deleted");
  assert.equal(repository.read({
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["project"],
  }).status, "empty");
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM content_records").get().count, 0);
  assert.equal(repository.db.pragma("secure_delete", { simple: true }), 1);
  repository.close();
});

test("save identifiers deduplicate while preserving the proposal and disposition", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const input = proposal(client, { save_id: "stable-save" });
  const first = repository.propose(input);
  const second = repository.propose(input);
  assert.equal(first.status, "recorded");
  assert.deepEqual(second, { ...first, status: "duplicate" });
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 1);
  const other = pair(repository, "Other agent");
  const probed = repository.propose({ ...input, client_id: other.client_id, client_secret: other.client_secret });
  assert.deepEqual(probed, { status: "rejected", proposal_id: null, save_id: "stable-save", disposition: "pending" });
  repository.close();
});

test("save identifiers are bounded opaque values at propose and ingest", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), ownerId: "owner-convergence", initializeDefaults: false });
  const client = pair(repository);
  const before = repository.events().length;
  for (const saveId of ["", "contains space", "a".repeat(65), "path/value", "owner:value", "snowman-☃"]) {
    assert.throws(() => repository.propose(proposal(client, { save_id: saveId })),
      /save_id must match \^\[A-Za-z0-9\._-\]\{1,64\}\$/);
  }
  assert.equal(repository.events().length, before);
  assert.throws(() => repository.ingestEvent(syncedEvent({
    event_id: "invalid-save-event",
    replica_seq: 2,
    entity_id: "proposal-invalid",
    op: "proposal_created",
    save_id: "content smuggling is not an id",
    payload: {
      category: "fact",
      content_version: 1,
      disposition: "pending",
      evidence_basis: "assistant_saved_from_chat",
      occurred_at: "2026-08-24T12:00:00.000Z",
      source: "Replica",
    },
  })), /save_id must match/);
  assert.equal(repository.events().length, before);
  repository.close();
});

test("automatic approval and review mode keep distinct dispositions", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const automatic = repository.propose(proposal(client, { save_id: "automatic" }));
  assert.equal(automatic.disposition, "auto_approved");
  assert.deepEqual(
    repository.events().filter((event) => event.save_id === "automatic").map((event) => event.op),
    ["proposal_created", "proposal_approved"]
  );
  const approval = repository.events().find((event) => event.op === "proposal_approved").payload;
  assert.equal(approval.via, "auto_approval_policy");
  assert.equal(typeof approval.memory_id, "string");
  assert.equal(typeof approval.decision_id, "string");
  assert.equal(approval.content_version, 1);

  repository.setAutoApprove(false);
  const pending = repository.propose(proposal(client, { save_id: "review", content: "Review this fact", category: "fact" }));
  assert.equal(pending.disposition, "pending");
  assert.equal(repository.listInbox()[0].proposal_id, pending.proposal_id);
  assert.equal(repository.approveProposal(pending.proposal_id), true);
  assert.equal(repository.listInbox().length, 0);
  repository.close();
});

test("client identity, grants, and revocation are enforced before recall", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const first = pair(repository, "First");
  const second = pair(repository, "Second");
  const storedClient = repository.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(first.client_id);
  assert.ok(!JSON.stringify(storedClient).includes(first.client_secret));
  assert.ok(storedClient.secret_hash);
  assert.ok(storedClient.secret_salt);
  repository.addGrant({ clientId: first.client_id, categories: ["fact"] });
  repository.propose(proposal(first, { category: "fact", content: "A governed fact" }));

  const input = { client_id: second.client_id, client_secret: second.client_secret, categories: ["fact"] };
  assert.equal(repository.read(input).status, "blocked");
  assert.deepEqual(repository.read(input).skipped_categories, [{ category: "fact", reason: "no_pass" }]);
  assert.equal(repository.read({ ...input, client_secret: first.client_secret }).status, "blocked");
  repository.addGrant({ clientId: second.client_id, categories: ["fact"] });
  assert.equal(repository.read(input).status, "results");
  repository.revokeClient(second.client_id);
  assert.equal(repository.read(input).status, "blocked");
  repository.close();
});

test("caller-provided client, grant, and creation-event UUIDs are exact, validated, and collision-safe", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const clientId = crypto.randomUUID();
  const clientEventId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const grantEventId = crypto.randomUUID();
  const client = repository.addClient({ clientId, eventId: clientEventId, host: "codex", label: "Exact client id" });
  const grant = repository.addGrant({ clientId, grantId, eventId: grantEventId, profile: "coding" });
  assert.equal(client.client_id, clientId);
  assert.equal(grant.grant_id, grantId);
  assert.equal(repository.creationEventId(clientId, "client_paired"), clientEventId);
  assert.equal(repository.creationEventId(grantId, "grant_created"), grantEventId);

  assert.throws(
    () => repository.addClient({ clientId: "not-a-uuid", host: "codex", label: "Invalid" }),
    /invalid client id/,
  );
  assert.throws(
    () => repository.addGrant({ clientId, grantId: "not-a-uuid", profile: "coding" }),
    /invalid grant id/,
  );
  assert.throws(
    () => repository.addClient({ eventId: "not-a-uuid", host: "codex", label: "Invalid" }),
    /invalid client event id/,
  );
  assert.throws(
    () => repository.addGrant({ clientId, eventId: "not-a-uuid", profile: "coding" }),
    /invalid grant event id/,
  );
  assert.throws(
    () => repository.addClient({ clientId, host: "codex", label: "Collision" }),
    /client id collision/,
  );
  assert.throws(
    () => repository.addGrant({ clientId, grantId, profile: "coding" }),
    /grant id collision/,
  );
  assert.throws(
    () => repository.addGrant({ clientId, grantId: clientId, profile: "coding" }),
    /grant id collision/,
  );
  assert.throws(
    () => repository.addClient({ eventId: clientEventId, host: "codex", label: "Event collision" }),
    /client event id collision/,
  );
  assert.throws(
    () => repository.addGrant({ clientId, eventId: grantEventId, profile: "coding" }),
    /grant event id collision/,
  );
  repository.close();
});

test("profile grants retain the expansion frozen at grant time", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const grant = repository.addGrant({ clientId: client.client_id, profile: "coding" });
  assert.equal(grant.profile_version, 1);
  repository.defineProfile({ name: "coding", categories: [...grant.categories, "relationship"] });
  assert.equal(repository.profile("coding").version, 2);
  const stored = repository.listGrants(client.client_id)[0];
  assert.equal(stored.profile_version, 1);
  assert.ok(!stored.categories.includes("relationship"));
  repository.propose(proposal(client, { category: "relationship", content: "Works with a trusted collaborator" }));
  const outcome = repository.read({
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["relationship"],
  });
  assert.equal(outcome.status, "blocked");
  repository.close();
});

test("a tombstone dominates a later replayed approval", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const saved = repository.propose(proposal(client, { save_id: "delete-before-replay" }));
  const approval = repository.events().find((event) => event.op === "proposal_approved" && event.entity_id === saved.proposal_id);
  const memoryId = repository.listMemories()[0].memory_id;
  repository.deleteMemory(memoryId);
  const replay = {
    ...approval,
    event_id: crypto.randomUUID(),
    replica_id: crypto.randomUUID(),
    replica_seq: 1,
    entity_version: approval.entity_version + 1,
  };
  assert.equal(repository.ingestEvent(replay), true);
  assert.equal(repository.db.prepare("SELECT deleted_at FROM memories WHERE memory_id = ?").get(memoryId).deleted_at != null, true);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM content_records").get().count, 0);
  assert.equal(repository.listMemories().length, 0);
  repository.close();
});

test("code-aware BM25 finds paths, camelCase symbols, and error codes", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  repository.addGrant({ clientId: client.client_id, categories: ["project"] });
  const cases = [
    ["path", "The config is in src/runtime/localStore.js", "src/runtime/localStore.js"],
    ["symbol", "Call rebuildRecallIndex after mutation", "rebuildRecallIndex"],
    ["error", "Retry when SQLITE_BUSY is raised", "SQLITE_BUSY"],
  ];
  for (const [saveId, content] of cases) repository.propose(proposal(client, { save_id: saveId, content }));
  for (const [, content, query] of cases) {
    const outcome = repository.read({
      client_id: client.client_id,
      client_secret: client.client_secret,
      categories: ["project"],
      query,
    });
    assert.equal(outcome.rows[0].content, content);
  }
  assert.ok(tokenize("rebuildRecallIndex").includes("recall"));
  repository.close();
});

test("blocked, empty, and results outcomes remain distinct", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const request = { client_id: client.client_id, client_secret: client.client_secret, categories: ["fact"] };
  assert.equal(repository.read(request).status, "blocked");
  repository.addGrant({ clientId: client.client_id, categories: ["fact"] });
  assert.equal(repository.read(request).status, "empty");
  repository.propose(proposal(client, { category: "fact", content: "A result exists" }));
  assert.equal(repository.read(request).status, "results");
  repository.close();
});

test("receipts are content-free and owner reads do not create them", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  repository.addGrant({ clientId: client.client_id, categories: ["fact"] });
  const sentinel = "RECEIPT_MUST_NOT_CONTAIN_THIS";
  repository.propose(proposal(client, { category: "fact", content: sentinel }));
  repository.prefetch({ client_id: client.client_id, client_secret: client.client_secret, categories: ["fact"], query: sentinel });
  assert.equal(repository.receipts().length, 0);
  repository.recall({ client_id: client.client_id, client_secret: client.client_secret, categories: ["fact"], query: sentinel });
  repository.read({ categories: ["fact"] }, { owner: true, receipt: false });
  const receipts = repository.receipts();
  assert.equal(receipts.length, 1);
  assert.ok(!JSON.stringify(receipts).includes(sentinel));
  assert.ok(!JSON.stringify(repository.events()).includes(sentinel));
  assert.deepEqual(repository.db.prepare("PRAGMA table_info(receipts)").all().map((column) => column.name), [
    "receipt_id", "client_id", "categories", "row_count", "created_at",
  ]);
  repository.close();
});

test("the event log rejects updates and deletes", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  assert.throws(() => repository.db.prepare("UPDATE events SET op = 'grant_created'").run(), /append-only/);
  assert.throws(() => repository.db.prepare("DELETE FROM events").run(), /append-only/);
  repository.close();
});

test("the storage payload codec is an encryption seam while plaintext remains the default", (t) => {
  const codec = {
    encode(value) {
      return Buffer.from(value, "utf8").toString("base64");
    },
    decode(value) {
      return Buffer.from(value, "base64").toString("utf8");
    },
  };
  const repository = new LocalRepository({ home: temporaryHome(t), storageOptions: { payloadCodec: codec } });
  const client = pair(repository);
  repository.addGrant({ clientId: client.client_id, categories: ["fact"] });
  const content = "Codec-protected local content";
  repository.propose(proposal(client, { category: "fact", content }));
  assert.notEqual(repository.db.prepare("SELECT content FROM content_records").get().content, content);
  assert.equal(repository.prefetch({
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["fact"],
  }).rows[0].content, content);
  repository.close();
});

test("content screens reject credentials, binary data, claims, and oversized values", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const rejected = [
    proposal(client, { save_id: "aws", content: "AKIAIOSFODNN7EXAMPLE" }),
    proposal(client, { save_id: "pem", content: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }),
    proposal(client, { save_id: "opaque", content: "0123456789abcdef".repeat(8) }),
    proposal(client, { save_id: "binary", content: "hello\0world" }),
    proposal(client, { save_id: "large", content: "word ".repeat(8_000) }),
    proposal(client, { save_id: "claim", category: "claim" }),
  ];
  for (const input of rejected) assert.equal(repository.propose(input).status, "rejected");
  assert.equal(screenContent("a".repeat(100)), null, "low-entropy prose-like runs are accepted");
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);
  repository.close();
});

test("content screening stays in parity with the repository never-store rules", () => {
  const rejected = [
    "Visa 4111 1111 1111 1111",
    "Mastercard 5555-5555-5555-4444",
    "Amex 378282246310005",
    `OpenAI sk-${"a".repeat(32)}`,
    `Project sk-proj-${"b".repeat(20)}`,
    `Anthropic sk-ant-api03-${"c".repeat(20)}`,
    `Stripe sk_live_${"d".repeat(20)}`,
    `GitHub ghp_${"e".repeat(24)}`,
    `Fine-grained github_pat_${"f".repeat(24)}`,
    "Slack xoxb-1234567890-abcdefghij",
    "AWS AKIAIOSFODNN7EXAMPLE",
    `Google AIza${"g".repeat(35)}`,
    `api_key=${"h".repeat(20)}`,
    `base64url abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-${"q7_Z".repeat(18)}`,
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
  ];
  for (const content of rejected) assert.equal(screenContent(content), "sensitive_content", content.slice(0, 24));
});

test("project scopes constrain grants and reads without exposing other projects", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const firstScope = "1".repeat(64);
  const secondScope = "2".repeat(64);
  repository.defineProfile({ name: "scoped", categories: ["project"], projectScopes: [firstScope] });
  repository.addGrant({ clientId: client.client_id, profile: "scoped" });
  repository.propose({ ...proposal(client), save_id: "global-scope", content: "global coding context" });
  repository.propose({ ...proposal(client), save_id: "first-scope", content: "first project context", project_scope: firstScope });
  repository.propose({ ...proposal(client), save_id: "second-scope", content: "second project context", project_scope: secondScope });
  const request = {
    client_id: client.client_id, client_secret: client.client_secret, categories: ["project"], query: "context",
  };
  assert.deepEqual(repository.read({ ...request, project_scope: firstScope }).rows.map((row) => row.content).sort(), [
    "first project context", "global coding context",
  ]);
  assert.deepEqual(repository.read({ ...request, project_scope: secondScope }).rows.map((row) => row.content), [
    "global coding context",
  ]);
  assert.deepEqual(repository.read(request).rows.map((row) => row.content), ["global coding context"]);
  assert.deepEqual(repository.profile("scoped").project_scopes, [firstScope]);
  repository.close();
});

test("foreign-owner events are rejected before insertion or projection changes", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(repository);
  const saved = repository.propose(proposal(client));
  const approval = repository.events().find((event) => event.op === "proposal_approved" && event.entity_id === saved.proposal_id);
  const memoryId = repository.listMemories()[0].memory_id;
  const before = {
    events: repository.events(),
    proposals: repository.db.prepare("SELECT * FROM proposals ORDER BY proposal_id").all(),
    memories: repository.db.prepare("SELECT * FROM memories ORDER BY memory_id").all(),
    tombstones: repository.db.prepare("SELECT * FROM tombstones ORDER BY entity_id").all(),
  };
  const foreignBase = { ...approval, owner_id: crypto.randomUUID(), replica_id: crypto.randomUUID(), replica_seq: 1 };
  assert.throws(() => repository.ingestEvent({
    ...foreignBase,
    event_id: crypto.randomUUID(),
    entity_id: memoryId,
    entity_version: 1,
    op: "memory_deleted",
    payload: {},
  }), /owner_id/);
  assert.throws(() => repository.ingestEvent({
    ...foreignBase,
    event_id: crypto.randomUUID(),
    entity_version: approval.entity_version + 1,
  }), /owner_id/);
  assert.deepEqual({
    events: repository.events(),
    proposals: repository.db.prepare("SELECT * FROM proposals ORDER BY proposal_id").all(),
    memories: repository.db.prepare("SELECT * FROM memories ORDER BY memory_id").all(),
    tombstones: repository.db.prepare("SELECT * FROM tombstones ORDER BY entity_id").all(),
  }, before);
  repository.close();
});

test("a clean replica rebuilds every projection from events and content records", (t) => {
  const source = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(source, "Replay source");
  const grant = source.addGrant({ clientId: client.client_id, profile: "coding" });
  source.revokeGrant(grant.grant_id);
  source.defineProfile({ name: "coding", categories: ["preference", "fact", "project", "instruction", "relationship"] });
  source.propose(proposal(client, { save_id: "live", category: "fact", content: "Content copied separately" }));
  source.setAutoApprove(false);
  const rejected = source.propose(proposal(client, { save_id: "rejected", content: "Erase rejected content" }));
  source.rejectProposal(rejected.proposal_id);
  source.setAutoApprove(true);
  source.propose(proposal(client, { save_id: "deleted", content: "Erase deleted content" }));
  const deletedMemory = source.listMemories().find((memory) => memory.category === "project").memory_id;
  source.deleteMemory(deletedMemory);
  source.revokeClient(client.client_id);
  source.setAutoApprove(false);

  const replica = new LocalRepository({
    home: temporaryHome(t),
    ownerId: source.metadata().owner_id,
    initializeDefaults: false,
  });
  for (const event of source.events()) assert.equal(replica.ingestEvent(event), true);
  for (const record of source.contentRecords()) assert.equal(replica.ingestContentRecord(record), true);

  const projections = [
    ["clients", "client_id"],
    ["grants", "grant_id"],
    ["profiles", "name, version"],
    ["proposals", "proposal_id"],
    ["decisions", "decision_id"],
    ["memories", "memory_id"],
    ["deletion_fences", "entity_id"],
    ["tombstones", "entity_id"],
  ];
  for (const [table, order] of projections) {
    assert.deepEqual(
      replica.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
      source.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
      table
    );
  }
  assert.deepEqual(replica.contentRecords(), source.contentRecords());
  assert.deepEqual(replica.listMemories(), source.listMemories());
  assert.equal(source.metadata().auto_approve, false);
  assert.equal(replica.metadata().auto_approve, true, "auto approval is not canonical synced state");
  replica.close();
  source.close();
});

test("approval before proposal is retained and reconciled", (t) => {
  const source = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(source);
  const saved = source.propose(proposal(client, { content: "Out of order approval" }));
  const created = source.events().find((event) => event.op === "proposal_created" && event.entity_id === saved.proposal_id);
  const approval = source.events().find((event) => event.op === "proposal_approved" && event.entity_id === saved.proposal_id);
  const content = source.contentRecords()[0];
  const replica = new LocalRepository({ home: temporaryHome(t), ownerId: source.metadata().owner_id, initializeDefaults: false });
  assert.equal(replica.ingestEvent(approval), true);
  assert.equal(replica.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 0);
  assert.equal(replica.ingestContentRecord(content), true);
  assert.equal(replica.ingestEvent(created), true);
  assert.equal(replica.listMemories()[0].content, content.content);
  assert.equal(replica.db.prepare("SELECT COUNT(*) AS count FROM event_applications").get().count, 2);
  replica.close();
  source.close();
});

test("deletion before approval dominates and erases separately arriving content", (t) => {
  const source = new LocalRepository({ home: temporaryHome(t) });
  const client = pair(source);
  const saved = source.propose(proposal(client, { content: "Out of order deletion" }));
  const created = source.events().find((event) => event.op === "proposal_created" && event.entity_id === saved.proposal_id);
  const approval = source.events().find((event) => event.op === "proposal_approved" && event.entity_id === saved.proposal_id);
  const content = source.contentRecords()[0];
  const memoryId = approval.payload.memory_id;
  source.deleteMemory(memoryId);
  const deletion = source.events().find((event) => event.op === "memory_deleted" && event.entity_id === memoryId);

  const replica = new LocalRepository({ home: temporaryHome(t), ownerId: source.metadata().owner_id, initializeDefaults: false });
  assert.equal(replica.ingestEvent(deletion), true);
  assert.equal(replica.ingestEvent(approval), true);
  assert.equal(replica.ingestContentRecord(content), true);
  assert.equal(replica.ingestEvent(created), true);
  assert.equal(replica.listMemories().length, 0);
  assert.equal(replica.contentRecords().length, 0);
  assert.equal(replica.db.prepare("SELECT deleted_at FROM memories WHERE memory_id = ?").get(memoryId).deleted_at, deletion.occurred_at);
  replica.close();
  source.close();
});

test("content records are validated against source events in either arrival order", (t) => {
  const event = syncedEvent({
    event_id: "content-source", entity_id: "content-proposal", op: "proposal_created", save_id: "content-save",
    payload: {
      category: "fact",
      content_version: 1,
      disposition: "pending",
      evidence_basis: "assistant_saved_from_chat",
      occurred_at: "2026-08-24T12:00:00.000Z",
      source: "Replica client",
    },
  });
  const mismatched = {
    event_id: event.event_id, entity_id: event.entity_id, content_version: 2,
    owner_id: event.owner_id, content: "Mismatched parked content", created_at: "2026-08-24T12:00:01.000Z",
  };
  const correct = {
    ...mismatched, content_version: 1, content: "Correct recovered content", created_at: "2026-08-24T12:00:02.000Z",
  };

  const eventFirst = new LocalRepository({
    home: temporaryHome(t), ownerId: event.owner_id, initializeDefaults: false,
  });
  assert.equal(eventFirst.ingestEvent(event), true);
  assert.throws(() => eventFirst.ingestContentRecord(mismatched), /does not match its source event/);
  assert.equal(eventFirst.ingestContentRecord(correct), true);
  assert.deepEqual(eventFirst.contentRecords(), [correct]);
  eventFirst.close();

  const contentFirst = new LocalRepository({
    home: temporaryHome(t), ownerId: event.owner_id, initializeDefaults: false,
  });
  assert.equal(contentFirst.ingestContentRecord(mismatched), true);
  assert.equal(contentFirst.ingestEvent(event), true);
  assert.equal(contentFirst.db.prepare("SELECT 1 FROM content_candidates WHERE source_event_id = ?").get(event.event_id), undefined);
  assert.deepEqual(contentFirst.db.prepare(`
    SELECT winner_event_id, reason FROM content_supersessions WHERE source_event_id = ?
  `).get(event.event_id), { winner_event_id: event.event_id, reason: "event_superseded" });
  assert.equal(contentFirst.ingestContentRecord(correct), true);
  assert.deepEqual(contentFirst.contentRecords(), [correct]);
  assert.equal(contentFirst.db.prepare("SELECT 1 FROM content_supersessions WHERE source_event_id = ?").get(event.event_id), undefined);
  contentFirst.close();
});

test("complete event streams converge across creation, reverse, and fixed shuffled orders", (t) => {
  const proposalPayload = (overrides = {}) => ({
    category: "fact",
    content_version: 1,
    disposition: "pending",
    evidence_basis: "assistant_saved_from_chat",
    occurred_at: "2026-08-24T12:00:00.000Z",
    source: "Replica client",
    ...overrides,
  });
  const approvalPayload = (decisionId, memoryId, contentVersion = 1) => ({
    content_version: contentVersion,
    decision_id: decisionId,
    memory_id: memoryId,
    via: "owner_review",
  });
  const rawEvents = [
    syncedEvent({
      event_id: "evt-020-client-pair", entity_id: "client-1", op: "client_paired", actor: "owner",
      payload: { host: "codex", label: "Convergence client", secret_salt: "0".repeat(32), secret_hash: "1".repeat(64) },
    }),
    syncedEvent({ event_id: "evt-021-client-revoke", entity_id: "client-1", entity_version: 2, op: "client_revoked", payload: {} }),
    syncedEvent({
      event_id: "evt-010-profile-win", entity_id: "profile-source-a", op: "profile_defined",
      payload: { name: "shared-profile", version: 1, categories: ["fact"], project_scopes: [] },
    }),
    syncedEvent({
      event_id: "evt-090-profile-lose", entity_id: "profile-source-b", op: "profile_defined",
      payload: { name: "shared-profile", version: 1, categories: ["project"], project_scopes: [] },
    }),
    syncedEvent({
      event_id: "evt-030-grant-create", entity_id: "grant-1", op: "grant_created", client_id: "client-1",
      payload: { profile: "shared-profile", profile_version: 1, categories: ["fact"], project_scopes: [] },
    }),
    syncedEvent({
      event_id: "evt-031-grant-revoke", entity_id: "grant-1", entity_version: 2, op: "grant_revoked",
      client_id: "client-1", payload: {},
    }),
    syncedEvent({
      event_id: "evt-040-save-win", entity_id: "proposal-a", op: "proposal_created", actor: "client",
      client_id: "client-1", save_id: "shared-save", payload: proposalPayload(),
    }),
    syncedEvent({
      event_id: "evt-041-approval", entity_id: "proposal-a", entity_version: 2, op: "proposal_approved",
      save_id: "shared-save", payload: approvalPayload("decision-approve-a", "memory-a"),
    }),
    syncedEvent({
      event_id: "evt-092-reject-z", entity_id: "proposal-a", entity_version: 2, op: "proposal_rejected",
      save_id: "shared-save", payload: { decision_id: "decision-reject-z", via: "owner_review" },
    }),
    syncedEvent({
      event_id: "evt-091-reject-a", entity_id: "proposal-a", entity_version: 2, op: "proposal_rejected",
      save_id: "shared-save", payload: { decision_id: "decision-reject-a", via: "owner_review" },
    }),
    syncedEvent({
      event_id: "evt-080-save-lose", entity_id: "proposal-b", op: "proposal_created", actor: "client",
      client_id: "client-1", save_id: "shared-save", payload: proposalPayload({ category: "project" }),
    }),
    syncedEvent({
      event_id: "evt-081-loser-approval", entity_id: "proposal-b", entity_version: 2, op: "proposal_approved",
      save_id: "shared-save", payload: approvalPayload("decision-b", "memory-b"),
    }),
    syncedEvent({
      event_id: "evt-015-version-win", entity_id: "proposal-c", op: "proposal_created", actor: "client",
      client_id: "client-1", save_id: "version-save", payload: proposalPayload({ content_version: 2 }),
    }),
    syncedEvent({
      event_id: "evt-099-version-lose", entity_id: "proposal-c", op: "proposal_created", actor: "client",
      client_id: "client-1", save_id: "version-save", payload: proposalPayload({ content_version: 2 }),
    }),
    syncedEvent({
      event_id: "evt-050-version-approval", entity_id: "proposal-c", entity_version: 2, op: "proposal_approved",
      save_id: "version-save", payload: approvalPayload("decision-c", "memory-c", 2),
    }),
    syncedEvent({
      event_id: "evt-060-delete-create", entity_id: "proposal-d", op: "proposal_created", actor: "client",
      client_id: "client-1", save_id: "delete-save", payload: proposalPayload({ category: "project" }),
    }),
    syncedEvent({
      event_id: "evt-061-delete-approval", entity_id: "proposal-d", entity_version: 2, op: "proposal_approved",
      save_id: "delete-save", payload: approvalPayload("decision-d", "memory-d"),
    }),
    syncedEvent({ event_id: "evt-070-delete-z", entity_id: "memory-d", op: "memory_deleted", payload: {} }),
    syncedEvent({ event_id: "evt-069-delete-a", entity_id: "memory-d", op: "memory_deleted", payload: {} }),
    syncedEvent({
      event_id: "evt-100-handoff-client-a", entity_id: "handoff-client-a", op: "client_paired",
      payload: { host: "claude-code", label: "Handoff A", secret_salt: "2".repeat(32), secret_hash: "3".repeat(64) },
    }),
    syncedEvent({
      event_id: "evt-101-handoff-client-b", entity_id: "handoff-client-b", op: "client_paired",
      payload: { host: "opencode", label: "Handoff B", secret_salt: "4".repeat(32), secret_hash: "5".repeat(64) },
    }),
    syncedEvent({
      event_id: "evt-102-handoff-grant-a", entity_id: "handoff-grant-a", op: "grant_created",
      client_id: "handoff-client-a",
      payload: { profile: "coding", profile_version: 1, categories: ["project"], project_scopes: [] },
    }),
    syncedEvent({
      event_id: "evt-103-handoff-grant-b", entity_id: "handoff-grant-b", op: "grant_created",
      client_id: "handoff-client-b",
      payload: { profile: "coding", profile_version: 1, categories: ["project"], project_scopes: [] },
    }),
    syncedEvent({
      event_id: "evt-104-handoff-create", entity_id: "handoff-convergent", op: "handoff_created",
      actor: "client", client_id: "handoff-client-a",
      payload: {
        content_ref: { entity_id: "handoff-convergent", content_version: 1 },
        expires_at: "2026-08-25T12:00:00.000Z", profile: "coding",
        project_scope: "2".repeat(64), to_client_id: null,
      },
    }),
    syncedEvent({
      event_id: "evt-106-handoff-claim-b", entity_id: "handoff-convergent", entity_version: 2,
      op: "handoff_claimed", actor: "client", client_id: "handoff-client-b",
      payload: { project_scope: "2".repeat(64) },
    }),
    syncedEvent({
      event_id: "evt-105-handoff-claim-a", entity_id: "handoff-convergent", entity_version: 2,
      op: "handoff_claimed", actor: "client", client_id: "handoff-client-a",
      payload: { project_scope: "2".repeat(64) },
    }),
  ];
  const events = rawEvents.map((event, index) => ({ ...event, replica_seq: index + 1 }));
  const contentRecords = [
    { event_id: "evt-040-save-win", entity_id: "proposal-a", content_version: 1, owner_id: "owner-convergence", content: "Rejected terminal content", created_at: "2026-08-24T12:00:01.000Z" },
    { event_id: "evt-080-save-lose", entity_id: "proposal-b", content_version: 1, owner_id: "owner-convergence", content: "Duplicate save content", created_at: "2026-08-24T12:00:02.000Z" },
    { event_id: "evt-099-version-lose", entity_id: "proposal-c", content_version: 2, owner_id: "owner-convergence", content: "A losing event has the smaller content hash", created_at: "2026-08-24T12:00:03.000Z" },
    { event_id: "evt-015-version-win", entity_id: "proposal-c", content_version: 2, owner_id: "owner-convergence", content: "The winning event owns canonical content", created_at: "2026-08-24T12:00:04.000Z" },
    { event_id: "evt-060-delete-create", entity_id: "proposal-d", content_version: 1, owner_id: "owner-convergence", content: "Deleted memory content", created_at: "2026-08-24T12:00:05.000Z" },
    { event_id: "evt-104-handoff-create", entity_id: "handoff-convergent", content_version: 1, owner_id: "owner-convergence", content: "Transient convergent handoff", created_at: "2026-08-24T12:00:06.000Z" },
  ];
  const contentByEvent = new Map(contentRecords.map((record) => [record.event_id, record]));
  const actions = events.flatMap((event) => [
    { kind: "event", value: event },
    ...(contentByEvent.has(event.event_id) ? [{ kind: "content", value: contentByEvent.get(event.event_id) }] : []),
  ]);
  const orders = [actions, [...actions].reverse(), seededShuffle(actions, 889), seededShuffle(actions, 20260824)];
  const repositories = orders.map((order) => {
    const repository = new LocalRepository({
      home: temporaryHome(t), ownerId: "owner-convergence", initializeDefaults: false,
      now: () => new Date("2026-08-24T13:00:00.000Z"),
    });
    for (const action of order) {
      if (action.kind === "event") assert.equal(repository.ingestEvent(action.value), true);
      else repository.ingestContentRecord(action.value);
    }
    return repository;
  });
  const tables = [
    ["clients", "client_id"], ["profiles", "name, version"], ["grants", "grant_id"],
    ["proposals", "proposal_id"], ["decisions", "decision_id"], ["memories", "memory_id"],
    ["deletion_fences", "entity_id"], ["tombstones", "entity_id"],
    ["event_versions", "entity_id, entity_version, op"], ["event_supersessions", "event_id"],
    ["event_applications", "event_id"], ["pending_events", "event_id"],
    ["content_candidates", "source_event_id"], ["content_supersessions", "source_event_id"],
    ["handoff_claim_dependencies", "event_id"],
    ["handoffs", "handoff_id"], ["handoff_receipts", "receipt_id"],
  ];
  const snapshot = (repository) => Object.fromEntries([
    ...tables.map(([table, order]) => [table, repository.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]),
    ["content_records", repository.contentRecords()],
  ]);
  const expected = snapshot(repositories[0]);
  for (const repository of repositories.slice(1)) assert.deepEqual(snapshot(repository), expected);
  for (const repository of repositories) {
    assert.deepEqual(repository.profile("shared-profile").categories, ["fact"]);
    assert.equal(repository.db.prepare("SELECT proposal_id FROM proposals WHERE save_id = 'shared-save'").get().proposal_id, "proposal-a");
    assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = 'proposal-a'").get().status, "rejected");
    assert.equal(repository.db.prepare("SELECT 1 FROM proposals WHERE proposal_id = 'proposal-b'").get(), undefined);
    assert.equal(repository.db.prepare("SELECT 1 FROM memories WHERE memory_id = 'memory-a'").get(), undefined);
    assert.equal(repository.db.prepare("SELECT 1 FROM content_records WHERE entity_id = 'proposal-a'").get(), undefined);
    assert.equal(repository.db.prepare("SELECT 1 FROM content_candidates WHERE entity_id = 'proposal-a'").get(), undefined);
    assert.deepEqual(repository.db.prepare(`
      SELECT winner_event_id, reason FROM content_supersessions WHERE source_event_id = 'evt-040-save-win'
    `).get(), { winner_event_id: "evt-091-reject-a", reason: "proposal_rejected" });
    assert.equal(repository.db.prepare("SELECT deleted_at FROM memories WHERE memory_id = 'memory-d'").get().deleted_at,
      "2026-08-24T12:00:00.000Z");
    assert.equal(repository.contentRecords()[0].content, "The winning event owns canonical content");
    assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = 'handoff-convergent'").get().status, "claimed");
    assert.equal(repository.db.prepare("SELECT client_id FROM handoff_receipts WHERE handoff_id = 'handoff-convergent'").get().client_id,
      "handoff-client-a");
    assert.equal(repository.db.prepare("SELECT 1 FROM content_records WHERE entity_id = 'handoff-convergent'").get(), undefined);
    assert.deepEqual(repository.db.prepare(`
      SELECT winner_event_id, reason FROM event_supersessions WHERE event_id = 'evt-106-handoff-claim-b'
    `).get(), { winner_event_id: "evt-105-handoff-claim-a", reason: "version_collision" });
    assert.deepEqual(repository.db.prepare(`
      SELECT winner_event_id, reason FROM content_supersessions WHERE source_event_id = 'evt-099-version-lose'
    `).get(), { winner_event_id: "evt-015-version-win", reason: "event_superseded" });
    assert.equal(repository.db.prepare(`
      SELECT event_id FROM event_versions WHERE entity_id = 'proposal-c' AND entity_version = 1
    `).get().event_id, "evt-015-version-win");
    assert.deepEqual(repository.db.prepare("SELECT winner_event_id, reason FROM event_supersessions WHERE event_id = ?")
      .get("evt-099-version-lose"), { winner_event_id: "evt-015-version-win", reason: "version_collision" });
    assert.deepEqual(repository.db.prepare("SELECT winner_event_id, reason FROM event_supersessions WHERE event_id = ?")
      .get("evt-041-approval"), { winner_event_id: "evt-091-reject-a", reason: "rejection_dominates" });
    assert.deepEqual(repository.db.prepare(`
      SELECT winner_event_id, reason FROM content_supersessions WHERE source_event_id = 'evt-060-delete-create'
    `).get(), { winner_event_id: "evt-069-delete-a", reason: "memory_deleted" });
    assert.equal(repository.db.prepare(`
      SELECT COUNT(*) AS count FROM event_versions
      WHERE entity_id = 'proposal-a' AND entity_version = 2
    `).get().count, 2, "different terminal operation classes survive version indexing");
    assert.equal(repository.metadata().auto_approve, true, "replay preserves the clean replica's local policy default");
    assert.deepEqual(repository.propose({ save_id: "shared-save" }, { owner: true }), {
      status: "duplicate", proposal_id: "proposal-a", save_id: "shared-save", disposition: "pending",
    });
    const beforeDuplicateEvent = snapshot(repository);
    assert.equal(repository.ingestEvent(events.find((event) => event.event_id === "evt-041-approval")), false);
    assert.deepEqual(snapshot(repository), beforeDuplicateEvent, "duplicate superseded events cannot rebuild or resurrect content");
    repository.close();
  }
});

test("proposal approval links reject self references and proposal-memory cross-links", (t) => {
  const repository = new LocalRepository({
    home: temporaryHome(t), ownerId: "owner-convergence", initializeDefaults: false,
  });
  assert.throws(() => repository.ingestEvent(syncedEvent({
    event_id: "self-approval", entity_id: "proposal-self", op: "proposal_approved", save_id: "self-save",
    payload: { content_version: 1, decision_id: "self-decision", memory_id: "proposal-self", via: "owner_review" },
  })), /memory_id must differ/);
  assert.equal(repository.ingestEvent(syncedEvent({
    event_id: "cross-first", entity_id: "proposal-left", op: "proposal_approved", save_id: "cross-left",
    payload: { content_version: 1, decision_id: "cross-decision-left", memory_id: "proposal-right", via: "owner_review" },
  })), true);
  assert.throws(() => repository.ingestEvent(syncedEvent({
    event_id: "cross-second", entity_id: "proposal-right", replica_seq: 2, op: "proposal_approved", save_id: "cross-right",
    payload: { content_version: 1, decision_id: "cross-decision-right", memory_id: "proposal-left", via: "owner_review" },
  })), /proposal entity_id conflicts with a memory_id/);
  assert.equal(repository.events().length, 1);
  repository.close();
});

test("reconciliation bounds work for a shaped legacy crossed sync-link cycle", (t) => {
  const attempts = [];
  const repository = new LocalRepository({
    home: temporaryHome(t), ownerId: "owner-convergence", initializeDefaults: false,
    reconciliationObserver: ({ entity_id: entityId }) => attempts.push(entityId),
  });
  const leftApproval = syncedEvent({
    event_id: "cycle-approval-left", entity_id: "cycle-proposal-left", op: "proposal_approved", save_id: "cycle-save-left",
    payload: { content_version: 1, decision_id: "cycle-decision-left", memory_id: "cycle-memory-left", via: "owner_review" },
  });
  const rightApproval = syncedEvent({
    event_id: "cycle-approval-right", entity_id: "cycle-proposal-right", replica_seq: 2,
    op: "proposal_approved", save_id: "cycle-save-right",
    payload: { content_version: 1, decision_id: "cycle-decision-right", memory_id: "cycle-memory-right", via: "owner_review" },
  });
  assert.equal(repository.ingestEvent(leftApproval), true);
  assert.equal(repository.ingestEvent(rightApproval), true);
  repository.db.prepare("UPDATE event_memory_links SET memory_id = ? WHERE event_id = ?")
    .run(rightApproval.entity_id, leftApproval.event_id);
  repository.db.prepare("UPDATE event_memory_links SET memory_id = ? WHERE event_id = ?")
    .run(leftApproval.entity_id, rightApproval.event_id);
  attempts.length = 0;
  assert.equal(repository.ingestEvent(syncedEvent({
    event_id: "cycle-trigger", entity_id: "cycle-proposal-left", replica_seq: 3, entity_version: 2,
    op: "memory_deleted", save_id: null, payload: {},
  })), true);
  assert.ok(attempts.length <= 5, `expected bounded reconciliation work, saw ${attempts.length} rebuilds`);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM pending_events").get().count, 2);
  repository.close();
});

test("parked orphans do not add reconciliation work to unrelated appends", (t) => {
  const attempts = [];
  const repository = new LocalRepository({
    home: temporaryHome(t), ownerId: "owner-convergence", initializeDefaults: false,
    reconciliationObserver: ({ event_id: eventId }) => attempts.push(eventId),
  });
  const orphans = Array.from({ length: 50 }, (_, index) => syncedEvent({
    event_id: `orphan-approval-${index}`, entity_id: `missing-proposal-${index}`, replica_seq: index + 1,
    op: "proposal_approved", save_id: `orphan-save-${index}`,
    payload: { content_version: 1, decision_id: `orphan-decision-${index}`, memory_id: `orphan-memory-${index}`, via: "owner_review" },
  }));
  for (const orphan of orphans) assert.equal(repository.ingestEvent(orphan), true);
  for (const orphan of orphans) assert.equal(attempts.filter((eventId) => eventId === orphan.event_id).length, 1);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM pending_events").get().count, 50);
  const beforeUnrelated = attempts.length;
  assert.equal(repository.ingestEvent(syncedEvent({
    event_id: "unrelated-profile", entity_id: "profile:unrelated", replica_seq: 51, op: "profile_defined",
    payload: { name: "unrelated", version: 1, categories: ["fact"], project_scopes: [] },
  })), true);
  assert.equal(attempts.length - beforeUnrelated, 1, "unrelated work is constant despite the orphan population");
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM pending_events").get().count, 50);
  repository.close();
});

test("event max-version lookups use the entity-version index", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const plan = repository.db.prepare("EXPLAIN QUERY PLAN SELECT MAX(entity_version) FROM events WHERE entity_id = ?").all("entity");
  assert.match(plan.map((step) => step.detail).join("\n"), /COVERING INDEX events_entity_version/);
  repository.close();
});

test("recall bounds query token work", () => {
  assert.equal(MAX_QUERY_CHARS, 1_024);
  assert.equal(MAX_QUERY_TOKENS, 64);
  const index = new RecallIndex({
    loadRows: () => [{ content: "needle", category: "fact", created_at: "2026-01-01T00:00:00.000Z" }],
  });
  const amplified = `${Array.from({ length: MAX_QUERY_TOKENS }, (_, index) => `token${index}`).join(" ")} needle`;
  assert.deepEqual(index.search({ query: amplified, allowedCategories: ["fact"], limit: 20 }), []);
  assert.equal(index.search({ query: "needle", allowedCategories: ["fact"], limit: 20 }).length, 1);
});

test("repository recall truncates megabyte queries before tokenization", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  repository.propose({ save_id: "large-query-memory", category: "fact", content: "needle" }, { owner: true });
  const query = `${"x".repeat(1024 * 1024)} needle`;
  const outcome = repository.read({ categories: ["fact"], query }, { owner: true });
  assert.equal(outcome.status, "empty");
  repository.close();
});

test("opening an older store fails with a clear versioned error", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  assert.equal(repository.metadata().schema_version, SCHEMA_VERSION);
  repository.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  repository.close();
  assert.throws(() => new LocalRepository({ home }), new RegExp(`unsupported Switchboard schema version 1; expected ${SCHEMA_VERSION}`));
});

test("a schema 6 binary refuses a schema 7 store with the pinned mixed-version message", () => {
  assert.equal(
    unsupportedSchemaVersionMessage(7, 6),
    "unsupported Switchboard schema version 7; expected 6",
  );
});

test("a live schema 6 store upgrades in place with constrained project columns", (t) => {
  const home = temporaryHome(t);
  let repository = new LocalRepository({ home });
  repository.propose({ content: "Preserved schema six memory", category: "project", save_id: "schema-six" }, { owner: true });
  repository.db.exec(`
    ALTER TABLE memories DROP COLUMN project_scope;
    ALTER TABLE proposals DROP COLUMN project_scope;
    UPDATE meta SET value = '6' WHERE key = 'schema_version';
  `);
  repository.close();

  repository = new LocalRepository({ home });
  assert.equal(repository.metadata().schema_version, SCHEMA_VERSION);
  assert.equal(repository.listMemories()[0].content, "Preserved schema six memory");
  assert.equal(repository.db.pragma("table_info(proposals)").some((column) => column.name === "project_scope"), true);
  assert.equal(repository.db.pragma("table_info(memories)").some((column) => column.name === "project_scope"), true);
  assert.throws(() => repository.db.prepare("UPDATE proposals SET project_scope = 'bad'").run(), /CHECK constraint/);
  repository.close();
});

test("a live schema 7 store retains its replica scope key during the guarded version 8 upgrade", (t) => {
  const home = temporaryHome(t);
  let repository = new LocalRepository({ home });
  const replicaKey = repository.db.prepare("SELECT value FROM meta WHERE key = 'replica_scope_key'").get().value;
  repository.propose({
    content: "Preserved schema seven scoped memory",
    category: "project",
    save_id: "schema-seven-scope",
    project_scope: repository.scopeFingerprint("schema-seven-project"),
  }, { owner: true });
  repository.db.transaction(() => {
    repository.db.prepare("INSERT INTO meta(key, value) VALUES ('scope_key', ?)").run(replicaKey);
    repository.db.prepare("DELETE FROM meta WHERE key = 'replica_scope_key'").run();
    repository.db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
  })();
  repository.close();

  repository = new LocalRepository({ home });
  assert.equal(repository.metadata().schema_version, SCHEMA_VERSION);
  assert.equal(repository.db.prepare("SELECT value FROM meta WHERE key = 'replica_scope_key'").get().value, replicaKey);
  assert.equal(repository.db.prepare("SELECT value FROM meta WHERE key = 'scope_key'").get(), undefined);
  assert.equal(repository.listMemories()[0].content, "Preserved schema seven scoped memory");
  assert.equal(repository.hasOwnerScopeKey(), false);
  repository.close();
});

test("a client may delete only memory it sourced", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const first = pair(repository, "First");
  const second = pair(repository, "Second");
  repository.propose(proposal(first));
  const memoryId = repository.listMemories()[0].memory_id;
  assert.deepEqual(repository.deleteMemory(memoryId, {
    owner: false,
    clientId: second.client_id,
    clientSecret: second.client_secret,
  }), { status: "refused", reason: "not_source_client" });
  assert.equal(repository.deleteMemory(memoryId, {
    owner: false,
    clientId: first.client_id,
    clientSecret: first.client_secret,
  }).status, "deleted");
  repository.close();
});
