import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const identityCache = new Map();

function gitRaw(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

const git = (cwd, args) => gitRaw(cwd, args)?.trim() ?? null;

export function normalizeRemoteIdentity(value) {
  const remote = String(value ?? "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!remote) return null;
  const scp = remote.includes("://") ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
  if (scp && !/^[A-Za-z]:[\\/]/.test(remote)) {
    return `remote:${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(remote);
    if (!parsed.hostname) return null;
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    if (!pathname) return null;
    return `remote:${parsed.hostname.toLowerCase()}${port}/${pathname}`;
  } catch {
    return null;
  }
}

function gitLayout(directory) {
  let current;
  try { current = realpathSync(path.resolve(directory)); } catch { return null; }
  for (;;) {
    const marker = path.join(current, ".git");
    try {
      const status = lstatSync(marker);
      let gitDirectory = marker;
      if (status.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(marker, "utf8"));
        if (!match) return null;
        gitDirectory = path.resolve(current, match[1]);
      } else if (!status.isDirectory()) return null;
      let commonDirectory = gitDirectory;
      try {
        const relative = readFileSync(path.join(gitDirectory, "commondir"), "utf8").trim();
        if (relative) commonDirectory = path.resolve(gitDirectory, relative);
      } catch {}
      return { gitDirectory: realpathSync(gitDirectory), commonDirectory: realpathSync(commonDirectory) };
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function fileStamp(file) {
  try {
    const status = statSync(file, { bigint: true });
    return `${status.mtimeNs}:${status.size}`;
  } catch {
    return "missing";
  }
}

function headStamp(layout, cwd) {
  const headFile = path.join(layout.gitDirectory, "HEAD");
  let referenceStamp = "detached";
  try {
    const match = /^ref:\s*(.+)\s*$/.exec(readFileSync(headFile, "utf8"));
    if (match) {
      referenceStamp = [
        fileStamp(path.join(layout.commonDirectory, match[1])),
        fileStamp(path.join(layout.commonDirectory, "packed-refs")),
      ].join(":");
    }
  } catch {}
  const revision = git(cwd, ["rev-parse", "--verify", "HEAD"]) ?? "unborn";
  return `${fileStamp(headFile)}:${referenceStamp}:${revision}`;
}

function effectiveConfiguration(cwd, layout) {
  const output = gitRaw(cwd, ["config", "-z", "--includes", "--show-origin", "--list"]);
  const records = [];
  if (output !== null) {
    const fields = output.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const origin = fields[index];
      const separator = fields[index + 1].indexOf("\n");
      records.push({
        origin,
        key: separator < 0 ? fields[index + 1] : fields[index + 1].slice(0, separator),
        value: separator < 0 ? "" : fields[index + 1].slice(separator + 1),
      });
    }
  }
  const sources = new Set([
    path.join(layout.commonDirectory, "config"),
    path.join(layout.gitDirectory, "config.worktree"),
  ]);
  for (const record of records) {
    if (!record.origin.startsWith("file:")) continue;
    const source = record.origin.slice("file:".length);
    if (source === ".git/config") sources.add(path.join(layout.commonDirectory, "config"));
    else if (source === ".git/config.worktree") sources.add(path.join(layout.gitDirectory, "config.worktree"));
    else sources.add(path.isAbsolute(source) ? path.normalize(source) : path.resolve(cwd, source));
  }
  const effectiveRemotes = new Map();
  for (const record of records) {
    if (!/^remote\..*\.url$/.test(record.key)) continue;
    const name = record.key.slice("remote.".length, -".url".length);
    effectiveRemotes.set(name, record.value);
  }
  const remotes = [...effectiveRemotes].map(([name, url]) => ({ name, url }));
  const evidence = [
    ...[...sources].sort().map((source) => `${source}\0${fileStamp(source)}`),
    ...remotes.map((remote) => `${remote.name}\0${remote.url}`),
  ];
  return {
    remotes,
    stamp: createHash("sha256").update(evidence.join("\0")).digest("hex"),
  };
}

function layoutState(directory) {
  const cwd = path.resolve(directory);
  const layout = gitLayout(cwd);
  if (!layout) return null;
  const configuration = effectiveConfiguration(cwd, layout);
  return {
    cwd,
    ...layout,
    configStamp: configuration.stamp,
    headStamp: headStamp(layout, cwd),
    remotes: configuration.remotes,
  };
}

function identityForState(state) {
  const signature = `${state.configStamp}:${state.headStamp}`;
  const cached = identityCache.get(state.commonDirectory);
  if (cached?.signature === signature) return cached.identity;
  if (state.remotes.length) {
    const selected = state.remotes.find((remote) => remote.name === "origin") ?? state.remotes[0];
    const identity = normalizeRemoteIdentity(selected?.url);
    if (identity) {
      identityCache.set(state.commonDirectory, { signature, identity });
      return identity;
    }
  }
  const roots = git(state.cwd, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
  const initialCommit = roots?.split("\n").find((entry) => /^[a-f0-9]{40,64}$/i.test(entry))?.toLowerCase() ?? null;
  const identity = initialCommit ? `root:${initialCommit}` : null;
  identityCache.set(state.commonDirectory, { signature, identity });
  return identity;
}

export function resolveProjectIdentity(directory = process.cwd()) {
  const state = layoutState(directory);
  return state ? identityForState(state) : null;
}

export function resolveProjectScopes(repository, directory = process.cwd()) {
  const state = layoutState(directory);
  if (!state) return [];
  const cacheKey = repository.scopeFingerprint(`project-identity-cache:${state.commonDirectory}`);
  const identity = identityForState(state);
  const scopes = identity ? repository.scopeFingerprints(identity) : [];
  if (!scopes.length) return [];
  try {
    const cached = repository.db.prepare(`
      SELECT config_stamp, head_stamp, project_scope
      FROM project_identity_cache WHERE cache_key = ?
    `).get(cacheKey);
    if (cached && cached.config_stamp === state.configStamp && cached.head_stamp === state.headStamp) {
      return cached.project_scope === scopes[0] ? scopes : [cached.project_scope, ...scopes.filter((scope) => scope !== cached.project_scope)];
    }
  } catch {}
  const scope = scopes[0] ?? null;
  try {
    repository.db.prepare(`
      INSERT INTO project_identity_cache(cache_key, config_stamp, head_stamp, project_scope)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        config_stamp = excluded.config_stamp,
        head_stamp = excluded.head_stamp,
        project_scope = excluded.project_scope
    `).run(cacheKey, state.configStamp, state.headStamp, scope);
  } catch {}
  return scopes;
}

export function resolveProjectScope(repository, directory = process.cwd()) {
  return resolveProjectScopes(repository, directory)[0] ?? null;
}

export function scopeForRemote(repository, remote) {
  const identity = normalizeRemoteIdentity(remote);
  return identity ? repository.scopeFingerprint(identity) : null;
}
