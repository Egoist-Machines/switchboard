import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createHostedMessagingReceiver, runMessagingCommand } from "../src/hostedMessaging.js";
import { temporaryHome } from "./helpers.mjs";

function fixtures(t) {
  const home = temporaryHome(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const credentialsPath = resolve(home, "receiver.json");
  const tokenPath = resolve(home, "messaging-token.json");
  const token = { access_token: "messaging-access-one", base_url: "https://passport.ego.ist" };
  const credentials = {
    agent: { id: "agent", runtime: "codex" },
    session: { id: "session", delivery_mode: "codex_app_server", live_verified: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    receiver_token: "receiver-secret", base_url: "https://passport.ego.ist", access_token_file: tokenPath,
  };
  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  writeFileSync(tokenPath, JSON.stringify(token), { mode: 0o600 });
  return { home, credentialsPath, tokenPath, credentials, token };
}

function fakeSdk({ run, failCreate } = {}) {
  const calls = { locks: [], releases: 0, receiver: null, reads: [] };
  const sdk = {
    readPrivateJson: async (path) => { calls.reads.push(path); return JSON.parse(readFileSync(path, "utf8")); },
    createFileAccessTokenProvider: (options) => {
      calls.provider = options;
      return async () => {
        const token = await sdk.readPrivateJson(options.path);
        if (token.base_url && new URL(token.base_url).origin !== options.baseUrl) throw Object.assign(new Error(), { code: "credential_origin_changed" });
        return token.access_token;
      };
    },
    MessagingClient: class { constructor(input) { Object.assign(this, input); calls.client = input; } },
    DeliveryJournal: class { constructor(input) { calls.journal = input; } async load() { return this; } },
    acquireReceiverLock: async (path) => { calls.locks.push(path); return async () => { calls.releases += 1; }; },
    createCodexReceiver: async (input) => {
      calls.receiver = input;
      if (failCreate) throw failCreate;
      return { run: run || (async ({ signal }) => { if (!signal.aborted) await new Promise((done) => signal.addEventListener("abort", done, { once: true })); }) };
    },
  };
  return { sdk, calls, loadSdk: async () => sdk };
}

test("messaging CLI delegates arguments and help to the optional public CLI export", async () => {
  const received = [];
  const args = ["send", "--credentials", "/private/receiver.json", "--input", "/private/message.json"];
  assert.equal(await runMessagingCommand(args, { loadCli: async () => ({ main: async (input) => received.push(input) }) }), 0);
  assert.deepEqual(received, [args]);
  assert.equal(await runMessagingCommand(["--help"], { loadCli: async () => ({ main: async (input) => received.push(input) }) }), 0);
  assert.deepEqual(received[1], ["--help"]);
});

test("optional-package and provider failures emit bounded text without secrets", async () => {
  let text = "";
  const stderr = { write: (line) => { text += line; } };
  assert.equal(await runMessagingCommand([], { stderr, loadCli: async () => { throw new Error("private token in dependency error"); } }), 1);
  assert.match(text, /optional Passport messaging package/);
  assert.doesNotMatch(text, /private token/);
  text = "";
  assert.equal(await runMessagingCommand([], { stderr, loadCli: async () => ({ main: async () => { throw new Error("private working context"); } }) }), 1);
  assert.doesNotMatch(text, /private working context/);
});

test("explicit credentials and a verified controlled host are required before reading files", async () => {
  let loads = 0;
  const deps = { loadSdk: async () => { loads += 1; } };
  for (const credentialsPath of [undefined, "receiver.json"]) {
    await assert.rejects(createHostedMessagingReceiver({ credentialsPath }, deps), { code: "explicit_messaging_credentials_required" });
  }
  for (const host of [{}, { rpc: { request() {} }, threadId: "task" }, { rpc: { request() {} }, threadId: "", supportedToolOutput: true }]) {
    await assert.rejects(createHostedMessagingReceiver({ credentialsPath: "/private/receiver.json", ...host }, deps), { code: "verified_controlled_app_server_required" });
  }
  assert.equal(loads, 0);
});

test("memory and sync credentials cannot be repurposed as messaging credentials", async (t) => {
  const fixture = fixtures(t);
  const { loadSdk, calls } = fakeSdk();
  const host = { credentialsPath: fixture.credentialsPath, rpc: { request() {} }, threadId: "task", supportedToolOutput: true };
  for (const value of [
    { client_id: "local-client", client_secret: "local-secret" },
    { device_id: "sync-device", token: "sync-token" },
    { ...fixture.credentials, session: { ...fixture.credentials.session, live_verified: false } },
    { ...fixture.credentials, session: { ...fixture.credentials.session, expires_at: "2000-01-01" } },
    { ...fixture.credentials, agent: { runtime: "claude_code" } },
    { ...fixture.credentials, access_token_file: "relative.json" },
  ]) {
    writeFileSync(fixture.credentialsPath, JSON.stringify(value));
    await assert.rejects(createHostedMessagingReceiver(host, { loadSdk }), { code: "explicit_verified_messaging_credentials_required" });
  }
  assert.deepEqual(calls.locks, []);
});

test("receiver pins one host, serializes its lifecycle, strips observer details, and releases once", async (t) => {
  const fixture = fixtures(t);
  const { loadSdk, calls } = fakeSdk();
  const observed = [];
  const rpc = { request() {} };
  const handle = await createHostedMessagingReceiver({ credentialsPath: fixture.credentialsPath, rpc, threadId: "exact-task", supportedToolOutput: true, onState: (event) => observed.push(event) }, { loadSdk });
  assert.equal(calls.receiver.rpc, rpc);
  assert.equal(calls.receiver.threadId, "exact-task");
  assert.equal(calls.receiver.supportedToolOutput, true);
  assert.deepEqual(calls.journal, { path: `${realpathSync(fixture.credentialsPath)}.journal`, sessionId: "session" });
  assert.deepEqual(calls.locks, [`${realpathSync(fixture.credentialsPath)}.lock`]);
  calls.receiver.onState({ state: "connected", body: "must not surface", token: "secret" });
  calls.receiver.onState({ state: "unbounded-peer-state", body: "must not surface" });
  assert.deepEqual(observed, [{ state: "connected" }]);
  const running = handle.run();
  assert.equal(handle.run(), running);
  await handle.stop();
  await running;
  await handle.stop();
  assert.equal(calls.releases, 1);
  assert.deepEqual(Object.keys(handle), ["sessionId", "threadId", "run", "stop"]);
  assert.equal(existsSync(resolve(fixture.home, "passport.db")), false);
});

test("setup failure releases its lock and preserves no provider error contents", async (t) => {
  const fixture = fixtures(t);
  const { loadSdk, calls } = fakeSdk({ failCreate: new Error("peer content or secret") });
  await assert.rejects(createHostedMessagingReceiver({ credentialsPath: fixture.credentialsPath, rpc: { request() {} }, threadId: "task", supportedToolOutput: true }, { loadSdk }), (error) => {
    assert.equal(error.code, "messaging_credentials_unavailable");
    assert.doesNotMatch(error.message, /peer content|secret/);
    return true;
  });
  assert.equal(calls.releases, 1);
});

test("stop before run releases the lock without starting a receiver", async (t) => {
  const fixture = fixtures(t);
  let runs = 0;
  const { loadSdk, calls } = fakeSdk({ run: async () => { runs += 1; } });
  const receiver = await createHostedMessagingReceiver({ credentialsPath: fixture.credentialsPath, rpc: { request() {} }, threadId: "task", supportedToolOutput: true }, { loadSdk });
  assert.equal(calls.provider.path, fixture.tokenPath);
  assert.equal(calls.provider.baseUrl, fixture.credentials.base_url);
  await receiver.stop();
  await assert.rejects(receiver.run(), { code: "messaging_receiver_stopped" });
  assert.equal(runs, 0);
  assert.equal(calls.releases, 1);
});

test("OAuth refresh reads only the explicitly referenced private token file and pins its origin", async (t) => {
  const fixture = fixtures(t);
  const { loadSdk, calls } = fakeSdk();
  const receiver = await createHostedMessagingReceiver({ credentialsPath: fixture.credentialsPath, rpc: { request() {} }, threadId: "task", supportedToolOutput: true }, { loadSdk });
  writeFileSync(fixture.tokenPath, JSON.stringify({ ...fixture.token, access_token: "new-access-token" }));
  assert.equal(await calls.client.getAccessToken(), "new-access-token");
  writeFileSync(fixture.tokenPath, JSON.stringify({ ...fixture.token, base_url: "https://other.example" }));
  await assert.rejects(calls.client.getAccessToken(), { code: "credential_origin_changed" });
  await receiver.stop();
  assert.ok(calls.reads.every((path) => [fixture.credentialsPath, fixture.tokenPath].includes(path)));
});

let sourceSdk;
try {
  sourceSdk = process.env.PASSPORT_MESSAGING_SDK_SOURCE
    ? await import(pathToFileURL(resolve(process.env.PASSPORT_MESSAGING_SDK_SOURCE, "src/index.js")))
    : await import("@egoistmachines/passport-messaging");
} catch (error) {
  if (process.env.PASSPORT_MESSAGING_SDK_SOURCE) throw error;
}

test("real Switchboard messaging CLI loads the source SDK public CLI before any local store", { skip: !process.env.PASSPORT_MESSAGING_SDK_SOURCE && "set PASSPORT_MESSAGING_SDK_SOURCE for the CLI release smoke" }, (t) => {
  const home = temporaryHome(t);
  writeFileSync(home, "not a local store directory");
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", new URL("./messagingSdkLoader.mjs", import.meta.url).pathname, new URL("../src/cli.js", import.meta.url).pathname, "messaging", "--help"], {
    encoding: "utf8", env: { ...process.env, SWITCHBOARD_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passport-messaging register/);
  assert.match(result.stdout, /separate messaging OAuth scope/);
  assert.doesNotMatch(result.stdout, /Usage: switchboard <command>/);
  assert.equal(readFileSync(home, "utf8"), "not a local store directory");
});

test("source SDK smoke: exact task tool-output acceptance, rotating OAuth, dedupe, private journal, and shutdown", { skip: !sourceSdk && "optional SDK not installed; set PASSPORT_MESSAGING_SDK_SOURCE for the release smoke" }, async (t) => {
  const fixture = fixtures(t);
  const rpcCalls = [];
  const network = [];
  const message = { id: "message-one", recipient_session_id: "session", sender_session_id: "peer-session", sender_id: "peer", conversation_id: "conversation", group_id: "group", body: "source SDK smoke working context", lease_token: "lease", expires_at: fixture.credentials.session.expires_at };
  let claimed = false;
  const request = async (url, init) => {
    network.push({ path: new URL(url).pathname, authorization: init.headers.authorization });
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (url.includes("/receive")) {
      const messages = claimed ? [] : [message];
      claimed = true;
      writeFileSync(fixture.tokenPath, JSON.stringify({ ...fixture.token, access_token: "messaging-access-refreshed" }));
      return Response.json({ messages });
    }
    if (url.includes("/ack")) {
      assert.equal(init.headers["x-passport-receiver"], "receiver-secret");
      assert.equal(JSON.parse(init.body).message_id, "message-one");
      return Response.json({ acknowledged: true });
    }
    throw new Error("unexpected request");
  };
  const make = async (threadId) => {
    const controller = new AbortController();
    const receiver = await createHostedMessagingReceiver({
      credentialsPath: fixture.credentialsPath, threadId, supportedToolOutput: true,
      rpc: { request: async (...args) => { rpcCalls.push(args); return { turn: { id: "accepted-turn" } }; } },
      fetch: request, onState: () => controller.abort(),
    }, { loadSdk: async () => sourceSdk });
    return { receiver, controller };
  };
  const first = await make("selected-task");
  await first.receiver.run({ signal: first.controller.signal });
  await first.receiver.stop();
  assert.equal(existsSync(`${fixture.credentialsPath}.lock`), false);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0][0], "turn/start");
  assert.equal(rpcCalls[0][1].threadId, "selected-task");
  assert.deepEqual(rpcCalls[0][1].input, []);
  assert.deepEqual(Object.keys(rpcCalls[0][1]).sort(), ["input", "threadId", "toolOutput"]);
  assert.equal(JSON.parse(rpcCalls[0][1].toolOutput.output).source, "passport_peer_message");
  assert.equal(network.find((row) => row.path.endsWith("/receive")).authorization, "Bearer messaging-access-one");
  assert.equal(network.find((row) => row.path.endsWith("/ack")).authorization, "Bearer messaging-access-refreshed");
  const journal = readFileSync(`${fixture.credentialsPath}.journal`, "utf8");
  assert.match(journal, /acknowledged/);
  assert.doesNotMatch(journal, /working context|receiver-secret|messaging-access|lease/);
  claimed = false;
  const second = await make("selected-task");
  await second.receiver.run({ signal: second.controller.signal });
  assert.equal(rpcCalls.length, 1, "an acknowledged retry never injects another task turn");
  await assert.rejects(make("different-task"), { code: "receiver_host_mismatch" });
  assert.equal(existsSync(`${fixture.credentialsPath}.lock`), false);
  chmodSync(fixture.credentialsPath, 0o644);
  await assert.rejects(make("selected-task"), { code: "unsafe_private_file" });
});

