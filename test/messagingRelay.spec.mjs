import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRepository } from "../src/repository.js";
import { MessagingRelay, messageAgents, sendMessage, messagingLinkKey, approvedMessagingLink, messagingStatus, ensureMessagingRelay } from "../src/messagingRelay.js";
import { receiveMessages, acquireLock, lockPath, LockBlockedError } from "../src/messaging.js";
import { writeHostedLink, forgetHostedLink } from "../src/hostedLink.js";
import { temporaryHome } from "./helpers.mjs";

async function fixture(t) {
  const r = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => r.close());
  const a = r.addClient({ host: "claude-code", label: "Claude" });
  const b = r.addClient({ host: "codex", label: "Codex" });
  const registrations = new Map(), seen = [], inbox = [], acknowledgements = new Set(), streams = new Map(), sent = new Map();
  const hosted = { id: randomUUID(), label: "Muse", runtime: "muse", live: true };
  const groupId = randomUUID();
  let lostReply = false;
  const handler = async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer apsd_${"a".repeat(43)}`);
      const url = new URL(req.url, "http://localhost");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const agentId = body?.agent_id ?? url.searchParams.get("agent_id");
      const route = url.pathname.replace("/messaging/v1/", "");
      seen.push({ route, body, agentId });
      const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (route === "register") {
        assert.equal(body.agent_id, undefined);
        assert.ok(body.installation);
        if (!registrations.has(body.installation)) registrations.set(body.installation, { ...body, id: randomUUID(), origin_kind: "device", live: false });
        json({ agent: registrations.get(body.installation) }); return;
      }
      assert.ok([...registrations.values()].some(a => a.id === agentId), "device requests must name their agent");
      if (route === "agents") {
        json({ self: [...registrations.values()].find(a => a.id === agentId), agents: [hosted, ...[...registrations.values()].filter(a => a.id !== agentId)], groups: [{ id: groupId, name: "Review", purpose: "Review code", agent_ids: [...registrations.values()].map(a => a.id).concat(hosted.id), expires_at: new Date(Date.now() + 86400000).toISOString() }] });
      } else if (route === "events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: ready\ndata: ${JSON.stringify({ agent_id: agentId })}\n\n`);
        streams.set(agentId, res);
        // The request body was already consumed above, so its close event may
        // have fired; the response closes only when the connection does.
        res.on("close", () => streams.delete(agentId));
      } else if (route === "receive") {
        json({ messages: inbox.filter(m => m.recipient_agent_id === agentId && !acknowledgements.has(m.id)).slice(0, body.limit) });
      } else if (route === "ack") {
        // The contract's custody ack cannot precede the SQLite commit.
        assert.ok(r.db.prepare("SELECT 1 FROM messages WHERE hosted_message_id=?").get(body.message_id));
        acknowledgements.add(body.message_id); json({ ...inbox.find(m => m.id === body.message_id), body: undefined, state: "acknowledged" });
      } else if (route === "send") {
        const prior = sent.get(body.idempotency_key);
        const message = prior ?? { id: randomUUID(), sender_agent_id: agentId, recipient_agent_id: body.recipient_agent_id, group_id: body.group_id, conversation_id: body.conversation_id ?? randomUUID(), reply_to: body.reply_to ?? null, state: "queued", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), delivered_at: null, acknowledged_at: null, replied_at: null };
        sent.set(body.idempotency_key, message);
        if (!lostReply) { lostReply = true; res.destroy(); return; }
        json({ ...message, ...(prior ? { replayed: true } : {}) });
      } else json({ error: "not_found", retryable: false }, 404);
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: "test_failure", retryable: false })); t.diagnostic(error.stack); }
  };
  const server = http.createServer(handler);
  let baseUrl, fetchImpl = globalThis.fetch;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { for (const stream of streams.values()) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    t.diagnostic("Sandbox denies loopback binding; exercising the same fake server handler with injected fetch.");
    baseUrl = "http://127.0.0.1:43210";
    fetchImpl = (url, init) => new Promise((resolve, reject) => {
      let status = 200, headers = {}, controller, closed = false, onClose = () => {};
      const close = () => { if (closed) return; closed = true; onClose(); try { controller?.close(); } catch {} };
      const req = {
        url: new URL(url).pathname + new URL(url).search, headers: init.headers,
        async *[Symbol.asyncIterator]() { if (init.body) yield init.body; },
        on(event, cb) { if (event === "close") onClose = cb; },
      };
      const res = {
        writeHead(code, fields = {}) {
          status = code; headers = fields;
          if (headers["content-type"] === "text/event-stream") {
            const body = new ReadableStream({ start(c) { controller = c; }, cancel() { close(); } });
            resolve(new Response(body, { status, headers }));
          }
        },
        write(text) { if (!closed) controller.enqueue(new TextEncoder().encode(text)); },
        end(text) { resolve(new Response(text, { status, headers })); },
        destroy() { close(); reject(new TypeError("connection lost")); },
        on(event, cb) { if (event === "close") onClose = cb; },
      };
      init.signal?.addEventListener("abort", close, { once: true });
      void handler(req, res).catch(reject);
    });
  }
  writeHostedLink(r.home, { base_url: baseUrl, device_id: "test-device", credential: `apsd_${"a".repeat(43)}`, status: "approved" });
  const relay = new MessagingRelay(r, { hostname: "test-machine", fetchImpl });
  const inbound = () => {
    const message = { id: randomUUID(), conversation_id: randomUUID(), group_id: groupId, sender_agent_id: hosted.id, recipient_agent_id: registrations.get(a.client_id).id, reply_to: null, state: "delivered", body: "Please check the parser", sender_label: "Muse", source: "passport_peer", notice: "untrusted", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() };
    inbox.push(message); return message;
  };
  return { r, a, b, relay, fetchImpl, hosted, groupId, registrations, seen, inbox, acknowledgements, streams, sent, inbound };
}

