import { createHash } from "node:crypto";

import {
  MAX_CONTENT_BYTES, SYNC_CAPABILITIES, SYNC_CAPABILITIES_HEADER,
} from "./constants.js";
import { adoptHostedOwnerScopeKey, readHostedLink } from "./hostedLink.js";

// Match the hosted boundary's isUuid: canonical UUID shape is sufficient here.
// Supabase-owned ids are opaque, so the client must not impose an RFC version or
// variant policy that the server itself does not impose.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^(0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const HOSTED_OPS = new Set(["proposal_created", "proposal_approved", "proposal_rejected", "memory_deleted"]);
const HANDOFF_OPS = new Set(["handoff_created", "handoff_claimed", "handoff_expired"]);
const HOSTED_CATEGORIES = new Set(["preference", "fact", "project", "instruction"]);
const BATCH_SIZE = 100;
const MAX_PAGE_ROWS = 100;
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_HOSTED_CONTENT_BYTES = 16 * 1024;
const MAX_STALLED_PAGE_RETRIES = 3;
const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PAGE_KEYS = new Set(["format_version", "cursor", "has_more", "memories", "proposals", "tombstones", "fences"]);
const BASE_ROW_KEYS = [
  "change_seq", "entity_id", "hosted_proposal_id", "hosted_memory_id", "lifecycle_state",
  "category", "origin_connector", "deletion_fence_id", "deleted_entity_version", "occurred_at",
];
const ROW_KEYS = {
  memory: new Set([...BASE_ROW_KEYS, "content", "created_at", "approved_at"]),
  proposal: new Set([...BASE_ROW_KEYS, "content", "created_at", "decided_at"]),
  tombstone: new Set(BASE_ROW_KEYS),
  fence: new Set(BASE_ROW_KEYS),
};
const PROJECT_SCOPE_KEY = "project_scope_ids";
const OUTCOME_KEYS = new Set([
  "event_id", "status", "reason", "retryable", "proposal_id", "memory_id", "winner_event_id",
]);
const TERMINAL_REJECTION_REASONS = new Set([
  "account_fenced", "content_missing", "content_rejected", "decision_conflict", "dependency_rejected",
  "proposal_actor_mismatch", "proposal_not_found", "superseded", "tombstoned",
]);
const PRECLAIM_REJECTION_REASONS = new Set([
  "application_incomplete", "claim_unavailable", "dependency_unavailable", "foreign_owner",
  "foreign_replica", "invalid_event", "memory_locked", "prior_pending",
  "replica_sequence_conflict", "sequence_gap", "unauthorized_event",
]);
const CLAIM_REFUSAL_REASONS = new Set([
  "claim_unavailable", "replica_sequence_conflict", "sequence_gap", "prior_pending",
]);
const RECORDED_REJECTION_REASONS = new Set(["invalid_event"]);
const RECORDED_REJECTION_KEYS = new Set(["event_id", "status", "reason"]);
const DISTINCT_TRANSPORT_STATUSES = new Set([
  "sync_refused", "ack_refused", "invalid_response", "pull_required_loop",
  "hosted_unavailable", "cursor_desync",
]);
// The proposal change trigger records stable pending/approved/rejected states,
// then page hydration replaces that value with the live trust-loop status. The
// only additional observable states are the two decision workers and their
// terminal failure: promoting/rejecting remain pending locally until a later
// pull settles them, while failed is the rejection-equivalent terminal state.
const WIRE_PROPOSAL_STATES = new Set([
  "pending", "promoting", "approved", "rejecting", "rejected", "failed",
]);
const PENDING_PROPOSAL_STATES = new Set(["pending", "promoting", "rejecting"]);
const REJECTED_PROPOSAL_STATES = new Set(["rejected", "failed"]);

class SyncTransportError extends Error {
  constructor(code, missingCapability = null, detail = null) {
    super(code);
    this.name = "SyncTransportError";
    this.code = code;
    this.missingCapability = missingCapability;
    this.detail = detail;
  }
}

const parseJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function deterministicUuid(value) {
  const hex = createHash("sha256").update(String(value)).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function syncKey(link) {
  return createHash("sha256").update(`${link.base_url}\0${link.device_id}`).digest("hex");
}

function initializeSyncTables(repository, link, onAfterUpgradeLock = null) {
  const key = syncKey(link);
  try {
    repository.db.transaction(() => {
      repository.db.exec(`
        CREATE TABLE IF NOT EXISTS hosted_sync_state (
          link_key TEXT PRIMARY KEY,
          download_cursor TEXT NOT NULL,
          bootstrap_complete INTEGER NOT NULL CHECK (bootstrap_complete IN (0, 1)),
          upload_scan_rowid INTEGER NOT NULL CHECK (upload_scan_rowid >= 0),
          next_upload_seq INTEGER NOT NULL CHECK (next_upload_seq >= 1),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hosted_sync_uploads (
          link_key TEXT NOT NULL,
          event_id TEXT NOT NULL,
          source_rowid INTEGER NOT NULL,
          upload_seq INTEGER NOT NULL,
          wire_entity_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'rejected_recorded', 'reemit_evaluated')),
          outcome TEXT,
          reemitted_event_id TEXT,
          PRIMARY KEY (link_key, event_id),
          UNIQUE (link_key, upload_seq)
        );
        CREATE TABLE IF NOT EXISTS hosted_sync_changes (
          link_key TEXT NOT NULL,
          change_seq TEXT NOT NULL,
          kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (link_key, change_seq, kind, entity_id)
        );
        CREATE TABLE IF NOT EXISTS hosted_sync_entities (
          link_key TEXT NOT NULL,
          remote_entity_id TEXT NOT NULL,
          local_proposal_id TEXT,
          local_memory_id TEXT,
          PRIMARY KEY (link_key, remote_entity_id)
        );
        CREATE TABLE IF NOT EXISTS hosted_sync_fences (
          link_key TEXT NOT NULL,
          change_seq TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (link_key, change_seq, entity_id)
        );
      `);
      const uploadTable = repository.db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosted_sync_uploads'
      `).get();
      const uploadColumns = repository.db.prepare("PRAGMA table_info(hosted_sync_uploads)").all();
      const hasReemitLink = uploadColumns.some((column) => column.name === "reemitted_event_id");
      if (!String(uploadTable?.sql || "").includes("reemit_evaluated")) {
        onAfterUpgradeLock?.();
        repository.db.exec("DROP TABLE IF EXISTS hosted_sync_uploads_before_reemit_evaluation");
        repository.db.exec(`
          ALTER TABLE hosted_sync_uploads RENAME TO hosted_sync_uploads_before_reemit_evaluation;
          CREATE TABLE hosted_sync_uploads (
            link_key TEXT NOT NULL,
            event_id TEXT NOT NULL,
            source_rowid INTEGER NOT NULL,
            upload_seq INTEGER NOT NULL,
            wire_entity_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'rejected_recorded', 'reemit_evaluated')),
            outcome TEXT,
            reemitted_event_id TEXT,
            PRIMARY KEY (link_key, event_id),
            UNIQUE (link_key, upload_seq)
          );
        `);
        repository.db.exec(hasReemitLink ? `
          INSERT INTO hosted_sync_uploads(
            link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome, reemitted_event_id
          )
          SELECT link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome, reemitted_event_id
          FROM hosted_sync_uploads_before_reemit_evaluation;
        ` : `
          INSERT INTO hosted_sync_uploads(
            link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome
          )
          SELECT link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome
          FROM hosted_sync_uploads_before_reemit_evaluation;
        `);
        repository.db.exec("DROP TABLE hosted_sync_uploads_before_reemit_evaluation");
      } else if (!hasReemitLink) {
        repository.db.prepare("ALTER TABLE hosted_sync_uploads ADD COLUMN reemitted_event_id TEXT").run();
      }
      repository.db.exec(`
        CREATE INDEX IF NOT EXISTS hosted_sync_uploads_reemit_candidates
        ON hosted_sync_uploads(link_key, upload_seq)
        WHERE state = 'rejected_recorded' AND reemitted_event_id IS NULL
      `);
      repository.db.prepare(`
        INSERT OR IGNORE INTO hosted_sync_state(
          link_key, download_cursor, bootstrap_complete, upload_scan_rowid, next_upload_seq, updated_at
        ) VALUES (?, '0', 0, 0, 1, ?)
      `).run(key, new Date().toISOString());
    }).immediate();
  } catch (error) {
    if (String(error?.code ?? "").startsWith("SQLITE_BUSY")) {
      throw new SyncTransportError("local_sync_unavailable");
    }
    throw error;
  }
  return key;
}

function queueReplay(repository, key, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("replay sequence must be a positive integer within the assigned range");
  }
  const range = repository.db.prepare(`
    SELECT MIN(upload_seq) AS first_seq, MAX(upload_seq) AS last_seq
    FROM hosted_sync_uploads WHERE link_key = ?
  `).get(key);
  if (range.first_seq == null || sequence < range.first_seq || sequence > range.last_seq) {
    throw new Error("replay sequence must be a positive integer within the assigned range");
  }
  return repository.db.prepare(`
    UPDATE hosted_sync_uploads SET state = 'pending', outcome = NULL
    WHERE link_key = ? AND upload_seq >= ?
  `).run(key, sequence).changes;
}

export async function reemitRecordedRejections(repository, key, onAfterDiscovery = null) {
  const rejected = repository.db.prepare(`
    SELECT event_id
    FROM hosted_sync_uploads INDEXED BY hosted_sync_uploads_reemit_candidates
    WHERE link_key = ? AND state = 'rejected_recorded' AND reemitted_event_id IS NULL
    ORDER BY upload_seq
  `).all(key);
  await onAfterDiscovery?.(rejected.map((row) => row.event_id));
  let count = 0;
  for (const candidate of rejected) {
    try {
      const emitted = repository.db.transaction(() => {
        const reserved = repository.db.prepare(`
          UPDATE hosted_sync_uploads SET outcome = 'reemit_reserved'
          WHERE link_key = ? AND event_id = ?
            AND state = 'rejected_recorded' AND reemitted_event_id IS NULL
        `).run(key, candidate.event_id);
        if (reserved.changes !== 1) return null;
        const row = repository.db.prepare(`
          SELECT uploads.*, events.op
          FROM hosted_sync_uploads AS uploads
          JOIN events ON events.event_id = uploads.event_id
          WHERE uploads.link_key = ? AND uploads.event_id = ?
        `).get(key, candidate.event_id);
        if (!row) return null;
        const proposal = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?")
          .get(row.wire_entity_id);
        const tombstoned = Boolean(repository.db.prepare(`
          SELECT 1 FROM tombstones WHERE entity_id = ? OR entity_id = ? LIMIT 1
        `).get(row.wire_entity_id, proposal?.memory_id ?? row.wire_entity_id));
        const latest = repository.db.prepare(`
          SELECT event_id FROM (
            SELECT rowid, event_id FROM events WHERE entity_id = ?
            UNION ALL
            SELECT events.rowid, events.event_id
            FROM memories
            JOIN events ON events.entity_id = memories.memory_id AND events.op = 'memory_deleted'
            WHERE memories.proposal_id = ?
          )
          ORDER BY rowid DESC LIMIT 1
        `).get(row.wire_entity_id, row.wire_entity_id);
        if (tombstoned || latest?.event_id !== row.event_id ||
          !["proposal_created", "proposal_approved"].includes(row.op)) {
          repository.db.prepare(`
            UPDATE hosted_sync_uploads SET state = 'reemit_evaluated', outcome = 'kept'
            WHERE link_key = ? AND event_id = ?
          `).run(key, row.event_id);
          return null;
        }
        const result = repository.reemitProposal(row.wire_entity_id);
        if (!result) {
          repository.db.prepare(`
            UPDATE hosted_sync_uploads SET state = 'reemit_evaluated', outcome = 'kept'
            WHERE link_key = ? AND event_id = ?
          `).run(key, row.event_id);
          return null;
        }
        repository.db.prepare(`
          UPDATE hosted_sync_uploads SET outcome = 'superseded_by_reemit', reemitted_event_id = ?
          WHERE link_key = ? AND event_id = ? AND reemitted_event_id IS NULL
        `).run(result.creation_event_id, key, row.event_id);
        return result;
      }).immediate();
      if (emitted) count += 1;
    } catch (error) {
      if (String(error?.code ?? "").startsWith("SQLITE_BUSY")) {
        throw new SyncTransportError("local_sync_unavailable");
      }
      throw error;
    }
  }
  return count;
}

async function readResponse(response) {
  try {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BODY_BYTES) {
      throw new SyncTransportError("invalid_response");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BODY_BYTES) {
      throw new SyncTransportError("invalid_response");
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyncTransportError) throw error;
    return {};
  }
}

async function hostedRequest(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error" });
  } catch {
    throw new SyncTransportError("network_failure");
  }
  return { response, body: await readResponse(response) };
}

function authorization(link, extra = {}) {
  return { authorization: `Bearer ${link.credential}`, ...extra };
}

function downloadAuthorization(link) {
  return authorization(link, {
    [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
  });
}

function state(repository, key) {
  return repository.db.prepare("SELECT * FROM hosted_sync_state WHERE link_key = ?").get(key);
}

function pendingUploads(repository, key) {
  return repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE link_key = ? AND state = 'pending'
  `).get(key).count;
}

function updateCursor(repository, key, cursor, bootstrapComplete = null) {
  if (bootstrapComplete == null) {
    repository.db.prepare(`
      UPDATE hosted_sync_state SET download_cursor = ?, updated_at = ? WHERE link_key = ?
    `).run(cursor, new Date().toISOString(), key);
  } else {
    repository.db.prepare(`
      UPDATE hosted_sync_state SET download_cursor = ?, bootstrap_complete = ?, updated_at = ? WHERE link_key = ?
    `).run(cursor, bootstrapComplete ? 1 : 0, new Date().toISOString(), key);
  }
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function cursorValue(value) {
  if (typeof value !== "string" || !CURSOR_RE.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_SIGNED_BIGINT ? parsed : null;
  } catch {
    return null;
  }
}

function changeSequenceValue(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const parsed = BigInt(value);
    return parsed <= MAX_SIGNED_BIGINT ? parsed : null;
  }
  return cursorValue(value);
}

function isoInstant(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function nullableUuid(value) {
  return value === null || (typeof value === "string" && UUID_RE.test(value));
}

function boundedContent(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= Math.min(MAX_CONTENT_BYTES, MAX_HOSTED_CONTENT_BYTES);
}

function validateRow(kind, row) {
  const expected = ROW_KEYS[kind];
  const keys = row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : [];
  const scoped = ["memory", "proposal"].includes(kind) && keys.length === expected.size + 1 &&
    keys.every((key) => expected.has(key) || key === PROJECT_SCOPE_KEY) && keys.includes(PROJECT_SCOPE_KEY);
  if ((!exactKeys(row, expected) && !scoped) ||
    (scoped && (!Array.isArray(row.project_scope_ids) || row.project_scope_ids.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(row.project_scope_ids[0]))) ||
    changeSequenceValue(row.change_seq) == null || !UUID_RE.test(row.entity_id) ||
    !nullableUuid(row.hosted_proposal_id) || !nullableUuid(row.hosted_memory_id) ||
    row.origin_connector !== null || !isoInstant(row.occurred_at)) return false;
  if (kind === "memory") {
    return row.lifecycle_state === "approved" && HOSTED_CATEGORIES.has(row.category) &&
      row.hosted_memory_id !== null && row.deletion_fence_id === null && row.deleted_entity_version === null &&
      boundedContent(row.content) && isoInstant(row.created_at) && isoInstant(row.approved_at);
  }
  if (kind === "proposal") {
    const undecided = row.lifecycle_state === "pending";
    const decided = ["promoting", "approved", "rejecting", "rejected", "failed"].includes(row.lifecycle_state);
    return WIRE_PROPOSAL_STATES.has(row.lifecycle_state) &&
      HOSTED_CATEGORIES.has(row.category) && row.hosted_proposal_id !== null &&
      row.deletion_fence_id === null && row.deleted_entity_version === null &&
      (undecided ? boundedContent(row.content) : row.content === null) &&
      isoInstant(row.created_at) && isoInstant(row.decided_at, { nullable: true }) &&
      (undecided ? row.decided_at === null : decided && row.decided_at !== null);
  }
  if (kind === "tombstone") {
    const hosted = row.hosted_memory_id !== null && HOSTED_CATEGORIES.has(row.category);
    const orphan = row.hosted_memory_id === null && row.hosted_proposal_id === null && row.category === null;
    return row.lifecycle_state === "deleted" && (hosted || orphan) && nullableUuid(row.deletion_fence_id) &&
      (row.deleted_entity_version === null || (Number.isSafeInteger(row.deleted_entity_version) && row.deleted_entity_version >= 1)) &&
      (row.deletion_fence_id === null) === (row.deleted_entity_version === null);
  }
  return row.lifecycle_state === "fenced" && row.hosted_proposal_id === null && row.hosted_memory_id === null &&
    row.category === null && row.deletion_fence_id === null && row.deleted_entity_version === null;
}

function validatePage(body, currentCursor) {
  if (!exactKeys(body, PAGE_KEYS) || body.format_version !== 1 || cursorValue(body.cursor) == null ||
    typeof body.has_more !== "boolean" ||
    ![body.memories, body.proposals, body.tombstones, body.fences].every(Array.isArray)) {
    throw new SyncTransportError("invalid_response");
  }
  const groups = [
    ["memory", body.memories], ["proposal", body.proposals],
    ["tombstone", body.tombstones], ["fence", body.fences],
  ];
  const rows = groups.flatMap(([, values]) => values);
  if (rows.length > MAX_PAGE_ROWS || groups.some(([kind, values]) => values.some((row) => !validateRow(kind, row)))) {
    throw new SyncTransportError("invalid_response");
  }
  const before = cursorValue(currentCursor);
  const after = cursorValue(body.cursor);
  if (before == null || after < before) throw new SyncTransportError("invalid_response");
  const sequences = rows.map((row) => changeSequenceValue(row.change_seq));
  if (sequences.some((sequence) => sequence <= before || sequence > after) ||
    new Set(sequences.map(String)).size !== sequences.length ||
    (rows.length > 0 && sequences.every((sequence) => sequence !== after)) ||
    (rows.length === 0 && after !== before)) {
    throw new SyncTransportError("invalid_response");
  }
  // PostgREST serializes bigint result columns as JSON numbers when they are in
  // JavaScript's safe range. Cursors stay decimal strings. Normalize rows to the
  // string form used by SQLite keys and deterministic synthetic-event seeds.
  return {
    ...body,
    memories: body.memories.map((row) => ({ ...row, change_seq: String(row.change_seq) })),
    proposals: body.proposals.map((row) => ({ ...row, change_seq: String(row.change_seq) })),
    tombstones: body.tombstones.map((row) => ({ ...row, change_seq: String(row.change_seq) })),
    fences: body.fences.map((row) => ({ ...row, change_seq: String(row.change_seq) })),
  };
}

function remoteIdentity(row) {
  return String(row.local_entity_id || row.entity_id || "");
}

function syntheticEvent(repository, row, kind, sequence, input) {
  const ownerId = repository.metadata().owner_id;
  const seed = `${row.change_seq}:${kind}:${remoteIdentity(row)}:${sequence}`;
  return {
    format_version: 1,
    event_id: deterministicUuid(`hosted-event:${seed}`),
    entity_id: input.entity_id,
    owner_id: ownerId,
    replica_id: `hosted_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`,
    replica_seq: sequence,
    entity_version: input.entity_version,
    op: input.op,
    actor: input.actor,
    client_id: input.client_id ?? null,
    occurred_at: input.occurred_at,
    save_id: input.save_id ?? null,
    payload: input.payload,
  };
}

function safeInstant(...values) {
  for (const value of values) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function rememberEntity(repository, key, remoteEntityId, proposalId, memoryId) {
  repository.db.prepare(`
    INSERT INTO hosted_sync_entities(link_key, remote_entity_id, local_proposal_id, local_memory_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(link_key, remote_entity_id) DO UPDATE SET
      local_proposal_id = COALESCE(excluded.local_proposal_id, hosted_sync_entities.local_proposal_id),
      local_memory_id = COALESCE(excluded.local_memory_id, hosted_sync_entities.local_memory_id)
  `).run(key, remoteEntityId, proposalId, memoryId);
}

function mappedEntity(repository, key, ...remoteIds) {
  for (const remoteId of remoteIds) {
    if (!UUID_RE.test(String(remoteId || ""))) continue;
    const mapped = repository.db.prepare(`
      SELECT local_proposal_id, local_memory_id FROM hosted_sync_entities
      WHERE link_key = ? AND remote_entity_id = ?
    `).get(key, remoteId);
    if (mapped) return mapped;
    const proposal = repository.db.prepare(`
      SELECT proposal_id AS local_proposal_id, memory_id AS local_memory_id
      FROM proposals WHERE proposal_id = ? OR memory_id = ? LIMIT 1
    `).get(remoteId, remoteId);
    if (proposal) return proposal;
  }
  return null;
}

function rememberAliases(repository, key, row, proposalId, memoryId) {
  const aliases = new Set([remoteIdentity(row), row.hosted_proposal_id, row.hosted_memory_id]);
  for (const alias of aliases) {
    if (UUID_RE.test(String(alias || ""))) rememberEntity(repository, key, alias, proposalId, memoryId);
  }
}

function proposalCreation(repository, proposalId) {
  const row = repository.db.prepare(`
    SELECT events.* FROM events
    JOIN event_applications ON event_applications.event_id = events.event_id
    WHERE events.entity_id = ? AND events.op = 'proposal_created'
    ORDER BY events.event_id LIMIT 1
  `).get(proposalId);
  return row ? { ...row, payload: parseJson(repository.payloadCodec.decode(row.payload)) } : null;
}

function reconcileCanonicalScope(repository, key, proposalId, row) {
  const scope = Array.isArray(row.project_scope_ids) && row.project_scope_ids.length === 1
    ? row.project_scope_ids[0]
    : null;
  return repository.reconcileProposalScope({
    proposalId,
    projectScope: scope,
    authorityKey: key,
    authorityRevision: String(row.change_seq),
  });
}

function clearEarlierRemoteTombstones(repository, key, row, memoryId) {
  const remoteEntityId = remoteIdentity(row);
  const tombstones = repository.db.prepare(`
    SELECT change_seq, entity_id FROM hosted_sync_changes
    WHERE link_key = ? AND kind = 'tombstone' AND entity_id = ?
  `).all(key, remoteEntityId);
  for (const tombstone of tombstones) {
    const eventId = deterministicUuid(
      `hosted-event:${tombstone.change_seq}:tombstone:${tombstone.entity_id}:1`,
    );
    // Events remain append-only evidence. Removing their derived version and
    // application rows makes the later hosted restore authoritative without
    // weakening account-fence deletions or an unrelated local tombstone.
    repository.db.prepare("DELETE FROM event_versions WHERE event_id = ?").run(eventId);
    repository.db.prepare("DELETE FROM event_applications WHERE event_id = ?").run(eventId);
    repository.db.prepare("DELETE FROM event_supersessions WHERE event_id = ?").run(eventId);
  }
  if (!tombstones.length) return;
  repository.db.prepare("DELETE FROM tombstones WHERE entity_id = ?").run(memoryId);
  repository.db.prepare("DELETE FROM deletion_fences WHERE entity_id = ?").run(memoryId);
  repository.db.prepare("UPDATE memories SET deleted_at = NULL WHERE memory_id = ?").run(memoryId);
  repository.db.prepare(`
    DELETE FROM content_supersessions
    WHERE reason = 'memory_deleted'
      AND source_event_id IN (
        SELECT content_candidates.source_event_id FROM content_candidates
        JOIN proposals ON proposals.proposal_id = content_candidates.entity_id
        WHERE proposals.memory_id = ?
      )
  `).run(memoryId);
  repository.db.prepare(`
    INSERT OR REPLACE INTO content_records(
      source_event_id, entity_id, content_version, owner_id, content, created_at
    )
    SELECT candidate.source_event_id, candidate.entity_id, candidate.content_version,
      candidate.owner_id, candidate.content, candidate.created_at
    FROM content_candidates AS candidate
    JOIN proposals ON proposals.proposal_id = candidate.entity_id
    JOIN event_applications ON event_applications.event_id = candidate.source_event_id
    WHERE proposals.memory_id = ? AND candidate.content_version = proposals.content_version
    ORDER BY candidate.source_event_id LIMIT 1
  `).run(memoryId);
  repository.recallIndex.markDirty();
}

function addRemoteProposal(repository, key, row, { approve }) {
  const remoteEntityId = remoteIdentity(row);
  const mapped = mappedEntity(repository, key, row.hosted_proposal_id, remoteEntityId, row.hosted_memory_id);
  let proposalId = mapped?.local_proposal_id ?? null;
  let proposal = proposalId
    ? repository.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId)
    : null;
  if (!proposalId) {
    proposalId = row.hosted_memory_id === remoteEntityId
      ? deterministicUuid(`hosted-proposal:${remoteEntityId}`)
      : remoteEntityId;
    proposal = repository.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
  }
  let memoryId = approve ? String(row.hosted_memory_id || "") : null;
  if (approve && (!UUID_RE.test(memoryId) || memoryId === proposalId)) {
    memoryId = deterministicUuid(`hosted-memory:${remoteEntityId}`);
  }
  if (approve) {
    clearEarlierRemoteTombstones(repository, key, row, memoryId);
    const creation = proposal ? proposalCreation(repository, proposalId) : null;
    if (creation && boundedContent(row.content)) {
      // A hosted restore carries the authoritative content again. Local
      // deletion deliberately erased its candidate, so re-admit that exact
      // creation record before refreshing the restored projection.
      repository.ingestContentRecord({
        event_id: creation.event_id,
        entity_id: proposalId,
        content_version: proposal.content_version,
        owner_id: repository.metadata().owner_id,
        content: row.content,
        created_at: safeInstant(row.created_at, row.occurred_at),
      });
    }
  }
  const occurredAt = safeInstant(row.occurred_at, row.created_at);
  const saveId = `sync.${createHash("sha256").update(remoteEntityId).digest("hex").slice(0, 48)}`;
  let changed = false;
  if (!proposal) {
    const creation = syntheticEvent(repository, row, "proposal_created", 1, {
      entity_id: proposalId,
      entity_version: 1,
      op: "proposal_created",
      actor: "owner",
      occurred_at: occurredAt,
      save_id: saveId,
      payload: {
        category: row.category,
        content_version: 1,
        disposition: approve ? "auto_approved" : "pending",
        evidence_basis: "direct_user_save",
        occurred_at: occurredAt,
        project_scope: Array.isArray(row.project_scope_ids) && row.project_scope_ids.length === 1
          ? row.project_scope_ids[0]
          : null,
        source: "hosted-sync",
      },
    });
    repository.ingestEvent(creation);
    repository.ingestContentRecord({
      event_id: creation.event_id,
      entity_id: proposalId,
      content_version: 1,
      owner_id: repository.metadata().owner_id,
      content: row.content,
      created_at: safeInstant(row.created_at, occurredAt),
    });
    proposal = repository.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    changed = true;
  }
  if (approve && proposal?.status === "pending") {
    const creation = proposalCreation(repository, proposalId);
    const approval = syntheticEvent(repository, row, "proposal_approved", 2, {
      entity_id: proposalId,
      entity_version: 2,
      op: "proposal_approved",
      actor: "owner",
      occurred_at: safeInstant(row.approved_at, row.occurred_at, row.created_at),
      save_id: proposal.save_id,
      payload: {
        content_version: proposal.content_version,
        decision_id: deterministicUuid(`hosted-decision:${row.change_seq}:${proposalId}`),
        memory_id: memoryId,
        via: "owner_review",
      },
    });
    if (creation && repository.ingestEvent(approval)) changed = true;
  }
  const current = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?").get(proposalId);
  // The hosted row is the canonical projection. Apply rows in change_seq order
  // (applyPage's commit-visible order), including entities that already existed
  // locally, so an earlier local scope cannot survive a later hosted correction.
  if (reconcileCanonicalScope(repository, key, proposalId, row)) changed = true;
  rememberAliases(repository, key, row, proposalId, current?.memory_id ?? memoryId);
  return changed ? 1 : 0;
}

function rejectRemoteProposal(repository, key, row) {
  const remoteEntityId = remoteIdentity(row);
  const mapped = mappedEntity(repository, key, row.hosted_proposal_id, remoteEntityId, row.hosted_memory_id);
  const proposalId = mapped?.local_proposal_id || remoteEntityId;
  const proposal = repository.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
  if (!proposal) return 0;
  rememberAliases(repository, key, row, proposalId, proposal.memory_id);
  if (proposal.status === "rejected") return 0;
  const rejection = syntheticEvent(repository, row, "proposal_rejected", 1, {
    entity_id: proposalId,
    entity_version: 3,
    op: "proposal_rejected",
    actor: "owner",
    occurred_at: safeInstant(row.decided_at, row.occurred_at),
    save_id: proposal.save_id,
    payload: {
      decision_id: deterministicUuid(`hosted-rejection:${row.change_seq}:${proposalId}`),
      via: "owner_review",
    },
  });
  repository.ingestEvent(rejection);
  return 1;
}

function keepRemoteProposalPending(repository, key, row) {
  if (boundedContent(row.content)) return addRemoteProposal(repository, key, row, { approve: false });
  const remoteEntityId = remoteIdentity(row);
  const mapped = mappedEntity(repository, key, row.hosted_proposal_id, remoteEntityId, row.hosted_memory_id);
  const proposalId = mapped?.local_proposal_id || remoteEntityId;
  const proposal = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?").get(proposalId);
  if (proposal) rememberAliases(repository, key, row, proposalId, proposal.memory_id);
  // The live worker states are content-free. If this replica did not observe
  // the earlier pending row, it cannot invent proposal text; the later stable
  // approved/rejected change completes the projection on a subsequent pull.
  return 0;
}

function applyRemoteTombstone(repository, key, row) {
  const remoteEntityId = remoteIdentity(row);
  const mapped = mappedEntity(repository, key, row.hosted_proposal_id, remoteEntityId, row.hosted_memory_id);
  const proposal = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?").get(
    mapped?.local_proposal_id || remoteEntityId,
  );
  const hostedMemory = typeof row.hosted_memory_id === "string" ? row.hosted_memory_id : null;
  const knownMemory = hostedMemory
    ? repository.db.prepare("SELECT memory_id FROM memories WHERE memory_id = ?").get(hostedMemory)?.memory_id
    : null;
  const memoryId = mapped?.local_memory_id || proposal?.memory_id || knownMemory || hostedMemory || remoteEntityId;
  if (!memoryId) return 0;
  rememberAliases(repository, key, row, mapped?.local_proposal_id || null, memoryId);
  if (repository.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(memoryId)) return 0;
  const deletion = syntheticEvent(repository, row, "memory_deleted", 1, {
    entity_id: memoryId,
    entity_version: Number.isSafeInteger(row.deleted_entity_version) && row.deleted_entity_version > 0
      ? row.deleted_entity_version
      : 1,
    op: "memory_deleted",
    actor: "owner",
    occurred_at: safeInstant(row.occurred_at),
    payload: {},
  });
  repository.ingestEvent(deletion);
  return 1;
}

function applyAccountFence(repository, key, row) {
  const existing = repository.db.prepare(`
    SELECT 1 FROM hosted_sync_fences WHERE link_key = ? AND change_seq = ? AND entity_id = ?
  `).get(key, String(row.change_seq), String(row.entity_id));
  if (existing) return 0;
  const memories = repository.db.prepare(`
    SELECT memory_id FROM memories WHERE deleted_at IS NULL ORDER BY memory_id
  `).all();
  for (const [index, memory] of memories.entries()) {
    const deletion = syntheticEvent(repository, row, "account_fence_memory", index + 1, {
      entity_id: memory.memory_id,
      entity_version: 1,
      op: "memory_deleted",
      actor: "owner",
      occurred_at: safeInstant(row.occurred_at),
      payload: {},
    });
    repository.ingestEvent(deletion);
  }
  const pending = repository.db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY proposal_id").all();
  for (const [index, proposal] of pending.entries()) {
    const rejection = syntheticEvent(repository, row, "account_fence_proposal", memories.length + index + 1, {
      entity_id: proposal.proposal_id,
      entity_version: 3,
      op: "proposal_rejected",
      actor: "owner",
      occurred_at: safeInstant(row.occurred_at),
      save_id: proposal.save_id,
      payload: {
        decision_id: deterministicUuid(`account-fence:${row.change_seq}:${proposal.proposal_id}`),
        via: "owner_review",
      },
    });
    repository.ingestEvent(rejection);
  }
  repository.db.prepare("DELETE FROM content_records").run();
  repository.db.prepare("DELETE FROM content_candidates").run();
  repository.db.prepare(`
    INSERT INTO hosted_sync_fences(link_key, change_seq, entity_id, applied_at) VALUES (?, ?, ?, ?)
  `).run(key, String(row.change_seq), String(row.entity_id), new Date().toISOString());
  repository.recallIndex.markDirty();
  return 1;
}

function applyChange(repository, key, kind, row) {
  if (!row || changeSequenceValue(row.change_seq) == null || !UUID_RE.test(remoteIdentity(row))) {
    throw new SyncTransportError("invalid_response");
  }
  if (kind === "memory") return addRemoteProposal(repository, key, row, { approve: true });
  if (kind === "proposal") {
    if (PENDING_PROPOSAL_STATES.has(row.lifecycle_state)) return keepRemoteProposalPending(repository, key, row);
    // A failed promotion/rejection is terminal on the hosted trust loop. The
    // local reducer records the closed, content-free `proposal_rejected`
    // supersession reason; hosted engine or proposal text never enters metadata.
    if (REJECTED_PROPOSAL_STATES.has(row.lifecycle_state)) return rejectRemoteProposal(repository, key, row);
    return 0;
  }
  if (kind === "tombstone") return applyRemoteTombstone(repository, key, row);
  return applyAccountFence(repository, key, row);
}

function applyPage(repository, key, page, summary) {
  const groups = [
    ["memory", page.memories],
    ["proposal", page.proposals],
    ["tombstone", page.tombstones],
    ["fence", page.fences],
  ];
  const ordered = groups.flatMap(([kind, rows]) => rows.map((row) => ({ kind, row })))
    .sort((left, right) => {
      const leftSequence = changeSequenceValue(left.row.change_seq);
      const rightSequence = changeSequenceValue(right.row.change_seq);
      return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
    });
  const pageSummary = { pulled: 0, applied: 0, tombstones: 0 };
  repository.db.transaction(() => {
    for (const { kind, row } of ordered) {
      pageSummary.pulled += 1;
      const entityId = remoteIdentity(row);
      if (repository.db.prepare(`
        SELECT 1 FROM hosted_sync_changes
        WHERE link_key = ? AND change_seq = ? AND kind = ? AND entity_id = ?
      `).get(key, String(row.change_seq), kind, entityId)) continue;
      pageSummary.applied += applyChange(repository, key, kind, row);
      if (kind === "tombstone") pageSummary.tombstones += 1;
      repository.db.prepare(`
        INSERT INTO hosted_sync_changes(link_key, change_seq, kind, entity_id, applied_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, String(row.change_seq), kind, entityId, new Date().toISOString());
    }
  })();
  summary.pulled += pageSummary.pulled;
  summary.applied += pageSummary.applied;
  summary.tombstones += pageSummary.tombstones;
}

async function pullAll({ repository, link, key, fetchImpl, summary }) {
  let stalledPages = 0;
  for (;;) {
    const current = state(repository, key);
    const snapshot = !current.bootstrap_complete;
    const path = snapshot
      ? "/sync/v1/snapshot"
      : `/sync/v1/changes?cursor=${encodeURIComponent(current.download_cursor)}`;
    const { response, body } = await hostedRequest(fetchImpl, `${link.base_url}${path}`, {
      headers: downloadAuthorization(link),
    });
    if (response.status === 409 && body.error === "cursor_not_current") {
      const reconciled = cursorValue(body.cursor);
      const local = cursorValue(current.download_cursor);
      if (reconciled == null || local == null) throw new SyncTransportError("invalid_response");
      if (reconciled === local) throw new SyncTransportError("sync_refused");
      const detail = { local_cursor: String(local), server_cursor: String(reconciled) };
      if (reconciled < local) throw new SyncTransportError("cursor_desync", null, detail);
      const changes = repository.db.prepare(`
        SELECT DISTINCT change_seq FROM hosted_sync_changes
        WHERE link_key = ?
          AND CAST(change_seq AS INTEGER) > CAST(? AS INTEGER)
          AND CAST(change_seq AS INTEGER) <= CAST(? AS INTEGER)
        ORDER BY CAST(change_seq AS INTEGER)
      `).all(key, String(local), String(reconciled));
      let expected = local + 1n;
      for (const change of changes) {
        if (cursorValue(change.change_seq) !== expected) {
          throw new SyncTransportError("cursor_desync", null, detail);
        }
        expected += 1n;
      }
      if (expected !== reconciled + 1n) throw new SyncTransportError("cursor_desync", null, detail);
      updateCursor(repository, key, String(reconciled), current.bootstrap_complete === 1);
      summary.new_cursor = String(reconciled);
      continue;
    }
    if (response.status === 403 && body.error === "sync_device_not_approved") throw new SyncTransportError("not_approved");
    if (
      response.status === 426 && body.error === "upgrade_required"
      && exactKeys(body, new Set(["error", "missing_capability"]))
      && CAPABILITY_RE.test(String(body.missing_capability || ""))
    ) {
      throw new SyncTransportError("upgrade_required", body.missing_capability);
    }
    if (response.status !== 200) throw new SyncTransportError(response.status >= 500 ? "hosted_unavailable" : "sync_refused");
    const page = validatePage(body, current.download_cursor);
    if (page.has_more && page.cursor === current.download_cursor) {
      stalledPages += 1;
      if (stalledPages >= MAX_STALLED_PAGE_RETRIES) throw new SyncTransportError("invalid_response");
      continue;
    }
    stalledPages = 0;
    applyPage(repository, key, page, summary);
    let acknowledged;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        acknowledged = await hostedRequest(fetchImpl, `${link.base_url}/sync/v1/ack`, {
          method: "POST",
          headers: authorization(link, { "content-type": "application/json" }),
          body: JSON.stringify({ cursor: page.cursor }),
        });
      } catch (error) {
        if (attempt === 0 && error instanceof SyncTransportError && error.code === "network_failure") continue;
        throw error;
      }
      if (attempt === 0 && acknowledged.response.status >= 500) continue;
      break;
    }
    if (acknowledged.response.status !== 200 || acknowledged.body.ok !== true || String(acknowledged.body.cursor) !== page.cursor) {
      throw new SyncTransportError(acknowledged.response.status >= 500 ? "hosted_unavailable" : "ack_refused");
    }
    updateCursor(repository, key, page.cursor, snapshot && !page.has_more ? true : current.bootstrap_complete === 1);
    summary.new_cursor = page.cursor;
    if (!page.has_more) return;
  }
}

function localEvent(repository, row) {
  return { ...row, payload: parseJson(repository.payloadCodec.decode(row.payload)) };
}

function uploadShape(repository, link, mapped) {
  const raw = repository.db.prepare("SELECT rowid, * FROM events WHERE event_id = ?").get(mapped.event_id);
  if (!raw) return null;
  const event = localEvent(repository, raw);
  const base = {
    format_version: 1,
    event_id: event.event_id,
    entity_id: mapped.wire_entity_id,
    owner_id: event.owner_id,
    replica_id: link.device_id,
    replica_seq: mapped.upload_seq,
    entity_version: event.entity_version,
    op: event.op,
    actor: event.actor,
    client_id: event.client_id,
    occurred_at: event.occurred_at,
    save_id: event.save_id,
    payload: {},
  };
  if (event.op === "proposal_created") {
    const record = repository.db.prepare(`
      SELECT * FROM content_records WHERE source_event_id = ? AND entity_id = ?
    `).get(event.event_id, event.entity_id);
    base.actor = event.actor;
    base.client_id = event.client_id ?? null;
    base.payload = {
      category: event.payload.category,
      context_profile: "coding",
      profile_version: 1,
      project_scope_ids: event.payload.project_scope ? [event.payload.project_scope] : [],
      content_ref: { entity_id: mapped.wire_entity_id, content_version: event.payload.content_version },
    };
    return {
      event: base,
      content: record ? {
        entity_id: mapped.wire_entity_id,
        content_version: event.payload.content_version,
        content: repository.payloadCodec.decode(record.content),
        created_at: record.created_at,
        occurred_at: event.payload.occurred_at,
      } : null,
    };
  }
  if (event.op === "proposal_approved") {
    const proposal = repository.db.prepare("SELECT client_id, save_id FROM proposals WHERE proposal_id = ?").get(event.entity_id);
    if (!proposal) return null;
    base.actor = "owner";
    base.client_id = proposal.client_id ?? null;
    base.save_id = proposal.save_id;
    base.payload = { via: event.payload.via === "auto_approval_policy" ? "auto_approval_policy" : "owner_decision" };
  } else if (event.op === "proposal_rejected") {
    const proposal = repository.db.prepare("SELECT client_id, save_id FROM proposals WHERE proposal_id = ?").get(event.entity_id);
    if (!proposal) return null;
    base.actor = "owner";
    base.client_id = proposal.client_id ?? null;
    base.save_id = proposal.save_id;
    base.payload = { tombstone_version: Math.max(1, event.entity_version) };
  } else {
    base.actor = "owner";
    base.client_id = null;
    base.save_id = null;
    base.payload = {
      deletion_fence_id: deterministicUuid(`deletion-fence:${event.event_id}`),
      deleted_entity_version: Math.max(1, event.entity_version),
    };
  }
  return { event: base, content: null };
}

function wireEntityId(repository, event) {
  if (event.op !== "memory_deleted") return event.entity_id;
  return repository.db.prepare("SELECT proposal_id FROM memories WHERE memory_id = ?").get(event.entity_id)?.proposal_id || event.entity_id;
}

function uploadCategory(repository, event) {
  if (event.op === "proposal_created") return event.payload?.category ?? null;
  const entityId = wireEntityId(repository, event);
  return repository.db.prepare("SELECT category FROM proposals WHERE proposal_id = ?").get(entityId)?.category ?? null;
}

function uploadCompatible(repository, event) {
  if (!HOSTED_OPS.has(event.op) || !HOSTED_CATEGORIES.has(uploadCategory(repository, event)) ||
    !UUID_RE.test(event.event_id) || !UUID_RE.test(wireEntityId(repository, event))) return false;
  if (event.op === "proposal_created") {
    return ((event.actor === "client" && UUID_RE.test(String(event.client_id || ""))) ||
      (event.actor === "owner" && event.client_id == null)) &&
      Boolean(repository.db.prepare("SELECT 1 FROM content_records WHERE source_event_id = ?").get(event.event_id));
  }
  if (["proposal_approved", "proposal_rejected"].includes(event.op)) {
    const proposal = repository.db.prepare("SELECT client_id FROM proposals WHERE proposal_id = ?").get(event.entity_id);
    return Boolean(proposal) && (proposal.client_id == null || UUID_RE.test(String(proposal.client_id)));
  }
  return true;
}

function assignUploads(repository, link, key, summary) {
  const pending = repository.db.prepare(`
    SELECT * FROM hosted_sync_uploads WHERE link_key = ? AND state = 'pending' ORDER BY upload_seq LIMIT ?
  `).all(key, BATCH_SIZE);
  if (pending.length) return pending;
  repository.db.transaction(() => {
    let current = state(repository, key);
    let assigned = 0;
    const selectRows = repository.db.prepare(`
      SELECT rowid, * FROM events
      WHERE replica_id = ? AND rowid > ? ORDER BY rowid LIMIT 500
    `);
    const replicaId = repository.metadata().replica_id;
    while (assigned < BATCH_SIZE) {
      const rows = selectRows.all(replicaId, current.upload_scan_rowid);
      if (!rows.length) break;
      for (const raw of rows) {
        const event = localEvent(repository, raw);
        if (HANDOFF_OPS.has(event.op)) summary.skipped_handoffs += 1;
        if (!uploadCompatible(repository, event)) {
          summary.skipped += 1;
          repository.db.prepare("UPDATE hosted_sync_state SET upload_scan_rowid = ?, updated_at = ? WHERE link_key = ?")
            .run(raw.rowid, new Date().toISOString(), key);
          current = { ...current, upload_scan_rowid: raw.rowid };
          continue;
        }
        const wireEntity = wireEntityId(repository, event);
        repository.db.prepare(`
          INSERT OR IGNORE INTO hosted_sync_uploads(
            link_key, event_id, source_rowid, upload_seq, wire_entity_id, state
          ) VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(key, event.event_id, raw.rowid, current.next_upload_seq, wireEntity);
        repository.db.prepare(`
          UPDATE hosted_sync_state
          SET upload_scan_rowid = ?, next_upload_seq = ?, updated_at = ? WHERE link_key = ?
        `).run(raw.rowid, current.next_upload_seq + 1, new Date().toISOString(), key);
        current = { ...current, upload_scan_rowid: raw.rowid, next_upload_seq: current.next_upload_seq + 1 };
        assigned += 1;
        if (assigned >= BATCH_SIZE) break;
      }
    }
  })();
  return repository.db.prepare(`
    SELECT * FROM hosted_sync_uploads WHERE link_key = ? AND state = 'pending' ORDER BY upload_seq LIMIT ?
  `).all(key, BATCH_SIZE);
}

function isRecordedRejection(outcome) {
  return exactKeys(outcome, RECORDED_REJECTION_KEYS) && outcome.event_id === null &&
    outcome.status === "rejected" && typeof outcome.reason === "string" &&
    RECORDED_REJECTION_REASONS.has(outcome.reason);
}

function validateOutcome(outcome, mapped) {
  if (isRecordedRejection(outcome)) return true;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) ||
    Object.keys(outcome).some((key) => !OUTCOME_KEYS.has(key)) || outcome.event_id !== mapped.event_id ||
    !["accepted", "duplicate", "rejected"].includes(outcome.status)) return false;
  for (const name of ["proposal_id", "memory_id", "winner_event_id"]) {
    if (Object.hasOwn(outcome, name) && !UUID_RE.test(String(outcome[name] || ""))) return false;
  }
  if (Object.hasOwn(outcome, "retryable") && outcome.retryable !== true) return false;
  if (outcome.status === "accepted") {
    return !Object.hasOwn(outcome, "retryable") &&
      (!Object.hasOwn(outcome, "winner_event_id") || outcome.winner_event_id === mapped.event_id) &&
      (!Object.hasOwn(outcome, "reason") || outcome.reason === "save_id_duplicate");
  }
  if (outcome.status === "duplicate") {
    return !Object.hasOwn(outcome, "retryable") && !Object.hasOwn(outcome, "winner_event_id") &&
      (!Object.hasOwn(outcome, "reason") || outcome.reason === "save_id_duplicate");
  }
  if (typeof outcome.reason !== "string" ||
    (!TERMINAL_REJECTION_REASONS.has(outcome.reason) && !PRECLAIM_REJECTION_REASONS.has(outcome.reason))) return false;
  if (PRECLAIM_REJECTION_REASONS.has(outcome.reason)) return outcome.retryable === true ||
    ["foreign_owner", "foreign_replica", "invalid_event", "unauthorized_event"].includes(outcome.reason);
  return !Object.hasOwn(outcome, "retryable") &&
    (outcome.reason === "superseded" || !Object.hasOwn(outcome, "winner_event_id"));
}

