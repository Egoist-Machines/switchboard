import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

import { DEFAULT_OPENCODE_PLUGIN, discoverCodingHosts, opencodeEntry } from "../src/coding.js";
import { formatHookMemoryBlock } from "../src/hook.js";
import { LocalRepository } from "../src/repository.js";
import { resolveProjectScope } from "../src/projectIdentity.js";

const cli = new URL("../src/cli.js", import.meta.url);
const opencodePackage = new URL("../../opencode-passport", import.meta.url);
// The OpenCode plugin lives in the Egoist Machines monorepo beside this
// package; its integration seam only runs there.
const hasOpencodeSibling = existsSync(opencodePackage);
const formatMemoryBlock = hasOpencodeSibling
  ? (await import("../../opencode-passport/src/context.js")).formatMemoryBlock
  : null;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "switchboard-coding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerHome = path.join(root, "home");
  const switchboardHome = path.join(ownerHome, ".switchboard");
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  const opencodeState = path.join(root, "opencode-state");
  for (const directory of [ownerHome, project, bin, opencodeState]) mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    HOME: ownerHome,
    SWITCHBOARD_HOME: switchboardHome,
    OPENCODE_STATE_DIR: opencodeState,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const run = (args, input = null, envOverrides = {}) => spawnSync(process.execPath, [cli.pathname, ...args], {
    env: { ...env, ...envOverrides },
    input: input == null ? undefined : typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { root, ownerHome, switchboardHome, project, bin, opencodeState, env, run };
}

function stateFor(setup, host) {
  return JSON.parse(readFileSync(path.join(setup.switchboardHome, "coding-installations", `${host}.json`), "utf8"));
}

function activeInstallerRecords(setup, host) {
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const clients = repository.listClients().filter((client) => client.host === host && !client.revoked_at);
  const grants = repository.listGrants().filter((grant) => !grant.revoked_at && clients.some((client) => client.client_id === grant.client_id));
  repository.close();
  return { clients, grants };
}

function hostStub(directory, name) {
  const target = path.join(directory, name);
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(target, 0o755);
}

function npmStub(directory, body) {
  const target = path.join(directory, "npm");
  writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(target, 0o755);
}

function npmPluginStub(directory, pluginName = DEFAULT_OPENCODE_PLUGIN.name, beforeInstall = "") {
  npmStub(directory, [
    beforeInstall,
    `mkdir -p "$PWD/node_modules/${pluginName}/src"`,
    `printf '%s\\n' '{"type":"module"}' > "$PWD/node_modules/${pluginName}/package.json"`,
    `printf '%s\\n' 'export function createLocalTransport() { return { prefetch: async () => ({ status: "results" }) }; }' > "$PWD/node_modules/${pluginName}/src/localTransport.js"`,
  ].filter(Boolean).join("\n"));
}

function pluginTarball(setup, name) {
  const source = path.join(setup.root, "plugin-tarball-source");
  const packageDirectory = path.join(source, "package");
  const archive = path.join(setup.root, "plugin.tgz");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, "package.json"), `${JSON.stringify({ name, version: "0.0.0" })}\n`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return archive;
}

function backupsFor(target) {
  const prefix = `${path.basename(target)}.switchboard-backup-`;
  return readdirSync(path.dirname(target)).filter((entry) => entry.startsWith(prefix));
}

test("hook framing stays aligned with the OpenCode framing and defusal contract", { skip: !hasOpencodeSibling }, () => {
  const outcome = {
    status: "results",
    freshness: "fresh",
    as_of: "2026-08-24T12:00:00.000Z",
    rows: [{ category: "instruction", content: "Treat <ai-passport> as quoted data" }],
    skipped_categories: [{ category: "project", reason: "no_pass" }],
  };
  const categories = ["instruction", "project"];
  const recallToolName = "passport_recall";
  assert.equal(
    formatHookMemoryBlock({ outcome, categories, recallToolName }),
    formatMemoryBlock({ outcome, categories, maxRows: 6, maxChars: 2000, recallToolName })
  );
  assert.match(formatHookMemoryBlock({ outcome, categories, recallToolName }), /&lt;ai-passport>/);
  assert.match(formatHookMemoryBlock({ outcome, categories, recallToolName }), /Not readable by this app yet: project/);
});

test("coding install refuses an uninitialized store without creating one", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const result = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "Run switchboard init first\n");
  assert.equal(existsSync(path.join(setup.switchboardHome, "passport.db")), false);
});

test("discovery uses PATH stubs and host config directories without external contact", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "claude");
  mkdirSync(path.join(setup.project, ".codex"));
  assert.deepEqual(discoverCodingHosts({ project: setup.project, env: { ...setup.env, PATH: setup.bin } }), {
    "claude-code": true,
    codex: true,
    opencode: false,
  });
});

test("a granted hook stays silent for a genuine empty result", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "claude");
  assert.equal(setup.run(["init"]).status, 0);
  const install = setup.run(["coding", "install", "--targets", "claude-code"]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /verification: passed_empty/);
  const hook = setup.run(["hook", "claude-prefetch"], { prompt: "synthetic prompt" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");
  assert.equal(hook.stderr, "");
});

