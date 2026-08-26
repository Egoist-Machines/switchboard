import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { SYNC_CAPABILITIES, SYNC_CAPABILITIES_HEADER } from "./constants.js";
import { ensurePrivateDirectory } from "./storage.js";

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CREDENTIAL_RE = /^apsd_[A-Za-z0-9_-]{43}$/;
const POLL_SECRET_RE = /^sblp_[A-Za-z0-9_-]{43}$/;
const TICKET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATCH_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const LINK_CEREMONY_VERSION = 1;
const OWNER_SCOPE_KEY_RE = /^[a-f0-9]{64}$/;

export class HostedLinkError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostedLinkError";
    this.code = code;
  }
}

function loopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function normalizeBaseUrl(value) {
  // A bare host means https; explicit http stays possible for loopback.
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value)) ? String(value) : `https://${value}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HostedLinkError("invalid_base_url");
  }
  if (url.username || url.password || url.search || url.hash) throw new HostedLinkError("invalid_base_url");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new HostedLinkError("invalid_base_url");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function linkPath(home) {
  return path.join(home, "link.json");
}

export function pendingLinkPath(home) {
  return path.join(home, "pending-link.json");
}

export function readHostedLink(home) {
  const target = linkPath(home);
  if (!existsSync(target)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new HostedLinkError("invalid_link_record");
  }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    normalizeBaseUrl(record.base_url) !== record.base_url ||
    !DEVICE_ID_RE.test(String(record.device_id || "")) ||
    !CREDENTIAL_RE.test(String(record.credential || "")) ||
    !["pending", "approved"].includes(record.status)) {
    throw new HostedLinkError("invalid_link_record");
  }
  return record;
}

export function writeHostedLink(home, record) {
  ensurePrivateDirectory(home);
  const target = linkPath(home);
  const temporary = path.join(home, `.link-${process.pid}.json`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return record;
}

export function readPendingHostedLink(home) {
  const target = pendingLinkPath(home);
  if (!existsSync(target)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new HostedLinkError("invalid_pending_link_record");
  }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    record.ceremony_version !== LINK_CEREMONY_VERSION ||
    normalizeBaseUrl(record.base_url) !== record.base_url ||
    !DEVICE_ID_RE.test(String(record.device_id || "")) ||
    !CREDENTIAL_RE.test(String(record.credential || "")) ||
    !TICKET_ID_RE.test(String(record.ticket_id || "")) ||
    !POLL_SECRET_RE.test(String(record.poll_secret || "")) ||
    !Number.isFinite(Date.parse(record.expires_at))) {
    throw new HostedLinkError("invalid_pending_link_record");
  }
  return record;
}

export function writePendingHostedLink(home, record) {
  ensurePrivateDirectory(home);
  const target = pendingLinkPath(home);
  const temporary = path.join(home, `.pending-link-${process.pid}.json`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return record;
}

export function forgetPendingHostedLink(home) {
  const target = pendingLinkPath(home);
  if (!existsSync(target)) return false;
  unlinkSync(target);
  return true;
}

export function promotePendingHostedLink(home, pending) {
  const linked = writeHostedLink(home, {
    base_url: pending.base_url,
    device_id: pending.device_id,
    credential: pending.credential,
    status: "approved",
  });
  // link.json is already durable and atomically renamed before the resumable
  // ceremony secret is removed. A crash between these operations is harmless:
  // the next run trusts link.json and removes the stale pending record.
  forgetPendingHostedLink(home);
  return linked;
}

export function forgetHostedLink(home) {
  const target = linkPath(home);
  const removedPending = forgetPendingHostedLink(home);
  if (!existsSync(target)) return removedPending;
  unlinkSync(target);
  return true;
}

export function deviceIdForReplica(replicaId) {
  if (DEVICE_ID_RE.test(String(replicaId || ""))) return replicaId;
  return `sb_${createHash("sha256").update(String(replicaId)).digest("base64url").slice(0, 43)}`;
}

export function labelForReplica(replicaId, hostname = os.hostname()) {
  const suffix = createHash("sha256").update(String(replicaId)).digest("hex").slice(0, 6);
  const clean = String(hostname).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || "Switchboard";
  return `${clean.slice(0, 72)} ${suffix}`.slice(0, 80);
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, redirect: "error" });
  } catch {
    throw new HostedLinkError("network_failure");
  }
}

export async function adoptHostedOwnerScopeKey({ repository, record, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await request(fetchImpl, `${record.base_url}/sync/v1/scope-key`, {
      headers: { authorization: `Bearer ${record.credential}` },
    });
  } catch {
    return false;
  }
  const body = await responseJson(response);
  if ([401, 403].includes(response.status)) throw new HostedLinkError("link_refused");
  if (response.status !== 200 || !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !OWNER_SCOPE_KEY_RE.test(String(body.owner_scope_key || ""))) {
    // Scope-key adoption is an additive rollout leg. Any failure other than
    // authentication leaves adoption pending and must not block linking or the
    // ordinary sync cycle; a later cycle retries while no owner key is active.
    return false;
  }
  repository.adoptOwnerScopeKey(body.owner_scope_key);
  return true;
}

export function hostedCredentialHash(credential) {
  if (!CREDENTIAL_RE.test(String(credential || ""))) throw new HostedLinkError("invalid_device_credential");
  return `h1_${createHash("sha256").update(`ai-passport/oauth/sync-device/v1:${credential}`).digest("hex")}`;
}

export function openHostedLinkUrl(url, {
  platform = process.platform, spawnImpl = spawn,
  disabled = process.env.SWITCHBOARD_NO_BROWSER_OPEN === "1",
} = {}) {
  if (disabled || platform !== "darwin") return false;
  try {
    const child = spawnImpl("open", [url], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function waitForHostedApproval({
  record,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 2_000,
  maxPolls = Infinity,
} = {}) {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const response = await request(fetchImpl, `${record.base_url}/sync/v1/changes?cursor=0`, {
      headers: {
        authorization: `Bearer ${record.credential}`,
        [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
      },
    });
    if (response.status === 200) return true;
    const body = await responseJson(response);
    if (response.status !== 403 || body.error !== "sync_device_not_approved") {
      if (response.status >= 500) throw new HostedLinkError("hosted_unavailable");
      throw new HostedLinkError("link_refused");
    }
    if (poll + 1 < maxPolls) await sleep(pollIntervalMs);
  }
  return false;
}

async function probePendingHostedCredential({ record, fetchImpl }) {
  // HEAD exercises the existing approved-device guard without returning any
  // memory content. A previous probe may have offered a cursor before the
  // process could promote the link, so cursor_not_current still proves that
  // the credential passed authentication.
  const response = await request(fetchImpl, `${record.base_url}/sync/v1/changes?cursor=0`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${record.credential}`,
      [SYNC_CAPABILITIES_HEADER]: SYNC_CAPABILITIES.join(","),
    },
  });
  if ([200, 409, 423].includes(response.status)) return true;
  if ([401, 403].includes(response.status)) return false;
  throw new HostedLinkError("hosted_unavailable");
}