function finishRecordedRejection(repository, key, mapped, outcome, summary) {
  summary.rejected += 1;
  repository.db.prepare(`
    UPDATE hosted_sync_uploads SET state = 'rejected_recorded', outcome = ? WHERE link_key = ? AND event_id = ?
  `).run(outcome.reason, key, mapped.event_id);
}

function rememberOutcomeAliases(repository, key, mapped, outcome) {
  const proposal = repository.db.prepare(`
    SELECT proposal_id, memory_id FROM proposals WHERE proposal_id = ?
  `).get(mapped.wire_entity_id);
  if (!proposal) return;
  for (const alias of [outcome.proposal_id, outcome.memory_id]) {
    if (UUID_RE.test(String(alias || ""))) {
      rememberEntity(repository, key, alias, proposal.proposal_id, proposal.memory_id);
    }
  }
}

function finishOutcome(repository, key, mapped, outcome, summary) {
  const reason = String(outcome?.reason || "");
  if (["accepted", "duplicate"].includes(outcome?.status)) {
    summary.pushed += 1;
  } else if (reason === "superseded" || reason === "tombstoned") {
    summary.superseded += 1;
    if (reason === "superseded") {
      summary.conflicts += 1;
      summary.conflict_rows.push({
        event_id: mapped.event_id,
        entity_id: mapped.wire_entity_id,
        winner_event_id: UUID_RE.test(String(outcome.winner_event_id || "")) ? outcome.winner_event_id : null,
      });
    }
  } else {
    summary.conflicts += 1;
    summary.conflict_rows.push({ event_id: mapped.event_id, entity_id: mapped.wire_entity_id, winner_event_id: null });
  }
  if (reason === "content_rejected") {
    const proposal = repository.db.prepare(`
      SELECT category, created_at FROM proposals WHERE proposal_id = ?
    `).get(mapped.wire_entity_id);
    summary.content_rejected_rows.push({
      event_id: mapped.event_id,
      entity_id: mapped.wire_entity_id,
      category: proposal?.category ?? null,
      created_at: proposal?.created_at ?? null,
    });
  }
  repository.db.prepare(`
    UPDATE hosted_sync_uploads SET state = 'complete', outcome = ? WHERE link_key = ? AND event_id = ?
  `).run(outcome?.status === "duplicate" ? "duplicate" : reason || outcome?.status || "rejected", key, mapped.event_id);
  rememberOutcomeAliases(repository, key, mapped, outcome);
}

