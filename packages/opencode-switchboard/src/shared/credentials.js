import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomically } from "./atomicFile.js";

// Connect-code credentials and OAuth refresh, owned by the agent client.
//
// The install guide writes {token_url, client_id, refresh_token} to an
// owner-only file and teaches the agent to refresh the MCP server's static
// bearer header from it. Refresh tokens are
// rotating and replay detection revokes the affected token family, so only
// one process should own refresh for an install. The in-process lock below
// keeps concurrent plugin calls safe. The server's five-minute recovery copy
// covers an accidental same-transport cross-process replay.
// The host adapter may also hand each new access token to its MCP entry
// writer, which keeps the agent from needing to refresh at all.

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export class PassportAuthError extends Error {
  constructor(message, { terminal = false, code = "auth_failed" } = {}) {
    super(message);
    this.name = "PassportAuthError";
    this.terminal = terminal;
    this.code = code;
  }
}

const DEFAULT_HOST_METADATA = {
  credentialRecoveryInstruction: "Ask the owner for a new connect code and reinstall.",
  credentialInstallInstruction: "Redeem a connect code first.",
};

function parseCredentialsFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PassportAuthError("AI Passport credentials file is not valid JSON.", { code: "invalid_file" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PassportAuthError("AI Passport credentials file is not a JSON object.", { code: "invalid_file" });
  }
  const tokenUrl = typeof parsed.token_url === "string" ? parsed.token_url.trim() : "";
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id.trim() : "";
  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "";
  if (!tokenUrl || !clientId || !refreshToken) {
    throw new PassportAuthError("AI Passport credentials file is missing token_url, client_id, or refresh_token.", {
      code: "invalid_file",
    });
  }
  return {
    raw: parsed,
    tokenUrl,
    clientId,
    refreshToken,
    accessToken: typeof parsed.access_token === "string" && parsed.access_token.trim() ? parsed.access_token.trim() : null,
    accessTokenExpiresAt:
      typeof parsed.access_token_expires_at === "number" && Number.isFinite(parsed.access_token_expires_at)
        ? parsed.access_token_expires_at
        : 0,
  };
}

