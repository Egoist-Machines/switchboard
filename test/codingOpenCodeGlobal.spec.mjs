import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

import { DEFAULT_OPENCODE_PLUGIN } from "../src/coding.js";
import { LocalRepository } from "../src/repository.js";

const cli = new URL("../src/cli.js", import.meta.url);

function fixture(t, { xdg = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "switchboard-opencode-global-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerHome = path.join(root, "home");
  const switchboardHome = path.join(ownerHome, ".switchboard");
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  const opencodeState = path.join(root, "opencode-state");
  const xdgConfigHome = path.join(root, "xdg-config");
  for (const directory of [ownerHome, project, bin, opencodeState]) mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    HOME: ownerHome,
    SWITCHBOARD_HOME: switchboardHome,
    OPENCODE_STATE_DIR: opencodeState,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.XDG_CONFIG_HOME;
  if (xdg) env.XDG_CONFIG_HOME = xdgConfigHome;
  const run = (args, { cwd = project, envOverrides = {} } = {}) => spawnSync(process.execPath, [cli.pathname, ...args], {
    cwd,
    env: { ...env, ...envOverrides },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    root, ownerHome, switchboardHome, project, bin, opencodeState, xdgConfigHome, env, run,
  };
}

function hostStub(directory, name = "opencode") {
  const target = path.join(directory, name);
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(target, 0o755);
}

function npmPluginStub(directory) {
  const pluginName = DEFAULT_OPENCODE_PLUGIN.name;
  const target = path.join(directory, "npm");
  writeFileSync(target, `#!/bin/sh
mkdir -p "$PWD/node_modules/${pluginName}/src" "$PWD/node_modules/transitive-package"
printf '%s\\n' '{"type":"module"}' > "$PWD/node_modules/${pluginName}/package.json"
printf '%s\\n' 'export function createLocalTransport() { return { prefetch: async () => ({ status: "results" }) }; }' > "$PWD/node_modules/${pluginName}/src/localTransport.js"
printf '%s\\n' transitive > "$PWD/node_modules/transitive-package/index.js"
printf '%s\\n' internal-lock > "$PWD/node_modules/.package-lock.json"
`, { mode: 0o755 });
  chmodSync(target, 0o755);
}

function prepare(setup) {
  hostStub(setup.bin);
  npmPluginStub(setup.bin);
  const initialized = setup.run(["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
}

function stateFor(setup, host = "opencode") {
  return JSON.parse(readFileSync(
    path.join(setup.switchboardHome, "coding-installations", `${host}.json`), "utf8",
  ));
}

function writeState(setup, state) {
  writeFileSync(
    path.join(setup.switchboardHome, "coding-installations", "opencode.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function expectedScopeId(setup, value) {
  const repository = new LocalRepository({ home: setup.switchboardHome });
  const scopeId = repository.scopeFingerprint(value);
  repository.close();
  return scopeId;
}

function globalConfigDirectory(setup) {
  return path.join(setup.env.XDG_CONFIG_HOME ?? path.join(setup.ownerHome, ".config"), "opencode");
}

test("OpenCode defaults to the XDG global config and falls back to the fake home config", (t) => {
  for (const xdg of [true, false]) {
    const setup = fixture(t, { xdg });
    prepare(setup);
    const installed = setup.run(["coding", "install", "--targets", "opencode"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /verification: passed_results/);

    const directory = globalConfigDirectory(setup);
    assert.equal(existsSync(path.join(directory, "package.json")), true);
    assert.equal(existsSync(path.join(
      directory, "node_modules", DEFAULT_OPENCODE_PLUGIN.name, "src", "localTransport.js",
    )), true);
    assert.equal(existsSync(path.join(directory, "plugin", "ai-passport.js")), true);
    assert.equal(existsSync(path.join(setup.project, ".opencode")), false);

    const scope = stateFor(setup).scopes[0];
    assert.equal(scope.scope_id, expectedScopeId(setup, "coding-install:opencode:user"));
    assert.equal(scope.opencode_scope, "user");
    assert.equal(scope.project, null);
    assert.equal(scope.last_verification, "passed_results");
    const status = setup.run(["coding", "status"]);
    const doctor = setup.run(["coding", "doctor"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(status.stdout, /opencode: installed=yes .* verification=passed_results/);
    assert.match(doctor.stdout, /opencode: discovered=yes verification=passed_results/);
  }
});

test("OpenCode --project keeps the project layout and a fully owned uninstall removes it all", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const installed = setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  const directory = path.join(setup.project, ".opencode");
  assert.equal(readFileSync(path.join(directory, ".gitignore"), "utf8"), "*\n");
  assert.equal(existsSync(path.join(directory, "package-lock.json")), false);
  assert.equal(existsSync(path.join(directory, "node_modules", ".package-lock.json")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", "transitive-package")), true);
  const scope = stateFor(setup).scopes[0];
  assert.equal(scope.scope_id, expectedScopeId(setup, `coding-install:opencode:project:${setup.project}`));
  assert.equal(scope.opencode_scope, "project");
  assert.equal(scope.node_modules_created, true);
  assert.equal(scope.gitignore_created, true);

  const uninstalled = setup.run([
    "coding", "uninstall", "--target", "opencode", "--project", setup.project,
  ]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(directory), false);
});

test("global OpenCode merges foreign package state and conservative uninstall keeps its tree", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const directory = globalConfigDirectory(setup);
  const packageJsonPath = path.join(directory, "package.json");
  const opencodeJsonc = "{\n  // owner config\n}\n";
  const authBody = "owner-auth\n";
  mkdirSync(path.join(directory, "node_modules", "foreign-package"), { recursive: true });
  writeFileSync(path.join(directory, "opencode.jsonc"), opencodeJsonc);
  writeFileSync(path.join(directory, "auth.json"), authBody);
  writeFileSync(path.join(directory, "package-lock.json"), "owner-lock\n");
  writeFileSync(path.join(directory, "node_modules", "foreign-package", "index.js"), "foreign\n");
  writeFileSync(packageJsonPath, `${JSON.stringify({
    private: true, dependencies: { "foreign-package": "1.0.0" },
  }, null, 2)}\n`);

  const installed = setup.run(["coding", "install", "--targets", "opencode"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), {
    private: true,
    dependencies: {
      "foreign-package": "1.0.0",
      [DEFAULT_OPENCODE_PLUGIN.name]: DEFAULT_OPENCODE_PLUGIN.spec,
    },
  });
  assert.equal(readFileSync(path.join(directory, "opencode.jsonc"), "utf8"), opencodeJsonc);
  assert.equal(readFileSync(path.join(directory, "auth.json"), "utf8"), authBody);
  assert.equal(stateFor(setup).scopes[0].package_json_created, false);
  assert.equal(stateFor(setup).scopes[0].node_modules_created, false);
  assert.equal(readdirSync(directory).some((name) => name.startsWith("package.json.switchboard-backup-")), true);

  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), {
    private: true, dependencies: { "foreign-package": "1.0.0" },
  });
  assert.equal(existsSync(path.join(directory, "node_modules")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", "foreign-package", "index.js")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", "transitive-package")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", DEFAULT_OPENCODE_PLUGIN.name)), false);
  assert.equal(existsSync(path.join(directory, "package-lock.json")), true);
  assert.equal(existsSync(path.join(directory, "plugin")), false);
  assert.equal(readFileSync(path.join(directory, "opencode.jsonc"), "utf8"), opencodeJsonc);
  assert.equal(readFileSync(path.join(directory, "auth.json"), "utf8"), authBody);
});

test("fully owned global uninstall removes installer artifacts but never the config directory", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const directory = globalConfigDirectory(setup);
  const opencodeJsonc = "{\n  // retained\n}\n";
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "opencode.jsonc"), opencodeJsonc);
  writeFileSync(path.join(directory, "session-auth"), "retained\n");
  assert.equal(setup.run(["coding", "install", "--targets", "opencode"]).status, 0);
  assert.equal(stateFor(setup).scopes[0].node_modules_created, true);
  assert.equal(setup.run(["coding", "install", "--targets", "opencode"]).status, 0);
  assert.equal(stateFor(setup).scopes[0].node_modules_created, true);

  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(directory), true);
  assert.equal(readFileSync(path.join(directory, "opencode.jsonc"), "utf8"), opencodeJsonc);
  assert.equal(readFileSync(path.join(directory, "session-auth"), "utf8"), "retained\n");
  assert.equal(existsSync(path.join(directory, "package.json")), false);
  assert.equal(existsSync(path.join(directory, "package-lock.json")), false);
  assert.equal(existsSync(path.join(directory, "node_modules")), false);
  assert.equal(existsSync(path.join(directory, "plugin")), false);
});

test("generated manifest with a later dev dependency keeps owner package artifacts", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const directory = globalConfigDirectory(setup);
  const packageJsonPath = path.join(directory, "package.json");
  assert.equal(setup.run(["coding", "install", "--targets", "opencode"]).status, 0);
  assert.equal(stateFor(setup).scopes[0].package_json_created, true);
  assert.equal(stateFor(setup).scopes[0].node_modules_created, true);

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  manifest.devDependencies = { "owner-tool": "2.0.0" };
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(path.join(directory, "node_modules", "owner-tool"), { recursive: true });
  writeFileSync(path.join(directory, "node_modules", "owner-tool", "index.js"), "owner\n");
  writeFileSync(path.join(directory, "package-lock.json"), "owner-lock\n");

  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), {
    dependencies: {},
    devDependencies: { "owner-tool": "2.0.0" },
  });
  assert.equal(readFileSync(path.join(directory, "package-lock.json"), "utf8"), "owner-lock\n");
  assert.equal(readFileSync(path.join(directory, "node_modules", "owner-tool", "index.js"), "utf8"), "owner\n");
  assert.equal(existsSync(path.join(directory, "node_modules", "transitive-package")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", DEFAULT_OPENCODE_PLUGIN.name)), false);
});

test("pre-existing node_modules is recorded as foreign and kept on uninstall", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const directory = globalConfigDirectory(setup);
  mkdirSync(path.join(directory, "node_modules", "owner-cache"), { recursive: true });
  writeFileSync(path.join(directory, "node_modules", "owner-cache", "sentinel"), "owner\n");

  assert.equal(setup.run(["coding", "install", "--targets", "opencode"]).status, 0);
  assert.equal(stateFor(setup).scopes[0].node_modules_created, false);
  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(path.join(directory, "package.json")), false);
  assert.equal(readFileSync(path.join(directory, "node_modules", "owner-cache", "sentinel"), "utf8"), "owner\n");
  assert.equal(existsSync(path.join(directory, "node_modules", DEFAULT_OPENCODE_PLUGIN.name)), false);
});

test("legacy OpenCode scope without node_modules ownership keeps the tree", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const directory = globalConfigDirectory(setup);
  assert.equal(setup.run(["coding", "install", "--targets", "opencode"]).status, 0);
  const state = stateFor(setup);
  delete state.scopes[0].node_modules_created;
  writeState(setup, state);

  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(path.join(directory, "package.json")), false);
  assert.equal(existsSync(path.join(directory, "node_modules")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", "transitive-package")), true);
  assert.equal(existsSync(path.join(directory, "node_modules", DEFAULT_OPENCODE_PLUGIN.name)), false);
});

test("project install never clobbers or removes a pre-existing .gitignore", (t) => {
  const setup = fixture(t);
  prepare(setup);
  const directory = path.join(setup.project, ".opencode");
  const gitignorePath = path.join(directory, ".gitignore");
  mkdirSync(directory, { recursive: true });
  writeFileSync(gitignorePath, "!.keep\n");
  const installed = setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(gitignorePath, "utf8"), "!.keep\n");
  assert.equal(stateFor(setup).scopes[0].gitignore_created, false);

  const uninstalled = setup.run([
    "coding", "uninstall", "--target", "opencode", "--project", setup.project,
  ]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(readFileSync(gitignorePath, "utf8"), "!.keep\n");
});

test("pre-change project-only OpenCode state still reports, verifies, and uninstalls", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  assert.equal(setup.run([
    "coding", "install", "--targets", "opencode", "--project", setup.project,
  ]).status, 0);
  const state = stateFor(setup);
  delete state.scopes[0].opencode_scope;
  delete state.scopes[0].gitignore_created;
  rmSync(path.join(setup.project, ".opencode", ".gitignore"));
  writeState(setup, state);

  const status = setup.run(["coding", "status", "--project", setup.project]);
  const doctor = setup.run(["coding", "doctor", "--project", setup.project]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(status.stdout, /opencode: installed=yes .* config=present/);
  assert.match(doctor.stdout, /opencode: discovered=yes verification=passed_results/);
  const uninstalled = setup.run([
    "coding", "uninstall", "--target", "opencode", "--project", setup.project,
  ]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(path.join(setup.project, ".opencode")), false);
});

test("OpenCode --global is accepted and reports retained project scopes", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  const project = realpathSync(setup.project);
  assert.equal(setup.run([
    "coding", "install", "--targets", "opencode", "--project", project,
  ]).status, 0);
  const installed = setup.run([
    "coding", "install", "--targets", "opencode", "--global",
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Existing OpenCode project scopes remain:/);
  assert.match(installed.stdout, new RegExp(`--project '${project.replaceAll("\\", "\\\\")}'`));
  assert.equal(stateFor(setup).scopes.length, 2);

  const otherProject = path.join(setup.root, "other-project");
  mkdirSync(otherProject);
  const status = setup.run(["coding", "status", "--project", otherProject]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /opencode: installed=no \(2 other scopes\)/);
  const uninstalled = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(globalConfigDirectory(setup)), true);
  assert.equal(stateFor(setup).scopes.length, 1);
  assert.equal(stateFor(setup).scopes[0].opencode_scope, "project");
  assert.equal(
    stateFor(setup).scopes[0].scope_id,
    expectedScopeId(setup, `coding-install:opencode:project:${project}`),
  );
  const fallbackStatus = setup.run(["coding", "status"]);
  assert.equal(fallbackStatus.status, 0, fallbackStatus.stderr);
  assert.match(fallbackStatus.stdout, /opencode: installed=yes/);
  const fallback = setup.run(["coding", "uninstall", "--target", "opencode"]);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(existsSync(path.join(project, ".opencode")), false);
});

test("coding install --global selects discovered Claude Code and OpenCode hosts", (t) => {
  const setup = fixture(t, { xdg: true });
  prepare(setup);
  hostStub(setup.bin, "claude");
  hostStub(setup.bin, "codex");

  const installed = setup.run(["coding", "install", "--global"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal((installed.stdout.match(/verification: passed_/g) ?? []).length, 2);
  assert.equal(stateFor(setup, "claude-code").scopes.length, 1);
  assert.equal(stateFor(setup, "opencode").scopes.length, 1);
  assert.equal(existsSync(path.join(setup.switchboardHome, "coding-installations", "codex.json")), false);

  const codex = setup.run(["coding", "install", "--targets", "codex", "--global"]);
  assert.equal(codex.status, 2);
  assert.equal(codex.stderr, "Only Claude Code and OpenCode support --global\n");
});
