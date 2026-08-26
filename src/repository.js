import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import {
  CODING_PROFILE_CATEGORIES,
  DEFAULT_HANDOFF_TTL_MS,
  EVENT_FORMAT_VERSION,
  MAX_CONTENT_BYTES,
  MAX_READ_CONTENT_CHARS,
  MAX_READ_ROWS,
  MAX_ROW_CONTENT_CHARS,
  MEMORY_CATEGORIES,
  SAVE_ID_PATTERN,
  SCHEMA_VERSION,
  WRITABLE_MEMORY_CATEGORIES,
} from "./constants.js";
import { RecallIndex } from "./recallIndex.js";
import { openStore } from "./storage.js";

const json = (value) => JSON.stringify(value);
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const iso = (value) => (value instanceof Date ? value : new Date(value)).toISOString();
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const instant = (value) => Date.parse(value);
const normalizeScopeInput = (value) => String(value).trim().normalize("NFC");
const eventEffectiveAt = (candidate, boundary) => {
  const candidateTime = instant(candidate.occurred_at);
  const boundaryTime = instant(boundary.occurred_at);
  if (candidateTime !== boundaryTime) return candidateTime < boundaryTime;
  if (candidate.replica_id === boundary.replica_id && candidate.replica_seq !== boundary.replica_seq) {
    return candidate.replica_seq < boundary.replica_seq;
  }
  return compareText(candidate.event_id, boundary.event_id) <= 0;
};

export class HandoffUnavailableError extends Error {
  constructor(message = "hand-off store is unavailable", options = undefined) {
    super(message, options);
    this.name = "HandoffUnavailableError";
  }
}
const EVENT_PAYLOAD_KEYS = Object.freeze({
  client_paired: ["host", "label", "secret_salt", "secret_hash"],
  client_revoked: [],
  grant_created: ["profile", "profile_version", "categories", "project_scopes"],
  grant_revoked: [],
  profile_defined: ["name", "version", "categories", "project_scopes"],
  profile_versioned: ["name", "version", "categories", "project_scopes"],
  proposal_created: ["category", "content_version", "disposition", "evidence_basis", "occurred_at", "project_scope", "source"],
  proposal_approved: ["content_version", "decision_id", "memory_id", "via"],
  proposal_rejected: ["decision_id", "via"],
  memory_deleted: [],
  handoff_created: ["content_ref", "expires_at", "profile", "project_scope", "to_client_id"],
  handoff_claimed: ["project_scope"],
  handoff_expired: [],
});

function existingSchemaVersion(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) {
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
    return hasTables ? "unversioned" : null;
  }
  return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? "missing";
}

export function unsupportedSchemaVersionMessage(version, expectedVersion = SCHEMA_VERSION) {
  return `unsupported Switchboard schema version ${version}; expected ${expectedVersion}`;
}

function assertSchemaCompatible(db) {
  const version = existingSchemaVersion(db);
  if (version !== null && !["4", "5", "6", "7", String(SCHEMA_VERSION)].includes(version)) {
    throw new Error(unsupportedSchemaVersionMessage(version));
  }
  return version;
}

