import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomically } from "./atomicFile.js";
import { clampSessionKey } from "./client.js";
import { createPlaneTransport } from "./transport.js";

// The host-neutral tool-policy reporter (issue #425 phase 4, audit-only).
//
// A `before_tool_call` hook posts every tool call's NAME and an argument
// DIGEST to POST /agent/policy/check, which is what puts the owner's activity
// feed in front of calls MCP alone could never see (exec, browse, message
// sends). Phase 4 is audit-only end to end: the backend answers allow for
// everything, and the hook below never blocks and never even awaits the
// answer, so the report costs the tool call nothing.
//
// Contract, same as src/client.js: the reporter NEVER throws, never loops,
// and keeps itself inside the backend's per-route throttle with a dedupe
// cache plus the shared transport's backoff and budget (src/transport.js
// owns all of the request mechanics for both surfaces).
//
// Content boundary: the tool's arguments never leave the machine. What is
// sent is sha256 over a canonical JSON form, which the backend shape-checks
// (h1_ + 64 hex) exactly so argument TEXT cannot end up in the owner's feed.

// Mirrors the backend's TOOL_SHAPE (lib/agentPolicy.js). Checked CLIENT-side
// because the backend answers 400 for a name outside it, and a 400 latches
// the version-skew backoff: one oddly named tool must cost its own report,
// not five minutes of everyone else's.
const TOOL_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

// Fallback when a response carries no usable cache_ttl; the backend's
// documented value is 60s.
const DEFAULT_CACHE_TTL_S = 60;
const MAX_CACHE_TTL_S = 600;
// Identical (tool, digest) answers within the TTL are served locally, so the
// cache is also the dedupe that keeps a tool-calling loop from hammering the
// plane. Bounded: a runaway generator of novel arguments must not grow it
// without limit.
const MAX_CACHED_ANSWERS = 512;

// Client-side share of the backend's check budget (600/min per client). All
// concurrent sessions of one install share the client_id, so an uncapped
// process could trip the backend throttle and starve the snapshot and
// decisions legs that share the plane.
const REQUEST_BUDGET_MAX = 300;

// How often the cached snapshot is refreshed while calls keep coming, and how
// often a pending approval is re-polled. Both sit far inside the backend's
// per-route budgets (snapshot 120/min, decisions 300/min).
const SNAPSHOT_TTL_MS = 60_000;
const APPROVAL_POLL_INTERVAL_MS = 3000;

// The matcher twin for LOCAL evaluation during an outage (enforce mode only).
// Same tiny grammar and the same total order as lib/agentPolicy.js on the
// backend: exact beats prefix, longer prefix beats shorter, bare `*` is the
// floor, default allow. SNAPSHOT_VERSION 1 is the contract that keeps the two
// in step; a snapshot with a higher version is refused rather than
// half-understood.
const SNAPSHOT_VERSION = 1;
const PATTERN_SHAPE = /^([A-Za-z0-9_][A-Za-z0-9_.:-]*\*?|\*)$/;
const POLICY_ACTIONS = ["allow", "deny", "require_approval"];

export function resolveLocalPolicy(tool, rules) {
  const fallback = { action: "allow", matchedPattern: null };
  if (typeof tool !== "string" || !TOOL_SHAPE.test(tool) || !Array.isArray(rules)) return fallback;
  let best = fallback;
  let bestScore = -1;
  for (const rule of rules) {
    const pattern = rule?.tool_pattern;
    const action = rule?.action;
    if (typeof pattern !== "string" || !PATTERN_SHAPE.test(pattern) || !POLICY_ACTIONS.includes(action)) continue;
    const matches = pattern === "*" || (pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool);
    if (!matches) continue;
    const score = pattern === "*" ? 0 : pattern.endsWith("*") ? pattern.length : 1000 + pattern.length;
    if (score > bestScore) {
      bestScore = score;
      best = { action, matchedPattern: pattern };
    }
  }
  return best;
}