test("relay registers installations, merges approved peers, stores before ack and deduplicates", async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  assert.equal(registrations.length, 2);
  assert.equal(f.registrations.get(f.a.client_id).runtime, "claude_code");
  assert.equal(f.registrations.get(f.b.client_id).runtime, "codex");
  assert.match(f.registrations.get(f.a.client_id).label, /on test-machine$/);
  const agents = await messageAgents(f.r, f.a, { hostname: "test-machine", fetchImpl: f.fetchImpl });
  assert.equal(agents.local.length, 2); assert.equal(agents.agents[0].id, f.hosted.id); assert.equal(agents.groups.length, 1);
  const remote = f.inbound();
  await f.relay.inbound(registrations.find(a => a.client_id === f.a.client_id));
  assert.ok(f.acknowledgements.has(remote.id));
  f.acknowledgements.clear();
  await f.relay.inbound(registrations.find(a => a.client_id === f.a.client_id));
  assert.equal(f.r.listMessages().length, 1);
  const result = await receiveMessages(f.r, f.a);
  assert.match(result.messages[0].envelope, /from="Muse"/);
  assert.equal(result.messages[0].hosted_message_id, remote.id);
  assert.equal(f.r.contentRecords().length, 0);
});

test("outbound retries the stored idempotency key after lost response and maps a reply", async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  const remote = f.inbound();
  await f.relay.inbound(registrations.find(a => a.client_id === f.a.client_id));
  const parent = f.r.listMessages()[0];
  const key = randomUUID();
  const release = acquireLock(lockPath(f.r.home)); t.after(release);
  const local = await sendMessage(f.r, { ...f.a, to: "Muse", body: "The parser looks correct", reply_to: parent.message_id, idempotency_key: key }, { fetchImpl: f.fetchImpl });
  await f.relay.outbound();
  assert.equal(f.r.messageStatus(local.message_id).state, "pending");
  assert.ok(messagingStatus(f.r).failures.length);
  f.r.db.prepare("UPDATE messages SET retry_at=NULL WHERE message_id=?").run(local.message_id);
  await f.relay.outbound();
  const result = f.r.messageStatus(local.message_id);
  assert.equal(result.state, "delivered");
  assert.equal(f.sent.size, 1);
  const requests = f.seen.filter(r => r.route === "send");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.body.idempotency_key === key && r.body.reply_to === remote.id && r.body.conversation_id === remote.conversation_id && r.body.group_id === remote.group_id));
  assert.equal(result.hosted_receipt_id, f.sent.get(key).id);
  assert.equal(result.hosted_message_id, null);
});

