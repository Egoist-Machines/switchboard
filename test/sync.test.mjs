import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  forgetHostedLink, hostedCredentialHash, linkHosted, openHostedLinkUrl, pendingLinkPath,
  writeHostedLink, writePendingHostedLink,
} from "../src/hostedLink.js";
import { LocalRepository } from "../src/repository.js";
import { reemitRecordedRejections, syncFailureMessage, syncOnce } from "../src/sync.js";
import { SYNC_CAPABILITIES, SYNC_CAPABILITIES_HEADER } from "../src/constants.js";
import { temporaryHome } from "./helpers.mjs";

const localSyncRoutesUrl = new URL("../../../lib/localSyncRoutes.js", import.meta.url);
const hasMonorepoServer = existsSync(localSyncRoutesUrl);
const expressModule = hasMonorepoServer ? await import("express") : null;
const localSyncRoutesModule = hasMonorepoServer ? await import("../../../lib/localSyncRoutes.js") : null;
const storeModule = hasMonorepoServer ? await import("../../../lib/store.js") : null;
const trustLoopModule = hasMonorepoServer ? await import("../../../lib/trustLoop.js") : null;
const harnessModule = hasMonorepoServer ? await import("../../../scripts/_harness.mjs") : null;
const express = expressModule?.default ?? null;
const mountLocalSyncRoutes = localSyncRoutesModule?.mountLocalSyncRoutes ?? null;
const validateNormalMemoryProposal = storeModule?.validateNormalMemoryProposal ?? null;
const OWNER_ORIGIN_CLIENT_ID = trustLoopModule?.OWNER_ORIGIN_CLIENT_ID ?? null;
const inject = harnessModule?.inject ?? null;

const CREDENTIAL = `apsd_${"a".repeat(43)}`;
const BRIDGE_SECOND_CREDENTIAL = `apsd_${"b".repeat(43)}`;
const REMOTE_MEMORY = "81000000-0000-4000-8000-000000000001";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyPage(cursor = "0") {
  return {
    format_version: 1,
    cursor,
    has_more: false,
    memories: [],
    proposals: [],
    tombstones: [],
    fences: [],
  };
}