test("source SDK refreshes an expired OAuth pair and retries one refused acknowledgement without changing its claim", { skip: !sourceSdk && "optional SDK not installed; set PASSPORT_MESSAGING_SDK_SOURCE for the release smoke" }, async (t) => {
  const fixture = fixtures(t);
  writeFileSync(fixture.tokenPath, JSON.stringify({ ...fixture.token, refresh_token: "refresh-one", client_id: "exact-client", scope: "openid messaging", expires_at: 1 }));
  let refreshes = 0;
  const acknowledgements = [];
  const controller = new AbortController();
  const message = { id: "auto-refreshed-message", sender_id: "peer", sender_session_id: "peer-session", recipient_session_id: "session", conversation_id: "conversation", group_id: "group", body: "A bounded peer request", lease_token: "original-claim", expires_at: fixture.credentials.session.expires_at };
  const receiver = await createHostedMessagingReceiver({
    credentialsPath: fixture.credentialsPath, rpc: { request: async () => ({ turn: { id: "accepted" } }) },
    threadId: "selected-task", supportedToolOutput: true, onState: () => controller.abort(),
    fetch: async (url, init) => {
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (url === "https://passport.ego.ist/token") {
        const request = new URLSearchParams(init.body);
        assert.equal(request.get("grant_type"), "refresh_token");
        assert.equal(request.get("client_id"), "exact-client");
        assert.equal(request.get("scope"), null);
        refreshes += 1;
        return Response.json({ access_token: `rotated-${refreshes}`, refresh_token: `rotated-refresh-${refreshes}`, token_type: "Bearer", expires_in: 3600, scope: "openid messaging" });
      }
      if (url.includes("/receive")) {
        assert.equal(init.headers.authorization, "Bearer rotated-1");
        return Response.json({ messages: [message] });
      }
      if (url.includes("/ack")) {
        acknowledgements.push({ authorization: init.headers.authorization, body: init.body });
        return acknowledgements.length === 1 ? Response.json({ error: "expired" }, { status: 401 }) : Response.json({ acknowledged: true });
      }
      throw new Error("unexpected request");
    },
  }, { loadSdk: async () => sourceSdk });
  await receiver.run({ signal: controller.signal });
  await receiver.stop();
  assert.equal(refreshes, 2);
  assert.deepEqual(acknowledgements.map((value) => value.authorization), ["Bearer rotated-1", "Bearer rotated-2"]);
  assert.equal(acknowledgements[0].body, acknowledgements[1].body);
  const stored = JSON.parse(readFileSync(fixture.tokenPath, "utf8"));
  assert.equal(stored.access_token, "rotated-2");
  assert.equal(stored.refresh_token, "rotated-refresh-2");
  assert.equal(stored.scope, "openid messaging");
  assert.equal(existsSync(`${fixture.credentialsPath}.lock`), false);
  assert.equal(existsSync(`${fixture.tokenPath}.refresh.lock`), false);
});
