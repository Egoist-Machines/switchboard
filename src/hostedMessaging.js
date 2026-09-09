import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

const PACKAGE = "@egoistmachines/passport-messaging";
const SAFE_CODES = new Set([
  "unsafe_private_file", "receiver_already_running_or_stale_lock", "receiver_host_mismatch", "journal_session_mismatch",
  "verified_live_codex_adapter_required", "verified_controlled_app_server_required", "host_acceptance_ambiguous",
  "receiver_reconnect_exhausted", "authentication_required", "credential_origin_changed", "invalid_received_message",
  "invalid_receive_response", "invalid_api_origin",
]);

export class HostedMessagingError extends Error {
  constructor(code) {
    super(`Hosted messaging: ${code}.`);
    this.name = "HostedMessagingError";
    this.code = code;
  }
}

function safeError(error, fallback = "messaging_receiver_failed") {
  if (error instanceof HostedMessagingError) return error;
  return new HostedMessagingError(SAFE_CODES.has(error?.code) ? error.code : fallback);
}

async function sdkModule(loadSdk) {
  try { return await loadSdk(); }
  catch { throw new HostedMessagingError("messaging_package_unavailable"); }
}

/** Delegate explicitly requested messaging commands without opening local memory. */
export async function runMessagingCommand(args, {
  loadCli = () => import(`${PACKAGE}/cli`),
  stderr = process.stderr,
} = {}) {
  try {
    const cli = await sdkModule(loadCli);
    if (typeof cli.main !== "function") throw new HostedMessagingError("messaging_package_unavailable");
    await cli.main(args);
    return 0;
  } catch (error) {
    const code = safeError(error).code;
    const message = code === "messaging_package_unavailable"
      ? "Install the optional Passport messaging package beside Switchboard. See the hosted messaging guide in DOCS.md."
      : code === "host_acceptance_ambiguous"
        ? "The receiving task may already have accepted this message. Reconcile its status before retrying."
        : code === "receiver_already_running_or_stale_lock"
          ? "This messaging session is already running or has a stale lock. Verify the previous receiver stopped before retrying."
          : "The messaging command could not complete. Check the separate messaging credentials, owner approval, and receiver status.";
    stderr.write(`${message}\n`);
    return 1;
  }
}

/**
 * Attach only to an initialized App Server connection controlled by the caller.
 * Local memory grants, hook credentials, and hosted-sync links are never read.
 * Creation holds the session lock until run finishes or stop is called.
 */
export async function createHostedMessagingReceiver({
  credentialsPath, rpc, threadId, supportedToolOutput = false,
  reconcileAcceptance, onState, fetch: fetchImpl,
  maxReconnects, retryBaseMs, recoveryIntervalMs,
} = {}, {
  loadSdk = () => import(PACKAGE),
  now = Date.now,
} = {}) {
  if (typeof credentialsPath !== "string" || !isAbsolute(credentialsPath)) throw new HostedMessagingError("explicit_messaging_credentials_required");
  if (typeof rpc?.request !== "function" || typeof threadId !== "string" || !threadId.trim() || supportedToolOutput !== true) {
    throw new HostedMessagingError("verified_controlled_app_server_required");
  }
  const sdk = await sdkModule(loadSdk);
  let release;
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    if (release) await release();
  };
  try {
    // Read the supplied path before canonicalizing, so a symlink at the file
    // itself remains rejected by the SDK. Canonical paths prevent alternate
    // directory spellings from opening a second lock for the same session.
    const credentials = await sdk.readPrivateJson(credentialsPath);
    const canonicalPath = await realpath(credentialsPath);
    if (credentials?.agent?.runtime !== "codex"
      || typeof credentials?.session?.id !== "string" || !credentials.session.id
      || credentials.session.delivery_mode !== "codex_app_server" || credentials.session.live_verified !== true
      || !(Date.parse(credentials.session.expires_at) > now())
      || typeof credentials.receiver_token !== "string" || !credentials.receiver_token
      || typeof credentials.access_token_file !== "string" || !isAbsolute(credentials.access_token_file)
      || typeof credentials.base_url !== "string") {
      throw new HostedMessagingError("explicit_verified_messaging_credentials_required");
    }
    const tokenPath = credentials.access_token_file;
    if (typeof sdk.createFileAccessTokenProvider !== "function") throw new HostedMessagingError("messaging_package_unavailable");
    const readAccessToken = sdk.createFileAccessTokenProvider({
      path: tokenPath, baseUrl: credentials.base_url, now,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const client = new sdk.MessagingClient({
      baseUrl: credentials.base_url, session: credentials.session, receiverToken: credentials.receiver_token,
      getAccessToken: readAccessToken,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    await readAccessToken();
    release = await sdk.acquireReceiverLock(`${canonicalPath}.lock`);
    const journal = await new sdk.DeliveryJournal({ path: `${canonicalPath}.journal`, sessionId: credentials.session.id }).load();
    const receiver = await sdk.createCodexReceiver({
      rpc, threadId, supportedToolOutput, client, journal,
      ...(reconcileAcceptance ? { reconcileAcceptance } : {}),
      ...(maxReconnects !== undefined ? { maxReconnects } : {}),
      ...(retryBaseMs !== undefined ? { retryBaseMs } : {}),
      ...(recoveryIntervalMs !== undefined ? { recoveryIntervalMs } : {}),
      onState: ({ state }) => {
        if (!["connecting", "connected", "reconnecting"].includes(state)) return;
        try { onState?.({ state }); } catch { /* Observers cannot change delivery or acknowledgement. */ }
      },
    });
    const controller = new AbortController();
    let running = null;
    let stopped = false;
    return Object.freeze({
      sessionId: credentials.session.id,
      threadId,
      run({ signal } = {}) {
        if (running) return running;
        if (stopped) return Promise.reject(new HostedMessagingError("messaging_receiver_stopped"));
        running = (async () => {
          try {
            await receiver.run({ signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
          } catch (error) { throw safeError(error); }
          finally { stopped = true; await releaseOnce(); }
        })();
        return running;
      },
      async stop() {
        stopped = true;
        controller.abort();
        if (running) await running.catch(() => {});
        await releaseOnce();
      },
    });
  } catch (error) {
    await releaseOnce();
    throw safeError(error, "messaging_credentials_unavailable");
  }
}