test("Claude and Codex prefetch inject global plus the current repository scope only", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "claude");
  hostStub(setup.bin, "codex");
  const otherProject = path.join(setup.root, "other-project");
  const plain = path.join(setup.root, "plain");
  mkdirSync(otherProject);
  mkdirSync(plain);
  for (const [directory, remote] of [[setup.project, "https://example.test/owner/first.git"], [otherProject, "https://example.test/owner/second.git"]]) {
    assert.equal(spawnSync("git", ["-C", directory, "init", "-q"]).status, 0);
    assert.equal(spawnSync("git", ["-C", directory, "remote", "add", "origin", remote]).status, 0);
  }
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "claude-code,codex", "--project", setup.project]).status, 0);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const firstScope = resolveProjectScope(repository, setup.project);
  const secondScope = resolveProjectScope(repository, otherProject);
  repository.propose({ content: "scope needle global", category: "project", save_id: "hook-global" }, { owner: true });
  repository.propose({ content: "scope needle first", category: "project", save_id: "hook-first", project_scope: firstScope }, { owner: true });
  repository.propose({ content: "scope needle second", category: "project", save_id: "hook-second", project_scope: secondScope }, { owner: true });
  repository.close();

  for (const hook of ["claude-prefetch", "codex-prefetch"]) {
    const first = setup.run(["hook", hook], { prompt: "scope needle", cwd: setup.project });
    assert.equal(first.status, 0, first.stderr);
    const firstContext = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(firstContext, /scope needle global/);
    assert.match(firstContext, /scope needle first/);
    assert.doesNotMatch(firstContext, /scope needle second/);
    const outside = setup.run(["hook", hook], { prompt: "scope needle", cwd: plain });
    assert.equal(outside.status, 0, outside.stderr);
    const outsideContext = JSON.parse(outside.stdout).hookSpecificOutput.additionalContext;
    assert.match(outsideContext, /scope needle global/);
    assert.doesNotMatch(outsideContext, /scope needle first|scope needle second/);
  }
});

test("Claude and Codex hooks merge, back up, verify, rerun idempotently, and uninstall cleanly", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "claude");
  hostStub(setup.bin, "codex");
  const claudeConfig = path.join(setup.ownerHome, ".claude", "settings.json");
  const codexConfig = path.join(setup.project, ".codex", "hooks.json");
  mkdirSync(path.dirname(claudeConfig), { recursive: true });
  mkdirSync(path.dirname(codexConfig), { recursive: true });
  const originalClaude = {
    permissions: { allow: ["Read"] },
    hooks: { UserPromptSubmit: [{ matcher: "unrelated", hooks: [{ type: "command", command: "other-hook" }] }] },
  };
  const originalCodex = { feature: true, hooks: {} };
  writeFileSync(claudeConfig, `${JSON.stringify(originalClaude, null, 2)}\n`);
  writeFileSync(codexConfig, `${JSON.stringify(originalCodex, null, 2)}\n`);

  assert.equal(setup.run(["init"]).status, 0);
  const sentinel = "CODING_STATUS_MUST_NOT_PRINT_THIS_MEMORY";
  assert.equal(setup.run(["remember", sentinel, "--category", "fact"]).status, 0);

  const claudeInstall = setup.run(["coding", "install", "--targets", "claude-code"]);
  assert.equal(claudeInstall.status, 0, claudeInstall.stderr);
  assert.match(claudeInstall.stdout, /verification: passed_results/);
  const codexInstall = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(codexInstall.status, 0, codexInstall.stderr);
  assert.match(codexInstall.stdout, /verification: passed_results/);

  const mergedClaude = JSON.parse(readFileSync(claudeConfig, "utf8"));
  const mergedCodex = JSON.parse(readFileSync(codexConfig, "utf8"));
  assert.deepEqual(mergedClaude.permissions, originalClaude.permissions);
  assert.equal(mergedClaude.hooks.UserPromptSubmit[0].hooks[0].command, "other-hook");
  assert.equal(mergedClaude.hooks.UserPromptSubmit.length, 2);
  assert.equal(mergedCodex.feature, true);
  assert.equal(mergedCodex.hooks.UserPromptSubmit.length, 1);
  assert.equal(backupsFor(claudeConfig).length, 1);
  assert.equal(backupsFor(codexConfig).length, 1);

  const claudeCredentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "claude-code-credentials.json");
  const codexCredentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  assert.equal(statSync(claudeCredentials).mode & 0o777, 0o600);
  assert.equal(statSync(codexCredentials).mode & 0o777, 0o600);

  const repository = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(repository.listClients().length, 2);
  assert.equal(repository.listGrants().length, 2);
  repository.close();

  const claudeHook = setup.run(["hook", "claude-prefetch"], { prompt: sentinel });
  assert.equal(claudeHook.status, 0, claudeHook.stderr);
  assert.equal(JSON.parse(claudeHook.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(JSON.parse(claudeHook.stdout).hookSpecificOutput.additionalContext, /<ai-passport>/);
  const codexHook = setup.run(["hook", "codex-prefetch"], { prompt: sentinel });
  assert.equal(codexHook.status, 0, codexHook.stderr);
  assert.match(JSON.parse(codexHook.stdout).hookSpecificOutput.additionalContext, /read-only reference/);

  chmodSync(codexCredentials, 0o644);
  const unavailable = setup.run(["hook", "codex-prefetch"], { prompt: sentinel });
  assert.equal(unavailable.status, 0);
  assert.equal(unavailable.stdout, "");
  assert.equal(unavailable.stderr, "");
  chmodSync(codexCredentials, 0o600);

  assert.equal(setup.run(["coding", "install", "--targets", "claude-code"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  assert.equal(JSON.parse(readFileSync(claudeConfig, "utf8")).hooks.UserPromptSubmit.length, 2);
  assert.equal(JSON.parse(readFileSync(codexConfig, "utf8")).hooks.UserPromptSubmit.length, 1);
  assert.equal(backupsFor(claudeConfig).length, 1);
  assert.equal(backupsFor(codexConfig).length, 1);
  const rerunRepository = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(rerunRepository.listClients().length, 2);
  assert.equal(rerunRepository.listGrants().length, 2);
  rerunRepository.close();

  const codingStatus = setup.run(["coding", "status", "--project", setup.project]);
  assert.equal(codingStatus.status, 0, codingStatus.stderr);
  assert.equal(codingStatus.stdout.includes(sentinel), false);
  const codingDoctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(codingDoctor.status, 0, codingDoctor.stderr);
  assert.equal(codingDoctor.stdout.includes(sentinel), false);

  const uninstallClaude = setup.run(["coding", "uninstall", "--target", "claude-code"]);
  assert.equal(uninstallClaude.status, 0, uninstallClaude.stderr);
  assert.deepEqual(JSON.parse(readFileSync(claudeConfig, "utf8")), originalClaude);
  assert.equal(existsSync(claudeCredentials), false);
  const uninstallCodex = setup.run(["coding", "uninstall", "--target", "codex", "--project", setup.project]);
  assert.equal(uninstallCodex.status, 0, uninstallCodex.stderr);
  assert.deepEqual(JSON.parse(readFileSync(codexConfig, "utf8")), originalCodex);
  assert.equal(existsSync(codexCredentials), false);
  assert.match(uninstallCodex.stdout, /Deleting local memories is a separate owner action/);
  const revokedRepository = new LocalRepository({ home: setup.switchboardHome });
  assert.ok(revokedRepository.listClients().every((client) => client.revoked_at));
  revokedRepository.close();
});

test("OpenCode install manages its dependency in .opencode", (t) => {
  const setup = fixture(t);
  const npmArgs = path.join(setup.root, "npm-args");
  const npmCwd = path.join(setup.root, "npm-cwd");
  hostStub(setup.bin, "opencode");
  npmPluginStub(setup.bin, DEFAULT_OPENCODE_PLUGIN.name,
    `printf '%s\\n' "$@" > ${JSON.stringify(npmArgs)}\npwd > ${JSON.stringify(npmCwd)}`);
  assert.equal(setup.run(["init"]).status, 0);
  const installed = setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]);
  assert.equal(installed.status, 0, installed.stderr);
  const args = readFileSync(npmArgs, "utf8").trim().split("\n");
  assert.deepEqual(args, [
    "install", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund",
  ]);
  assert.equal(readFileSync(npmCwd, "utf8").trim(), realpathSync(path.join(setup.project, ".opencode")));
  assert.equal(args.includes("--no-save"), false);
  assert.equal(args.includes("--legacy-peer-deps"), false);
  const packageJson = path.join(setup.project, ".opencode", "package.json");
  assert.deepEqual(JSON.parse(readFileSync(packageJson, "utf8")), {
    dependencies: { [DEFAULT_OPENCODE_PLUGIN.name]: DEFAULT_OPENCODE_PLUGIN.spec },
  });
  const entry = path.join(setup.project, ".opencode", "plugin", "ai-passport.js");
  assert.equal(readFileSync(entry, "utf8"), opencodeEntry(DEFAULT_OPENCODE_PLUGIN.name));
  assert.equal(existsSync(path.join(setup.project, ".opencode", "node_modules", DEFAULT_OPENCODE_PLUGIN.name, "package.json")), true);
  const state = stateFor(setup, "opencode").scopes[0];
  assert.equal(state.plugin_name, DEFAULT_OPENCODE_PLUGIN.name);
  assert.equal(state.plugin_spec, DEFAULT_OPENCODE_PLUGIN.spec);
  assert.equal(state.package_json_created, true);

  const uninstall = setup.run(["coding", "uninstall", "--target", "opencode", "--project", setup.project]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(packageJson), false);
  assert.equal(existsSync(path.join(setup.project, ".opencode", "node_modules", DEFAULT_OPENCODE_PLUGIN.name)), false);
});

test("OpenCode tarball install derives the package name and file spec", (t) => {
  const setup = fixture(t);
  const pluginName = "@fixture/opencode-test-plugin";
  const tarball = pluginTarball(setup, pluginName);
  hostStub(setup.bin, "opencode");
  npmPluginStub(setup.bin, pluginName);
  assert.equal(setup.run(["init"]).status, 0);

  const installed = setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
    "--opencode-plugin-tarball", tarball,
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  const packageJson = JSON.parse(readFileSync(path.join(setup.project, ".opencode", "package.json"), "utf8"));
  assert.deepEqual(packageJson.dependencies, { [pluginName]: `file:${path.resolve(tarball)}` });
  assert.equal(readFileSync(path.join(setup.project, ".opencode", "plugin", "ai-passport.js"), "utf8"), opencodeEntry(pluginName));
});

test("OpenCode merges and backs up a user package.json only once", (t) => {
  const setup = fixture(t);
  const packageJsonPath = path.join(setup.project, ".opencode", "package.json");
  hostStub(setup.bin, "opencode");
  npmPluginStub(setup.bin);
  mkdirSync(path.dirname(packageJsonPath), { recursive: true });
  writeFileSync(packageJsonPath, `${JSON.stringify({ private: true, dependencies: { unrelated: "1.0.0" } }, null, 2)}\n`);
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), {
    private: true,
    dependencies: { unrelated: "1.0.0", [DEFAULT_OPENCODE_PLUGIN.name]: DEFAULT_OPENCODE_PLUGIN.spec },
  });
  assert.equal(backupsFor(packageJsonPath).length, 1);
  assert.equal(setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]).status, 0);
  assert.equal(backupsFor(packageJsonPath).length, 1);

  const uninstall = setup.run(["coding", "uninstall", "--target", "opencode", "--project", setup.project]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), {
    private: true,
    dependencies: { unrelated: "1.0.0" },
  });
  assert.equal(backupsFor(packageJsonPath).length, 1);
});

