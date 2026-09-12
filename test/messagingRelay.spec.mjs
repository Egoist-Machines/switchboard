import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { runClaudeChannel } from "../src/claudeChannel.js";
import test from "node:test";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRepository } from "../src/repository.js";
import { MessagingRelay, messageAgents, sendMessage, messagingLinkKey, approvedMessagingLink, messagingStatus, refreshMessagingStatus, proposeCollaboration, proposalStatus, ensureMessagingRelay } from "../src/messagingRelay.js";
import { receiveMessages, acquireLock, lockPath, LockBlockedError } from "../src/messaging.js";
import { writeHostedLink, forgetHostedLink } from "../src/hostedLink.js";
import { temporaryHome } from "./helpers.mjs";

async function fixture(t, { grouped = true, dropFirst = true, holdKind = null, cap = 3, sendError = null, excludedClients = [] } = {}) {
  const r = new LocalRepository({ home: temporaryHome(t) });
  t.after(() => r.close());
  const a = r.addClient({ host: "claude-code", label: "Claude" });
  const b = r.addClient({ host: "codex", label: "Codex" });
  const registrations = new Map(), seen = [], inbox = [], acknowledgements = new Set(), streams = new Map(), sent = new Map();
  const proposals = new Map(), threads = new Map();
  const members = () => [...registrations.values()].filter(a => !excludedClients.includes(a.installation)).map(a => a.id).concat(hosted.id);
  const hosted = { id: randomUUID(), label: "Muse", runtime: "muse", live: true, presence_kind: "webhook" };
  const groupId = randomUUID();
  let lostReply = !dropFirst;
  const proposalFor = (body, agentId) => {
    const kind = body.kind ?? holdKind ?? "create";
    const agentIds = body.agent_ids ?? [agentId, body.recipient_agent_id];
    const prior = [...proposals.values()].find(p => p.state === "pending" && p.kind === kind && p.agent_ids.join() === agentIds.join());
    if (prior) return { ...prior, replayed: true };
    const proposal = { id: randomUUID(), kind, state: "pending", proposer_agent_id: agentId,
      agent_ids: agentIds, purpose: body.purpose ?? "Existing collaboration", name: body.name ?? "Review",
      duration_hours: body.duration_hours ?? 168, project_boundary: body.project_boundary ?? null,
      group_id: body.group_id ?? null, conversation_id: body.conversation_id ?? null, held_message_ids: [],
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), decided_at: null };
    proposals.set(proposal.id, proposal);
    return proposal;
  };
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
        if (!registrations.has(body.installation)) registrations.set(body.installation, { ...body, id: randomUUID(), origin_kind: "device", live: body.installation === a.client_id, presence_kind: body.installation === a.client_id ? "events" : null });
        json({ agent: registrations.get(body.installation) }); return;
      }
      assert.ok([...registrations.values()].some(a => a.id === agentId), "device requests must name their agent");
      if (route === "agents") {
        const peers = [hosted, ...[...registrations.values()].filter(a => a.id !== agentId)];
        json({ self: [...registrations.values()].find(a => a.id === agentId),
          agents: peers.map(a => ({ ...a, shared_group_ids: grouped ? [groupId] : [] })),
          groups: grouped ? [{ id: groupId, name: "Review", purpose: "Review code", agent_ids: members(), expires_at: new Date(Date.now() + 86400000).toISOString() }] : [],
          proposals: [...proposals.values()].filter(p => p.agent_ids.includes(agentId)) });
      } else if (route === "proposals") {
        if (body) json(proposalFor(body, agentId));
        else {
          const proposal = proposals.get(url.searchParams.get("proposal_id"));
          json(proposal ?? { error: "proposal_not_found", retryable: false }, proposal ? 200 : 404);
        }
      } else if (route === "status") {
        const postId = url.searchParams.get("post_id");
        const message = [...sent.values()].find(m => postId ? m.post_id === postId && m.sender_agent_id === agentId : m.id === url.searchParams.get("message_id"));
        json(message ?? { error: "not_found", retryable: false }, message ? 200 : 404);
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
        if (sendError) { json(sendError, 409); return; }
        const thread = [...threads.values()].find(thread => thread.id === body.conversation_id);
        if (body.recipient_agent_id && thread) { json({ error: "conversation_unavailable", retryable: false }, 409); return; }
        const prior = sent.get(body.idempotency_key);
        if (!body.recipient_agent_id) {
          if (prior) { json({ ...prior, replayed: true }); return; }
          const group = body.group_id ?? thread?.group_id;
          if (!grouped || group !== groupId || !members().includes(agentId)) { json({ error: "group_unauthorized", retryable: false }, 403); return; }
          if (body.conversation_id && (!thread || thread.group_id !== group)) { json({ error: "conversation_unavailable", retryable: false }, 409); return; }
          let current = threads.get(group);
          if (!current) { current = { id: randomUUID(), group_id: group, posts: 0 }; threads.set(group, current); }
          if (body.reply_to && !inbox.some(m => m.id === body.reply_to && m.recipient_agent_id === agentId && m.conversation_id === current.id)) { json({ error: "invalid_reply", retryable: false }, 409); return; }
          if (current.posts >= cap) { json({ error: "conversation_capped", retryable: false, conversation_id: current.id }, 409); return; }
          const post = { post_id: randomUUID(), conversation_id: current.id, conversation_kind: "group", group_id: group,
            sender_agent_id: agentId, recipient_agent_ids: members().filter(id => id !== agentId), state: "queued",
            created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() };
          post.messages = post.recipient_agent_ids.map(recipient_agent_id => ({ id: randomUUID(), post_id: post.post_id,
            conversation_kind: "group", conversation_id: current.id, group_id: group, sender_agent_id: agentId, recipient_agent_id,
            reply_to: body.reply_to ?? null, state: "queued", created_at: post.created_at, expires_at: post.expires_at }));
          const sender = [...registrations.values()].find(a => a.id === agentId);
          inbox.push(...post.messages.map(m => ({ ...m, body: body.body, sender_label: sender.label })));
          current.posts++;
          sent.set(body.idempotency_key, post);
          if (!lostReply) { lostReply = true; res.destroy(); return; }
          json(post); return;
        }
        const message = prior ?? { id: randomUUID(), conversation_kind: "pair", post_id: null, sender_agent_id: agentId, recipient_agent_id: body.recipient_agent_id, group_id: body.group_id, conversation_id: body.conversation_id ?? randomUUID(), reply_to: body.reply_to ?? null, state: "queued", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), delivered_at: null, acknowledged_at: null, replied_at: null };
        if (!prior && (!grouped || holdKind)) {
          if (!grouped && !body.purpose) { json({ error: "purpose_required", retryable: false }, 400); return; }
          const proposal = proposalFor(body, agentId);
          message.state = "held"; message.proposal_id = proposal.id; message.group_id = null;
          proposal.held_message_ids.push(message.id);
        }
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
    const message = { id: randomUUID(), conversation_kind: "pair", post_id: null, conversation_id: randomUUID(), group_id: groupId, sender_agent_id: hosted.id, recipient_agent_id: registrations.get(a.client_id).id, reply_to: null, state: "delivered", body: "Please check the parser", sender_label: "Muse", source: "passport_peer", notice: "untrusted", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() };
    inbox.push(message); return message;
  };
  return { r, a, b, relay, fetchImpl, proposals, hosted, groupId, registrations, seen, inbox, acknowledgements, streams, sent, inbound, threads };
}