export async function linkHosted({
  repository,
  baseUrl,
  fetchImpl = globalThis.fetch,
  onInstruction = () => {},
  openUrl = openHostedLinkUrl,
  randomCredential = () => `apsd_${randomBytes(32).toString("base64url")}`,
  sleep,
  pollIntervalMs,
  maxPolls,
  promoteLink = promotePendingHostedLink,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const metadata = repository.metadata();
  const deviceId = deviceIdForReplica(metadata.replica_id);
  let record = readHostedLink(repository.home);
  if (record && (record.base_url !== normalizedBaseUrl || record.device_id !== deviceId)) {
    throw new HostedLinkError("already_linked");
  }
  if (record?.status === "approved") {
    forgetPendingHostedLink(repository.home);
    await adoptHostedOwnerScopeKey({ repository, record, fetchImpl });
    return record;
  }
  if (!record) {
    let pending = readPendingHostedLink(repository.home);
    const resumingPending = Boolean(pending);
    if (pending && (pending.base_url !== normalizedBaseUrl || pending.device_id !== deviceId)) {
      throw new HostedLinkError("already_linked");
    }
    if (!pending) {
      const credential = randomCredential();
      if (!CREDENTIAL_RE.test(credential)) throw new HostedLinkError("invalid_device_credential");
      const response = await request(fetchImpl, `${normalizedBaseUrl}/sync/v1/link/tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_id: deviceId,
          local_owner_id: metadata.owner_id,
          label: labelForReplica(metadata.replica_id),
          credential_hash: hostedCredentialHash(credential),
          capabilities: SYNC_CAPABILITIES,
        }),
      });
      const body = await responseJson(response);
      let linkUrl;
      try { linkUrl = new URL(String(body.link_url || "")); } catch { linkUrl = null; }
      if (
        response.status !== 201 || !TICKET_ID_RE.test(String(body.ticket_id || ""))
        || !POLL_SECRET_RE.test(String(body.poll_secret || ""))
        || !MATCH_CODE_RE.test(String(body.match_code || ""))
        || !Number.isFinite(Date.parse(body.expires_at))
        || !linkUrl || linkUrl.origin !== new URL(normalizedBaseUrl).origin
      ) {
        if (response.status >= 500) throw new HostedLinkError("hosted_unavailable");
        throw new HostedLinkError("link_refused");
      }
      pending = writePendingHostedLink(repository.home, {
        ceremony_version: LINK_CEREMONY_VERSION,
        base_url: normalizedBaseUrl,
        device_id: deviceId,
        credential,
        ticket_id: body.ticket_id,
        poll_secret: body.poll_secret,
        expires_at: new Date(body.expires_at).toISOString(),
      });
      onInstruction({
        base_url: normalizedBaseUrl, device_id: deviceId, ticket_id: body.ticket_id,
        link_url: linkUrl.toString(), match_code: body.match_code,
      });
      openUrl(linkUrl.toString());
    } else {
      onInstruction({
        base_url: pending.base_url, device_id: pending.device_id,
        ticket_id: pending.ticket_id, expires_at: pending.expires_at, resuming_pending: true,
      });
    }
    for (let poll = 0; poll < (maxPolls ?? Infinity); poll += 1) {
      const statusResponse = await request(
        fetchImpl,
        `${pending.base_url}/sync/v1/link/tickets/${encodeURIComponent(pending.ticket_id)}`,
        { headers: { authorization: `Bearer ${pending.poll_secret}` } },
      );
      const statusBody = await responseJson(statusResponse);
      if (statusResponse.status >= 500) throw new HostedLinkError("hosted_unavailable");
      if (statusResponse.status !== 200) {
        if (
          resumingPending && statusResponse.status === 404
          && statusBody.error === "link_not_available"
        ) {
          if (await probePendingHostedCredential({ record: pending, fetchImpl })) {
            repository.deferOwnerScopeKeyAdoption();
            const linked = promoteLink(repository.home, pending);
            await adoptHostedOwnerScopeKey({ repository, record: linked, fetchImpl });
            return linked;
          }
        }
        forgetPendingHostedLink(repository.home);
        throw new HostedLinkError("link_refused");
      }
      if (statusBody.status === "approved") {
        repository.deferOwnerScopeKeyAdoption();
        const linked = promoteLink(repository.home, pending);
        await adoptHostedOwnerScopeKey({ repository, record: linked, fetchImpl });
        return linked;
      }
      if (statusBody.status === "refused") {
        forgetPendingHostedLink(repository.home);
        throw new HostedLinkError("link_refused");
      }
      if (statusBody.status === "expired") {
        forgetPendingHostedLink(repository.home);
        throw new HostedLinkError("link_expired");
      }
      if (statusBody.status !== "pending") {
        forgetPendingHostedLink(repository.home);
        throw new HostedLinkError("link_refused");
      }
      if (poll + 1 < (maxPolls ?? Infinity)) {
        await (sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(pollIntervalMs ?? 2_000);
      }
    }
    return { base_url: pending.base_url, device_id: pending.device_id, status: "pending" };
  }
  if (record.status !== "approved") {
    onInstruction({ base_url: record.base_url, device_id: record.device_id, legacy_pending: true });
    const approved = await waitForHostedApproval({ record, fetchImpl, sleep, pollIntervalMs, maxPolls });
    if (!approved) return record;
    record = writeHostedLink(repository.home, { ...record, status: "approved" });
  }
  await adoptHostedOwnerScopeKey({ repository, record, fetchImpl });
  return record;
}