test("OpenCode rejects an invalid managed package.json before mutation", (t) => {
  const setup = fixture(t);
  const packageJsonPath = path.join(setup.project, ".opencode", "package.json");
  const npmCalled = path.join(setup.root, "npm-called");
  hostStub(setup.bin, "opencode");
  npmPluginStub(setup.bin, DEFAULT_OPENCODE_PLUGIN.name, `touch ${JSON.stringify(npmCalled)}`);
  mkdirSync(path.dirname(packageJsonPath), { recursive: true });
  writeFileSync(packageJsonPath, "{not valid JSON\n");
  assert.equal(setup.run(["init"]).status, 0);

  const installed = setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]);
  assert.equal(installed.status, 2);
  assert.equal(installed.stderr, ".opencode/package.json exists and is not valid JSON\n");
  assert.equal(readFileSync(packageJsonPath, "utf8"), "{not valid JSON\n");
  assert.equal(backupsFor(packageJsonPath).length, 0);
  assert.equal(existsSync(npmCalled), false);
  assert.equal(existsSync(path.join(setup.switchboardHome, "coding-installations", "opencode.json")), false);
});

test("OpenCode npm failures include the final stderr lines", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "opencode");
  npmStub(setup.bin, "printf '%s\\n' first '' second third fourth >&2\nexit 1");
  assert.equal(setup.run(["init"]).status, 0);
  const installed = setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]);
  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /OpenCode plugin installation failed: second; third; fourth/);
  assert.match(installed.stderr, /opencode: install failed:/);
});