test("relay registers installations, merges approved peers, stores before ack and deduplicates", async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  assert.equal(registrations.length, 2);
  assert.equal(f.registrations.get(f.a.client_id).runtime, "claude_code");
  assert.equal(f.registrations.get(f.b.client_id).runtime, "codex");
  assert.match(f.registrations.get(f.a.client_id).label, /on test-machine$/);
  const agents = await messageAgents(f.r, f.a, { hostname: "test-machine", fetchImpl: f.fetchImpl });
  assert.deepEqual(agents.agents[0].shared_group_ids, [f.groupId]);
  assert.deepEqual(agents.proposals, []);
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

test("discovery caches registrations per client and link and refreshes changed labels and runtimes", async t => {
  const f = await fixture(t, { dropFirst: false });
  const calls = () => f.seen.filter(r => r.route === "register");
  await f.relay.peers();
  assert.equal(calls().length, 2);
  const rows = await f.relay.register();
  assert.deepEqual(rows, f.relay.registrations().map(({ client_id, agent_id, link_key }) => ({ client_id, agent_id, link_key })));
  await f.relay.peers();
  await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { hostname: "test-machine", fetchImpl: f.fetchImpl });
  assert.equal(calls().length, 2);
  f.relay.hostname = "renamed-machine";
  await f.relay.peers();
  assert.equal(calls().length, 4);
  assert.ok(calls().slice(-2).every(r => r.body.label.endsWith("on renamed-machine")));
  const c = f.r.addClient({ host: "opencode", label: "OpenCode" });
  await f.relay.peers();
  assert.equal(calls().length, 5); assert.equal(calls().at(-1).body.installation, c.client_id);
  f.r.db.prepare("UPDATE clients SET host='cursor' WHERE client_id=?").run(c.client_id);
  await f.relay.peers();
  assert.equal(calls().length, 6); assert.equal(calls().at(-1).body.runtime, "cursor");
  f.r.db.prepare("UPDATE clients SET label=? WHERE client_id=?").run("x".repeat(90), c.client_id);
  await f.relay.peers(); await f.relay.peers();
  assert.equal(calls().length, 7); assert.equal(calls().at(-1).body.label, "x".repeat(80));
  f.r.db.prepare("UPDATE messaging_agents SET link_key='old-link' WHERE client_id=?").run(c.client_id);
  await f.relay.peers();
  assert.equal(calls().length, 8); assert.equal(calls().at(-1).body.installation, c.client_id);
});

test("registration skips a client revoked during the request", async t => {
  const f = await fixture(t);
  const request = f.relay.request.bind(f.relay);
  t.mock.method(f.relay, "request", async (route, options) => {
    const result = await request(route, options);
    if (route === "register" && options.body.installation === f.a.client_id) f.r.revokeClient(f.a.client_id);
    return result;
  });
  const rows = await f.relay.register();
  assert.deepEqual(rows.map(r => r.client_id), [f.b.client_id]);
  assert.equal(f.r.db.prepare("SELECT 1 FROM messaging_agents WHERE client_id=?").get(f.a.client_id), undefined);
});

test("registration skips a cached client revoked while another registration is in flight", async t => {
  const f = await fixture(t);
  const rows = await f.relay.register();
  const [first, second] = rows;
  f.r.db.prepare("UPDATE messaging_agents SET label='old-label' WHERE client_id=?").run(first.client_id);
  const request = f.relay.request.bind(f.relay);
  t.mock.method(f.relay, "request", async (route, options) => {
    const result = await request(route, options);
    f.r.revokeClient(second.client_id);
    return result;
  });
  assert.deepEqual(await f.relay.register(), [first]);
  assert.equal(f.seen.filter(r => r.route === "register").length, 3);
});

test("relay forces registration at start and caches it on the next reconciliation", async t => {
  const f = await fixture(t);
  await f.relay.register();
  f.seen.length = 0;
  const controller = new AbortController();
  f.relay.signal = controller.signal;
  let now = Date.now(), passes = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(f.relay, "stream", async () => {});
  const register = t.mock.method(f.relay, "register");
  t.mock.method(f.relay, "outbound", async () => {
    if (++passes === 2) controller.abort();
    now += 21000;
  });
  assert.equal((await f.relay.run()).status, "stopped");
  assert.equal(register.mock.callCount(), 2);
  assert.deepEqual(register.mock.calls.map(c => c.arguments), [[{ force: true }], []]);
  assert.equal(f.seen.filter(r => r.route === "register").length, 2);
  assert.equal(f.seen.filter(r => r.route === "agents").length, 4);
});

for (const error of ["agent_not_found", "agent_revoked"]) test(`discovery ${error} forgets only the failed registration and retries registration next time`, async t => {
  const f = await fixture(t);
  await f.relay.peers();
  const row = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  const fetch = t.mock.method(f.relay, "fetch", async (url, init) => new URL(url).pathname.endsWith("/agents")
    ? new Response(JSON.stringify({ error }), { status: 404 }) : f.fetchImpl(url, init));
  await assert.rejects(f.relay.peers(f.a.client_id), new RegExp(error));
  assert.equal(f.relay.registrations().some(r => r.agent_id === row.agent_id), false);
  assert.equal(f.relay.registrations().length, 1);
  fetch.mock.restore();
  await f.relay.peers();
  const calls = f.seen.filter(r => r.route === "register");
  assert.equal(calls.length, 3); assert.equal(calls.at(-1).body.installation, f.a.client_id);
});

