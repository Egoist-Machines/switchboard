import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMessagingDelivery } from "../src/messaging.js";
import { createPassportHooks, AMBIENT_HOOK } from "../src/plugin.js";
import { fakeTool, fakeStatus } from "./helpers.mjs";

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