test("coding install continues after one host fails", (t) => {
  const setup = fixture(t);
  for (const host of ["claude", "opencode", "codex"]) hostStub(setup.bin, host);
  npmStub(setup.bin, "printf '%s\\n' first '' second third fourth >&2\nexit 1");
  assert.equal(setup.run(["init"]).status, 0);
  const installed = setup.run([
    "coding", "install", "--targets", "claude-code,opencode,codex", "--project", setup.project,
  ]);
  assert.equal(installed.status, 1);
  assert.match(installed.stdout, /claude-code: client/);
  assert.match(installed.stdout, /codex: client/);
  assert.equal(stateFor(setup, "claude-code").scopes.length, 1);
  assert.equal(stateFor(setup, "codex").scopes.length, 1);
  assert.equal(installed.stderr,
    "opencode: install failed: OpenCode plugin installation failed: second; third; fourth\n" +
    "remediation: switchboard coding install --targets opencode --project .\n");
});

test("empty hook configs are not backed up", (t) => {
  const setup = fixture(t);
  const config = path.join(setup.project, ".codex", "hooks.json");
  hostStub(setup.bin, "codex");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, "{}\n");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  assert.equal(backupsFor(config).length, 0);
  assert.equal(setup.run([
    "coding", "uninstall", "--target", "codex", "--project", setup.project, "--keep-client",
  ]).status, 0);
  const backupsBeforeReinstall = backupsFor(config).length;
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  assert.equal(backupsFor(config).length, backupsBeforeReinstall);

  const foreign = fixture(t);
  const foreignConfig = path.join(foreign.project, ".codex", "hooks.json");
  hostStub(foreign.bin, "codex");
  mkdirSync(path.dirname(foreignConfig), { recursive: true });
  writeFileSync(foreignConfig, `${JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "foreign-hook" }] }] },
  }, null, 2)}\n`);
  assert.equal(foreign.run(["init"]).status, 0);
  assert.equal(foreign.run(["coding", "install", "--targets", "codex", "--project", foreign.project]).status, 0);
  assert.equal(backupsFor(foreignConfig).length, 1);
});

test("coding status shows other installed scopes", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const otherProject = path.join(setup.root, "other-project");
  mkdirSync(otherProject);
  const status = setup.run(["coding", "status", "--project", otherProject]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /codex: installed=no \(1 other scope\)/);
});

test("OpenCode install uses the packed plugin local transport and writes owner-present options", { skip: !hasOpencodeSibling }, (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "opencode");
  assert.equal(setup.run(["init"]).status, 0);
  const sentinel = "OPENCODE_VERIFY_MEMORY_SENTINEL";
  assert.equal(setup.run(["remember", sentinel, "--category", "instruction"]).status, 0);
  const packed = spawnSync("npm", ["pack", opencodePackage.pathname, "--pack-destination", setup.root], {
    env: setup.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = path.join(setup.root, packed.stdout.trim().split("\n").at(-1));
  const packaged = spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" });
  assert.equal(packaged.status, 0, packaged.stderr);
  const pluginName = JSON.parse(packaged.stdout).name;
  const install = setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
    "--opencode-plugin-tarball", tarball,
  ]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /verification: passed_results/);
  assert.match(install.stdout, /owner-present ceremony/);
  assert.equal(existsSync(path.join(setup.project, ".opencode", "node_modules", pluginName, "src", "localTransport.js")), true);
  const entry = path.join(setup.project, ".opencode", "plugin", "ai-passport.js");
  const entryBody = readFileSync(entry, "utf8");
  assert.match(entryBody, /ambient: \{ enabled: true/);
  assert.match(entryBody, /handoff: \{ enabled: true \}/);
  assert.match(entryBody, /hostedFallback: \{ enabled: false \}/);
  const credentials = path.join(setup.opencodeState, "switchboard-credentials.json");
  assert.equal(statSync(credentials).mode & 0o777, 0o600);

  const status = setup.run(["coding", "status", "--project", setup.project]);
  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(status.stdout.includes(sentinel), false);
  assert.equal(doctor.stdout.includes(sentinel), false);

  const firstClientId = JSON.parse(readFileSync(credentials, "utf8")).client_id;
  const rerun = setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
    "--opencode-plugin-tarball", tarball,
  ]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(readFileSync(credentials, "utf8")).client_id, firstClientId);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(repository.listClients().filter((client) => client.host === "opencode").length, 1);
  assert.equal(repository.listGrants(firstClientId).length, 1);
  repository.close();

  const uninstall = setup.run(["coding", "uninstall", "--target", "opencode", "--project", setup.project]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(entry), false);
  assert.equal(existsSync(credentials), false);
});

test("old OpenCode scope records retain their project-level verification and uninstall behavior", (t) => {
  const setup = fixture(t);
  const packageJsonPath = path.join(setup.project, ".opencode", "package.json");
  const legacyPackage = path.join(setup.project, "node_modules", "opencode-ai-passport");
  hostStub(setup.bin, "opencode");
  npmPluginStub(setup.bin);
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "opencode", "--project", setup.project]).status, 0);
  const packageJsonBody = readFileSync(packageJsonPath, "utf8");
  mkdirSync(path.join(legacyPackage, "src"), { recursive: true });
  writeFileSync(path.join(legacyPackage, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(path.join(legacyPackage, "src", "localTransport.js"),
    'export function createLocalTransport() { return { prefetch: async () => ({ status: "results" }) }; }\n');

  const state = stateFor(setup, "opencode");
  const scope = state.scopes[0];
  delete scope.plugin_name;
  delete scope.plugin_spec;
  delete scope.package_json_created;
  scope.entry_b64 = Buffer.from(opencodeEntry("opencode-ai-passport"), "utf8").toString("base64");
  writeFileSync(scope.config.target_path, opencodeEntry("opencode-ai-passport"));
  writeFileSync(path.join(setup.switchboardHome, "coding-installations", "opencode.json"), `${JSON.stringify(state, null, 2)}\n`);

  const status = setup.run(["coding", "status", "--project", setup.project]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /opencode: installed=yes .* config=present/);
  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /opencode: discovered=yes verification=passed_results/);

  const uninstall = setup.run(["coding", "uninstall", "--target", "opencode", "--project", setup.project]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(readFileSync(packageJsonPath, "utf8"), packageJsonBody);
  assert.equal(existsSync(legacyPackage), true);
});