for (const route of ["receive", "ack", "status", "send", "proposals"]) for (const error of ["agent_not_found", "agent_revoked"]) test(`${route} ${error} clears registration and rethrows`, async t => {
  const f = await fixture(t, { dropFirst: false, grouped: false, holdKind: "create" });
  const held = await sendMessage(f.r, { ...f.a, to: f.hosted.id, body: "Review", purpose: "Review code", idempotency_key: randomUUID() }, { hostname: "test-machine", fetchImpl: f.fetchImpl });
  const row = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  f.inbound();
  if (["send", "proposals"].includes(route)) f.r.db.prepare("UPDATE messages SET state='pending' WHERE message_id=?").run(held.message_id);
  t.mock.method(f.relay, "fetch", async (url, init) => new URL(url).pathname.endsWith(`/${route}`)
    ? new Response(JSON.stringify({ error }), { status: 404 }) : f.fetchImpl(url, init));
  const action = ["receive", "ack"].includes(route) ? () => f.relay.inbound(row)
    : route === "status" ? () => f.relay.reconcileHeld(row) : () => f.relay.outbound();
  await assert.rejects(action(), new RegExp(error));
  assert.equal(f.relay.registrations().some(r => r.agent_id === row.agent_id), false);
  assert.equal(f.relay.registrations().length, 1);
});

test("send uses a 30 second timeout while discovery keeps the 10 second default", async t => {
  const f = await fixture(t, { dropFirst: false });
  const timeout = t.mock.method(AbortSignal, "timeout");
  const request = t.mock.method(MessagingRelay.prototype, "request");
  const row = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  assert.equal(row.state, "delivered");
  const calls = request.mock.calls;
  assert.equal(calls.filter(c => c.arguments[0] === "send").length, 1);
  for (const call of calls) assert.equal(call.arguments[1].timeoutMs, call.arguments[0] === "send" ? 30000 : undefined);
  assert.deepEqual(timeout.mock.calls.map(c => c.arguments[0]), calls.map(c => c.arguments[0] === "send" ? 30000 : 10000));
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
  const registration = f.relay.registrations().find(a => a.client_id === f.a.client_id);
  const link = approvedMessagingLink(f.r);
  const message = f.r.sendMessage({ ...f.a, to: f.hosted.id, body: "Review the parser", idempotency_key: randomUUID() }, {
    target: { kind: "hosted", ref: f.hosted.id, group_id: f.groupId, sender_id: registration.agent_id, link_key: messagingLinkKey(link) },
  });
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

function decide(f, receipt, state) {
  const message = [...f.sent.values()].find(m => m.id === receipt.hosted_receipt_id);
  message.state = state;
  if (state === "queued") message.group_id = f.groupId;
  Object.assign(f.proposals.get(message.proposal_id), { state: state === "queued" ? "approved" : state, decided_at: new Date().toISOString() });
  return message;
}

test("ungrouped discovery requires purpose, stores held receipt and durable options, and keeps local sends local", async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  const options = { fetchImpl: f.fetchImpl };
  const agents = await messageAgents(f.r, f.a, options);
  assert.deepEqual(agents.agents[0].shared_group_ids, []);
  assert.equal(agents.agents[0].id, f.hosted.id);
  assert.deepEqual(agents.groups, []);
  await assert.rejects(sendMessage(f.r, { ...f.a, to: "Muse", body: "Hello", idempotency_key: randomUUID() }, options), /purpose_required/);
  assert.equal(f.r.listMessages().length, 0);
  assert.equal(f.seen.filter(r => r.route === "send").length, 0);
  const input = { ...f.a, to: "Muse", body: "Review the parser", purpose: "Review parser changes", name: "Parser review", duration_hours: 48, idempotency_key: randomUUID() };
  const registration = f.relay.registrations().find(a => a.client_id === f.a.client_id);
  const pending = f.r.sendMessage({ ...input, to: f.hosted.id }, { target: {
    kind: "hosted", ref: f.hosted.id, group_id: null, sender_id: registration.agent_id,
    link_key: messagingLinkKey(approvedMessagingLink(f.r)),
  } });
  assert.equal(pending.state, "pending");
  // A fresh relay instance must read the options from the durable outbox.
  await new MessagingRelay(f.r, options).outbound();
  const held = f.r.messageStatus(pending.message_id);
  assert.equal(held.state, "held");
  assert.ok(held.proposal_id && held.hosted_receipt_id);
  assert.equal(held.hosted_group_id, null);
  assert.equal(held.send_options, undefined);
  const sent = f.seen.find(r => r.route === "send");
  assert.equal(sent.body.purpose, input.purpose);
  assert.equal(sent.body.name, input.name);
  assert.equal(sent.body.duration_hours, 48);
  assert.equal(sent.body.group_id, undefined);
  const replay = await sendMessage(f.r, input, options);
  assert.equal(replay.message_id, held.message_id);
  assert.match(replay.notice, /owner must approve.*Passport Inbox/);
  await assert.rejects(sendMessage(f.r, { ...input, purpose: "Different purpose" }, options), /idempotency_conflict/);
  const status = await refreshMessagingStatus(f.r, options);
  assert.equal(status.held[0].proposal_id, held.proposal_id);
  assert.equal(status.proposals[0].id, held.proposal_id);
  assert.equal(f.r.listMessages()[0].state, "held");
  assert.equal((await messageAgents(f.r, f.a, options)).proposals[0].id, held.proposal_id);
  const local = await sendMessage(f.r, { ...f.a, to: f.b.client_id, body: "Local review", idempotency_key: randomUUID() }, options);
  assert.equal(local.state, "pending"); assert.equal(local.proposal_id, null);
  assert.equal(f.sent.size, 1);
});

for (const state of ["queued", "denied", "expired"]) test(`sender events reconcile held messages after ${state}`, async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  const options = { fetchImpl: f.fetchImpl };
  const held = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review the parser", purpose: "Parser review", idempotency_key: randomUUID() }, options);
  assert.equal(held.state, "held");
  const registration = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  const controller = new AbortController();
  const running = f.relay.stream(registration, controller.signal);
  try {
    for (let i = 0; i < 100 && !f.streams.has(registration.agent_id); i++) await delay(10);
    const remote = decide(f, held, state);
    const stream = f.streams.get(registration.agent_id);
    assert.ok(stream);
    stream.write(`event: message\ndata: ${JSON.stringify({ message_id: remote.id, state })}\n\n`);
    for (let i = 0; i < 100 && f.r.messageStatus(held.message_id).state === "held"; i++) await delay(10);
    const result = f.r.messageStatus(held.message_id);
    assert.equal(result.state, state === "queued" ? "delivered" : "expired");
    assert.equal(result.last_error, state === "denied" ? "denied" : null);
    assert.equal(result.proposal_id, held.proposal_id);
    if (state === "queued") assert.equal(result.hosted_group_id, f.groupId);
    else assert.equal(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id=?").get(held.message_id), undefined);
    assert.ok(f.seen.some(r => r.route === "status" && r.agentId === registration.agent_id));
    await f.relay.reconcileHeld(registration);
    assert.equal(f.r.events().filter(e => e.entity_id === held.message_id && e.op === (state === "queued" ? "message_delivered" : "message_expired")).length, 1);
  } finally { controller.abort(); await running; }
});

test("held reconciliation recovers without an event, including after local receipt TTL", async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  const held = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review", purpose: "Parser review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  decide(f, held, "denied");
  f.r.db.prepare("UPDATE messages SET expires_at='2000-01-01' WHERE message_id=?").run(held.message_id);
  f.r.expireMessages();
  assert.equal(f.r.messageStatus(held.message_id).state, "held");
  assert.equal(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id=?").get(held.message_id), undefined);
  await f.relay.reconcileHeld(f.relay.registrations().find(r => r.client_id === f.a.client_id));
  assert.equal(f.r.messageStatus(held.message_id).last_error, "denied");
});

test("explicit create, renewal, continuation and status use the sending client's agent id", async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  const options = { fetchImpl: f.fetchImpl };
  const input = { ...f.b, peer_agent_ids: [f.hosted.id], purpose: "Review changes", name: "Review", project_boundary: "Parser", duration_hours: 72 };
  const proposal = await proposeCollaboration(f.r, input, options);
  assert.equal(proposal.kind, "create");
  assert.equal(proposal.state, "pending");
  assert.equal(proposal.duration_hours, 72);
  assert.match(proposal.notice, /owner must approve/);
  const sender = f.registrations.get(f.b.client_id).id;
  assert.deepEqual(proposal.agent_ids, [sender, f.hosted.id]);
  const post = f.seen.find(r => r.route === "proposals" && r.body);
  assert.equal(post.body.agent_id, sender);
  assert.equal(post.body.client_secret, undefined);
  assert.equal(post.body.project_boundary, "Parser");
  assert.equal((await proposeCollaboration(f.r, input, options)).replayed, true);
  const fetched = await proposalStatus(f.r, { ...f.b, proposal_id: proposal.id }, options);
  assert.equal(fetched.id, proposal.id);
  assert.equal(f.seen.at(-1).agentId, sender);
  await proposalStatus(f.r, { proposal_id: proposal.id }, { ...options, owner: true });
  assert.equal(f.seen.at(-1).agentId, sender);
  const ownerProposal = await proposeCollaboration(f.r, { to: f.registrations.get(f.a.client_id).id, purpose: "Review" }, { ...options, owner: true });
  assert.equal(ownerProposal.agent_ids.length, 2);
  assert.notEqual(ownerProposal.proposer_agent_id, f.registrations.get(f.a.client_id).id);
  const renew = await proposeCollaboration(f.r, { ...f.b, kind: "renew", group_id: f.groupId, duration_hours: 24 }, options);
  assert.equal(renew.group_id, f.groupId);
  const conversation = randomUUID();
  const continuation = await proposeCollaboration(f.r, { ...f.b, kind: "continue", conversation_id: conversation }, options);
  assert.equal(continuation.conversation_id, conversation);
  for (const duration_hours of [0, 721, 1.5]) await assert.rejects(proposeCollaboration(f.r, { ...input, duration_hours }, options), /invalid duration/);
  const calls = f.seen.length;
  f.r.revokeClient(f.b.client_id);
  await assert.rejects(proposalStatus(f.r, { ...f.b, proposal_id: proposal.id }, options), /authentication/);
  assert.equal(f.seen.length, calls);
});