async function pushAll({ repository, link, key, fetchImpl, summary, onAfterUploadResponse }) {
  let pullRequiredLoops = 0;
  for (;;) {
    const mapped = assignUploads(repository, link, key, summary);
    if (!mapped.length) break;
    const shaped = mapped.map((row) => uploadShape(repository, link, row));
    if (shaped.some((row) => !row)) throw new SyncTransportError("local_sync_state_invalid");
    const contentRecords = shaped.map((row) => row.content).filter(Boolean);
    const result = await hostedRequest(fetchImpl, `${link.base_url}/sync/v1/events`, {
      method: "POST",
      headers: authorization(link, { "content-type": "application/json" }),
      body: JSON.stringify({ events: shaped.map((row) => row.event), content_records: contentRecords }),
    });
    if (result.response.status === 409 && result.body.error === "pull_required") {
      pullRequiredLoops += 1;
      if (pullRequiredLoops > 8) throw new SyncTransportError("pull_required_loop");
      await pullAll({ repository, link, key, fetchImpl, summary });
      continue;
    }
    if (result.response.status === 403 && result.body.error === "sync_device_not_approved") throw new SyncTransportError("not_approved");
    if (result.response.status !== 200 || !exactKeys(result.body, new Set(["outcomes", "upload_seq"])) ||
      !Array.isArray(result.body.outcomes)) {
      throw new SyncTransportError(result.response.status >= 500 ? "hosted_unavailable" : "sync_refused");
    }
    const uploadSeq = result.body.upload_seq;
    const outcomes = result.body.outcomes;
    let lastClaimed = -1;
    for (let index = 0; index < outcomes.length; index += 1) {
      if (!CLAIM_REFUSAL_REASONS.has(outcomes[index]?.reason)) lastClaimed = index;
    }
    if (!Number.isSafeInteger(uploadSeq) || uploadSeq < 0 || outcomes.length < 1 || outcomes.length > mapped.length ||
      outcomes.some((outcome, index) => !validateOutcome(outcome, mapped[index])) ||
      (lastClaimed >= 0 && uploadSeq !== mapped[lastClaimed].upload_seq)) {
      throw new SyncTransportError("invalid_response");
    }
    await onAfterUploadResponse?.({ mapped, outcomes });
    repository.db.transaction(() => {
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        if (outcome.retryable === true) continue;
        if (isRecordedRejection(outcome)) finishRecordedRejection(repository, key, mapped[index], outcome, summary);
        else finishOutcome(repository, key, mapped[index], outcome, summary);
      }
    })();
    if (outcomes.length < mapped.length || outcomes.some((outcome) => outcome.retryable === true)) break;
  }
  summary.pending = pendingUploads(repository, key);
}

