import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { CODING_PROFILE_CATEGORIES, SCHEMA_VERSION } from "./constants.js";
import {
  codexHookStateKey, codexHookTrustedHash, findSwitchboardHookIndices,
  readTrustEntry, removeTrustEntry, upsertTrustEntry,
} from "./codexTrust.js";
import { hostCredentialPath, loadHostCredentials } from "./hook.js";

const HOSTS = Object.freeze(["opencode", "claude-code", "codex"]);
const STATE_VERSION = 2;
const HOOK_TIMEOUT_SECONDS = 2;
const STATE_REMEDIATION = "Coding install state is missing or invalid; no changes were made. Re-run coding install to repair it.";
const DEFAULT_OPENCODE_PLUGIN = Object.freeze({
  name: "@egoistmachines/opencode-switchboard",
  // The spec is the dependency value written into .opencode/package.json,
  // so it must be a plain pinned version, not a name@version specifier.
  spec: "0.1.2",
});
const LEGACY_OPENCODE_PLUGIN_NAME = "opencode-ai-passport";
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function opencodeEntry(pluginName) {
  return `import { AIPassportPlugin } from "${pluginName}";

const options = {
  categories: ["preference", "fact", "project", "instruction"],
  ambient: { enabled: true, maxRows: 6, maxChars: 2000, timeoutMs: 1500 },
  handoff: { enabled: true },
  hostedFallback: { enabled: false },
};

export const AIPassport = async (input) => AIPassportPlugin(input, options);
`;
}

const OPENCODE_ENTRY = opencodeEntry(DEFAULT_OPENCODE_PLUGIN.name);

function ownerHome(env = process.env) {
  return typeof env.HOME === "string" && env.HOME.trim() ? path.resolve(env.HOME) : os.homedir();
}

function codexHome(env = process.env) {
  return typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
    ? path.resolve(env.CODEX_HOME) : path.join(ownerHome(env), ".codex");
}

function codexUserConfigPath(env = process.env) {
  return path.join(codexHome(env), "config.toml");
}

function statePath(home, host) {
  return path.join(home, "coding-installations", `${host}.json`);
}

const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const encode = (body) => Buffer.from(body, "utf8").toString("base64");
const decode = (body) => Buffer.from(body, "base64").toString("utf8");

function validScope(value) {
  return plainObject(value) && typeof value.scope_id === "string" && value.scope_id &&
    typeof value.entry_b64 === "string" && value.entry_b64 && encode(decode(value.entry_b64)) === value.entry_b64 && plainObject(value.config) &&
    typeof value.config.requested_path === "string" && typeof value.config.target_path === "string" &&
    ["file", "symlink"].includes(value.config.topology) &&
    (!Object.hasOwn(value, "plugin_name") || (typeof value.plugin_name === "string" && value.plugin_name)) &&
    (!Object.hasOwn(value, "plugin_spec") || (typeof value.plugin_spec === "string" && value.plugin_spec)) &&
    (!Object.hasOwn(value, "package_json_created") || typeof value.package_json_created === "boolean");
}

function emptyState(host) {
  return { version: STATE_VERSION, host, client_id: null, scopes: [], transaction: null };
}

function readState(home, host, { required = false } = {}) {
  const target = statePath(home, host);
  if (!existsSync(target)) {
    if (required) throw new Error(STATE_REMEDIATION);
    return emptyState(host);
  }
  try {
    if (!lstatSync(target).isFile()) throw new Error("unsafe state file");
    const value = JSON.parse(readFileSync(target, "utf8"));
    if (!plainObject(value) || value.version !== STATE_VERSION || value.host !== host ||
      !(value.client_id === null || typeof value.client_id === "string") ||
      !Array.isArray(value.scopes) || !value.scopes.every(validScope) ||
      !(value.transaction === null || plainObject(value.transaction))) throw new Error("invalid state");
    return value;
  } catch {
    throw new Error(STATE_REMEDIATION);
  }
}

function writePrivateJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function writeState(home, state) {
  writePrivateJson(statePath(home, state.host), state);
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function backupPath(target) {
  let candidate = `${target}.switchboard-backup-${timestamp()}`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${target}.switchboard-backup-${timestamp()}-${suffix++}`;
  return candidate;
}

function backup(target) {
  if (!existsSync(target)) return null;
  const candidate = backupPath(target);
  copyFileSync(target, candidate);
  chmodSync(candidate, statSync(target).mode & 0o777);
  return candidate;
}

function emptyHookConfig(body) {
  try {
    const config = JSON.parse(body);
    if (!plainObject(config)) return false;
    const keys = Object.keys(config);
    if (!keys.length) return true;
    return keys.length === 1 && keys[0] === "hooks" && plainObject(config.hooks) &&
      Object.values(config.hooks).every((groups) => Array.isArray(groups) && !groups.length);
  } catch { return false; }
}

function atomicText(target, body, mode = 0o600) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  writeFileSync(temporary, body, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
  chmodSync(target, mode);
}

function resolveMissingTarget(target) {
  const missing = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...missing);
}

function configSnapshot(requestedPath) {
  const requested = path.resolve(requestedPath);
  let info;
  try {
    info = lstatSync(requested);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      identity: { requested_path: requested, target_path: resolveMissingTarget(requested), topology: "file" },
      existed: false, body: "", mode: 0o600,
    };
  }
  if (info.isSymbolicLink()) {
    let resolved;
    try { resolved = realpathSync(requested); } catch { throw new Error("host config symlink must resolve to a regular file"); }
    if (!statSync(resolved).isFile()) throw new Error("host config must be a regular file");
    return {
      identity: { requested_path: requested, target_path: resolved, topology: "symlink", link_target: readlinkSync(requested) },
      existed: true, body: readFileSync(resolved, "utf8"), mode: statSync(resolved).mode & 0o777,
    };
  }
  if (!info.isFile()) throw new Error("host config must be a regular file");
  const resolved = realpathSync(requested);
  return {
    identity: { requested_path: requested, target_path: resolved, topology: "file" },
    existed: true, body: readFileSync(resolved, "utf8"), mode: statSync(resolved).mode & 0o777,
  };
}

function sameIdentity(left, right) {
  return left?.requested_path === right?.requested_path && left?.target_path === right?.target_path &&
    left?.topology === right?.topology && left?.link_target === right?.link_target;
}

function validateHookConfigBody(body, existed) {
  const value = existed ? JSON.parse(body) : {};
  if (!plainObject(value)) throw new Error("host config must contain one JSON object");
  if (Object.hasOwn(value, "hooks") && !plainObject(value.hooks)) throw new Error("host config hooks must be an object");
  const groups = value.hooks?.UserPromptSubmit;
  if (value.hooks && Object.hasOwn(value.hooks, "UserPromptSubmit") && !Array.isArray(groups)) {
    throw new Error("UserPromptSubmit hooks must be an array");
  }
  for (const group of groups ?? []) {
    if (!plainObject(group) || !Array.isArray(group.hooks)) throw new Error("UserPromptSubmit entries must contain a hooks array");
    for (const entry of group.hooks) {
      if (!plainObject(entry) || typeof entry.type !== "string" || !entry.type.trim() ||
        (entry.type === "command" && (typeof entry.command !== "string" || !entry.command.trim()))) {
        throw new Error("UserPromptSubmit contains an invalid hook entry");
      }
    }
  }
  return value;
}

function readCurrentLike(snapshot) {
  const current = configSnapshot(snapshot.identity.requested_path);
  if (!sameIdentity(current.identity, snapshot.identity)) throw new Error("host config identity changed during installation");
  return current;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function hookCommand(binPath, host) {
  return `${shellQuote(binPath)} hook ${host === "codex" ? "codex-prefetch" : "claude-prefetch"}`;
}

function hookEntry(binPath, host) {
  return { hooks: [{
    type: "command", command: hookCommand(binPath, host), timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: "Checking AI Passport memory",
  }] };
}

const entryBytes = (value) => JSON.stringify(value);

function exactEntryIndex(config, entryB64) {
  return (config.hooks?.UserPromptSubmit ?? []).findIndex((group) => encode(entryBytes(group)) === entryB64);
}

function configuredCommand(entryB64) {
  try {
    const command = JSON.parse(decode(entryB64))?.hooks?.[0]?.command;
    return typeof command === "string" ? command : null;
  } catch { return null; }
}

function mergeHookInstall(config, desired, previous) {
  const result = structuredClone(config);
  const hooksExisted = plainObject(result.hooks);
  const eventExisted = Array.isArray(result.hooks?.UserPromptSubmit);
  if (!result.hooks) result.hooks = {};
  if (!result.hooks.UserPromptSubmit) result.hooks.UserPromptSubmit = [];
  if (previous) {
    const oldIndex = exactEntryIndex(result, previous.entry_b64);
    if (oldIndex >= 0) result.hooks.UserPromptSubmit.splice(oldIndex, 1);
    else {
      const suffix = previous.host === "codex" ? " hook codex-prefetch" : " hook claude-prefetch";
      const suspicious = result.hooks.UserPromptSubmit.some((group) =>
        group.hooks.some((entry) => entry.type === "command" && entry.command.endsWith(suffix)));
      if (suspicious) throw new Error("recorded hook changed; refusing to replace an unowned entry");
    }
  }
  result.hooks.UserPromptSubmit.push(desired);
  return { value: result, metadata: previous?.metadata ?? { hooks_existed: hooksExisted, event_existed: eventExisted } };
}

function mergeHookRemoval(config, scope) {
  const result = structuredClone(config);
  const index = exactEntryIndex(result, scope.entry_b64);
  if (index < 0) throw new Error(STATE_REMEDIATION);
  result.hooks.UserPromptSubmit.splice(index, 1);
  if (!result.hooks.UserPromptSubmit.length && !scope.metadata?.event_existed) delete result.hooks.UserPromptSubmit;
  if (!Object.keys(result.hooks).length && !scope.metadata?.hooks_existed) delete result.hooks;
  return result;
}

function casJsonMutation(initial, merge, { env, beforeWrite } = {}) {
  let snapshot = initial;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const config = validateHookConfigBody(snapshot.body, snapshot.existed);
    const merged = merge(config);
    const body = `${JSON.stringify(merged.value ?? merged, null, 2)}\n`;
    if (attempt === 0 && env?.SWITCHBOARD_CODING_TEST_CAS_EDIT) {
      const edit = JSON.parse(env.SWITCHBOARD_CODING_TEST_CAS_EDIT);
      atomicText(snapshot.identity.target_path, `${JSON.stringify(edit, null, 2)}\n`, snapshot.mode);
    }
    const current = readCurrentLike(snapshot);
    if (current.existed !== snapshot.existed || current.body !== snapshot.body) {
      if (attempt === 1) throw new Error("host config changed twice; refusing to overwrite it");
      snapshot = current;
      continue;
    }
    beforeWrite?.(snapshot, body, merged.metadata ?? null);
    if (snapshot.existed && !emptyHookConfig(snapshot.body)) backup(snapshot.identity.target_path);
    atomicText(snapshot.identity.target_path, body, snapshot.mode);
    return { original: snapshot, body, metadata: merged.metadata ?? null };
  }
  throw new Error("host config changed twice; refusing to overwrite it");
}

function executableOnPath(name, env = process.env) {
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try { if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0) return true; } catch {}
  }
  return false;
}

function hostPaths(host, { project, projectClaude = false, env = process.env } = {}) {
  const home = ownerHome(env);
  if (host === "claude-code") return {
    config: projectClaude ? path.join(project, ".claude", "settings.json") : path.join(home, ".claude", "settings.json"),
    credential: hostCredentialPath(host, { env, home }),
  };
  if (host === "codex") return {
    config: path.join(codexHome(env), "hooks.json"), credential: hostCredentialPath(host, { env, home }),
  };
  return {
    config: path.join(project, ".opencode", "plugin", "ai-passport.js"),
    credential: hostCredentialPath(host, { env, home }),
  };
}

export function discoverCodingHosts({ project = process.cwd(), env = process.env } = {}) {
  const home = ownerHome(env);
  return {
    "claude-code": executableOnPath("claude", env) || existsSync(path.join(home, ".claude")),
    codex: executableOnPath("codex", env) || existsSync(codexHome(env)),
    opencode: executableOnPath("opencode", env) || existsSync(hostCredentialPath("opencode", { env, home })) || existsSync(path.join(project, ".opencode")),
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function parseTargets(value) {
  if (value == null) return null;
  const targets = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (!targets.length || targets.some((host) => !HOSTS.includes(host))) throw new Error("invalid coding target");
  return targets;
}

function scopeId(repository, host, { project, projectClaude }) {
  const scope = (host === "claude-code" && !projectClaude) || host === "codex" ? "user" : `project:${project}`;
  return repository.scopeFingerprint(`coding-install:${host}:${scope}`);
}

const currentScope = (state, scope) => state.scopes.find((entry) => entry.scope_id === scope) ?? null;

function legacyCodexProjectScopeId(repository, project) {
  return repository.scopeFingerprint(`coding-install:codex:project:${project}`);
}

function selectedScope(state, repository, host, { project, projectClaude }) {
  if (host === "codex") {
    const legacy = currentScope(state, legacyCodexProjectScopeId(repository, project));
    if (legacy) return legacy;
  }
  return currentScope(state, scopeId(repository, host, { project, projectClaude }));
}

function activeClient(repository, host, credentialPath, expectedClientId = null) {
  try {
    if ((statSync(credentialPath).mode & 0o077) !== 0) return null;
    const credentials = JSON.parse(readFileSync(credentialPath, "utf8"));
    if (expectedClientId && credentials.client_id !== expectedClientId) return null;
    const client = repository.listClients().find((entry) =>
      entry.client_id === credentials.client_id && entry.host === host && !entry.revoked_at);
    if (!client || !repository.authenticate(credentials.client_id, credentials.client_secret)) return null;
    return { ...client, client_secret: credentials.client_secret };
  } catch { return null; }
}

function revokeClientAndGrants(repository, clientId) {
  if (!clientId) return;
  repository.db.transaction(() => {
    for (const grant of repository.listGrants(clientId)) if (!grant.revoked_at) repository.revokeGrant(grant.grant_id);
    repository.revokeClient(clientId);
  })();
}

function snapshotFile(target) {
  try {
    const info = lstatSync(target);
    if (!info.isFile()) throw new Error("credential path must be a regular file");
    return { path: target, existed: true, body_b64: encode(readFileSync(target, "utf8")), mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: target, existed: false, body_b64: "", mode: 0o600 };
    throw error;
  }
}

function restoreFile(snapshot) {
  if (!snapshot) return;
  if (snapshot.existed) atomicText(snapshot.path, decode(snapshot.body_b64), snapshot.mode);
  else {
    try { unlinkSync(snapshot.path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function injectAfterPhase(env, phase) {
  if (env.SWITCHBOARD_CODING_CRASH_AFTER_PHASE === phase) process.exit(86);
  if (env.SWITCHBOARD_CODING_FAIL_AFTER_PHASE === phase) throw new Error(`injected failure after ${phase}`);
}

function injectAfterMutation(env, mutation) {
  if (env.SWITCHBOARD_CODING_CRASH_AFTER_MUTATION === mutation) process.exit(86);
}

function journalPhase(home, state, phase, additions = {}) {
  state.transaction = { ...state.transaction, ...additions, phase };
  writeState(home, state);
}

function openCodePaths(project, pluginName) {
  const directory = path.join(project, ".opencode");
  return {
    directory,
    package_json_path: path.join(directory, "package.json"),
    package_path: path.join(directory, "node_modules", pluginName),
  };
}

function readOpenCodePackageJson(project) {
  const { package_json_path: packageJsonPath } = openCodePaths(project, DEFAULT_OPENCODE_PLUGIN.name);
  let info;
  try {
    info = lstatSync(packageJsonPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: packageJsonPath, existed: false, body: "", mode: 0o600, value: null };
    }
    throw error;
  }
  try {
    if (!info.isFile()) throw new Error("not a regular file");
    const body = readFileSync(packageJsonPath, "utf8");
    const value = JSON.parse(body);
    if (!plainObject(value)) throw new Error("not an object");
    return { path: packageJsonPath, existed: true, body, mode: info.mode & 0o777, value };
  } catch {
    throw new Error(".opencode/package.json exists and is not valid JSON");
  }
}

function managedOpenCodePackageBody(snapshot, pluginName, pluginSpec) {
  if (!snapshot.existed) return `${JSON.stringify({ dependencies: { [pluginName]: pluginSpec } })}\n`;
  const value = structuredClone(snapshot.value);
  if (!plainObject(value.dependencies)) value.dependencies = {};
  value.dependencies[pluginName] = pluginSpec;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replacedOpenCodePlugin(snapshot, plugin, previous) {
  const previousPluginName = previous?.plugin_name;
  if (!previousPluginName || previousPluginName === plugin.name || !plainObject(snapshot.value?.dependencies)) return null;
  return snapshot.value.dependencies[previousPluginName] === previous.plugin_spec ? previousPluginName : null;
}

function reconciledOpenCodePackageBody(snapshot, plugin, removedPluginName) {
  if (!snapshot.existed) return managedOpenCodePackageBody(snapshot, plugin.name, plugin.spec);
  const value = structuredClone(snapshot.value);
  if (!plainObject(value.dependencies)) value.dependencies = {};
  if (removedPluginName) delete value.dependencies[removedPluginName];
  value.dependencies[plugin.name] = plugin.spec;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function switchboardManagedOpenCodePackage(snapshot, pluginName, pluginSpec) {
  return snapshot.existed && (snapshot.body === managedOpenCodePackageBody(snapshot, pluginName, pluginSpec) ||
    snapshot.body === `${JSON.stringify({ dependencies: { [pluginName]: pluginSpec } })}\n`);
}

function resolveOpenCodePlugin(tarball) {
  if (!tarball) return DEFAULT_OPENCODE_PLUGIN;
  const archive = path.resolve(tarball);
  try {
    const result = spawnSync("tar", ["-xzOf", archive, "package/package.json"], {
      encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error) throw new Error("tar failed");
    const { name } = JSON.parse(result.stdout);
    if (typeof name !== "string" || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) {
      throw new Error("invalid package name");
    }
    return { name, spec: `file:${archive}` };
  } catch {
    throw new Error("OpenCode plugin tarball is unreadable");
  }
}

function restoreOpenCodeDependency(record) {
  if (!record) return;
  const project = path.dirname(path.dirname(record.package_json_path));
  rmSync(openCodePaths(project, record.plugin_name).package_path, {
    recursive: true, force: true,
  });
  if (record.removed_package_backup_path) {
    const removedPackagePath = openCodePaths(project, record.removed_plugin_name).package_path;
    if (existsSync(record.removed_package_backup_path)) {
      if (existsSync(removedPackagePath)) throw new Error("removed OpenCode package and its backup both exist");
      mkdirSync(path.dirname(removedPackagePath), { recursive: true });
      renameSync(record.removed_package_backup_path, removedPackagePath);
    } else if (!existsSync(removedPackagePath)) {
      throw new Error("removed OpenCode package backup is missing");
    }
  }
  if (record.original_existed) atomicText(record.package_json_path, decode(record.original_body_b64), record.original_mode);
  else {
    try { unlinkSync(record.package_json_path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function fileMatchesSnapshot(snapshot) {
  try {
    if (!snapshot.existed) return !existsSync(snapshot.path);
    const info = lstatSync(snapshot.path);
    return info.isFile() && (info.mode & 0o777) === snapshot.mode &&
      readFileSync(snapshot.path, "utf8") === decode(snapshot.body_b64);
  } catch { return false; }
}

function restoreCodexTrust(record) {
  if (!record?.installed_body_b64 || typeof record.state_key !== "string") {
    if (!fileMatchesSnapshot(record)) restoreFile(record);
    if (!fileMatchesSnapshot(record)) throw new Error("Codex trust restoration did not verify");
    return;
  }
  const current = snapshotFile(record.path);
  const currentBody = decode(current.body_b64);
  if (current.existed && currentBody === decode(record.installed_body_b64)) {
    restoreFile(record);
    if (!fileMatchesSnapshot(record)) throw new Error("Codex trust restoration did not verify");
    return;
  }
  const originalValue = readTrustEntry(decode(record.body_b64), record.state_key);
  const next = originalValue === null
    ? removeTrustEntry(currentBody, record.state_key)
    : upsertTrustEntry(currentBody, record.state_key, originalValue);
  if (next !== currentBody) atomicText(record.path, next, current.mode);
  const restored = snapshotFile(record.path);
  if (readTrustEntry(decode(restored.body_b64), record.state_key) !== originalValue) {
    throw new Error("Codex trust restoration did not verify");
  }
}

function restoreConfig(record) {
  if (!record?.installed_body_b64) return;
  const current = configSnapshot(record.identity.requested_path);
  if (!sameIdentity(current.identity, record.identity)) throw new Error("config identity changed underneath recovery");
  const originalBody = decode(record.original_body_b64);
  if ((record.original_existed && current.existed && current.body === originalBody) ||
      (!record.original_existed && !current.existed)) return;
  if (!current.existed || current.body !== decode(record.installed_body_b64)) {
    throw new Error("config changed underneath recovery");
  }
  if (record.original_existed) atomicText(record.identity.target_path, originalBody, record.original_mode);
  else {
    try { unlinkSync(record.identity.target_path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const restored = configSnapshot(record.identity.requested_path);
  if (!sameIdentity(restored.identity, record.identity) || restored.existed !== record.original_existed ||
      (record.original_existed && restored.body !== originalBody)) throw new Error("config restoration did not verify");
}

function revokeTransactionRecords(repository, transaction) {
  const owned = [];
  const needsAttention = [];
  repository.db.transaction(() => {
    const records = [
      {
        id: transaction.new_grant_id,
        eventId: transaction.new_grant_event_id,
        op: "grant_created",
        revoke: (id) => repository.revokeGrant(id),
      },
      {
        id: transaction.new_client_id,
        eventId: transaction.new_client_event_id,
        op: "client_paired",
        revoke: (id) => repository.revokeClient(id),
      },
    ];
    for (const record of records) {
      if (!record.id) continue;
      if (!record.eventId || repository.creationEventId(record.id, record.op) !== record.eventId) {
        needsAttention.push(record.op);
        continue;
      }
      record.revoke(record.id);
      owned.push(record);
    }
  })();
  const activeOwnedRecord = owned.some((record) => record.op === "grant_created"
    ? repository.listGrants().some((grant) => grant.grant_id === record.id && !grant.revoked_at)
    : repository.listClients().some((client) => client.client_id === record.id && !client.revoked_at));
  if (activeOwnedRecord) throw new Error("journal-owned client or grant is still active");
  if (needsAttention.length) {
    throw new Error("journaled creation ownership could not be verified; unmatched records were left unchanged");
  }
}

function compensationRemediation(home, state, step, error) {
  const transaction = state.transaction;
  if (step === "config") {
    const record = transaction.config;
    const action = record?.original_existed
      ? `restore ${record.identity.target_path} to the base64-decoded bytes in transaction.config.original_body_b64`
      : `remove the Switchboard-created file ${record?.identity?.target_path}`;
    return `${action} recorded in ${statePath(home, state.host)}, then run switchboard coding doctor`;
  }
  if (step === "package_restore") {
    return `restore ${transaction.package?.package_json_path} from transaction.package.original_body_b64 and remove its recorded plugin directory, then run switchboard coding doctor`;
  }
  if (step === "credential") {
    return `restore ${transaction.credential?.path} from transaction.credential in ${statePath(home, state.host)}, then run switchboard coding doctor`;
  }
  if (step === "trust") {
    return `restore ${transaction.trust?.path} from transaction.trust in ${statePath(home, state.host)}, then run switchboard coding doctor`;
  }
  return `resolve ${error.message} in the local client/grant store, then run switchboard coding doctor`;
}

function rollbackTransaction(repository, home, state, env = process.env) {
  const transaction = state.transaction;
  if (!transaction) return true;
  const completed = new Set(transaction.recovery?.completed ?? []);
  transaction.phase = "rolling_back";
  transaction.recovery = { status: "rolling_back", completed: [...completed], failures: [] };
  writeState(home, state);

  const steps = [];
  if (transaction.config?.installed_body_b64) steps.push(["config", () => restoreConfig(transaction.config)]);
  if (transaction.trust) steps.push(["trust", () => restoreCodexTrust(transaction.trust)]);
  if (transaction.package) steps.push(["package_restore", () => restoreOpenCodeDependency(transaction.package)]);
  if (transaction.credential_write) steps.push(["credential", () => {
    if (!fileMatchesSnapshot(transaction.credential)) restoreFile(transaction.credential);
    if (!fileMatchesSnapshot(transaction.credential)) throw new Error("credential restoration did not verify");
  }]);
  steps.push(["database", () => revokeTransactionRecords(repository, transaction)]);

  const failures = [];
  for (const [step, compensate] of steps) {
    if (completed.has(step)) continue;
    try {
      compensate();
      injectAfterMutation(env, `rollback_${step}`);
      completed.add(step);
      transaction.recovery = { status: "rolling_back", completed: [...completed], failures: [] };
      writeState(home, state);
    } catch (error) {
      failures.push({ step, error: error.message, remediation: compensationRemediation(home, state, step, error) });
    }
  }
  if (failures.length) {
    transaction.phase = "rollback_needs_attention";
    transaction.recovery = { status: "needs_attention", completed: [...completed], failures };
    writeState(home, state);
    return false;
  }
  state.transaction = null;
  writeState(home, state);
  return true;
}

function recoveryError(state) {
  const details = state.transaction?.recovery?.failures?.map((failure) => failure.remediation).join("; ");
  return new Error(`Coding recovery needs attention${details ? `: ${details}` : ""}`);
}

function recoverHost(repository, home, host, env = process.env) {
  const state = readState(home, host);
  if (state.transaction) {
    const recovered = state.transaction.commit
      ? finalizeTransactionCommit(repository, home, state, env)
      : rollbackTransaction(repository, home, state, env);
    if (!recovered) throw recoveryError(state);
  }
  return state;
}

function verifyHook({ host, repository, entryB64, env }) {
  let expected;
  try {
    const credentials = loadHostCredentials(host, { env });
    expected = repository.read({ ...credentials, categories: CODING_PROFILE_CATEGORIES, query: "", ambient: true });
  } catch { return "failed_credentials"; }
  const command = configuredCommand(entryB64);
  if (!command) return "failed_config";
  const child = spawnSync(command, {
    shell: true, env, input: JSON.stringify({ prompt: "" }), encoding: "utf8",
    timeout: 2_000, maxBuffer: 64 * 1024,
  });
  if (child.status !== 0 || child.error || child.stderr) return "failed_adapter";
  const shouldEmit = !["empty", "unavailable"].includes(expected.status);
  if (shouldEmit !== Boolean(child.stdout.trim())) return "failed_adapter";
  if (child.stdout.trim()) {
    try {
      const output = JSON.parse(child.stdout);
      if (output?.hookSpecificOutput?.hookEventName !== "UserPromptSubmit" ||
        typeof output?.hookSpecificOutput?.additionalContext !== "string") return "failed_adapter";
    } catch { return "failed_adapter"; }
  }
  return `passed_${expected.status}`;
}

const OPENCODE_VERIFY_SCRIPT = `
import { pathToFileURL } from "node:url";
const module = await import(pathToFileURL(process.env.SWITCHBOARD_OPENCODE_TRANSPORT).href);
const transport = module.createLocalTransport({
  discoveryPath: process.env.SWITCHBOARD_DISCOVERY_PATH,
  credentialsPath: process.env.SWITCHBOARD_OPENCODE_CREDENTIALS,
  timeoutMs: 1500,
});
const outcome = await transport.prefetch({ categories: ["preference", "fact", "project", "instruction"] });
process.stdout.write(JSON.stringify({ status: outcome.status }));
`;

function verifyOpenCode({ project, home, credentialPath, env, pluginName = DEFAULT_OPENCODE_PLUGIN.name, legacy = false }) {
  const transportPath = legacy
    ? path.join(project, "node_modules", LEGACY_OPENCODE_PLUGIN_NAME, "src", "localTransport.js")
    : path.join(project, ".opencode", "node_modules", pluginName, "src", "localTransport.js");
  if (!existsSync(transportPath)) return "failed_plugin_missing";
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", OPENCODE_VERIFY_SCRIPT], {
    env: { ...env, SWITCHBOARD_OPENCODE_TRANSPORT: transportPath,
      SWITCHBOARD_DISCOVERY_PATH: path.join(home, "runtime.json"),
      SWITCHBOARD_OPENCODE_CREDENTIALS: credentialPath },
    encoding: "utf8", timeout: 3_000, maxBuffer: 64 * 1024,
  });
  if (child.status !== 0 || child.error || child.stderr) return "failed_adapter";
  try {
    const outcome = JSON.parse(child.stdout);
    return ["results", "empty", "blocked", "locked"].includes(outcome.status)
      ? `passed_${outcome.status}` : "failed_adapter";
  } catch { return "failed_adapter"; }
}

function installOpenCodeDependency(project, plugin, env, home, state, previous) {
  const snapshot = readOpenCodePackageJson(project);
  const { directory, package_json_path: packageJsonPath, package_path: packagePath } = openCodePaths(project, plugin.name);
  const removedPluginName = replacedOpenCodePlugin(snapshot, plugin, previous);
  const installedBody = reconciledOpenCodePackageBody(snapshot, plugin, removedPluginName);
  const record = {
    package_json_path: packageJsonPath,
    package_json_created: !snapshot.existed,
    plugin_name: plugin.name,
    plugin_spec: plugin.spec,
    ...(removedPluginName ? { removed_plugin_name: removedPluginName } : {}),
    original_existed: snapshot.existed,
    original_body_b64: encode(snapshot.body),
    original_mode: snapshot.mode,
    installed_body_b64: encode(installedBody),
  };
  journalPhase(home, state, "package_json_prepared", { package: record });
  mkdirSync(directory, { recursive: true });
  // The superseded package is parked before the manifest drops it, because
  // npm prunes an undeclared package during install and would leave nothing
  // to restore on rollback. The parking spot must sit outside node_modules,
  // where npm would prune an unrecognized directory as extraneous.
  const removedPackagePath = removedPluginName
    ? openCodePaths(project, removedPluginName).package_path : null;
  if (removedPackagePath && existsSync(removedPackagePath)) {
    const removedNameDigest = createHash("sha256").update(removedPluginName, "utf8").digest("hex").slice(0, 16);
    record.removed_package_backup_path = backupPath(
      path.join(directory, `.removed-package-${removedNameDigest}`));
    journalPhase(home, state, "package_reconciliation_prepared", { package: record });
    renameSync(removedPackagePath, record.removed_package_backup_path);
    injectAfterMutation(env, "package_reconciliation");
  }
  if (!snapshot.existed || snapshot.body !== installedBody) {
    const alreadyManaged = switchboardManagedOpenCodePackage(snapshot, plugin.name, plugin.spec) ||
      Boolean(previous?.plugin_name && switchboardManagedOpenCodePackage(snapshot, previous.plugin_name, previous.plugin_spec));
    if (snapshot.existed && !alreadyManaged) backup(packageJsonPath);
    atomicText(packageJsonPath, installedBody, snapshot.mode);
  }
  injectAfterMutation(env, "package_json_write");
  const result = spawnSync("npm", [
    "install", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund",
  ], {
    cwd: directory, env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const output = (result.stderr || result.error?.message || "").trim();
    const reason = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join("; ") ||
      `npm exited with status ${result.status}`;
    throw new Error(`OpenCode plugin installation failed: ${reason}`);
  }
  injectAfterMutation(env, "package_npm_install");
  if (!existsSync(path.join(packagePath, "package.json"))) {
    throw new Error("OpenCode plugin installation failed: package missing after npm install");
  }
  return record;
}

function uninstallOpenCodeDependency(scope, snapshot = readOpenCodePackageJson(scope.project)) {
  const { package_json_path: packageJsonPath, package_path: packagePath } = openCodePaths(scope.project, scope.plugin_name);
  if (snapshot.existed && plainObject(snapshot.value.dependencies) &&
      Object.hasOwn(snapshot.value.dependencies, scope.plugin_name)) {
    const managed = switchboardManagedOpenCodePackage(snapshot, scope.plugin_name, scope.plugin_spec);
    const value = structuredClone(snapshot.value);
    delete value.dependencies[scope.plugin_name];
    const onlyEmptyDependencies = Object.keys(value).length === 1 && Object.hasOwn(value, "dependencies") &&
      plainObject(value.dependencies) && !Object.keys(value.dependencies).length;
    if (!managed) backup(packageJsonPath);
    if (scope.package_json_created && onlyEmptyDependencies) {
      try { unlinkSync(packageJsonPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    } else atomicText(packageJsonPath, `${JSON.stringify(value, null, 2)}\n`, snapshot.mode);
  }
  rmSync(packagePath, { recursive: true, force: true });
}

function preflightConfig(host, target, previous, plugin = DEFAULT_OPENCODE_PLUGIN) {
  const snapshot = configSnapshot(target);
  if (previous && !sameIdentity(snapshot.identity, previous.config)) {
    const repairableMissingFile = !snapshot.existed && previous.config.topology === "file" &&
      snapshot.identity.requested_path === previous.config.requested_path &&
      snapshot.identity.target_path === previous.config.target_path;
    if (!repairableMissingFile) throw new Error("host config identity no longer matches install state");
  }
  if (host === "opencode") {
    const previousPluginName = previous?.plugin_name ?? LEGACY_OPENCODE_PLUGIN_NAME;
    const expected = previous ? opencodeEntry(previousPluginName) : opencodeEntry(plugin.name);
    if (snapshot.existed && (!previous || snapshot.body !== expected)) {
      throw new Error("OpenCode plugin entry already exists and is not managed by Switchboard");
    }
  } else {
    const config = validateHookConfigBody(snapshot.body, snapshot.existed);
    if (previous && snapshot.existed && exactEntryIndex(config, previous.entry_b64) < 0) {
      const suffix = host === "codex" ? " hook codex-prefetch" : " hook claude-prefetch";
      if ((config.hooks?.UserPromptSubmit ?? []).some((group) =>
        group.hooks.some((entry) => entry.type === "command" && entry.command.endsWith(suffix)))) {
        throw new Error("recorded hook changed; refusing to replace an unowned entry");
      }
    }
  }
  return snapshot;
}

function grantSummary(repository, clientId) {
  const categories = new Set(repository.listGrants(clientId).filter((grant) => !grant.revoked_at)
    .flatMap((grant) => grant.categories));
  return CODING_PROFILE_CATEGORIES.filter((category) => categories.has(category));
}

function commitRemediation(home, state, step, error) {
  const commit = state.transaction?.commit;
  return `verify ${commit?.credential_path} authenticates replacement client ${commit?.new_client_id}, ` +
    `that it has an active coding grant, and that every scope in ${statePath(home, state.host)} points to that client; ` +
    `then run switchboard coding doctor (${error.message})`;
}

function removeOpenCodePackageBackup(record) {
  if (!record?.removed_package_backup_path) return;
  rmSync(record.removed_package_backup_path, { recursive: true, force: true });
  if (existsSync(record.removed_package_backup_path)) throw new Error("removed OpenCode package backup remains after commit");
}

function finalizeTransactionCommit(repository, home, state, env = process.env) {
  const transaction = state.transaction;
  if (!transaction?.commit) return true;
  const completed = new Set(transaction.recovery?.completed ?? []);
  transaction.phase = "committing";
  transaction.recovery = { status: "committing", completed: [...completed], failures: [] };
  writeState(home, state);
  const fail = (step, error) => {
    transaction.phase = "commit_needs_attention";
    transaction.recovery = {
      status: "needs_attention",
      completed: [...completed],
      failures: [{ step, error: error.message, remediation: commitRemediation(home, state, step, error) }],
    };
    writeState(home, state);
    return false;
  };

  if (!completed.has("package_backup_cleanup")) {
    try {
      removeOpenCodePackageBackup(transaction.package);
      injectAfterMutation(env, "package_backup_cleanup");
      completed.add("package_backup_cleanup");
      transaction.recovery = { status: "committing", completed: [...completed], failures: [] };
      writeState(home, state);
    } catch (error) { return fail("package_backup_cleanup", error); }
  }

  if (!completed.has("replacement_revocation")) {
    try {
      const commit = transaction.commit;
      const client = activeClient(repository, state.host, commit.credential_path, commit.new_client_id);
      const hasGrant = repository.listGrants(commit.new_client_id).some((grant) => !grant.revoked_at &&
        grant.profile_name === "coding" && CODING_PROFILE_CATEGORIES.every((category) => grant.categories.includes(category)));
      const scopesPointToReplacement = state.client_id === commit.new_client_id &&
        state.scopes.every((installedScope) => installedScope.client_id === commit.new_client_id);
      if (!client || !hasGrant || !scopesPointToReplacement || !transaction.verification?.startsWith("passed_")) {
        throw new Error("replacement commit did not verify");
      }
      if (commit.old_client_id && commit.old_client_id !== commit.new_client_id) {
        revokeClientAndGrants(repository, commit.old_client_id);
        injectAfterMutation(env, "replacement_revocation");
        const oldClient = repository.listClients().find((entry) => entry.client_id === commit.old_client_id);
        if (!oldClient?.revoked_at || repository.listGrants(commit.old_client_id).some((grant) => !grant.revoked_at)) {
          throw new Error("superseded client revocation did not verify");
        }
      }
      completed.add("replacement_revocation");
      transaction.recovery = { status: "committing", completed: [...completed], failures: [] };
      writeState(home, state);
    } catch (error) { return fail("replacement_revocation", error); }
  }

  state.transaction = null;
  writeState(home, state);
  return true;
}

function recordCodexHookTrust({ hooksJsonPath, entryB64, previous, env, home, state }) {
  const snapshot = configSnapshot(hooksJsonPath);
  if (!snapshot.existed) throw new Error("hooks.json was not found after installation");
  const indices = findSwitchboardHookIndices(snapshot.body, entryB64);
  if (!indices) throw new Error("the Switchboard hook was not found after installation");
  const stateKey = codexHookStateKey(snapshot.identity.requested_path, indices.groupIndex, indices.handlerIndex);
  const trustedHash = codexHookTrustedHash(indices.handler);
  const configPath = codexUserConfigPath(env);
  const trust = snapshotFile(configPath);
  const original = decode(trust.body_b64);
  let next = original;
  if (previous?.codex_trust_key && previous.codex_trust_key !== stateKey) {
    next = removeTrustEntry(next, previous.codex_trust_key);
  }
  const alreadyRecorded = readTrustEntry(next, stateKey) === trustedHash;
  if (!alreadyRecorded) next = upsertTrustEntry(next, stateKey, trustedHash);
  if (next !== original) {
    const installedTrust = { ...trust, installed_body_b64: encode(next), state_key: stateKey };
    journalPhase(home, state, "trust_recorded", { trust: installedTrust });
    injectAfterPhase(env, "trust_recorded");
    if (trust.existed) backup(configPath);
    atomicText(configPath, next, trust.mode);
    injectAfterMutation(env, "trust_write");
  }
  return { stateKey, status: alreadyRecorded && next === original ? "already recorded" : "recorded" };
}

function clearCodexHookTrust(scope, env) {
  if (!scope.codex_trust_key) return;
  const configPath = codexUserConfigPath(env);
  let original;
  let mode;
  try {
    original = readFileSync(configPath, "utf8");
    mode = statSync(configPath).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const next = removeTrustEntry(original, scope.codex_trust_key);
  if (next === original) return;
  backup(configPath);
  atomicText(configPath, next, mode);
}

function codexHookTrustStatus(scope, env) {
  let snapshot;
  let indices;
  try {
    snapshot = configSnapshot(scope.config.requested_path);
    if (!snapshot.existed || !sameIdentity(snapshot.identity, scope.config)) return "unknown";
    indices = findSwitchboardHookIndices(snapshot.body, scope.entry_b64);
    if (!indices) return "unknown";
  } catch { return "unknown"; }
  const stateKey = codexHookStateKey(snapshot.identity.requested_path, indices.groupIndex, indices.handlerIndex);
  const trustedHash = codexHookTrustedHash(indices.handler);
  let configToml;
  try { configToml = readFileSync(codexUserConfigPath(env), "utf8"); }
  catch (error) { return error?.code === "ENOENT" ? "missing" : "unknown"; }
  if (typeof scope.codex_trust_key === "string" && scope.codex_trust_key !== stateKey) return "stale";
  const recordedHash = readTrustEntry(configToml, stateKey);
  if (recordedHash === null) return "missing";
  return recordedHash === trustedHash ? "ok" : "stale";
}

function installOne({ plan, repository, home, binPath, env, plugin }) {
  const { host, project, paths, scope, previous, preflight } = plan;
  const state = plan.state;
  const credential = snapshotFile(paths.credential);
  state.transaction = {
    operation: "install", phase: "started", scope_id: scope,
    credential,
  };
  writeState(home, state);
  try {
    let client = state.client_id ? activeClient(repository, host, paths.credential, state.client_id) : null;
    const supersededClientId = !client ? state.client_id : null;
    if (supersededClientId) journalPhase(home, state, "replacement_prepared", { superseded_client_id: supersededClientId });
    if (!client) {
      const label = `${host === "claude-code" ? "Claude Code" : host === "codex" ? "Codex" : "OpenCode"} coding install`;
      const clientId = randomUUID();
      const clientEventId = randomUUID();
      journalPhase(home, state, "client_create_prepared", {
        new_client_id: clientId,
        new_client_event_id: clientEventId,
        client_create: { client_id: clientId, event_id: clientEventId, host, label },
      });
      injectAfterPhase(env, "client_create_prepared");
      client = repository.addClient({ clientId, eventId: clientEventId, host, label });
      injectAfterMutation(env, "client_create");
      journalPhase(home, state, "client_minted");
    } else journalPhase(home, state, "client_minted", { reused_client: true });
    injectAfterPhase(env, "client_minted");

    const grants = repository.listGrants(client.client_id).filter((grant) => !grant.revoked_at);
    let grant = grants.find((entry) => entry.profile_name === "coding" &&
      CODING_PROFILE_CATEGORIES.every((category) => entry.categories.includes(category)));
    if (!grant) {
      const grantId = randomUUID();
      const grantEventId = randomUUID();
      journalPhase(home, state, "grant_create_prepared", {
        new_grant_id: grantId,
        new_grant_event_id: grantEventId,
        grant_create: {
          grant_id: grantId, event_id: grantEventId, client_id: client.client_id, profile: "coding",
        },
      });
      injectAfterPhase(env, "grant_create_prepared");
      grant = repository.addGrant({ clientId: client.client_id, grantId, eventId: grantEventId, profile: "coding" });
      injectAfterMutation(env, "grant_create");
      journalPhase(home, state, "grant_created");
    } else journalPhase(home, state, "grant_created", { reused_grant: true });
    injectAfterPhase(env, "grant_created");

    journalPhase(home, state, "credential_write_prepared", {
      credential_write: { path: paths.credential, client_id: client.client_id },
    });
    writePrivateJson(paths.credential, { client_id: client.client_id, client_secret: client.client_secret });
    injectAfterMutation(env, "credential_write");
    journalPhase(home, state, "credential_written");
    injectAfterPhase(env, "credential_written");

    const packageRecord = host === "opencode"
      ? installOpenCodeDependency(project, plugin, env, home, state, previous) : null;
    journalPhase(home, state, "package_installed", { package_skipped: host !== "opencode" });
    injectAfterPhase(env, "package_installed");

    let installedEntryB64;
    let metadata = previous?.metadata ?? null;
    let installedIdentity = preflight.identity;
    if (host === "opencode") {
      const current = readCurrentLike(preflight);
      const previousPluginName = previous?.plugin_name ?? LEGACY_OPENCODE_PLUGIN_NAME;
      const desiredEntry = opencodeEntry(plugin.name);
      if (current.existed && current.body !== (previous ? opencodeEntry(previousPluginName) : desiredEntry)) {
        throw new Error("OpenCode plugin entry changed during installation");
      }
      state.transaction = { ...state.transaction, config: {
        identity: current.identity, original_existed: current.existed,
        original_body_b64: encode(current.body), original_mode: current.mode,
        installed_body_b64: encode(desiredEntry),
      } };
      writeState(home, state);
      if (!current.existed || current.body !== desiredEntry) atomicText(current.identity.target_path, desiredEntry, current.mode);
      installedEntryB64 = encode(desiredEntry);
    } else {
      const desired = hookEntry(binPath, host);
      installedEntryB64 = encode(entryBytes(desired));
      const currentConfig = validateHookConfigBody(preflight.body, preflight.existed);
      const alreadyExact = previous?.entry_b64 === installedEntryB64 &&
        exactEntryIndex(currentConfig, installedEntryB64) >= 0;
      if (!alreadyExact) {
        casJsonMutation(preflight, (config) => mergeHookInstall(config, desired, previous ? { ...previous, host } : null), {
          env,
          beforeWrite(original, body, nextMetadata) {
            state.transaction = { ...state.transaction, config: {
              identity: original.identity, original_existed: original.existed,
              original_body_b64: encode(original.body), original_mode: original.mode,
              installed_body_b64: encode(body),
            } };
            writeState(home, state);
            metadata = nextMetadata;
            installedIdentity = original.identity;
          },
        });
      }
    }
    journalPhase(home, state, "config_mutated");
    let codexTrust = null;
    if (host === "codex") {
      try {
        codexTrust = recordCodexHookTrust({
          hooksJsonPath: paths.config, entryB64: installedEntryB64, previous, env, home, state,
        });
      } catch (error) {
        const reason = String(error?.message ?? error).replace(/\.+$/, "").replace(/\s+/g, " ").trim();
        process.stderr.write(`codex: hook trust could not be recorded: ${reason}. Open codex in this project and trust the hook via /hooks.\n`);
      }
    }
    injectAfterPhase(env, "config_mutated");

    const verification = host === "opencode"
      ? verifyOpenCode({ project, home, credentialPath: paths.credential, env, pluginName: plugin.name })
      : verifyHook({ host, repository, entryB64: installedEntryB64, env });
    if (!verification.startsWith("passed_")) throw new Error(`Coding seam verification failed: ${verification}`);
    journalPhase(home, state, "verified", { verification });
    injectAfterPhase(env, "verified");

    const row = {
      host, scope_id: scope, project, client_id: client.client_id, entry_b64: installedEntryB64,
      config: installedIdentity, metadata, last_verification: verification, verified_at: new Date().toISOString(),
      ...(host === "codex" && codexTrust ? { codex_trust_key: codexTrust.stateKey } : {}),
      ...(host === "opencode" ? {
        plugin_name: plugin.name,
        plugin_spec: plugin.spec,
        package_json_created: previous?.package_json_created ?? packageRecord.package_json_created,
      } : {}),
    };
    const committedScopes = state.scopes.map((installedScope) => ({ ...installedScope, client_id: client.client_id }));
    const index = committedScopes.findIndex((entry) => entry.scope_id === scope);
    if (index >= 0) committedScopes[index] = row;
    else committedScopes.push(row);
    state.scopes = committedScopes;
    state.client_id = client.client_id;
    state.transaction = { ...state.transaction, phase: "commit_prepared", commit: {
      old_client_id: supersededClientId,
      new_client_id: client.client_id,
      credential_path: paths.credential,
      scope_ids: committedScopes.map((installedScope) => installedScope.scope_id),
    } };
    writeState(home, state);
    injectAfterPhase(env, "commit_prepared");
    if (!finalizeTransactionCommit(repository, home, state, env)) throw recoveryError(state);
    process.stdout.write(`${host}: client ${client.client_id}\n`);
    process.stdout.write(`categories: ${CODING_PROFILE_CATEGORIES.join(",")}\n`);
    if (host === "opencode") {
      process.stdout.write("OpenCode ambient memory and hand-offs are enabled. This install is the owner-present ceremony. Hosted fallback is disabled.\n");
    }
    process.stdout.write(`verification: ${verification}\n`);
    process.stdout.write(`uninstall: switchboard coding uninstall --target ${host}\n`);
    if (host === "codex" && codexTrust) process.stdout.write(`hook trust: ${codexTrust.status}\n`);
  } catch (error) {
    if (state.transaction?.commit) finalizeTransactionCommit(repository, home, state, env);
    else if (!rollbackTransaction(repository, home, state, env)) throw recoveryError(state);
    throw error;
  }
}

function install({ args, repository, home, binPath, env }) {
  if (!existsSync(path.join(home, "runtime.json"))) throw new Error("Run switchboard init first");
  const projectOption = option(args, "--project");
  const global = args.includes("--global");
  if (projectOption && global) throw new Error("Use either --project or --global");
  const project = path.resolve(projectOption ?? process.cwd());
  const explicitTargets = parseTargets(option(args, "--targets"));
  const discovered = discoverCodingHosts({ project, env });
  const targets = explicitTargets ?? (global ? ["claude-code"] : HOSTS.filter((host) => discovered[host]));
  if (!targets.length) throw new Error("No supported coding host was found");
  if (global && targets.some((host) => host !== "claude-code")) throw new Error("Only Claude Code supports --global");
  const plugin = resolveOpenCodePlugin(option(args, "--opencode-plugin-tarball"));

  const failures = [];
  const plans = [];
  for (const host of targets) {
    try {
      if (!discovered[host]) throw new Error(`Coding host not found: ${host}`);
      const hadState = existsSync(statePath(home, host));
      const state = readState(home, host);
      const projectClaude = host === "claude-code" && Boolean(projectOption) && !global;
      const paths = hostPaths(host, { project, projectClaude, env });
      if (!hadState && existsSync(paths.credential)) {
        throw new Error("host credentials exist without install state; refusing to take ownership");
      }
      const scope = scopeId(repository, host, { project, projectClaude });
      let previous = currentScope(state, scope);
      if (host === "opencode") readOpenCodePackageJson(project);
      let preflight = preflightConfig(host, paths.config, previous, plugin);

      // Recovery is a mutation, but this host passed its own read-only preflight first.
      const recoveredState = recoverHost(repository, home, host);
      previous = currentScope(recoveredState, scope);
      if (host === "opencode") readOpenCodePackageJson(project);
      preflight = preflightConfig(host, paths.config, previous, plugin);
      plans.push({ host, project, projectClaude, paths, scope, previous, state: recoveredState, preflight });
    } catch (error) {
      failures.push({ host, message: String(error?.message ?? error).replace(/\s+/g, " ").trim() });
    }
  }
  for (const plan of plans) {
    try {
      installOne({ plan, repository, home, binPath, env, plugin });
    } catch (error) {
      failures.push({ host: plan.host, message: String(error?.message ?? error).replace(/\s+/g, " ").trim() });
    }
  }
  for (const failure of failures) process.stderr.write(`${failure.host}: install failed: ${failure.message}\n`);
  if (!failures.length) return 0;
  for (const failure of failures) {
    process.stderr.write(`remediation: switchboard coding install --targets ${failure.host}${projectOption ? " --project ." : ""}\n`);
  }
  return 1;
}

function exactConfigPresent(host, scope) {
  try {
    const snapshot = configSnapshot(scope.config.requested_path);
    if (!snapshot.existed || !sameIdentity(snapshot.identity, scope.config)) return false;
    if (host === "opencode") return snapshot.body === opencodeEntry(scope.plugin_name ?? LEGACY_OPENCODE_PLUGIN_NAME);
    return exactEntryIndex(validateHookConfigBody(snapshot.body, true), scope.entry_b64) >= 0;
  } catch { return false; }
}

function status({ args, repository, home, env }) {
  const projectOption = option(args, "--project");
  const project = path.resolve(projectOption ?? process.cwd());
  for (const host of HOSTS) {
    let state;
    try { state = recoverHost(repository, home, host); } catch {
      process.stdout.write(`${host}: installed=unknown client=unknown grants=unknown config=unknown verification=state_invalid\n`);
      continue;
    }
    const scope = selectedScope(state, repository, host, {
      project, projectClaude: host === "claude-code" && Boolean(projectOption),
    });
    const client = state.client_id
      ? repository.listClients().find((entry) => entry.client_id === state.client_id && !entry.revoked_at) : null;
    const grants = client ? grantSummary(repository, client.client_id) : [];
    const present = scope ? exactConfigPresent(host, scope) : false;
    const installed = scope ? "yes" : state.scopes.length
      ? `no (${state.scopes.length} other scope${state.scopes.length === 1 ? "" : "s"})` : "no";
    const trust = host === "codex" && scope ? codexHookTrustStatus(scope, env) : null;
    process.stdout.write(`${host}: installed=${installed} client=${client?.client_id ?? "none"} ` +
      `grants=${grants.join(",") || "none"} config=${present ? "present" : "absent"} ` +
      `verification=${scope?.last_verification ?? "not_run"}${trust ? ` hook_trust=${trust}` : ""}\n`);
  }
  return 0;
}

function verifyInstalledScope({ host, scope, repository, home, env }) {
  if (!exactConfigPresent(host, scope)) return "failed_config";
  const credentialPath = hostCredentialPath(host, { env, home: ownerHome(env) });
  try { if ((statSync(credentialPath).mode & 0o777) !== 0o600) return "failed_credential_mode"; }
  catch { return "failed_credentials"; }
  return host === "opencode"
    ? verifyOpenCode({
      project: scope.project, home, credentialPath, env,
      pluginName: scope.plugin_name ?? DEFAULT_OPENCODE_PLUGIN.name,
      legacy: !scope.plugin_name,
    })
    : verifyHook({ host, repository, entryB64: scope.entry_b64, env });
}

function doctor({ args, repository, home, env }) {
  const projectOption = option(args, "--project");
  const project = path.resolve(projectOption ?? process.cwd());
  const discovered = discoverCodingHosts({ project, env });
  let healthy = false;
  try {
    healthy = existsSync(path.join(home, "runtime.json")) && (statSync(home).mode & 0o777) === 0o700 &&
      (statSync(repository.databasePath).mode & 0o777) === 0o600 && repository.metadata().schema_version === SCHEMA_VERSION;
  } catch {}
  process.stdout.write(`store: ${healthy ? "healthy" : "not_initialized"}\n`);
  if (!healthy) process.stdout.write("remediation: switchboard init\n");
  for (const host of HOSTS) {
    let state;
    try { state = recoverHost(repository, home, host); }
    catch {
      healthy = false;
      let pending = null;
      try { pending = readState(home, host).transaction; } catch {}
      const failures = pending?.recovery?.failures ?? [];
      process.stdout.write(`${host}: discovered=${discovered[host] ? "yes" : "no"} ` +
        `verification=${failures.length ? "recovery_needs_attention" : "state_invalid"}\n`);
      if (failures.length) {
        for (const failure of failures) process.stdout.write(`remediation (${failure.step}): ${failure.remediation}\n`);
      } else process.stdout.write(`remediation: ${STATE_REMEDIATION}\n`);
      continue;
    }
    const scope = selectedScope(state, repository, host, {
      project, projectClaude: host === "claude-code" && Boolean(projectOption),
    });
    let verification = "not_installed";
    let trust = null;
    if (scope) {
      verification = verifyInstalledScope({ host, scope, repository, home, env });
      if (host === "codex") trust = codexHookTrustStatus(scope, env);
      scope.last_verification = verification;
      scope.verified_at = new Date().toISOString();
      writeState(home, state);
      if (!verification.startsWith("passed_") || (trust && trust !== "ok")) healthy = false;
    }
    process.stdout.write(`${host}: discovered=${discovered[host] ? "yes" : "no"} verification=${verification}` +
      `${trust ? ` hook_trust=${trust}` : ""}\n`);
    if (verification !== "not_installed" &&
        (!verification.startsWith("passed_") || (trust && trust !== "ok"))) {
      process.stdout.write(`remediation: switchboard coding install --targets ${host}${projectOption ? " --project ." : ""}\n`);
    }
    if (trust === "missing" || trust === "stale") {
      process.stdout.write("or open codex in this project and trust the hook via /hooks.\n");
    }
  }
  return healthy ? 0 : 1;
}

function uninstall({ args, repository, home, env }) {
  const host = option(args, "--target");
  if (!HOSTS.includes(host)) throw new Error("uninstall requires one valid --target");
  const projectOption = option(args, "--project");
  const project = path.resolve(projectOption ?? process.cwd());
  const projectClaude = host === "claude-code" && Boolean(projectOption) && !args.includes("--global");
  const state = readState(home, host, { required: true });
  if (state.transaction) {
    const recovered = state.transaction.commit
      ? finalizeTransactionCommit(repository, home, state, env)
      : rollbackTransaction(repository, home, state, env);
    if (!recovered) throw recoveryError(state);
  }
  const scope = selectedScope(state, repository, host, { project, projectClaude });
  if (!scope) throw new Error(STATE_REMEDIATION);

  // Resolve and validate everything before making the first change. State and config must agree exactly.
  const snapshot = configSnapshot(scope.config.requested_path);
  if (!snapshot.existed || !sameIdentity(snapshot.identity, scope.config)) throw new Error(STATE_REMEDIATION);
  if (host === "opencode") {
    if (snapshot.body !== opencodeEntry(scope.plugin_name ?? LEGACY_OPENCODE_PLUGIN_NAME)) throw new Error(STATE_REMEDIATION);
  } else {
    const config = validateHookConfigBody(snapshot.body, true);
    if (exactEntryIndex(config, scope.entry_b64) < 0) throw new Error(STATE_REMEDIATION);
  }

  if (host === "opencode") {
    const packageSnapshot = readOpenCodePackageJson(scope.project);
    unlinkSync(snapshot.identity.target_path);
    if (scope.plugin_name) uninstallOpenCodeDependency(scope, packageSnapshot);
  }
  else {
    casJsonMutation(snapshot, (config) => mergeHookRemoval(config, scope), { env });
    if (host === "codex") clearCodexHookTrust(scope, env);
  }
  state.scopes = state.scopes.filter((entry) => entry.scope_id !== scope.scope_id);
  const last = state.scopes.length === 0;
  const keepClient = args.includes("--keep-client");
  if (last && !keepClient) {
    try { unlinkSync(hostCredentialPath(host, { env, home: ownerHome(env) })); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    revokeClientAndGrants(repository, state.client_id);
    state.client_id = null;
  }
  writeState(home, state);
  process.stdout.write(`${host}: uninstalled\n`);
  process.stdout.write(`remaining scopes: ${state.scopes.length}\n`);
  process.stdout.write(`client: ${last ? (keepClient ? "kept" : "revoked") : "kept (still in use)"}\n`);
  process.stdout.write("Deleting local memories is a separate owner action.\n");
  return 0;
}

export function runCodingCommand({ args, repository, home, binPath, env = process.env } = {}) {
  const action = args[1];
  if (action === "install") return install({ args: args.slice(2), repository, home, binPath, env });
  if (action === "status") return status({ args: args.slice(2), repository, home, env });
  if (action === "doctor") return doctor({ args: args.slice(2), repository, home, env });
  if (action === "uninstall") return uninstall({ args: args.slice(2), repository, home, env });
  throw new Error("coding requires install, status, doctor, or uninstall");
}

export { DEFAULT_OPENCODE_PLUGIN, OPENCODE_ENTRY, opencodeEntry, STATE_REMEDIATION };