for (const kind of ["renew", "continue"]) test(`grouped sends can be held for ${kind}`, async t => {
  const f = await fixture(t, { dropFirst: false, holdKind: kind });
  const held = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  assert.equal(held.state, "held");
  assert.equal(held.hosted_group_id, null);
  assert.equal(f.proposals.get(held.proposal_id).kind, kind);
  decide(f, held, "queued");
  await f.relay.reconcileHeld(f.relay.registrations().find(r => r.client_id === f.a.client_id));
  assert.equal(f.r.messageStatus(held.message_id).state, "delivered");
});


test("send returns a held receipt even with a running relay lock", async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  const release = acquireLock(lockPath(f.r.home)); t.after(release);
  const held = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review", purpose: "Parser review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  assert.equal(held.state, "held"); assert.ok(held.proposal_id);
  assert.match(held.notice, /owner must approve/);
  const sends = f.seen.filter(r => r.route === "send").length;
  await f.relay.outbound();
  assert.equal(f.seen.filter(r => r.route === "send").length, sends);
  f.r.revokeClient(f.a.client_id);
  assert.equal(f.r.messageStatus(held.message_id).state, "expired");
  assert.equal(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id=?").get(held.message_id), undefined);
});

for (const kind of ["renew", "continue"]) for (const state of ["denied", "expired"]) test(`lost grouped ${kind} response replays after proposal ${state}`, async t => {
  const f = await fixture(t, { holdKind: kind });
  const key = randomUUID();
  const pending = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review", idempotency_key: key }, { fetchImpl: f.fetchImpl });
  assert.equal(pending.state, "pending");
  assert.equal(pending.hosted_group_id, f.groupId);
  assert.equal(pending.hosted_receipt_id, null);
  const hosted = f.sent.get(key);
  assert.equal(hosted.state, "held");
  decide(f, { hosted_receipt_id: hosted.id }, state);
  assert.equal(hosted.group_id, null);
  f.r.db.prepare("UPDATE messages SET retry_at = NULL WHERE message_id = ?").run(pending.message_id);
  await f.relay.outbound();
  const result = f.r.messageStatus(pending.message_id);
  assert.equal(result.state, "expired");
  assert.equal(result.last_error, state === "denied" ? "denied" : null);
  assert.equal(result.hosted_receipt_id, hosted.id);
  assert.equal(result.proposal_id, hosted.proposal_id);
  assert.equal(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id = ?").get(pending.message_id), undefined);
  await f.relay.outbound();
  f.r.expireMessages();
  assert.equal(f.seen.filter(r => r.route === "send").length, 2);
  assert.equal(f.r.events().filter(e => e.entity_id === pending.message_id && e.op === "message_expired").length, 1);
});

for (const field of ["sender_agent_id", "recipient_agent_id", "id", "group_id", "proposal_id", "state"]) test(`terminal replay still validates ${field}`, async t => {
  const f = await fixture(t, { holdKind: "renew" });
  const key = randomUUID();
  const pending = await sendMessage(f.r, { ...f.a, to: "Muse", body: "Review", idempotency_key: key }, { fetchImpl: f.fetchImpl });
  const hosted = f.sent.get(key);
  decide(f, { hosted_receipt_id: hosted.id }, "denied");
  // A concurrently recorded receipt must also retain its identity on replay.
  if (field === "id") f.r.db.prepare("UPDATE messages SET hosted_receipt_id = ? WHERE message_id = ?").run(hosted.id, pending.message_id);
  hosted[field] = field === "state" ? "queued" : field === "proposal_id" ? null : randomUUID();
  f.r.db.prepare("UPDATE messages SET retry_at = NULL WHERE message_id = ?").run(pending.message_id);
  await f.relay.outbound();
  const result = f.r.messageStatus(pending.message_id);
  assert.equal(result.state, "pending");
  assert.equal(result.last_error, "invalid_response");
  assert.ok(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id = ?").get(pending.message_id));
  assert.equal(f.r.events().filter(e => e.entity_id === pending.message_id && e.op === "message_expired").length, 0);
});

for (const source of ["proposal", "outbound", "inbound"]) test(`owner renews an expired group using retained ${source} membership`, async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  await f.relay.register();
  const sender = f.registrations.get(f.b.client_id).id;
  const key = messagingLinkKey(approvedMessagingLink(f.r));
  if (source === "proposal") {
    f.relay.cacheProposal({ id: randomUUID(), kind: "create", state: "approved", group_id: f.groupId,
      proposer_agent_id: sender, agent_ids: [sender, f.hosted.id], decided_at: "2000-01-01" });
  } else if (source === "outbound") {
    const row = f.r.sendMessage({ ...f.b, to: f.hosted.id, body: "Review", idempotency_key: randomUUID() }, {
      target: { kind: "hosted", ref: f.hosted.id, group_id: f.groupId, sender_id: sender, link_key: key },
    });
    f.r.db.prepare("UPDATE messages SET expires_at = '2000-01-01' WHERE message_id = ?").run(row.message_id);
    f.r.expireMessages();
  } else {
    f.r.acceptHostedMessage(f.b.client_id, { ...f.inbound(), recipient_agent_id: sender }, key);
  }
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/proposals") && init.body) assert.equal(JSON.parse(init.body).agent_id, sender);
    return f.fetchImpl(url, init);
  };
  const proposal = await proposeCollaboration(f.r, { kind: "renew", group_id: f.groupId }, { owner: true, fetchImpl });
  assert.equal(proposal.proposer_agent_id, sender);
  assert.equal(proposal.group_id, f.groupId);
  assert.equal(f.seen.filter(r => r.route === "proposals" && r.body).length, 1);
});

