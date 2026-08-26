import { spawn as nodeSpawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeProposalOutcome, normalizeReadOutcome, unavailableProposal, unavailableRead } from "./outcomes.js";

const MAX_STDOUT_BYTES = 1024 * 1024;

function normalizeHandoffClaimOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.status === "none_pending") {
    return { status: "none_pending", handoff_id: null, snapshot: null, expires_at: null };
  }
  if (value.status === "claimed") {
    if (
      typeof value.handoff_id !== "string" ||
      !value.handoff_id ||
      typeof value.snapshot !== "string" ||
      !value.snapshot ||
      typeof value.expires_at !== "string" ||
      !value.expires_at
    ) {
      return null;
    }
    return {
      status: "claimed",
      handoff_id: value.handoff_id,
      snapshot: value.snapshot,
      expires_at: value.expires_at,
    };
  }
  if (value.status === "expired") {
    if (
      typeof value.handoff_id !== "string" ||
      !value.handoff_id ||
      typeof value.expires_at !== "string" ||
      !value.expires_at
    ) {
      return null;
    }
    return { status: "expired", handoff_id: value.handoff_id, snapshot: null, expires_at: value.expires_at };
  }
  return null;
}

const unavailableHandoffClaim = (_transport, reason) => ({
  status: "unavailable",
  handoff_id: null,
  snapshot: null,
  expires_at: null,
  internalReason: reason,
});

async function readJson(filePath) {
  const body = await readFile(filePath, "utf8");
  const value = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json_object");
  return value;
}

async function loadRuntime(discoveryPath) {
  const record = await readJson(discoveryPath);
  if (typeof record.bin !== "string" || !path.isAbsolute(record.bin)) throw new Error("invalid_discovery_record");
  return record.bin;
}

async function loadCredentials(credentialsPath) {
  const metadata = await stat(credentialsPath);
  if ((metadata.mode & 0o077) !== 0) throw new Error("unsafe_credentials_mode");
  const record = await readJson(credentialsPath);
  const secret = typeof record.client_secret === "string" ? record.client_secret : record.secret;
  if (typeof record.client_id !== "string" || !record.client_id || typeof secret !== "string" || !secret) {
    throw new Error("invalid_credentials");
  }
  return { client_id: record.client_id, client_secret: secret };
}

function runJsonCommand({ bin, command, payload, timeoutMs, spawnImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(bin, [command, "--json"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "spawn_failed" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "deadline_exceeded" });
    }, timeoutMs);
    timer.unref?.();

    child.once("error", () => finish({ ok: false, reason: "spawn_failed" }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish({ ok: false, reason: "stdout_too_large" });
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ ok: false, reason: "nonzero_exit" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_stdout");
        finish({ ok: true, payload: parsed });
      } catch {
        finish({ ok: false, reason: "malformed_stdout" });
      }
    });
    child.stdin.once("error", () => finish({ ok: false, reason: "stdin_failed" }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export function createLocalTransport({
  discoveryPath,
  credentialsPath,
  timeoutMs = 1500,
  spawnImpl = nodeSpawn,
} = {}) {
  let lastOutcome = null;
  let lastReason = null;

  const invoke = async (command, input, normalize, unavailable) => {
    try {
      const [bin, credentials] = await Promise.all([loadRuntime(discoveryPath), loadCredentials(credentialsPath)]);
      const { timeoutMs: callTimeoutMs, ...commandInput } = input ?? {};
      const executed = await runJsonCommand({
        bin,
        command,
        payload: { ...commandInput, ...credentials },
        timeoutMs: callTimeoutMs ?? timeoutMs,
        spawnImpl,
      });
      if (!executed.ok) {
        lastReason = executed.reason;
        lastOutcome = "unavailable";
        return unavailable("local", executed.reason, input?.save_id);
      }
      const outcome = normalize(executed.payload, "local");
      const requestedCategories = Array.isArray(input?.categories) ? new Set(input.categories) : null;
      const crossedCategoryBoundary =
        command === "prefetch" &&
        requestedCategories &&
        [...(outcome?.rows ?? []), ...(outcome?.skipped_categories ?? [])].some(
          (entry) => !requestedCategories.has(entry.category)
        );
      if (!outcome || crossedCategoryBoundary) {
        lastReason = "invalid_contract";
        lastOutcome = "unavailable";
        return unavailable("local", "invalid_contract", input?.save_id);
      }
      lastReason = null;
      lastOutcome = outcome.status;
      return outcome;
    } catch (error) {
      const reason = error?.code === "ENOENT" ? "missing_local_state" : error?.message || "local_state_unavailable";
      lastReason = reason;
      lastOutcome = "unavailable";
      return unavailable("local", reason, input?.save_id);
    }
  };

  return {
    async status() {
      const result = {
        transport: "local",
        discoveryFound: false,
        paired: false,
        lastOutcome,
        lastReason,
      };
      try {
        await loadRuntime(discoveryPath);
        result.discoveryFound = true;
      } catch {}
      try {
        await loadCredentials(credentialsPath);
        result.paired = true;
      } catch {}
      return result;
    },
    prefetch(input = {}) {
      return invoke("prefetch", input, normalizeReadOutcome, unavailableRead);
    },
    recall(input = {}) {
      return invoke("prefetch", { ...input, ambient: false }, normalizeReadOutcome, unavailableRead);
    },
    propose(input = {}) {
      return invoke("propose", input, normalizeProposalOutcome, unavailableProposal);
    },
    claimHandoff(input = {}) {
      return invoke("handoff-claim", input, normalizeHandoffClaimOutcome, unavailableHandoffClaim);
    },
  };
}
