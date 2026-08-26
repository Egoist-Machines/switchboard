import { createTtlCache } from "./cache.js";
import { createPlaneTransport } from "./transport.js";

// The host-neutral /agent/prefetch client (issue #425 phase 1 plane).
//
// Contract this side of the wire commits to:
//   - it NEVER throws. Both callers sit on paths where a rejection is worse
//     than an empty answer: a rejected explicit-memory supplement fails the
//     agent's whole search, and a rejected prompt hook costs the turn. Every
//     failure resolves to the last good answer, or to null.
//   - it never nags. The route is side-effect-free by construction (no access
//     requests, no pass claims, no receipts), so polling it is cheap for the
//     owner; the plugin keeps it cheap for the backend with a TTL cache and by
//     honoring 429 with a real backoff instead of a retry loop.
//   - it logs a given failure class once per backoff window, not per turn.
//
// The request mechanics (bearer, redirect refusal, per-class backoff, the
// forbidden probe-then-latch, budget, 401 retry, terminal verdicts) live in
// src/transport.js, shared with the tool-policy reporter; what stays here is
// what is prefetch-SHAPED: the TTL cache with stale-on-error, row retention
// for memory_get, single-flight per cache key, and response normalization.

// The backend's own request bounds (lib/agentBackendRoutes.js). Clamping here
// rather than in each caller means a long user prompt or an unusual session
// key can never turn into a 400 that backs the whole plugin off.
const QUERY_MAX_LENGTH = 256;
const SESSION_KEY_MAX_LENGTH = 128;
const LIMIT_MAX = 50;

export function clampQuery(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, QUERY_MAX_LENGTH);
}

export function clampSessionKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, SESSION_KEY_MAX_LENGTH);
}

export function mergeRows(resultSets, limit) {
  const seen = new Set();
  const merged = [];
  for (const rows of resultSets) {
    for (const row of rows) {
      if (merged.length >= limit) return merged;
      if (seen.has(row.memory_id)) continue;
      seen.add(row.memory_id);
      merged.push(row);
    }
  }
  return merged;
}

const clampLimit = (value, fallback) => {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(LIMIT_MAX, Math.max(1, candidate));
};

// Client-side share of the backend's per-client prefetch throttle (60/min).
// All concurrent sessions of one install share a client_id, and novel prompt
// text makes most context reads cache misses, so an uncapped process can trip
// the backend throttle and black out EVERY surface for a minute. Spending at
// most half the budget leaves headroom for the install's other processes
// (gateway, cron, CLI) before the backend has to say 429.
const REQUEST_BUDGET_MAX = 30;