test("owner renewal requires an explicit installation when membership is unknown or belongs to an old link", async t => {
  const f = await fixture(t, { grouped: false, dropFirst: false });
  await f.relay.register();
  const sender = f.registrations.get(f.b.client_id).id;
  const input = { kind: "renew", group_id: f.groupId };
  const options = { owner: true, fetchImpl: f.fetchImpl };
  await assert.rejects(proposeCollaboration(f.r, input, options), /Cannot determine.*--from <client_id>/);
  f.relay.cacheProposal({ id: randomUUID(), kind: "create", state: "approved", group_id: f.groupId, agent_ids: [sender, f.hosted.id] });
  f.r.db.prepare("UPDATE messaging_proposals SET link_key = 'old-link'").run();
  f.r.sendMessage({ ...f.b, to: f.hosted.id, body: "Review", idempotency_key: randomUUID() }, {
    target: { kind: "hosted", ref: f.hosted.id, group_id: f.groupId, sender_id: sender, link_key: "old-link" },
  });
  await assert.rejects(proposeCollaboration(f.r, input, options), /Cannot determine.*--from <client_id>/);
  await assert.rejects(proposeCollaboration(f.r, { ...input, client_id: "unknown" }, options), /--from must name an active local client_id/);
  assert.equal(f.seen.filter(r => r.route === "proposals" && r.body).length, 0);
  const proposal = await proposeCollaboration(f.r, { ...input, client_id: f.b.client_id }, options);
  assert.equal(proposal.proposer_agent_id, sender);
  f.r.revokeClient(f.b.client_id);
  await assert.rejects(proposeCollaboration(f.r, { ...input, client_id: f.b.client_id }, options), /--from must name an active local client_id/);
});

test("group posts fan out, thread replies omit recipients and link through copies", async t => {
  const f = await fixture(t, { dropFirst: false, cap: 10 });
  const options = { fetchImpl: f.fetchImpl };
  const input = { ...f.a, group_id: f.groupId, body: "Group review", idempotency_key: randomUUID() };
  const post = await sendMessage(f.r, input, options);
  assert.equal(post.to_kind, "group"); assert.equal(post.to_ref, f.groupId);
  assert.equal(post.conversation_kind, "group"); assert.ok(post.hosted_post_id);
  assert.equal(post.state, "delivered"); assert.equal(post.hosted_receipt_id, null);
  assert.equal(post.conversation_id, post.hosted_conversation_id);
  assert.equal(f.r.db.prepare("SELECT send_options FROM messages WHERE message_id=?").get(post.message_id).send_options, null);
  const copies = f.r.db.prepare("SELECT * FROM messaging_post_copies WHERE message_id=?").all(post.message_id);
  assert.equal(copies.length, 2); assert.equal(f.inbox.length, 2);
  assert.ok(copies.every(c => c.link_key === messagingLinkKey(approvedMessagingLink(f.r))));
  const submission = f.seen.find(r => r.route === "send").body;
  assert.equal(submission.recipient_agent_id, undefined); assert.equal(submission.group_id, f.groupId);
  assert.equal(submission.conversation_id, undefined);
  assert.equal((await sendMessage(f.r, input, options)).message_id, post.message_id);
  await assert.rejects(sendMessage(f.r, { ...input, body: "Different" }, options), /idempotency_conflict/);
  const a = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  const b = f.relay.registrations().find(r => r.client_id === f.b.client_id);
  const remote = await f.relay.request(`status?post_id=${post.hosted_post_id}`, { agentId: a.agent_id });
  assert.equal(remote.post_id, post.hosted_post_id); assert.equal(remote.body, undefined);
  await assert.rejects(f.relay.request(`status?post_id=${post.hosted_post_id}`, { agentId: b.agent_id }), /not_found/);
  assert.equal(f.r.postStatus(post.hosted_post_id, f.a).message_id, post.message_id);
  assert.throws(() => f.r.postStatus(post.hosted_post_id, f.b), /message_not_found/);
  await f.relay.inbound(b);
  const received = (await receiveMessages(f.r, f.b)).messages[0];
  assert.equal(received.conversation_kind, "group"); assert.equal(received.hosted_post_id, post.hosted_post_id);
  assert.equal(received.conversation_id, post.conversation_id);
  assert.match(received.envelope, /kind="group"/); assert.match(received.envelope, /reply reaches every member of the thread/);
  assert.equal(received.body, undefined);
  const replyInput = { ...f.b, reply_to: received.message_id, body: "Reviewed", idempotency_key: randomUUID() };
  const reply = await sendMessage(f.r, replyInput, options);
  assert.equal(reply.state, "delivered"); assert.equal(reply.reply_to, received.message_id);
  const replyBody = f.seen.filter(r => r.route === "send").at(-1).body;
  assert.equal(replyBody.recipient_agent_id, undefined); assert.equal(replyBody.reply_to, received.hosted_message_id);
  assert.equal(replyBody.conversation_id, post.hosted_conversation_id); assert.equal(replyBody.group_id, f.groupId);
  assert.equal(f.inbox.filter(m => m.post_id === reply.hosted_post_id).length, 2);
  await f.relay.inbound(a);
  const linked = (await receiveMessages(f.r, f.a)).messages[0];
  assert.equal(linked.reply_to, post.message_id); assert.equal(linked.conversation_id, post.conversation_id);
  for (const to of [received.from_ref, received.from_label, received.hosted_group_id]) {
    const result = await sendMessage(f.r, { ...replyInput, to, idempotency_key: randomUUID() }, options);
    assert.equal(result.to_kind, "group"); assert.equal(result.state, "delivered");
    assert.equal(f.seen.filter(r => r.route === "send").at(-1).body.recipient_agent_id, undefined);
  }
  await assert.rejects(sendMessage(f.r, { ...replyInput, to: "Unrelated", idempotency_key: randomUUID() }, options), /invalid message target/);
  await assert.rejects(sendMessage(f.r, { ...replyInput, ...f.a, idempotency_key: randomUUID() }, options), /invalid reply_to/);
  for (const field of ["purpose", "name", "duration_hours"]) {
    await assert.rejects(sendMessage(f.r, { ...replyInput, [field]: field === "duration_hours" ? 24 : "Review" }, options), new RegExp(`invalid ${field}`));
    await assert.rejects(sendMessage(f.r, { ...input, [field]: field === "duration_hours" ? 24 : "Review" }, options), new RegExp(`invalid ${field}`));
  }
  const continuation = await sendMessage(f.r, { ...f.b, conversation_id: post.hosted_conversation_id, body: "More review", idempotency_key: randomUUID() }, options);
  assert.equal(continuation.state, "delivered"); assert.equal(continuation.hosted_sender_id, b.agent_id);
  assert.equal(continuation.conversation_id, post.conversation_id);
  assert.equal(f.seen.filter(r => r.route === "send").at(-1).body.conversation_id, post.hosted_conversation_id);
  await assert.rejects(sendMessage(f.r, { ...f.a, conversation_id: randomUUID(), body: "Unknown", idempotency_key: randomUUID() }, options), /conversation_not_found/);
  await assert.rejects(f.relay.request("send", { agentId: a.agent_id, body: { recipient_agent_id: b.agent_id, conversation_id: post.hosted_conversation_id } }), /conversation_unavailable/);
  for (const value of [post, f.r.listMessages(), messagingStatus(f.r), f.r.events().filter(e => e.op.startsWith("message_"))]) assert.doesNotMatch(JSON.stringify(value), /Group review|Reviewed|More review/);
});

