import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeRemoteIdentity, resolveProjectIdentity, resolveProjectScope, resolveProjectScopes } from "../src/projectIdentity.js";
import { LocalRepository } from "../src/repository.js";
import { temporaryHome } from "./helpers.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repositoryAt(t, root, name, remote = null) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Test");
  git(directory, "commit", "--allow-empty", "-qm", "initial");
  if (remote) git(directory, "remote", "add", "origin", remote);
  return directory;
}

test("remote normalization removes transport, credentials, and dot-git while folding only the host", () => {
  assert.equal(normalizeRemoteIdentity("https://User:secret@GitHub.COM/Egoist/Passport.git"), "remote:github.com/Egoist/Passport");
  assert.equal(normalizeRemoteIdentity("git@GITHUB.com:Egoist/Passport.git"), "remote:github.com/Egoist/Passport");
  assert.equal(normalizeRemoteIdentity("ssh://git@github.COM/Egoist/Passport.git/"), "remote:github.com/Egoist/Passport");
});

test("project identity is clone portable, remote specific, and path independent", (t) => {
  const root = temporaryHome(t);
  const source = repositoryAt(t, root, "source", "https://github.com/Egoist/Passport.git");
  const first = path.join(root, "first-clone");
  const second = path.join(root, "second-clone");
  for (const clone of [first, second]) {
    const result = spawnSync("git", ["clone", "-q", source, clone], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    git(clone, "remote", "set-url", "origin", "git@GITHUB.com:Egoist/Passport.git");
  }
  const other = repositoryAt(t, root, "other", "https://github.com/Egoist/Other.git");
  const store = new LocalRepository({ home: path.join(root, "store") });
  assert.equal(resolveProjectIdentity(first), resolveProjectIdentity(second));
  assert.equal(resolveProjectScope(store, first), resolveProjectScope(store, second));
  assert.notEqual(resolveProjectScope(store, first), resolveProjectScope(store, other));
  store.close();
});

test("a no-remote repository uses its first root and a non-git directory has no identity", (t) => {
  const root = temporaryHome(t);
  const source = repositoryAt(t, root, "no-remote");
  const initial = git(source, "rev-list", "--max-parents=0", "--reverse", "HEAD");
  assert.equal(resolveProjectIdentity(source), `root:${initial}`);
  const plain = path.join(root, "plain");
  mkdirSync(plain);
  assert.equal(resolveProjectIdentity(plain), null);
});

test("the next scope resolution observes an origin URL change", (t) => {
  const root = temporaryHome(t);
  const source = repositoryAt(t, root, "changed-origin", "https://example.test/Owner/First.git");
  const store = new LocalRepository({ home: path.join(root, "store") });
  const first = resolveProjectScope(store, source);
  git(source, "remote", "set-url", "origin", "https://example.test/Owner/Other.git");
  const second = resolveProjectScope(store, source);
  assert.notEqual(second, first);
  assert.equal(resolveProjectIdentity(source), "remote:example.test/Owner/Other");
  store.close();
});

test("a rewritten no-remote root replaces both cached identity and scope", (t) => {
  const root = temporaryHome(t);
  const source = repositoryAt(t, root, "rewritten-root");
  const store = new LocalRepository({ home: path.join(root, "store") });
  const firstIdentity = resolveProjectIdentity(source);
  const firstScope = resolveProjectScope(store, source);
  git(source, "commit", "--amend", "--allow-empty", "-qm", "rewritten root");
  const rewrittenRoot = git(source, "rev-list", "--max-parents=0", "--reverse", "HEAD");
  assert.equal(resolveProjectIdentity(source), `root:${rewrittenRoot}`);
  assert.notEqual(resolveProjectIdentity(source), firstIdentity);
  assert.notEqual(resolveProjectScope(store, source), firstScope);
  store.close();
});

test("effective include and worktree config sources invalidate the scope cache", (t) => {
  const root = temporaryHome(t);
  const included = repositoryAt(t, root, "included-config");
  const includedFile = path.join(root, "remote.inc");
  git(included, "config", "include.path", includedFile);
  git(included, "config", "-f", includedFile, "remote.origin.url", "https://example.test/Owner/Included.git");
  const store = new LocalRepository({ home: path.join(root, "store") });
  const includedFirst = resolveProjectScope(store, included);
  git(included, "config", "-f", includedFile, "remote.origin.url", "https://example.test/Owner/Changed.git");
  assert.notEqual(resolveProjectScope(store, included), includedFirst);

  const worktree = repositoryAt(t, root, "worktree-config");
  git(worktree, "config", "extensions.worktreeConfig", "true");
  git(worktree, "config", "--worktree", "remote.origin.url", "https://example.test/Owner/Worktree.git");
  const worktreeFirst = resolveProjectScope(store, worktree);
  git(worktree, "config", "--worktree", "remote.origin.url", "https://example.test/Owner/Changed.git");
  assert.notEqual(resolveProjectScope(store, worktree), worktreeFirst);
  store.close();
});

test("raw repository identities never enter event envelopes", (t) => {
  const root = temporaryHome(t);
  const project = repositoryAt(t, root, "private-name", "https://example.test/SecretOrg/SecretRepo.git");
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const scope = resolveProjectScope(repository, project);
  repository.propose({ content: "Scoped project fact", category: "project", save_id: "scoped-event", project_scope: scope }, { owner: true });
  const serialized = JSON.stringify(repository.events());
  assert.equal(serialized.includes("SecretOrg"), false);
  assert.equal(serialized.includes("SecretRepo"), false);
  assert.match(serialized, new RegExp(scope));
  repository.close();
});

test("two linked stores for one owner converge on one repository fingerprint and inject synced memory", (t) => {
  const root = temporaryHome(t);
  const remote = repositoryAt(t, root, "remote", "https://example.test/Owner/Shared.git");
  const firstClone = path.join(root, "first-linked-clone");
  const secondClone = path.join(root, "second-linked-clone");
  for (const clone of [firstClone, secondClone]) {
    const result = spawnSync("git", ["clone", "-q", remote, clone], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    git(clone, "remote", "set-url", "origin", "https://example.test/Owner/Shared.git");
  }

  const ownerId = crypto.randomUUID();
  const first = new LocalRepository({ home: path.join(root, "first-store"), ownerId });
  const second = new LocalRepository({ home: path.join(root, "second-store"), ownerId, initializeDefaults: false });
  const ownerScopeKey = "7".repeat(64);
  first.adoptOwnerScopeKey(ownerScopeKey);
  second.adoptOwnerScopeKey(ownerScopeKey);
  const firstScope = resolveProjectScope(first, firstClone);
  const secondScope = resolveProjectScope(second, secondClone);
  assert.equal(firstScope, secondScope);

  const client = first.addClient({ host: "codex", label: "Shared linked client" });
  first.addGrant({ clientId: client.client_id, profile: "coding" });
  first.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "linked-project-memory",
    category: "project",
    content: "Shared linked repository context",
    project_scope: firstScope,
  });
  for (const event of first.events()) second.ingestEvent(event);
  for (const record of first.contentRecords()) second.ingestContentRecord(record);

  for (const [store, clone] of [[first, firstClone], [second, secondClone]]) {
    const outcome = store.prefetch({
      client_id: client.client_id,
      client_secret: client.client_secret,
      categories: ["project"],
      query: "repository context",
      project_scopes: resolveProjectScopes(store, clone),
    });
    assert.deepEqual(outcome.rows.map((row) => row.content), ["Shared linked repository context"]);
  }
  first.close();
  second.close();
});