function baseRow(overrides = {}) {
  return {
    change_seq: "1",
    entity_id: "83000000-0000-4000-8000-000000000001",
    hosted_proposal_id: null,
    hosted_memory_id: null,
    lifecycle_state: "fenced",
    category: null,
    origin_connector: null,
    deletion_fence_id: null,
    deleted_entity_version: null,
    occurred_at: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function memoryRow(overrides = {}) {
  return {
    ...baseRow({
      entity_id: REMOTE_MEMORY,
      hosted_memory_id: REMOTE_MEMORY,
      lifecycle_state: "approved",
      category: "project",
    }),
    content: "Hosted memory content.",
    created_at: "2026-08-24T12:00:00.000Z",
    approved_at: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function proposalRow(overrides = {}) {
  const entityId = overrides.entity_id || "84000000-0000-4000-8000-000000000001";
  return {
    ...baseRow({
      entity_id: entityId,
      hosted_proposal_id: entityId,
      hosted_memory_id: null,
      lifecycle_state: "pending",
      category: "project",
    }),
    content: "Hosted proposal content.",
    created_at: "2026-08-24T12:00:00.000Z",
    decided_at: null,
    ...overrides,
  };
}

function tombstoneRow(overrides = {}) {
  return baseRow({
    entity_id: REMOTE_MEMORY,
    hosted_memory_id: REMOTE_MEMORY,
    lifecycle_state: "deleted",
    category: "project",
    ...overrides,
  });
}

function linked(repository, baseUrl = "https://passport.example") {
  const record = writeHostedLink(repository.home, {
    base_url: baseUrl,
    device_id: repository.metadata().replica_id,
    credential: CREDENTIAL,
    status: "approved",
  });
  repository.adoptOwnerScopeKey("c".repeat(64));
  return record;
}

function pendingLink(repository, overrides = {}) {
  return writePendingHostedLink(repository.home, {
    ceremony_version: 1,
    base_url: "https://passport.example",
    device_id: repository.metadata().replica_id,
    credential: CREDENTIAL,
    ticket_id: "97000000-0000-4000-8000-000000000005",
    poll_secret: `sblp_${"n".repeat(43)}`,
    expires_at: "2026-08-25T12:10:00.000Z",
    ...overrides,
  });
}

function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (call.url.endsWith("/sync/v1/scope-key")) {
      return jsonResponse({ owner_scope_key: "c".repeat(64) });
    }
    return handler(call, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const BRIDGE_USER = "11111111-1111-4111-8111-111111111111";
const BRIDGE_OWNER_TOKEN = "bridge-owner-native-session";
const BRIDGE_NOW = "2026-08-24T14:00:00.000Z";

class BridgeSyncStore {
  constructor() {
    this.devices = new Map();
    this.linkTickets = new Map();
    this.events = new Map();
    this.tombstones = new Map();
    this.changes = [];
    this.currentState = new Map();
    this.ownerScopeKeys = new Map();
    this.nextChangeSeq = 1;
    this.rejectNextPreparedOpAsInvalidEvent = null;
    this.nullEventIdsOnReplay = new Set();
    this.hideCreationOutcomeOnce = new Set();
    this.emptyTerminalTombstoneWrites = new Set();
  }

  key(userId, value) { return `${userId}:${value}`; }

  appendChange(row) {
    const change = {
      change_seq: this.nextChangeSeq++,
      user_id: BRIDGE_USER,
      hosted_proposal_id: null,
      hosted_memory_id: null,
      category: null,
      origin_connector: null,
      deletion_fence_id: null,
      deleted_entity_version: null,
      occurred_at: BRIDGE_NOW,
      ...row,
    };
    this.changes.push(change);
    const stateKind = ["memory", "tombstone"].includes(change.kind) ? "memory" : change.kind;
    const stateId = stateKind === "memory" ? change.hosted_memory_id || change.entity_id : change.entity_id;
    this.currentState.set(this.key(change.user_id, `${stateKind}:${stateId}`), change);
    return change;
  }

  async enrollDevice({ userId, deviceId, localOwnerId, label, credentialHash, capabilities = [] }) {
    const key = this.key(userId, deviceId);
    if (this.devices.has(key)) return null;
    const row = {
      user_id: userId,
      device_id: deviceId,
      local_owner_id: localOwnerId,
      label,
      credential_hash: credentialHash,
      capabilities: [...capabilities],
      status: "pending",
      upload_seq: 0,
      download_cursor: "0",
      offered_cursor: "0",
      created_at: BRIDGE_NOW,
      approved_at: null,
      revoked_at: null,
    };
    this.devices.set(key, row);
    return { ...row };
  }

  async mintLinkTicket(input) {
    const row = {
      id: input.ticketId, ticket_hash: input.ticketHash, poll_secret_hash: input.pollSecretHash,
      browser_nonce_hash: null, user_id: null, device_id: input.deviceId,
      local_owner_id: input.localOwnerId, label: input.label,
      credential_hash: input.credentialHash, capabilities: [...input.capabilities], state: "minted",
      expires_at: input.expiresAt, terminal_at: null, created_at: BRIDGE_NOW,
    };
    this.linkTickets.set(input.ticketId, row);
    return { ...row };
  }

  async readLinkTicketStatus({ ticketId, pollSecretHash }) {
    const row = this.linkTickets.get(ticketId);
    return row && row.poll_secret_hash === pollSecretHash ? { ticket_state: row.state } : null;
  }

  async listDevices({ userId }) {
    return [...this.devices.values()].filter((row) => row.user_id === userId).map((row) => ({ ...row }));
  }

  async approveDevice({ userId, deviceId }) {
    const row = this.devices.get(this.key(userId, deviceId));
    if (!row) return null;
    row.status = "approved";
    row.approved_at = BRIDGE_NOW;
    return { ...row };
  }

  async revokeDevice({ userId, deviceId }) {
    const row = this.devices.get(this.key(userId, deviceId));
    if (!row) return false;
    row.status = "revoked";
    row.revoked_at = BRIDGE_NOW;
    return true;
  }

  async authenticateDevice({ credentialHash }) {
    const row = [...this.devices.values()].find((candidate) => candidate.credential_hash === credentialHash);
    return row ? { ...row } : null;
  }

  async refreshDeviceCapabilities({ credentialHash, capabilities }) {
    const row = [...this.devices.values()].find((candidate) => candidate.credential_hash === credentialHash);
    if (!row || row.status !== "approved") return null;
    row.capabilities = [...capabilities];
    return { ...row };
  }

  async getOwnerScopeKey({ credentialHash }) {
    const device = [...this.devices.values()].find((candidate) => candidate.credential_hash === credentialHash);
    if (!device || device.status !== "approved") return null;
    if (!this.ownerScopeKeys.has(device.user_id)) this.ownerScopeKeys.set(device.user_id, "c".repeat(64));
    return { owner_scope_key: this.ownerScopeKeys.get(device.user_id) };
  }

  async getEvent({ userId, eventId }) { return this.events.get(this.key(userId, eventId)) || null; }

  async getEventBySaveId({ userId, saveId }) {
    return [...this.events.values()].find((row) =>
      row.user_id === userId && row.save_id === saveId && row.op === "proposal_created" && row.outcome === "accepted") || null;
  }

  async getEntityState({ userId, entityId }) {
    return [...this.events.values()]
      .filter((row) => row.user_id === userId && row.entity_id === entityId && row.outcome === "accepted")
      .sort((left, right) => Number(Boolean(right.hosted_memory_id)) - Number(Boolean(left.hosted_memory_id)) ||
        right.entity_version - left.entity_version)[0] || null;
  }

  async getEntityCreationOutcome({ userId, entityId }) {
    const key = this.key(userId, entityId);
    if (this.hideCreationOutcomeOnce.delete(key)) return null;
    return [...this.events.values()]
      .filter((row) => row.user_id === userId && row.entity_id === entityId && row.op === "proposal_created")
      .sort((left, right) => right.entity_version - left.entity_version)[0] || null;
  }

  async getTombstone({ userId, entityId }) { return this.tombstones.get(this.key(userId, entityId)) || null; }

  async claimEvent({ credentialHash, event }) {
    const device = [...this.devices.values()].find((candidate) => candidate.credential_hash === credentialHash);
    if (!device || device.status !== "approved" || device.local_owner_id !== event.owner_id) {
      return { claim_outcome: "revoked", event_id: event.event_id };
    }
    const existing = this.events.get(this.key(device.user_id, event.event_id));
    if (existing) {
      return {
        ...existing,
        event_id: this.nullEventIdsOnReplay.has(event.event_id) ? null : existing.event_id,
        claim_outcome: ["applied", "superseded"].includes(existing.application_phase) ? "existing_final" : "claimed",
      };
    }
    const fence = this.changes.find((row) =>
      row.user_id === device.user_id && ["tombstone", "account_fence"].includes(row.kind) &&
      BigInt(row.change_seq) > BigInt(device.download_cursor));
    if (fence) return { claim_outcome: "pull_required", required_cursor: fence.change_seq, event_id: event.event_id };
    if ([...this.events.values()].some((row) => row.user_id === device.user_id && row.device_id === device.device_id &&
      ["claimed", "effects_pending"].includes(row.application_phase))) {
      return { claim_outcome: "prior_pending", event_id: event.event_id };
    }
    if (event.replica_seq !== device.upload_seq + 1) {
      return { claim_outcome: "sequence_gap", event_id: event.event_id };
    }
    const row = {
      ...event,
      user_id: device.user_id,
      device_id: device.device_id,
      application_phase: "claimed",
      outcome: null,
      reason: null,
      winner_event_id: null,
      hosted_proposal_id: null,
      hosted_memory_id: null,
      effect_lease_token: null,
      effect_lease_expires_at: null,
    };
    this.events.set(this.key(device.user_id, event.event_id), row);
    device.upload_seq = event.replica_seq;
    return { ...row, claim_outcome: "claimed" };
  }

  async prepareEvent({ userId, deviceId, eventId, leaseToken }) {
    const row = this.events.get(this.key(userId, eventId));
    if (!row || row.device_id !== deviceId) return null;
    if (row.application_phase === "applied") return { ...row };
    if (this.rejectNextPreparedOpAsInvalidEvent === row.op) {
      this.rejectNextPreparedOpAsInvalidEvent = null;
      this.nullEventIdsOnReplay.add(eventId);
      Object.assign(row, {
        application_phase: "applied",
        outcome: "rejected",
        reason: "invalid_event",
        effect_lease_token: null,
        effect_lease_expires_at: null,
      });
      return { ...row };
    }
    row.application_phase = "effects_pending";
    row.effect_lease_token = leaseToken;
    row.effect_lease_expires_at = Date.now() + 300_000;
    if (["proposal_approved", "proposal_rejected", "memory_deleted"].includes(row.op)) {
      row.winner_event_id = row.event_id;
    }
    return { ...row };
  }

  async listPendingEvents() { return []; }

  async markEvent({ userId, deviceId, eventId, leaseToken, outcome, reason, proposalId, memoryId, winnerEventId }) {
    const row = this.events.get(this.key(userId, eventId));
    if (!row || row.device_id !== deviceId || row.effect_lease_token !== leaseToken) return null;
    Object.assign(row, {
      application_phase: "applied",
      outcome,
      reason,
      hosted_proposal_id: proposalId,
      hosted_memory_id: memoryId,
      winner_event_id: winnerEventId || row.winner_event_id,
      effect_lease_token: null,
      effect_lease_expires_at: null,
    });
    const category = row.payload?.category || "project";
    if (outcome === "accepted" && row.op === "proposal_created") {
      this.appendChange({
        kind: "proposal", entity_id: row.entity_id, hosted_proposal_id: proposalId,
        lifecycle_state: "pending", category,
      });
    }
    if (outcome === "accepted" && ["proposal_approved", "proposal_rejected"].includes(row.op)) {
      this.appendChange({
        kind: "proposal", entity_id: row.entity_id, hosted_proposal_id: proposalId,
        hosted_memory_id: memoryId, lifecycle_state: row.op === "proposal_approved" ? "approved" : "rejected",
        category,
      });
      if (row.op === "proposal_approved" && memoryId) {
        this.appendChange({
          kind: "memory", entity_id: row.entity_id, hosted_proposal_id: proposalId,
          hosted_memory_id: memoryId, lifecycle_state: "approved", category,
        });
      }
    }
    return { ...row };
  }

  async retryEvent({ userId, deviceId, eventId, leaseToken }) {
    const row = this.events.get(this.key(userId, eventId));
    if (!row || row.device_id !== deviceId || row.effect_lease_token !== leaseToken) return null;
    row.effect_lease_token = null;
    row.effect_lease_expires_at = null;
    return { ...row };
  }
  async renewEventLease() { return true; }

  async writeTombstone({ userId, entityId, memoryId, deletionFenceId, deletedEntityVersion, occurredAt }) {
    const key = this.key(userId, entityId);
    if (this.tombstones.has(key)) return this.tombstones.get(key);
    const creation = await this.getEntityCreationOutcome({ userId, entityId });
    if (creation && ["claimed", "effects_pending"].includes(creation.application_phase)) return null;
    const terminallyRejected = creation?.outcome === "rejected"
      && ["applied", "superseded"].includes(creation.application_phase);
    if (terminallyRejected && this.emptyTerminalTombstoneWrites.delete(key)) return null;
    const resolvedMemoryId = creation
      ? creation.hosted_memory_id || memoryId || entityId
      : memoryId;
    if (!this.tombstones.has(key)) {
      const row = {
        user_id: userId, entity_id: entityId, hosted_proposal_id: null, hosted_memory_id: resolvedMemoryId,
        deletion_fence_id: deletionFenceId, deleted_entity_version: deletedEntityVersion,
        category: resolvedMemoryId ? creation?.payload?.category || "project" : null,
        origin_connector: null, occurred_at: occurredAt,
      };
      this.tombstones.set(key, row);
      this.appendChange({ ...row, kind: "tombstone", lifecycle_state: "deleted" });
    }
    return this.tombstones.get(key);
  }

  async page({ userId, cursor, snapshot, limit }) {
    const source = snapshot ? [...this.currentState.values()] : this.changes;
    return source.filter((row) => row.user_id === userId && BigInt(row.change_seq) > BigInt(cursor))
      .sort((left, right) => left.change_seq - right.change_seq).slice(0, limit).map(({ user_id: _userId, ...row }) => row);
  }

  async offerCursor({ userId, deviceId, after, cursor }) {
    const row = this.devices.get(this.key(userId, deviceId));
    if (!row || String(row.download_cursor) !== String(after)) return false;
    row.offered_cursor = String(cursor);
    return true;
  }

  async ackCursor({ userId, deviceId, cursor }) {
    const row = this.devices.get(this.key(userId, deviceId));
    if (!row || String(row.offered_cursor) !== String(cursor)) return false;
    row.download_cursor = String(cursor);
    return true;
  }
}

class BridgeTrustService {
  constructor() {
    this.proposals = new Map();
    this.memories = new Map();
    this.nextProposal = 1;
    this.failNextProposal = false;
    this.proposalAttempts = [];
    this.rejectNextProposal = false;
  }

  addProposal({ id, memoryId = null, status = "pending", category = "project", content, clientId = null, evidenceBasis = null, source = null }) {
    this.proposals.set(id, {
      id, memoryId, status, category, content, createdAt: BRIDGE_NOW,
      clientId, evidenceBasis, source,
      decidedAt: status === "pending" ? null : BRIDGE_NOW,
    });
    return this.proposals.get(id);
  }

  addApprovedMemory({ proposalId, memoryId, category = "project", content }) {
    this.addProposal({ id: proposalId, memoryId, status: "approved", category, content });
    this.memories.set(memoryId, { memoryId, proposalId, category, content, createdAt: BRIDGE_NOW, approvedAt: BRIDGE_NOW });
  }

  transition(proposalId, status) {
    const proposal = this.proposals.get(proposalId);
    proposal.status = status;
    // Production stamps decided_at on entry to promoting/rejecting. The old
    // null fixture was a false-green because the client accepted a shape the
    // real hydrator never emits for an in-flight decision.
    proposal.decidedAt = status === "pending" ? null : BRIDGE_NOW;
    return proposal;
  }

  async proposeMemory(input) {
    if (this.rejectNextProposal) {
      this.rejectNextProposal = false;
      const error = new Error("terminal content rejection");
      error.code = "content_rejected";
      throw error;
    }
    validateNormalMemoryProposal({
      content: input.content,
      source: input.source,
      category: input.category,
      clientId: input.clientId,
      evidenceBasis: input.evidenceBasis,
      sourceAuthority: input.sourceAuthority,
    });
    this.proposalAttempts.push(input.content);
    if (this.failNextProposal) {
      this.failNextProposal = false;
      throw new Error("simulated proposal dependency failure");
    }
    const suffix = String(this.nextProposal++).padStart(12, "0");
    const proposalId = `50000000-0000-f000-0000-${suffix}`;
    const memoryId = `60000000-0000-e000-0000-${suffix}`;
    this.addProposal({
      id: proposalId, memoryId, category: input.category, content: input.content,
      clientId: input.clientId, evidenceBasis: input.evidenceBasis, source: input.source,
    });
    return { id: proposalId };
  }

  async applyLocalSyncDecision({ proposalId, approve }) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { ok: false, reason: "not_found" };
    this.transition(proposalId, approve ? "approved" : "rejected");
    if (approve) {
      this.memories.set(proposal.memoryId, {
        memoryId: proposal.memoryId, proposalId, category: proposal.category,
        content: proposal.content, createdAt: proposal.createdAt, approvedAt: BRIDGE_NOW, source: proposal.source,
      });
    }
    return { ok: true, memoryId: approve ? proposal.memoryId : null };
  }

  async forgetApprovedMemory({ memoryId }) {
    this.memories.delete(memoryId);
    return { ok: true };
  }

  async hydrateLocalSyncRows({ userId, rows }) {
    assert.equal(userId, BRIDGE_USER);
    return rows.map((row) => {
      if (row.kind === "proposal") {
        const proposal = this.proposals.get(row.hosted_proposal_id);
        if (!proposal) return null;
        return {
          ...row,
          ...(proposal.source?.startsWith("switchboard-project-scope:")
            ? { project_scope_ids: [proposal.source.slice("switchboard-project-scope:".length)] }
            : {}),
          lifecycle_state: proposal.status,
          category: proposal.category,
          content: proposal.status === "pending" ? proposal.content : null,
          created_at: proposal.createdAt,
          decided_at: proposal.decidedAt,
        };
      }
      if (row.kind === "memory") {
        const memory = this.memories.get(row.hosted_memory_id);
        if (!memory) return null;
        return {
          ...row,
          ...(memory.source?.startsWith("switchboard-project-scope:")
            ? { project_scope_ids: [memory.source.slice("switchboard-project-scope:".length)] }
            : {}),
          lifecycle_state: "approved",
          category: memory.category,
          content: memory.content,
          created_at: memory.createdAt,
          approved_at: memory.approvedAt,
        };
      }
      return row;
    }).filter(Boolean);
  }
}

function bridgeFetch(app, { afterResponse = null, beforeRequest = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers || {}) };
    const request = { method: init.method || "GET", path: `${parsed.pathname}${parsed.search}`, headers, body: init.body || null };
    calls.push(request);
    await beforeRequest?.(request);
    const result = await inject(app, request);
    await afterResponse?.(request, result);
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function bootstrap(repository, fetchImpl = null) {
  linked(repository);
  const scripted = fetchImpl || scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl: scripted });
  assert.equal(result.status, "ok");
  return scripted;
}

test("the real scope-key route admits only approved devices", { skip: !hasMonorepoServer }, async () => {
  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  const app = express();
  app.use(express.json());
  mountLocalSyncRoutes(app, {
    syncOpen: true,
    store,
    trustService,
    ownerSessionOrRespond: async (_req, res) => {
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });

  const approvedHash = hostedCredentialHash(CREDENTIAL);
  const pendingHash = hostedCredentialHash(BRIDGE_SECOND_CREDENTIAL);
  await store.enrollDevice({
    userId: BRIDGE_USER, deviceId: "scope_approved", localOwnerId: "scope_owner",
    label: "Approved scope device", credentialHash: approvedHash,
  });
  await store.enrollDevice({
    userId: BRIDGE_USER, deviceId: "scope_pending", localOwnerId: "scope_owner",
    label: "Pending scope device", credentialHash: pendingHash,
  });
  await store.approveDevice({ userId: BRIDGE_USER, deviceId: "scope_approved" });

  const approved = await inject(app, {
    method: "GET", path: "/sync/v1/scope-key",
    headers: { authorization: `Bearer ${CREDENTIAL}` },
  });
  assert.equal(approved.status, 200);
  assert.match(approved.json.owner_scope_key, /^[a-f0-9]{64}$/);

  const pending = await inject(app, {
    method: "GET", path: "/sync/v1/scope-key",
    headers: { authorization: `Bearer ${BRIDGE_SECOND_CREDENTIAL}` },
  });
  assert.deepEqual([pending.status, pending.json.error], [403, "sync_device_not_approved"]);

  await store.revokeDevice({ userId: BRIDGE_USER, deviceId: "scope_approved" });
  const revoked = await inject(app, {
    method: "GET", path: "/sync/v1/scope-key",
    headers: { authorization: `Bearer ${CREDENTIAL}` },
  });
  assert.deepEqual([revoked.status, revoked.json.error], [403, "sync_device_not_approved"]);
});

// REAL route/client bridge coverage. This would have caught every round-two
// finding: it uses localSyncRoutes safeEventRow and hydrated row shapes, numeric
// PostgREST-style sequences, interleaved kinds, live trust-loop statuses, and
// the server's shape-only UUID boundary instead of hand-authored response mocks.
test("the real hosted route and real sync client bridge the complete lifecycle", { skip: !hasMonorepoServer }, async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => repository.close());
  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  let credentialIndex = 0;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mountLocalSyncRoutes(app, {
    syncOpen: true,
    store,
    trustService,
    publicUrl: "http://127.0.0.1",
    randomCredential: () => [CREDENTIAL, BRIDGE_SECOND_CREDENTIAL][credentialIndex++],
    ownerSessionOrRespond: async (req, res) => {
      if (req.get("authorization") === `Bearer ${BRIDGE_OWNER_TOKEN}`) {
        return { userId: BRIDGE_USER, authenticatedVia: "bearer" };
      }
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });

  const outcomePages = [];
  let selfFence = null;
  let corruptNextUploadBeforeClaim = false;
  const fetchImpl = bridgeFetch(app, {
    beforeRequest: async (request) => {
      if (selfFence && request.method === "POST" && request.path === "/sync/v1/events") {
        store.appendChange(selfFence);
        selfFence = null;
      }
      if (corruptNextUploadBeforeClaim && request.method === "POST" && request.path === "/sync/v1/events") {
        const body = JSON.parse(request.body);
        body.events[0].payload.unrecognized_preclaim_field = true;
        request.body = JSON.stringify(body);
        corruptNextUploadBeforeClaim = false;
      }
    },
    afterResponse: async (request, response) => {
      if (request.method === "POST" && request.path === "/sync/v1/link/tickets" && response.status === 201) {
        const input = JSON.parse(request.body);
        await store.enrollDevice({
          userId: BRIDGE_USER, deviceId: input.device_id, localOwnerId: input.local_owner_id,
          label: input.label, credentialHash: input.credential_hash, capabilities: input.capabilities,
        });
        await store.approveDevice({ userId: BRIDGE_USER, deviceId: input.device_id });
        store.linkTickets.get(response.json.ticket_id).state = "approved";
      }
      if (request.method === "POST" && request.path === "/sync/v1/events" && response.status === 200) {
        outcomePages.push(response.json);
      }
    },
  });

  const guard = await syncOnce({ repository, fetchImpl });
  assert.equal(guard.status, "unlinked");
  assert.equal(fetchImpl.calls.length, 0, "the link-less guard never reaches the route");

  const record = await linkHosted({
    repository,
    baseUrl: "http://127.0.0.1",
    fetchImpl,
    openUrl: () => false,
    maxPolls: 1,
  });
  assert.equal(record.status, "approved");
  const linkedDevice = store.devices.get(store.key(BRIDGE_USER, repository.metadata().replica_id));
  assert.deepEqual(linkedDevice.capabilities, SYNC_CAPABILITIES);
  assert.deepEqual(
    JSON.parse(fetchImpl.calls.find((call) => call.path === "/sync/v1/link/tickets").body).capabilities,
    SYNC_CAPABILITIES,
  );
  const bootstrapped = await syncOnce({ repository, fetchImpl });
  assert.equal(bootstrapped.status, "ok");
  assert.equal(bootstrapped.new_cursor, "0");

  const wedgeContent = "REAL_BRIDGE_REPLAY_RESTORES_INLINE_CONTENT";
  const wedgedSave = repository.propose({
    save_id: "real-bridge-wedged-effect",
    category: "project",
    content: wedgeContent,
  }, { owner: true });
  trustService.failNextProposal = true;
  const wedged = await syncOnce({ repository, fetchImpl });
  assert.equal(wedged.status, "ok", "the failed effect leaves its claimed sequence pending on the server");
  assert.ok(wedged.pending > 0);
  const wedgeUpload = repository.db.prepare(`
    SELECT upload_seq FROM hosted_sync_uploads
    WHERE event_id = (SELECT event_id FROM events WHERE entity_id = ? AND op = 'proposal_created')
  `).get(wedgedSave.proposal_id);
  repository.db.prepare(`
    UPDATE hosted_sync_uploads SET state = 'complete', outcome = 'accepted'
    WHERE wire_entity_id = ?
  `).run(wedgedSave.proposal_id);
  const blockedSave = repository.propose({
    save_id: "real-bridge-behind-wedge",
    category: "fact",
    content: "REAL_BRIDGE_UPLOAD_BEHIND_WEDGE",
  }, { owner: true });
  const blocked = await syncOnce({ repository, fetchImpl });
  assert.equal(blocked.status, "ok");
  assert.equal(blocked.pending, 2);
  assert.equal(outcomePages.at(-1).outcomes[0].reason, "prior_pending");

  const replayed = await syncOnce({ repository, fetchImpl, replayFrom: wedgeUpload.upload_seq });
  assert.equal(replayed.status, "ok");
  assert.equal(replayed.replay_queued, 4);
  assert.deepEqual(trustService.proposalAttempts.filter((content) => content === wedgeContent), [wedgeContent, wedgeContent],
    "the claimed creation reruns its effect with replayed inline content");
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state <> 'complete'
  `).get().count, 0, "the replay clears the wedge and drains later assigned uploads");
  assert.ok(blockedSave.proposal_id);

  const proposalAttemptsBeforeCompleteReplay = trustService.proposalAttempts.length;
  const completeReplay = await syncOnce({ repository, fetchImpl, replayFrom: wedgeUpload.upload_seq });
  assert.equal(completeReplay.status, "ok");
  assert.equal(completeReplay.replay_queued, 4);
  assert.equal(trustService.proposalAttempts.length, proposalAttemptsBeforeCompleteReplay,
    "a complete range replays as existing_final without rerunning effects");
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state <> 'complete'
  `).get().count, 0);

  const journalBeforeMultiScope = store.events.size;
  const proposalsBeforeMultiScope = trustService.proposals.size;
  const linkedCredential = JSON.parse(readFileSync(path.join(repository.home, "link.json"), "utf8")).credential;
  const multiScopeEntity = "a0000000-0000-4000-8000-000000000099";
  const multiScopeUpload = await inject(app, {
    method: "POST",
    path: "/sync/v1/events",
    headers: { authorization: `Bearer ${linkedCredential}`, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        format_version: 1,
        event_id: "a0000000-0000-4000-8000-000000000098",
        entity_id: multiScopeEntity,
        owner_id: repository.metadata().owner_id,
        replica_id: repository.metadata().replica_id,
        replica_seq: 1,
        entity_version: 1,
        op: "proposal_created",
        actor: "owner",
        client_id: null,
        occurred_at: "2026-08-24T12:00:00.000Z",
        save_id: "two-scopes-invalid",
        payload: {
          category: "project",
          context_profile: "coding",
          profile_version: 1,
          project_scope_ids: ["a".repeat(64), "b".repeat(64)],
          content_ref: { entity_id: multiScopeEntity, content_version: 1 },
        },
      }],
      content_records: [{
        entity_id: multiScopeEntity,
        content_version: 1,
        content: "MULTI_SCOPE_MUST_NOT_MUTATE",
        created_at: "2026-08-24T12:00:00.000Z",
        occurred_at: "2026-08-24T12:00:00.000Z",
      }],
    }),
  });
  assert.equal(multiScopeUpload.status, 200);
  assert.deepEqual(multiScopeUpload.json.outcomes, [{
    event_id: "a0000000-0000-4000-8000-000000000098",
    status: "rejected",
    reason: "invalid_event",
  }]);
  assert.equal(store.events.size, journalBeforeMultiScope, "invalid multi-scope upload never enters the hosted journal");
  assert.equal(trustService.proposals.size, proposalsBeforeMultiScope, "invalid multi-scope upload never reaches Trust Loop");

  const hostedProposal = "a1000000-0000-f000-0000-000000000001";
  const hostedMemory = "a2000000-0000-e000-0000-000000000001";
  trustService.addApprovedMemory({
    proposalId: hostedProposal,
    memoryId: hostedMemory,
    content: "Bridge-hosted restored memory.",
  });
  store.appendChange({
    kind: "memory", entity_id: hostedMemory, hosted_proposal_id: hostedProposal,
    hosted_memory_id: hostedMemory, lifecycle_state: "approved", category: "project",
  });
  const firstPull = await syncOnce({ repository, fetchImpl });
  assert.equal(firstPull.status, "ok");
  assert.equal(firstPull.new_cursor, String(store.nextChangeSeq - 1));
  assert.equal(repository.listMemories().some((row) => row.content === "Bridge-hosted restored memory."), true);

  const promoting = "b1000000-0000-a000-0000-000000000001";
  const rejecting = "b2000000-0000-b000-0000-000000000001";
  const failed = "b3000000-0000-c000-0000-000000000001";
  trustService.addProposal({ id: promoting, content: "Promoting stays pending." });
  trustService.addProposal({ id: rejecting, content: "Rejecting stays pending." });
  trustService.addProposal({ id: failed, content: "Failure becomes a rejection." });
  store.nextChangeSeq = 10;
  store.appendChange({
    kind: "tombstone", entity_id: hostedMemory, hosted_proposal_id: hostedProposal,
    hosted_memory_id: hostedMemory, lifecycle_state: "deleted", category: "project",
  });
  store.appendChange({
    kind: "memory", entity_id: hostedMemory, hosted_proposal_id: hostedProposal,
    hosted_memory_id: hostedMemory, lifecycle_state: "approved", category: "project",
  });
  for (const proposalId of [promoting, rejecting, failed]) {
    store.appendChange({
      kind: "proposal", entity_id: proposalId, hosted_proposal_id: proposalId,
      lifecycle_state: "pending", category: "project",
    });
  }
  const mixed = await syncOnce({ repository, fetchImpl });
  assert.equal(mixed.status, "ok");
  assert.equal(mixed.new_cursor, "14");
  assert.equal(repository.listMemories().some((row) => row.content === "Bridge-hosted restored memory."), true,
    "trash sequence 10 followed by restore sequence 11 converges to restored");
  assert.equal(repository.listInbox().length, 3);

  trustService.transition(promoting, "promoting");
  trustService.transition(rejecting, "rejecting");
  trustService.transition(failed, "failed");
  for (const proposalId of [promoting, rejecting, failed]) {
    store.appendChange({
      kind: "proposal", entity_id: proposalId, hosted_proposal_id: proposalId,
      lifecycle_state: "pending", category: "project",
    });
  }
  const workers = await syncOnce({ repository, fetchImpl });
  assert.equal(workers.status, "ok");
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(promoting).status, "pending");
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(rejecting).status, "pending");
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(failed).status, "rejected");

  trustService.addApprovedMemory({
    proposalId: promoting,
    memoryId: "b4000000-0000-d000-0000-000000000001",
    content: "Promoting stays pending.",
  });
  trustService.transition(rejecting, "rejected");
  store.appendChange({
    kind: "proposal", entity_id: promoting, hosted_proposal_id: promoting,
    hosted_memory_id: "b4000000-0000-d000-0000-000000000001", lifecycle_state: "approved", category: "project",
  });
  store.appendChange({
    kind: "memory", entity_id: promoting, hosted_proposal_id: promoting,
    hosted_memory_id: "b4000000-0000-d000-0000-000000000001", lifecycle_state: "approved", category: "project",
  });
  store.appendChange({
    kind: "proposal", entity_id: rejecting, hosted_proposal_id: rejecting,
    lifecycle_state: "rejected", category: "project",
  });
  const settled = await syncOnce({ repository, fetchImpl });
  assert.equal(settled.status, "ok");
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(promoting).status, "approved");
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(rejecting).status, "rejected");

  const client = repository.addClient({ host: "codex", label: "Real bridge" });
  repository.setAutoApprove(false);
  const saved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "real-bridge-lifecycle",
    category: "project",
    content: "REAL_BRIDGE_LOCAL_LIFECYCLE",
  });
  assert.equal(repository.approveProposal(saved.proposal_id), true);
  const pushed = await syncOnce({ repository, fetchImpl });
  assert.equal(pushed.status, "ok");
  assert.equal(pushed.pushed, 2);
  const approvalOutcome = outcomePages.flatMap((page) => page.outcomes).find((outcome) =>
    outcome.status === "accepted" && outcome.winner_event_id === outcome.event_id);
  assert.ok(approvalOutcome, "the real accepted approval carries its self winner and passes client validation");

  const echoed = await syncOnce({ repository, fetchImpl });
  assert.equal(echoed.status, "ok");
  const localMemory = repository.listMemories().find((row) => row.content === "REAL_BRIDGE_LOCAL_LIFECYCLE");
  assert.ok(localMemory);

  const ownerSaved = repository.propose({
    save_id: "real-bridge-owner-save",
    category: "project",
    content: "REAL_BRIDGE_OWNER_SAVE",
    project_scope: "9".repeat(64),
  }, { owner: true });
  assert.equal(ownerSaved.disposition, "auto_approved");
  const ownerPushed = await syncOnce({ repository, fetchImpl });
  assert.equal(ownerPushed.status, "ok");
  assert.equal(ownerPushed.pushed, 2);
  const ownerUpload = fetchImpl.calls.filter((call) =>
    call.method === "POST" && call.path === "/sync/v1/events"
  ).map((call) => JSON.parse(call.body)).find((body) =>
    body.events.some((event) => event.entity_id === ownerSaved.proposal_id)
  );
  assert.deepEqual(ownerUpload.events.map((event) => [event.op, event.actor, event.client_id]), [
    ["proposal_created", "owner", null],
    ["proposal_approved", "owner", null],
  ]);
  assert.deepEqual(ownerUpload.events[0].payload.project_scope_ids, ["9".repeat(64)]);
  const hostedOwnerCreation = [...store.events.values()].find((row) =>
    row.entity_id === ownerSaved.proposal_id && row.op === "proposal_created");
  assert.equal(hostedOwnerCreation.client_id, null, "the hosted journal preserves the wire's owner/null-client event");
  const hostedOwnerProposal = trustService.proposals.get(hostedOwnerCreation.hosted_proposal_id);
  assert.equal(hostedOwnerProposal.clientId, OWNER_ORIGIN_CLIENT_ID);
  assert.equal(hostedOwnerProposal.evidenceBasis, "direct_user_save");

  const secondRepository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => secondRepository.close());
  const secondLink = await linkHosted({
    repository: secondRepository,
    baseUrl: "http://127.0.0.1",
    fetchImpl,
    openUrl: () => false,
    maxPolls: 1,
  });
  assert.equal(secondLink.status, "approved");
  const secondPull = await syncOnce({ repository: secondRepository, fetchImpl });
  assert.equal(secondPull.status, "ok");
  const secondOwnerMemory = secondRepository.listMemories().find((row) => row.content === "REAL_BRIDGE_OWNER_SAVE");
  assert.equal(secondOwnerMemory?.project_scope, "9".repeat(64));

  repository.deleteMemory(localMemory.memory_id);
  const hostedCreated = [...store.events.values()].find((row) =>
    row.entity_id === saved.proposal_id && row.op === "proposal_created");
  const hostedApproval = [...store.events.values()].find((row) =>
    row.entity_id === saved.proposal_id && row.op === "proposal_approved");
  selfFence = {
    kind: "tombstone",
    entity_id: saved.proposal_id,
    hosted_proposal_id: hostedCreated.hosted_proposal_id,
    hosted_memory_id: hostedApproval.hosted_memory_id,
    lifecycle_state: "deleted",
    category: "project",
  };
  const uploadsBeforeFence = fetchImpl.calls.filter((call) => call.path === "/sync/v1/events").length;
  const fenced = await syncOnce({ repository, fetchImpl });
  const uploadsAfterFence = fetchImpl.calls.filter((call) => call.path === "/sync/v1/events").length;
  assert.equal(fenced.status, "ok");
  assert.equal(uploadsAfterFence - uploadsBeforeFence, 2, "the client pulls and acknowledges its fence before retrying");
  assert.equal(store.devices.values().next().value.download_cursor, fenced.new_cursor);

  store.rejectNextPreparedOpAsInvalidEvent = "proposal_approved";
  const recordedSave = repository.propose({
    save_id: "real-bridge-recorded-rejection",
    category: "project",
    content: "REAL_BRIDGE_RECORDED_REJECTION_STAYS_LOCAL",
  }, { owner: true });
  const firstRejectedCycle = await syncOnce({ repository, fetchImpl });
  assert.equal(firstRejectedCycle.status, "invalid_response", "the first invalid_event response remains fail-closed");
  const firstRejectedPage = outcomePages.at(-1);
  assert.equal(firstRejectedPage.outcomes[1].event_id !== null, true, "the initial apply rejection is not a recorded replay");
  assert.equal(firstRejectedPage.outcomes[1].reason, "invalid_event");

  const followingSave = repository.propose({
    save_id: "real-bridge-after-recorded-rejection",
    category: "fact",
    content: "REAL_BRIDGE_DRAINS_AFTER_RECORDED_REJECTION",
  }, { owner: true });
  const pagesBeforeReplay = outcomePages.length;
  const recovered = await syncOnce({ repository, fetchImpl });
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.rejected, 1);
  assert.equal(recovered.pushed, 3, "the cycle completes the replayed creation, then advances to the next assigned save");
  const replayPages = outcomePages.slice(pagesBeforeReplay);
  assert.deepEqual(replayPages[0].outcomes[1], {
    event_id: null,
    status: "rejected",
    reason: "invalid_event",
  });
  const recordedEvent = repository.db.prepare(`
    SELECT rowid, event_id FROM events WHERE entity_id = ? AND op = 'proposal_approved'
  `).get(recordedSave.proposal_id);
  assert.deepEqual(repository.db.prepare(`
    SELECT state, outcome FROM hosted_sync_uploads WHERE source_rowid = ?
  `).get(recordedEvent.rowid), { state: "rejected_recorded", outcome: "invalid_event" });
  assert.equal(repository.db.prepare("SELECT event_id FROM events WHERE rowid = ?").get(recordedEvent.rowid).event_id,
    recordedEvent.event_id, "the underlying local event is retained rather than marked synced");
  assert.equal(repository.listMemories().some((row) => row.content === "REAL_BRIDGE_RECORDED_REJECTION_STAYS_LOCAL"), true);
  assert.equal(repository.listMemories().some((row) => row.content === "REAL_BRIDGE_DRAINS_AFTER_RECORDED_REJECTION"), true);
  assert.ok(followingSave.proposal_id);

  const reemitted = await syncOnce({ repository, fetchImpl });
  assert.equal(reemitted.status, "ok");
  assert.equal(reemitted.reemitted, 1);
  const reemitEvents = repository.db.prepare(`
    SELECT op, payload FROM events WHERE entity_id = ? AND entity_version > 2 ORDER BY entity_version
  `).all(recordedSave.proposal_id).map((event) => ({
    op: event.op,
    payload: JSON.parse(repository.payloadCodec.decode(event.payload)),
  }));
  assert.deepEqual(reemitEvents.map((event) => [event.op, event.payload.content_version]), [
    ["proposal_created", 2],
    ["proposal_approved", 2],
  ]);
  assert.equal([...trustService.memories.values()].some((memory) =>
    memory.content === "REAL_BRIDGE_RECORDED_REJECTION_STAYS_LOCAL"), true,
  "the superseding owner save lands the formerly local-only memory hosted");
  assert.deepEqual(repository.db.prepare(`
    SELECT state, outcome, reemitted_event_id IS NOT NULL AS linked
    FROM hosted_sync_uploads WHERE source_rowid = ?
  `).get(recordedEvent.rowid), { state: "rejected_recorded", outcome: "superseded_by_reemit", linked: 1 });

  const stableReemitOne = await syncOnce({ repository, fetchImpl });
  const stableReemitTwo = await syncOnce({ repository, fetchImpl });
  assert.equal(stableReemitOne.reemitted, 0);
  assert.equal(stableReemitTwo.reemitted, 0);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM events
    WHERE entity_id = ? AND entity_version > 2
  `).get(recordedSave.proposal_id).count, 2, "three later cycles produce exactly one reemit pair");

  store.rejectNextPreparedOpAsInvalidEvent = "proposal_approved";
  const deletedRejectedSave = repository.propose({
    save_id: "real-bridge-deleted-recorded-rejection",
    category: "instruction",
    content: "REAL_BRIDGE_TOMBSTONED_REJECTION_MUST_NOT_REEMIT",
  }, { owner: true });
  const deletedMemoryId = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?")
    .get(deletedRejectedSave.proposal_id).memory_id;
  assert.equal((await syncOnce({ repository, fetchImpl })).status, "invalid_response");
  assert.deepEqual(repository.deleteMemory(deletedMemoryId), { status: "deleted", memory_id: deletedMemoryId });
  const deletedRecorded = await syncOnce({ repository, fetchImpl });
  assert.equal(deletedRecorded.status, "ok");
  assert.equal(deletedRecorded.rejected, 1);
  const deletedKept = await syncOnce({ repository, fetchImpl });
  assert.equal(deletedKept.status, "ok");
  assert.equal(deletedKept.reemitted, 0);
  const deletedRejectedEvent = repository.db.prepare(`
    SELECT event_id FROM events WHERE entity_id = ? AND op = 'proposal_approved'
  `).get(deletedRejectedSave.proposal_id);
  assert.deepEqual(repository.db.prepare(`
    SELECT state, outcome, reemitted_event_id FROM hosted_sync_uploads WHERE event_id = ?
  `).get(deletedRejectedEvent.event_id), {
    state: "reemit_evaluated", outcome: "kept", reemitted_event_id: null,
  });
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM events WHERE entity_id = ? AND entity_version > 2
  `).get(deletedRejectedSave.proposal_id).count, 0);

  const uploadSeqBeforeFreshRejection = [...store.devices.values()]
    .find((row) => row.device_id === repository.metadata().replica_id).upload_seq;
  repository.propose({
    save_id: "real-bridge-fresh-preclaim-rejection",
    category: "project",
    content: "REAL_BRIDGE_FRESH_PRECLAIM_STAYS_PENDING",
  }, { owner: true });
  corruptNextUploadBeforeClaim = true;
  const freshRejected = await syncOnce({ repository, fetchImpl });
  assert.equal(freshRejected.status, "invalid_response");
  assert.equal(freshRejected.rejected, 0);
  assert.equal(outcomePages.at(-1).outcomes[0].event_id === null, false, "fresh pre-claim rejection retains its event id");
  assert.equal(outcomePages.at(-1).outcomes[0].reason, "invalid_event");
  assert.equal([...store.devices.values()].find((row) => row.device_id === repository.metadata().replica_id).upload_seq,
    uploadSeqBeforeFreshRejection, "fresh rejection does not claim a hosted sequence");
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'pending'
  `).get().count, 2, "fresh rejection leaves its local lifecycle pending for a fail-closed retry");
});

test("a recorded terminal creation rejection settles its replayed dependent and lets the tombstone drain", { skip: !hasMonorepoServer }, async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => repository.close());
  linked(repository, "http://127.0.0.1");

  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  const metadata = repository.metadata();
  await store.enrollDevice({
    userId: BRIDGE_USER,
    deviceId: metadata.replica_id,
    localOwnerId: metadata.owner_id,
    label: "Terminal dependency bridge",
    credentialHash: hostedCredentialHash(CREDENTIAL),
  });
  await store.approveDevice({ userId: BRIDGE_USER, deviceId: metadata.replica_id });

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mountLocalSyncRoutes(app, {
    syncOpen: true,
    store,
    trustService,
    publicUrl: "http://127.0.0.1",
    ownerSessionOrRespond: async (_req, res) => {
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });
  const outcomePages = [];
  const fetchImpl = bridgeFetch(app, {
    afterResponse(request, response) {
      if (request.method === "POST" && request.path === "/sync/v1/events" && response.status === 200) {
        outcomePages.push(response.json);
      }
    },
  });

  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  const saved = repository.propose({
    save_id: "terminal-dependency-bridge",
    category: "project",
    content: "The local validator accepts this before the hosted dependency rejects it.",
  }, { owner: true });
  const memory = repository.db.prepare("SELECT memory_id FROM proposals WHERE proposal_id = ?").get(saved.proposal_id);
  assert.ok(memory?.memory_id);

  trustService.rejectNextProposal = true;
  store.hideCreationOutcomeOnce.add(store.key(BRIDGE_USER, saved.proposal_id));
  const interrupted = await syncOnce({ repository, fetchImpl });
  assert.equal(interrupted.status, "ok", "the first transient lookup remains queued");
  assert.equal(interrupted.pending, 1);
  assert.deepEqual(outcomePages.at(-1).outcomes.map((outcome) => [outcome.reason, outcome.retryable ?? false]), [
    ["content_rejected", false],
    ["dependency_unavailable", true],
  ]);

  const pagesBeforeReplay = outcomePages.length;
  let queuedTombstone = false;
  store.emptyTerminalTombstoneWrites.add(store.key(BRIDGE_USER, saved.proposal_id));
  const unfenced = await syncOnce({
    repository,
    fetchImpl,
    onAfterUploadResponse() {
      if (queuedTombstone) return;
      queuedTombstone = true;
      assert.equal(repository.deleteMemory(memory.memory_id).status, "deleted");
    },
  });
  assert.equal(unfenced.status, "ok", "an empty tombstone RPC row keeps the deletion retryable");
  assert.equal(unfenced.pending, 1);
  assert.equal(await store.getTombstone({ userId: BRIDGE_USER, entityId: saved.proposal_id }), null);
  assert.deepEqual(outcomePages.slice(pagesBeforeReplay).flatMap((page) => page.outcomes)
    .map((outcome) => [outcome.status, outcome.reason || null, outcome.retryable ?? false]), [
    ["rejected", "dependency_rejected", false],
    ["rejected", "dependency_unavailable", true],
  ]);

  const pagesBeforeFenceRetry = outcomePages.length;
  const replayed = await syncOnce({ repository, fetchImpl });
  assert.equal(replayed.status, "ok", JSON.stringify({ replayed, outcomePages }));
  assert.deepEqual(outcomePages.slice(pagesBeforeFenceRetry).flatMap((page) => page.outcomes)
    .map((outcome) => [outcome.status, outcome.reason || null]), [
    ["accepted", null],
  ]);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'pending'
  `).get().count, 0, "the terminal dependent no longer starves the queue");
  const tombstone = await store.getTombstone({ userId: BRIDGE_USER, entityId: saved.proposal_id });
  assert.ok(tombstone, "the queued tombstone settles the entity after the rejected dependency");
  assert.deepEqual({
    hosted_memory_id: tombstone.hosted_memory_id,
    category: tombstone.category,
  }, {
    hosted_memory_id: saved.proposal_id,
    category: "project",
  }, "terminal content rejection preserves #936's categoried creation fence");
  assert.equal(trustService.memories.size, 0, "tombstone dominance cannot leave hosted content behind");
});