test("group selectors preserve the conversation and refuse a conflicting local group before discovery", async t => {
  const f = await fixture(t, { dropFirst: false });
  const options = { fetchImpl: f.fetchImpl }, conversation = randomUUID();
  f.threads.set(f.groupId, { id: conversation, group_id: f.groupId, posts: 0 });
  const input = { ...f.a, group_id: f.groupId, conversation_id: conversation, body: "Review", idempotency_key: randomUUID() };
  const post = await sendMessage(f.r, input, options);
  assert.equal(post.state, "delivered"); assert.equal(post.hosted_conversation_id, conversation);
  assert.equal(post.conversation_id, conversation); assert.equal(post.hosted_group_id, f.groupId);
  const body = f.seen.filter(r => r.route === "send").at(-1).body;
  assert.equal(body.group_id, f.groupId); assert.equal(body.conversation_id, conversation);
  assert.equal(body.recipient_agent_id, undefined);
  f.r.db.prepare("UPDATE messages SET hosted_group_id=? WHERE message_id=?").run(randomUUID(), post.message_id);
  const count = f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, requests = f.seen.length;
  await assert.rejects(sendMessage(f.r, { ...input, idempotency_key: randomUUID() }, options), /invalid conversation_id/);
  assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
  assert.equal(f.seen.length, requests);
  f.r.db.prepare("UPDATE messages SET link_key='old-link' WHERE message_id=?").run(post.message_id);
  const next = await sendMessage(f.r, { ...input, idempotency_key: randomUUID() }, options);
  assert.equal(next.state, "delivered"); assert.equal(next.hosted_conversation_id, conversation);
});

test("pair and local sends refuse group selectors before discovery or inserting a row", async t => {
  const f = await fixture(t, { dropFirst: false });
  const options = { fetchImpl: f.fetchImpl };
  const registrations = await f.relay.register();
  f.inbound();
  await f.relay.inbound(registrations.find(r => r.client_id === f.a.client_id));
  const parent = f.r.listMessages()[0];
  const count = f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, requests = f.seen.length;
  for (const field of ["group_id", "conversation_id"]) for (const route of [
    { to: f.hosted.id }, { to: f.hosted.label }, { to: f.b.client_id },
    { to: f.hosted.id, reply_to: parent.message_id }, { reply_to: parent.message_id },
  ]) {
    const input = { ...f.a, ...route, [field]: field === "group_id" ? f.groupId : randomUUID(), body: "Review", idempotency_key: randomUUID() };
    await assert.rejects(sendMessage(f.r, input, options), new RegExp(`invalid ${field}`));
    assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
    assert.equal(f.seen.length, requests);
  }
  for (const kind of ["client", "hosted"]) for (const field of ["group_id", "conversation_id"]) {
    const to = kind === "client" ? f.b.client_id : f.hosted.id;
    assert.throws(() => f.r.sendMessage({ ...f.a, to, [field]: randomUUID(), body: "Review", idempotency_key: randomUUID() },
      { target: { kind, ref: to } }), new RegExp(`invalid ${field}`));
    assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
  }
});

