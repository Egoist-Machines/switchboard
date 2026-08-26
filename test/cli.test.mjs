import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { LocalRepository } from "../src/repository.js";
import { resolveProjectScope } from "../src/projectIdentity.js";
import { resolveSwitchboardHome } from "../src/storage.js";
import { temporaryHome } from "./helpers.mjs";

const cli = new URL("../src/cli.js", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("Switchboard home uses only the new override and ignores the removed override", () => {
  const removedHomeOverride = ["AI", "PASSPORT", "HOME"].join("_");
  assert.equal(resolveSwitchboardHome({ SWITCHBOARD_HOME: "/configured-switchboard" }), "/configured-switchboard");
  assert.equal(
    resolveSwitchboardHome({ [removedHomeOverride]: "/removed-home" }),
    path.join(os.homedir(), ".switchboard")
  );
});

function run(home, args, input = null) {
  return spawnSync(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, SWITCHBOARD_HOME: home },
    input: input == null ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
}

function runRaw(home, args, input = null) {
  return spawnSync(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, SWITCHBOARD_HOME: home },
    input: input == null ? undefined : input,
    encoding: "utf8",
  });
}

function projectCheckout(root, name, remote) {
  const directory = path.join(root, name);
  const commands = [
    ["init", "-q", directory],
    ["-C", directory, "config", "user.email", "test@example.com"],
    ["-C", directory, "config", "user.name", "Test"],
    ["-C", directory, "commit", "--allow-empty", "-qm", "initial"],
    ["-C", directory, "remote", "add", "origin", remote],
  ];
  for (const args of commands) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return directory;
}