test("a missing unrecorded creation dependency remains retryable through the real route", { skip: !hasMonorepoServer }, async () => {
  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  const deviceId = "transient_dependency_device";
  const ownerId = "transient_dependency_owner";
  await store.enrollDevice({
    userId: BRIDGE_USER,
    deviceId,
    localOwnerId: ownerId,
    label: "Transient dependency bridge",
    credentialHash: hostedCredentialHash(CREDENTIAL),
  });
  await store.approveDevice({ userId: BRIDGE_USER, deviceId });

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mountLocalSyncRoutes(app, {
    syncOpen: true,
    store,
    trustService,
    publicUrl: "http://127.0.0.1",
    ownerSessionOrRespond: async (_req, res) => {
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });
  const event = {
    format_version: 1,
    event_id: "92000000-0000-4000-8000-000000000001",
    entity_id: "92000000-0000-4000-8000-000000000002",
    owner_id: ownerId,
    replica_id: deviceId,
    replica_seq: 1,
    entity_version: 2,
    op: "proposal_approved",
    actor: "owner",
    client_id: null,
    occurred_at: BRIDGE_NOW,
    save_id: "transient-dependency",
    payload: { via: "owner_decision" },
  };
  const response = await inject(app, {
    method: "POST",
    path: "/sync/v1/events",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [event], content_records: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.outcomes, [{
    event_id: event.event_id,
    status: "rejected",
    reason: "dependency_unavailable",
    retryable: true,
  }]);
  assert.equal(store.events.get(store.key(BRIDGE_USER, event.event_id)).application_phase, "effects_pending");
});

test("an orphan tombstone settles through the real route, drains the batch, and fences a later device create", { skip: !hasMonorepoServer }, async () => {
  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  const firstDevice = "orphan_tombstone_first";
  const secondDevice = "orphan_tombstone_second";
  const ownerId = "orphan_tombstone_owner";
  for (const [deviceId, credential] of [[firstDevice, CREDENTIAL], [secondDevice, BRIDGE_SECOND_CREDENTIAL]]) {
    await store.enrollDevice({
      userId: BRIDGE_USER, deviceId, localOwnerId: ownerId, label: deviceId,
      credentialHash: hostedCredentialHash(credential),
    });
    await store.approveDevice({ userId: BRIDGE_USER, deviceId });
  }
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mountLocalSyncRoutes(app, {
    syncOpen: true, store, trustService, publicUrl: "http://127.0.0.1",
    ownerSessionOrRespond: async (_req, res) => {
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });
  const orphanEntity = "93000000-0000-4000-8000-000000000001";
  const healthyEntity = "93000000-0000-4000-8000-000000000002";
  const orphan = {
    format_version: 1, event_id: "93000000-0000-4000-8000-000000000003",
    entity_id: orphanEntity, owner_id: ownerId, replica_id: firstDevice,
    replica_seq: 1, entity_version: 2, op: "memory_deleted", actor: "owner",
    client_id: null, occurred_at: BRIDGE_NOW, save_id: null,
    payload: {
      deletion_fence_id: "93000000-0000-4000-8000-000000000004",
      deleted_entity_version: 2,
    },
  };
  const healthy = {
    format_version: 1, event_id: "93000000-0000-4000-8000-000000000005",
    entity_id: healthyEntity, owner_id: ownerId, replica_id: firstDevice,
    replica_seq: 2, entity_version: 1, op: "proposal_created", actor: "owner",
    client_id: null, occurred_at: BRIDGE_NOW, save_id: "behind-orphan-tombstone",
    payload: {
      category: "project", context_profile: "coding", profile_version: 1,
      project_scope_ids: [], content_ref: { entity_id: healthyEntity, content_version: 1 },
    },
  };
  const uploaded = await inject(app, {
    method: "POST", path: "/sync/v1/events",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [orphan], content_records: [] }),
  });
  assert.deepEqual(uploaded.json.outcomes.map((row) => [row.status, row.reason || null]), [
    ["accepted", null],
  ]);
  const fence = await store.getTombstone({ userId: BRIDGE_USER, entityId: orphanEntity });
  assert.equal(fence?.hosted_memory_id, null);
  assert.equal(fence?.category, null);

  const firstHeaders = {
    authorization: `Bearer ${CREDENTIAL}`,
    [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
    "content-type": "application/json",
  };
  const firstPull = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0", headers: firstHeaders,
  });
  assert.equal((await inject(app, {
    method: "POST", path: "/sync/v1/ack", headers: firstHeaders,
    body: JSON.stringify({ cursor: firstPull.json.cursor }),
  })).status, 200);
  const drained = await inject(app, {
    method: "POST", path: "/sync/v1/events", headers: firstHeaders,
    body: JSON.stringify({
      events: [healthy],
      content_records: [{ entity_id: healthyEntity, content_version: 1, content: "The queue drained." }],
    }),
  });
  assert.equal(drained.json.outcomes[0].status, "accepted");
  assert.ok([...trustService.proposals.values()].some((proposal) => proposal.content === "The queue drained."));

  const secondHeaders = {
    authorization: `Bearer ${BRIDGE_SECOND_CREDENTIAL}`,
    [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
    "content-type": "application/json",
  };
  const pulled = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0", headers: secondHeaders,
  });
  assert.equal(pulled.status, 200);
  assert.ok(pulled.json.tombstones.some((row) =>
    row.entity_id === orphanEntity && row.hosted_memory_id === null && row.category === null));
  assert.equal((await inject(app, {
    method: "POST", path: "/sync/v1/ack", headers: secondHeaders,
    body: JSON.stringify({ cursor: pulled.json.cursor }),
  })).status, 200);

  const lateCreate = {
    ...healthy,
    event_id: "93000000-0000-4000-8000-000000000006",
    entity_id: orphanEntity,
    replica_id: secondDevice,
    replica_seq: 1,
    save_id: "late-create-behind-orphan-tombstone",
    payload: { ...healthy.payload, content_ref: { entity_id: orphanEntity, content_version: 1 } },
  };
  const late = await inject(app, {
    method: "POST", path: "/sync/v1/events", headers: secondHeaders,
    body: JSON.stringify({
      events: [lateCreate],
      content_records: [{ entity_id: orphanEntity, content_version: 1, content: "Must stay fenced." }],
    }),
  });
  assert.deepEqual(late.json.outcomes, [{
    event_id: lateCreate.event_id, status: "rejected", reason: "tombstoned",
  }]);
  assert.ok(!trustService.proposalAttempts.includes("Must stay fenced."));
});