export function canonicalJson(value) {
  if (typeof value === "number") {
    // Refuse non-finite numbers instead of letting JSON.stringify quietly
    // spell them "null": the Python twin (hermes-passport policy_hook.py)
    // digests with allow_nan=False and answers "no digest", and the two
    // clients must agree on which inputs are canonicalizable at all.
    if (!Number.isFinite(value)) throw new RangeError("non-finite number");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  // undefined, functions, symbols: nothing canonical to say.
  return "null";
}

/**
 * `h1_` + sha256 over a key-sorted JSON form of the params, or null when the
 * params cannot be canonicalized (circular structures, exotic values). Null
 * is a valid check-route value meaning "no digest", so failure here degrades
 * to a slightly coarser audit row rather than a dropped one.
 */
export function argsDigest(params) {
  if (params === undefined || params === null) return null;
  try {
    return `h1_${createHash("sha256").update(canonicalJson(params), "utf8").digest("hex")}`;
  } catch {
    return null;
  }
}

export function createPolicyReporter({
  config,
  credentials,
  fetchImpl = globalThis.fetch,
  logger = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Where the last real snapshot persists across processes (the plugin wires
  // config.policySnapshotPath). Null disables persistence, which is what the
  // suite wants unless a test is about persistence itself.
  snapshotPath = null,
}) {
  const transport = createPlaneTransport({
    config,
    credentials,
    fetchImpl,
    logger,
    now,
    label: "policy check",
    budgetMax: REQUEST_BUDGET_MAX,
  });
  const answers = new Map(); // key -> {value, expiresAt}
  const pendingByKey = new Map();

  // The last snapshot the plane served: {mode, rules, fetchedAt}. This is the
  // outage posture in enforce mode (evaluate the last-known rules locally)
  // and the mode detector that decides whether a tool call awaits its
  // verdict. PERSISTED beside the credentials file (same trust boundary):
  // rules are the owner's standing policy, and a gateway restart during a
  // Passport outage must not silently drop their Block rules to the audit
  // posture until the plane answers again.
  const loadPersistedSnapshot = () => {
    if (!snapshotPath) return null;
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
      if (
        parsed &&
        parsed.version === SNAPSHOT_VERSION &&
        (parsed.mode === "enforce" || parsed.mode === "audit") &&
        Array.isArray(parsed.rules) &&
        typeof parsed.fetchedAt === "number" &&
        Number.isFinite(parsed.fetchedAt) &&
        parsed.fetchedAt > 0
      ) {
        return { mode: parsed.mode, rules: parsed.rules, fetchedAt: parsed.fetchedAt };
      }
    } catch {
      // Missing or unreadable is the same as never fetched; a malformed file
      // (torn write, foreign version) is refused whole like a bad snapshot.
    }
    return null;
  };
  let lastSnapshot = loadPersistedSnapshot();
  let snapshotPending = null;
  let persistWarned = false;
  // Fire-and-forget: persistence is what makes the outage posture survive a
  // restart, but it must never cost a tool call or a report. Mode-learned
  // stubs (fetchedAt 0) are not worth a write; they carry no rules. Writes
  // are chained so two never interleave on the same file (a torn write would
  // be refused whole at the next load, but a clean file is strictly better),
  // and the chain doubles as the awaitable the test seam below exposes.
  let persistPending = Promise.resolve();
  const persistSnapshot = () => {
    if (!snapshotPath || !lastSnapshot || lastSnapshot.fetchedAt === 0) return;
    // Captured at queue time: the chained job below must persist THIS
    // snapshot even if a later answer mutates lastSnapshot first.
    const snapshot = { version: SNAPSHOT_VERSION, ...lastSnapshot };
    persistPending = persistPending
      .then(async () => {
        // Written UNCONDITIONALLY, one tiny file per snapshot refresh: the
        // path is shared (the gateway plus every CLI invocation), so any
        // skip heuristic (a process-local latch, a read-and-compare against
        // the file) leaves some external rewrite unhealed; a content compare
        // in particular would never re-assert mode 600 on a matching file an
        // external writer left world-readable. Always writing heals content
        // AND permissions, retries a failed persist at the next refresh for
        // free, and keeps loadPersistedSnapshot the only reader.
        //
        // The shared crash-safe write (src/atomicFile.js): a SIGTERM
        // mid-write (a restart is the exact event this file exists for) must
        // not tear the file into a silent audit-posture start, the mkdtemp
        // stage keeps concurrent writers off each other's temp, mode 600 is
        // the same trust boundary as the credentials file, and the directory
        // is created on demand so an owner-configured policySnapshotPath
        // works without a manual mkdir.
        await writeFileAtomically(snapshotPath, `${JSON.stringify(snapshot)}\n`);
        persistWarned = false;
      })
      .catch((err) => {
        if (persistWarned) return;
        persistWarned = true;
        logger?.warn?.(
          `ai-passport: could not persist the policy snapshot (${err?.code ?? err?.name ?? "error"}); the enforce outage posture will not survive a restart`
        );
      });
  };
  const refreshSnapshot = () => {
    if (snapshotPending) return snapshotPending;
    snapshotPending = (async () => {
      const payload = await transport.request({
        path: "/agent/policy/snapshot",
        method: "GET",
        timeoutMs: config.policy.timeoutMs,
      });
      // A version this plugin does not understand, or a body that does not
      // even carry one (a middlebox 200, an error-shaped reply), is refused
      // whole: acting on half-understood rules is worse than the documented
      // unknown posture, and latching a versionless body as authoritative
      // once silently dropped an enforce install to the audit posture.
      if (payload && typeof payload.version === "number" && payload.version <= SNAPSHOT_VERSION) {
        lastSnapshot = {
          mode: payload.mode === "enforce" ? "enforce" : "audit",
          rules: Array.isArray(payload.rules) ? payload.rules : [],
          fetchedAt: now(),
        };
        persistSnapshot();
      }
      return lastSnapshot;
    })().finally(() => {
      snapshotPending = null;
    });
    return snapshotPending;
  };

  const cacheGet = (key) => {
    const entry = answers.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      answers.delete(key);
      return null;
    }
    return entry.value;
  };

  const cacheSet = (key, value, ttlSeconds) => {
    const ttl = typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Math.min(MAX_CACHE_TTL_S, ttlSeconds)
      : DEFAULT_CACHE_TTL_S;
    answers.delete(key);
    answers.set(key, { value, expiresAt: now() + ttl * 1000 });
    while (answers.size > MAX_CACHED_ANSWERS) {
      const oldest = answers.keys().next();
      if (oldest.done) break;
      answers.delete(oldest.value);
    }
  };

  const normalizeAnswer = (payload) => ({
    decision: typeof payload.decision === "string" ? payload.decision : "allow",
    effective: typeof payload.effective === "string" ? payload.effective : "allow",
    // Explicit or nothing: a body that does not NAME its mode teaches
    // nothing. Coercing an absent mode to "audit" once meant a single
    // error-shaped or field-renamed JSON 200 could durably downgrade an
    // enforce install (learnMode persists flips); the Hermes twin refuses
    // the same input.
    mode: payload.mode === "enforce" || payload.mode === "audit" ? payload.mode : null,
    matchedPattern: typeof payload.matched_pattern === "string" ? payload.matched_pattern : null,
    eventId: typeof payload.event_id === "string" ? payload.event_id : null,
    pollUrl: typeof payload.poll_url === "string" ? payload.poll_url : null,
    approvalUrl: typeof payload.approval_url === "string" ? payload.approval_url : null,
    degraded: payload.degraded === true,
    degradedReason: typeof payload.degraded_reason === "string" ? payload.degraded_reason : null,
  });

  // The rules-unreachable degraded flavor: the plane had NO OPINION (nothing
  // was readable), as opposed to a real verdict whose event RECORDING failed.
  // Named on the wire by degraded_reason (phase 6). Only the KNOWN verdict
  // reason is trusted as a verdict; everything else, including reason strings
  // this plugin has never heard of, falls back to the mode heuristic (the
  // no-opinion body hardcodes mode audit). Plugins live on owner machines for
  // years while the backend deploys continuously, so a future no-opinion
  // flavor must not be mistaken for a verdict that teaches and persists its
  // hardcoded audit mode.
  const isNoOpinion = (answer) => {
    if (!answer.degraded) return false;
    if (answer.degradedReason === "rules_unavailable") return true;
    if (answer.degradedReason === "event_write_failed") return false;
    return answer.mode !== "enforce";
  };

  // Every check answer names the live mode, so a mode flip reaches the next
  // tool call without waiting for the snapshot poll. When no snapshot exists
  // yet, the learned mode arrives with an empty rule set and a stale stamp,
  // which forces a real snapshot fetch before any local evaluation.
  const learnMode = (mode) => {
    if (lastSnapshot) {
      if (lastSnapshot.mode !== mode) {
        lastSnapshot.mode = mode;
        // A real snapshot whose mode just flipped is worth re-persisting, or
        // a restart would resurrect the old mode until the plane answers.
        persistSnapshot();
      }
    } else lastSnapshot = { mode, rules: [], fetchedAt: 0 };
  };

  const reporter = {
    /**
     * Report one tool call. Resolves to the (normalized) check answer, or
     * null when nothing was knowable (disabled, invalid name, backoff,
     * budget, outage). Phase 4 callers ignore the value; it exists so the
     * phase 5 enforce path is a caller change, not a client change.
     */
    async report({ toolName, params = undefined, sessionKey = null, coalesce = true }) {
      if (!config.policy.enabled) return null;
      if (typeof toolName !== "string" || !TOOL_SHAPE.test(toolName)) {
        // Not an error: the host owns its tool names and this plane's grammar
        // is deliberately narrower. Skipping here keeps one exotic name from
        // latching the invalid_request backoff against every other tool.
        return null;
      }
      const digest = argsDigest(params);
      // \u0000 as the separator: it cannot appear in a TOOL_SHAPE name or a
      // hex digest, so the key cannot collide. Escaped, never a raw byte: a
      // literal NUL in the source made file(1) and grep classify this module
      // as binary data and silently no-match it.
      const key = `${toolName}\u0000${digest ?? ""}`;
      const cached = cacheGet(key);
      if (cached) return cached;
      // In-flight coalescing is for the audit path only. Enforce-mode calls
      // pass coalesce=false: N concurrent identical calls sharing one check
      // would share ONE approval event, and the owner's allow-once would run
      // the tool N times. Each enforce call gets its own event and its own
      // wait; the backend's single-use grant is what keeps that honest.
      if (coalesce) {
        const pending = pendingByKey.get(key);
        if (pending) return pending;
      }
      const attempt = (async () => {
        const boundedSessionKey = clampSessionKey(sessionKey);
        const payload = await transport.request({
          path: "/agent/policy/check",
          method: "POST",
          body: {
            tool: toolName,
            ...(digest ? { args_digest: digest } : {}),
            ...(boundedSessionKey ? { session_key: boundedSessionKey } : {}),
          },
          timeoutMs: config.policy.timeoutMs,
        });
        if (!payload) return null;
        const answer = normalizeAnswer(payload);
        // Every answer that NAMES its mode teaches it, including a
        // recording-degraded verdict: while the event table is down those
        // answers are the only flip detector, in BOTH directions (an owner's
        // enforce flip must start blocking, and their audit flip must stop
        // enforcing stale rules). Only the no-opinion flavor is mute: its
        // mode is hardcoded audit and must never overwrite the learned one.
        if (answer.mode !== null && !isNoOpinion(answer)) learnMode(answer.mode);
        // require_approval answers are never cached (each is ONE wait on ONE
        // event), and neither is anything the server marks single-use with
        // cache_ttl <= 0 (a grant-consumed allow, or the degraded approval
        // fall-open whose allow admits exactly the one call whose wait could
        // not be recorded): an owner's allow_once must mean once, not sixty
        // seconds of identical calls riding it. The mode-gated decision
        // clause is the belt for a backend that predates the fall-open's
        // cache_ttl 0; the mode gate matters because an AUDIT answer for an
        // approval-ruled tool during the same outage enforced nothing and
        // must keep its ttl. Degraded answers otherwise ARE cached (the
        // backend sends them a ttl on purpose): the cache is what keeps
        // per-call checks from hammering an already-degraded plane, and a
        // replayed no-opinion body still gets its local-rules evaluation in
        // decide() on every call.
        const singleUse =
          (typeof payload.cache_ttl === "number" && payload.cache_ttl <= 0) ||
          (answer.degraded && answer.mode === "enforce" && answer.decision === "require_approval");
        if (answer.effective !== "require_approval" && !singleUse) {
          cacheSet(key, answer, payload.cache_ttl);
        }
        return answer;
      })();
      if (!coalesce) return attempt;
      pendingByKey.set(key, attempt);
      try {
        return await attempt;
      } finally {
        pendingByKey.delete(key);
      }
    },

    /**
     * The verdict for one tool call (issue #425 phase 5). Never throws.
     *
     * Audit mode (or an unknown mode: fresh process, plane never reached)
     * keeps the phase-4 posture: the report is fired without being awaited
     * and the answer is `allow` immediately. Enforce mode awaits the plane,
     * blocks on deny, waits out a pending approval by polling the decisions
     * leg, and falls back to evaluating the LAST KNOWN rules locally when the
     * plane does not answer: fail closed exactly for the tools the owner's
     * rules constrain, fail open for everything else (a Passport outage must
     * not wedge tools the owner never restricted).
     */
    async decide({ toolName, params = undefined, sessionKey = null }) {
      const allow = { effective: "allow", reason: null };
      try {
        if (!config.policy.enabled) return allow;
        if (typeof toolName !== "string" || !TOOL_SHAPE.test(toolName)) return allow;

        // Mode discovery never blocks a tool call. The snapshot warms up in
        // the background (registration kicks it; a fresh process's first
        // calls run in audit posture until it lands), every check answer
        // teaches the live mode for free, and only ENFORCE mode has any use
        // for the periodic rules refresh; audit installs make zero snapshot
        // requests. The phase-4 test suite pins this: audit decide() awaits
        // nothing.
        if (!lastSnapshot) refreshSnapshot().catch(() => {});
        else if (lastSnapshot.mode === "enforce" && now() - lastSnapshot.fetchedAt > SNAPSHOT_TTL_MS) {
          refreshSnapshot().catch(() => {});
        }
        const mode = lastSnapshot?.mode ?? "audit";

        if (mode !== "enforce") {
          // The phase-4 contract: the report costs the tool call nothing.
          this.report({ toolName, params, sessionKey })?.catch?.(() => {});
          return allow;
        }

        const answer = await this.report({ toolName, params, sessionKey, coalesce: false });
        // Two degraded flavors, named by degraded_reason. An
        // event_write_failed body is a real verdict whose RECORDING failed:
        // it falls through to the ordinary handling below, so a wire deny
        // stays a deny even when the local snapshot is stale, and a
        // grant-consumed allow (the owner's explicit yes, cache_ttl 0) runs
        // the tool instead of paging the owner for a second approval of the
        // call they just approved. Only the NO-OPINION flavor
        // (rules_unavailable: nothing was readable) defers to the last-known
        // rules, which is what keeps the public promise that an outage
        // blocks exactly the tools the owner's rules constrain.
        const noOpinion = answer !== null && isNoOpinion(answer);
        if (!answer || noOpinion) {
          // The plane did not answer, or shrugged; the last-known rules
          // decide. A mode
          // learned from a check answer arrives with NO rules (fetchedAt 0),
          // and evaluating an empty list would fail open for the very tools
          // the owner constrained, so an unknown rule set gets one awaited
          // fetch attempt first; if that also fails, fail open and say so
          // rather than silently wedging every tool.
          if (!lastSnapshot || lastSnapshot.fetchedAt === 0) await refreshSnapshot().catch(() => {});
          if (!lastSnapshot || lastSnapshot.fetchedAt === 0) {
            logger?.warn?.(
              "ai-passport: enforce mode with no reachable rule snapshot; failing open until the plane answers"
            );
            return allow;
          }
          const local = resolveLocalPolicy(toolName, lastSnapshot.rules);
          if (local.action === "deny") {
            // Honest copy: a no-opinion 200 means the Passport ANSWERED and
            // only its policy store is down; calling it "unreachable" would
            // send the owner debugging connectivity while the service is up.
            const why = noOpinion
              ? "their Passport's policy service is temporarily degraded"
              : "their Passport is currently unreachable";
            return {
              effective: "deny",
              reason: `Blocked by the owner's AI Passport tool policy (rule ${local.matchedPattern}); ${why}.`,
            };
          }
          if (local.action === "require_approval") {
            const why = noOpinion
              ? "their AI Passport's policy service is temporarily degraded"
              : "their AI Passport is unreachable";
            return {
              effective: "deny",
              reason: `This tool needs the owner's approval (rule ${local.matchedPattern}) and ${why}, so no approval can be requested right now. Retry later.`,
            };
          }
          return allow;
        }
        if (answer.effective === "deny") {
          return {
            effective: "deny",
            reason: `Blocked by the owner's AI Passport tool policy${answer.matchedPattern ? ` (rule ${answer.matchedPattern})` : ""}.`,
          };
        }
        if (answer.effective === "require_approval") return await this._awaitApproval(answer);
        return allow;
      } catch (err) {
        // decide() sits in front of every tool call; a plugin bug here must
        // cost a report, never the tool.
        logger?.warn?.(`ai-passport: policy decision failed open (${err?.name ?? "error"})`);
        return allow;
      }
    },

    // Wait for the owner to answer a pending approval, by polling the
    // decisions leg the check answer named. A transient poll failure keeps
    // waiting (the wait's own deadline bounds the loop); running out of
    // patience blocks with the approval link so the owner can still answer
    // and the agent can retry.
    async _awaitApproval(answer) {
      const approvalHint = answer.approvalUrl ? ` The owner can approve it at ${answer.approvalUrl}.` : "";
      if (!answer.eventId || !answer.pollUrl) {
        // The server fell open recording the wait (degraded), so there is
        // nothing to poll and nothing the owner could resolve.
        return answer.degraded
          ? { effective: "allow", reason: null }
          : { effective: "deny", reason: `This tool needs the owner's approval.${approvalHint}` };
      }
      const deadline = now() + config.policy.approvalWaitMs;
      while (now() < deadline) {
        await sleep(Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        const payload = await transport.request({
          path: answer.pollUrl,
          method: "GET",
          timeoutMs: config.policy.timeoutMs,
        });
        if (!payload || !payload.resolution) continue;
        // The server's `effective` is the verdict, not the resolution alone:
        // an allow_once whose grant was already consumed elsewhere answers
        // effective=deny, because the one permitted execution happened.
        if (payload.effective === "allow") return { effective: "allow", reason: null };
        if (payload.resolution === "expired") {
          return {
            effective: "deny",
            reason: `The owner's approval window for this tool expired before they answered.${approvalHint} Retry to ask again.`,
          };
        }
        if (payload.resolution === "denied") {
          return { effective: "deny", reason: "The owner denied this tool call in their AI Passport." };
        }
        return {
          effective: "deny",
          reason: "That approval was already used by another call. Retry to ask the owner again.",
        };
      }
      return {
        effective: "deny",
        reason: `Still waiting for the owner's approval to use this tool.${approvalHint} Retry after they approve.`,
      };
    },

    /**
     * Fire-and-forget snapshot warmup, called at plugin registration so an
     * enforce-mode owner's rules are in memory before the model produces its
     * first tool call, without any tool call ever awaiting the fetch.
     */
    warmup() {
      if (!config.policy.enabled) return;
      refreshSnapshot().catch(() => {});
    },

    /**
     * One GET /agent/policy/snapshot, for the status CLI (and, in phase 5,
     * the local evaluation fallback). Returns {mode, ruleCount, version} or
     * null; never throws.
     */
    async snapshot() {
      const payload = await transport.request({
        path: "/agent/policy/snapshot",
        method: "GET",
        timeoutMs: config.policy.timeoutMs,
      });
      if (!payload) return null;
      return {
        mode: payload.mode === "enforce" ? "enforce" : "audit",
        ruleCount: Array.isArray(payload.rules) ? payload.rules.length : 0,
        version: typeof payload.version === "number" ? payload.version : null,
      };
    },

    __state() {
      return {
        ...transport.state(),
        cacheSize: answers.size,
        snapshotMode: lastSnapshot?.mode ?? null,
        snapshotRules: lastSnapshot?.rules?.length ?? null,
      };
    },

    // Test seam: resolves once every persist queued so far has hit the disk
    // (or failed). Production code never awaits a persist by design.
    __persistSettled() {
      return persistPending;
    },
  };
  return reporter;
}
