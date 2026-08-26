import { PassportAuthError } from "./credentials.js";

// The host-neutral authenticated-request engine both plane surfaces share (the
// /agent/prefetch client in src/client.js and the tool-policy reporter in
// src/policy.js). Everything transport-shaped lives here ONCE: bearer
// headers, redirect refusal, per-class backoff, the forbidden
// probe-then-latch, the client-side request budget, the single 401
// refresh-retry, and terminal credential verdicts with their recheck window.
// The first version of the reporter re-implemented all of it, which meant the
// next transport fix had to land twice or the surfaces silently diverged.
//
// Each surface keeps its OWN transport instance on purpose. The backend
// throttles per route (prefetch 60/min, policy check 600/min, ...), so budget
// state must not be pooled: a chatty policy reporter must never spend the
// prefetch budget, and a prefetch 429 must not black out the audit trail.
// The cost is that a plane-closed 403 is probed once per surface per window,
// which is two requests where one would do; that is cheaper than the shared
// state machine that could tell those cases apart.

const BACKOFF_MS = {
  // 429 is the backend telling us our own cadence is wrong; pause for at
  // least one cache window so the next call is served from cache anyway.
  rate_limited: 60_000,
  // 403/404 mean the plane is closed to this install: the agent backend is
  // disabled on that deployment (it ships behind a flag and Express answers
  // its default 404 while it is dark), or this client is not an agent-connect
  // registration. Nothing the plugin does will change that soon, so a REPEAT
  // latches this long window. A single 403 can also be one transient store
  // blip during the backend's token verification (it deliberately leaves a
  // failed client lookup uncached so a blip costs one read, not a lockout),
  // so the first one only pauses for `forbidden_probe` and the next read
  // re-probes instead of amplifying the blip into a five-minute blackout.
  forbidden: 5 * 60 * 1000,
  forbidden_probe: 60_000,
  // 400 means we sent a shape the backend refuses: a version skew, not a
  // transient fault. Back off hard and say so once.
  invalid_request: 5 * 60 * 1000,
  unavailable: 30_000,
  auth: 60_000,
};

// A terminal verdict (not installed, refresh token dead) stops network
// traffic, but the documented recovery is the owner rewriting the credentials
// file, and a long-running gateway must pick that up without a restart. Probe
// again after this window; an unchanged file re-latches at the cost of at
// most one stat (not_installed) or one token POST (invalid_grant) per window.
const TERMINAL_RECHECK_MS = 5 * 60 * 1000;