test("the real route refreshes capability claims, gates legacy devices, and rejects unknown declarations", { skip: !hasMonorepoServer }, async () => {
  const store = new BridgeSyncStore();
  const trustService = new BridgeTrustService();
  for (const [deviceId, credential] of [["capable_device", CREDENTIAL], ["legacy_device", BRIDGE_SECOND_CREDENTIAL]]) {
    await store.enrollDevice({
      userId: BRIDGE_USER, deviceId, localOwnerId: "capability_owner", label: deviceId,
      credentialHash: hostedCredentialHash(credential), capabilities: [],
    });
    await store.approveDevice({ userId: BRIDGE_USER, deviceId });
  }
  let hydrationCalls = 0;
  const hydrate = trustService.hydrateLocalSyncRows.bind(trustService);
  trustService.hydrateLocalSyncRows = async (input) => {
    hydrationCalls += 1;
    return hydrate(input);
  };
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  mountLocalSyncRoutes(app, {
    syncOpen: true, store, trustService, publicUrl: "http://127.0.0.1",
    ownerSessionOrRespond: async (_req, res) => {
      res.status(401).json({ error: "invalid_session" });
      return null;
    },
  });

  const declared = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0",
    headers: {
      authorization: `Bearer ${CREDENTIAL}`,
      [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
    },
  });
  assert.equal(declared.status, 200);
  assert.deepEqual(declared.json.tombstones, []);
  assert.deepEqual(store.devices.get(store.key(BRIDGE_USER, "capable_device")).capabilities, SYNC_CAPABILITIES);
  assert.equal(hydrationCalls, 1);

  const fence = store.appendChange({
    kind: "tombstone", entity_id: "94000000-0000-4000-8000-000000000001",
    hosted_memory_id: null, category: null, lifecycle_state: "deleted",
    deletion_fence_id: "94000000-0000-4000-8000-000000000002", deleted_entity_version: 2,
  });
  const downgraded = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0",
    headers: { authorization: `Bearer ${CREDENTIAL}` },
  });
  assert.equal(downgraded.status, 426);
  assert.deepEqual(downgraded.json, { error: "upgrade_required", missing_capability: "null_tombstones" });
  assert.equal(store.devices.get(store.key(BRIDGE_USER, "capable_device")).offered_cursor, "0");
  assert.equal(hydrationCalls, 1, "downgrade gating runs before hydration or cursor movement");

  const recovered = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0",
    headers: {
      authorization: `Bearer ${CREDENTIAL}`,
      [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
    },
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.tombstones[0].change_seq, fence.change_seq);
  assert.equal(hydrationCalls, 2, "restoring the declaration returns the same guarded page");

  const legacy = await inject(app, {
    method: "GET", path: "/sync/v1/changes?cursor=0",
    headers: { authorization: `Bearer ${BRIDGE_SECOND_CREDENTIAL}` },
  });
  assert.equal(legacy.status, 426);
  assert.deepEqual(legacy.json, { error: "upgrade_required", missing_capability: "null_tombstones" });
  assert.equal(hydrationCalls, 2, "legacy upgrade gating runs before hydration");
  assert.equal(store.devices.get(store.key(BRIDGE_USER, "legacy_device")).offered_cursor, "0");

  const unknownRefresh = await inject(app, {
    method: "GET", path: "/sync/v1/snapshot",
    headers: {
      authorization: `Bearer ${CREDENTIAL}`,
      [SYNC_CAPABILITIES_HEADER]: "future_unknown_shape",
    },
  });
  assert.equal(unknownRefresh.status, 400);
  assert.deepEqual(unknownRefresh.json, { error: "invalid_capabilities" });

  const unknownMint = await inject(app, {
    method: "POST", path: "/sync/v1/link/tickets",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: "unknown_capability_device", local_owner_id: "capability_owner",
      label: "Unknown capability", credential_hash: hostedCredentialHash(`apsd_${"z".repeat(43)}`),
      capabilities: ["future_unknown_shape"],
    }),
  });
  assert.equal(unknownMint.status, 400);
  assert.deepEqual(unknownMint.json, { error: "invalid_capabilities" });
});

test("upgrade_required remains distinct and tells the owner to upgrade Switchboard", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => repository.close());
  linked(repository);
  const fetchImpl = scriptedFetch((call) => {
    assert.equal(call.headers[SYNC_CAPABILITIES_HEADER], SYNC_CAPABILITIES.join(","));
    return jsonResponse({ error: "upgrade_required", missing_capability: "future_shape" }, 426);
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.deepEqual(
    { status: result.status, missing_capability: result.missing_capability },
    { status: "upgrade_required", missing_capability: "future_shape" },
  );
  assert.equal(
    syncFailureMessage(result),
    "Upgrade Switchboard to continue hosted sync. Required capability: future_shape.",
  );
});