// The shared crash-safe write (src/atomicFile.js): same-directory temp plus
// rename, mode 600 before the temp holds a token, stage dir removed on every
// path so nothing accumulates across the years of hourly rotations an install
// lives for.
async function writeCredentialsAtomically(filePath, payload) {
  await writeFileAtomically(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function createCredentials({
  credentialsPath,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = null,
  onAccessToken = null,
  hostMetadata = {},
} = {}) {
  if (!credentialsPath) throw new Error("createCredentials requires a credentialsPath.");
  const recoveryCopy = { ...DEFAULT_HOST_METADATA, ...hostMetadata };

  let cached = null;
  let cachedMtimeMs = -1;
  let inFlight = null;
  // True while a rotated token lives only in memory because the file write
  // failed. Retried on every read until the disk catches up.
  let needsPersist = false;

  const load = async () => {
    // While a rotated token lives only in memory, memory outranks disk: the
    // file's token is spent by definition, so re-reading it here would
    // clobber the only live copy and brick the install on the next refresh.
    // retryPersist() is what heals the file, never a re-read.
    if (needsPersist && cached) return cached;
    let fileStat = null;
    try {
      fileStat = await stat(credentialsPath);
    } catch (err) {
      if (err?.code === "ENOENT") {
        throw new PassportAuthError(
          `AI Passport is not installed for this agent. ${recoveryCopy.credentialInstallInstruction}`,
          { terminal: true, code: "not_installed" }
        );
      }
      throw new PassportAuthError("AI Passport credentials file is unreadable.", {
        code: "unreadable",
      });
    }
    if (cached && fileStat.mtimeMs === cachedMtimeMs) return cached;
    let text;
    try {
      text = await readFile(credentialsPath, "utf8");
    } catch {
      throw new PassportAuthError("AI Passport credentials file is unreadable.", { code: "unreadable" });
    }
    const parsed = parseCredentialsFile(text);
    cached = parsed;
    cachedMtimeMs = fileStat.mtimeMs;
    return cached;
  };

  const persist = async (current, token) => {
    const payload = {
      ...current.raw,
      token_url: current.tokenUrl,
      client_id: current.clientId,
      refresh_token: token.refreshToken,
      access_token: token.accessToken,
      access_token_expires_at: token.expiresAt,
    };
    // Commit to memory BEFORE touching disk. The server already rotated, so
    // this process's copy of the new single-use refresh token is the only one
    // anywhere; a failed file write must degrade to "disk is behind, retry
    // later", never to losing the token (which bricks the install).
    cached = {
      raw: payload,
      tokenUrl: current.tokenUrl,
      clientId: current.clientId,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.expiresAt,
    };
    try {
      await writeCredentialsAtomically(credentialsPath, payload);
      needsPersist = false;
    } catch (err) {
      needsPersist = true;
      logger?.warn?.(
        `ai-passport: could not write rotated credentials (${err?.code ?? err?.name ?? "error"}); keeping them in memory and retrying`
      );
    }
    // Re-stat rather than trusting our own write: the next load must not
    // decide the file changed under it and re-read on every single call.
    // After a FAILED write the needsPersist guard in load() is what protects
    // the in-memory rotation; a failed stat here only costs one extra read.
    try {
      cachedMtimeMs = (await stat(credentialsPath)).mtimeMs;
    } catch {
      cachedMtimeMs = -1;
    }
  };

  const retryPersist = async () => {
    if (!needsPersist || !cached) return;
    try {
      await writeCredentialsAtomically(credentialsPath, cached.raw);
      needsPersist = false;
      try {
        cachedMtimeMs = (await stat(credentialsPath)).mtimeMs;
      } catch {
        cachedMtimeMs = -1;
      }
      logger?.debug?.("ai-passport: rotated credentials written after an earlier failure");
    } catch {
      // Still failing; keep serving from memory and try again on the next read.
    }
  };

  const requestToken = async (current) => {
    // No `resource` parameter. Verified against lib/oauth.js
    // exchangeRefreshToken (2026-08-15): the audience a rotation binds is the
    // one already stored on the chain, and connect-code redeem always stores
    // it (lib/agentConnect.js), so sending it cannot change the outcome of our
    // refreshes. It can only fail them: a value that is not byte-equal to the
    // server's canonical issuer + /mcp answers invalid_grant, which this
    // plugin latches as terminal and which sends the owner off to re-pair a
    // healthy install. Deriving it from tokenUrl (the only value we hold)
    // diverges from the canonical one for any deployment whose public URL
    // carries a path or whose issuer and public URL are configured apart.
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: current.clientId,
      refresh_token: current.refreshToken,
    });
    let response;
    try {
      response = await fetchImpl(current.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        // Never follow a redirect while carrying a credential: the body holds
        // the live single-use refresh token, no Passport endpoint answers a
        // 3xx, and following one hands the token to whatever a middlebox
        // points at (303 would even rewrite the POST to a GET).
        redirect: "manual",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PassportAuthError(`AI Passport token endpoint is unreachable: ${err?.name ?? "error"}.`, {
        code: "unreachable",
      });
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status >= 300 && response.status < 400) {
      // A middlebox answering in the token endpoint's place, never the
      // endpoint itself. Transient like any other transport fault.
      throw new PassportAuthError(
        `AI Passport token endpoint answered a ${response.status} redirect; refusing to follow it with a credential.`,
        { code: "unreachable" }
      );
    }
    if (response.status === 400 && payload?.error === "invalid_grant") {
      throw new PassportAuthError(
        `AI Passport refresh token is spent or revoked. ${recoveryCopy.credentialRecoveryInstruction}`,
        { terminal: true, code: "invalid_grant" }
      );
    }
    if (payload?.error === "invalid_client") {
      // The registration this install was paired under no longer exists: the
      // owner severed it, or the deployment's client store was reset. Verified
      // against the backend (2026-08-14): its store THROWS on a failed read,
      // which the OAuth layer answers as a 500, so invalid_client is never a
      // transient blip and retrying it hourly only hides a dead install behind
      // "answered 400". The terminal latch still re-probes on its recheck
      // window, so a wrong verdict costs minutes of stale context, not the
      // install. The same rule applies to every host adapter.
      throw new PassportAuthError(
        `AI Passport refresh token is spent or revoked. ${recoveryCopy.credentialRecoveryInstruction}`,
        { terminal: true, code: "invalid_client" }
      );
    }
    if (!response.ok) {
      throw new PassportAuthError(`AI Passport token endpoint answered ${response.status}.`, { code: "token_error" });
    }
    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
    if (!accessToken) {
      throw new PassportAuthError("AI Passport token response carried no access_token.", { code: "token_error" });
    }
    const expiresIn = typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
    return {
      accessToken,
      // A rotation is expected on every use; a server that echoes no new
      // refresh token keeps the old one working rather than losing the install.
      refreshToken: typeof payload?.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : current.refreshToken,
      expiresAt: now() + Math.max(0, expiresIn) * 1000,
    };
  };

  // One rotation at a time per process. The server also recovers a matching
  // cross-process replay during its five-minute delivery window.
  const refresh = async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const current = await load();
      const token = await requestToken(current);
      await persist(current, token);
      if (onAccessToken) await onAccessToken(token.accessToken);
      return token.accessToken;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    // The Passport origin the install was paired against. Deriving it from
    // token_url means one guide serves prod and a local stack.
    async baseUrl() {
      const current = await load();
      return new URL(current.tokenUrl).origin;
    },
    async accessToken({ force = false } = {}) {
      if (needsPersist) await retryPersist();
      if (!force) {
        const current = await load();
        if (current.accessToken && current.accessTokenExpiresAt - REFRESH_MARGIN_MS > now()) {
          // Reconcile on every read, not only on rotation. Whoever holds the
          // paired MCP entry has to end up with the token that is actually
          // valid, and rotation is not the only way the two drift: another
          // process can rotate (a CLI run, a script, a second gateway), a
          // crash can land between the file write and the config write, or a
          // human can edit either side. Edge-triggered syncing leaves those
          // cases broken until the next rotation, which is up to an hour of
          // 401s on every MCP tool call. The sync is a no-op when the header
          // already matches, so this costs an in-memory config read.
          if (onAccessToken) await onAccessToken(current.accessToken);
          return current.accessToken;
        }
      }
      const token = await refresh();
      logger?.debug?.("ai-passport: refreshed access token");
      return token;
    },
    // Test seam: drop the in-process view so a rewritten file is re-read.
    __reset() {
      cached = null;
      cachedMtimeMs = -1;
      needsPersist = false;
    },
  };
}

// Exported for tests that need a scratch credentials file.
export async function makeTempCredentialsDir(prefix = "ai-passport-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
