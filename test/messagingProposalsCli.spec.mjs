import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalRepository } from "../src/repository.js";
import { writeHostedLink } from "../src/hostedLink.js";
import { temporaryHome } from "./helpers.mjs";

const cli = new URL("../src/cli.js", import.meta.url).pathname;
test("owner and machine CLI proposal commands preserve fields and explain approval", async t => {
  const home = temporaryHome(t), r = new LocalRepository({ home });
  t.after(() => r.close());
  const client = r.addClient({ host: "claude-code", label: "Claude" });
  const sender = randomUUID(), peer = randomUUID(), proposal = randomUUID(), receipt = randomUUID();
  writeHostedLink(home, { base_url: "http://127.0.0.1:43210", device_id: "test-device", credential: `apsd_${"a".repeat(43)}`, status: "approved" });
  const preload = path.join(home, "fake-proposals.mjs");
  writeFileSync(preload, `
    import assert from "node:assert/strict";
    const sender = ${JSON.stringify(sender)}, peer = ${JSON.stringify(peer)}, proposalId = ${JSON.stringify(proposal)};
    globalThis.fetch = async (address, init) => {
      const url = new URL(address), route = url.pathname.split("/").at(-1);
      const body = init.body ? JSON.parse(init.body) : null;
      const proposal = { id: proposalId, kind: "create", state: "pending", proposer_agent_id: sender,
        agent_ids: [sender, peer], purpose: "Parser review", name: "Parser", duration_hours: 48,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), held_message_ids: [] };
      let result;
      if (route === "register") result = { agent: { ...body, id: sender } };
      else {
        assert.equal(body?.agent_id ?? url.searchParams.get("agent_id"), sender);
        if (route === "agents") result = { self: { id: sender }, agents: [{ id: peer, label: "Muse", shared_group_ids: [] }], groups: [], proposals: [] };
        else if (route === "send") {
          assert.equal(body.purpose, "Parser review");
          assert.equal(body.name, undefined);
          assert.equal(body.duration_hours, undefined);
          assert.equal(body.group_id, undefined);
          result = { id: ${JSON.stringify(receipt)}, state: "held", proposal_id: proposalId, sender_agent_id: sender, recipient_agent_id: peer, group_id: null, conversation_id: null };
        } else if (route === "proposals") {
          result = body ? { ...proposal, ...body } : { ...proposal, state: "approved" };
          if (body?.kind === "create") assert.deepEqual(body.agent_ids, [sender, peer]);
        } else throw new Error("Unexpected route: " + route);
      }
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    };
  `);
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, cli, ...args], { env: { ...process.env, SWITCHBOARD_HOME: home, HOME: path.dirname(home) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
  let result = await run(["message", "send", "--to", "Muse", "Review"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /purpose_required.*--purpose/);
  result = await run(["message-send", "--json"], { ...client, to: "Muse", body: "Review", idempotency_key: randomUUID() });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).error, "purpose_required");
  result = await run(["message", "send", "--to", "Muse", "--purpose", "Parser review", "Review"]);
  assert.equal(result.code, 0, result.stderr);
  let value = JSON.parse(result.stdout);
  assert.equal(value.state, "held"); assert.equal(value.proposal_id, proposal);
  assert.equal(value.hosted_receipt_id, receipt); assert.match(value.notice, /owner must approve.*Passport Inbox/);
  result = await run(["message", "propose", "--to", peer, "--purpose", "Parser review", "--name", "Parser", "--duration-hours", "48"]);
  assert.equal(result.code, 0, result.stderr); value = JSON.parse(result.stdout);
  assert.equal(value.id, proposal); assert.equal(value.duration_hours, 48); assert.equal(value.name, "Parser");
  assert.match(value.notice, /owner must approve/);
  result = await run(["message-propose", "--json"], { ...client, peer_agent_ids: [peer], purpose: "Parser review" });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).id, proposal);
  for (const [kind, field] of [["renew", "group_id"], ["continue", "conversation_id"]]) {
    const id = randomUUID();
    result = await run(["message-propose", "--json"], { ...client, kind, [field]: id });
    assert.equal(result.code, 0, result.stderr); value = JSON.parse(result.stdout);
    assert.equal(value.kind, kind); assert.equal(value[field], id);
  }
  const expiredGroup = randomUUID();
  result = await run(["message", "propose", "--kind", "renew", "--group-id", expiredGroup]);
  assert.equal(result.code, 2); assert.match(result.stderr, /Cannot determine.*--from <client_id>/);
  result = await run(["message", "propose", "--kind", "renew", "--group-id", expiredGroup, "--from", "unknown"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /--from must name an active local client_id/);
  result = await run(["message", "propose", "--kind", "renew", "--group-id", expiredGroup, "--from", client.client_id]);
  assert.equal(result.code, 0, result.stderr); value = JSON.parse(result.stdout);
  assert.equal(value.kind, "renew"); assert.equal(value.group_id, expiredGroup);
  assert.equal(value.proposer_agent_id, sender);
  result = await run(["message-proposal-status", "--json"], { ...client, proposal_id: proposal });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, "approved");
  result = await run(["message", "proposal-status", proposal]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, "approved");
  result = await run(["message", "list"]);
  assert.equal(JSON.parse(result.stdout)[0].state, "held");
});