function migrateV4ToV5(db) {
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  const legacyAlterTable = db.pragma("legacy_alter_table", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS events_forbid_update;
        DROP TRIGGER IF EXISTS events_forbid_delete;
        ALTER TABLE events RENAME TO events_v4;
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
        INSERT INTO events SELECT * FROM events_v4;
        DROP TABLE events_v4;
        UPDATE meta SET value = '5' WHERE key = 'schema_version';
      `);
    })();
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlterTable ? "ON" : "OFF"}`);
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
  const violations = db.pragma("foreign_key_check");
  if (violations.length) throw new Error("Switchboard v4 migration failed foreign-key verification");
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_identity_cache (
      cache_key TEXT PRIMARY KEY CHECK (length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*'),
      config_stamp TEXT NOT NULL,
      head_stamp TEXT NOT NULL,
      project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*'))
    );
    CREATE TABLE IF NOT EXISTS proposal_scope_overrides (
      proposal_id TEXT PRIMARY KEY,
      project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*')),
      authority_key TEXT NOT NULL CHECK (length(authority_key) = 64 AND authority_key NOT GLOB '*[^0-9a-f]*'),
      authority_revision TEXT NOT NULL CHECK (
        authority_revision = '0' OR (
          authority_revision NOT GLOB '*[^0-9]*' AND
          substr(authority_revision, 1, 1) <> '0' AND
          length(authority_revision) <= 19
        )
      )
    );
    CREATE TABLE IF NOT EXISTS events (
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
    CREATE UNIQUE INDEX IF NOT EXISTS events_replica_sequence ON events(replica_id, replica_seq);
    CREATE INDEX IF NOT EXISTS events_entity_version ON events(entity_id, entity_version);
    CREATE INDEX IF NOT EXISTS events_save_id ON events(save_id, op, event_id);
    CREATE INDEX IF NOT EXISTS events_client ON events(client_id, op, entity_id);
    CREATE TRIGGER IF NOT EXISTS events_forbid_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_forbid_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_salt TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS profiles (
      name TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      categories TEXT NOT NULL,
      project_scopes TEXT NOT NULL,
      defined_at TEXT NOT NULL,
      PRIMARY KEY (name, version)
    );
    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(client_id),
      profile_name TEXT,
      profile_version INTEGER,
      categories TEXT NOT NULL,
      project_scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS proposals (
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
      disposition TEXT NOT NULL,
      project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*'))
    );
    CREATE TABLE IF NOT EXISTS memories (
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
      deleted_at TEXT,
      project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*'))
    );
    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
      decision TEXT NOT NULL,
      via TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_records (
      source_event_id TEXT NOT NULL UNIQUE,
      entity_id TEXT NOT NULL,
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, content_version)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      categories TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
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
    CREATE INDEX IF NOT EXISTS handoffs_pending_expiry ON handoffs(status, expires_at, handoff_id);
    CREATE INDEX IF NOT EXISTS handoffs_target ON handoffs(status, to_client_id, profile, handoff_id);
    CREATE TABLE IF NOT EXISTS handoff_receipts (
      receipt_id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      client_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('claimed', 'expired')),
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deletion_fences (
      entity_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      entity_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_cursors (
      replica_id TEXT PRIMARY KEY,
      replica_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_applications (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      applied_at TEXT NOT NULL
    );
    -- Version collisions are comparable only within one operation class. Lifecycle
    -- precedence is applied later by the entity reducer.
    CREATE TABLE IF NOT EXISTS event_versions (
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL,
      op TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      PRIMARY KEY (entity_id, entity_version, op)
    );
    CREATE TABLE IF NOT EXISTS event_supersessions (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      winner_event_id TEXT NOT NULL REFERENCES events(event_id),
      reason TEXT NOT NULL CHECK (reason IN (
        'version_collision', 'profile_version_conflict', 'save_id_duplicate',
        'entity_conflict', 'proposal_conflict', 'terminal_conflict',
        'rejection_dominates', 'duplicate_deletion'
      ))
    );
    CREATE TABLE IF NOT EXISTS pending_events (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      dependency_entity_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_events_dependency ON pending_events(dependency_entity_id, event_id);
    CREATE TABLE IF NOT EXISTS handoff_claim_dependencies (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      handoff_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      profile TEXT
    );
    CREATE INDEX IF NOT EXISTS handoff_claim_dependencies_client
      ON handoff_claim_dependencies(client_id, profile, handoff_id);
    CREATE TABLE IF NOT EXISTS event_profile_keys (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      profile_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_profile_keys_key ON event_profile_keys(profile_key, event_id);
    CREATE TABLE IF NOT EXISTS event_memory_links (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      memory_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_memory_links_memory ON event_memory_links(memory_id, proposal_id);
    CREATE TABLE IF NOT EXISTS content_candidates (
      source_event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      content_version INTEGER NOT NULL CHECK (content_version > 0),
      content_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS content_candidates_entity ON content_candidates(entity_id, source_event_id);
    CREATE TABLE IF NOT EXISTS content_supersessions (
      source_event_id TEXT PRIMARY KEY,
      winner_event_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN (
        'event_superseded', 'proposal_rejected', 'memory_deleted'
      ))
    );
  `);
}

// Keep these dependency-free never-store rules in parity with lib/pii.js. Naming the
// source here makes changes to the hosted write-path detector discoverable during review.
function luhnValid(number) {
  let sum = 0;
  let alternate = false;
  for (let index = number.length - 1; index >= 0; index -= 1) {
    let digit = number.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function looksLikeCard(digits) {
  if (digits.length < 12 || digits.length > 19 || /^(\d)\1+$/.test(digits) || !luhnValid(digits)) return false;
  if (/^4/.test(digits)) return [13, 16, 19].includes(digits.length);
  if (/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return digits.length === 16;
  if (/^3[47]/.test(digits)) return digits.length === 15;
  if (/^(?:6011|65|64[4-9])/.test(digits)) return [16, 19].includes(digits.length);
  if (/^35(?:2[89]|[3-8]\d)/.test(digits)) return [16, 17, 18, 19].includes(digits.length);
  if (/^3(?:0[0-5]|[689])/.test(digits)) return [14, 16, 19].includes(digits.length);
  if (/^62/.test(digits)) return [16, 17, 18, 19].includes(digits.length);
  if (/^(?:50|5[6-9]|6[0-9])/.test(digits)) return digits.length >= 12;
  if (/^8[12]/.test(digits)) return [16, 17, 18, 19].includes(digits.length);
  if (/^220[0-4]/.test(digits)) return [16, 17, 18, 19].includes(digits.length);
  return false;
}

const CARD_CANDIDATE_RE = /(?<![\p{L}\p{N}])[0-9](?:[0-9]|[^\p{L}\p{N}])*[0-9](?![\p{L}\p{N}])/gu;
const API_SECRET_RE = /\b(?:sk-[A-Za-z0-9]{32,}|sk-(?:proj|live|test|svcacct)-[A-Za-z0-9_-]{16,}|sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|\b(?:api[_-]?(?:key|secret)|client[_-]?secret|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i;

function hasCardNumber(content) {
  for (const match of String(content).normalize("NFKC").matchAll(CARD_CANDIDATE_RE)) {
    if (looksLikeCard(match[0].replace(/[^0-9]/g, ""))) return true;
  }
  return false;
}

export function screenContent(content) {
  if (typeof content !== "string" || !content.trim()) return "content_required";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return "content_too_large";
  if (/\0/.test(content)) return "binary_content";
  const controls = [...content].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && ![9, 10, 13].includes(code);
  }).length;
  if (controls > Math.max(2, content.length * 0.02)) return "binary_content";
  if (hasCardNumber(content)) return "sensitive_content";
  if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/.test(content)) return "sensitive_content";
  if (API_SECRET_RE.test(content)) return "sensitive_content";
  const opaqueRuns = content.match(/(?<![A-Za-z0-9+/_-])(?:[a-fA-F0-9]{48,}|[A-Za-z0-9+/_-]{64,}={0,2})(?![A-Za-z0-9+/_=-])/g) ?? [];
  if (opaqueRuns.some((value) => {
    const counts = new Map();
    for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
    return [...counts.values()].reduce((entropy, count) => {
      const probability = count / value.length;
      return entropy - probability * Math.log2(probability);
    }, 0) >= 3.5;
  })) return "sensitive_content";
  return null;
}

function hashSecret(secret, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(secret, salt, 32).toString("hex") };
}

function secretMatches(secret, salt, expectedHex) {
  if (typeof secret !== "string" || !secret) return false;
  const actual = scryptSync(secret, salt, 32);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, name) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function eventContentVersion(event) {
  return event.op === "handoff_created" ? event.payload.content_ref?.content_version : event.payload.content_version;
}

export class LocalRepository {
  constructor({
    home,
    now = () => new Date(),
    uuid = randomUUID,
    ownerId = null,
    initializeDefaults = true,
    reconciliationObserver = null,
    expirySweepObserver = null,
    storageOptions = {},
  } = {}) {
    const opened = openStore({ home, ...storageOptions });
    this.db = opened.db;
    this.home = opened.home;
    this.databasePath = opened.databasePath;
    this.payloadCodec = opened.payloadCodec;
    this.now = now;
    this.uuid = uuid;
    this.initialOwnerId = ownerId;
    this.initializeDefaults = initializeDefaults;
    this.reconciliationObserver = reconciliationObserver;
    this.expirySweepObserver = expirySweepObserver;
    this.handoffSweepOperationDepth = 0;
    try {
      const version = assertSchemaCompatible(this.db);
      if (version === "4") migrateV4ToV5(this.db);
      schema(this.db);
      if (version === "4" || version === "5") this.#migrateV5ToV6();
      if (["4", "5", "6"].includes(version)) this.#migrateV6ToV7();
      if (["4", "5", "6", "7"].includes(version)) this.#migrateV7ToV8();
      this.#initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.recallIndex = new RecallIndex({ loadRows: () => this.#approvedRows() });
    this.expireHandoffs();
  }

  #initialize() {
    const initialize = this.db.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)");
      insert.run("schema_version", String(SCHEMA_VERSION));
      insert.run("owner_id", this.initialOwnerId ?? this.uuid());
      insert.run("replica_id", this.uuid());
      insert.run("replica_seq", "0");
      insert.run("auto_approve", "on");
      insert.run("replica_scope_key", randomBytes(32).toString("hex"));
      insert.run("project_scope_format", "hmac-sha256-v1");
      if (this.initializeDefaults && !this.db.prepare("SELECT 1 FROM profiles WHERE name = 'coding' AND version = 1").get()) {
        const timestamp = this.#now();
        this.#appendLocalEvent({
          entityId: "profile:coding",
          op: "profile_defined",
          actor: "owner",
          occurredAt: timestamp,
          payload: { name: "coding", version: 1, categories: CODING_PROFILE_CATEGORIES, project_scopes: [] },
        });
      }
    });
    initialize();
  }

  #now() {
    return iso(this.now());
  }

  #meta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  #setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  #projectScopes(value) {
    if (value == null || normalizeScopeInput(value) === "") return null;
    const parsedLegacyOwnerKeys = parseJson(this.#meta("legacy_owner_scope_keys"), []);
    const legacyOwnerKeys = Array.isArray(parsedLegacyOwnerKeys) ? parsedLegacyOwnerKeys : [];
    const keys = [this.#meta("owner_scope_key"), this.#meta("replica_scope_key"), ...legacyOwnerKeys]
      .filter((key, index, values) => key !== null && values.indexOf(key) === index);
    if (!keys.length || keys.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
      throw new Error("invalid project scope key");
    }
    return keys.map((key) => createHmac("sha256", Buffer.from(key, "hex"))
      .update(normalizeScopeInput(value))
      .digest("hex"));
  }

  #projectScope(value) {
    return this.#projectScopes(value)?.[0] ?? null;
  }

  scopeFingerprint(value) {
    return this.#projectScope(value);
  }

  scopeFingerprints(value) {
    return this.#projectScopes(value) ?? [];
  }

  hasOwnerScopeKey() {
    return /^[a-f0-9]{64}$/.test(this.#meta("owner_scope_key") ?? "");
  }

  deferOwnerScopeKeyAdoption() {
    const existing = this.#meta("owner_scope_key");
    if (!existing) return false;
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error("invalid owner scope key");
    this.db.transaction(() => {
      const parsedLegacy = parseJson(this.#meta("legacy_owner_scope_keys"), []);
      const legacy = (Array.isArray(parsedLegacy) ? parsedLegacy : [])
        .filter((key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key));
      this.#setMeta("legacy_owner_scope_keys", json([...new Set([existing, ...legacy])]));
      this.db.prepare("DELETE FROM meta WHERE key = 'owner_scope_key'").run();
    })();
    return true;
  }

  adoptOwnerScopeKey(ownerScopeKey) {
    if (typeof ownerScopeKey !== "string" || !/^[a-f0-9]{64}$/.test(ownerScopeKey)) {
      throw new Error("invalid owner scope key");
    }
    const existing = this.#meta("owner_scope_key");
    if (existing === ownerScopeKey) return false;
    this.db.transaction(() => {
      const parsedLegacy = parseJson(this.#meta("legacy_owner_scope_keys"), []);
      const legacy = (Array.isArray(parsedLegacy) ? parsedLegacy : [])
        .filter((key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key));
      const nextLegacy = [...new Set([
        ...(existing ? [existing] : []),
        ...legacy,
      ])].filter((key) => key !== ownerScopeKey);
      this.#setMeta("owner_scope_key", ownerScopeKey);
      if (nextLegacy.length) this.#setMeta("legacy_owner_scope_keys", json(nextLegacy));
      else this.db.prepare("DELETE FROM meta WHERE key = 'legacy_owner_scope_keys'").run();
    })();
    return true;
  }

  reconcileProposalScope({ proposalId, projectScope = null, authorityKey, authorityRevision }) {
    if (typeof proposalId !== "string" || !proposalId ||
      (projectScope !== null && (typeof projectScope !== "string" || !/^[a-f0-9]{64}$/.test(projectScope))) ||
      typeof authorityKey !== "string" || !/^[a-f0-9]{64}$/.test(authorityKey) ||
      typeof authorityRevision !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(authorityRevision)) {
      throw new Error("invalid proposal scope reconciliation");
    }
    const existing = this.db.prepare(`
      SELECT project_scope, authority_key, authority_revision
      FROM proposal_scope_overrides WHERE proposal_id = ?
    `).get(proposalId);
    if (existing?.authority_key === authorityKey &&
      (existing.authority_revision.length > authorityRevision.length ||
        (existing.authority_revision.length === authorityRevision.length &&
          existing.authority_revision >= authorityRevision))) {
      return false;
    }
    this.db.prepare(`
      INSERT INTO proposal_scope_overrides(
        proposal_id, project_scope, authority_key, authority_revision
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        project_scope = excluded.project_scope,
        authority_key = excluded.authority_key,
        authority_revision = excluded.authority_revision
    `).run(proposalId, projectScope, authorityKey, authorityRevision);
    let changed = this.db.prepare(`
      UPDATE proposals SET project_scope = ?
      WHERE proposal_id = ? AND project_scope IS NOT ?
    `).run(projectScope, proposalId, projectScope).changes;
    changed += this.db.prepare(`
      UPDATE memories SET project_scope = ?
      WHERE proposal_id = ? AND project_scope IS NOT ?
    `).run(projectScope, proposalId, projectScope).changes;
    if (changed) this.recallIndex.markDirty();
    return true;
  }

  #migrateV5ToV6() {
    this.#withImmediateTransaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('scope_key', ?)")
        .run(randomBytes(32).toString("hex"));
      this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('project_scope_format', 'hmac-sha256-v1')").run();
      // Schema v5 never shipped outside this branch. Its public SHA-256 project
      // scopes cannot be safely derived into keyed v6 scopes, so migration fails
      // closed by expiring each scoped transient through the normal deletion fence path.
      const migrationTime = this.#now();
      const legacyScoped = this.db.prepare(`
        SELECT * FROM handoffs
        WHERE status = 'pending' AND project_scope IS NOT NULL
        ORDER BY handoff_id
      `).all();
      for (const handoff of legacyScoped) {
        const occurredAt = instant(handoff.expires_at) > instant(migrationTime)
          ? iso(handoff.expires_at)
          : migrationTime;
        this.#expireHandoff(handoff, occurredAt);
      }
      this.db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
    });
  }

  #migrateV6ToV7() {
    this.#withImmediateTransaction(() => {
      const proposalColumns = new Set(this.db.pragma("table_info(proposals)").map((column) => column.name));
      const memoryColumns = new Set(this.db.pragma("table_info(memories)").map((column) => column.name));
      if (!proposalColumns.has("project_scope")) {
        this.db.exec("ALTER TABLE proposals ADD COLUMN project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*'))");
      }
      if (!memoryColumns.has("project_scope")) {
        this.db.exec("ALTER TABLE memories ADD COLUMN project_scope TEXT CHECK (project_scope IS NULL OR (length(project_scope) = 64 AND project_scope NOT GLOB '*[^0-9a-f]*'))");
      }
      this.db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
    });
  }

  #migrateV7ToV8() {
    this.#withImmediateTransaction(() => {
      const legacyKey = this.#meta("replica_scope_key") ?? this.#meta("scope_key");
      if (!/^[a-f0-9]{64}$/.test(legacyKey ?? "")) throw new Error("invalid project scope key");
      this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('replica_scope_key', ?)").run(legacyKey);
      this.db.prepare("DELETE FROM meta WHERE key = 'scope_key'").run();
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
  }

  #withImmediateTransaction(work, { attempts = 6 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return this.db.transaction(work).immediate();
      } catch (error) {
        if (!String(error?.code ?? "").startsWith("SQLITE_BUSY")) throw error;
        lastError = error;
      }
    }
    throw new HandoffUnavailableError("hand-off contention retries exhausted", { cause: lastError });
  }

  #appendLocalEvent({
    entityId, op, actor, clientId = null, saveId = null, payload = {}, occurredAt = this.#now(), eventId = null,
  }) {
    const replicaSeq = Number(this.#meta("replica_seq")) + 1;
    const entityVersion = (this.db.prepare("SELECT MAX(entity_version) AS version FROM events WHERE entity_id = ?").get(entityId)?.version ?? 0) + 1;
    const event = {
      format_version: EVENT_FORMAT_VERSION,
      event_id: eventId ?? this.uuid(),
      entity_id: entityId,
      owner_id: this.#meta("owner_id"),
      replica_id: this.#meta("replica_id"),
      replica_seq: replicaSeq,
      entity_version: entityVersion,
      op,
      actor,
      client_id: clientId,
      occurred_at: occurredAt,
      save_id: saveId,
      payload,
    };
    this.#insertEvent(event);
    this.#setMeta("replica_seq", replicaSeq);
    this.#reconcileEvents(event);
    return event;
  }

  #insertEvent(event) {
    this.#validateEvent(event);
    this.db.prepare(`
      INSERT INTO events(event_id, format_version, entity_id, owner_id, replica_id, replica_seq,
        entity_version, op, actor, client_id, occurred_at, save_id, payload)
      VALUES (@event_id, @format_version, @entity_id, @owner_id, @replica_id, @replica_seq,
        @entity_version, @op, @actor, @client_id, @occurred_at, @save_id, @payload)
    `).run({ ...event, payload: this.payloadCodec.encode(json(event.payload ?? {})) });
    if (event.op === "profile_defined" || event.op === "profile_versioned") {
      this.db.prepare("INSERT INTO event_profile_keys(event_id, profile_key) VALUES (?, ?)")
        .run(event.event_id, `${event.payload.name}\0${event.payload.version}`);
    }
    if (event.op === "proposal_approved") {
      this.db.prepare("INSERT INTO event_memory_links(event_id, memory_id, proposal_id) VALUES (?, ?, ?)")
        .run(event.event_id, event.payload.memory_id, event.entity_id);
    }
    this.#discardMismatchedContentCandidate(event);
    this.#refreshVersionWinner(event.entity_id, event.entity_version, event.op);
  }

  #discardMismatchedContentCandidate(event) {
    const candidate = this.db.prepare("SELECT * FROM content_candidates WHERE source_event_id = ?").get(event.event_id);
    if (!candidate || (["proposal_created", "handoff_created"].includes(event.op) && candidate.owner_id === event.owner_id &&
      candidate.entity_id === event.entity_id && candidate.content_version === eventContentVersion(event))) return;
    this.db.prepare("DELETE FROM content_candidates WHERE source_event_id = ?").run(event.event_id);
    this.db.prepare("DELETE FROM content_records WHERE source_event_id = ?").run(event.event_id);
    this.db.prepare(`
      INSERT INTO content_supersessions(source_event_id, winner_event_id, reason)
      VALUES (?, ?, 'event_superseded')
      ON CONFLICT(source_event_id) DO UPDATE SET
        winner_event_id = excluded.winner_event_id,
        reason = excluded.reason
    `).run(event.event_id, event.event_id);
  }

  #refreshVersionWinner(entityId, entityVersion, op) {
    const contenders = this.db.prepare(`
      SELECT event_id FROM events
      WHERE entity_id = ? AND entity_version = ? AND op = ?
      ORDER BY event_id
    `).all(entityId, entityVersion, op);
    const winnerId = contenders[0].event_id;
    this.db.prepare(`
      INSERT INTO event_versions(entity_id, entity_version, op, event_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_id, entity_version, op) DO UPDATE SET event_id = excluded.event_id
    `).run(entityId, entityVersion, op, winnerId);
    const clearVersionSupersession = this.db.prepare(`
      DELETE FROM event_supersessions WHERE event_id = ? AND reason = 'version_collision'
    `);
    const supersede = this.db.prepare(`
      INSERT INTO event_supersessions(event_id, winner_event_id, reason)
      VALUES (?, ?, 'version_collision')
      ON CONFLICT(event_id) DO UPDATE SET
        winner_event_id = excluded.winner_event_id,
        reason = excluded.reason
    `);
    for (const contender of contenders) {
      if (contender.event_id === winnerId) clearVersionSupersession.run(contender.event_id);
      else supersede.run(contender.event_id, winnerId);
    }
  }

  #validateEvent(event) {
    if (!event || event.format_version !== EVENT_FORMAT_VERSION || typeof event.event_id !== "string" || !event.event_id) {
      throw new Error("invalid event");
    }
    if (![event.entity_id, event.owner_id, event.replica_id].every((value) => typeof value === "string" && value) ||
      !Number.isInteger(event.replica_seq) || event.replica_seq < 1 ||
      !Number.isInteger(event.entity_version) || event.entity_version < 1 ||
      !["owner", "client"].includes(event.actor) ||
      (event.client_id !== null && typeof event.client_id !== "string") ||
      typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at))) {
      throw new Error("invalid event");
    }
    if (event.save_id !== null && !SAVE_ID_PATTERN.test(event.save_id)) {
      throw new Error("save_id must match ^[A-Za-z0-9._-]{1,64}$");
    }
    if (!EVENT_PAYLOAD_KEYS[event.op] || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new Error("invalid event payload");
    }
    const allowedKeys = new Set(EVENT_PAYLOAD_KEYS[event.op]);
    const payloadKeys = Object.keys(event.payload);
    const legacyUnscopedProposal = event.op === "proposal_created" && !payloadKeys.includes("project_scope");
    if ((!legacyUnscopedProposal && payloadKeys.length !== allowedKeys.size) ||
      (legacyUnscopedProposal && payloadKeys.length !== allowedKeys.size - 1) ||
      payloadKeys.some((key) => !allowedKeys.has(key))) {
      throw new Error("invalid event payload");
    }
    const payload = event.payload;
    if (["grant_created", "profile_defined", "profile_versioned"].includes(event.op) &&
      (!Array.isArray(payload.categories) || !payload.categories.length ||
        new Set(payload.categories).size !== payload.categories.length ||
        payload.categories.some((category) => !MEMORY_CATEGORIES.includes(category)) ||
        !Array.isArray(payload.project_scopes) || payload.project_scopes.length > 100 ||
        new Set(payload.project_scopes).size !== payload.project_scopes.length ||
        payload.project_scopes.some((scope) => typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope)))) {
      throw new Error("invalid event payload");
    }
    if ((event.op === "profile_defined" || event.op === "profile_versioned") &&
      (typeof payload.name !== "string" || !payload.name.trim() || !Number.isInteger(payload.version) || payload.version < 1)) {
      throw new Error("invalid event payload");
    }
    if (event.op === "grant_created" &&
      (typeof event.client_id !== "string" || (payload.profile !== null && typeof payload.profile !== "string") ||
        (payload.profile_version !== null && (!Number.isInteger(payload.profile_version) || payload.profile_version < 1)))) {
      throw new Error("invalid event payload");
    }
    if (event.op === "client_paired" &&
      (!["opencode", "claude-code", "codex", "other"].includes(payload.host) || typeof payload.label !== "string" ||
        !payload.label || payload.label.length > 120 || /[\u0000-\u001f\u007f]/.test(payload.label) ||
        !/^[a-f0-9]{32}$/.test(payload.secret_salt) || !/^[a-f0-9]{64}$/.test(payload.secret_hash))) {
      throw new Error("invalid event payload");
    }
    if (event.op === "proposal_created" &&
      (!WRITABLE_MEMORY_CATEGORIES.includes(payload.category) || !Number.isInteger(payload.content_version) || payload.content_version < 1 ||
        !["auto_approved", "pending"].includes(payload.disposition) ||
        !["direct_user_save", "assistant_saved_from_chat"].includes(payload.evidence_basis) ||
        typeof payload.occurred_at !== "string" || !Number.isFinite(Date.parse(payload.occurred_at)) ||
        typeof payload.source !== "string" || !payload.source || payload.source.length > 120 ||
        (payload.project_scope != null && (typeof payload.project_scope !== "string" || !/^[a-f0-9]{64}$/.test(payload.project_scope))) ||
        typeof event.save_id !== "string" || !event.save_id)) {
      throw new Error("invalid event payload");
    }
    if (event.op === "proposal_approved" &&
      (!Number.isInteger(payload.content_version) || payload.content_version < 1 ||
        ![payload.decision_id, payload.memory_id].every((value) => typeof value === "string" && value) ||
        !["auto_approval_policy", "direct_user_save", "owner_review"].includes(payload.via))) {
      throw new Error("invalid event payload");
    }
    if (event.op === "proposal_rejected" &&
      (typeof payload.decision_id !== "string" || !payload.decision_id || payload.via !== "owner_review")) {
      throw new Error("invalid event payload");
    }
    if (event.op === "handoff_created") {
      const exact = typeof payload.to_client_id === "string" && payload.to_client_id.length > 0;
      const profiled = payload.profile === "coding";
      const contentRef = payload.content_ref;
      if (exact === profiled || !contentRef || typeof contentRef !== "object" || Array.isArray(contentRef) ||
        Object.keys(contentRef).sort().join(",") !== "content_version,entity_id" ||
        contentRef.entity_id !== event.entity_id || !Number.isInteger(contentRef.content_version) || contentRef.content_version < 1 ||
        typeof payload.expires_at !== "string" || !Number.isFinite(Date.parse(payload.expires_at)) ||
        Date.parse(payload.expires_at) <= Date.parse(event.occurred_at) || event.save_id !== null ||
        (payload.project_scope !== null && !/^[a-f0-9]{64}$/.test(payload.project_scope)) ||
        (exact && (payload.profile !== null || payload.project_scope !== null)) ||
        (profiled && payload.to_client_id !== null) ||
        (event.actor === "owner" ? event.client_id !== null : typeof event.client_id !== "string" || !event.client_id)) {
        throw new Error("invalid event payload");
      }
    }
    if (event.op === "handoff_claimed" &&
      (event.actor !== "client" || typeof event.client_id !== "string" || !event.client_id ||
        event.save_id !== null ||
        (payload.project_scope !== null && !/^[a-f0-9]{64}$/.test(payload.project_scope)))) {
      throw new Error("invalid event payload");
    }
    if (event.op === "handoff_expired" && (event.actor !== "owner" || event.client_id !== null || event.save_id !== null)) {
      throw new Error("invalid event payload");
    }
    if (["proposal_created", "proposal_approved", "proposal_rejected"].includes(event.op) &&
      this.db.prepare(`
        SELECT 1 FROM event_memory_links
        WHERE memory_id = ? AND proposal_id <> ?
      `).get(event.entity_id, event.entity_id)) {
      throw new Error("proposal entity_id conflicts with a memory_id");
    }
    if (event.op === "proposal_approved") {
      if (payload.memory_id === event.entity_id) throw new Error("memory_id must differ from proposal entity_id");
      if (this.db.prepare(`
        SELECT 1 FROM events
        WHERE entity_id = ? AND op IN ('proposal_created', 'proposal_approved', 'proposal_rejected')
      `).get(payload.memory_id)) {
        throw new Error("memory_id conflicts with a proposal entity_id");
      }
      if (this.db.prepare(`
        SELECT 1 FROM event_memory_links
        WHERE memory_id = ? AND proposal_id <> ?
      `).get(payload.memory_id, event.entity_id)) {
        throw new Error("memory_id is already linked to another proposal");
      }
    }
  }

  #eventFromRow(row) {
    return { ...row, payload: parseJson(this.payloadCodec.decode(row.payload), {}) };
  }

  #canonicalEvents(entityId) {
    return this.db.prepare(`
      SELECT events.* FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      WHERE events.entity_id = ?
      ORDER BY events.entity_version, events.event_id
    `).all(entityId).map((row) => this.#eventFromRow(row));
  }

  #reconcileEvents(insertedEvent) {
    const queued = new Set();
    const processed = new Set();
    const enqueue = (entityId) => {
      const pair = `${entityId}\0${this.#reconciliationRevision(entityId)}`;
      if (!processed.has(pair)) queued.add(entityId);
    };
    enqueue(insertedEvent.entity_id);
    if (insertedEvent.op === "proposal_created") {
      for (const row of this.db.prepare(`
        SELECT DISTINCT events.entity_id FROM events
        JOIN event_versions ON event_versions.event_id = events.event_id
        WHERE events.op = 'proposal_created' AND events.save_id = ?
      `).all(insertedEvent.save_id)) enqueue(row.entity_id);
    }
    for (const row of this.db.prepare(`
      SELECT DISTINCT related.entity_id FROM events AS source
      JOIN events AS related ON related.op = 'proposal_created' AND related.save_id = source.save_id
      WHERE source.entity_id = ? AND source.op = 'proposal_created'
    `).all(insertedEvent.entity_id)) enqueue(row.entity_id);

    while (queued.size) {
      const entityId = [...queued].sort((left, right) =>
        this.#proposalReconcilePriority(left) - this.#proposalReconcilePriority(right) || compareText(left, right)
      )[0];
      queued.delete(entityId);
      const revision = this.#reconciliationRevision(entityId);
      const pair = `${entityId}\0${revision}`;
      if (processed.has(pair)) continue;
      processed.add(pair);
      const touched = this.#rebuildEntity(entityId);
      for (const touchedId of touched) {
        for (const row of this.db.prepare(`
          SELECT DISTINCT events.entity_id FROM pending_events
          JOIN events ON events.event_id = pending_events.event_id
          WHERE pending_events.dependency_entity_id = ? AND events.entity_id <> ?
        `).all(touchedId, entityId)) enqueue(row.entity_id);
        for (const row of this.db.prepare(`
          SELECT DISTINCT proposal_id FROM event_memory_links WHERE memory_id = ?
        `).all(touchedId)) enqueue(row.proposal_id);
        for (const row of this.db.prepare(`
          SELECT DISTINCT events.entity_id FROM events
          JOIN event_versions ON event_versions.event_id = events.event_id
          WHERE events.op = 'grant_created' AND events.client_id = ?
        `).all(touchedId)) enqueue(row.entity_id);
      }
      if (entityId === insertedEvent.entity_id &&
        (insertedEvent.op === "client_paired" || insertedEvent.op === "client_revoked")) {
        for (const row of this.db.prepare(`
          SELECT DISTINCT handoff_id FROM handoff_claim_dependencies WHERE client_id = ?
        `).all(insertedEvent.entity_id)) enqueue(row.handoff_id);
      }
      if (entityId === insertedEvent.entity_id &&
        (insertedEvent.op === "grant_created" || insertedEvent.op === "grant_revoked")) {
        const grantCreation = this.#canonicalEvents(insertedEvent.entity_id)
          .filter((event) => event.op === "grant_created")
          .sort((left, right) => compareText(left.event_id, right.event_id))[0];
        if (grantCreation?.payload.profile) {
          for (const row of this.db.prepare(`
            SELECT DISTINCT handoff_id FROM handoff_claim_dependencies
            WHERE client_id = ? AND profile = ?
          `).all(grantCreation.client_id, grantCreation.payload.profile)) enqueue(row.handoff_id);
        }
      }
    }
  }

  #reconciliationRevision(entityId) {
    const events = this.db.prepare(`
      SELECT entity_version, op, event_id FROM event_versions
      WHERE entity_id = ? ORDER BY entity_version, op, event_id
    `).all(entityId);
    const proposalDependencies = this.db.prepare(`
      SELECT events.save_id, winner.event_id AS winner_event_id
      FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      LEFT JOIN events AS winner ON winner.event_id = (
        SELECT candidate.event_id FROM events AS candidate
        JOIN event_versions AS candidate_version ON candidate_version.event_id = candidate.event_id
        WHERE candidate.op = 'proposal_created' AND candidate.save_id = events.save_id
        ORDER BY candidate.event_id LIMIT 1
      )
      WHERE events.entity_id = ? AND events.op = 'proposal_created'
      ORDER BY events.save_id, events.event_id
    `).all(entityId);
    const tombstones = this.db.prepare(`
      SELECT event_memory_links.memory_id, tombstones.event_id
      FROM event_memory_links
      LEFT JOIN tombstones ON tombstones.entity_id = event_memory_links.memory_id
      WHERE event_memory_links.proposal_id = ?
      ORDER BY event_memory_links.memory_id, tombstones.event_id
    `).all(entityId);
    const clients = this.db.prepare(`
      SELECT events.client_id, clients.paired_at, clients.revoked_at
      FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      LEFT JOIN clients ON clients.client_id = events.client_id
      WHERE events.entity_id = ? AND events.op = 'grant_created'
      ORDER BY events.client_id, events.event_id
    `).all(entityId);
    return createHash("sha256").update(json({ events, proposalDependencies, tombstones, clients })).digest("hex");
  }

  #proposalReconcilePriority(entityId) {
    const rows = this.db.prepare(`
      SELECT events.event_id, events.save_id FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      WHERE events.entity_id = ? AND events.op = 'proposal_created'
    `).all(entityId);
    if (!rows.length) return 0;
    return rows.some((row) => this.#proposalSaveWinner(row.save_id)?.event_id === row.event_id) ? 1 : 0;
  }

  #clearEntityEventState(entityId) {
    this.db.prepare("DELETE FROM event_applications WHERE event_id IN (SELECT event_id FROM events WHERE entity_id = ?)").run(entityId);
    this.db.prepare("DELETE FROM pending_events WHERE event_id IN (SELECT event_id FROM events WHERE entity_id = ?)").run(entityId);
    this.db.prepare("DELETE FROM handoff_claim_dependencies WHERE handoff_id = ?").run(entityId);
    this.db.prepare(`
      DELETE FROM event_supersessions
      WHERE reason <> 'version_collision'
        AND event_id IN (SELECT event_id FROM events WHERE entity_id = ?)
    `).run(entityId);
  }

  #writeEventState({ applied = [], pending = [], superseded = [], handoffDependencies = [] }) {
    const apply = this.db.prepare("INSERT OR REPLACE INTO event_applications(event_id, applied_at) VALUES (?, ?)");
    const park = this.db.prepare("INSERT OR REPLACE INTO pending_events(event_id, dependency_entity_id) VALUES (?, ?)");
    const supersede = this.db.prepare(`
      INSERT INTO event_supersessions(event_id, winner_event_id, reason) VALUES (?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET winner_event_id = excluded.winner_event_id, reason = excluded.reason
    `);
    const depend = this.db.prepare(`
      INSERT OR REPLACE INTO handoff_claim_dependencies(event_id, handoff_id, client_id, profile)
      VALUES (?, ?, ?, ?)
    `);
    for (const event of applied) apply.run(event.event_id, event.occurred_at);
    for (const [event, dependency] of pending) park.run(event.event_id, dependency);
    for (const [event, handoffId, clientId, profile] of handoffDependencies) {
      depend.run(event.event_id, handoffId, clientId, profile);
    }
    for (const [event, winner, reason] of superseded) supersede.run(event.event_id, winner.event_id, reason);
  }

  #rebuildEntity(entityId) {
    const events = this.#canonicalEvents(entityId);
    this.#clearEntityEventState(entityId);
    for (const event of events) this.reconciliationObserver?.({ entity_id: entityId, event_id: event.event_id });
    const touched = new Set([entityId]);
    const profileKeys = this.db.prepare(`
      SELECT DISTINCT event_profile_keys.profile_key FROM event_profile_keys
      JOIN events ON events.event_id = event_profile_keys.event_id
      WHERE events.entity_id = ?
    `).all(entityId).map((row) => row.profile_key);
    for (const key of profileKeys) this.#rebuildProfile(key);

    if (events.some((event) => event.op === "client_paired" || event.op === "client_revoked")) {
      if (this.#rebuildClient(entityId, events)) touched.add(entityId);
    }
    if (events.some((event) => event.op === "grant_created" || event.op === "grant_revoked")) {
      if (this.#rebuildGrant(entityId, events)) touched.add(entityId);
    }
    if (events.some((event) => ["proposal_created", "proposal_approved", "proposal_rejected"].includes(event.op))) {
      if (this.#rebuildProposal(entityId, events)) touched.add(entityId);
    }
    if (events.some((event) => event.op === "memory_deleted")) {
      this.#rebuildDeletion(entityId, events);
      touched.add(entityId);
    }
    if (events.some((event) => ["handoff_created", "handoff_claimed", "handoff_expired"].includes(event.op))) {
      this.#rebuildHandoff(entityId, events);
      touched.add(entityId);
    }
    return touched;
  }

  #rebuildClient(entityId, events) {
    const paired = events.filter((event) => event.op === "client_paired").sort((a, b) => compareText(a.event_id, b.event_id));
    const revoked = events.filter((event) => event.op === "client_revoked");
    if (!paired.length) {
      this.db.prepare("DELETE FROM grants WHERE client_id = ?").run(entityId);
      this.db.prepare("DELETE FROM clients WHERE client_id = ?").run(entityId);
      this.#writeEventState({ pending: revoked.map((event) => [event, entityId]) });
      return false;
    }
    const winner = paired[0];
    this.db.prepare(`
      INSERT INTO clients(client_id, host, label, secret_salt, secret_hash, paired_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        host = excluded.host, label = excluded.label, secret_salt = excluded.secret_salt,
        secret_hash = excluded.secret_hash, paired_at = excluded.paired_at, revoked_at = excluded.revoked_at
    `).run(entityId, winner.payload.host, winner.payload.label, winner.payload.secret_salt, winner.payload.secret_hash,
      winner.occurred_at, revoked[0]?.occurred_at ?? null);
    this.#writeEventState({
      applied: [winner, ...revoked],
      superseded: paired.slice(1).map((event) => [event, winner, "entity_conflict"]),
    });
    return true;
  }

  #rebuildProfile(profileKey) {
    const candidates = this.db.prepare(`
      SELECT events.* FROM event_profile_keys
      JOIN event_versions ON event_versions.event_id = event_profile_keys.event_id
      JOIN events ON events.event_id = event_profile_keys.event_id
      WHERE event_profile_keys.profile_key = ?
      ORDER BY events.event_id
    `).all(profileKey).map((row) => this.#eventFromRow(row));
    const separator = profileKey.lastIndexOf("\0");
    const name = profileKey.slice(0, separator);
    const version = Number(profileKey.slice(separator + 1));
    this.db.prepare("DELETE FROM profiles WHERE name = ? AND version = ?").run(name, version);
    if (!candidates.length) return;
    const winner = candidates[0];
    this.db.prepare(`
      INSERT INTO profiles(name, version, categories, project_scopes, defined_at) VALUES (?, ?, ?, ?, ?)
    `).run(winner.payload.name, winner.payload.version, json(winner.payload.categories),
      json(winner.payload.project_scopes), winner.occurred_at);
    for (const event of candidates) {
      this.db.prepare("DELETE FROM event_applications WHERE event_id = ?").run(event.event_id);
      this.db.prepare("DELETE FROM pending_events WHERE event_id = ?").run(event.event_id);
      this.db.prepare("DELETE FROM event_supersessions WHERE event_id = ? AND reason <> 'version_collision'").run(event.event_id);
    }
    this.#writeEventState({
      applied: [winner],
      superseded: candidates.slice(1).map((event) => [event, winner, "profile_version_conflict"]),
    });
  }

  #rebuildGrant(entityId, events) {
    this.db.prepare("DELETE FROM grants WHERE grant_id = ?").run(entityId);
    const created = events.filter((event) => event.op === "grant_created").sort((a, b) => compareText(a.event_id, b.event_id));
    const revoked = events.filter((event) => event.op === "grant_revoked");
    if (!created.length) {
      this.#writeEventState({ pending: revoked.map((event) => [event, entityId]) });
      return false;
    }
    const winner = created[0];
    if (!this.db.prepare("SELECT 1 FROM clients WHERE client_id = ?").get(winner.client_id)) {
      this.#writeEventState({ pending: events.map((event) => [event, winner.client_id]) });
      return false;
    }
    this.db.prepare(`
      INSERT INTO grants(grant_id, client_id, profile_name, profile_version, categories, project_scopes, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, winner.client_id, winner.payload.profile, winner.payload.profile_version,
      json(winner.payload.categories), json(winner.payload.project_scopes), winner.occurred_at, revoked[0]?.occurred_at ?? null);
    this.#writeEventState({
      applied: [winner, ...revoked],
      superseded: created.slice(1).map((event) => [event, winner, "entity_conflict"]),
    });
    return true;
  }

  #proposalSaveWinner(saveId) {
    const row = this.db.prepare(`
      SELECT events.* FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      WHERE events.op = 'proposal_created' AND events.save_id = ?
      ORDER BY events.event_id LIMIT 1
    `).get(saveId);
    return row ? this.#eventFromRow(row) : null;
  }

  #rebuildProposal(entityId, events) {
    this.db.prepare("DELETE FROM decisions WHERE proposal_id = ?").run(entityId);
    this.db.prepare("DELETE FROM memories WHERE proposal_id = ?").run(entityId);
    this.db.prepare("DELETE FROM proposals WHERE proposal_id = ?").run(entityId);
    const created = events.filter((event) => event.op === "proposal_created");
    const approvals = events.filter((event) => event.op === "proposal_approved");
    const rejections = events.filter((event) => event.op === "proposal_rejected");
    if (!created.length) {
      this.db.prepare("DELETE FROM content_records WHERE entity_id = ?").run(entityId);
      this.#writeEventState({ pending: [...approvals, ...rejections].map((event) => [event, entityId]) });
      return false;
    }

    const effective = [];
    const superseded = [];
    for (const event of created) {
      const winner = this.#proposalSaveWinner(event.save_id);
      if (winner.event_id === event.event_id) effective.push(event);
      else superseded.push([event, winner, "save_id_duplicate"]);
    }
    effective.sort((a, b) => b.entity_version - a.entity_version || compareText(a.event_id, b.event_id));
    if (!effective.length) {
      const winner = this.#proposalSaveWinner(created[0].save_id);
      for (const event of [...approvals, ...rejections]) superseded.push([event, winner, "save_id_duplicate"]);
      this.db.prepare("DELETE FROM content_records WHERE entity_id = ?").run(entityId);
      this.#supersedeContentCandidates(entityId, winner, "event_superseded");
      this.#writeEventState({ superseded });
      return false;
    }
    const creation = effective[0];
    const scopeOverride = this.db.prepare(`
      SELECT project_scope FROM proposal_scope_overrides WHERE proposal_id = ?
    `).get(entityId);
    const projectScope = scopeOverride
      ? scopeOverride.project_scope
      : creation.payload.project_scope ?? null;
    for (const event of effective.slice(1)) superseded.push([event, creation, "proposal_conflict"]);

    const rejection = [...rejections].sort((a, b) => compareText(a.event_id, b.event_id))[0] ?? null;
    const currentApprovals = approvals.filter((event) => event.entity_version > creation.entity_version);
    const approval = rejection ? null : [...currentApprovals].sort((a, b) => compareText(a.event_id, b.event_id))[0] ?? null;
    if (rejection) {
      for (const event of approvals) superseded.push([event, rejection, "rejection_dominates"]);
      for (const event of rejections) if (event !== rejection) superseded.push([event, rejection, "terminal_conflict"]);
    } else if (approval) {
      for (const event of approvals) if (event !== approval) superseded.push([event, approval, "terminal_conflict"]);
    } else {
      for (const event of approvals) superseded.push([event, creation, "proposal_conflict"]);
    }

    const status = rejection ? "rejected" : approval ? "approved" : "pending";
    this.db.prepare(`
      INSERT INTO proposals(proposal_id, save_id, memory_id, category, content_version, source, client_id,
        evidence_basis, status, created_at, occurred_at, disposition, project_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, creation.save_id, approval?.payload.memory_id ?? null, creation.payload.category,
      creation.payload.content_version, creation.payload.source, creation.client_id, creation.payload.evidence_basis,
      status, creation.occurred_at, creation.payload.occurred_at, creation.payload.disposition,
      projectScope);

    if (rejection) {
      this.db.prepare(`
        INSERT INTO decisions(decision_id, proposal_id, decision, via, decided_at)
        VALUES (?, ?, 'rejected', ?, ?)
      `).run(rejection.payload.decision_id, entityId, rejection.payload.via, rejection.occurred_at);
      this.#supersedeContentCandidates(entityId, rejection, "proposal_rejected");
    } else if (approval) {
      const tombstone = this.db.prepare("SELECT deleted_at FROM tombstones WHERE entity_id = ?").get(approval.payload.memory_id);
      this.db.prepare(`
        INSERT INTO memories(memory_id, proposal_id, content_version, source, client_id, category,
          evidence_basis, created_at, occurred_at, deleted_at, project_scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(approval.payload.memory_id, entityId, approval.payload.content_version, creation.payload.source,
        creation.client_id, creation.payload.category, creation.payload.evidence_basis, approval.occurred_at,
        creation.payload.occurred_at, tombstone?.deleted_at ?? null, projectScope);
      this.db.prepare(`
        INSERT INTO decisions(decision_id, proposal_id, decision, via, decided_at)
        VALUES (?, ?, 'approved', ?, ?)
      `).run(approval.payload.decision_id, entityId, approval.payload.via, approval.occurred_at);
      if (tombstone) {
        const deletion = this.db.prepare("SELECT event_id FROM tombstones WHERE entity_id = ?").get(approval.payload.memory_id);
        this.#supersedeContentCandidates(entityId, deletion, "memory_deleted");
      }
    }
    this.#refreshProposalContent(entityId, creation);
    this.#writeEventState({ applied: [creation, ...(rejection ? [rejection] : approval ? [approval] : [])], superseded });
    return true;
  }

  #supersedeContentCandidates(entityId, winner, reason, exceptSourceEventId = null) {
    const candidates = this.db.prepare(`
      SELECT source_event_id FROM (
        SELECT source_event_id FROM content_candidates WHERE entity_id = ?
        UNION
        SELECT content_supersessions.source_event_id FROM content_supersessions
        JOIN events ON events.event_id = content_supersessions.source_event_id
        WHERE events.entity_id = ?
      )
      WHERE ? IS NULL OR source_event_id <> ?
    `).all(entityId, entityId, exceptSourceEventId, exceptSourceEventId);
    const record = this.db.prepare(`
      INSERT INTO content_supersessions(source_event_id, winner_event_id, reason) VALUES (?, ?, ?)
      ON CONFLICT(source_event_id) DO UPDATE SET
        winner_event_id = excluded.winner_event_id,
        reason = excluded.reason
    `);
    const erase = reason === "event_superseded"
      ? null
      : this.db.prepare("DELETE FROM content_candidates WHERE source_event_id = ?");
    for (const candidate of candidates) {
      record.run(candidate.source_event_id, winner.event_id, reason);
      erase?.run(candidate.source_event_id);
    }
  }

  #refreshProposalContent(entityId, creation = null) {
    this.db.prepare("DELETE FROM content_records WHERE entity_id = ?").run(entityId);
    const proposal = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(entityId);
    if (!proposal || proposal.status === "rejected") return;
    if (proposal.memory_id && this.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(proposal.memory_id)) return;
    const contentEvent = creation ?? this.db.prepare(`
      SELECT events.* FROM events
      JOIN event_applications ON event_applications.event_id = events.event_id
      WHERE events.entity_id = ? AND events.op = 'proposal_created'
      ORDER BY events.event_id LIMIT 1
    `).get(entityId);
    if (!contentEvent) return;
    this.#supersedeContentCandidates(entityId, contentEvent, "event_superseded", contentEvent.event_id);
    const candidate = this.db.prepare(`
      SELECT * FROM content_candidates
      WHERE source_event_id = ? AND entity_id = ? AND content_version = ?
    `).get(contentEvent.event_id, entityId, proposal.content_version);
    if (!candidate) return;
    this.db.prepare(`
      DELETE FROM content_supersessions
      WHERE source_event_id = ? AND reason = 'event_superseded'
    `).run(contentEvent.event_id);
    this.db.prepare(`
      INSERT INTO content_records(source_event_id, entity_id, content_version, owner_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(candidate.source_event_id, candidate.entity_id, candidate.content_version,
      candidate.owner_id, candidate.content, candidate.created_at);
  }

  #handoffClaimAuthorization(creation, claim) {
    const clientEvents = this.#canonicalEvents(claim.client_id);
    const paired = clientEvents.filter((event) => event.op === "client_paired")
      .sort((left, right) => compareText(left.event_id, right.event_id))[0];
    if (!paired || !eventEffectiveAt(paired, claim)) return { pending: true, profile: creation.payload.profile };
    if (clientEvents.some((event) => event.op === "client_revoked" && eventEffectiveAt(event, claim))) {
      return { allowed: false };
    }
    if (creation.payload.to_client_id !== null) {
      return { allowed: creation.payload.to_client_id === claim.client_id && claim.payload.project_scope === null };
    }
    if (creation.payload.project_scope !== claim.payload.project_scope) return { allowed: false };
    const grantEntityIds = this.db.prepare(`
      SELECT DISTINCT events.entity_id FROM events
      JOIN event_versions ON event_versions.event_id = events.event_id
      WHERE events.op = 'grant_created' AND events.client_id = ?
    `).all(claim.client_id).map((row) => row.entity_id);
    for (const grantEntityId of grantEntityIds) {
      const grantEvents = this.#canonicalEvents(grantEntityId);
      const grant = grantEvents.filter((event) => event.op === "grant_created")
        .sort((left, right) => compareText(left.event_id, right.event_id))[0];
      if (!grant || grant.payload.profile !== creation.payload.profile || !eventEffectiveAt(grant, claim)) continue;
      const revokedAtClaim = grantEvents.some((event) =>
        event.op === "grant_revoked" && eventEffectiveAt(event, claim));
      if (!revokedAtClaim) return { allowed: true };
    }
    return { pending: true, profile: creation.payload.profile };
  }

  #refreshHandoffContent(entityId, creation) {
    this.db.prepare("DELETE FROM content_records WHERE entity_id = ?").run(entityId);
    const handoff = this.db.prepare("SELECT status, content_version FROM handoffs WHERE handoff_id = ?").get(entityId);
    if (!handoff || handoff.status !== "pending") return;
    const candidate = this.db.prepare(`
      SELECT * FROM content_candidates
      WHERE source_event_id = ? AND entity_id = ? AND content_version = ?
    `).get(creation.event_id, entityId, handoff.content_version);
    if (!candidate) return;
    this.db.prepare(`
      INSERT INTO content_records(source_event_id, entity_id, content_version, owner_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(candidate.source_event_id, candidate.entity_id, candidate.content_version,
      candidate.owner_id, candidate.content, candidate.created_at);
  }

  #rebuildHandoff(entityId, events) {
    const previousTerminalEventId = this.db.prepare(`
      SELECT terminal_event_id FROM handoffs WHERE handoff_id = ? AND status <> 'pending'
    `).get(entityId)?.terminal_event_id ?? null;
    this.db.prepare("DELETE FROM handoff_receipts WHERE handoff_id = ?").run(entityId);
    this.db.prepare("DELETE FROM handoffs WHERE handoff_id = ?").run(entityId);
    this.db.prepare("DELETE FROM content_records WHERE entity_id = ?").run(entityId);
    this.db.prepare("DELETE FROM tombstones WHERE entity_id = ?").run(entityId);
    this.db.prepare("DELETE FROM deletion_fences WHERE entity_id = ?").run(entityId);
    const creations = events.filter((event) => event.op === "handoff_created").sort((a, b) => compareText(a.event_id, b.event_id));
    const claims = events.filter((event) => event.op === "handoff_claimed");
    const expiries = events.filter((event) => event.op === "handoff_expired").sort((a, b) => compareText(a.event_id, b.event_id));
    if (!creations.length) {
      this.#writeEventState({ pending: [...claims, ...expiries].map((event) => [event, entityId]) });
      return;
    }
    const creation = creations[0];
    const superseded = creations.slice(1).map((event) => [event, creation, "entity_conflict"]);
    const pending = [];
    const handoffDependencies = [];
    const validClaims = [];
    for (const claim of claims) {
      if (claim.event_id === previousTerminalEventId) {
        validClaims.push(claim);
        continue;
      }
      if (!eventEffectiveAt(creation, claim)) {
        superseded.push([claim, creation, "entity_conflict"]);
        continue;
      }
      const authorization = this.#handoffClaimAuthorization(creation, claim);
      if (authorization.pending) {
        pending.push([claim, claim.client_id]);
        handoffDependencies.push([claim, entityId, claim.client_id, authorization.profile]);
      } else if (!authorization.allowed || instant(claim.occurred_at) >= instant(creation.payload.expires_at)) {
        superseded.push([claim, creation, "entity_conflict"]);
      } else validClaims.push(claim);
    }
    const validExpiries = [];
    for (const expiry of expiries) {
      if (expiry.event_id === previousTerminalEventId) validExpiries.push(expiry);
      else if (instant(expiry.occurred_at) < instant(creation.payload.expires_at)) {
        superseded.push([expiry, creation, "entity_conflict"]);
      } else validExpiries.push(expiry);
    }
    validClaims.sort((a, b) => compareText(a.event_id, b.event_id));
    const terminal = pending.length && validClaims.length
      ? validExpiries[0] ?? null
      : validClaims[0] ?? validExpiries[0] ?? null;
    if (terminal) {
      for (const claim of validClaims) if (claim !== terminal) superseded.push([claim, terminal, "terminal_conflict"]);
      for (const expiry of validExpiries) if (expiry !== terminal) superseded.push([expiry, terminal, "terminal_conflict"]);
    }
    const status = terminal?.op === "handoff_claimed" ? "claimed" : terminal ? "expired" : "pending";
    this.db.prepare(`
      INSERT INTO handoffs(handoff_id, content_version, created_by_client_id, to_client_id, profile,
        project_scope, created_at, expires_at, status, terminal_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, creation.payload.content_ref.content_version, creation.client_id, creation.payload.to_client_id,
      creation.payload.profile, creation.payload.project_scope, iso(creation.occurred_at),
      iso(creation.payload.expires_at), status, terminal?.event_id ?? null);
    if (terminal) {
      this.db.prepare("INSERT INTO deletion_fences(entity_id, created_at) VALUES (?, ?)").run(entityId, terminal.occurred_at);
      this.db.prepare("INSERT INTO tombstones(entity_id, event_id, deleted_at) VALUES (?, ?, ?)")
        .run(entityId, terminal.event_id, terminal.occurred_at);
      this.db.prepare(`
        INSERT INTO handoff_receipts(receipt_id, handoff_id, client_id, action, event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`receipt:${terminal.event_id}`, entityId, terminal.client_id,
        terminal.op === "handoff_claimed" ? "claimed" : "expired", terminal.event_id, terminal.occurred_at);
      this.db.prepare("DELETE FROM content_candidates WHERE entity_id = ?").run(entityId);
      this.db.prepare("DELETE FROM content_supersessions WHERE source_event_id = ?").run(creation.event_id);
    } else {
      this.#refreshHandoffContent(entityId, creation);
    }
    this.#writeEventState({
      applied: [creation, ...(terminal ? [terminal] : [])],
      pending,
      superseded,
      handoffDependencies: terminal ? [] : handoffDependencies,
    });
  }

  #rebuildDeletion(entityId, events) {
    this.db.prepare("DELETE FROM tombstones WHERE entity_id = ?").run(entityId);
    this.db.prepare("DELETE FROM deletion_fences WHERE entity_id = ?").run(entityId);
    const deletions = events.filter((event) => event.op === "memory_deleted").sort((a, b) => compareText(a.event_id, b.event_id));
    if (!deletions.length) return;
    const winner = deletions[0];
    this.db.prepare("INSERT INTO deletion_fences(entity_id, created_at) VALUES (?, ?)").run(entityId, winner.occurred_at);
    this.db.prepare("INSERT INTO tombstones(entity_id, event_id, deleted_at) VALUES (?, ?, ?)")
      .run(entityId, winner.event_id, winner.occurred_at);
    this.#writeEventState({
      applied: [winner],
      superseded: deletions.slice(1).map((event) => [event, winner, "duplicate_deletion"]),
    });
  }

  metadata() {
    return {
      schema_version: Number(this.#meta("schema_version")),
      owner_id: this.#meta("owner_id"),
      replica_id: this.#meta("replica_id"),
      replica_seq: Number(this.#meta("replica_seq")),
      auto_approve: this.#meta("auto_approve") === "on",
    };
  }

  setAutoApprove(enabled) {
    // This owner policy is replica-local by design. Syncing it would let one replica
    // silently change how another owner surface handles new proposals.
    this.#setMeta("auto_approve", enabled ? "on" : "off");
    return this.metadata().auto_approve;
  }

  addClient({ host, label, clientId = null, eventId = null }) {
    const normalizedHost = typeof host === "string" ? host.trim() : "";
    const normalizedLabel = typeof label === "string" ? label.trim() : "";
    if (!["opencode", "claude-code", "codex", "other"].includes(normalizedHost)) throw new Error("invalid host");
    if (!normalizedLabel || normalizedLabel.length > 120 || /[\u0000-\u001f\u007f]/.test(normalizedLabel)) throw new Error("invalid label");
    const pairedClientId = requireUuid(clientId ?? this.uuid(), "client id");
    const pairedEventId = requireUuid(eventId ?? this.uuid(), "client event id");
    const secret = randomBytes(32).toString("base64url");
    const credential = hashSecret(secret);
    const timestamp = this.#now();
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM events WHERE entity_id = ? COLLATE NOCASE").get(pairedClientId)) {
        throw new Error("client id collision");
      }
      if (this.db.prepare("SELECT 1 FROM events WHERE event_id = ? COLLATE NOCASE").get(pairedEventId)) {
        throw new Error("client event id collision");
      }
      this.#appendLocalEvent({
        entityId: pairedClientId,
        eventId: pairedEventId,
        op: "client_paired",
        actor: "owner",
        occurredAt: timestamp,
        payload: { host: normalizedHost, label: normalizedLabel, secret_salt: credential.salt, secret_hash: credential.hash },
      });
    })();
    return { client_id: pairedClientId, client_secret: secret, host: normalizedHost, label: normalizedLabel };
  }

  listClients() {
    return this.#withHandoffExpirySweep(() => this.db.prepare(`
        SELECT client_id, host, label, paired_at, revoked_at FROM clients ORDER BY paired_at, client_id
      `).all());
  }

  revokeClient(clientId) {
    const timestamp = this.#now();
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM clients WHERE client_id = ? AND revoked_at IS NULL").get(clientId)) return false;
      this.#appendLocalEvent({ entityId: clientId, op: "client_revoked", actor: "owner", occurredAt: timestamp });
      return true;
    })();
  }

  authenticate(clientId, secret) {
    const client = this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(clientId);
    if (!client || client.revoked_at || !secretMatches(secret, client.secret_salt, client.secret_hash)) return null;
    return client;
  }

  defineProfile({ name, categories, projectScopes = [] }) {
    const normalized = this.#validateCategories(categories, { writable: false });
    if (!name?.trim() || !normalized.length) throw new Error("profile name and categories are required");
    const normalizedProjectScopes = this.#validateProjectScopes(projectScopes);
    return this.db.transaction(() => {
      const version = (this.db.prepare("SELECT MAX(version) AS version FROM profiles WHERE name = ?").get(name.trim())?.version ?? 0) + 1;
      const timestamp = this.#now();
      this.#appendLocalEvent({
        entityId: `profile:${name.trim()}`,
        op: version === 1 ? "profile_defined" : "profile_versioned",
        actor: "owner",
        occurredAt: timestamp,
        payload: { name: name.trim(), version, categories: normalized, project_scopes: normalizedProjectScopes },
      });
      return this.profile(name.trim(), version);
    })();
  }

  profile(name, version = null) {
    const row = version == null
      ? this.db.prepare("SELECT * FROM profiles WHERE name = ? ORDER BY version DESC LIMIT 1").get(name)
      : this.db.prepare("SELECT * FROM profiles WHERE name = ? AND version = ?").get(name, version);
    return row ? { ...row, categories: parseJson(row.categories, []), project_scopes: parseJson(row.project_scopes, []) } : null;
  }

  listProfiles() {
    return this.#withHandoffExpirySweep(() =>
      this.db.prepare("SELECT * FROM profiles ORDER BY name, version").all().map((row) => ({
        ...row,
        categories: parseJson(row.categories, []),
        project_scopes: parseJson(row.project_scopes, []),
      })));
  }

  addGrant({ clientId, grantId = null, eventId = null, profile = null, categories = null, projectScopes = [] }) {
    if (!this.db.prepare("SELECT 1 FROM clients WHERE client_id = ?").get(clientId)) throw new Error("unknown client");
    const normalizedProjectScopes = this.#validateProjectScopes(projectScopes);
    let frozenCategories;
    let profileVersion = null;
    let frozenProjectScopes = [];
    if (profile) {
      const current = this.profile(profile);
      if (!current) throw new Error("unknown profile");
      frozenCategories = current.categories;
      profileVersion = current.version;
      frozenProjectScopes = current.project_scopes;
    } else {
      frozenCategories = this.#validateCategories(categories, { writable: false });
      if (!frozenCategories.length) throw new Error("categories are required");
      frozenProjectScopes = normalizedProjectScopes;
    }
    const createdGrantId = requireUuid(grantId ?? this.uuid(), "grant id");
    const createdEventId = requireUuid(eventId ?? this.uuid(), "grant event id");
    const timestamp = this.#now();
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM events WHERE entity_id = ? COLLATE NOCASE").get(createdGrantId)) {
        throw new Error("grant id collision");
      }
      if (this.db.prepare("SELECT 1 FROM events WHERE event_id = ? COLLATE NOCASE").get(createdEventId)) {
        throw new Error("grant event id collision");
      }
      this.#appendLocalEvent({
        entityId: createdGrantId,
        eventId: createdEventId,
        op: "grant_created",
        actor: "owner",
        clientId,
        occurredAt: timestamp,
        payload: { profile, profile_version: profileVersion, categories: frozenCategories, project_scopes: frozenProjectScopes },
      });
    })();
    return { grant_id: createdGrantId, client_id: clientId, profile, profile_version: profileVersion, categories: frozenCategories, project_scopes: frozenProjectScopes };
  }

  listGrants(clientId = null) {
    return this.#withHandoffExpirySweep(() => {
      const rows = clientId
        ? this.db.prepare("SELECT * FROM grants WHERE client_id = ? ORDER BY created_at, grant_id").all(clientId)
        : this.db.prepare("SELECT * FROM grants ORDER BY created_at, grant_id").all();
      return rows.map((row) => ({ ...row, categories: parseJson(row.categories, []), project_scopes: parseJson(row.project_scopes, []) }));
    });
  }

  creationEventId(entityId, op) {
    if (!["client_paired", "grant_created"].includes(op)) throw new Error("invalid creation event operation");
    return this.db.prepare(`
      SELECT events.event_id FROM events
      JOIN event_applications ON event_applications.event_id = events.event_id
      WHERE events.entity_id = ? AND events.op = ?
      LIMIT 1
    `).get(entityId, op)?.event_id ?? null;
  }

  revokeGrant(grantId) {
    const timestamp = this.#now();
    return this.db.transaction(() => {
      const grant = this.db.prepare("SELECT * FROM grants WHERE grant_id = ? AND revoked_at IS NULL").get(grantId);
      if (!grant) return false;
      this.#appendLocalEvent({ entityId: grantId, op: "grant_revoked", actor: "owner", clientId: grant.client_id, occurredAt: timestamp });
      return true;
    })();
  }

  createHandoff(input, { owner = false } = {}) {
    let creatorClientId = null;
    if (!owner) {
      const creator = this.authenticate(input?.client_id, input?.client_secret);
      if (!creator) throw new Error("client authentication failed");
      creatorClientId = creator.client_id;
    }
    const toClientId = typeof input?.to_client_id === "string" && input.to_client_id.trim()
      ? input.to_client_id.trim()
      : null;
    const profile = typeof input?.profile === "string" && input.profile.trim() ? input.profile.trim() : null;
    if ((toClientId === null) === (profile === null) || (profile !== null && profile !== "coding")) {
      throw new Error("handoff requires one exact client or the coding profile");
    }
    if (toClientId) {
      const target = this.db.prepare("SELECT revoked_at FROM clients WHERE client_id = ?").get(toClientId);
      if (!target || target.revoked_at) throw new Error("unknown or revoked target client");
      if (input.project != null && String(input.project).trim()) throw new Error("project scope requires the coding profile");
    }
    const refusal = screenContent(input?.snapshot);
    if (refusal) throw new Error("handoff snapshot was refused");
    const timestamp = this.#now();
    const expiresAt = input?.expires_at == null
      ? new Date(Date.parse(timestamp) + DEFAULT_HANDOFF_TTL_MS).toISOString()
      : iso(input.expires_at);
    if (Date.parse(expiresAt) <= Date.parse(timestamp)) throw new Error("handoff expiry must be in the future");
    const handoffId = this.uuid();
    const contentVersion = 1;
    this.db.transaction(() => {
      const creation = this.#appendLocalEvent({
        entityId: handoffId,
        op: "handoff_created",
        actor: owner ? "owner" : "client",
        clientId: creatorClientId,
        occurredAt: timestamp,
        payload: {
          content_ref: { entity_id: handoffId, content_version: contentVersion },
          expires_at: expiresAt,
          profile,
          project_scope: profile ? this.#projectScope(input.project) : null,
          to_client_id: toClientId,
        },
      });
      this.db.prepare(`
        INSERT INTO content_candidates(source_event_id, entity_id, content_version, content_hash, owner_id, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(creation.event_id, handoffId, contentVersion,
        createHash("sha256").update(input.snapshot.trim()).digest("hex"), this.#meta("owner_id"),
        this.payloadCodec.encode(input.snapshot.trim()), timestamp);
      this.#refreshHandoffContent(handoffId, creation);
    })();
    return { status: "created", handoff_id: handoffId, expires_at: expiresAt };
  }

  #clientCanClaimHandoff(handoff, clientId, requestedScopes) {
    if (handoff.to_client_id !== null) return handoff.to_client_id === clientId;
    if (!requestedScopes.includes(handoff.project_scope)) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM grants
      WHERE client_id = ? AND profile_name = ? AND revoked_at IS NULL
      LIMIT 1
    `).get(clientId, handoff.profile));
  }

  #expireHandoff(handoff, occurredAt = this.#now()) {
    this.#appendLocalEvent({
      entityId: handoff.handoff_id,
      op: "handoff_expired",
      actor: "owner",
      occurredAt,
    });
    return { status: "expired", handoff_id: handoff.handoff_id, snapshot: null, expires_at: handoff.expires_at };
  }

  #expiredHandoffsAt(nowMs) {
    return this.db.prepare(`
      SELECT * FROM handoffs
      WHERE status = 'pending' AND expires_at <= ?
      ORDER BY expires_at, handoff_id
    `).all(iso(nowMs));
  }

  #sweepExpiredHandoffs(nowMs) {
    return this.#expiredHandoffsAt(nowMs).map((handoff) => this.#expireHandoff(handoff));
  }

  expireHandoffs() {
    this.expirySweepObserver?.();
    const nowMs = instant(this.#now());
    if (!this.db.prepare(`
      SELECT 1 FROM handoffs
      WHERE status = 'pending' AND expires_at <= ?
      LIMIT 1
    `).get(iso(nowMs))) return [];
    return this.#withImmediateTransaction(() => this.#sweepExpiredHandoffs(nowMs));
  }

  #withHandoffExpirySweep(work) {
    const outermost = this.handoffSweepOperationDepth === 0;
    this.handoffSweepOperationDepth += 1;
    try {
      if (outermost) this.expireHandoffs();
      return work();
    } finally {
      this.handoffSweepOperationDepth -= 1;
    }
  }

  claimHandoff(input) {
    const timestamp = this.#now();
    const requestedScopes = this.#projectScopes(input?.project) ?? [null];
    return this.#withImmediateTransaction(() => {
      const expired = this.#sweepExpiredHandoffs(instant(timestamp));
      const client = this.authenticate(input?.client_id, input?.client_secret);
      if (!client) return { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null };
      const handoffs = this.db.prepare(`
        SELECT * FROM handoffs WHERE status = 'pending' ORDER BY created_at, handoff_id
      `).all();
      for (const handoff of handoffs) {
        if (!this.#clientCanClaimHandoff(handoff, client.client_id, requestedScopes)) continue;
        const record = this.db.prepare(`
          SELECT content FROM content_records WHERE entity_id = ? AND content_version = ?
        `).get(handoff.handoff_id, handoff.content_version);
        if (!record) continue;
        const snapshot = this.payloadCodec.decode(record.content);
        this.#appendLocalEvent({
          entityId: handoff.handoff_id,
          op: "handoff_claimed",
          actor: "client",
          clientId: client.client_id,
          occurredAt: timestamp,
          payload: { project_scope: handoff.profile ? handoff.project_scope : null },
        });
        return { status: "claimed", handoff_id: handoff.handoff_id, snapshot, expires_at: handoff.expires_at };
      }
      for (const outcome of expired) {
        const handoff = this.db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(outcome.handoff_id);
        if (handoff && this.#clientCanClaimHandoff(handoff, client.client_id, requestedScopes)) return outcome;
      }
      return { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null };
    });
  }

  listHandoffs() {
    return this.#withHandoffExpirySweep(() => this.db.prepare(`
        SELECT handoff_id, to_client_id, profile, project_scope IS NOT NULL AS project_scoped,
          created_at, expires_at, status
        FROM handoffs WHERE status = 'pending' ORDER BY created_at, handoff_id
      `).all().map((row) => ({ ...row, project_scoped: Boolean(row.project_scoped) })));
  }

  handoffReceipts() {
    return this.#withHandoffExpirySweep(() => this.db.prepare(`
        SELECT receipt_id, handoff_id, client_id, action, event_id, created_at
        FROM handoff_receipts ORDER BY created_at, receipt_id
      `).all());
  }

  propose(input, { owner = false, source: ownerSource = null } = {}) {
    const saveId = typeof input?.save_id === "string" ? input.save_id : "";
    if (!SAVE_ID_PATTERN.test(saveId)) throw new Error("save_id must match ^[A-Za-z0-9._-]{1,64}$");
    let client = null;
    if (!owner) {
      client = this.authenticate(input.client_id, input.client_secret);
      if (!client) return { status: "rejected", proposal_id: null, save_id: saveId, disposition: "pending" };
    }
    const existing = this.db.prepare("SELECT proposal_id, disposition FROM proposals WHERE save_id = ?").get(saveId);
    if (existing) {
      const owned = this.db.prepare("SELECT client_id FROM proposals WHERE proposal_id = ?").get(existing.proposal_id);
      if (!owner && owned?.client_id !== client.client_id) {
        return { status: "rejected", proposal_id: null, save_id: saveId, disposition: "pending" };
      }
      return { status: "duplicate", proposal_id: existing.proposal_id, save_id: saveId, disposition: existing.disposition };
    }
    if (!WRITABLE_MEMORY_CATEGORIES.includes(input.category)) {
      return { status: "rejected", proposal_id: null, save_id: saveId, disposition: "pending" };
    }
    const refusal = screenContent(input.content);
    if (refusal) return { status: "rejected", proposal_id: null, save_id: saveId, disposition: "pending" };
    const projectScope = input.project_scope == null || input.project_scope === ""
      ? null
      : this.#validateProjectScopes([input.project_scope])[0];

    const shouldApprove = owner || this.#meta("auto_approve") === "on";
    const proposalId = this.uuid();
    const memoryId = shouldApprove ? this.uuid() : null;
    const timestamp = this.#now();
    const occurredAt = input.occurred_at ? iso(input.occurred_at) : timestamp;
    const disposition = shouldApprove ? "auto_approved" : "pending";
    const source = owner
      ? (typeof ownerSource === "string" && ownerSource && ownerSource.length <= 120 ? ownerSource : "owner")
      : client.label || client.host;
    const clientId = owner ? null : client.client_id;
    const evidenceBasis = owner ? "direct_user_save" : "assistant_saved_from_chat";
    const contentVersion = 1;

    this.db.transaction(() => {
      const creation = this.#appendLocalEvent({
        entityId: proposalId,
        op: "proposal_created",
        actor: owner ? "owner" : "client",
        clientId,
        saveId,
        occurredAt: timestamp,
        payload: {
          category: input.category,
          content_version: contentVersion,
          disposition,
          evidence_basis: evidenceBasis,
          occurred_at: occurredAt,
          project_scope: projectScope,
          source,
        },
      });
      this.db.prepare(`
        INSERT INTO content_candidates(source_event_id, entity_id, content_version, content_hash, owner_id, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(creation.event_id, proposalId, contentVersion, createHash("sha256").update(input.content.trim()).digest("hex"),
        this.#meta("owner_id"), this.payloadCodec.encode(input.content.trim()), timestamp);
      this.#refreshProposalContent(proposalId, creation);
      if (shouldApprove) this.#approveProjection({ proposalId, memoryId, actor: owner ? "owner" : "client", clientId, via: owner ? "direct_user_save" : "auto_approval_policy" });
    })();
    if (shouldApprove) this.recallIndex.markDirty();
    return { status: "recorded", proposal_id: proposalId, save_id: saveId, disposition };
  }

  reemitProposal(proposalId) {
    const result = this.db.transaction(() => {
      const proposal = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
      if (!proposal || !["pending", "approved"].includes(proposal.status)) return null;
      if (proposal.memory_id && this.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(proposal.memory_id)) {
        return null;
      }
      const record = this.db.prepare(`
        SELECT content_records.*, events.actor AS creation_actor, events.client_id AS creation_client_id
        FROM content_records
        JOIN events ON events.event_id = content_records.source_event_id
        WHERE content_records.entity_id = ? AND content_records.content_version = ?
      `).get(proposalId, proposal.content_version);
      if (!record) return null;

      const timestamp = this.#now();
      const contentVersion = proposal.content_version + 1;
      const saveId = `reemit.${this.uuid()}`;
      const approved = proposal.status === "approved";
      const creation = this.#appendLocalEvent({
        entityId: proposalId,
        op: "proposal_created",
        actor: approved ? "owner" : record.creation_actor,
        clientId: approved ? null : record.creation_client_id,
        saveId,
        occurredAt: timestamp,
        payload: {
          category: proposal.category,
          content_version: contentVersion,
          disposition: approved ? "auto_approved" : proposal.disposition,
          evidence_basis: approved ? "direct_user_save" : proposal.evidence_basis,
          occurred_at: approved ? timestamp : proposal.occurred_at,
          project_scope: proposal.project_scope,
          source: approved ? "owner" : proposal.source,
        },
      });
      const content = this.payloadCodec.decode(record.content);
      this.db.prepare(`
        INSERT INTO content_candidates(source_event_id, entity_id, content_version, content_hash, owner_id, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(creation.event_id, proposalId, contentVersion, createHash("sha256").update(content).digest("hex"),
        this.#meta("owner_id"), this.payloadCodec.encode(content), timestamp);
      this.#refreshProposalContent(proposalId, creation);
      const approval = approved ? this.#appendLocalEvent({
        entityId: proposalId,
        op: "proposal_approved",
        actor: "owner",
        saveId,
        occurredAt: timestamp,
        payload: {
          content_version: contentVersion,
          decision_id: this.uuid(),
          memory_id: proposal.memory_id,
          via: "direct_user_save",
        },
      }) : null;
      return {
        proposal_id: proposalId,
        creation_event_id: creation.event_id,
        approval_event_id: approval?.event_id ?? null,
        content_version: contentVersion,
      };
    })();
    if (result?.approval_event_id) this.recallIndex.markDirty();
    return result;
  }

  #approveProjection({ proposalId, memoryId = this.uuid(), actor = "owner", clientId = null, via = "owner_review" }) {
    const proposal = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    if (!proposal || proposal.status !== "pending") return false;
    const timestamp = this.#now();
    this.#appendLocalEvent({
      entityId: proposalId,
      op: "proposal_approved",
      actor,
      clientId,
      saveId: proposal.save_id,
      occurredAt: timestamp,
      payload: { content_version: proposal.content_version, decision_id: this.uuid(), memory_id: memoryId, via },
    });
    return true;
  }

  approveProposal(proposalId) {
    const changed = this.db.transaction(() => this.#approveProjection({ proposalId }))();
    if (changed) this.recallIndex.markDirty();
    return changed;
  }

  rejectProposal(proposalId) {
    const timestamp = this.#now();
    return this.db.transaction(() => {
      const proposal = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ? AND status = 'pending'").get(proposalId);
      if (!proposal) return false;
      this.#appendLocalEvent({
        entityId: proposalId,
        op: "proposal_rejected",
        actor: "owner",
        saveId: proposal.save_id,
        occurredAt: timestamp,
        payload: { decision_id: this.uuid(), via: "owner_review" },
      });
      return true;
    })();
  }

  listInbox() {
    return this.#withHandoffExpirySweep(() => this.db.prepare(`
        SELECT proposals.proposal_id, proposals.save_id, proposals.category, content_records.content,
          proposals.source, proposals.client_id, proposals.evidence_basis, proposals.created_at, proposals.occurred_at
        FROM proposals
        JOIN content_records ON content_records.entity_id = proposals.proposal_id
          AND content_records.content_version = proposals.content_version
        WHERE proposals.status = 'pending' ORDER BY proposals.created_at, proposals.proposal_id
      `).all().map((row) => ({ ...row, content: this.payloadCodec.decode(row.content) })));
  }

  #validateCategories(categories, { writable = false } = {}) {
    const accepted = writable ? WRITABLE_MEMORY_CATEGORIES : MEMORY_CATEGORIES;
    if (!Array.isArray(categories)) return [];
    return [...new Set(categories.filter((category) => accepted.includes(category)))];
  }

  #validateProjectScopes(projectScopes) {
    if (!Array.isArray(projectScopes) || projectScopes.length > 100 ||
      projectScopes.some((scope) => typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope))) {
      throw new Error("invalid project scopes");
    }
    return [...new Set(projectScopes)];
  }

  #authorizations(clientId) {
    const authorizations = new Map();
    for (const grant of this.db.prepare("SELECT categories, project_scopes FROM grants WHERE client_id = ? AND revoked_at IS NULL").all(clientId)) {
      const scopes = parseJson(grant.project_scopes, []);
      for (const category of parseJson(grant.categories, [])) {
        const authorization = authorizations.get(category) ?? { unrestricted: false, scopes: new Set() };
        if (!scopes.length) authorization.unrestricted = true;
        for (const scope of scopes) authorization.scopes.add(scope);
        authorizations.set(category, authorization);
      }
    }
    return authorizations;
  }

  #approvedRows() {
    return this.db.prepare(`
      SELECT memories.memory_id, content_records.content, memories.source, memories.created_at,
        memories.occurred_at, memories.category, memories.client_id, memories.evidence_basis,
        memories.project_scope, 'memory' AS record_kind, NULL AS verified_issuer, NULL AS verified_at
      FROM memories
      JOIN content_records ON content_records.entity_id = memories.proposal_id
        AND content_records.content_version = memories.content_version
      WHERE memories.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones WHERE tombstones.entity_id = memories.memory_id)
    `).all().map((row) => ({ ...row, content: this.payloadCodec.decode(row.content) }));
  }

  prefetch(input) {
    return this.read(input, { receipt: false });
  }

  recall(input) {
    return this.read(input, { receipt: true });
  }

  read({
    client_id: clientId, client_secret: secret, categories, query = "", limit = 20,
    project_scope: projectScope = null, project_scopes: projectScopes = null,
  }, { owner = false, receipt = false } = {}) {
    return this.#withHandoffExpirySweep(() => {
      if (projectScope != null && (typeof projectScope !== "string" || !/^[a-f0-9]{64}$/.test(projectScope))) {
        throw new Error("invalid project scope");
      }
      const requestedProjectScopes = projectScopes == null
        ? new Set(projectScope === null ? [] : [projectScope])
        : new Set(this.#validateProjectScopes(projectScopes));
      const requested = this.#validateCategories(categories, { writable: false });
      const boundedLimit = Math.min(MAX_READ_ROWS, Math.max(1, Number.isFinite(limit) ? Math.round(limit) : 20));
      let allowed = requested;
      let skipped = [];
      let authorizations = null;
      if (!owner) {
        const client = this.authenticate(clientId, secret);
        if (!client) {
          return this.#readOutcome({ status: "blocked", rows: [], skipped: requested.map((category) => ({ category, reason: "no_pass" })) });
        }
        authorizations = this.#authorizations(clientId);
        allowed = requested.filter((category) => authorizations.has(category));
        skipped = requested.filter((category) => !authorizations.has(category)).map((category) => ({ category, reason: "no_pass" }));
        if (!allowed.length) return this.#readOutcome({ status: "blocked", rows: [], skipped });
      }
      let remainingContent = MAX_READ_CONTENT_CHARS;
      const rows = [];
      const candidateAllowed = (row) => {
        if (row.project_scope !== null && !requestedProjectScopes.has(row.project_scope)) return false;
        if (owner || row.project_scope === null) return true;
        const authorization = authorizations.get(row.category);
        return authorization?.unrestricted || authorization?.scopes.has(row.project_scope);
      };
      for (const row of this.recallIndex.search({ query, allowedCategories: allowed, candidateAllowed, limit: boundedLimit })) {
        if (remainingContent <= 0) break;
        const content = row.content.slice(0, Math.min(MAX_ROW_CONTENT_CHARS, remainingContent));
        const { project_scope: _projectScope, ...publicRow } = row;
        rows.push({ ...publicRow, content });
        remainingContent -= content.length;
      }
      if (!owner && receipt) {
        this.db.prepare("INSERT INTO receipts(receipt_id, client_id, categories, row_count, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(this.uuid(), clientId, json(allowed), rows.length, this.#now());
      }
      return this.#readOutcome({ status: rows.length ? "results" : "empty", rows, skipped });
    });
  }

  #readOutcome({ status, rows, skipped }) {
    return {
      status,
      transport: "local",
      connectivity: "offline",
      freshness: "fresh",
      as_of: this.#now(),
      rows,
      skipped_categories: skipped,
    };
  }

  listMemories() {
    return this.#withHandoffExpirySweep(() =>
      this.#approvedRows().sort((left, right) => right.created_at.localeCompare(left.created_at)));
  }

  deleteMemory(memoryId, { owner = true, clientId = null, clientSecret = null } = {}) {
    let actor = "owner";
    if (!owner) {
      const client = this.authenticate(clientId, clientSecret);
      if (!client) return { status: "refused", reason: "client_auth_failed" };
      actor = "client";
    }
    const memory = this.db.prepare("SELECT * FROM memories WHERE memory_id = ? AND deleted_at IS NULL").get(memoryId);
    if (!memory) return { status: "not_found" };
    if (!owner && memory.client_id !== clientId) return { status: "refused", reason: "not_source_client" };
    const timestamp = this.#now();
    this.db.transaction(() => {
      this.#appendLocalEvent({
        entityId: memoryId,
        op: "memory_deleted",
        actor,
        clientId: owner ? null : clientId,
        occurredAt: timestamp,
      });
    })();
    this.recallIndex.markDirty();
    return { status: "deleted", memory_id: memoryId };
  }

  ingestEvent(event) {
    if (event?.owner_id !== this.#meta("owner_id")) throw new Error("event owner_id does not match store owner_id");
    if (typeof event?.event_id === "string" && event.event_id &&
      this.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.event_id)) return false;
    this.#validateEvent(event);
    return this.db.transaction(() => {
      this.#insertEvent(event);
      this.#reconcileEvents(event);
      this.recallIndex.markDirty();
      return true;
    })();
  }

  ingestContentRecord(record) {
    if (!record || record.owner_id !== this.#meta("owner_id")) throw new Error("content record owner_id does not match store owner_id");
    if (typeof record.event_id !== "string" || !record.event_id ||
      typeof record.entity_id !== "string" || !record.entity_id ||
      !Number.isInteger(record.content_version) || record.content_version < 1) {
      throw new Error("invalid content record");
    }
    const refusal = screenContent(record.content);
    if (refusal) throw new Error("invalid content record");
    return this.db.transaction(() => {
      const sourceEvent = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(record.event_id);
      if (sourceEvent && (sourceEvent.owner_id !== record.owner_id || sourceEvent.entity_id !== record.entity_id ||
        !["proposal_created", "handoff_created"].includes(sourceEvent.op) ||
        eventContentVersion(this.#eventFromRow(sourceEvent)) !== record.content_version)) {
        throw new Error("content record does not match its source event");
      }
      const handoff = this.db.prepare("SELECT status FROM handoffs WHERE handoff_id = ?").get(record.entity_id);
      if (handoff && handoff.status !== "pending") return false;
      if (this.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(record.entity_id)) return false;
      const proposal = this.db.prepare("SELECT status, memory_id FROM proposals WHERE proposal_id = ?").get(record.entity_id);
      if (proposal?.status === "rejected") {
        const rejection = this.db.prepare(`
          SELECT events.event_id FROM events
          JOIN event_applications ON event_applications.event_id = events.event_id
          WHERE events.entity_id = ? AND events.op = 'proposal_rejected'
        `).get(record.entity_id);
        this.db.prepare(`
          INSERT INTO content_supersessions(source_event_id, winner_event_id, reason)
          VALUES (?, ?, 'proposal_rejected')
          ON CONFLICT(source_event_id) DO UPDATE SET
            winner_event_id = excluded.winner_event_id,
            reason = excluded.reason
        `).run(record.event_id, rejection.event_id);
        return false;
      }
      if (proposal?.memory_id) {
        const tombstone = this.db.prepare("SELECT event_id FROM tombstones WHERE entity_id = ?").get(proposal.memory_id);
        if (tombstone) {
          this.db.prepare(`
            INSERT INTO content_supersessions(source_event_id, winner_event_id, reason)
            VALUES (?, ?, 'memory_deleted')
            ON CONFLICT(source_event_id) DO UPDATE SET
              winner_event_id = excluded.winner_event_id,
              reason = excluded.reason
          `).run(record.event_id, tombstone.event_id);
          return false;
        }
      }
      const supersession = this.db.prepare("SELECT winner_event_id FROM event_supersessions WHERE event_id = ?").get(record.event_id);
      if (supersession) {
        this.db.prepare(`
          INSERT INTO content_supersessions(source_event_id, winner_event_id, reason)
          VALUES (?, ?, 'event_superseded')
          ON CONFLICT(source_event_id) DO UPDATE SET winner_event_id = excluded.winner_event_id
        `).run(record.event_id, supersession.winner_event_id);
      }
      const encoded = this.payloadCodec.encode(record.content);
      const contentHash = createHash("sha256").update(record.content).digest("hex");
      const createdAt = record.created_at ? iso(record.created_at) : this.#now();
      const existing = this.db.prepare("SELECT content_hash FROM content_candidates WHERE source_event_id = ?").get(record.event_id);
      if (existing && existing.content_hash !== contentHash) throw new Error("source event has conflicting content records");
      const result = this.db.prepare(`
        INSERT INTO content_candidates(source_event_id, entity_id, content_version, content_hash, owner_id, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_event_id) DO UPDATE SET
          created_at = MIN(content_candidates.created_at, excluded.created_at)
      `).run(record.event_id, record.entity_id, record.content_version, contentHash, record.owner_id, encoded, createdAt);
      if (sourceEvent && sourceEvent.op === "handoff_created") {
        this.#refreshHandoffContent(record.entity_id, this.#eventFromRow(sourceEvent));
      } else {
        this.#refreshProposalContent(record.entity_id);
      }
      if (result.changes) this.recallIndex.markDirty();
      return Boolean(result.changes);
    })();
  }

  contentRecords() {
    return this.#withHandoffExpirySweep(() => this.db.prepare(`
        SELECT source_event_id AS event_id, entity_id, content_version, owner_id, content, created_at
        FROM content_records ORDER BY entity_id, content_version
      `).all().map((record) => ({ ...record, content: this.payloadCodec.decode(record.content) })));
  }

  events() {
    return this.#withHandoffExpirySweep(() =>
      this.db.prepare("SELECT * FROM events ORDER BY rowid").all().map((event) => ({
        ...event,
        payload: parseJson(this.payloadCodec.decode(event.payload), {}),
      })));
  }

  receipts() {
    return this.#withHandoffExpirySweep(() =>
      this.db.prepare("SELECT * FROM receipts ORDER BY created_at, receipt_id").all().map((receipt) => ({
        ...receipt,
        categories: parseJson(receipt.categories, []),
      })));
  }

  status() {
    return this.#withHandoffExpirySweep(() => {
      const counts = Object.fromEntries(this.db.prepare(`
        SELECT memories.category, COUNT(*) AS count
        FROM memories
        JOIN content_records ON content_records.entity_id = memories.proposal_id
          AND content_records.content_version = memories.content_version
        WHERE memories.deleted_at IS NULL
        GROUP BY memories.category
      `).all().map((row) => [row.category, row.count]));
      const clients = this.listClients().map((client) => ({
        ...client,
        grants: this.listGrants(client.client_id).filter((grant) => !grant.revoked_at).map((grant) => ({
          grant_id: grant.grant_id,
          profile: grant.profile_name,
          profile_version: grant.profile_version,
          categories: grant.categories,
        })),
      }));
      return {
        schema_version: Number(this.#meta("schema_version")),
        policy_mode: this.#meta("auto_approve") === "on" ? "auto_approve" : "review",
        store: "local",
        memory_counts: counts,
        clients,
      };
    });
  }

  close() {
    this.db.close();
  }
}