test("an in-flight or later-in-batch creation keeps an unresolved tombstone retryable", { skip: !hasMonorepoServer }, async () => {
  async function mountedStore(deviceSuffix) {
    const store = new BridgeSyncStore();
    const trustService = new BridgeTrustService();
    const creatorDevice = `inflight_creator_${deviceSuffix}`;
    const deletingDevice = `inflight_deleter_${deviceSuffix}`;
    const ownerId = `inflight_owner_${deviceSuffix}`;
    for (const [deviceId, credential] of [[creatorDevice, CREDENTIAL], [deletingDevice, BRIDGE_SECOND_CREDENTIAL]]) {
      await store.enrollDevice({
        userId: BRIDGE_USER, deviceId, localOwnerId: ownerId, label: deviceId,
        credentialHash: hostedCredentialHash(credential),
      });
      await store.approveDevice({ userId: BRIDGE_USER, deviceId });
    }
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    mountLocalSyncRoutes(app, {
      syncOpen: true, store, trustService, publicUrl: "http://127.0.0.1",
      ownerSessionOrRespond: async (_req, res) => {
        res.status(401).json({ error: "invalid_session" });
        return null;
      },
    });
    return { app, store, creatorDevice, deletingDevice, ownerId };
  }

  const claimedCase = await mountedStore("claimed");
  const entityId = "94000000-0000-4000-8000-000000000001";
  const creation = {
    format_version: 1, event_id: "94000000-0000-4000-8000-000000000002",
    entity_id: entityId, owner_id: claimedCase.ownerId, replica_id: claimedCase.creatorDevice,
    replica_seq: 1, entity_version: 1, op: "proposal_created", actor: "owner",
    client_id: null, occurred_at: BRIDGE_NOW, save_id: "claimed-before-tombstone",
    payload: {
      category: "project", context_profile: "coding", profile_version: 1,
      project_scope_ids: [], content_ref: { entity_id: entityId, content_version: 1 },
    },
  };
  const claimed = await claimedCase.store.claimEvent({
    credentialHash: hostedCredentialHash(CREDENTIAL), event: creation,
  });
  assert.equal(claimed.application_phase, "claimed");
  const deletion = {
    format_version: 1, event_id: "94000000-0000-4000-8000-000000000003",
    entity_id: entityId, owner_id: claimedCase.ownerId, replica_id: claimedCase.deletingDevice,
    replica_seq: 1, entity_version: 2, op: "memory_deleted", actor: "owner",
    client_id: null, occurred_at: BRIDGE_NOW, save_id: null,
    payload: {
      deletion_fence_id: "94000000-0000-4000-8000-000000000004",
      deleted_entity_version: 2,
    },
  };
  const blocked = await inject(claimedCase.app, {
    method: "POST", path: "/sync/v1/events",
    headers: { authorization: `Bearer ${BRIDGE_SECOND_CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [deletion], content_records: [] }),
  });
  assert.deepEqual(blocked.json.outcomes, [{
    event_id: deletion.event_id, status: "rejected", reason: "dependency_unavailable", retryable: true,
  }]);
  assert.equal(await claimedCase.store.getTombstone({ userId: BRIDGE_USER, entityId }), null);

  const batchCase = await mountedStore("batch");
  const batchEntity = "94000000-0000-4000-8000-000000000005";
  const batchDeletion = {
    ...deletion,
    event_id: "94000000-0000-4000-8000-000000000006",
    entity_id: batchEntity,
    owner_id: batchCase.ownerId,
    replica_id: batchCase.creatorDevice,
  };
  const batchCreation = {
    ...creation,
    event_id: "94000000-0000-4000-8000-000000000007",
    entity_id: batchEntity,
    owner_id: batchCase.ownerId,
    replica_id: batchCase.creatorDevice,
    replica_seq: 2,
    save_id: "later-in-same-batch",
    payload: { ...creation.payload, content_ref: { entity_id: batchEntity, content_version: 1 } },
  };
  const sameBatch = await inject(batchCase.app, {
    method: "POST", path: "/sync/v1/events",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({
      events: [batchDeletion, batchCreation],
      content_records: [{ entity_id: batchEntity, content_version: 1, content: "Arrives later." }],
    }),
  });
  assert.deepEqual(sameBatch.json.outcomes, [{
    event_id: batchDeletion.event_id, status: "rejected", reason: "dependency_unavailable", retryable: true,
  }]);
  assert.equal(await batchCase.store.getTombstone({ userId: BRIDGE_USER, entityId: batchEntity }), null);
  assert.equal(await batchCase.store.getEvent({ userId: BRIDGE_USER, eventId: batchCreation.event_id }), null);

  batchCase.store.listPendingEvents = async ({ userId, deviceId, leaseToken }) => {
    const pending = [...batchCase.store.events.values()].filter((row) =>
      row.user_id === userId && row.device_id === deviceId
      && ["claimed", "effects_pending"].includes(row.application_phase));
    for (const row of pending) {
      row.effect_lease_token = leaseToken;
      row.effect_lease_expires_at = Date.now() + 300_000;
    }
    return pending.map((row) => ({ ...row }));
  };
  const replayedBatch = await inject(batchCase.app, {
    method: "POST", path: "/sync/v1/events",
    headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
    body: JSON.stringify({
      events: [batchDeletion, batchCreation],
      content_records: [{ entity_id: batchEntity, content_version: 1, content: "Arrives later." }],
    }),
  });
  assert.deepEqual(replayedBatch.json.outcomes, [{
    event_id: batchDeletion.event_id, status: "rejected", reason: "dependency_unavailable", retryable: true,
  }], "pre-route reconciliation also preserves the later-in-batch creation dependency");
  assert.equal(await batchCase.store.getTombstone({ userId: BRIDGE_USER, entityId: batchEntity }), null);
  assert.equal(await batchCase.store.getEvent({ userId: BRIDGE_USER, eventId: batchCreation.event_id }), null);
});

test("link mints a browser ticket, prints its server code, polls, and stores only the local credential", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const ticketId = "96000000-0000-4000-8000-000000000001";
  const pollSecret = `sblp_${"p".repeat(43)}`;
  const matchCode = "7KQ9MW";
  const fetchImpl = scriptedFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/sync/v1/link/tickets")) {
      assert.equal(call.headers.authorization, undefined);
      assert.deepEqual(Object.keys(call.body).sort(), ["capabilities", "credential_hash", "device_id", "label", "local_owner_id"]);
      assert.deepEqual(call.body.capabilities, SYNC_CAPABILITIES);
      assert.equal(call.body.credential_hash, hostedCredentialHash(CREDENTIAL));
      return jsonResponse({
        ticket_id: ticketId,
        link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
        match_code: matchCode,
        poll_secret: pollSecret,
        expires_at: "2026-08-25T12:10:00.000Z",
      }, 201);
    }
    if (call.url.endsWith(`/sync/v1/link/tickets/${ticketId}`)) {
      assert.equal(call.headers.authorization, `Bearer ${pollSecret}`);
      return jsonResponse({ status: "approved" });
    }
    throw new Error("unexpected request");
  });
  const instructions = [];
  const opened = [];
  const result = await linkHosted({
    repository,
    baseUrl: "https://passport.example/",
    fetchImpl,
    randomCredential: () => CREDENTIAL,
    onInstruction: (instruction) => instructions.push(instruction),
    openUrl: (url) => { opened.push(url); return true; },
    maxPolls: 1,
  });
  assert.equal(result.status, "approved");
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].match_code, matchCode);
  assert.deepEqual(opened, [instructions[0].link_url]);
  assert.equal(statSync(path.join(repository.home, "link.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(pendingLinkPath(repository.home)), false);
  assert.equal(fetchImpl.calls.filter((call) => !call.url.endsWith("/sync/v1/scope-key"))
    .some((call) => JSON.stringify(call).includes(CREDENTIAL)), false,
  "the local device credential crosses the wire only as approved-device route authentication");
  assert.equal(fetchImpl.calls.at(-1).headers.authorization, `Bearer ${CREDENTIAL}`);
  assert.equal(readFileSync(path.join(repository.home, "link.json"), "utf8").includes(CREDENTIAL), true);
  repository.close();
});

test("link reports refusal and expiry without persisting a credential", async (t) => {
  for (const terminal of ["refused", "expired"]) {
    const repository = new LocalRepository({ home: temporaryHome(t) });
    const ticketId = terminal === "refused"
      ? "97000000-0000-4000-8000-000000000001"
      : "97000000-0000-4000-8000-000000000002";
    const pollSecret = `sblp_${terminal[0].repeat(43)}`;
    const fetchImpl = scriptedFetch((call) => call.method === "POST"
      ? jsonResponse({
          ticket_id: ticketId,
          link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
          match_code: "8N4RKW",
          poll_secret: pollSecret,
          expires_at: "2026-08-25T12:10:00.000Z",
        }, 201)
      : jsonResponse({ status: terminal }));
    await assert.rejects(
      linkHosted({ repository, baseUrl: "https://passport.example", fetchImpl, openUrl: () => false, maxPolls: 1 }),
      (error) => error.code === `link_${terminal === "refused" ? "refused" : "expired"}`,
    );
    assert.equal(existsSync(path.join(repository.home, "link.json")), false);
    assert.equal(existsSync(pendingLinkPath(repository.home)), false);
    repository.close();
  }
});

test("an approved ceremony survives interruption before link.json and reruns the original poll", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const ticketId = "97000000-0000-4000-8000-000000000003";
  const pollSecret = `sblp_${"k".repeat(43)}`;
  let mintCalls = 0;
  let pollCalls = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.method === "POST") {
      mintCalls += 1;
      return jsonResponse({
        ticket_id: ticketId,
        link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
        match_code: "8N4RKW",
        poll_secret: pollSecret,
        expires_at: "2026-08-25T12:10:00.000Z",
      }, 201);
    }
    pollCalls += 1;
    assert.equal(call.url.endsWith(`/sync/v1/link/tickets/${ticketId}`), true);
    assert.equal(call.headers.authorization, `Bearer ${pollSecret}`);
    return jsonResponse({ status: "approved" });
  });
  await assert.rejects(linkHosted({
    repository, baseUrl: "https://passport.example", fetchImpl,
    randomCredential: () => CREDENTIAL, openUrl: () => false, maxPolls: 1,
    promoteLink: () => { throw new Error("simulated process interruption"); },
  }), /simulated process interruption/);
  assert.equal(existsSync(pendingLinkPath(repository.home)), true);
  assert.equal(statSync(pendingLinkPath(repository.home)).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(repository.home, "link.json")), false);

  const resumedInstructions = [];
  const resumed = await linkHosted({
    repository, baseUrl: "https://passport.example", fetchImpl,
    randomCredential: () => { throw new Error("must not mint a replacement credential"); },
    openUrl: () => { throw new Error("must not reopen a completed browser ceremony"); },
    onInstruction: (instruction) => resumedInstructions.push(instruction),
    maxPolls: 1,
  });
  assert.equal(resumed.credential, CREDENTIAL);
  assert.equal(resumedInstructions[0]?.resuming_pending, true);
  assert.equal(mintCalls, 1);
  assert.equal(pollCalls, 2);
  assert.equal(existsSync(pendingLinkPath(repository.home)), false);
  repository.close();
});

test("a 503 after browser approval leaves the original ceremony resumable", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const ticketId = "97000000-0000-4000-8000-000000000004";
  const pollSecret = `sblp_${"m".repeat(43)}`;
  let mintCalls = 0;
  let pollCalls = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.method === "POST") {
      mintCalls += 1;
      return jsonResponse({
        ticket_id: ticketId,
        link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
        match_code: "8N4RKW",
        poll_secret: pollSecret,
        expires_at: "2026-08-25T12:10:00.000Z",
      }, 201);
    }
    pollCalls += 1;
    return pollCalls === 1
      ? jsonResponse({ error: "unavailable" }, 503)
      : jsonResponse({ status: "approved" });
  });
  await assert.rejects(
    linkHosted({ repository, baseUrl: "https://passport.example", fetchImpl, randomCredential: () => CREDENTIAL, openUrl: () => false, maxPolls: 1 }),
    (error) => error.code === "hosted_unavailable",
  );
  assert.equal(existsSync(pendingLinkPath(repository.home)), true);
  const resumed = await linkHosted({ repository, baseUrl: "https://passport.example", fetchImpl, maxPolls: 1 });
  assert.equal(resumed.credential, CREDENTIAL);
  assert.equal(mintCalls, 1);
  assert.equal(pollCalls, 2);
  repository.close();
});

test("a resumed approved credential survives ticket cleanup and is promoted", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  const pending = pendingLink(repository);
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith(`/sync/v1/link/tickets/${pending.ticket_id}`)) {
      assert.equal(call.method, "GET");
      assert.equal(call.headers.authorization, `Bearer ${pending.poll_secret}`);
      return jsonResponse({ error: "link_not_available" }, 404);
    }
    assert.equal(call.url, `${pending.base_url}/sync/v1/changes?cursor=0`);
    assert.equal(call.method, "HEAD");
    assert.equal(call.headers.authorization, `Bearer ${pending.credential}`);
    assert.equal(call.body, null, "the credential probe sends no content");
    return new Response(null, { status: 200 });
  });

  const result = await linkHosted({
    repository, baseUrl: pending.base_url, fetchImpl,
    randomCredential: () => { throw new Error("must not mint a replacement credential"); },
    maxPolls: 1,
  });

  assert.equal(result.status, "approved");
  assert.equal(result.credential, pending.credential);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(existsSync(pendingLinkPath(repository.home)), false);
  assert.equal(readFileSync(path.join(repository.home, "link.json"), "utf8").includes(pending.credential), true);
  repository.close();
});

test("a resumed never-approved credential is refused after ticket cleanup", async (t) => {
  for (const probeStatus of [401, 403]) {
    const repository = new LocalRepository({ home: temporaryHome(t) });
    const pending = pendingLink(repository, {
      ticket_id: probeStatus === 401
        ? "97000000-0000-4000-8000-000000000006"
        : "97000000-0000-4000-8000-000000000007",
    });
    const fetchImpl = scriptedFetch((call) => call.url.includes("/sync/v1/link/tickets/")
      ? jsonResponse({ error: "link_not_available" }, 404)
      : new Response(null, { status: probeStatus }));

    await assert.rejects(
      linkHosted({ repository, baseUrl: pending.base_url, fetchImpl, maxPolls: 1 }),
      (error) => error.code === "link_refused",
    );
    assert.equal(fetchImpl.calls[1].method, "HEAD");
    assert.equal(fetchImpl.calls[1].headers.authorization, `Bearer ${pending.credential}`);
    assert.equal(existsSync(path.join(repository.home, "link.json")), false);
    assert.equal(existsSync(pendingLinkPath(repository.home)), false);
    repository.close();
  }
});

test("ticket-cleanup probe transport failures retain the pending credential for retry", async (t) => {
  for (const failure of ["network", "503"]) {
    const repository = new LocalRepository({ home: temporaryHome(t) });
    const pending = pendingLink(repository, {
      ticket_id: failure === "network"
        ? "97000000-0000-4000-8000-000000000008"
        : "97000000-0000-4000-8000-000000000009",
    });
    const fetchImpl = scriptedFetch((call) => {
      if (call.url.includes("/sync/v1/link/tickets/")) {
        return jsonResponse({ error: "link_not_available" }, 404);
      }
      if (failure === "network") throw new Error("offline");
      return new Response(null, { status: 503 });
    });

    await assert.rejects(
      linkHosted({ repository, baseUrl: pending.base_url, fetchImpl, maxPolls: 1 }),
      (error) => error.code === (failure === "network" ? "network_failure" : "hosted_unavailable"),
    );
    assert.equal(existsSync(path.join(repository.home, "link.json")), false);
    assert.equal(existsSync(pendingLinkPath(repository.home)), true);
    assert.equal(readFileSync(pendingLinkPath(repository.home), "utf8").includes(pending.credential), true);
    repository.close();
  }
});

test("the CLI link implementation contains no owner credential path", () => {
  const hostedLinkSource = readFileSync(new URL("../src/hostedLink.js", import.meta.url), "utf8");
  const cliSource = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  assert.doesNotMatch(`${hostedLinkSource}\n${cliSource}`, /SWITCHBOARD_OWNER_TOKEN|ownerToken|native-owner-token/);
});

test("link opening uses macOS open and stays print-only elsewhere", () => {
  const calls = [];
  const spawnImpl = (...args) => {
    calls.push(args);
    return { on() {}, unref() {} };
  };
  assert.equal(openHostedLinkUrl("https://passport.example/switchboard-link?ticket=x", {
    platform: "darwin", spawnImpl, disabled: false,
  }), true);
  assert.deepEqual(calls[0], [
    "open", ["https://passport.example/switchboard-link?ticket=x"],
    { detached: true, stdio: "ignore" },
  ]);
  assert.equal(openHostedLinkUrl("https://passport.example/switchboard-link?ticket=x", {
    platform: "linux", spawnImpl, disabled: false,
  }), false);
  assert.equal(calls.length, 1);
});

test("bootstrap hydrates an empty real store and acknowledges exactly the offered boundary", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  linked(repository);
  const sentinel = "SYNC_CONTENT_SENTINEL";
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) {
      return jsonResponse({
        ...emptyPage("7"),
        memories: [memoryRow({ change_seq: "7", content: sentinel })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) {
      assert.deepEqual(call.body, { cursor: "7" });
      return jsonResponse({ ok: true, cursor: "7" });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.pulled, 1);
  assert.equal(result.applied, 1);
  assert.equal(result.new_cursor, "7");
  assert.equal(repository.listMemories()[0].content, sentinel);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  repository.close();
});

test("the first sync after upgrade adopts the hosted owner scope key before pulling", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => repository.close());
  writeHostedLink(repository.home, {
    base_url: "https://passport.example",
    device_id: repository.metadata().replica_id,
    credential: CREDENTIAL,
    status: "approved",
  });
  assert.equal(repository.hasOwnerScopeKey(), false);
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(repository.hasOwnerScopeKey(), true);
  assert.equal(fetchImpl.calls[0].url, "https://passport.example/sync/v1/scope-key");
});

test("a server without the scope-key leg leaves adoption pending until a later capable sync", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => repository.close());
  const identity = "remote:example.test/owner/rolling-compatible";
  const replicaFingerprint = repository.scopeFingerprint(identity);
  const ticketId = "97000000-0000-4000-8000-000000000010";
  const pollSecret = `sblp_${"r".repeat(43)}`;
  let scopeKeyCalls = 0;
  let scopeKeyCapable = false;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (call.url.endsWith("/sync/v1/scope-key")) {
      scopeKeyCalls += 1;
      if (scopeKeyCapable) return jsonResponse({ owner_scope_key: "e".repeat(64) });
      return scopeKeyCalls === 1
        ? jsonResponse({ error: "not_found" }, 404)
        : jsonResponse({ error: "not_found" }, 400);
    }
    if (call.method === "POST" && call.url.endsWith("/sync/v1/link/tickets")) {
      return jsonResponse({
        ticket_id: ticketId,
        link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
        match_code: "8R4QKW",
        poll_secret: pollSecret,
        expires_at: "2026-08-25T12:10:00.000Z",
      }, 201);
    }
    if (call.url.endsWith(`/sync/v1/link/tickets/${ticketId}`)) {
      return jsonResponse({ status: "approved" });
    }
    if (call.url.endsWith("/sync/v1/snapshot") || call.url.includes("/sync/v1/changes?cursor=")) {
      return jsonResponse(emptyPage("0"));
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };

  const linkedRecord = await linkHosted({
    repository,
    baseUrl: "https://passport.example",
    fetchImpl,
    randomCredential: () => CREDENTIAL,
    openUrl: () => false,
    maxPolls: 1,
  });
  assert.equal(linkedRecord.status, "approved");
  assert.equal(repository.hasOwnerScopeKey(), false);
  assert.equal(repository.scopeFingerprint(identity), replicaFingerprint);

  const legacySync = await syncOnce({ repository, fetchImpl });
  assert.equal(legacySync.status, "ok");
  assert.equal(repository.hasOwnerScopeKey(), false);
  assert.equal(repository.scopeFingerprint(identity), replicaFingerprint);

  scopeKeyCapable = true;
  const capableSync = await syncOnce({ repository, fetchImpl });
  assert.equal(capableSync.status, "ok");
  assert.equal(repository.hasOwnerScopeKey(), true);
  assert.notEqual(repository.scopeFingerprint(identity), replicaFingerprint);
  assert.deepEqual(repository.scopeFingerprints(identity).slice(1), [replicaFingerprint]);
  assert.equal(scopeKeyCalls, 3, "link and each pre-adoption sync retry the scope-key leg");
  assert.equal(calls.filter((call) => call.url.endsWith("/sync/v1/scope-key")).at(-1)
    .headers.authorization, `Bearer ${CREDENTIAL}`);
});

test("a healthy sync cycle defers adoption when only the scope-key leg is unavailable", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => repository.close());
  writeHostedLink(repository.home, {
    base_url: "https://passport.example",
    device_id: repository.metadata().replica_id,
    credential: CREDENTIAL,
    status: "approved",
  });
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const originalFetch = fetchImpl;
  const scopeUnavailableFetch = async (url, init) => String(url).endsWith("/sync/v1/scope-key")
    ? jsonResponse({ error: "unavailable" }, 503)
    : originalFetch(url, init);
  const result = await syncOnce({ repository, fetchImpl: scopeUnavailableFetch });
  assert.equal(result.status, "ok");
  assert.equal(repository.hasOwnerScopeKey(), false);
  assert.equal(fetchImpl.calls.some((call) => call.url.endsWith("/sync/v1/snapshot")), true);
});

test("relinking adopts the new owner's key as primary and retains the former owner key only for local reads", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => repository.close());
  const identity = "remote:example.test/Owner/Relinked";
  repository.adoptOwnerScopeKey("a".repeat(64));
  const scopeA = repository.scopeFingerprint(identity);
  repository.propose({
    save_id: "owner-a-project-row", category: "project",
    content: "Owner A project context", project_scope: scopeA,
  }, { owner: true });
  writeHostedLink(repository.home, {
    base_url: "https://passport.example", device_id: repository.metadata().replica_id,
    credential: CREDENTIAL, status: "approved",
  });
  assert.equal(forgetHostedLink(repository.home), true);
  assert.equal(repository.scopeFingerprint(identity), scopeA, "unlink leaves scope keys untouched");

  const ticketId = "97000000-0000-4000-8000-000000000011";
  const pollSecret = `sblp_${"s".repeat(43)}`;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/sync/v1/link/tickets") && init.method === "POST") {
      return jsonResponse({
        ticket_id: ticketId,
        link_url: "https://passport.example/switchboard-link?ticket=browser_ticket_value",
        match_code: "8S4QKW", poll_secret: pollSecret,
        expires_at: "2026-08-25T12:10:00.000Z",
      }, 201);
    }
    if (target.endsWith(`/sync/v1/link/tickets/${ticketId}`)) return jsonResponse({ status: "approved" });
    if (target.endsWith("/sync/v1/scope-key")) return jsonResponse({ owner_scope_key: "b".repeat(64) });
    throw new Error(`unexpected request ${target}`);
  };
  await linkHosted({
    repository, baseUrl: "https://passport.example", fetchImpl,
    randomCredential: () => CREDENTIAL, openUrl: () => false, maxPolls: 1,
  });

  const scopeB = repository.scopeFingerprint(identity);
  assert.notEqual(scopeB, scopeA);
  const scopes = repository.scopeFingerprints(identity);
  assert.equal(scopes[0], scopeB);
  assert.equal(scopes.length, 3);
  assert.equal(scopes[2], scopeA, "the former owner key follows the replica fallback and is never primary");
  assert.deepEqual(repository.read({
    categories: ["project"], query: "Owner A", project_scopes: scopes,
  }, { owner: true, receipt: false }).rows.map((row) => row.content), ["Owner A project context"]);
});

test("hosted scope wins in commit order for existing, bootstrap, and incremental entities", async (t) => {
  const firstScope = "1".repeat(64);
  const secondScope = "2".repeat(64);
  const modes = ["existing-bootstrap", "fresh-bootstrap", "incremental"];
  for (const mode of modes) {
    for (const scopes of [[firstScope, secondScope], [secondScope, firstScope]]) {
      const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
      let proposalId = "85000000-0000-4000-8000-000000000001";
      let memoryId = "86000000-0000-4000-8000-000000000001";
      if (mode === "incremental") await bootstrap(repository);
      if (mode !== "fresh-bootstrap") {
        const saved = repository.propose({
          save_id: `scope-order-${mode}-${scopes[0][0]}`,
          category: "project",
          content: `Canonical scope ${mode}`,
          project_scope: "f".repeat(64),
        }, { owner: true });
        proposalId = saved.proposal_id;
        memoryId = repository.listMemories()[0].memory_id;
      }
      if (mode !== "incremental") linked(repository);
      const pagePath = mode === "incremental" ? "/sync/v1/changes?cursor=0" : "/sync/v1/snapshot";
      const fetchImpl = scriptedFetch((call) => {
        if (call.url.includes(pagePath)) {
          return jsonResponse({
            ...emptyPage("2"),
            memories: scopes.map((scope, index) => memoryRow({
              change_seq: String(index + 1),
              entity_id: proposalId,
              hosted_proposal_id: proposalId,
              hosted_memory_id: memoryId,
              content: `Canonical scope ${mode}`,
              project_scope_ids: [scope],
            })),
          });
        }
        if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
        if (call.url.endsWith("/sync/v1/events")) {
          return jsonResponse({
            outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
            upload_seq: call.body.events.at(-1).replica_seq,
          });
        }
        throw new Error(`unexpected request ${call.url}`);
      });
      const result = await syncOnce({ repository, fetchImpl });
      assert.equal(result.status, "ok", `${mode} ${scopes.join("->")}`);
      assert.equal(repository.listMemories()[0].project_scope, scopes[1], `${mode} follows later change_seq`);
      assert.equal(repository.db.prepare("SELECT project_scope FROM proposals WHERE proposal_id = ?").get(proposalId).project_scope, scopes[1]);
      repository.close();
    }
  }
});

test("hosted scope arbitration survives local approval and event-driven projection rebuilds", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  repository.setAutoApprove(false);
  const client = repository.addClient({ host: "codex", label: "Durable scope client" });
  const localScope = "a".repeat(64);
  const hostedScope = "b".repeat(64);
  const content = "Hosted scope remains canonical after approval.";
  const saved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "durable-hosted-scope",
    category: "project",
    content,
    project_scope: localScope,
  });
  linked(repository);
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) {
      return jsonResponse({
        ...emptyPage("1"),
        proposals: [proposalRow({
          change_seq: "1",
          entity_id: saved.proposal_id,
          hosted_proposal_id: saved.proposal_id,
          content,
          project_scope_ids: [hostedScope],
        })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error(`unexpected request ${call.url}`);
  });
  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  assert.equal(repository.db.prepare("SELECT project_scope FROM proposals WHERE proposal_id = ?")
    .get(saved.proposal_id).project_scope, hostedScope);
  assert.equal(repository.approveProposal(saved.proposal_id), true);
  assert.equal(repository.listMemories()[0].project_scope, hostedScope);

  const creation = repository.events().find((event) =>
    event.entity_id === saved.proposal_id && event.op === "proposal_created");
  assert.equal(repository.ingestEvent({
    ...creation,
    event_id: "zz-durable-scope-rebuild-trigger",
    replica_id: "durable-scope-rebuild-replica",
    replica_seq: 1,
  }), true);
  assert.equal(repository.db.prepare("SELECT project_scope FROM proposals WHERE proposal_id = ?")
    .get(saved.proposal_id).project_scope, hostedScope);
  assert.equal(repository.listMemories()[0].project_scope, hostedScope);
  assert.deepEqual(repository.db.prepare(`
    SELECT project_scope, authority_revision FROM proposal_scope_overrides WHERE proposal_id = ?
  `).get(saved.proposal_id), { project_scope: hostedScope, authority_revision: "1" });
  repository.close();
});

test("sync upgrades and drains a partially completed active upload journal without resequencing", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  linked(repository);
  repository.propose({
    save_id: "migration-complete",
    category: "project",
    content: "The completed lifecycle must remain completed across the rebuild.",
  }, { owner: true });
  repository.propose({
    save_id: "migration-pending",
    category: "fact",
    content: "The pending lifecycle must replay with its assigned sequence.",
  }, { owner: true });
  const events = repository.db.prepare(`
    SELECT rowid, event_id, entity_id FROM events ORDER BY rowid
  `).all();
  assert.equal(events.length, 4);
  const linkKey = createHash("sha256")
    .update(`https://passport.example\0${repository.metadata().replica_id}`)
    .digest("hex");
  repository.db.exec(`
    CREATE TABLE hosted_sync_state (
      link_key TEXT PRIMARY KEY,
      download_cursor TEXT NOT NULL,
      bootstrap_complete INTEGER NOT NULL CHECK (bootstrap_complete IN (0, 1)),
      upload_scan_rowid INTEGER NOT NULL CHECK (upload_scan_rowid >= 0),
      next_upload_seq INTEGER NOT NULL CHECK (next_upload_seq >= 1),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE hosted_sync_uploads (
      link_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      source_rowid INTEGER NOT NULL,
      upload_seq INTEGER NOT NULL,
      wire_entity_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
      outcome TEXT,
      PRIMARY KEY (link_key, event_id),
      UNIQUE (link_key, upload_seq)
    );
  `);
  const firstUploadSeq = 41;
  repository.db.prepare(`
    INSERT INTO hosted_sync_state(
      link_key, download_cursor, bootstrap_complete, upload_scan_rowid, next_upload_seq, updated_at
    ) VALUES (?, '9', 1, ?, ?, ?)
  `).run(linkKey, events.at(-1).rowid, firstUploadSeq + events.length, "2026-08-25T12:00:00.000Z");
  const insertUpload = repository.db.prepare(`
    INSERT INTO hosted_sync_uploads(
      link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  events.forEach((event, index) => insertUpload.run(
    linkKey,
    event.event_id,
    event.rowid,
    firstUploadSeq + index,
    event.entity_id,
    index < 2 ? "complete" : "pending",
    index < 2 ? "accepted" : null,
  ));
  const expectedReplay = events.slice(2).map((event, index) => ({
    event_id: event.event_id,
    replica_seq: firstUploadSeq + index + 2,
  }));
  const uploaded = [];
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=9")) return jsonResponse(emptyPage("9"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploaded.push(...call.body.events.map((event) => ({
        event_id: event.event_id,
        replica_seq: event.replica_seq,
      })));
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.deepEqual(uploaded, expectedReplay);
  assert.match(repository.db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosted_sync_uploads'
  `).get().sql, /rejected_recorded/);
  assert.equal(repository.db.prepare("PRAGMA table_info(hosted_sync_uploads)").all()
    .some((column) => column.name === "reemitted_event_id"), true);
  assert.deepEqual(repository.db.prepare(`
    SELECT event_id, upload_seq, state, outcome
    FROM hosted_sync_uploads WHERE link_key = ? ORDER BY upload_seq
  `).all(linkKey), events.map((event, index) => ({
    event_id: event.event_id,
    upload_seq: firstUploadSeq + index,
    state: "complete",
    outcome: "accepted",
  })));
  assert.deepEqual(repository.db.prepare(`
    SELECT upload_scan_rowid, next_upload_seq FROM hosted_sync_state WHERE link_key = ?
  `).get(linkKey), {
    upload_scan_rowid: events.at(-1).rowid,
    next_upload_seq: firstUploadSeq + events.length,
  });
  repository.close();
});

test("recorded rejection reemits scoped and global client proposals without changing authority", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => repository.close());
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Pending replay client" });
  repository.setAutoApprove(false);
  const occurredAt = "2026-08-20T08:30:00.000Z";
  const projectScope = "7".repeat(64);
  const saved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "pending-recorded-rejection",
    category: "project",
    content: "A review proposal must remain pending after replay.",
    occurred_at: occurredAt,
    project_scope: projectScope,
  });
  const uploads = [];
  let rejectCreation = true;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploads.push(call.body.events);
      const outcomes = call.body.events.map((event) => rejectCreation
        ? { event_id: null, status: "rejected", reason: "invalid_event" }
        : { event_id: event.event_id, status: "accepted" });
      rejectCreation = false;
      return jsonResponse({ outcomes, upload_seq: call.body.events.at(-1).replica_seq });
    }
    throw new Error("unexpected request");
  });

  const rejected = await syncOnce({ repository, fetchImpl });
  assert.equal(rejected.status, "ok");
  assert.equal(rejected.rejected, 1);
  assert.deepEqual(uploads.at(-1)[0].payload.project_scope_ids, [projectScope]);
  assert.deepEqual(repository.db.prepare(`
    SELECT state, outcome FROM hosted_sync_uploads WHERE event_id = (
      SELECT event_id FROM events
      WHERE entity_id = ? AND op = 'proposal_created' ORDER BY entity_version LIMIT 1
    )
  `).get(saved.proposal_id), { state: "rejected_recorded", outcome: "invalid_event" });
  const retried = await syncOnce({ repository, fetchImpl });
  assert.equal(retried.status, "ok");
  assert.equal(retried.reemitted, 1);
  assert.deepEqual(repository.db.prepare("SELECT status, project_scope FROM proposals WHERE proposal_id = ?")
    .get(saved.proposal_id), { status: "pending", project_scope: projectScope });
  assert.equal(repository.db.prepare("SELECT count(*) AS count FROM memories WHERE proposal_id = ?")
    .get(saved.proposal_id).count, 0);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM events WHERE entity_id = ? AND op = 'proposal_approved'
  `).get(saved.proposal_id).count, 0);
  const replayEvent = repository.db.prepare(`
    SELECT actor, client_id, payload FROM events
    WHERE entity_id = ? AND op = 'proposal_created' ORDER BY entity_version DESC LIMIT 1
  `).get(saved.proposal_id);
  const replayPayload = JSON.parse(repository.payloadCodec.decode(replayEvent.payload));
  assert.equal(replayEvent.actor, "client");
  assert.equal(replayEvent.client_id, client.client_id);
  assert.deepEqual({
    source: replayPayload.source,
    evidence_basis: replayPayload.evidence_basis,
    disposition: replayPayload.disposition,
    occurred_at: replayPayload.occurred_at,
  }, {
    source: "Pending replay client",
    evidence_basis: "assistant_saved_from_chat",
    disposition: "pending",
    occurred_at: occurredAt,
  });
  assert.equal(replayPayload.project_scope, projectScope);
  assert.equal(uploads.at(-1)[0].actor, "client", "the retried wire event keeps the client actor");
  assert.equal(uploads.at(-1)[0].client_id, client.client_id);
  assert.deepEqual(uploads.at(-1)[0].payload.project_scope_ids, [projectScope]);
  assert.equal((await syncOnce({ repository, fetchImpl })).reemitted, 0);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM events WHERE entity_id = ? AND op = 'proposal_created'
  `).get(saved.proposal_id).count, 2, "the scoped rejection creates exactly one replacement event");

  const globalSaved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "global-recorded-rejection",
    category: "project",
    content: "A global review proposal must remain global after replay.",
  });
  rejectCreation = true;
  const globalRejected = await syncOnce({ repository, fetchImpl });
  assert.equal(globalRejected.rejected, 1);
  assert.deepEqual(uploads.at(-1)[0].payload.project_scope_ids, []);
  const globalRetried = await syncOnce({ repository, fetchImpl });
  assert.equal(globalRetried.reemitted, 1);
  const globalReplay = repository.db.prepare(`
    SELECT payload FROM events
    WHERE entity_id = ? AND op = 'proposal_created' ORDER BY entity_version DESC LIMIT 1
  `).get(globalSaved.proposal_id);
  assert.equal(JSON.parse(repository.payloadCodec.decode(globalReplay.payload)).project_scope, null);
  assert.equal(repository.db.prepare("SELECT project_scope FROM proposals WHERE proposal_id = ?")
    .get(globalSaved.proposal_id).project_scope, null);
  assert.deepEqual(uploads.at(-1)[0].payload.project_scope_ids, []);
});

