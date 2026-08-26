import { readFile, stat } from "node:fs/promises";

import { GOVERNED_CATEGORIES } from "./config.js";
import { OPENCODE_HOST_METADATA } from "./host.js";
import { unavailableProposal, unavailableRead, withInternalReason } from "./outcomes.js";
import { createTtlCache } from "./shared/cache.js";
import { createCredentials } from "./shared/credentials.js";
import { createPlaneTransport } from "./shared/transport.js";

const QUERY_MAX_LENGTH = 256;
const SESSION_KEY_MAX_LENGTH = 128;
const LIMIT_MAX = 50;
const PREFETCH_BUDGET_MAX = 30;
const DEFAULT_CACHE_TTL_MS = 60_000;
const SKIP_REASONS = new Set(["no_pass", "once_only", "locked"]);

const boundedText = (value, max, collapseWhitespace = false) => {
  if (typeof value !== "string") return null;
  const normalized = collapseWhitespace ? value.replace(/\s+/g, " ").trim() : value.trim();
  return normalized ? normalized.slice(0, max) : null;
};

const boundedLimit = (value, fallback = 20) => {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(LIMIT_MAX, Math.max(1, candidate));
};

const nullableString = (value) => value === null || typeof value === "string";

function normalizeRow(row) {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    typeof row.memory_id !== "string" ||
    typeof row.content !== "string" ||
    !nullableString(row.source) ||
    !nullableString(row.created_at) ||
    !nullableString(row.occurred_at) ||
    !GOVERNED_CATEGORIES.includes(row.category) ||
    !nullableString(row.client_id) ||
    !nullableString(row.evidence_basis) ||
    !nullableString(row.record_kind) ||
    !nullableString(row.verified_issuer) ||
    !nullableString(row.verified_at)
  ) {
    return null;
  }
  return {
    memory_id: row.memory_id,
    content: row.content,
    source: row.source,
    created_at: row.created_at,
    occurred_at: row.occurred_at,
    category: row.category,
    client_id: row.client_id,
    evidence_basis: row.evidence_basis,
    record_kind: row.record_kind,
    verified_issuer: row.verified_issuer,
    verified_at: row.verified_at,
  };
}

export function normalizeHostedPrefetch(payload, { categories, asOf }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.rows) || !Array.isArray(payload.skipped_categories)) return null;

  const requested = new Set(categories);
  const rows = payload.rows.map(normalizeRow);
  if (rows.some((row) => !row) || rows.some((row) => !requested.has(row.category))) return null;

  const skippedCategories = payload.skipped_categories.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !requested.has(entry.category) ||
      !SKIP_REASONS.has(entry.reason)
    ) {
      return null;
    }
    return { category: entry.category, reason: entry.reason };
  });
  if (skippedCategories.some((entry) => !entry)) return null;

  let status = "empty";
  if (rows.length) status = "results";
  else if (new Set(skippedCategories.map((entry) => entry.category)).size === requested.size) {
    status = skippedCategories.every((entry) => entry.reason === "locked") ? "locked" : "blocked";
  }

  return {
    status,
    transport: "hosted",
    connectivity: "online",
    freshness: "fresh",
    as_of: asOf,
    rows,
    skipped_categories: skippedCategories,
  };
}

async function requireOwnerOnlyMode(credentialsPath) {
  const metadata = await stat(credentialsPath);
  if ((metadata.mode & 0o077) !== 0) {
    const error = new Error("unsafe_hosted_credentials_mode");
    error.code = "unsafe_hosted_credentials_mode";
    throw error;
  }
}

async function validateHostedCredentialsFile(credentialsPath) {
  await requireOwnerOnlyMode(credentialsPath);
  const record = JSON.parse(await readFile(credentialsPath, "utf8"));
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_hosted_credentials");
  for (const field of ["token_url", "client_id", "refresh_token"]) {
    if (typeof record[field] !== "string" || !record[field].trim()) throw new Error("invalid_hosted_credentials");
  }
  const tokenUrl = new URL(record.token_url);
  if (tokenUrl.protocol !== "https:" && tokenUrl.protocol !== "http:") throw new Error("invalid_hosted_credentials");
}