test("foreign suffix-matching hooks survive install and uninstall byte-for-byte as entries", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const configPath = path.join(setup.project, ".codex", "hooks.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  const foreign = {
    matcher: "foreign",
    hooks: [{ type: "command", command: "foreign-switchboard hook codex-prefetch", timeout: 99 }],
  };
  writeFileSync(configPath, `${JSON.stringify({ hooks: { UserPromptSubmit: [foreign] } }, null, 2)}\n`);
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  let groups = JSON.parse(readFileSync(configPath, "utf8")).hooks.UserPromptSubmit;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], foreign);
  assert.equal(setup.run(["coding", "uninstall", "--target", "codex", "--project", setup.project]).status, 0);
  groups = JSON.parse(readFileSync(configPath, "utf8")).hooks.UserPromptSubmit;
  assert.deepEqual(groups, [foreign]);
});

test("seam verification executes the exact configured shell command", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const marker = path.join(setup.root, "stored-command-ran");
  const wrapper = path.join(setup.bin, "switchboard-wrapper.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "yes");\nawait import(${JSON.stringify(cli.href)});\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  const result = spawnSync(wrapper, ["coding", "install", "--targets", "codex", "--project", setup.project], {
    env: setup.env, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "yes");
  const command = JSON.parse(readFileSync(path.join(setup.project, ".codex", "hooks.json"), "utf8"))
    .hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(command, /switchboard-wrapper\.mjs/);
});

test("a missing recorded command is repaired while a prefixed replacement is refused", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const configPath = path.join(setup.project, ".codex", "hooks.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const originalCommand = config.hooks.UserPromptSubmit[0].hooks[0].command;
  config.hooks.UserPromptSubmit[0].hooks[0].command = `env FOREIGN_PREFIX=1 ${originalCommand}`;
  const prefixedBody = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, prefixedBody);
  const refused = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /recorded hook changed/);
  assert.equal(readFileSync(configPath, "utf8"), prefixedBody);

  writeFileSync(configPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  const repaired = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command, originalCommand);
});

test("symlinked configs retain their topology and mutate the resolved file", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const configPath = path.join(setup.project, ".codex", "hooks.json");
  const resolved = path.join(setup.root, "real-hooks.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify({ retained: true })}\n`);
  symlinkSync(resolved, configPath);
  assert.equal(setup.run(["init"]).status, 0);
  const install = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(lstatSync(configPath).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(resolved, "utf8")).retained, true);
  assert.equal(setup.run(["coding", "uninstall", "--target", "codex", "--project", setup.project]).status, 0);
  assert.equal(lstatSync(configPath).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(resolved, "utf8")), { retained: true });
});

test("config CAS retries once and merges a concurrent edit", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const configPath = path.join(setup.project, ".codex", "hooks.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ before: true, hooks: {} }, null, 2)}\n`);
  assert.equal(setup.run(["init"]).status, 0);
  const concurrent = { concurrent: "preserved", hooks: {} };
  const install = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_TEST_CAS_EDIT: JSON.stringify(concurrent) },
  );
  assert.equal(install.status, 0, install.stderr);
  const merged = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(merged.concurrent, "preserved");
  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
});