test("concurrent rejection reemit reserves one stable event pair", async (t) => {
  const home = temporaryHome(t);
  const firstRepository = new LocalRepository({ home, initializeDefaults: false });
  t.after(() => firstRepository.close());
  await bootstrap(firstRepository);
  const saved = firstRepository.propose({
    save_id: "concurrent-recorded-rejection",
    category: "fact",
    content: "Concurrent recovery creates one owner-approved pair.",
  }, { owner: true });
  let rejectApproval = true;
  const rejectingFetch = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      const outcomes = call.body.events.map((event) => rejectApproval && event.op === "proposal_approved"
        ? { event_id: null, status: "rejected", reason: "invalid_event" }
        : { event_id: event.event_id, status: "accepted" });
      rejectApproval = false;
      return jsonResponse({ outcomes, upload_seq: call.body.events.at(-1).replica_seq });
    }
    throw new Error("unexpected request");
  });
  assert.equal((await syncOnce({ repository: firstRepository, fetchImpl: rejectingFetch })).rejected, 1);

  const secondRepository = new LocalRepository({ home, initializeDefaults: false });
  t.after(() => secondRepository.close());
  let arrivals = 0;
  let releaseDiscovery;
  const discoveryBarrier = new Promise((resolve) => { releaseDiscovery = resolve; });
  const afterDiscovery = async (eventIds) => {
    assert.equal(eventIds.length, 1);
    arrivals += 1;
    if (arrivals === 2) releaseDiscovery();
    await discoveryBarrier;
  };
  const acceptingFetch = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const results = await Promise.all([
    syncOnce({ repository: firstRepository, fetchImpl: acceptingFetch, onAfterReemitDiscovery: afterDiscovery }),
    syncOnce({ repository: secondRepository, fetchImpl: acceptingFetch, onAfterReemitDiscovery: afterDiscovery }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["ok", "ok"]);
  assert.equal(results.reduce((sum, result) => sum + result.reemitted, 0), 1);
  const pair = firstRepository.db.prepare(`
    SELECT event_id, op FROM events WHERE entity_id = ? AND entity_version > 2 ORDER BY entity_version
  `).all(saved.proposal_id);
  assert.deepEqual(pair.map((event) => event.op), ["proposal_created", "proposal_approved"]);
  const rejectionLink = firstRepository.db.prepare(`
    SELECT reemitted_event_id FROM hosted_sync_uploads
    WHERE wire_entity_id = ? AND outcome = 'superseded_by_reemit'
  `).get(saved.proposal_id);
  assert.equal(rejectionLink.reemitted_event_id, pair[0].event_id);
});