test("owner-key adoption re-fingerprints cached identities while legacy rows still inject at home", (t) => {
  const root = temporaryHome(t);
  const project = repositoryAt(t, root, "legacy-project", "https://example.test/Owner/Legacy.git");
  const repository = new LocalRepository({ home: path.join(root, "legacy-store") });
  const client = repository.addClient({ host: "codex", label: "Legacy client" });
  repository.addGrant({ clientId: client.client_id, profile: "coding" });
  const legacyScope = resolveProjectScope(repository, project);
  repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: "legacy-project-memory",
    category: "project",
    content: "Pre-adoption project context",
    project_scope: legacyScope,
  });

  repository.adoptOwnerScopeKey("8".repeat(64));
  const adoptedScopes = resolveProjectScopes(repository, project);
  assert.notEqual(adoptedScopes[0], legacyScope);
  assert.equal(adoptedScopes[1], legacyScope);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM project_identity_cache").get().count, 2,
    "the owner-key cache entry is recomputed instead of reusing the legacy fingerprint");
  const outcome = repository.prefetch({
    client_id: client.client_id,
    client_secret: client.client_secret,
    categories: ["project"],
    query: "pre-adoption",
    project_scopes: adoptedScopes,
  });
  assert.deepEqual(outcome.rows.map((row) => row.content), ["Pre-adoption project context"]);
  repository.close();
});

test("never-linked stores retain replica-key scope behavior", (t) => {
  const root = temporaryHome(t);
  const project = repositoryAt(t, root, "unlinked-project", "https://example.test/Owner/Unlinked.git");
  const first = new LocalRepository({ home: path.join(root, "unlinked-first") });
  const second = new LocalRepository({ home: path.join(root, "unlinked-second") });
  assert.equal(first.hasOwnerScopeKey(), false);
  assert.equal(second.hasOwnerScopeKey(), false);
  assert.equal(resolveProjectScope(first, project), resolveProjectScope(first, project));
  assert.notEqual(resolveProjectScope(first, project), resolveProjectScope(second, project));
  first.close();
  second.close();
});