test("SSE ready and fragmented message events trigger inbox reconciliation", async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  const registration = registrations.find(a => a.client_id === f.a.client_id);
  const controller = new AbortController();
  const running = f.relay.stream(registration, controller.signal);
  try {
    for (let i = 0; i < 100 && !f.streams.has(registration.agent_id); i++) await delay(10);
    const remote = f.inbound();
    const stream = f.streams.get(registration.agent_id);
    assert.ok(stream);
    stream.write("event: mess"); stream.write(`age\ndata: ${JSON.stringify({ message_id: remote.id, state: "queued" })}\n\n`);
    for (let i = 0; i < 100 && !f.acknowledgements.has(remote.id); i++) await delay(10);
    assert.ok(f.acknowledgements.has(remote.id));
  } finally { controller.abort(); await running; }
});

test("unlinked and disabled stores make no hosted calls; stale link outbox is fenced", async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error("network called"); } };
  f.r.setMessaging(false);
  assert.equal(approvedMessagingLink(f.r), null);
  await messageAgents(f.r, null, options);
  f.r.setMessaging(true); forgetHostedLink(f.r.home);
  const agents = await messageAgents(f.r, f.a, options);
  assert.equal(agents.local.length, 2); assert.equal(calls, 0);
  await assert.rejects(sendMessage(f.r, { ...f.a, to: "Muse", body: "Hello", idempotency_key: randomUUID() }, options), /unlinked/);
  assert.equal(calls, 0);
});

test("ambiguous hosted labels list ids and revoked clients cannot query hosted peers", async t => {
  const f = await fixture(t);
  const one = randomUUID(), two = randomUUID();
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/register")) { const body = JSON.parse(init.body); return new Response(JSON.stringify({ agent: { ...body, id: randomUUID() } })); }
    const agentId = new URL(url).searchParams.get("agent_id");
    return new Response(JSON.stringify({ self: { id: agentId }, agents: [{ id: one, label: "Same" }, { id: two, label: "Same" }], groups: [] }));
  };
  await assert.rejects(sendMessage(f.r, { ...f.a, to: "Same", body: "Hello", idempotency_key: randomUUID() }, { fetchImpl }), error => error.message.includes(one) && error.message.includes(two));
  f.r.revokeClient(f.a.client_id);
  await assert.rejects(messageAgents(f.r, f.a, { fetchImpl }), /authentication/);
});

test("relinking the same device with a new credential fences the old outbox", async t => {
  const f = await fixture(t);
  await f.relay.register();
  const release = acquireLock(lockPath(f.r.home)); t.after(release);
  const message = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review the parser", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  const link = approvedMessagingLink(f.r);
  writeHostedLink(f.r.home, { ...link, credential: `apsd_${"b".repeat(43)}` });
  await f.relay.outbound();
  assert.equal(f.r.messageStatus(message.message_id).last_error, "link_changed");
  assert.equal(f.seen.filter(c => c.route === "send").length, 0);
});

test("orphaned takeover guard reports blocked and suppresses relay starts until recovery", async t => {
  const f = await fixture(t);
  const file = lockPath(f.r.home), guard = `${file}.takeover`;
  const stale = JSON.stringify({ pid: 2147483647, token: "stale" });
  writeFileSync(file, stale);
  writeFileSync(guard, "");
  let spawns = 0, calls = 0;
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    spawns++;
    return { on() {}, unref() {} };
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  const relay = new MessagingRelay(f.r, { fetchImpl: async () => { calls++; throw new Error("unexpected network call"); } });
  assert.throws(() => acquireLock(file), error => error instanceof LockBlockedError && error.guard === guard);
  for (let i = 0; i < 3; i++) {
    const result = await relay.run();
    assert.equal(result.status, "blocked");
    assert.equal(result.guard, guard);
    assert.ok(result.recovery.includes(guard));
    assert.match(result.recovery, /Stop all users/);
    const status = messagingStatus(f.r);
    assert.equal(status.relay, "blocked");
    assert.equal(status.guard, guard);
    assert.equal(status.recovery, result.recovery);
    assert.equal(ensureMessagingRelay(f.r), false);
  }
  assert.equal(spawns, 0);
  assert.equal(calls, 0);
  assert.equal(f.seen.length, 0);
  assert.equal(readFileSync(file, "utf8"), stale);
  assert.equal(existsSync(guard), true);
  // The foreground command must not exit quietly with success while recovery is needed.
  const cli = childProcess.spawnSync(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname, "messaging", "relay"],
    { env: { ...process.env, SWITCHBOARD_HOME: f.r.home }, encoding: "utf8", timeout: 20000 });
  assert.equal(cli.status, 2);
  assert.equal(JSON.parse(cli.stdout).status, "blocked");
  assert.equal(f.seen.length, 0);
  unlinkSync(guard);
  assert.equal(messagingStatus(f.r).relay, "stopped");
  assert.equal(ensureMessagingRelay(f.r), true);
  assert.equal(spawns, 1);
  const release = acquireLock(file);
  try {
    assert.equal(typeof release, "function");
    assert.equal(messagingStatus(f.r).relay, "running");
    assert.equal((await relay.run()).status, "already_running");
    assert.equal(ensureMessagingRelay(f.r), false);
  } finally { release(); }
  assert.equal(existsSync(file), false);
  assert.equal(calls, 0);
});