test("owner and machine group CLI routes, sender selection, caps and presence", async t => {
  const home = temporaryHome(t), r = new LocalRepository({ home }); t.after(() => r.close());
  const a = r.addClient({ host: "claude-code", label: "Claude" });
  const b = r.addClient({ host: "codex", label: "Codex" });
  const c = r.addClient({ host: "cursor", label: "Cursor" });
  const ids = { [a.client_id]: randomUUID(), [b.client_id]: randomUUID(), [c.client_id]: randomUUID() };
  const group = randomUUID(), thread = randomUUID(), peer = randomUUID();
  writeHostedLink(home, { base_url: "http://127.0.0.1:43210", device_id: "test-device", credential: `apsd_${"a".repeat(43)}`, status: "approved" });
  const preload = path.join(home, "fake-groups.mjs");
  writeFileSync(preload, `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    const ids = ${JSON.stringify(ids)}, group = ${JSON.stringify(group)}, thread = ${JSON.stringify(thread)}, peer = ${JSON.stringify(peer)};
    const members = [ids[${JSON.stringify(a.client_id)}], ids[${JSON.stringify(b.client_id)}], peer];
    globalThis.fetch = async (address, init) => {
      const url = new URL(address), route = url.pathname.split("/").at(-1), body = init.body ? JSON.parse(init.body) : null;
      const agent = body?.agent_id ?? url.searchParams.get("agent_id");
      let result;
      if (route === "register") result = { agent: { ...body, id: ids[body.installation] } };
      else if (route === "agents") result = { self: { id: agent }, groups: [{ id: group, agent_ids: members }], proposals: [],
        agents: [{ id: peer, label: "Muse", presence_kind: "webhook", live: true },
          { id: members[0], label: "Claude", presence_kind: "events", live: true },
          { id: members[1], label: "Codex", presence_kind: null, live: false }] };
      else if (route === "send") {
        assert.equal(body.recipient_agent_id, undefined); assert.equal(body.group_id, group);
        assert.ok(members.includes(agent));
        if (process.env.GROUP_CAP === "1") return new Response(JSON.stringify({ error: "conversation_capped", retryable: false, conversation_id: thread }), { status: 409 });
        const post = randomUUID(), recipients = members.filter(id => id !== agent);
        result = { post_id: post, conversation_id: thread, conversation_kind: "group", group_id: group, sender_agent_id: agent,
          recipient_agent_ids: recipients, state: "queued", messages: recipients.map(recipient_agent_id => ({ id: randomUUID(), post_id: post, recipient_agent_id })) };
      } else throw new Error("Unexpected route");
      return new Response(JSON.stringify(result));
    };
  `);
  const run = (args, input, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, cli, ...args], { env: { ...process.env, SWITCHBOARD_HOME: home, HOME: path.dirname(home), ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
  const args = ["message", "send", "--group", group];
  let result = await run([...args, "Review"]);
  assert.equal(result.code, 0, result.stderr);
  const first = JSON.parse(result.stdout);
  assert.equal(first.to_kind, "group"); assert.equal(first.conversation_kind, "group");
  assert.ok([ids[a.client_id], ids[b.client_id]].includes(first.hosted_sender_id));
  for (const client of [a, b]) {
    result = await run([...args, "--from", client.client_id, "Review"]);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).hosted_sender_id, ids[client.client_id]);
  }
  result = await run([...args, "--from", c.client_id, "Review"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /group_unauthorized/);
  result = await run([...args, "--from", "unknown", "Review"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /--from must name an active local client_id/);
  result = await run(["message-send", "--json"], { ...a, group_id: group, body: "Review", idempotency_key: randomUUID() });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, "delivered");
  result = await run(["message-send", "--json"], { ...c, group_id: group, body: "Review", idempotency_key: randomUUID() });
  assert.equal(JSON.parse(result.stdout).error, "group_unauthorized");
  result = await run(["message", "send", "--conversation", thread, "--from", b.client_id, "Review"]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).hosted_conversation_id, thread);
  result = await run(["message", "send", "--conversation", randomUUID(), "Review"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /conversation_not_found/);
  result = await run([...args, "Review"], null, { GROUP_CAP: "1" });
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).last_error, "conversation_capped");
  assert.match(result.stderr, new RegExp(`switchboard message propose --kind continue --conversation-id ${thread}`));
  result = await run(["message-send", "--json"], { ...a, conversation_id: thread, body: "Review", idempotency_key: randomUUID() }, { GROUP_CAP: "1" });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).state, "expired");
  assert.ok(JSON.parse(result.stdout).notice.includes(thread));
  for (const [command, input] of [[["message", "agents"], null], [["message-agents", "--json"], a]]) {
    result = await run(command, input);
    assert.equal(result.code, 0, result.stderr);
    const agents = JSON.parse(result.stdout).agents;
    assert.equal(agents.find(a => a.presence_kind === "events").presence, "live through events");
    assert.equal(agents.find(a => a.presence_kind === "webhook").presence, "reachable through a wake webhook");
    assert.equal(agents.find(a => a.presence_kind === null).presence, "offline");
  }
});