test("linked recorded rejection lookup is indexed and does not touch the event journal", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => repository.close());
  await bootstrap(repository);
  const key = createHash("sha256")
    .update(`https://passport.example\0${repository.metadata().replica_id}`)
    .digest("hex");
  const insert = repository.db.prepare(`
    INSERT INTO hosted_sync_uploads(
      link_key, event_id, source_rowid, upload_seq, wire_entity_id, state, outcome, reemitted_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  repository.db.transaction(() => {
    for (let index = 1; index <= 2000; index += 1) {
      insert.run(key, `completed-${index}`, index, index, `entity-${index}`, "complete", "accepted", null);
    }
    insert.run(key, "linked-rejection", 2001, 2001, "linked-entity", "rejected_recorded",
      "superseded_by_reemit", "stable-reemit-link");
  })();
  const plan = repository.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT event_id FROM hosted_sync_uploads INDEXED BY hosted_sync_uploads_reemit_candidates
    WHERE link_key = ? AND state = 'rejected_recorded' AND reemitted_event_id IS NULL
    ORDER BY upload_seq
  `).all(key).map((row) => row.detail).join("\n");
  assert.match(plan, /hosted_sync_uploads_reemit_candidates/);
  assert.doesNotMatch(plan, /SCAN events/);
  const writesBefore = repository.db.prepare("SELECT total_changes() AS count").get().count;
  assert.equal(await reemitRecordedRejections(repository, key), 0);
  assert.equal(repository.db.prepare("SELECT total_changes() AS count").get().count, writesBefore);
});

test("concurrent first sync upgrade contention is unavailable and retryable", async (t) => {
  const home = temporaryHome(t);
  const firstRepository = new LocalRepository({ home, initializeDefaults: false });
  const secondRepository = new LocalRepository({ home, initializeDefaults: false });
  t.after(() => firstRepository.close());
  t.after(() => secondRepository.close());
  linked(firstRepository);
  firstRepository.db.exec(`
    CREATE TABLE hosted_sync_uploads (
      link_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      source_rowid INTEGER NOT NULL,
      upload_seq INTEGER NOT NULL,
      wire_entity_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'rejected_recorded')),
      outcome TEXT,
      PRIMARY KEY (link_key, event_id),
      UNIQUE (link_key, upload_seq)
    )
  `);
  const emptyFetch = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot") || call.url.includes("/sync/v1/changes?cursor=0")) {
      return jsonResponse(emptyPage("0"));
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error("unexpected request");
  });
  let contender;
  const first = await syncOnce({
    repository: firstRepository,
    fetchImpl: emptyFetch,
    onAfterSyncUpgradeLock: () => {
      contender = syncOnce({ repository: secondRepository, fetchImpl: emptyFetch });
    },
  });
  const blocked = await contender;
  assert.equal(first.status, "ok");
  assert.equal(blocked.status, "unavailable");
  assert.equal((await syncOnce({ repository: secondRepository, fetchImpl: emptyFetch })).status, "ok");
  assert.equal(secondRepository.db.prepare("PRAGMA table_info(hosted_sync_uploads)").all()
    .filter((column) => column.name === "reemitted_event_id").length, 1);
  assert.equal(secondRepository.db.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'index' AND name = 'hosted_sync_uploads_reemit_candidates'
  `).get().count, 1);
});

test("incremental tombstones dominate local approval and are acknowledged before upload", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Sync test" });
  const saved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "sync-tombstone",
    category: "fact",
    content: "Local approval must lose to the remote tombstone.",
  });
  const memory = repository.listMemories()[0];
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      return jsonResponse({
        ...emptyPage("9"),
        tombstones: [tombstoneRow({
          change_seq: "9", entity_id: saved.proposal_id, hosted_memory_id: memory.memory_id,
          category: "fact", occurred_at: "2026-08-24T12:05:00.000Z",
        })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      assert.equal(fetchImpl.calls.at(-2).url.endsWith("/sync/v1/ack"), true, "the fence is acknowledged before upload");
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.tombstones, 1);
  assert.equal(repository.listMemories().length, 0);
  repository.close();
});

test("a null-memory hosted tombstone is a valid first-class local fence", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const entityId = "82000000-0000-4000-8000-000000000009";
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      return jsonResponse({
        ...emptyPage("10"),
        tombstones: [tombstoneRow({
          change_seq: "10", entity_id: entityId, hosted_memory_id: null,
          hosted_proposal_id: null, category: null,
          deletion_fence_id: "82000000-0000-4000-8000-000000000010",
          deleted_entity_version: 2,
        })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      return jsonResponse({ ok: true, cursor: call.body.cursor });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.tombstones, 1);
  assert.equal(acknowledgements, 1);
  assert.ok(repository.db.prepare("SELECT 1 FROM tombstones WHERE entity_id = ?").get(entityId));
  repository.close();
});

test("upload resumes after response loss with the same event ids and accepts duplicates", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Resume test" });
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "sync-resume",
    category: "instruction",
    content: "Resume the same domain events after a lost response.",
  });
  const uploads = [];
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploads.push(call.body.events);
      const duplicate = uploads.length > 1;
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: duplicate ? "duplicate" : "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  let loseResponse = true;
  const first = await syncOnce({
    repository,
    fetchImpl,
    onAfterUploadResponse: () => {
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated crash after server receipt");
      }
    },
  });
  assert.equal(first.status, "unavailable");
  const second = await syncOnce({ repository, fetchImpl });
  assert.equal(second.status, "ok");
  assert.equal(second.pushed, 2);
  assert.deepEqual(uploads[0].map((event) => event.replica_seq), [1, 2], "unsupported local events do not create hosted sequence gaps");
  assert.deepEqual(uploads[1].map((event) => [event.event_id, event.replica_seq]), uploads[0].map((event) => [event.event_id, event.replica_seq]));
  repository.close();
});

test("replay validates the assigned range and lets the server settle locally deleted content", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  repository.propose({
    save_id: "replay-deleted-content",
    category: "project",
    content: "This content is deleted locally after its first completed upload.",
  }, { owner: true });
  let uploadPage = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploadPage += 1;
      if (uploadPage === 2) assert.deepEqual(call.body.content_records, []);
      return jsonResponse({
        outcomes: call.body.events.map((event, index) => uploadPage === 2 && index === 0
          ? { event_id: event.event_id, status: "rejected", reason: "content_missing" }
          : { event_id: event.event_id, status: "accepted" }),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  repository.db.prepare("DELETE FROM content_records").run();
  await assert.rejects(() => syncOnce({ repository, fetchImpl, replayFrom: 0 }),
    /positive integer within the assigned range/);
  await assert.rejects(() => syncOnce({ repository, fetchImpl, replayFrom: 3 }),
    /positive integer within the assigned range/);
  const replayed = await syncOnce({ repository, fetchImpl, replayFrom: 1 });
  assert.equal(replayed.status, "ok");
  assert.equal(replayed.replay_queued, 2);
  assert.equal(replayed.conflicts, 1);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'complete'
  `).get().count, 2);
  repository.close();
});

test("review proposals sync as pending while hand-off and message events and content stay local", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Custody test" });
  repository.setAutoApprove(false);
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "sync-pending",
    category: "project",
    content: "PENDING_PROPOSAL_CONTENT",
  });
  repository.createHandoff({
    client_id: client.client_id,
    client_secret: client.client_secret,
    snapshot: "HANDOFF_CONTENT_MUST_STAY_LOCAL",
    to_client_id: client.client_id,
  });
  repository.sendMessage({
    client_id: client.client_id, client_secret: client.client_secret,
    to: client.client_id, body: "MESSAGE_CONTENT_MUST_STAY_LOCAL",
    idempotency_key: "58000000-0000-4000-8000-000000000001",
  });
  let uploadBody;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploadBody = call.body;
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.skipped_handoffs, 1);
  assert.deepEqual(uploadBody.events.map((event) => event.op), ["proposal_created"]);
  assert.equal(uploadBody.content_records[0].content, "PENDING_PROPOSAL_CONTENT");
  assert.equal(JSON.stringify(uploadBody).includes("HANDOFF_CONTENT_MUST_STAY_LOCAL"), false);
  assert.equal(JSON.stringify(uploadBody).includes("MESSAGE_CONTENT_MUST_STAY_LOCAL"), false);
  assert.equal(JSON.stringify(result).includes("PENDING_PROPOSAL_CONTENT"), false);
  repository.close();
});

test("pull_required loops through a self-fence and then re-pushes successfully", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Fence test" });
  const saved = repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "sync-self-fence",
    category: "project",
    content: "A memory used to create a self-fence.",
  });
  const memory = repository.listMemories()[0];
  repository.deleteMemory(memory.memory_id);
  let uploads = 0;
  let offeredFence = false;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      if (!offeredFence) return jsonResponse(emptyPage("0"));
      return jsonResponse({
        ...emptyPage("15"),
        tombstones: [tombstoneRow({
          change_seq: "15", entity_id: saved.proposal_id, hosted_memory_id: memory.memory_id,
          occurred_at: "2026-08-24T13:00:00.000Z",
        })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploads += 1;
      if (uploads === 1) {
        offeredFence = true;
        return jsonResponse({ error: "pull_required", reason: "remote_fence_pending", required_cursor: "15" }, 409);
      }
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.new_cursor, "15");
  assert.equal(uploads, 2);
  repository.close();
});

test("server supersession surfaces a content-free conflict pointer", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  await bootstrap(repository);
  const client = repository.addClient({ host: "codex", label: "Conflict test" });
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "sync-conflict",
    category: "preference",
    content: "CONFLICT_CONTENT_SENTINEL",
  });
  let rejected = false;
  const winner = "82000000-0000-4000-8000-000000000001";
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      return jsonResponse({
        outcomes: call.body.events.map((event, index) => {
          if (!rejected && index === call.body.events.length - 1) {
            rejected = true;
            return { event_id: event.event_id, status: "rejected", reason: "superseded", winner_event_id: winner };
          }
          return { event_id: event.event_id, status: "accepted" };
        }),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.conflicts, 1);
  assert.equal(result.superseded, 1);
  assert.equal(result.conflict_rows[0].winner_event_id, winner);
  assert.equal(JSON.stringify(result).includes("CONFLICT_CONTENT_SENTINEL"), false);
  repository.close();
});

test("invalid or cross-kind pull rows fail transactionally before ack and push", async (t) => {
  const cases = [
    {
      name: "incomplete fence",
      page: { ...emptyPage("1"), fences: [{ change_seq: "1", entity_id: "85000000-0000-4000-8000-000000000001" }] },
    },
    {
      name: "tombstone placed in fences",
      page: { ...emptyPage("1"), fences: [tombstoneRow({ change_seq: "1" })] },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const repository = new LocalRepository({ home: temporaryHome(subtest), initializeDefaults: false });
      await bootstrap(repository);
      const client = repository.addClient({ host: "codex", label: "Pull validation" });
      repository.propose({
        client_id: client.client_id,
        client_secret: client.client_secret,
        save_id: `invalid-page-${entry.name.replaceAll(" ", "-")}`,
        category: "fact",
        content: "This local memory must survive an invalid page.",
      });
      let acknowledgements = 0;
      let uploads = 0;
      const fetchImpl = scriptedFetch((call) => {
        if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(entry.page);
        if (call.url.endsWith("/sync/v1/ack")) acknowledgements += 1;
        if (call.url.endsWith("/sync/v1/events")) uploads += 1;
        throw new Error("unexpected request");
      });
      const result = await syncOnce({ repository, fetchImpl });
      assert.equal(result.status, "invalid_response");
      assert.equal(result.pulled, 0);
      assert.equal(result.applied, 0);
      assert.equal(acknowledgements, 0);
      assert.equal(uploads, 0);
      assert.equal(repository.listMemories().length, 1);
      assert.equal(repository.db.prepare("SELECT count(*) AS count FROM hosted_sync_changes").get().count, 0);
      repository.close();
    });
  }
});