test("version commands exit before opening the store", (t) => {
  const home = temporaryHome(t);
  writeFileSync(home, "not a directory");
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const result = run(home, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${packageJson.version}\n`);
    assert.equal(result.stderr, "");
  }
});

test("init is idempotent and creates private store and discovery files", (t) => {
  const home = temporaryHome(t);
  const first = run(home, ["init"]);
  const firstRecord = JSON.parse(readFileSync(path.join(home, "runtime.json"), "utf8"));
  const firstRepository = new LocalRepository({ home });
  const firstMetadata = firstRepository.metadata();
  firstRepository.close();
  const second = run(home, ["init"]);
  const secondRepository = new LocalRepository({ home });
  const secondMetadata = secondRepository.metadata();
  secondRepository.close();

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /kept automatically/);
  assert.match(first.stdout, /Nothing leaves this machine/);
  assert.deepEqual(secondMetadata, firstMetadata);
  assert.deepEqual({ ...firstRecord, bin: undefined }, { version: "0.1.0", home, transport: "cli", bin: undefined });
  assert.equal(path.isAbsolute(firstRecord.bin), true);
  assert.equal(existsSync(firstRecord.bin), true);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(home, "passport.db")).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(home, "runtime.json")).mode & 0o777, 0o600);
  const doctor = run(home, ["doctor"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.ok(Object.values(JSON.parse(doctor.stdout)).every(Boolean));
});

test("JSON stdio propose and prefetch work through the real CLI", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const client = repository.addClient({ host: "opencode", label: "OpenCode local" });
  repository.addGrant({ clientId: client.client_id, profile: "coding" });
  repository.close();

  const proposed = run(home, ["propose", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "stdio-save",
    category: "instruction",
    content: "Use exact-token tests for ERR_RUNTIME_42",
  });
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.deepEqual(Object.keys(JSON.parse(proposed.stdout)), ["status", "proposal_id", "save_id", "disposition"]);
  assert.equal(JSON.parse(proposed.stdout).disposition, "auto_approved");

  const prefetched = run(home, ["prefetch", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["instruction"],
    query: "ERR_RUNTIME_42",
  });
  assert.equal(prefetched.status, 0, prefetched.stderr);
  const outcome = JSON.parse(prefetched.stdout);
  assert.equal(outcome.status, "results");
  assert.equal(outcome.transport, "local");
  assert.equal(outcome.connectivity, "offline");
  assert.equal(outcome.rows[0].source, "OpenCode local");
  assert.deepEqual(Object.keys(outcome.rows[0]), [
    "memory_id", "content", "source", "created_at", "occurred_at", "category", "client_id",
    "evidence_basis", "record_kind", "verified_issuer", "verified_at",
  ]);

  let inspected = new LocalRepository({ home });
  assert.equal(inspected.receipts().length, 0, "ambient prefetch is side-effect-free");
  inspected.close();
  const explicit = run(home, ["prefetch", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["instruction"],
    ambient: false,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  inspected = new LocalRepository({ home });
  assert.equal(inspected.receipts().length, 1, "explicit recall writes a receipt");
  inspected.close();
});

test("explicit unresolved projects and caller-supplied scope fingerprints create no memory", (t) => {
  const root = temporaryHome(t);
  const home = path.join(root, "store");
  const checkout = path.join(root, "checkout");
  const missing = path.join(root, "missing");
  const repository = new LocalRepository({ home });
  const client = repository.addClient({ host: "codex", label: "Scoped CLI" });
  const beforeEvents = repository.events().length;
  repository.close();

  const unresolved = run(home, ["propose", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "missing-project",
    category: "fact",
    content: "Must not be stored.",
    project: missing,
  });
  assert.equal(unresolved.status, 2);

  const plain = path.join(root, "plain");
  writeFileSync(plain, "not a checkout");
  const nonGit = run(home, ["remember", "Must not be stored", "--category", "fact", "--project", plain]);
  assert.equal(nonGit.status, 2);

  const initialized = spawnSync("git", ["init", "-q", checkout], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const injected = run(home, ["propose", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "injected-scope",
    category: "fact",
    content: "Must not be stored either.",
    project: checkout,
    project_scope: "a".repeat(64),
  });
  assert.equal(injected.status, 2);

  const inspected = new LocalRepository({ home });
  assert.equal(inspected.events().length, beforeEvents);
  assert.equal(inspected.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);
  inspected.close();
});

test("real CLI project writes use one primary fingerprint and reads include local legacy fallbacks", (t) => {
  const root = temporaryHome(t);
  const home = path.join(root, "store");
  const repoA = projectCheckout(root, "repo-a", "https://example.test/Owner/RepoA.git");
  const repoB = projectCheckout(root, "repo-b", "https://example.test/Owner/RepoB.git");
  let repository = new LocalRepository({ home });
  const client = repository.addClient({ host: "codex", label: "Scoped CLI" });
  repository.addGrant({ clientId: client.client_id, profile: "coding" });
  repository.close();

  const legacy = run(home, ["remember", "Coriander albatross legacy context", "--category", "project", "--project", repoA]);
  assert.equal(legacy.status, 0, legacy.stderr);

  repository = new LocalRepository({ home });
  const legacyScope = resolveProjectScope(repository, repoA);
  repository.adoptOwnerScopeKey("a".repeat(64));
  const primaryScope = resolveProjectScope(repository, repoA);
  assert.notEqual(primaryScope, legacyScope);
  repository.close();

  const remembered = run(home, ["remember", "Zirconium narwhal primary context", "--category", "project", "--project", repoA]);
  assert.equal(remembered.status, 0, remembered.stderr);

  const inA = run(home, ["prefetch", "--json"], {
    client_id: client.client_id, client_secret: client.client_secret,
    categories: ["project"], query: "zirconium narwhal", project: repoA,
  });
  assert.equal(inA.status, 0, inA.stderr);
  assert.deepEqual(JSON.parse(inA.stdout).rows.map((row) => row.content), ["Zirconium narwhal primary context"]);

  const inB = run(home, ["prefetch", "--json"], {
    client_id: client.client_id, client_secret: client.client_secret,
    categories: ["project"], query: "zirconium narwhal", project: repoB,
  });
  assert.equal(inB.status, 0, inB.stderr);
  assert.deepEqual(JSON.parse(inB.stdout).rows, []);

  const recalled = run(home, ["recall", "--categories", "project", "--query", "coriander albatross", "--project", repoA]);
  assert.equal(recalled.status, 0, recalled.stderr);
  assert.match(recalled.stdout, /Coriander albatross legacy context/);

  repository = new LocalRepository({ home });
  const created = repository.events().filter((event) => event.op === "proposal_created").at(-1);
  assert.equal(created.payload.project_scope, primaryScope);
  assert.deepEqual(Object.keys(created.payload).filter((key) => key.startsWith("project_scope")), ["project_scope"]);
  assert.equal(repository.db.prepare("SELECT project_scope FROM memories WHERE proposal_id = ?")
    .get(created.entity_id).project_scope, primaryScope);
  repository.close();
});

test("JSON mode returns blocked as data and rejects malformed invocation", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const client = repository.addClient({ host: "claude-code", label: "Claude local" });
  repository.close();
  const blocked = run(home, ["prefetch", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["fact"],
  });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
  const malformed = run(home, ["propose", "--json"], "not-an-object");
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, "");

  const invalidSaveId = run(home, ["propose", "--json"], {
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "not a bounded opaque id",
    category: "fact",
    content: "This must not reach the event log",
  });
  assert.equal(invalidSaveId.status, 2);
  assert.equal(invalidSaveId.stdout, "");
  assert.equal(invalidSaveId.stderr, "save_id must match ^[A-Za-z0-9._-]{1,64}$\n");
  const inspected = new LocalRepository({ home });
  assert.equal(inspected.events().some((event) => event.save_id === "not a bounded opaque id"), false);
  inspected.close();
});

test("JSON mode returns unavailable when the local store cannot open", (t) => {
  const home = temporaryHome(t);
  writeFileSync(home, "not a directory");
  const input = {
    client_id: "client",
    client_secret: "secret",
    save_id: "unavailable-save",
    category: "fact",
    content: "This content must not be printed",
  };
  const outcome = run(home, ["propose", "--json"], input);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stderr, "Switchboard store is unavailable.\n");
  assert.deepEqual(JSON.parse(outcome.stdout), {
    status: "unavailable",
    proposal_id: null,
    save_id: "unavailable-save",
    disposition: "pending",
  });
  assert.ok(!outcome.stderr.includes(input.content));

  const handoff = run(home, ["handoff-claim", "--json"], {
    client_id: "client",
    client_secret: "secret",
  });
  assert.equal(handoff.status, 0);
  assert.equal(handoff.stderr, "Switchboard store is unavailable.\n");
  assert.deepEqual(JSON.parse(handoff.stdout), {
    status: "unavailable", handoff_id: null, snapshot: null, expires_at: null,
  });
});

test("status never contains saved memory text", (t) => {
  const home = temporaryHome(t);
  const sentinel = "STATUS_MUST_NOT_CONTAIN_THIS_SENTINEL";
  const remembered = run(home, ["remember", sentinel, "--category", "fact"]);
  assert.equal(remembered.status, 0, remembered.stderr);
  const status = run(home, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!status.stdout.includes(sentinel));
  assert.equal(JSON.parse(status.stdout).memory_counts.fact, 1);
});

test("client deletion is available through JSON stdin and enforces source ownership", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const source = repository.addClient({ host: "codex", label: "Source" });
  const other = repository.addClient({ host: "codex", label: "Other" });
  repository.propose({
    client_id: source.client_id,
    client_secret: source.client_secret,
    save_id: "delete-json",
    category: "fact",
    content: "Delete this through standard input",
  });
  const memoryId = repository.listMemories()[0].memory_id;
  repository.close();
  const refused = run(home, ["memory", "delete", "--json"], {
    client_id: other.client_id,
    client_secret: other.client_secret,
    memory_id: memoryId,
  });
  assert.equal(JSON.parse(refused.stdout).status, "refused");
  const deleted = run(home, ["memory", "delete", "--json"], {
    client_id: source.client_id,
    client_secret: source.client_secret,
    memory_id: memoryId,
  });
  assert.equal(JSON.parse(deleted.stdout).status, "deleted");
});

test("handoff owner commands read snapshots from stdin and list only content-free state", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const target = repository.addClient({ host: "codex", label: "Codex target" });
  repository.close();
  const sentinel = "CLI_HANDOFF_SNAPSHOT_MUST_STAY_OUT_OF_LIST";
  const created = runRaw(home, ["handoff", "create", "--to", target.client_id, "--expires", "2h"], sentinel);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).status, "created");
  const listed = run(home, ["handoff", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 1);
  assert.equal(listed.stdout.includes(sentinel), false);
});

test("three-host handoff E2E moves a Claude Stop snapshot to OpenCode session start once", (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const claude = repository.addClient({ host: "claude-code", label: "Claude Stop hook" });
  const opencode = repository.addClient({ host: "opencode", label: "OpenCode SessionStart" });
  const codex = repository.addClient({ host: "codex", label: "Codex control" });
  repository.addGrant({ clientId: opencode.client_id, profile: "coding" });
  repository.addGrant({ clientId: codex.client_id, profile: "coding" });
  repository.close();
  const snapshot = "Task: finish E2E. Plan: claim on session start. Constraint: preserve trust boundaries.";

  const stopped = run(home, ["handoff-create", "--json"], {
    client_id: claude.client_id,
    client_secret: claude.client_secret,
    snapshot,
    profile: "coding",
    project: "synthetic-three-host-project",
    expires: "24h",
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).status, "created");

  const wrongProject = run(home, ["handoff-claim", "--json"], {
    client_id: codex.client_id,
    client_secret: codex.client_secret,
    project: "different-project",
  });
  assert.equal(JSON.parse(wrongProject.stdout).status, "none_pending");
  const started = run(home, ["handoff-claim", "--json"], {
    client_id: opencode.client_id,
    client_secret: opencode.client_secret,
    project: "synthetic-three-host-project",
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, "claimed");
  assert.equal(JSON.parse(started.stdout).snapshot, snapshot);
  const replay = run(home, ["handoff-claim", "--json"], {
    client_id: opencode.client_id,
    client_secret: opencode.client_secret,
    project: "synthetic-three-host-project",
  });
  assert.equal(JSON.parse(replay.stdout).status, "none_pending");

  const inspected = new LocalRepository({ home });
  assert.equal(inspected.contentRecords().length, 0);
  assert.equal(inspected.listHandoffs().length, 0);
  assert.equal(inspected.db.prepare("SELECT status FROM handoffs").get().status, "claimed");
  inspected.close();
});

test("two CLI processes claiming behind one barrier serialize to claimed and none_pending", async (t) => {
  const home = temporaryHome(t);
  const repository = new LocalRepository({ home });
  const client = repository.addClient({ host: "opencode", label: "Concurrent claimant" });
  repository.createHandoff({ snapshot: "Only one process receives this", to_client_id: client.client_id }, { owner: true });
  repository.close();

  const input = JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret });
  const start = () => {
    const child = spawn(process.execPath, [cli.pathname, "handoff-claim", "--json"], {
      env: { ...process.env, SWITCHBOARD_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { child, finished };
  };
  const first = start();
  const second = start();
  await new Promise((resolve) => setImmediate(resolve));
  first.child.stdin.end(input);
  second.child.stdin.end(input);
  const results = await Promise.all([first.finished, second.finished]);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).status).sort(), ["claimed", "none_pending"]);

  const inspected = new LocalRepository({ home });
  assert.equal(inspected.handoffReceipts().length, 1);
  assert.equal(inspected.db.prepare("SELECT COUNT(*) AS count FROM deletion_fences").get().count, 1);
  assert.equal(inspected.db.prepare("SELECT COUNT(*) AS count FROM tombstones").get().count, 1);
  assert.equal(inspected.contentRecords().length, 0);
  inspected.close();
});
