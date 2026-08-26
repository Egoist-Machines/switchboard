import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalTransport } from "../src/localTransport.js";
import { localFixture } from "./helpers.mjs";

test("local prefetch and propose use the discovered binary", async () => {
  const fixture = await localFixture();
  const transport = createLocalTransport({ ...fixture, timeoutMs: 500 });
  const read = await transport.prefetch({ categories: ["preference"] });
  assert.equal(read.status, "results");
  assert.equal(read.rows[0].content, "Prefers dark roast coffee");
  const proposal = await transport.propose({ content: "A memory", category: "fact", save_id: "save-1" });
  assert.deepEqual(proposal, {
    status: "recorded",
    proposal_id: "proposal-1",
    save_id: "save-1",
    disposition: "auto_approved",
  });
});

test("local handoff claim uses the discovered binary and preserves terminal outcomes", async () => {
  const fixture = await localFixture();
  const transport = createLocalTransport({ ...fixture, timeoutMs: 500 });
  const claimed = await transport.claimHandoff({ project: "/workspace/project" });
  assert.deepEqual(claimed, {
    status: "claimed",
    handoff_id: "handoff-1",
    snapshot: "Task hand-off",
    expires_at: "2026-08-25T12:00:00.000Z",
  });
  assert.deepEqual(await transport.claimHandoff({ fixture_behavior: "none" }), {
    status: "none_pending",
    handoff_id: null,
    snapshot: null,
    expires_at: null,
  });
});

test("the secret is sent on stdin and never appears in argv", async () => {
  const fixture = await localFixture({ secret: "never-in-argv" });
  const calls = [];
  const spawnImpl = (bin, args, options) => {
    calls.push({ bin, args, options });
    return spawn(bin, args, options);
  };
  const transport = createLocalTransport({ ...fixture, spawnImpl, timeoutMs: 500 });
  assert.equal((await transport.prefetch({ categories: ["fact"], fixture_behavior: "require_secret" })).status, "results");
  assert.deepEqual(calls[0].args, ["prefetch", "--json"]);
  assert.ok(!JSON.stringify(calls[0]).includes(fixture.secret));

  assert.equal((await transport.claimHandoff({ fixture_behavior: "require_secret" })).status, "claimed");
  assert.deepEqual(calls[1].args, ["handoff-claim", "--json"]);
  assert.ok(!JSON.stringify(calls[1]).includes(fixture.secret));
});

for (const scenario of [
  ["garbage stdout", { fixture_behavior: "garbage" }, "malformed_stdout"],
  ["deadline overrun", { fixture_behavior: "hang" }, "deadline_exceeded"],
  ["nonzero exit", { fixture_behavior: "nonzero" }, "nonzero_exit"],
]) {
  test(`${scenario[0]} returns unavailable and never throws`, async () => {
    const fixture = await localFixture();
    const transport = createLocalTransport({ ...fixture, timeoutMs: scenario[0] === "deadline overrun" ? 30 : 500 });
    const outcome = await transport.prefetch({ categories: ["fact"], ...scenario[1] });
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.internalReason, scenario[2]);
  });
}

test("a missing discovery record returns unavailable and never spawns", async () => {
  const fixture = await localFixture();
  let spawns = 0;
  const transport = createLocalTransport({
    discoveryPath: path.join(fixture.dir, "missing.json"),
    credentialsPath: fixture.credentialsPath,
    spawnImpl: () => {
      spawns += 1;
      throw new Error("must not spawn");
    },
  });
  const outcome = await transport.prefetch({ categories: ["fact"] });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.internalReason, "missing_local_state");
  assert.equal(spawns, 0);
});

test("a spawn failure returns unavailable and preserves proposal idempotency", async () => {
  const fixture = await localFixture();
  const transport = createLocalTransport({
    ...fixture,
    spawnImpl: () => {
      throw new Error("spawn failed");
    },
  });
  const outcome = await transport.propose({ content: "A memory", category: "fact", save_id: "save-retry" });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.save_id, "save-retry");
  assert.equal(outcome.internalReason, "spawn_failed");
});

test("unsafe credential permissions fail closed without spawning", async () => {
  const fixture = await localFixture();
  await chmod(fixture.credentialsPath, 0o644);
  let spawns = 0;
  const transport = createLocalTransport({
    ...fixture,
    spawnImpl: () => {
      spawns += 1;
      throw new Error("must not spawn");
    },
  });
  const outcome = await transport.prefetch({ categories: ["fact"] });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.internalReason, "unsafe_credentials_mode");
  assert.equal(spawns, 0);
});

test("a relative discovery bin is rejected instead of using PATH", async () => {
  const fixture = await localFixture();
  await writeFile(fixture.discoveryPath, `${JSON.stringify({ bin: "switchboard" })}\n`);
  const transport = createLocalTransport({ ...fixture });
  const outcome = await transport.prefetch({ categories: ["fact"] });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.internalReason, "invalid_discovery_record");
});

test("a row outside the requested category boundary is unavailable", async () => {
  const fixture = await localFixture();
  const transport = createLocalTransport({ ...fixture });
  const outcome = await transport.prefetch({ categories: ["fact"], fixture_category: "relationship" });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.internalReason, "invalid_contract");
});
