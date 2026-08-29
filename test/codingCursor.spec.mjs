import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { discoverCodingHosts } from "../src/coding.js";
import { LocalRepository } from "../src/repository.js";
import { resolveProjectScope } from "../src/projectIdentity.js";

const cli = new URL("../src/cli.js", import.meta.url);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "switchboard-cursor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerHome = path.join(root, "home");
  const switchboardHome = path.join(ownerHome, ".switchboard");
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  for (const directory of [ownerHome, project, bin]) mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    HOME: ownerHome,
    XDG_CONFIG_HOME: path.join(ownerHome, ".config"),
    SWITCHBOARD_HOME: switchboardHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const run = (args, input = null, envOverrides = {}, options = {}) => spawnSync(process.execPath, [cli.pathname, ...args], {
    cwd: options.cwd,
    env: { ...env, ...envOverrides },
    input: input == null ? undefined : typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { root, ownerHome, switchboardHome, project, bin, env, run };
}

function hostStub(directory, name) {
  const target = path.join(directory, name);
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(target, 0o755);
}

function cursorConfigPath(setup) {
  return path.join(setup.ownerHome, ".cursor", "hooks.json");
}

function cursorCredentialsPath(setup) {
  return path.join(setup.ownerHome, ".local", "share", "switchboard", "cursor-credentials.json");
}

function stateFor(setup) {
  return JSON.parse(readFileSync(path.join(setup.switchboardHome, "coding-installations", "cursor.json"), "utf8"));
}

function sessionStart(project) {
  return {
    conversation_id: "conversation-1",
    generation_id: "generation-1",
    model: "default",
    is_background_agent: false,
    session_id: "session-1",
    hook_event_name: "sessionStart",
    cursor_version: "2026.08.25-3e8eec8",
    workspace_roots: project ? [project] : [],
    user_email: "owner@example.test",
    transcript_path: null,
  };
}

test("cursor discovery uses its path stub and user directory", (t) => {
  const setup = fixture(t);
  assert.equal(discoverCodingHosts({ project: setup.project, env: { ...setup.env, PATH: setup.bin } }).cursor, false);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(discoverCodingHosts({ project: setup.project, env: { ...setup.env, PATH: setup.bin } }).cursor, true);
  rmSync(path.join(setup.bin, "cursor-agent"));
  mkdirSync(path.join(setup.ownerHome, ".cursor"));
  assert.equal(discoverCodingHosts({ project: setup.project, env: { ...setup.env, PATH: setup.bin } }).cursor, true);
});

test("cursor installs, verifies, reruns, reports status, and uninstalls", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(setup.run(["init"]).status, 0);

  const installed = setup.run(["coding", "install", "--targets", "cursor", "--project", setup.project]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /verification: passed_empty/);
  assert.doesNotMatch(installed.stdout, / --project /);

  const configPath = cursorConfigPath(setup);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const expectedEntry = { command: `'${cli.pathname}' hook cursor-prefetch`, timeout: 2 };
  assert.deepEqual(config, { version: 1, hooks: { sessionStart: [expectedEntry] } });
  const state = stateFor(setup);
  assert.equal(state.scopes.length, 1);
  assert.equal(Buffer.from(state.scopes[0].entry_b64, "base64").toString("utf8"), JSON.stringify(expectedEntry));
  assert.equal(state.scopes[0].last_verification, "passed_empty");
  const credentials = cursorCredentialsPath(setup);
  assert.equal(statSync(credentials).mode & 0o777, 0o600);

  const rerun = setup.run(["coding", "install", "--targets", "cursor", "--project", setup.project]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).hooks.sessionStart.length, 1);
  const status = setup.run(["coding", "status", "--project", setup.project]);
  assert.match(status.stdout, /cursor: installed=yes .*config=present verification=passed_empty/);

  const clientId = state.client_id;
  const uninstalled = setup.run(["coding", "uninstall", "--target", "cursor", "--project", setup.project]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {});
  assert.equal(existsSync(credentials), false);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(repository.listClients().find((client) => client.client_id === clientId).revoked_at !== null, true);
  assert.equal(repository.listGrants(clientId).every((grant) => grant.revoked_at), true);
  repository.close();
});

test("cursor verification reads project-scoped memory from the installer's repository", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(spawnSync("git", ["-C", setup.project, "init", "-q"]).status, 0);
  assert.equal(spawnSync("git", ["-C", setup.project, "remote", "add", "origin", "https://example.test/owner/project.git"]).status, 0);
  assert.equal(setup.run(["init"]).status, 0);

  const repository = new LocalRepository({ home: setup.switchboardHome });
  repository.propose({
    content: "cursor install verification project memory",
    category: "project",
    save_id: "cursor-install-verification-project-memory",
    project_scope: resolveProjectScope(repository, setup.project),
  }, { owner: true });
  repository.close();

  const installed = setup.run(["coding", "install", "--targets", "cursor"], null, {}, { cwd: setup.project });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /verification: passed_results/);
});