export function createPlaneTransport({
  config,
  credentials,
  fetchImpl = globalThis.fetch,
  logger = null,
  now = () => Date.now(),
  // Names this surface in the once-per-window warnings, so an operator
  // grepping a log can tell a prefetch outage from a policy one.
  label,
  // Client-side share of this surface's per-route backend budget.
  budgetMax,
  budgetWindowMs = 60_000,
}) {
  let backoffUntil = 0;
  let backoffReason = null;
  // Consecutive plane-closed answers, so one transient 403 (a store blip on
  // the backend's verification path) is probed past quickly while a genuinely
  // closed plane still converges to the long backoff on its second answer.
  let forbiddenStreak = 0;
  let terminalReason = null;
  let terminalRecheckAt = 0;
  const requestLog = [];
  const pendingReservations = new Set();

  const pruneRequestLog = () => {
    const cutoff = now() - budgetWindowMs;
    while (requestLog.length && requestLog[0] <= cutoff) requestLog.shift();
  };

  // Reserve before credential loading yields. Pending reservations do not
  // expire, because a slow credential provider must not let later callers
  // take the same slots and then release a burst larger than the route budget.
  const reserveRequest = () => {
    pruneRequestLog();
    if (requestLog.length + pendingReservations.size >= budgetMax) return null;
    const reservation = {};
    pendingReservations.add(reservation);
    return reservation;
  };

  const startRequest = (reservation) => {
    pendingReservations.delete(reservation);
    requestLog.push(now());
  };

  const releaseRequest = (reservation) => {
    pendingReservations.delete(reservation);
  };

  const backOff = (reason, detail, ms = BACKOFF_MS[reason] ?? BACKOFF_MS.unavailable) => {
    const alreadyBackedOff = backoffUntil > now() && backoffReason === reason;
    backoffUntil = now() + ms;
    backoffReason = reason;
    if (!alreadyBackedOff) logger?.warn?.(`ai-passport: ${label} ${reason}${detail ? ` (${detail})` : ""}`);
  };

  const latchTerminal = (err) => {
    terminalReason = err.code;
    terminalRecheckAt = now() + TERMINAL_RECHECK_MS;
    // Log the closed reason code, not an error message that may have been
    // created by a filesystem implementation or another credential provider.
    logger?.warn?.(`ai-passport: credentials ${err.code}`);
  };

  const requestOnce = async ({ baseUrl, path, method, accessToken, body, timeoutMs }) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Never follow a redirect while carrying a bearer: no Passport endpoint
      // answers one, so a 3xx is a middlebox (captive portal, proxy)
      // answering in the backend's place, and following it hands the
      // credential to whatever host it points at. The 3xx status falls
      // through to the generic branch below and degrades like any outage.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    let malformed = false;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      malformed = true;
    }
    return { status: response.status, payload, malformed };
  };

  return {
    /**
     * One authenticated request. Resolves to the 200's JSON object, or null
     * when nothing was knowable (terminal, backoff, budget, outage, refusal);
     * the failure class has already been recorded and warned about here, so
     * callers only decide what "no answer" means for their surface. Never
     * throws.
     */
    async request({ path, method = "POST", body = null, timeoutMs }) {
      if (terminalReason) {
        if (now() < terminalRecheckAt) return null;
        // Clear the verdict and fall through: the credentials layer re-reads
        // the file on mtime change, so a reinstall is picked up here.
        terminalReason = null;
      }
      if (backoffUntil > now()) return null;
      const initialReservation = reserveRequest();
      if (!initialReservation) return null;

      let baseUrl;
      let accessToken;
      try {
        baseUrl = config.baseUrl ?? (await credentials.baseUrl());
        accessToken = await credentials.accessToken();
      } catch (err) {
        releaseRequest(initialReservation);
        if (err instanceof PassportAuthError && err.terminal) {
          // Not installed, or the refresh token is genuinely dead. Say it
          // once and stop touching the network until the recheck window
          // probes for the owner's reinstall.
          latchTerminal(err);
          return null;
        }
        backOff("auth", err?.code ?? "error");
        return null;
      }

      let result;
      let retried = false;
      let retryReservation = null;
      let retryStarted = false;
      try {
        startRequest(initialReservation);
        result = await requestOnce({ baseUrl, path, method, accessToken, body, timeoutMs });
        if (result.status === 401) {
          // The stored access token outlived its hour, or the server rotated
          // out from under us. One forced refresh, one retry, then give up
          // for this window; the refresh path itself owns the terminal cases.
          retryReservation = reserveRequest();
          if (!retryReservation) return null;
          retried = true;
          const refreshed = await credentials.accessToken({ force: true });
          startRequest(retryReservation);
          retryStarted = true;
          result = await requestOnce({ baseUrl, path, method, accessToken: refreshed, body, timeoutMs });
        }
      } catch (err) {
        if (retryReservation && !retryStarted) releaseRequest(retryReservation);
        if (err instanceof PassportAuthError && err.terminal) {
          latchTerminal(err);
          return null;
        }
        // AbortSignal.timeout rejects with TimeoutError; treat every
        // transport failure the same way, because the caller's answer is the
        // same.
        backOff("unavailable", err?.name ?? "error");
        return null;
      }

      if (result.status === 200) {
        if (result.malformed || !result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) {
          // A 200 whose body is not the plane's JSON object is a middlebox
          // answering in the backend's place (captive portal, proxy error
          // page), not an answer. Treating it as one would have the surface
          // cache a lie; degrade like any other transport fault instead.
          backOff("unavailable", "malformed_200");
          return null;
        }
        backoffUntil = 0;
        backoffReason = null;
        forbiddenStreak = 0;
        return result.payload;
      }
      if (result.status === 429) {
        backOff("rate_limited");
        return null;
      }
      if (result.status === 403 || result.status === 404) {
        // 403 is the scope guard refusing this install; 404 is a deployment
        // that never mounted the plane. Both mean the same thing to the
        // owner, and neither is an outage.
        forbiddenStreak += 1;
        backOff(
          "forbidden",
          `${result.status}: ask the owner to enable the AI Passport agent backend`,
          forbiddenStreak > 1 ? BACKOFF_MS.forbidden : BACKOFF_MS.forbidden_probe
        );
        return null;
      }
      if (result.status === 401) {
        backOff("auth", retried ? "401 after refresh" : "401");
        return null;
      }
      if (result.status === 400) {
        backOff("invalid_request", String(result.payload?.error ?? "bad_request"));
        return null;
      }
      backOff("unavailable", String(result.status));
      return null;
    },

    state() {
      return { backoffUntil, backoffReason, terminalReason };
    },
  };
}