test("group response loss replays the same post and copies and repairs an early reply", async t => {
  const f = await fixture(t);
  const key = randomUUID();
  const pending = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: key }, { fetchImpl: f.fetchImpl });
  assert.equal(pending.state, "pending"); assert.ok(pending.retry_at);
  const hosted = f.sent.get(key), copy = hosted.messages.find(m => m.recipient_agent_id === f.hosted.id);
  const incoming = Object.assign(f.inbound(), { conversation_kind: "group", post_id: randomUUID(), conversation_id: hosted.conversation_id, reply_to: copy.id });
  const registration = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  await f.relay.inbound(registration);
  const early = f.r.db.prepare("SELECT * FROM messages WHERE hosted_message_id=?").get(incoming.id);
  assert.equal(early.reply_to, null); assert.equal(early.hosted_reply_to, copy.id);
  assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messaging_post_copies").get().n, 0);
  const unrelated = f.r.acceptHostedMessage(f.a.client_id, { ...incoming, id: randomUUID() }, "old-link");
  const other = f.relay.registrations().find(r => r.client_id === f.b.client_id);
  const wrongRecipient = f.r.acceptHostedMessage(f.b.client_id, { ...incoming, id: randomUUID(), recipient_agent_id: other.agent_id }, other.link_key);
  f.r.db.prepare("UPDATE messages SET retry_at=NULL WHERE message_id=?").run(pending.message_id);
  await f.relay.outbound();
  const post = f.r.messageStatus(pending.message_id);
  assert.equal(post.state, "delivered"); assert.equal(post.hosted_post_id, f.sent.get(key).post_id);
  assert.equal(f.inbox.length, 3); assert.equal(f.threads.get(f.groupId).posts, 1);
  assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messaging_post_copies").get().n, 2);
  const reply = f.r.messageStatus(early.message_id, f.a);
  assert.equal(reply.reply_to, post.message_id); assert.equal(reply.hosted_reply_to, copy.id);
  assert.equal(reply.conversation_id, post.conversation_id);
  assert.equal(f.r.messageStatus(unrelated.message_id).reply_to, null);
  assert.equal(f.r.messageStatus(wrongRecipient.message_id).reply_to, null);
});

test("group cap expires once and returns continuation guidance", async t => {
  const f = await fixture(t, { dropFirst: false, cap: 1 });
  const send = () => sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  const first = await send();
  const capped = await send();
  assert.equal(capped.state, "expired"); assert.equal(capped.last_error, "conversation_capped");
  assert.equal(capped.hosted_conversation_id, first.hosted_conversation_id);
  assert.match(capped.notice, new RegExp(`switchboard message propose --kind continue --conversation-id ${first.hosted_conversation_id}`));
  assert.match(capped.notice, /passport_propose_collaboration/);
  assert.equal(capped.attempts, 1); assert.equal(capped.retry_at, null);
  assert.equal(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id=?").get(capped.message_id), undefined);
  await f.relay.outbound(); await f.relay.outbound();
  assert.equal(f.seen.filter(r => r.route === "send" && r.body.idempotency_key === capped.idempotency_key).length, 1);
  assert.equal(f.r.events().filter(e => e.entity_id === capped.message_id && e.op === "message_expired").length, 1);
});

for (const [error, retryable] of [["group_unauthorized", false], ["purpose_required", false], ["rate_limited", true]]) test(`send ${error} ${retryable ? "retries" : "expires"}`, async t => {
  const f = await fixture(t, { dropFirst: false, sendError: { error, retryable } });
  const row = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  assert.equal(row.state, retryable ? "pending" : "expired"); assert.equal(row.last_error, error);
  assert.equal(Boolean(row.retry_at), retryable);
  assert.equal(Boolean(f.r.db.prepare("SELECT 1 FROM content_records WHERE entity_id=?").get(row.message_id)), retryable);
  f.r.db.prepare("UPDATE messages SET retry_at=NULL WHERE message_id=?").run(row.message_id);
  await f.relay.outbound();
  assert.equal(f.seen.filter(r => r.route === "send").length, retryable ? 2 : 1);
});

test("presence labels retain events, webhook and offline fields for owner and machine discovery", async t => {
  const f = await fixture(t, { dropFirst: false });
  for (const input of [null, f.b]) {
    const discovery = await messageAgents(f.r, input, { fetchImpl: f.fetchImpl });
    for (const agent of discovery.agents) {
      assert.equal(agent.presence, agent.presence_kind === "events" ? "live through events" : agent.presence_kind === "webhook" ? "reachable through a wake webhook" : "offline");
      assert.equal(agent.live, agent.presence_kind !== null);
    }
    assert.ok(discovery.agents.some(a => a.presence_kind === "webhook"));
    assert.ok(discovery.agents.some(a => a.presence_kind === "events"));
    if (!input) assert.ok(discovery.agents.some(a => a.presence_kind === null));
  }
});

for (const invalid of [{ conversation_kind: "other" }, { conversation_kind: null }, { conversation_kind: "group", post_id: null }, { conversation_kind: "group", post_id: randomUUID(), group_id: "bad" }]) test(`invalid inbound group metadata is never acknowledged: ${JSON.stringify(invalid)}`, async t => {
  const f = await fixture(t);
  const registrations = await f.relay.register();
  const message = Object.assign(f.inbound(), invalid);
  await assert.rejects(f.relay.inbound(registrations.find(r => r.client_id === f.a.client_id)), /invalid_response/);
  assert.equal(f.acknowledgements.has(message.id), false);
  assert.equal(f.r.listMessages().length, 0);
});

test("hosted reply metadata accepts UUIDs or null and refuses malformed parents before storing", async t => {
  const f = await fixture(t);
  await f.relay.register();
  const registration = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  for (const conversation_kind of ["pair", "group"]) {
    const message = { ...f.inbound(), conversation_kind, post_id: conversation_kind === "group" ? randomUUID() : null };
    for (const reply_to of ["", "bad", 1, {}]) {
      const count = f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n;
      assert.throws(() => f.r.acceptHostedMessage(f.a.client_id, { ...message, reply_to }, registration.link_key), /invalid reply_to/);
      assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messages").get().n, count);
    }
    for (const reply_to of [undefined, null, randomUUID()]) {
      const row = f.r.acceptHostedMessage(f.a.client_id, { ...message, id: randomUUID(), reply_to }, registration.link_key);
      assert.equal(f.r.messageStatus(row.message_id).hosted_reply_to, reply_to ?? null);
    }
  }
});

for (const field of ["post_id", "conversation_kind", "sender_agent_id", "group_id", "conversation_id", "state", "recipient_agent_ids", "messages", "copy_id", "copy_post", "copy_recipient", "missing_copy", "duplicate_copy_id", "duplicate_copy_recipient", "duplicate_recipient", "null_response"]) test(`group receipt validates ${field}`, async t => {
  const f = await fixture(t, { dropFirst: false });
  const fetchImpl = async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (!url.endsWith("/send")) return response;
    const post = await response.json();
    if (field === "null_response") return new Response("null");
    if (field === "copy_id") post.messages[0].id = "bad";
    else if (field === "copy_post") post.messages[0].post_id = randomUUID();
    else if (field === "copy_recipient") post.messages[0].recipient_agent_id = randomUUID();
    else if (field === "missing_copy") post.messages.pop();
    else if (field === "duplicate_copy_id") post.messages[1].id = post.messages[0].id;
    else if (field === "duplicate_copy_recipient") post.messages[1].recipient_agent_id = post.messages[0].recipient_agent_id;
    else if (field === "duplicate_recipient") post.recipient_agent_ids[1] = post.recipient_agent_ids[0];
    else post[field] = field === "state" ? "uploading" : field === "sender_agent_id" || field === "group_id" ? randomUUID() : null;
    return new Response(JSON.stringify(post));
  };
  const row = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl });
  assert.equal(row.state, "pending"); assert.equal(row.last_error, "invalid_response"); assert.ok(row.retry_at);
  assert.equal(f.r.db.prepare("SELECT count(*) AS n FROM messaging_post_copies").get().n, 0);
});

