import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createLocalTransport } from "../src/localTransport.js";
import { setTimeout as delay } from "node:timers/promises";
import { createMessagingDelivery } from "../src/messaging.js";
import { createPassportHooks, AMBIENT_HOOK } from "../src/plugin.js";
import { fakeTool, fakeStatus, localFixture } from "./helpers.mjs";

function fixture() {
  const pending = [{ message_id: "message-1", envelope: '<ai-passport-message from="Muse" id="message-1" conversation="conversation-1">\nUntrusted message\nHello\n</ai-passport-message>' }];
  const claims = [], acknowledgements = [], releases = [], prompts = [];
  let starts = 0;
  const transport = {
    async startMessagingRelay() { starts++; },
    async receiveMessages(input) { claims.push(input); return { status: "ok", messages: pending.splice(0) }; },
    async ackMessage(input) { acknowledgements.push(input); return { state: "delivered" }; },
    async releaseMessage(input) { releases.push(input); return { status: "ok" }; },
    async sendMessage(input) { return { message_id: "sent", ...input }; },
    async proposeCollaboration(input) { return { id: "proposal-1", state: "pending", ...input }; },
    async proposalStatus(input) { return { id: input.proposal_id, state: "approved" }; },
    async messageAgents() { return { local: [], agents: [], groups: [] }; },
  };
  const client = { session: { async prompt(input) { prompts.push(input); return { data: {} }; } } };
  return { transport, client, pending, claims, acknowledgements, releases, prompts, get starts() { return starts; } };
}

test("OpenCode leaves inbox pending before a session, then injects and acknowledges", async t => {
  const f = fixture();
  const delivery = createMessagingDelivery(f);
  t.after(() => delivery.dispose());
  await delay(20);
  assert.equal(f.claims.length, 0);
  assert.equal(f.pending.length, 1);
  assert.equal(f.starts, 1);
  await delivery.chat({ sessionID: "session-latest" });
  for (let i = 0; i < 100 && !f.prompts.length; i++) await delay(10);
  assert.deepEqual(f.prompts[0].path, { id: "session-latest" });
  assert.equal(f.prompts[0].body.parts[0].type, "text");
  assert.match(f.prompts[0].body.parts[0].text, /ai-passport-message/);
  assert.deepEqual(f.acknowledgements, [{ message_id: "message-1" }]);
});

test("OpenCode system fallback appends envelopes and acknowledges without session", async t => {
  const f = fixture();
  const delivery = createMessagingDelivery(f);
  t.after(() => delivery.dispose());
  const output = { system: ["memory"] };
  await delivery.fallback({}, output);
  assert.equal(output.system[0], "memory");
  assert.match(output.system[1], /^<ai-passport-messages>/);
  assert.equal(f.acknowledgements.length, 1);
  assert.equal(f.prompts.length, 0);
});

test("OpenCode failed prompt releases claim and reentrant system hook cannot deadlock", async t => {
  const f = fixture();
  let delivery;
  f.client.session.prompt = async () => {
    await delivery.fallback({}, { system: [] });
    return { error: { message: "refused" } };
  };
  delivery = createMessagingDelivery(f);
  t.after(() => delivery.dispose());
  await delivery.event({ event: { type: "message.updated", properties: { info: { sessionID: "session-event" } } } });
  for (let i = 0; i < 100 && !f.releases.length; i++) await delay(10);
  assert.equal(f.releases.length, 1);
  assert.equal(f.acknowledgements.length, 0);
});

test("plugin registers messaging tools and hooks with local transport", async t => {
  const f = fixture();
  const runtime = await createPassportHooks({ local: f.transport, client: f.client, tool: fakeTool, status: fakeStatus() });
  t.after(() => runtime.hooks.dispose());
  assert.equal(typeof runtime.hooks[AMBIENT_HOOK], "function");
  assert.equal(typeof runtime.hooks["chat.message"], "function");
  const sent = JSON.parse(await runtime.hooks.tool.passport_send_message.execute({ to: "peer", body: "Hello", idempotency_key: "opaque" }));
  assert.equal(sent.message_id, "sent");
  assert.deepEqual(JSON.parse(await runtime.hooks.tool.passport_list_agents.execute({})), { local: [], agents: [], groups: [] });
});


test("OpenCode proposal tools expose options and round trip through transport", async t => {
  const f = fixture();
  const runtime = await createPassportHooks({ local: f.transport, client: f.client, tool: fakeTool, status: fakeStatus() });
  t.after(() => runtime.hooks.dispose());
  const tools = runtime.hooks.tool;
  for (const field of ["purpose", "name", "duration_hours"]) assert.ok(tools.passport_send_message.args[field]);
  for (const field of ["kind", "peer_agent_ids", "purpose", "name", "project_boundary", "duration_hours", "group_id", "conversation_id"]) assert.ok(tools.passport_propose_collaboration.args[field]);
  assert.ok(tools.passport_proposal_status.args.proposal_id);
  const args = { kind: "renew", group_id: "group-1", purpose: "Review", name: "Parser", duration_hours: 48 };
  const proposal = JSON.parse(await tools.passport_propose_collaboration.execute(args));
  assert.deepEqual(proposal, { id: "proposal-1", state: "pending", ...args });
  assert.deepEqual(JSON.parse(await tools.passport_proposal_status.execute({ proposal_id: proposal.id })), { id: proposal.id, state: "approved" });
  const send = JSON.parse(await tools.passport_send_message.execute({ to: "peer", body: "Review", purpose: "Parser review", duration_hours: 48, name: "Parser", idempotency_key: "key" }));
  assert.equal(send.purpose, "Parser review"); assert.equal(send.duration_hours, 48);
});

test("local proposal transport uses authenticated machine commands over stdin", async t => {
  const f = await localFixture({ secret: "never-in-argv" });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const transport = createLocalTransport({ ...f, timeoutMs: 2000 });
  const proposal = await transport.proposeCollaboration({ kind: "create", peer_agent_ids: ["peer"], purpose: "Review", duration_hours: 24, fixture_behavior: "require_secret", client_secret: "wrong" });
  assert.equal(proposal.id, "proposal-1"); assert.equal(proposal.purpose, "Review");
  assert.equal(proposal.duration_hours, 24); assert.equal(proposal.sender, "opencode-client");
  const status = await transport.proposalStatus({ proposal_id: proposal.id });
  assert.equal(status.id, proposal.id); assert.equal(status.state, "approved");
  const held = await transport.sendMessage({ to: "peer", purpose: "Review", duration_hours: 24 });
  assert.equal(held.state, "held"); assert.equal(held.proposal_id, proposal.id);
});