test("foreground relay holds one store lock and stops on consent withdrawal", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const relay = new MessagingRelay(f.r, { fetchImpl: f.fetchImpl, signal: controller.signal });
  const running = relay.run();
  try {
    for (let i = 0; i < 100 && !f.streams.size; i++) await delay(10);
    assert.equal((await new MessagingRelay(f.r, { fetchImpl: f.fetchImpl }).run()).status, "already_running");
    assert.equal(messagingStatus(f.r).relay, "running");
    f.r.setMessaging(false);
    await running;
    assert.equal(messagingStatus(f.r).relay, "stopped");
    // The fake server observes the socket close asynchronously after the relay
    // aborts its streams, so allow it a bounded moment to record the closures.
    for (let i = 0; i < 100 && f.streams.size; i++) await delay(10);
    assert.equal(f.streams.size, 0);
  } finally { controller.abort(); await running; }
});

for (const inboundFirst of [true, false]) test(`hosted delivery between local installations works with inbound ${inboundFirst ? "before" : "after"} outbound completion`, async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  const a = registrations.find(row => row.client_id === f.a.client_id);
  const b = registrations.find(row => row.client_id === f.b.client_id);
  const release = acquireLock(lockPath(f.r.home)); t.after(release);
  const key = randomUUID();
  const outbound = await sendMessage(f.r, { ...f.a, to: b.agent_id, body: "Review this change", idempotency_key: key }, { fetchImpl: f.fetchImpl });
  // The fake server accepts this send but drops its first response.
  await f.relay.outbound();
  const hosted = f.sent.get(key);
  assert.ok(hosted);
  f.inbox.push({ ...hosted, body: "Review this change", sender_label: "Claude" });
  if (inboundFirst) await f.relay.inbound(b);
  f.r.db.prepare("UPDATE messages SET retry_at = NULL WHERE message_id = ?").run(outbound.message_id);
  await f.relay.outbound();
  if (!inboundFirst) await f.relay.inbound(b);
  assert.ok(f.acknowledgements.has(hosted.id));
  const receipt = f.r.messageStatus(outbound.message_id);
  assert.equal(receipt.hosted_receipt_id, hosted.id);
  assert.equal(receipt.hosted_message_id, null);
  const received = f.r.receiveMessages(f.b).messages[0];
  assert.equal(received.hosted_message_id, hosted.id);
  assert.equal(received.hosted_receipt_id, null);
  assert.notEqual(received.message_id, outbound.message_id);
  // Redelivery deduplicates against the inbox row, never the sender's receipt.
  f.acknowledgements.delete(hosted.id);
  await f.relay.inbound(b);
  assert.equal(f.r.listMessages().length, 2);
  f.r.ackMessage({ ...f.b, message_id: received.message_id });
  const replyKey = randomUUID();
  const reply = await sendMessage(f.r, { ...f.b, to: a.agent_id, body: "Reviewed", reply_to: received.message_id, idempotency_key: replyKey }, { fetchImpl: f.fetchImpl });
  await f.relay.outbound();
  const hostedReply = f.sent.get(replyKey);
  assert.equal(hostedReply.reply_to, hosted.id);
  assert.equal(hostedReply.conversation_id, hosted.conversation_id);
  assert.equal(f.r.messageStatus(reply.message_id).hosted_receipt_id, hostedReply.id);
  f.inbox.push({ ...hostedReply, body: "Reviewed", sender_label: "Codex" });
  await f.relay.inbound(a);
  const receivedReply = f.r.receiveMessages(f.a).messages[0];
  assert.equal(receivedReply.reply_to, outbound.message_id);
  assert.equal(receivedReply.conversation_id, outbound.conversation_id);
});