function guardedCredentials(credentials, credentialsPath) {
  if (!credentialsPath) return credentials;
  return {
    async baseUrl() {
      await validateHostedCredentialsFile(credentialsPath);
      return credentials.baseUrl();
    },
    async accessToken(options) {
      await validateHostedCredentialsFile(credentialsPath);
      return credentials.accessToken(options);
    },
  };
}

function unavailableReason(state) {
  if (state.backoffReason === "forbidden") return "hosted_plane_closed";
  if (state.terminalReason) return `hosted_credentials_${state.terminalReason}`;
  if (state.backoffReason) return `hosted_${state.backoffReason}`;
  return "hosted_unavailable";
}

export function createHostedTransport({
  credentialsPath,
  timeoutMs = 1500,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = null,
  credentials: suppliedCredentials = null,
} = {}) {
  const rawCredentials =
    suppliedCredentials ??
    createCredentials({
      credentialsPath,
      fetchImpl,
      now,
      logger,
      hostMetadata: OPENCODE_HOST_METADATA,
    });
  const credentials = guardedCredentials(rawCredentials, suppliedCredentials ? null : credentialsPath);
  const plane = createPlaneTransport({
    config: { baseUrl: null },
    credentials,
    fetchImpl,
    logger,
    now,
    label: "prefetch",
    budgetMax: PREFETCH_BUDGET_MAX,
  });
  const cache = createTtlCache({ ttlMs: cacheTtlMs, now });
  const pending = new Map();
  let lastOutcome = null;
  let lastReason = null;

  const read = async (input = {}) => {
    const categories = Array.isArray(input.categories)
      ? [...new Set(input.categories.filter((category) => GOVERNED_CATEGORIES.includes(category)))]
      : [];
    if (!categories.length) {
      lastOutcome = "unavailable";
      lastReason = "invalid_contract";
      return unavailableRead("hosted", lastReason);
    }
    const query = boundedText(input.query, QUERY_MAX_LENGTH, true);
    const sessionKey = boundedText(input.session_id ?? input.session_key, SESSION_KEY_MAX_LENGTH);
    const limit = boundedLimit(input.limit);
    const key = JSON.stringify([categories, limit, query ?? ""]);
    const cached = cache.get(key);
    if (cached.hit && cached.fresh) {
      lastOutcome = cached.value.status;
      lastReason = null;
      return structuredClone(cached.value);
    }
    if (pending.has(key)) return pending.get(key);

    const attempt = (async () => {
      const unavailableOrStale = (reason) => {
        lastReason = reason;
        if (cached.hit) {
          const stale = {
            ...structuredClone(cached.value),
            connectivity: "offline",
            freshness: "stale",
          };
          lastOutcome = stale.status;
          return withInternalReason(stale, reason);
        }
        lastOutcome = "unavailable";
        return unavailableRead("hosted", reason);
      };
      const payload = await plane.request({
        path: "/agent/prefetch",
        method: "POST",
        body: {
          categories,
          ...(query ? { query } : {}),
          ...(sessionKey ? { session_key: sessionKey } : {}),
          limit,
        },
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : timeoutMs,
      });
      if (!payload) {
        return unavailableOrStale(unavailableReason(plane.state()));
      }

      const asOf = new Date(now()).toISOString();
      const normalized = normalizeHostedPrefetch(payload, { categories, asOf });
      if (!normalized) {
        return unavailableOrStale("invalid_contract");
      }
      cache.set(key, normalized);
      lastOutcome = normalized.status;
      lastReason = null;
      return structuredClone(normalized);
    })().finally(() => pending.delete(key));
    pending.set(key, attempt);
    return attempt;
  };

  return {
    async status() {
      let paired = Boolean(suppliedCredentials);
      if (!paired && credentialsPath) {
        try {
          await validateHostedCredentialsFile(credentialsPath);
          paired = true;
        } catch {}
      }
      return {
        transport: "hosted",
        paired,
        lastOutcome,
        lastReason,
      };
    },
    prefetch: read,
    recall(input = {}) {
      return read({ ...input, ambient: false });
    },
    propose(input = {}) {
      lastOutcome = "unavailable";
      lastReason = "hosted_propose_unsupported";
      return Promise.resolve(unavailableProposal("hosted", lastReason, input.save_id));
    },
    __state() {
      return { ...plane.state(), cacheSize: cache.size, lastOutcome, lastReason };
    },
  };
}