test("cursor leaves foreign sessionStart hooks and other events in place", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  const configPath = cursorConfigPath(setup);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const foreign = { command: "foreign-session-start", timeout: 8 };
  const original = {
    version: 1,
    hooks: { sessionStart: [foreign], afterAgent: [{ command: "foreign-after-agent" }] },
    feature: true,
  };
  writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "cursor"]).status, 0);
  const merged = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(merged.version, 1);
  assert.equal(merged.feature, true);
  assert.deepEqual(merged.hooks.afterAgent, original.hooks.afterAgent);
  assert.deepEqual(merged.hooks.sessionStart[0], foreign);
  assert.equal(merged.hooks.sessionStart.length, 2);

  assert.equal(setup.run(["coding", "uninstall", "--target", "cursor"]).status, 0);
  const remaining = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(remaining, original);
});

test("cursor preserves a foreign hooks file that did not declare a version", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  const configPath = cursorConfigPath(setup);
  const foreign = { command: "foreign-session-start", timeout: 8 };
  const original = { hooks: { sessionStart: [foreign] } };
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(setup.run(["init"]).status, 0);

  const installed = setup.run(["coding", "install", "--targets", "cursor"]);
  assert.equal(installed.status, 0, installed.stderr);
  const merged = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(merged.version, 1);
  assert.deepEqual(merged.hooks.sessionStart[0], foreign);
  assert.equal(merged.hooks.sessionStart.length, 2);

  const uninstalled = setup.run(["coding", "uninstall", "--target", "cursor"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
});

test("cursor refuses invalid hook configuration shapes without changing them", (t) => {
  const cases = [
    { value: { version: 2, hooks: {} }, message: "Cursor hooks version must be 1" },
    { value: { hooks: [] }, message: "Cursor hooks must be an object" },
    { value: { hooks: { sessionStart: {} } }, message: "Cursor sessionStart hooks must be an array" },
    { value: { hooks: { sessionStart: [{ command: 7 }] } }, message: "Cursor sessionStart contains an invalid hook entry" },
  ];

  for (const { value, message } of cases) {
    const setup = fixture(t);
    hostStub(setup.bin, "cursor-agent");
    const configPath = cursorConfigPath(setup);
    const original = `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);
    assert.equal(setup.run(["init"]).status, 0);

    const installed = setup.run(["coding", "install", "--targets", "cursor"]);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, new RegExp(message));
    assert.equal(readFileSync(configPath, "utf8"), original);
  }
});

test("cursor refuses to replace a changed recorded hook with a foreign cursor command", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "cursor"]).status, 0);
  writeFileSync(cursorConfigPath(setup), `${JSON.stringify({
    version: 1,
    hooks: { sessionStart: [{ command: "foreign-switchboard hook cursor-prefetch", timeout: 99 }] },
  }, null, 2)}\n`);

  const rerun = setup.run(["coding", "install", "--targets", "cursor"]);
  assert.equal(rerun.status, 1);
  assert.match(rerun.stderr, /recorded hook changed; refusing to replace an unowned entry/);
});

test("cursor prefetch injects global and workspace-root project memory", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(spawnSync("git", ["-C", setup.project, "init", "-q"]).status, 0);
  assert.equal(spawnSync("git", ["-C", setup.project, "remote", "add", "origin", "https://example.test/owner/project.git"]).status, 0);
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "cursor"]).status, 0);
  assert.equal(setup.run(["remember", "cursor global memory", "--category", "fact"]).status, 0);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  repository.propose({
    content: "cursor workspace memory", category: "project", save_id: "cursor-workspace-memory",
    project_scope: resolveProjectScope(repository, setup.project),
  }, { owner: true });
  repository.close();

  const hook = setup.run(["hook", "cursor-prefetch"], sessionStart(setup.project));
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stderr, "");
  const output = JSON.parse(hook.stdout);
  assert.match(output.additional_context, /<ai-passport>/);
  assert.match(output.additional_context, /cursor global memory/);
  assert.match(output.additional_context, /cursor workspace memory/);
});

test("cursor prefetch is silent for empty, malformed, and oversized input", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "cursor-agent");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "cursor"]).status, 0);
  for (const input of [sessionStart(setup.project), "not json", "x".repeat(128 * 1024 + 1)]) {
    const hook = setup.run(["hook", "cursor-prefetch"], input);
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout, "");
    assert.equal(hook.stderr, "");
  }
});
