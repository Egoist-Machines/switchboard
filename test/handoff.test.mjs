import assert from "node:assert/strict";
import { createHash, createHmac, scryptSync } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { SCHEMA_VERSION } from "../src/constants.js";
import { LocalRepository } from "../src/repository.js";
import { temporaryHome } from "./helpers.mjs";

function scope(value) {
  return createHash("sha256").update(`ai-passport-project-scope\0${value}`).digest("hex");
}

function event(overrides) {
  return {
    format_version: 1,
    event_id: "event-default",
    entity_id: "entity-default",
    owner_id: "owner-handoff",
    replica_id: "replica-default",
    replica_seq: 1,
    entity_version: 1,
    op: "handoff_expired",
    actor: "owner",
    client_id: null,
    occurred_at: "2026-08-24T12:00:00.000Z",
    save_id: null,
    payload: {},
    ...overrides,
  };
}

function writeV5FixtureStore(home) {
  mkdirSync(home, { recursive: true });
  const db = new Database(path.join(home, "passport.db"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      entity_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      replica_id TEXT NOT NULL,
      replica_seq INTEGER NOT NULL CHECK (replica_seq > 0),
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      op TEXT NOT NULL CHECK (op IN (
        'proposal_created', 'proposal_approved', 'proposal_rejected', 'memory_deleted',
        'grant_created', 'grant_revoked', 'client_paired', 'client_revoked',
        'profile_defined', 'profile_versioned', 'handoff_created',
        'handoff_claimed', 'handoff_expired'
      )),
      actor TEXT NOT NULL CHECK (actor IN ('owner', 'client')),
      client_id TEXT,
      occurred_at TEXT NOT NULL,
      save_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX events_replica_sequence ON events(replica_id, replica_seq);
    CREATE INDEX events_entity_version ON events(entity_id, entity_version);
    CREATE INDEX events_save_id ON events(save_id, op, event_id);
    CREATE INDEX events_client ON events(client_id, op, entity_id);
    CREATE TRIGGER events_forbid_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER events_forbid_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TABLE clients (
      client_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_salt TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE profiles (
      name TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      categories TEXT NOT NULL,
      project_scopes TEXT NOT NULL,
      defined_at TEXT NOT NULL,
      PRIMARY KEY (name, version)
    );
    CREATE TABLE grants (
      grant_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(client_id),
      profile_name TEXT,
      profile_version INTEGER,
      categories TEXT NOT NULL,
      project_scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE proposals (
      proposal_id TEXT PRIMARY KEY,
      save_id TEXT NOT NULL UNIQUE,
      memory_id TEXT UNIQUE,
      category TEXT NOT NULL CHECK (category IN (
        'preference', 'fact', 'project', 'relationship', 'instruction', 'event', 'purchase', 'other'
      )),
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      source TEXT NOT NULL,
      client_id TEXT,
      evidence_basis TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      disposition TEXT NOT NULL
    );
    CREATE TABLE memories (
      memory_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(proposal_id),
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      source TEXT NOT NULL,
      client_id TEXT,
      category TEXT NOT NULL CHECK (category IN (
        'preference', 'fact', 'project', 'relationship', 'instruction', 'event', 'purchase', 'claim', 'other'
      )),
      evidence_basis TEXT NOT NULL,
      created_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE decisions (
      decision_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
      decision TEXT NOT NULL,
      via TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE TABLE content_records (
      source_event_id TEXT NOT NULL UNIQUE,
      entity_id TEXT NOT NULL,
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, content_version)
    );
    CREATE TABLE receipts (
      receipt_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      categories TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE handoffs (
      handoff_id TEXT PRIMARY KEY,
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      created_by_client_id TEXT,
      to_client_id TEXT,
      profile TEXT,
      project_scope TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'expired')),
      terminal_event_id TEXT,
      CHECK (
        (to_client_id IS NOT NULL AND profile IS NULL AND project_scope IS NULL) OR
        (to_client_id IS NULL AND profile = 'coding')
      ),
      CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*')),
      CHECK ((status = 'pending' AND terminal_event_id IS NULL) OR (status <> 'pending' AND terminal_event_id IS NOT NULL))
    );
    CREATE INDEX handoffs_pending_expiry ON handoffs(status, expires_at, handoff_id);
    CREATE INDEX handoffs_target ON handoffs(status, to_client_id, profile, handoff_id);
    CREATE TABLE handoff_receipts (
      receipt_id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      client_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('claimed', 'expired')),
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE deletion_fences (entity_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE tombstones (
      entity_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE sync_cursors (
      replica_id TEXT PRIMARY KEY,
      replica_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE event_applications (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      applied_at TEXT NOT NULL
    );
    CREATE TABLE event_versions (
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL,
      op TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      PRIMARY KEY (entity_id, entity_version, op)
    );
    CREATE TABLE event_supersessions (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      winner_event_id TEXT NOT NULL REFERENCES events(event_id),
      reason TEXT NOT NULL CHECK (reason IN (
        'version_collision', 'profile_version_conflict', 'save_id_duplicate',
        'entity_conflict', 'proposal_conflict', 'terminal_conflict',
        'rejection_dominates', 'duplicate_deletion'
      ))
    );
    CREATE TABLE pending_events (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      dependency_entity_id TEXT NOT NULL
    );
    CREATE INDEX pending_events_dependency ON pending_events(dependency_entity_id, event_id);
    CREATE TABLE event_profile_keys (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      profile_key TEXT NOT NULL
    );
    CREATE INDEX event_profile_keys_key ON event_profile_keys(profile_key, event_id);
    CREATE TABLE event_memory_links (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      memory_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL
    );
    CREATE INDEX event_memory_links_memory ON event_memory_links(memory_id, proposal_id);
    CREATE TABLE content_candidates (
      source_event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      content_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX content_candidates_entity ON content_candidates(entity_id, source_event_id);
    CREATE TABLE content_supersessions (
      source_event_id TEXT PRIMARY KEY,
      winner_event_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN (
        'event_superseded', 'proposal_rejected', 'memory_deleted'
      ))
    );
  `);

  const ownerId = "owner-v5-fixture";
  const replicaId = "replica-v5-fixture";
  const clientId = "client-v5-fixture";
  const clientSecret = "v5-fixture-client-secret";
  const salt = "1".repeat(32);
  const secretHash = scryptSync(clientSecret, salt, 32).toString("hex");
  const createdAt = "2026-08-24T10:00:00.000Z";
  const expiresAt = "2026-08-25T10:00:00.000Z";
  const scopedSnapshot = "LEGACY_SCOPED_V5_CONTENT";
  const unscopedSnapshot = "UNSCOPED_V5_CONTENT";
  const legacyScope = scope("/private/v5-project");
  const events = [
    event({
      event_id: "v5-client-paired", entity_id: clientId, owner_id: ownerId, replica_id: replicaId,
      op: "client_paired", occurred_at: createdAt,
      payload: { host: "codex", label: "v5 fixture", secret_salt: salt, secret_hash: secretHash },
    }),
    event({
      event_id: "v5-coding-grant", entity_id: "v5-grant", owner_id: ownerId, replica_id: replicaId,
      replica_seq: 2, op: "grant_created", client_id: clientId, occurred_at: createdAt,
      payload: {
        profile: "coding", profile_version: 1,
        categories: ["preference", "fact", "project", "instruction"], project_scopes: [],
      },
    }),
    event({
      event_id: "v5-scoped-created", entity_id: "v5-scoped-handoff", owner_id: ownerId, replica_id: replicaId,
      replica_seq: 3, op: "handoff_created", occurred_at: createdAt,
      payload: {
        content_ref: { entity_id: "v5-scoped-handoff", content_version: 1 },
        expires_at: expiresAt, profile: "coding", project_scope: legacyScope, to_client_id: null,
      },
    }),
    event({
      event_id: "v5-unscoped-created", entity_id: "v5-unscoped-handoff", owner_id: ownerId, replica_id: replicaId,
      replica_seq: 4, op: "handoff_created", occurred_at: createdAt,
      payload: {
        content_ref: { entity_id: "v5-unscoped-handoff", content_version: 1 },
        expires_at: expiresAt, profile: "coding", project_scope: null, to_client_id: null,
      },
    }),
  ];
  const insertEvent = db.prepare(`
    INSERT INTO events(event_id, format_version, entity_id, owner_id, replica_id, replica_seq,
      entity_version, op, actor, client_id, occurred_at, save_id, payload)
    VALUES (@event_id, @format_version, @entity_id, @owner_id, @replica_id, @replica_seq,
      @entity_version, @op, @actor, @client_id, @occurred_at, @save_id, @payload)
  `);
  db.transaction(() => {
    for (const [key, value] of Object.entries({
      schema_version: "5", owner_id: ownerId, replica_id: replicaId, replica_seq: "4", auto_approve: "on",
    })) db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(key, value);
    for (const item of events) insertEvent.run({ ...item, payload: JSON.stringify(item.payload) });
    db.prepare(`
      INSERT INTO clients(client_id, host, label, secret_salt, secret_hash, paired_at, revoked_at)
      VALUES (?, 'codex', 'v5 fixture', ?, ?, ?, NULL)
    `).run(clientId, salt, secretHash, createdAt);
    db.prepare(`
      INSERT INTO grants(grant_id, client_id, profile_name, profile_version, categories,
        project_scopes, created_at, revoked_at)
      VALUES ('v5-grant', ?, 'coding', 1, ?, '[]', ?, NULL)
    `).run(clientId, JSON.stringify(["preference", "fact", "project", "instruction"]), createdAt);
    const insertHandoff = db.prepare(`
      INSERT INTO handoffs(handoff_id, content_version, created_by_client_id, to_client_id, profile,
        project_scope, created_at, expires_at, status, terminal_event_id)
      VALUES (?, 1, NULL, NULL, 'coding', ?, ?, ?, 'pending', NULL)
    `);
    insertHandoff.run("v5-scoped-handoff", legacyScope, createdAt, expiresAt);
    insertHandoff.run("v5-unscoped-handoff", null, createdAt, expiresAt);
    const insertContent = db.prepare(`
      INSERT INTO content_candidates(source_event_id, entity_id, content_version, content_hash, owner_id, content, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `);
    const insertProjectedContent = db.prepare(`
      INSERT INTO content_records(source_event_id, entity_id, content_version, owner_id, content, created_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `);
    for (const [sourceEventId, entityId, content] of [
      ["v5-scoped-created", "v5-scoped-handoff", scopedSnapshot],
      ["v5-unscoped-created", "v5-unscoped-handoff", unscopedSnapshot],
    ]) {
      insertContent.run(sourceEventId, entityId, createHash("sha256").update(content).digest("hex"), ownerId, content, createdAt);
      insertProjectedContent.run(sourceEventId, entityId, ownerId, content, createdAt);
    }
    const apply = db.prepare("INSERT INTO event_applications(event_id, applied_at) VALUES (?, ?)");
    const version = db.prepare(`
      INSERT INTO event_versions(entity_id, entity_version, op, event_id) VALUES (?, 1, ?, ?)
    `);
    for (const item of events) {
      apply.run(item.event_id, item.occurred_at);
      version.run(item.entity_id, item.op, item.event_id);
    }
  })();
  db.close();
  return { clientId, clientSecret, legacyScope, scopedSnapshot, unscopedSnapshot };
}

test("handoffs claim once, erase content, write content-free receipts, and never enter recall", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), now: () => new Date("2026-08-24T12:00:00.000Z") });
  const claude = repository.addClient({ host: "claude-code", label: "Claude Code" });
  const opencode = repository.addClient({ host: "opencode", label: "OpenCode" });
  repository.addGrant({ clientId: opencode.client_id, profile: "coding" });
  const sentinel = "HANDOFF_ONLY_TASK_PLAN_CONSTRAINTS";
  const created = repository.createHandoff({
    client_id: claude.client_id,
    client_secret: claude.client_secret,
    snapshot: sentinel,
    profile: "coding",
    project: "/private/project-name",
  });

  assert.equal(created.status, "created");
  assert.equal(repository.listMemories().length, 0);
  assert.equal(repository.prefetch({
    client_id: opencode.client_id,
    client_secret: opencode.client_secret,
    categories: ["project"],
  }).status, "empty");
  assert.equal(JSON.stringify(repository.events()).includes(sentinel), false);
  assert.equal(JSON.stringify(repository.listHandoffs()).includes("project-name"), false);
  assert.throws(() => repository.createHandoff({
    snapshot: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    to_client_id: opencode.client_id,
  }, { owner: true }), /snapshot was refused/);
  assert.equal(repository.events().filter((event) => event.op === "handoff_created").length, 1);

  const claimed = repository.claimHandoff({
    client_id: opencode.client_id,
    client_secret: opencode.client_secret,
    project: "/private/project-name",
  });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.snapshot, sentinel);
  assert.deepEqual(repository.claimHandoff({
    client_id: opencode.client_id,
    client_secret: opencode.client_secret,
    project: "/private/project-name",
  }), { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null });
  assert.equal(repository.contentRecords().length, 0);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM content_candidates").get().count, 0);
  assert.equal(repository.db.prepare("SELECT 1 FROM deletion_fences WHERE entity_id = ?").get(created.handoff_id) != null, true);
  assert.equal(repository.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(created.handoff_id) != null, true);
  const receipts = repository.handoffReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].action, "claimed");
  assert.equal(JSON.stringify(receipts).includes(sentinel), false);
  assert.equal(JSON.stringify(receipts).includes("project-name"), false);
  repository.close();
});

test("expiry uses the deletion fence and produces an erased outcome", (t) => {
  let now = new Date("2026-08-24T12:00:00.000Z");
  const repository = new LocalRepository({ home: temporaryHome(t), now: () => now });
  const client = repository.addClient({ host: "codex", label: "Codex" });
  const created = repository.createHandoff({
    snapshot: "Short-lived task state",
    to_client_id: client.client_id,
    expires_at: "2026-08-24T12:01:00.000Z",
  }, { owner: true });
  now = new Date("2026-08-24T12:02:00.000Z");
  assert.deepEqual(repository.claimHandoff({
    client_id: client.client_id,
    client_secret: client.client_secret,
  }), {
    status: "expired",
    handoff_id: created.handoff_id,
    snapshot: null,
    expires_at: "2026-08-24T12:01:00.000Z",
  });
  assert.equal(repository.contentRecords().length, 0);
  assert.equal(repository.handoffReceipts()[0].action, "expired");
  repository.close();
});

test("exact addressing, coding-profile scope, and client revocation fail closed", (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const exact = repository.addClient({ host: "opencode", label: "Exact" });
  const other = repository.addClient({ host: "codex", label: "Other" });
  repository.addGrant({ clientId: other.client_id, profile: "coding" });
  repository.createHandoff({ snapshot: "Exact only", to_client_id: exact.client_id }, { owner: true });
  assert.equal(repository.claimHandoff({ client_id: other.client_id, client_secret: other.client_secret }).status, "none_pending");
  assert.equal(repository.claimHandoff({ client_id: exact.client_id, client_secret: exact.client_secret }).status, "claimed");

  repository.createHandoff({ snapshot: "Scoped profile", profile: "coding", project: "scope-a" }, { owner: true });
  assert.equal(repository.claimHandoff({
    client_id: other.client_id, client_secret: other.client_secret, project: "scope-b",
  }).status, "none_pending");
  assert.equal(repository.revokeClient(other.client_id), true);
  assert.equal(repository.claimHandoff({
    client_id: other.client_id, client_secret: other.client_secret, project: "scope-a",
  }).status, "none_pending");
  repository.close();
});

test("handoff replay converges across orderings and smallest claim event id wins", (t) => {
  const projectScope = scope("shared-project");
  const pairPayload = (label) => ({
    host: "opencode", label, secret_salt: "0".repeat(32), secret_hash: "1".repeat(64),
  });
  const grantPayload = {
    profile: "coding", profile_version: 1,
    categories: ["preference", "fact", "project", "instruction"], project_scopes: [],
  };
  const events = [
    event({ event_id: "pair-a", entity_id: "client-a", op: "client_paired", payload: pairPayload("Client A") }),
    event({ event_id: "pair-b", entity_id: "client-b", replica_id: "replica-b", op: "client_paired", payload: pairPayload("Client B") }),
    event({ event_id: "grant-a", entity_id: "grant-a", replica_seq: 2, op: "grant_created", client_id: "client-a", payload: grantPayload }),
    event({ event_id: "grant-b", entity_id: "grant-b", replica_id: "replica-b", replica_seq: 2, op: "grant_created", client_id: "client-b", payload: grantPayload }),
    event({
      event_id: "handoff-create", entity_id: "handoff-shared", replica_seq: 3, op: "handoff_created",
      actor: "client", client_id: "client-a",
      payload: {
        content_ref: { entity_id: "handoff-shared", content_version: 1 },
        expires_at: "2026-08-25T12:00:00.000Z", profile: "coding", project_scope: projectScope, to_client_id: null,
      },
    }),
    event({
      event_id: "claim-b", entity_id: "handoff-shared", replica_id: "replica-b", replica_seq: 3,
      entity_version: 2, op: "handoff_claimed", actor: "client", client_id: "client-b",
      occurred_at: "2026-08-24T12:05:00.000Z", payload: { project_scope: projectScope },
    }),
    event({
      event_id: "claim-a", entity_id: "handoff-shared", replica_seq: 4, entity_version: 2,
      op: "handoff_claimed", actor: "client", client_id: "client-a",
      occurred_at: "2026-08-24T12:05:00.000Z", payload: { project_scope: projectScope },
    }),
  ];
  const content = {
    event_id: "handoff-create", entity_id: "handoff-shared", content_version: 1,
    owner_id: "owner-handoff", content: "Convergent handoff snapshot", created_at: "2026-08-24T12:00:00.000Z",
  };
  const orders = [events, [...events].reverse(), [events[4], events[6], events[2], events[0], events[5], events[3], events[1]]];
  const snapshots = [];
  for (const order of orders) {
    const repository = new LocalRepository({
      home: temporaryHome(t), ownerId: "owner-handoff", initializeDefaults: false,
      now: () => new Date("2026-08-24T13:00:00.000Z"),
    });
    repository.ingestContentRecord(content);
    for (const item of order) repository.ingestEvent(item);
    assert.equal(repository.contentRecords().length, 0);
    assert.equal(repository.listHandoffs().length, 0);
    assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = 'handoff-shared'").get().status, "claimed");
    assert.equal(repository.handoffReceipts()[0].client_id, "client-a");
    assert.deepEqual(repository.db.prepare(`
      SELECT winner_event_id, reason FROM event_supersessions WHERE event_id = 'claim-b'
    `).get(), { winner_event_id: "claim-a", reason: "version_collision" });
    snapshots.push({
      handoffs: repository.db.prepare("SELECT * FROM handoffs").all(),
      receipts: repository.handoffReceipts(),
      fences: repository.db.prepare("SELECT * FROM deletion_fences").all(),
      tombstones: repository.db.prepare("SELECT * FROM tombstones").all(),
    });
    repository.close();
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
});

test("schema v4 stores migrate through every ordered version instead of bricking", (t) => {
  const home = temporaryHome(t);
  let repository = new LocalRepository({ home });
  repository.propose({ save_id: "before-migration", category: "fact", content: "Preserved content" }, { owner: true });
  repository.db.exec("DROP TABLE handoff_receipts; DROP TABLE handoffs;");
  repository.db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  repository.close();

  repository = new LocalRepository({ home });
  assert.equal(repository.metadata().schema_version, SCHEMA_VERSION);
  assert.equal(repository.listMemories()[0].content, "Preserved content");
  const sql = repository.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get().sql;
  assert.match(sql, /handoff_created/);
  assert.deepEqual(repository.db.pragma("foreign_key_check"), []);
  repository.close();
});

test("later grant and client revocations never reopen terminal hand-off custody", (t) => {
  for (const revocation of ["grant", "client"]) {
    let nowMs = Date.parse("2026-08-24T12:00:00.000Z");
    const source = new LocalRepository({
      home: temporaryHome(t),
      now: () => new Date(nowMs),
      ownerId: `owner-terminal-${revocation}`,
    });
    const claimant = source.addClient({ host: "opencode", label: "Original claimant" });
    nowMs += 1_000;
    const later = source.addClient({ host: "codex", label: "Later claimant" });
    nowMs += 1_000;
    const claimantGrant = source.addGrant({ clientId: claimant.client_id, profile: "coding" });
    source.addGrant({ clientId: later.client_id, profile: "coding" });
    nowMs += 1_000;
    const created = source.createHandoff({
      snapshot: "Terminal custody survives later policy changes",
      profile: "coding",
      project: "/private/terminal-project",
      expires_at: "2026-08-25T12:00:00.000Z",
    }, { owner: true });
    const content = source.contentRecords()[0];
    nowMs += 1_000;
    const claimed = source.claimHandoff({
      client_id: claimant.client_id,
      client_secret: claimant.client_secret,
      project: "/private/terminal-project",
    });
    const terminalEventId = source.handoffReceipts()[0].event_id;
    nowMs += 1_000;
    if (revocation === "grant") source.revokeGrant(claimantGrant.grant_id);
    else source.revokeClient(claimant.client_id);

    assert.equal(source.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(created.handoff_id).status, "claimed");
    assert.equal(source.handoffReceipts()[0].event_id, terminalEventId);
    const events = source.events();
    source.close();

    const policyEvents = events.filter((item) => item.op === "grant_revoked" || item.op === "client_revoked");
    const orders = [events, [...events].reverse(), [...policyEvents, ...events.filter((item) => !policyEvents.includes(item))]];
    for (const order of orders) {
      const replay = new LocalRepository({
        home: temporaryHome(t), ownerId: `owner-terminal-${revocation}`, initializeDefaults: false,
        now: () => new Date("2026-08-24T13:00:00.000Z"),
      });
      for (const item of order) replay.ingestEvent(item);
      assert.equal(replay.ingestContentRecord(content), false, "late content stays behind the terminal fence");
      assert.deepEqual(replay.claimHandoff({
        client_id: later.client_id,
        client_secret: later.client_secret,
        project: "/private/terminal-project",
      }), { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null });
      assert.deepEqual(replay.db.prepare(`
        SELECT status, terminal_event_id FROM handoffs WHERE handoff_id = ?
      `).get(created.handoff_id), { status: claimed.status, terminal_event_id: terminalEventId });
      assert.equal(replay.db.prepare("SELECT event_id FROM tombstones WHERE entity_id = ?").get(created.handoff_id).event_id, terminalEventId);
      assert.equal(replay.db.prepare("SELECT 1 FROM deletion_fences WHERE entity_id = ?").get(created.handoff_id) != null, true);
      assert.equal(replay.handoffReceipts()[0].event_id, terminalEventId);
      assert.equal(replay.contentRecords().length, 0);
      replay.close();
    }
  }
});

test("expiry sweeps on unrelated, revoked, reopen, status, and offset-bearing access", (t) => {
  let now = new Date("2026-08-24T11:00:00.000Z");
  const home = temporaryHome(t);
  let repository = new LocalRepository({ home, now: () => now, ownerId: "owner-expiry-access" });
  const target = repository.addClient({ host: "codex", label: "Revoked exact target" });
  const unrelated = repository.addClient({ host: "opencode", label: "Unrelated target" });
  const bystander = repository.addClient({ host: "claude-code", label: "Unrelated claimant" });
  const revoked = repository.createHandoff({
    snapshot: "Erase for a revoked exact target", to_client_id: target.client_id,
    expires_at: "2026-08-24T11:30:00.000Z",
  }, { owner: true });
  repository.revokeClient(target.client_id);
  now = new Date("2026-08-24T12:00:00.000Z");
  assert.equal(repository.claimHandoff({
    client_id: target.client_id, client_secret: target.client_secret,
  }).status, "none_pending");
  assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(revoked.handoff_id).status, "expired");

  const unrelatedExpired = repository.createHandoff({
    snapshot: "An unrelated attempt must still sweep this", to_client_id: unrelated.client_id,
    expires_at: "2026-08-24T12:30:00.000Z",
  }, { owner: true });
  now = new Date("2026-08-24T13:00:00.000Z");
  assert.equal(repository.claimHandoff({
    client_id: bystander.client_id, client_secret: bystander.client_secret,
  }).status, "none_pending");
  assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(unrelatedExpired.handoff_id).status, "expired");

  const reopenExpired = repository.createHandoff({
    snapshot: "Reopen must sweep this", to_client_id: unrelated.client_id,
    expires_at: "2026-08-24T13:30:00.000Z",
  }, { owner: true });
  repository.close();
  now = new Date("2026-08-24T14:00:00.000Z");
  repository = new LocalRepository({ home, now: () => now });
  repository.status();
  assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(reopenExpired.handoff_id).status, "expired");
  repository.close();

  const offsetRepository = new LocalRepository({
    home: temporaryHome(t), ownerId: "owner-handoff", initializeDefaults: false,
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  offsetRepository.ingestEvent(event({
    event_id: "offset-create", entity_id: "offset-handoff", op: "handoff_created",
    occurred_at: "2026-08-24T10:00:00.000Z",
    payload: {
      content_ref: { entity_id: "offset-handoff", content_version: 1 },
      expires_at: "2026-08-24T20:59:00+09:00", profile: null,
      project_scope: null, to_client_id: "offset-client",
    },
  }));
  offsetRepository.status();
  assert.equal(offsetRepository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = 'offset-handoff'").get().status, "expired");
  offsetRepository.close();
});

test("status shares one indexed expiry sweep across nested client and grant reads", (t) => {
  let sweepCount = 0;
  const repository = new LocalRepository({
    home: temporaryHome(t),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    expirySweepObserver: () => { sweepCount += 1; },
  });
  const clients = Array.from({ length: 8 }, (_, index) =>
    repository.addClient({ host: "codex", label: `Status client ${index}` }));
  for (let index = 0; index < 120; index += 1) {
    repository.createHandoff({
      snapshot: `Pending status hand-off ${index}`,
      to_client_id: clients[0].client_id,
      expires_at: "2026-08-25T12:00:00.000Z",
    }, { owner: true });
  }

  sweepCount = 0;
  const status = repository.status();
  assert.equal(status.clients.length, clients.length);
  assert.equal(sweepCount, 1);
  const expiryPlan = repository.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM handoffs
    WHERE status = 'pending' AND expires_at <= ?
    ORDER BY expires_at, handoff_id
  `).all("2026-08-24T12:00:00.000Z");
  assert.match(expiryPlan.map((row) => row.detail).join("\n"), /handoffs_pending_expiry/);
  repository.close();
});

test("pre-creation claims and premature expiry events never become terminal in any arrival order", (t) => {
  const projectScope = "7".repeat(64);
  const lifecycleEvents = [
    event({
      event_id: "lifecycle-pair", entity_id: "lifecycle-client", op: "client_paired",
      occurred_at: "2026-08-24T10:00:00.000Z",
      payload: { host: "opencode", label: "Lifecycle", secret_salt: "0".repeat(32), secret_hash: "1".repeat(64) },
    }),
    event({
      event_id: "lifecycle-grant", entity_id: "lifecycle-grant", replica_seq: 2, op: "grant_created",
      client_id: "lifecycle-client", occurred_at: "2026-08-24T10:30:00.000Z",
      payload: { profile: "coding", profile_version: 1, categories: ["project"], project_scopes: [] },
    }),
    event({
      event_id: "lifecycle-create", entity_id: "lifecycle-handoff", replica_seq: 3, op: "handoff_created",
      occurred_at: "2026-08-24T12:00:00.000Z",
      payload: {
        content_ref: { entity_id: "lifecycle-handoff", content_version: 1 },
        expires_at: "2026-08-24T13:00:00.000Z", profile: "coding",
        project_scope: projectScope, to_client_id: null,
      },
    }),
    event({
      event_id: "lifecycle-early-claim", entity_id: "lifecycle-handoff", replica_seq: 4,
      entity_version: 2, op: "handoff_claimed", actor: "client", client_id: "lifecycle-client",
      occurred_at: "2026-08-24T11:59:00.000Z", payload: { project_scope: projectScope },
    }),
    event({
      event_id: "lifecycle-early-expiry", entity_id: "lifecycle-handoff", replica_seq: 5,
      entity_version: 3, op: "handoff_expired", occurred_at: "2026-08-24T12:30:00.000Z",
    }),
  ];
  const content = {
    event_id: "lifecycle-create", entity_id: "lifecycle-handoff", content_version: 1,
    owner_id: "owner-handoff", content: "Lifecycle content must remain pending",
    created_at: "2026-08-24T12:00:00.000Z",
  };
  const actions = [...lifecycleEvents.map((value) => ({ kind: "event", value })), { kind: "content", value: content }];
  const orders = [actions, [...actions].reverse(), [actions[3], actions[4], actions[5], ...actions.slice(0, 3)]];
  for (const order of orders) {
    const repository = new LocalRepository({
      home: temporaryHome(t), ownerId: "owner-handoff", initializeDefaults: false,
      now: () => new Date("2026-08-24T12:45:00.000Z"),
    });
    for (const action of order) {
      if (action.kind === "event") repository.ingestEvent(action.value);
      else repository.ingestContentRecord(action.value);
    }
    assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = 'lifecycle-handoff'").get().status, "pending");
    assert.equal(repository.contentRecords()[0].content, content.content);
    assert.equal(repository.handoffReceipts().length, 0);
    assert.equal(repository.db.prepare("SELECT 1 FROM deletion_fences WHERE entity_id = 'lifecycle-handoff'").get(), undefined);
    assert.equal(repository.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = 'lifecycle-handoff'").get(), undefined);
    for (const eventId of ["lifecycle-early-claim", "lifecycle-early-expiry"]) {
      assert.equal(repository.db.prepare("SELECT reason FROM event_supersessions WHERE event_id = ?").get(eventId).reason, "entity_conflict");
    }
    repository.close();
  }
});

test("project scopes use a private owner HMAC key", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const knownPath = "/private/known/project";
  repository.createHandoff({ snapshot: "Keyed scope", profile: "coding", project: knownPath }, { owner: true });
  const storedScope = repository.events().find((item) => item.op === "handoff_created").payload.project_scope;
  const publicDigest = createHash("sha256").update(`ai-passport-project-scope\0${knownPath}`).digest("hex");
  const scopeKey = repository.db.prepare("SELECT value FROM meta WHERE key = 'replica_scope_key'").get().value;
  assert.notEqual(storedScope, publicDigest);
  assert.equal(createHmac("sha256", Buffer.from(scopeKey, "hex"))
    .update(knownPath).digest("hex"), storedScope);
  assert.equal(JSON.stringify(repository.metadata()).includes(scopeKey), false);
  assert.equal(JSON.stringify(repository.events()).includes(scopeKey), false);
  assert.equal(JSON.stringify(repository.handoffReceipts()).includes(scopeKey), false);
  assert.equal(statSync(path.join(home, "passport.db")).mode & 0o777, 0o600);
  repository.close();
});

test("v5 migration expires legacy scoped hand-offs and preserves unscoped claims", (t) => {
  const home = temporaryHome(t);
  const fixture = writeV5FixtureStore(home);
  const repository = new LocalRepository({
    home,
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });

  assert.match(repository.db.prepare("SELECT value FROM meta WHERE key = 'replica_scope_key'").get().value, /^[a-f0-9]{64}$/);
  assert.equal(repository.db.prepare("SELECT value FROM meta WHERE key = 'project_scope_format'").get().value, "hmac-sha256-v1");
  assert.equal(repository.metadata().schema_version, SCHEMA_VERSION);
  assert.equal(repository.events().find((item) => item.event_id === "v5-scoped-created").payload.project_scope, fixture.legacyScope);
  assert.deepEqual(repository.db.prepare(`
    SELECT status, terminal_event_id FROM handoffs WHERE handoff_id = 'v5-scoped-handoff'
  `).get(), {
    status: "expired",
    terminal_event_id: repository.handoffReceipts().find((receipt) => receipt.handoff_id === "v5-scoped-handoff").event_id,
  });
  assert.deepEqual(repository.handoffReceipts().filter((receipt) => receipt.handoff_id === "v5-scoped-handoff")
    .map((receipt) => receipt.action), ["expired"]);
  assert.equal(repository.db.prepare("SELECT 1 FROM deletion_fences WHERE entity_id = 'v5-scoped-handoff'").get() != null, true);
  assert.equal(repository.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = 'v5-scoped-handoff'").get() != null, true);
  assert.equal(repository.db.prepare(`
    SELECT COUNT(*) AS count FROM content_records WHERE entity_id = 'v5-scoped-handoff'
  `).get().count, 0);
  assert.equal(repository.db.prepare(`
    SELECT COUNT(*) AS count FROM content_candidates WHERE entity_id = 'v5-scoped-handoff'
  `).get().count, 0);
  assert.equal(JSON.stringify(repository.handoffReceipts()).includes(fixture.scopedSnapshot), false);

  assert.deepEqual(repository.db.prepare(`
    SELECT status, project_scope FROM handoffs WHERE handoff_id = 'v5-unscoped-handoff'
  `).get(), { status: "pending", project_scope: null });
  const claimed = repository.claimHandoff({
    client_id: fixture.clientId,
    client_secret: fixture.clientSecret,
  });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.handoff_id, "v5-unscoped-handoff");
  assert.equal(claimed.snapshot, fixture.unscopedSnapshot);
  assert.deepEqual(repository.claimHandoff({
    client_id: fixture.clientId,
    client_secret: fixture.clientSecret,
  }), { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null });
  assert.equal(repository.db.prepare(`
    SELECT COUNT(*) AS count FROM content_records WHERE entity_id = 'v5-unscoped-handoff'
  `).get().count, 0);
  repository.close();
});

test("grant mutations reconcile only exact unresolved hand-off dependencies", (t) => {
  const attempts = [];
  let nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const repository = new LocalRepository({
    home: temporaryHome(t), ownerId: "owner-handoff", now: () => new Date(nowMs),
    reconciliationObserver: ({ entity_id: entityId }) => attempts.push(entityId),
  });
  const exact = repository.addClient({ host: "codex", label: "Terminal exact" });
  const unresolved = repository.addClient({ host: "opencode", label: "Unresolved profile" });
  for (let index = 0; index < 30; index += 1) {
    const created = repository.createHandoff({ snapshot: `Terminal ${index}`, to_client_id: exact.client_id }, { owner: true });
    assert.equal(repository.claimHandoff({ client_id: exact.client_id, client_secret: exact.client_secret }).status, "claimed");
    assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(created.handoff_id).status, "claimed");
  }
  const unresolvedScope = "8".repeat(64);
  repository.ingestEvent(event({
    event_id: "unresolved-create", entity_id: "unresolved-handoff", replica_id: "unresolved-replica",
    replica_seq: 1, op: "handoff_created", occurred_at: "2026-08-24T12:10:00.000Z",
    payload: {
      content_ref: { entity_id: "unresolved-handoff", content_version: 1 },
      expires_at: "2026-08-25T12:00:00.000Z", profile: "coding",
      project_scope: unresolvedScope, to_client_id: null,
    },
  }));
  repository.ingestEvent(event({
    event_id: "unresolved-claim", entity_id: "unresolved-handoff", replica_id: "unresolved-replica",
    replica_seq: 2, entity_version: 2, op: "handoff_claimed", actor: "client",
    client_id: unresolved.client_id, occurred_at: "2026-08-24T12:20:00.000Z",
    payload: { project_scope: unresolvedScope },
  }));
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM handoff_claim_dependencies").get().count, 1);
  attempts.length = 0;
  repository.ingestEvent(event({
    event_id: "unresolved-grant", entity_id: "unresolved-grant", replica_id: "policy-replica",
    replica_seq: 1, op: "grant_created", client_id: unresolved.client_id,
    occurred_at: "2026-08-24T12:15:00.000Z",
    payload: { profile: "coding", profile_version: 1, categories: ["project"], project_scopes: [] },
  }));
  assert.equal(repository.db.prepare("SELECT status FROM handoffs WHERE handoff_id = 'unresolved-handoff'").get().status, "claimed");
  assert.equal(attempts.some((entityId) => entityId !== "unresolved-grant" && entityId !== "unresolved-handoff"), false);
  assert.ok(attempts.length <= 4, `expected bounded policy reconciliation, saw ${attempts.length} observer calls`);
  repository.close();
});