test("unsupported proposal categories skip their whole lifecycle before sequence allocation", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  const client = repository.addClient({ host: "codex", label: "Category filter" });
  await bootstrap(repository);
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "unsupported-relationship",
    category: "relationship",
    content: "This relationship lifecycle stays local.",
  });
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "supported-fact",
    category: "fact",
    content: "This fact lifecycle can be hosted.",
  });
  let uploadBody;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) {
      uploadBody = call.body;
      return jsonResponse({
        outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    throw new Error("unexpected request");
  });
  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.skipped, 2);
  assert.deepEqual(uploadBody.events.map((event) => event.op), ["proposal_created", "proposal_approved"]);
  assert.deepEqual(uploadBody.events.map((event) => event.replica_seq), [1, 2]);
  assert.equal(JSON.stringify(uploadBody).includes("relationship lifecycle"), false);
  repository.close();
});

test("upload completion requires a closed outcome and proven hosted sequence", async (t) => {
  const cases = [
    {
      name: "unknown status",
      response(events) {
        return { outcomes: [{ event_id: events[0].event_id, status: "ignored" }, { event_id: events[1].event_id, status: "accepted" }], upload_seq: 2 };
      },
    },
    {
      name: "malformed upload sequence",
      response(events) {
        return { outcomes: events.map((event) => ({ event_id: event.event_id, status: "accepted" })), upload_seq: "2" };
      },
    },
    {
      name: "accepted outcome names a different winner",
      response(events) {
        return {
          outcomes: events.map((event, index) => ({
            event_id: event.event_id,
            status: "accepted",
            ...(index === 1 ? { winner_event_id: events[0].event_id } : {}),
          })),
          upload_seq: 2,
        };
      },
    },
    {
      name: "sequence one rejected before claim",
      response(events) {
        return {
          outcomes: [
            { event_id: events[0].event_id, status: "rejected", reason: "invalid_event" },
            { event_id: events[1].event_id, status: "rejected", reason: "sequence_gap", retryable: true },
          ],
          upload_seq: 0,
        };
      },
    },
    {
      name: "recorded rejection includes an extra field",
      response(events) {
        return {
          outcomes: [
            { event_id: events[0].event_id, status: "accepted" },
            { event_id: null, status: "rejected", reason: "invalid_event", retryable: true },
          ],
          upload_seq: 2,
        };
      },
    },
    {
      name: "recorded rejection has an unknown reason",
      response(events) {
        return {
          outcomes: [
            { event_id: events[0].event_id, status: "accepted" },
            { event_id: null, status: "rejected", reason: "new_server_reason" },
          ],
          upload_seq: 2,
        };
      },
    },
    {
      name: "recorded rejection has a malformed upload sequence",
      response(events) {
        return {
          outcomes: [
            { event_id: events[0].event_id, status: "accepted" },
            { event_id: null, status: "rejected", reason: "invalid_event" },
          ],
          upload_seq: "2",
        };
      },
    },
    ...[
      "dependency_unavailable",
      "application_incomplete",
      "claim_unavailable",
      "prior_pending",
      "sequence_gap",
    ].map((reason) => ({
      name: `null-event rejection cannot record ${reason}`,
      response(events) {
        return {
          outcomes: [
            { event_id: events[0].event_id, status: "accepted" },
            { event_id: null, status: "rejected", reason },
          ],
          upload_seq: events.at(-1).replica_seq,
        };
      },
    })),
  ];
  for (const [caseIndex, entry] of cases.entries()) {
    await t.test(entry.name, async (subtest) => {
      const repository = new LocalRepository({ home: temporaryHome(subtest), initializeDefaults: false });
      await bootstrap(repository);
      const client = repository.addClient({ host: "codex", label: "Outcome validation" });
      repository.propose({
        client_id: client.client_id,
        client_secret: client.client_secret,
        save_id: `outcome-${caseIndex}`,
        category: "fact",
        content: "Both lifecycle events must remain pending until sequence proof arrives.",
      });
      let offeredEvents;
      const fetchImpl = scriptedFetch((call) => {
        if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage("0"));
        if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
        if (call.url.endsWith("/sync/v1/events")) {
          offeredEvents = call.body.events;
          return jsonResponse(entry.response(call.body.events));
        }
        throw new Error("unexpected request");
      });
      const result = await syncOnce({ repository, fetchImpl });
      assert.equal(result.status, "invalid_response");
      assert.equal(result.rejected, 0);
      assert.deepEqual(offeredEvents.map((event) => event.replica_seq), [1, 2]);
      assert.equal(repository.db.prepare("SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'pending'").get().count, 2);
      assert.equal(repository.db.prepare("SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'complete'").get().count, 0);
      repository.close();
    });
  }
});

test("a memory feed row resolves through its hosted proposal and approves the original local proposal", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  linked(repository);
  const hostedProposal = "86000000-0000-4000-8000-000000000001";
  const hostedMemory = "86000000-0000-4000-8000-000000000002";
  let cycle = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) {
      return jsonResponse({
        ...emptyPage("1"),
        proposals: [proposalRow({
          change_seq: "1", entity_id: hostedProposal, content: "The approved hosted content.",
        })],
      });
    }
    if (call.url.includes("/sync/v1/changes?cursor=1")) {
      return jsonResponse({
        ...emptyPage("3"),
        proposals: [proposalRow({
          change_seq: "2", entity_id: hostedProposal, hosted_memory_id: hostedMemory,
          lifecycle_state: "approved", content: null, decided_at: "2026-08-24T12:05:00.000Z",
        })],
        memories: [memoryRow({
          change_seq: "3", entity_id: hostedMemory, hosted_proposal_id: hostedProposal,
          hosted_memory_id: hostedMemory, content: "The approved hosted content.",
        })],
      });
    }
    if (call.url.endsWith("/sync/v1/ack")) {
      cycle += 1;
      return jsonResponse({ ok: true, cursor: call.body.cursor });
    }
    throw new Error("unexpected request");
  });
  const pending = await syncOnce({ repository, fetchImpl });
  assert.equal(pending.status, "ok");
  assert.equal(repository.listInbox().length, 1);
  const originalProposalId = repository.listInbox()[0].proposal_id;
  const approved = await syncOnce({ repository, fetchImpl });
  assert.equal(approved.status, "ok");
  assert.equal(cycle, 2);
  assert.equal(repository.db.prepare("SELECT count(*) AS count FROM proposals").get().count, 1);
  assert.equal(repository.db.prepare("SELECT status FROM proposals WHERE proposal_id = ?").get(originalProposalId).status, "approved");
  assert.equal(repository.listInbox().length, 0);
  assert.equal(repository.listMemories().length, 1);
  const aliases = repository.db.prepare(`
    SELECT remote_entity_id FROM hosted_sync_entities
    WHERE remote_entity_id IN (?, ?) ORDER BY remote_entity_id
  `).all(hostedProposal, hostedMemory).map((row) => row.remote_entity_id);
  assert.deepEqual(aliases, [hostedProposal, hostedMemory]);
  repository.close();
});

test("invalid cursors never mutate local state or permit upload", async (t) => {
  const cases = [
    { name: "regression", status: "invalid_response", prepare(repository) { repository.db.prepare("UPDATE hosted_sync_state SET download_cursor = '5'").run(); }, response: () => jsonResponse(emptyPage("4")), urlCursor: "5", calls: 1 },
    { name: "signed bigint overflow", status: "invalid_response", response: () => jsonResponse(emptyPage("9223372036854775808")), urlCursor: "0", calls: 1 },
    { name: "unchanged cursor with more pages", status: "invalid_response", response: () => jsonResponse({ ...emptyPage("0"), has_more: true }), urlCursor: "0", calls: 3 },
    { name: "unexpected future reconciliation", status: "cursor_desync", response: () => jsonResponse({ error: "cursor_not_current", cursor: "9" }, 409), urlCursor: "0", calls: 1 },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const repository = new LocalRepository({ home: temporaryHome(subtest), initializeDefaults: false });
      await bootstrap(repository);
      entry.prepare?.(repository);
      const beforeCursor = repository.db.prepare("SELECT download_cursor FROM hosted_sync_state").get().download_cursor;
      const client = repository.addClient({ host: "codex", label: "Cursor validation" });
      repository.propose({
        client_id: client.client_id,
        client_secret: client.client_secret,
        save_id: `cursor-${entry.name.replaceAll(" ", "-")}`,
        category: "fact",
        content: "This upload must wait behind invalid cursor state.",
      });
      let pulls = 0;
      let acknowledgements = 0;
      let uploads = 0;
      const fetchImpl = scriptedFetch((call) => {
        if (call.url.includes(`/sync/v1/changes?cursor=${entry.urlCursor}`)) {
          pulls += 1;
          return entry.response();
        }
        if (call.url.endsWith("/sync/v1/ack")) acknowledgements += 1;
        if (call.url.endsWith("/sync/v1/events")) uploads += 1;
        throw new Error("unexpected request");
      });
      const result = await syncOnce({ repository, fetchImpl });
      assert.equal(result.status, entry.status);
      assert.equal(pulls, entry.calls);
      assert.equal(acknowledgements, 0);
      assert.equal(uploads, 0);
      assert.equal(repository.db.prepare("SELECT download_cursor FROM hosted_sync_state").get().download_cursor, beforeCursor);
      assert.equal(repository.db.prepare("SELECT count(*) AS count FROM hosted_sync_changes").get().count, 0);
      assert.equal(repository.db.prepare("SELECT count(*) AS count FROM hosted_sync_uploads").get().count, 0);
      assert.equal(repository.listMemories().length, 1);
      repository.close();
    });
  }
});

test("an unlinked store never issues a hosted request", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  let requests = 0;
  const result = await syncOnce({
    repository,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(result.status, "unlinked");
  assert.equal(requests, 0);
  repository.close();
});

test("network failure remains distinct from an empty hosted Passport", async (t) => {
  const repository = new LocalRepository({ home: temporaryHome(t) });
  linked(repository);
  const result = await syncOnce({
    repository,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(result.status, "network_failure");
  assert.equal(result.pulled, 0);
  repository.close();
});

test("CLI link status is local-only and unlink removes only the credential file", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  linked(repository);
  repository.close();
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const environment = { ...process.env, SWITCHBOARD_HOME: home };
  const status = spawnSync(process.execPath, [cli, "link", "--status"], { env: environment, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /linked: approved/);
  const unlink = spawnSync(process.execPath, [cli, "unlink"], { env: environment, encoding: "utf8" });
  assert.equal(unlink.status, 0, unlink.stderr);
  assert.match(unlink.stdout, /Revoke this device/);
  assert.equal(existsSync(path.join(home, "link.json")), false);
  assert.equal(existsSync(path.join(home, "passport.db")), true);
});

test("the real CLI keeps human recovery count-only and JSON recovery automation-safe", async (t) => {
  const home = temporaryHome(t);
  const uploadedBodies = [];
  let rejectOnce = true;
  let returnTerminalReplayConflicts = false;
  const replayWinner = "89000000-0000-4000-8000-000000000001";
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === "/sync/v1/link/tickets") {
      return send(201, {
        ticket_id: "98000000-0000-4000-8000-000000000001",
        link_url: `http://${request.headers.host}/switchboard-link?ticket=browser_ticket_value`,
        match_code: "9M4QKW",
        poll_secret: `sblp_${"q".repeat(43)}`,
        expires_at: "2026-08-25T12:10:00.000Z",
      });
    }
    if (request.url === "/sync/v1/link/tickets/98000000-0000-4000-8000-000000000001") return send(200, { status: "approved" });
    if (request.url === "/sync/v1/scope-key") return send(200, { owner_scope_key: "c".repeat(64) });
    if (request.url === "/sync/v1/changes?cursor=0") return send(200, emptyPage("0"));
    if (request.url === "/sync/v1/snapshot") return send(200, emptyPage("0"));
    if (request.method === "POST" && request.url === "/sync/v1/ack") return send(200, { ok: true, cursor: JSON.parse(body).cursor });
    if (request.method === "POST" && request.url === "/sync/v1/events") {
      const uploadedBody = JSON.parse(body);
      uploadedBodies.push(uploadedBody);
      const rejectThisPage = rejectOnce;
      rejectOnce = false;
      return send(200, {
        outcomes: uploadedBody.events.map((event, index) => {
          if (rejectThisPage && index === uploadedBody.events.length - 1) {
            return { event_id: null, status: "rejected", reason: "invalid_event" };
          }
          if (returnTerminalReplayConflicts && index === 0) {
            return { event_id: event.event_id, status: "rejected", reason: "content_missing" };
          }
          if (returnTerminalReplayConflicts && index === 1) {
            return { event_id: event.event_id, status: "rejected", reason: "superseded", winner_event_id: replayWinner };
          }
          return { event_id: event.event_id, status: "accepted" };
        }),
        upload_seq: uploadedBody.events.at(-1).replica_seq,
      });
    }
    return send(404, { error: "not_found" });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("loopback listen is denied in this sandbox; injected-fetch coverage exercises the real repository");
      return;
    }
    throw error;
  }
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_NO_BROWSER_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const link = await run(["link", baseUrl]);
  assert.equal(link.code, 0, link.stderr);
  assert.match(link.stdout, /Switchboard is linked\./);
  const sync = await run(["sync", "--json"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(JSON.parse(sync.stdout).status, "ok");

  const sentinel = "CLI_RECORDED_REJECTION_CONTENT_MUST_NOT_PRINT";
  const saveId = "cli-recorded-rejection";
  const repository = new LocalRepository({ home, initializeDefaults: false });
  repository.propose({
    save_id: saveId,
    category: "project",
    content: sentinel,
  }, { owner: true });
  repository.close();

  const rejected = await run(["sync"]);
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.equal(rejected.stderr, "");
  assert.match(rejected.stdout, /^rejected: 1$/m);
  assert.match(rejected.stdout, /^Issue #916: A memory could not sync and stays local; re-save it to retry\.$/m);
  assert.match(rejected.stdout, /^Re-emission queued the memory; run another sync to complete it\.$/m);
  const reemitted = await run(["sync"]);
  assert.equal(reemitted.code, 0, reemitted.stderr);
  assert.match(reemitted.stdout, /^reemitted: 1$/m);
  returnTerminalReplayConflicts = true;
  const replayed = await run(["sync", "--replay-from", "1"]);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /^queued_for_replay: 4$/m);
  assert.match(replayed.stdout, /^superseded: 1$/m);
  assert.match(replayed.stdout, /^conflicts: 2$/m);
  assert.match(replayed.stdout, /^Run switchboard memory list\.$/m);
  const recovered = await run(["sync", "--json", "--replay-from", "1"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const recoveryJson = JSON.parse(recovered.stdout);
  assert.equal(recoveryJson.conflicts, 2);
  assert.equal(recoveryJson.conflict_rows.length, 2);
  assert.equal(recoveryJson.conflict_rows.some((row) => row.winner_event_id === replayWinner), true);
  assert.ok(uploadedBodies.length >= 3);
  const privateValues = [
    ...uploadedBodies.flatMap((uploadedBody) => uploadedBody.events.flatMap((event) => [event.event_id, event.entity_id])),
    ...uploadedBodies.flatMap((uploadedBody) => uploadedBody.content_records.map((record) => record.content)),
    replayWinner,
  ];
  assert.equal(privateValues.includes(sentinel), true, "the privacy assertion covers content actually sent by sync");
  for (const value of privateValues) {
    assert.equal(rejected.stdout.includes(value), false, `CLI output must not include ${value === sentinel ? "content" : "an identifier"}`);
    assert.equal(reemitted.stdout.includes(value), false, `reemit output must not include ${value === sentinel ? "content" : "an identifier"}`);
    assert.equal(replayed.stdout.includes(value), false, `replay output must not include ${value === sentinel ? "content" : "an identifier"}`);
  }
  const recoveryOutput = recovered.stdout;
  for (const value of [sentinel, saveId, home, process.cwd()]) {
    assert.equal(recoveryOutput.includes(value), false, "recovery JSON must not include content, save_id text, or paths");
  }
  const recoveryIdentifiers = recoveryJson.conflict_rows.flatMap((row) =>
    [row.event_id, row.entity_id, row.winner_event_id].filter(Boolean));
  assert.equal(recoveryIdentifiers.every((value) => recoveryOutput.includes(value)), true,
    "recovery JSON permits opaque identifiers for automation");
});
