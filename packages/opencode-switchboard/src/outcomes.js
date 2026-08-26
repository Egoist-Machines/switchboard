import { GOVERNED_CATEGORIES } from "./config.js";

export const READ_STATUSES = Object.freeze(["results", "empty", "blocked", "locked", "unavailable"]);
export const PROPOSAL_STATUSES = Object.freeze(["recorded", "duplicate", "rejected", "unavailable"]);

export function unavailableRead(transport, internalReason) {
  return withInternalReason(
    {
      status: "unavailable",
      transport,
      connectivity: "offline",
      freshness: "stale",
      as_of: null,
      rows: [],
      skipped_categories: [],
    },
    internalReason
  );
}

export function unavailableProposal(transport, internalReason, saveId = null) {
  return withInternalReason(
    {
      status: "unavailable",
      proposal_id: null,
      save_id: typeof saveId === "string" && saveId ? saveId : null,
      disposition: "pending",
    },
    internalReason
  );
}

export function withInternalReason(outcome, internalReason) {
  Object.defineProperty(outcome, "internalReason", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: internalReason,
  });
  return outcome;
}

export function normalizeReadOutcome(payload, transport) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!READ_STATUSES.includes(payload.status)) return null;
  if (!Array.isArray(payload.rows) || !Array.isArray(payload.skipped_categories)) return null;
  if (payload.transport !== transport) return null;
  if (payload.connectivity !== "online" && payload.connectivity !== "offline") return null;
  if (payload.freshness !== "fresh" && payload.freshness !== "stale") return null;
  if (payload.as_of !== null && typeof payload.as_of !== "string") return null;
  if (payload.status === "results" && payload.rows.length === 0) return null;
  if (payload.status !== "results" && payload.rows.length > 0) return null;
  const nullableString = (value) => value === null || typeof value === "string";
  const rows = payload.rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      typeof row.memory_id === "string" &&
      typeof row.content === "string" &&
      nullableString(row.source) &&
      typeof row.created_at === "string" &&
      GOVERNED_CATEGORIES.includes(row.category) &&
      nullableString(row.occurred_at) &&
      nullableString(row.client_id) &&
      nullableString(row.evidence_basis) &&
      nullableString(row.record_kind) &&
      nullableString(row.verified_issuer) &&
      nullableString(row.verified_at)
  );
  if (rows.length !== payload.rows.length) return null;
  const skippedCategories = payload.skipped_categories.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      GOVERNED_CATEGORIES.includes(entry.category) &&
      GOVERNED_SKIP_REASONS.has(entry.reason)
  );
  if (skippedCategories.length !== payload.skipped_categories.length) return null;
  return {
    status: payload.status,
    transport,
    connectivity: payload.connectivity,
    freshness: payload.freshness,
    as_of: payload.as_of,
    rows,
    skipped_categories: skippedCategories,
  };
}

export function normalizeProposalOutcome(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!PROPOSAL_STATUSES.includes(payload.status)) return null;
  if (payload.disposition !== "auto_approved" && payload.disposition !== "pending") return null;
  if (typeof payload.save_id !== "string" || !payload.save_id) return null;
  if (payload.proposal_id !== null && typeof payload.proposal_id !== "string") return null;
  return {
    status: payload.status,
    proposal_id: payload.proposal_id,
    save_id: payload.save_id,
    disposition: payload.disposition,
  };
}

const GOVERNED_SKIP_REASONS = new Set(["no_pass", "once_only", "locked"]);