export function emptySyncSummary(status = "ok") {
  return {
    status,
    pulled: 0,
    applied: 0,
    tombstones: 0,
    pushed: 0,
    pending: 0,
    rejected: 0,
    reemitted: 0,
    replay_queued: 0,
    superseded: 0,
    conflicts: 0,
    skipped: 0,
    skipped_handoffs: 0,
    new_cursor: "0",
    conflict_rows: [],
    content_rejected_rows: [],
    failure_detail: null,
  };
}

export function syncFailureMessage(result) {
  if (result?.status === "unlinked") return "Switchboard is not linked.";
  if (result?.status === "network_failure") return "Switchboard could not reach the linked Passport.";
  if (result?.status === "not_approved") return "The linked sync device is not approved.";
  if (result?.status === "upgrade_required") {
    return `Upgrade Switchboard to continue hosted sync. Required capability: ${result.missing_capability}.`;
  }
  if (result?.status === "sync_refused") return "The hosted plane refused the sync request.";
  if (result?.status === "ack_refused") return "The hosted plane refused the cursor acknowledgement.";
  if (result?.status === "invalid_response") {
    return "The hosted plane answered with a response shape this Switchboard client does not recognize.";
  }
  if (result?.status === "pull_required_loop") return "Hosted sync push kept being fenced behind pulls.";
  if (result?.status === "hosted_unavailable") return "The hosted plane answered with server errors.";
  if (result?.status === "cursor_desync") {
    const local = result.failure_detail?.local_cursor ?? "unknown";
    const server = result.failure_detail?.server_cursor ?? "unknown";
    return `Hosted sync cursors have diverged (local ${local}, server ${server}). Run switchboard sync --replay-from ${local} or contact support.`;
  }
  return "Hosted sync is unavailable.";
}