export function createPassportClient({ config, credentials, fetchImpl = globalThis.fetch, logger = null, now = () => Date.now() }) {
  const transport = createPlaneTransport({
    config,
    credentials,
    fetchImpl,
    logger,
    now,
    label: "prefetch",
    budgetMax: REQUEST_BUDGET_MAX,
  });
  const cache = createTtlCache({ ttlMs: config.cacheTtlMs, now });
  // memory_get has no backend equivalent on this plane (prefetch is a search,
  // not a read-by-id), so rows seen in any answer are retained for the corpus
  // supplement's get(). Bounded, and content the owner already approved.
  const rowsById = new Map();
  const MAX_RETAINED_ROWS = 200;
  // In-flight requests by cache key (the same reason lib/trustLoop.js
  // memoizes its namespace reads): the TTL cache stores only COMPLETED
  // answers, so at cold start or on TTL expiry N concurrent turns of one
  // gateway would otherwise each spend the request budget, and the backend's
  // 60/min ceiling, on N copies of one identical read.
  const pendingByKey = new Map();

  const rememberRows = (rows) => {
    for (const row of rows) {
      if (!row?.memory_id) continue;
      rowsById.delete(row.memory_id);
      rowsById.set(row.memory_id, row);
    }
    while (rowsById.size > MAX_RETAINED_ROWS) {
      const oldest = rowsById.keys().next();
      if (oldest.done) break;
      rowsById.delete(oldest.value);
    }
  };

  // The backend answers a closed vocabulary; anything else is a version skew
  // and is dropped rather than forwarded into a prompt.
  const normalize = (payload) => {
    const rows = Array.isArray(payload?.rows)
      ? payload.rows
          .filter((row) => row && typeof row.memory_id === "string" && typeof row.content === "string")
          .map((row) => ({
            memory_id: row.memory_id,
            content: row.content,
            category: typeof row.category === "string" ? row.category : "other",
            created_at: typeof row.created_at === "string" ? row.created_at : null,
            source: typeof row.source === "string" ? row.source : null,
          }))
      : [];
    const skipped = Array.isArray(payload?.skipped_categories)
      ? payload.skipped_categories
          .filter((entry) => entry && typeof entry.category === "string" && typeof entry.reason === "string")
          .map((entry) => ({ category: entry.category, reason: entry.reason }))
      : [];
    const approvalUrl = typeof payload?.approval_url === "string" ? payload.approval_url : null;
    return { rows, skipped, approvalUrl };
  };

  const client = {
    /**
     * Ask for the owner-approved rows in `categories`. Resolves to
     * {rows, skipped, approvalUrl, stale} or null when nothing is knowable.
     */
    async prefetch({ categories, query = null, limit, sessionKey = null, timeoutMs }) {
      const boundedQuery = clampQuery(query);
      const boundedSessionKey = clampSessionKey(sessionKey);
      const boundedLimit = clampLimit(limit, 20);
      // session_key is deliberately NOT part of the cache key: the backend
      // validates it and then ignores it (reserved for the policy plane's
      // audit events), so the answer is identical across sessions and keying
      // on it would turn one read into a cache miss per concurrent session.
      const cacheKey = JSON.stringify([categories, boundedLimit, boundedQuery ?? ""]);
      const cached = cache.get(cacheKey);
      if (cached.hit && cached.fresh) return { ...cached.value, stale: false };
      const pending = pendingByKey.get(cacheKey);
      if (pending) return pending;
      const attempt = client._prefetchOnce({ categories, boundedQuery, boundedSessionKey, boundedLimit, cacheKey, cached, timeoutMs });
      pendingByKey.set(cacheKey, attempt);
      try {
        return await attempt;
      } finally {
        pendingByKey.delete(cacheKey);
      }
    },

    // The single-flight body behind prefetch(); every concurrent caller of one
    // cache key awaits the same invocation of this.
    async _prefetchOnce({ categories, boundedQuery, boundedSessionKey, boundedLimit, cacheKey, cached, timeoutMs }) {
      const serveStale = () => (cached.hit ? { ...cached.value, stale: true } : null);

      // session_key has no pass-lifecycle effect today (an agent session pass
      // is a plain 24h cap and concurrent sessions of one install share it);
      // it is sent so the plugin's request contract is already right for the
      // policy plane's per-session audit events.
      const body = {
        categories,
        ...(boundedQuery ? { query: boundedQuery } : {}),
        ...(boundedSessionKey ? { session_key: boundedSessionKey } : {}),
        limit: boundedLimit,
      };

      // Every failure class (terminal verdicts, backoff windows, the budget,
      // outages, refusals) is the transport's to classify and warn about;
      // this surface's only decision is that "no answer" means the last good
      // answer, and a fresh answer refreshes the cache.
      const payload = await transport.request({ path: "/agent/prefetch", method: "POST", body, timeoutMs });
      if (!payload) return serveStale();
      const value = normalize(payload);
      rememberRows(value.rows);
      cache.set(cacheKey, value);
      return { ...value, stale: false };
    },

    // Rows the plugin has already served this process, for memory_get.
    row(memoryId) {
      return rowsById.get(memoryId) ?? null;
    },

    __state() {
      return { ...transport.state(), cacheSize: cache.size, rows: rowsById.size };
    },
  };
  return client;
}