test("Claude channel group notifications, post status and cap guidance", async t => {
  const f = await fixture(t, { dropFirst: false, cap: 2 });
  const options = { fetchImpl: f.fetchImpl };
  const own = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "First review", idempotency_key: randomUUID() }, options);
  const other = await sendMessage(f.r, { ...f.b, group_id: f.groupId, body: "Second review", idempotency_key: randomUUID() }, options);
  await f.relay.inbound(f.relay.registrations().find(r => r.client_id === f.a.client_id));
  t.mock.method(globalThis, "fetch", f.fetchImpl);
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => text += chunk);
  const running = runClaudeChannel({ repository: f.r, credentials: f.a, input, output, autoStart: false });
  const write = (id, method, params) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  write(1, "initialize", {}); write(null, "notifications/initialized");
  write(2, "tools/call", { name: "passport_message_status", arguments: { post_id: own.hosted_post_id } });
  write(3, "tools/call", { name: "passport_message_status", arguments: { post_id: other.hosted_post_id } });
  write(4, "tools/call", { name: "passport_message_status", arguments: { message_id: own.message_id, post_id: own.hosted_post_id } });
  write(5, "tools/call", { name: "passport_message_status", arguments: {} });
  write(6, "tools/call", { name: "passport_send_message", arguments: { group_id: f.groupId, body: "Capped review", idempotency_key: randomUUID() } });
  for (let i = 0; i < 100 && (!text.includes('"id":6') || !text.includes("notifications/claude/channel")); i++) await delay(20);
  input.end(); await running;
  const values = text.trim().split("\n").map(JSON.parse);
  assert.equal(values.find(v => v.id === 1).result.serverInfo.version, "0.3.1");
  assert.match(values.find(v => v.id === 1).result.instructions, /whole thread/);
  assert.equal(JSON.parse(values.find(v => v.id === 2).result.content[0].text).message_id, own.message_id);
  for (const id of [3, 4, 5]) assert.equal(values.find(v => v.id === id).result.isError, true);
  assert.match(values.find(v => v.id === 6).result.content[0].text, /switchboard message propose --kind continue --conversation-id/);
  const notification = values.find(v => v.method === "notifications/claude/channel");
  assert.equal(notification.params.meta.conversation_kind, "group");
  assert.equal(notification.params.meta.post_id, other.hosted_post_id);
  assert.ok(Object.values(notification.params.meta).every(v => typeof v === "string"));
  assert.match(notification.params.content, /kind="group"/);
});

test("hosted peer replies link only to posts from the receiving installation and link", async t => {
  const f = await fixture(t, { dropFirst: false });
  const post = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  const copy = f.sent.values().next().value.messages.find(m => m.recipient_agent_id === f.hosted.id);
  const a = f.relay.registrations().find(r => r.client_id === f.a.client_id);
  const b = f.relay.registrations().find(r => r.client_id === f.b.client_id);
  for (const [registration, link] of [[a, a.link_key], [b, b.link_key], [a, "old-link"]]) {
    const incoming = { ...f.inbound(), conversation_kind: "group", post_id: randomUUID(), conversation_id: post.hosted_conversation_id,
      reply_to: copy.id, recipient_agent_id: registration.agent_id };
    const row = f.r.acceptHostedMessage(registration.client_id, incoming, link);
    assert.equal(row.reply_to, registration === a && link === a.link_key ? post.message_id : null);
    assert.equal(row.conversation_id, post.conversation_id);
  }
});

test("group sender membership, continuation identity and idempotency stay scoped", async t => {
  const excludedClients = [];
  const f = await fixture(t, { dropFirst: false, excludedClients });
  const options = { fetchImpl: f.fetchImpl }, owner = { ...options, owner: true };
  excludedClients.push(f.a.client_id);
  const input = { group_id: f.groupId, body: "Review", idempotency_key: randomUUID() };
  await assert.rejects(sendMessage(f.r, { ...input, ...f.a }, options), /group_unauthorized/);
  await assert.rejects(sendMessage(f.r, { ...input, client_id: f.a.client_id }, owner), /group_unauthorized/);
  const post = await sendMessage(f.r, input, owner);
  assert.equal(post.hosted_sender_id, f.registrations.get(f.b.client_id).id);
  await assert.rejects(sendMessage(f.r, { ...f.a, conversation_id: post.hosted_conversation_id, body: "Review", idempotency_key: randomUUID() }, options), /conversation_not_found/);
  excludedClients.length = 0;
  await assert.rejects(sendMessage(f.r, { ...input, client_id: f.a.client_id }, owner), /idempotency_conflict/);
  const continued = { ...f.b, conversation_id: post.hosted_conversation_id, body: "Continue", idempotency_key: randomUUID() };
  const result = await sendMessage(f.r, continued, options);
  assert.equal(result.state, "delivered");
  assert.equal((await sendMessage(f.r, continued, options)).replayed, true);
  const another = randomUUID();
  f.r.db.prepare("UPDATE messages SET hosted_conversation_id=? WHERE message_id=?").run(another, post.message_id);
  await assert.rejects(sendMessage(f.r, { ...continued, conversation_id: another }, options), /idempotency_conflict/);
  excludedClients.push(f.a.client_id, f.b.client_id);
  await assert.rejects(sendMessage(f.r, { ...input, idempotency_key: randomUUID() }, owner), /Cannot determine.*--from <client_id>/);
});

test("continuation refuses a different receipt thread and invalid cap details", async t => {
  const f = await fixture(t, { dropFirst: false });
  const first = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: f.fetchImpl });
  const fetchImpl = async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (!url.endsWith("/send")) return response;
    return new Response(JSON.stringify({ ...await response.json(), conversation_id: randomUUID() }));
  };
  const continued = await sendMessage(f.r, { ...f.a, conversation_id: first.hosted_conversation_id, body: "Continue", idempotency_key: randomUUID() }, { fetchImpl });
  assert.equal(continued.state, "pending"); assert.equal(continued.last_error, "invalid_response");
  const invalidCap = async (url, init) => url.endsWith("/send")
    ? new Response(JSON.stringify({ error: "conversation_capped", retryable: false, conversation_id: "bad" }), { status: 409 })
    : f.fetchImpl(url, init);
  const capped = await sendMessage(f.r, { ...f.a, group_id: f.groupId, body: "Review", idempotency_key: randomUUID() }, { fetchImpl: invalidCap });
  assert.equal(capped.state, "pending"); assert.equal(capped.last_error, "invalid_response");
  assert.equal(capped.hosted_conversation_id, null);
});