export async function syncOnce({
  repository,
  fetchImpl = globalThis.fetch,
  onAfterUploadResponse = null,
  onAfterReemitDiscovery = null,
  onAfterSyncUpgradeLock = null,
  replayFrom = null,
} = {}) {
  const summary = emptySyncSummary();
  let link;
  try {
    link = readHostedLink(repository.home);
  } catch {
    return { ...summary, status: "invalid_link" };
  }
  if (!link) return { ...summary, status: "unlinked" };
  if (link.status !== "approved") return { ...summary, status: "not_approved" };
  if (!repository.hasOwnerScopeKey()) {
    try {
      await adoptHostedOwnerScopeKey({ repository, record: link, fetchImpl });
    } catch (error) {
      return {
        ...summary,
        status: error?.code === "network_failure" ? "network_failure" :
          error?.code === "link_refused" ? "not_approved" : "unavailable",
      };
    }
  }
  let key;
  try {
    key = initializeSyncTables(repository, link, onAfterSyncUpgradeLock);
  } catch (error) {
    if (error instanceof SyncTransportError) return { ...summary, status: "unavailable" };
    throw error;
  }
  if (replayFrom != null) summary.replay_queued = queueReplay(repository, key, replayFrom);
  summary.new_cursor = state(repository, key).download_cursor;
  try {
    summary.reemitted = await reemitRecordedRejections(repository, key, onAfterReemitDiscovery);
    await pullAll({ repository, link, key, fetchImpl, summary });
    await pushAll({ repository, link, key, fetchImpl, summary, onAfterUploadResponse });
    summary.new_cursor = state(repository, key).download_cursor;
    return summary;
  } catch (error) {
    const status = error?.code === "network_failure" ? "network_failure" :
      error?.code === "not_approved" ? "not_approved" :
      error?.code === "upgrade_required" ? "upgrade_required" :
      error instanceof SyncTransportError && DISTINCT_TRANSPORT_STATUSES.has(error.code) ? error.code : "unavailable";
    summary.status = status;
    summary.pending = pendingUploads(repository, key);
    summary.failure_detail = error instanceof SyncTransportError ? error.detail : null;
    summary.new_cursor = state(repository, key).download_cursor;
    return status === "upgrade_required"
      ? { ...summary, missing_capability: error.missingCapability }
      : summary;
  }
}