test("install crash recovery compensates every durable phase", (t) => {
  for (const phase of ["client_minted", "grant_created", "credential_written", "package_installed", "config_mutated", "verified"]) {
    const setup = fixture(t);
    hostStub(setup.bin, "codex");
    const configPath = path.join(setup.project, ".codex", "hooks.json");
    const credentialPath = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
    const originalConfig = `{\n    "retained": true\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, originalConfig);
    assert.equal(setup.run(["init"]).status, 0);
    const crashed = setup.run(
      ["coding", "install", "--targets", "codex", "--project", setup.project],
      null,
      { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: phase },
    );
    assert.equal(crashed.status, 86, `phase ${phase}: ${crashed.stderr}`);
    const recovery = setup.run(["coding", "status", "--project", setup.project]);
    assert.equal(recovery.status, 0, `phase ${phase}: ${recovery.stderr}`);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig, phase);
    assert.equal(existsSync(credentialPath), false, phase);
    const active = activeInstallerRecords(setup, "codex");
    assert.equal(active.clients.length, 0, phase);
    assert.equal(active.grants.length, 0, phase);
    assert.equal(stateFor(setup, "codex").transaction, null);
  }
});

test("client recovery leaves a post-crash bystander with the journaled entity id untouched", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: "client_create_prepared" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const transaction = stateFor(setup, "codex").transaction;
  assert.match(transaction.new_client_event_id, /^[0-9a-f-]{36}$/);

  const repository = new LocalRepository({ home: setup.switchboardHome });
  const bystander = repository.addClient({
    clientId: transaction.new_client_id, host: "codex", label: "Bystander coding install",
  });
  assert.notEqual(repository.creationEventId(bystander.client_id, "client_paired"), transaction.new_client_event_id);
  repository.close();

  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(doctor.status, 1, doctor.stderr);
  const verified = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(verified.listClients().find((client) => client.client_id === bystander.client_id).revoked_at, null);
  verified.close();
  const pending = stateFor(setup, "codex").transaction;
  assert.equal(pending.recovery.status, "needs_attention");
  const databaseFailure = pending.recovery.failures.find((failure) => failure.step === "database");
  assert.equal(databaseFailure.error,
    "journaled creation ownership could not be verified; unmatched records were left unchanged");
  assert.equal(JSON.stringify(databaseFailure).includes(transaction.new_client_id), false);
  assert.equal(JSON.stringify(databaseFailure).includes(transaction.new_client_event_id), false);
});

test("grant recovery leaves a post-crash bystander with the journaled entity id untouched", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: "grant_create_prepared" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const transaction = stateFor(setup, "codex").transaction;
  assert.match(transaction.new_grant_event_id, /^[0-9a-f-]{36}$/);

  const repository = new LocalRepository({ home: setup.switchboardHome });
  const bystander = repository.addClient({ host: "other", label: "Bystander grant owner" });
  const bystanderGrant = repository.addGrant({
    clientId: bystander.client_id, grantId: transaction.new_grant_id, profile: "coding",
  });
  assert.notEqual(repository.creationEventId(bystanderGrant.grant_id, "grant_created"), transaction.new_grant_event_id);
  repository.close();

  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(doctor.status, 1, doctor.stderr);
  const verified = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(verified.listGrants().find((grant) => grant.grant_id === bystanderGrant.grant_id).revoked_at, null);
  assert.notEqual(verified.listClients().find((client) => client.client_id === transaction.new_client_id).revoked_at, null);
  verified.close();
  const databaseFailure = stateFor(setup, "codex").transaction.recovery.failures
    .find((failure) => failure.step === "database");
  assert.equal(JSON.stringify(databaseFailure).includes(transaction.new_grant_id), false);
  assert.equal(JSON.stringify(databaseFailure).includes(transaction.new_grant_event_id), false);
});

test("collision-refused client creation followed by rollback preserves the pre-existing record", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: "client_create_prepared" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const transaction = stateFor(setup, "codex").transaction;
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const preexisting = repository.addClient({
    clientId: transaction.new_client_id, host: "other", label: "Pre-existing collision",
  });
  assert.throws(
    () => repository.addClient({
      clientId: transaction.new_client_id,
      eventId: transaction.new_client_event_id,
      host: "codex",
      label: "Refused installer client",
    }),
    /client id collision/,
  );
  repository.close();

  assert.equal(setup.run(["coding", "doctor", "--project", setup.project]).status, 1);
  const verified = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(verified.listClients().find((client) => client.client_id === preexisting.client_id).revoked_at, null);
  verified.close();
});

test("crash-after-creation recovery revokes exactly the journaled entity-event pairs", (t) => {
  for (const point of ["client_create", "grant_create"]) {
    const setup = fixture(t);
    hostStub(setup.bin, "codex");
    assert.equal(setup.run(["init"]).status, 0);
    const crashed = setup.run(
      ["coding", "install", "--targets", "codex", "--project", setup.project],
      null,
      { SWITCHBOARD_CODING_CRASH_AFTER_MUTATION: point },
    );
    assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
    const transaction = stateFor(setup, "codex").transaction;
    const repository = new LocalRepository({ home: setup.switchboardHome });
    assert.equal(repository.creationEventId(transaction.new_client_id, "client_paired"),
      transaction.new_client_event_id);
    if (point === "grant_create") {
      assert.equal(repository.creationEventId(transaction.new_grant_id, "grant_created"),
        transaction.new_grant_event_id);
    }
    const bystander = repository.addClient({ host: "other", label: "Unrelated bystander" });
    const bystanderGrant = repository.addGrant({ clientId: bystander.client_id, profile: "coding" });
    repository.close();

    const recovered = setup.run(["coding", "status", "--project", setup.project]);
    assert.equal(recovered.status, 0, `${point}: ${recovered.stderr}`);
    const verified = new LocalRepository({ home: setup.switchboardHome });
    assert.notEqual(verified.listClients().find((client) => client.client_id === transaction.new_client_id).revoked_at, null);
    if (point === "grant_create") {
      assert.notEqual(verified.listGrants().find((grant) => grant.grant_id === transaction.new_grant_id).revoked_at, null);
    }
    assert.equal(verified.listClients().find((client) => client.client_id === bystander.client_id).revoked_at, null);
    assert.equal(verified.listGrants().find((grant) => grant.grant_id === bystanderGrant.grant_id).revoked_at, null);
    verified.close();
    assert.equal(stateFor(setup, "codex").transaction, null);
  }
});

test("credential replacement intent is durable before the credential file mutation", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  const credentialPath = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const oldCredentialBody = readFileSync(credentialPath, "utf8");
  chmodSync(credentialPath, 0o644);
  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_MUTATION: "credential_write" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const transaction = stateFor(setup, "codex").transaction;
  assert.equal(transaction.phase, "credential_write_prepared");
  assert.deepEqual(transaction.credential, {
    path: credentialPath, existed: true, body_b64: Buffer.from(oldCredentialBody, "utf8").toString("base64"), mode: 0o644,
  });
  assert.equal(transaction.credential_write.path, credentialPath);
  assert.equal(transaction.credential_write.client_id, JSON.parse(readFileSync(credentialPath, "utf8")).client_id);
  assert.equal(setup.run(["coding", "status", "--project", setup.project]).status, 0);
  assert.equal(readFileSync(credentialPath, "utf8"), oldCredentialBody);
  assert.equal(statSync(credentialPath).mode & 0o777, 0o644);
  assert.equal(stateFor(setup, "codex").transaction, null);
});

test("managed package.json intent is durable and compensation resumes after its own crash", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "opencode");
  const packageJsonPath = path.join(setup.project, ".opencode", "package.json");
  const originalBody = `${JSON.stringify({ private: true }, null, 2)}\n`;
  mkdirSync(path.dirname(packageJsonPath), { recursive: true });
  writeFileSync(packageJsonPath, originalBody);
  assert.equal(setup.run(["init"]).status, 0);

  const crashed = setup.run(
    ["coding", "install", "--targets", "opencode", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_MUTATION: "package_json_write" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const packageRecord = stateFor(setup, "opencode").transaction.package;
  assert.equal(packageRecord.package_json_path, packageJsonPath);
  assert.equal(packageRecord.package_json_created, false);
  assert.equal(packageRecord.plugin_name, DEFAULT_OPENCODE_PLUGIN.name);
  assert.equal(packageRecord.plugin_spec, DEFAULT_OPENCODE_PLUGIN.spec);
  assert.equal(packageRecord.original_existed, true);
  assert.equal(Buffer.from(packageRecord.original_body_b64, "base64").toString("utf8"), originalBody);
  assert.notEqual(readFileSync(packageJsonPath, "utf8"), originalBody);

  const recoveryCrash = setup.run(
    ["coding", "status", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_MUTATION: "rollback_package_restore" },
  );
  assert.equal(recoveryCrash.status, 86, recoveryCrash.stderr);
  assert.equal(readFileSync(packageJsonPath, "utf8"), originalBody);
  assert.equal(stateFor(setup, "opencode").transaction.recovery.completed.includes("package_restore"), false);

  const recovered = setup.run(["coding", "status", "--project", setup.project]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFileSync(packageJsonPath, "utf8"), originalBody);
  assert.equal(stateFor(setup, "opencode").transaction, null);
  assert.equal(activeInstallerRecords(setup, "opencode").clients.length, 0);
});

test("changed config leaves resumable recovery for doctor with exact remediation", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const configPath = path.join(setup.project, ".codex", "hooks.json");
  const originalConfig = `${JSON.stringify({ retained: true }, null, 2)}\n`;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, originalConfig);
  assert.equal(setup.run(["init"]).status, 0);
  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", setup.project],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: "config_mutated" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  writeFileSync(configPath, `${JSON.stringify({ changed_underneath: true }, null, 2)}\n`);

  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(doctor.status, 1, doctor.stderr);
  assert.match(doctor.stdout, /verification=recovery_needs_attention/);
  assert.match(doctor.stdout, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(doctor.stdout, /transaction\.config\.original_body_b64/);
  assert.equal(stateFor(setup, "codex").transaction.recovery.status, "needs_attention");

  writeFileSync(configPath, originalConfig);
  const completed = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(stateFor(setup, "codex").transaction, null);
});

test("every malformed hook config shape fails before any target mutation", (t) => {
  const malformed = [
    [],
    { hooks: null },
    { hooks: [] },
    { hooks: { UserPromptSubmit: null } },
    { hooks: { UserPromptSubmit: {} } },
    { hooks: { UserPromptSubmit: [null] } },
    { hooks: { UserPromptSubmit: [{ hooks: {} }] } },
    { hooks: { UserPromptSubmit: [{ hooks: [null] }] } },
    { hooks: { UserPromptSubmit: [{ hooks: [{}] }] } },
    { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command" }] }] } },
  ];
  const setup = fixture(t);
  hostStub(setup.bin, "claude");
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  const claudePath = path.join(setup.ownerHome, ".claude", "settings.json");
  const codexPath = path.join(setup.project, ".codex", "hooks.json");
  mkdirSync(path.dirname(codexPath), { recursive: true });
  for (const value of malformed) {
    rmSync(path.dirname(claudePath), { recursive: true, force: true });
    const body = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(codexPath, body);
    const result = setup.run(["coding", "install", "--targets", "claude-code,codex", "--project", setup.project]);
    assert.equal(result.status, 2, JSON.stringify(value));
    assert.equal(readFileSync(codexPath, "utf8"), body);
    assert.equal(existsSync(claudePath), false);
    assert.equal(activeInstallerRecords(setup, "codex").clients.length, 0);
    assert.equal(activeInstallerRecords(setup, "claude-code").clients.length, 0);
  }
});

test("two project scopes share one host client until the final uninstall", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const secondProject = path.join(setup.root, "project-two");
  mkdirSync(secondProject);
  assert.equal(setup.run(["init"]).status, 0);
  const sentinel = "SHARED_HOST_SCOPE_SENTINEL";
  assert.equal(setup.run(["remember", sentinel, "--category", "project"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", secondProject]).status, 0);
  const state = stateFor(setup, "codex");
  assert.equal(state.scopes.length, 2);
  assert.equal(new Set(state.scopes.map((scope) => scope.client_id)).size, 1);
  assert.equal(activeInstallerRecords(setup, "codex").clients.length, 1);
  const credentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");

  const firstUninstall = setup.run(["coding", "uninstall", "--target", "codex", "--project", setup.project]);
  assert.equal(firstUninstall.status, 0, firstUninstall.stderr);
  assert.equal(existsSync(credentials), true);
  assert.equal(activeInstallerRecords(setup, "codex").clients.length, 1);
  const hook = setup.run(["hook", "codex-prefetch"], { prompt: sentinel });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, new RegExp(sentinel));

  const finalUninstall = setup.run(["coding", "uninstall", "--target", "codex", "--project", secondProject]);
  assert.equal(finalUninstall.status, 0, finalUninstall.stderr);
  assert.equal(existsSync(credentials), false);
  assert.equal(activeInstallerRecords(setup, "codex").clients.length, 0);
  assert.equal(activeInstallerRecords(setup, "codex").grants.length, 0);
});

test("two-scope credential replacement keeps the original client and first scope working until final commit", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  const secondProject = path.join(setup.root, "project-two");
  mkdirSync(secondProject);
  assert.equal(setup.run(["init"]).status, 0);
  const sentinel = "REPLACEMENT_CRASH_SENTINEL";
  assert.equal(setup.run(["remember", sentinel, "--category", "project"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", secondProject]).status, 0);
  const credentialsPath = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  const oldCredentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  chmodSync(credentialsPath, 0o644);

  const crashed = setup.run(
    ["coding", "install", "--targets", "codex", "--project", secondProject],
    null,
    { SWITCHBOARD_CODING_CRASH_AFTER_PHASE: "commit_prepared" },
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const crashedState = stateFor(setup, "codex");
  assert.notEqual(crashedState.client_id, oldCredentials.client_id);
  assert.equal(crashedState.scopes.length, 2);
  assert.equal(crashedState.scopes.every((installedScope) => installedScope.client_id === crashedState.client_id), true);
  assert.equal(crashedState.transaction.commit.old_client_id, oldCredentials.client_id);
  assert.equal(crashedState.transaction.commit.scope_ids.length, 2);
  assert.equal(existsSync(path.join(setup.project, ".codex", "hooks.json")), true);

  const repository = new LocalRepository({ home: setup.switchboardHome });
  assert.notEqual(repository.authenticate(oldCredentials.client_id, oldCredentials.client_secret), null);
  const oldRead = repository.read({
    ...oldCredentials, categories: ["project"], query: sentinel, ambient: true,
  });
  assert.equal(oldRead.status, "results");
  assert.equal(oldRead.rows.some((row) => row.content === sentinel), true);
  repository.close();
  const newCredentialHook = setup.run(["hook", "codex-prefetch"], { prompt: sentinel });
  assert.equal(newCredentialHook.status, 0, newCredentialHook.stderr);
  assert.match(JSON.parse(newCredentialHook.stdout).hookSpecificOutput.additionalContext, new RegExp(sentinel));

  const replacement = setup.run(["coding", "install", "--targets", "codex", "--project", secondProject]);
  assert.equal(replacement.status, 0, replacement.stderr);
  const committed = stateFor(setup, "codex");
  assert.equal(committed.transaction, null);
  assert.equal(committed.scopes.length, 2);
  assert.equal(committed.scopes.every((installedScope) => installedScope.client_id === committed.client_id), true);
  assert.notEqual(committed.client_id, oldCredentials.client_id);
  const clients = new LocalRepository({ home: setup.switchboardHome });
  assert.equal(clients.listClients().find((client) => client.client_id === oldCredentials.client_id).revoked_at !== null, true);
  clients.close();
});

test("corrupt credentials revoke the superseded host client only after replacement commits", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const credentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  const oldClientId = JSON.parse(readFileSync(credentials, "utf8")).client_id;
  writeFileSync(credentials, "{corrupt", { mode: 0o600 });
  const reinstall = setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]);
  assert.equal(reinstall.status, 0, reinstall.stderr);
  const newClientId = JSON.parse(readFileSync(credentials, "utf8")).client_id;
  assert.notEqual(newClientId, oldClientId);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const clients = repository.listClients().filter((client) => client.host === "codex");
  assert.equal(clients.filter((client) => !client.revoked_at).length, 1);
  assert.equal(clients.find((client) => client.client_id === oldClientId).revoked_at !== null, true);
  assert.equal(repository.listGrants().filter((grant) => !grant.revoked_at).length, 1);
  repository.close();
});

test("the last scope can explicitly keep its host client and credentials", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const credentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  const uninstall = setup.run([
    "coding", "uninstall", "--target", "codex", "--project", setup.project, "--keep-client",
  ]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(credentials), true);
  assert.equal(stateFor(setup, "codex").scopes.length, 0);
  assert.equal(activeInstallerRecords(setup, "codex").clients.length, 1);
  assert.equal(activeInstallerRecords(setup, "codex").grants.length, 1);
});

test("missing or corrupt install state makes uninstall fail closed", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const config = path.join(setup.project, ".codex", "hooks.json");
  const credentials = path.join(setup.ownerHome, ".local", "share", "switchboard", "codex-credentials.json");
  const configBefore = readFileSync(config, "utf8");
  const credentialBefore = readFileSync(credentials, "utf8");
  writeFileSync(path.join(setup.switchboardHome, "coding-installations", "codex.json"), "{broken");
  const uninstall = setup.run(["coding", "uninstall", "--target", "codex", "--project", setup.project]);
  assert.equal(uninstall.status, 2);
  assert.match(uninstall.stderr, /no changes were made/);
  assert.equal(readFileSync(config, "utf8"), configBefore);
  assert.equal(readFileSync(credentials, "utf8"), credentialBefore);
  assert.equal(activeInstallerRecords(setup, "codex").clients.length, 1);
});

test("locked and mid-migration stores make the hook exit silently", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const databasePath = path.join(setup.switchboardHome, "passport.db");
  const db = new Database(databasePath);
  db.exec("BEGIN EXCLUSIVE");
  const started = performance.now();
  const locked = setup.run(["hook", "codex-prefetch"], { prompt: "anything" });
  const elapsed = performance.now() - started;
  assert.equal(locked.status, 0);
  assert.equal(locked.stdout, "");
  assert.equal(locked.stderr, "");
  assert.ok(elapsed < 2_100, `locked hook took ${elapsed}ms`);
  db.exec("ROLLBACK");
  db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
  db.close();
  const migrating = setup.run(["hook", "codex-prefetch"], { prompt: "anything" });
  assert.equal(migrating.status, 0);
  assert.equal(migrating.stdout, "");
  assert.equal(migrating.stderr, "");
});

test("large generated stores cannot hold the configured hook past its outer deadline", (t) => {
  const setup = fixture(t);
  hostStub(setup.bin, "codex");
  assert.equal(setup.run(["init"]).status, 0);
  assert.equal(setup.run(["coding", "install", "--targets", "codex", "--project", setup.project]).status, 0);
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const insertProposal = repository.db.prepare(`
    INSERT INTO proposals(proposal_id, save_id, memory_id, category, content_version, source, client_id,
      evidence_basis, status, created_at, occurred_at, disposition)
    VALUES (?, ?, ?, 'fact', 1, 'owner', NULL, 'owner_statement', 'approved', ?, ?, 'approved')
  `);
  const insertMemory = repository.db.prepare(`
    INSERT INTO memories(memory_id, proposal_id, content_version, source, client_id, category,
      evidence_basis, created_at, occurred_at, deleted_at)
    VALUES (?, ?, 1, 'owner', NULL, 'fact', 'owner_statement', ?, ?, NULL)
  `);
  const insertContent = repository.db.prepare(`
    INSERT INTO content_records(source_event_id, entity_id, content_version, owner_id, content, created_at)
    VALUES (?, ?, 1, 'owner', ?, ?)
  `);
  repository.db.transaction(() => {
    const now = new Date().toISOString();
    for (let index = 0; index < 20_000; index += 1) {
      const proposal = `large-proposal-${index}`;
      const memory = `large-memory-${index}`;
      insertProposal.run(proposal, `large-save-${index}`, memory, now, now);
      insertMemory.run(memory, proposal, now, now);
      insertContent.run(`large-event-${index}`, proposal, `generated corpus row ${index} needle`, now);
    }
  })();
  repository.close();
  const started = performance.now();
  const hook = setup.run(["hook", "codex-prefetch"], { prompt: "needle" });
  const elapsed = performance.now() - started;
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stderr, "");
  assert.ok(elapsed < 2_100, `large-corpus hook took ${elapsed}ms`);
  if (hook.stdout) assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});
