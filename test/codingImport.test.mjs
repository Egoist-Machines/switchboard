import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import Database from "better-sqlite3";

import { discoverCodingImports, importCodingMemories, printCodingImportPreview } from "../src/codingImport.js";
import { LocalRepository } from "../src/repository.js";
import { temporaryHome } from "./helpers.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function textOutput() {
  return { body: "", write(chunk) { this.body += String(chunk); return true; } };
}

const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function codexDatabases(home, project) {
  const codex = path.join(home, ".codex");
  mkdirSync(codex, { recursive: true });
  const state = new Database(path.join(codex, "state_5.sqlite"));
  state.exec(`CREATE TABLE threads(
    thread_id TEXT, cwd TEXT, git_origin_url TEXT, git_sha TEXT, memory_mode TEXT
  )`);
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "thread-on", project, "https://EXAMPLE.test/Owner/Portable.git", "a".repeat(40), "enabled",
  );
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "thread-off", project, "https://example.test/Owner/Portable.git", "a".repeat(40), "disabled",
  );
  state.close();
  const memories = new Database(path.join(codex, "memories_5.sqlite"));
  memories.exec(`CREATE TABLE stage1_outputs(
    thread_id TEXT, raw_memory TEXT, rollout_summary TEXT, selected_for_phase2 INTEGER
  )`);
  memories.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?, ?)").run(
    "thread-on", "Codex remembers the build layout.", "Always run the focused checks.", 1,
  );
  memories.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?, ?)").run(
    "thread-off", "DISABLED_MEMORY", "DISABLED_SUMMARY", 1,
  );
  memories.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?, ?)").run(
    "thread-on", "UNSELECTED_MEMORY", "UNSELECTED_SUMMARY", 0,
  );
  memories.close();
}

test("coding import previews every source, honors skips, remains idempotent, and never mutates sources", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  const project = path.join(root, "portable-project");
  mkdirSync(path.join(ownerHome, ".claude"), { recursive: true });
  mkdirSync(path.join(ownerHome, ".codex", "rules"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(ownerHome, ".claude", "CLAUDE.md"), "Always keep global Claude context.");
  writeFileSync(path.join(ownerHome, ".codex", "AGENTS.md"), "Codex global guidance.");
  writeFileSync(path.join(ownerHome, ".codex", "rules", "safe.rules"), "Never expose private data.");
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  writeFileSync(path.join(project, "CLAUDE.md"), "CHECKED_IN_CLAUDE");
  writeFileSync(path.join(project, "AGENTS.md"), "CHECKED_IN_AGENTS");
  git(project, "add", "CLAUDE.md", "AGENTS.md");
  git(project, "commit", "-qm", "instructions");
  git(project, "remote", "add", "origin", "git@EXAMPLE.test:Owner/Portable.git");
  writeFileSync(path.join(project, "CLAUDE.local.md"), "Use the private project convention.");
  writeFileSync(path.join(project, "INSTRUCTIONS.md"), "Always test the private integration.");

  const slug = path.resolve(project).split(path.sep).join("-");
  const claudeMemory = path.join(ownerHome, ".claude", "projects", slug, "memory");
  mkdirSync(claudeMemory, { recursive: true });
  writeFileSync(path.join(claudeMemory, "MEMORY.md"), "INDEX_MUST_NOT_IMPORT");
  writeFileSync(path.join(claudeMemory, "fact.md"), "The project uses a portable memory scope.");
  const unresolvedMemory = path.join(ownerHome, ".claude", "projects", "-definitely-missing-project", "memory");
  mkdirSync(unresolvedMemory, { recursive: true });
  writeFileSync(path.join(unresolvedMemory, "orphan.md"), "An orphaned Claude fact.");
  codexDatabases(ownerHome, project);

  const protectedFiles = [
    path.join(ownerHome, ".claude", "CLAUDE.md"),
    path.join(ownerHome, ".codex", "AGENTS.md"),
    path.join(ownerHome, ".codex", "rules", "safe.rules"),
    path.join(project, "CLAUDE.local.md"),
    path.join(project, "INSTRUCTIONS.md"),
    path.join(claudeMemory, "fact.md"),
  ];
  const before = protectedFiles.map(hash);
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const env = { ...process.env, HOME: ownerHome };
  const discovery = await discoverCodingImports({ repository, project, env });
  const preview = textOutput();
  printCodingImportPreview(discovery, (text) => preview.write(text));
  for (const label of [
    "Claude global instructions", "Codex global guidance", "Codex global rule",
    "Project-local instructions", "Claude Code auto-memory", "Codex session memory", "Codex rollout summary",
  ]) assert.match(preview.body, new RegExp(label));
  assert.equal(preview.body.includes("INDEX_MUST_NOT_IMPORT"), false);
  assert.equal(preview.body.includes("CHECKED_IN_CLAUDE"), false);
  assert.equal(preview.body.includes("CHECKED_IN_AGENTS"), false);
  assert.equal(preview.body.includes("DISABLED_MEMORY"), false);
  assert.equal(preview.body.includes("UNSELECTED_MEMORY"), false);
  const orphan = discovery.entries.find((item) => item.content === "An orphaned Claude fact.");
  assert.equal(orphan, undefined);
  assert.match(discovery.notes.join("\n"), /could not be resolved uniquely/);

  const dryOutput = textOutput();
  const dry = await importCodingMemories({ repository, discovery, dryRun: true, output: dryOutput });
  assert.equal(dry.imported, 0);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);

  const pipedRepository = new LocalRepository({ home: path.join(root, "piped-store") });
  const piped = await importCodingMemories({
    repository: pipedRepository,
    discovery: { entries: discovery.entries.slice(0, 2), notes: [] },
    input: Readable.from(["y\nn\n"]),
    output: textOutput(),
  });
  assert.deepEqual({ imported: piped.imported, skipped: piped.skipped }, { imported: 1, skipped: 1 });
  pipedRepository.close();

  const skippedContent = discovery.entries[1].content;
  const first = await importCodingMemories({
    repository,
    discovery,
    output: textOutput(),
    confirm: (_item, index) => index !== 1,
  });
  assert.equal(first.skipped, 1);
  assert.equal(repository.listMemories().some((item) => item.content === skippedContent), false);
  assert.deepEqual(protectedFiles.map(hash), before);

  const secondDiscovery = await discoverCodingImports({ repository, project, env });
  assert.equal(secondDiscovery.entries.filter((item) => item.already_present).length, discovery.entries.length - 1);
  const second = await importCodingMemories({
    repository,
    discovery: secondDiscovery,
    output: textOutput(),
    confirm: () => true,
  });
  assert.equal(second.imported, 1);
  const third = await discoverCodingImports({ repository, project, env });
  assert.equal(third.entries.every((item) => item.already_present), true);
  assert.deepEqual(protectedFiles.map(hash), before);
  repository.close();
});

test("an unrecognized highest Codex schema is skipped with a note", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  const codex = path.join(ownerHome, ".codex");
  mkdirSync(codex, { recursive: true });
  const state = new Database(path.join(codex, "state_99.sqlite"));
  state.exec("CREATE TABLE threads(unexpected TEXT)");
  state.close();
  const memories = new Database(path.join(codex, "memories_99.sqlite"));
  memories.exec("CREATE TABLE stage1_outputs(unexpected TEXT)");
  memories.close();
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const discovery = await discoverCodingImports({ repository, project: root, env: { ...process.env, HOME: ownerHome } });
  assert.deepEqual(discovery.entries, []);
  assert.match(discovery.notes[0], /schema is not recognized/);
  repository.close();
});

test("a thrown snapshot quick_check closes the opened database copy", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  codexDatabases(ownerHome, root);
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const originalPragma = Database.prototype.pragma;
  const originalClose = Database.prototype.close;
  let failedCopy = null;
  let failedCopyClosed = false;
  Database.prototype.pragma = function patchedPragma(source, options) {
    if (source === "quick_check" && this.name.includes("switchboard-coding-import-")) {
      failedCopy = this.name;
      throw new Error("injected quick_check failure");
    }
    return originalPragma.call(this, source, options);
  };
  Database.prototype.close = function patchedClose() {
    if (this.name === failedCopy) failedCopyClosed = true;
    return originalClose.call(this);
  };
  try {
    const discovery = await discoverCodingImports({
      repository,
      project: root,
      env: { ...process.env, HOME: ownerHome },
    });
    assert.match(discovery.notes.join("\n"), /database copy could not be read/);
    assert.notEqual(failedCopy, null);
    assert.equal(failedCopyClosed, true);
  } finally {
    Database.prototype.pragma = originalPragma;
    Database.prototype.close = originalClose;
    repository.close();
  }
});

test("ambiguous Claude slugs are skipped until --project names one complete checkout", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  const first = path.join(root, "a-b", "c");
  const second = path.join(root, "a", "b-c");
  for (const checkout of [first, second]) {
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q");
    git(checkout, "config", "user.email", "test@example.com");
    git(checkout, "config", "user.name", "Test");
    git(checkout, "commit", "--allow-empty", "-qm", "initial");
  }
  const slug = path.resolve(first).split(path.sep).join("-");
  const memory = path.join(ownerHome, ".claude", "projects", slug, "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(path.join(memory, "fact.md"), "Ambiguous slug memory.");
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const env = { ...process.env, HOME: ownerHome };

  const ambiguous = await discoverCodingImports({ repository, project: root, env });
  assert.equal(ambiguous.entries.some((item) => item.content === "Ambiguous slug memory."), false);
  assert.match(ambiguous.notes.join("\n"), /resolved uniquely.*--project/);

  const selected = await discoverCodingImports({ repository, project: first, env });
  const resolved = selected.entries.find((item) => item.content === "Ambiguous slug memory.");
  assert.match(resolved.project_scope, /^[a-f0-9]{64}$/);
  repository.close();
});

test("Claude auto-memory discovery caps directory visits before candidate discovery", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  const project = path.join(root, "bounded-project");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "--allow-empty", "-qm", "initial");
  const slug = path.resolve(project).split(path.sep).join("-");
  const memory = path.join(ownerHome, ".claude", "projects", slug, "memory");
  for (let index = 0; index < 110; index += 1) {
    mkdirSync(path.join(memory, `directory-${String(index).padStart(3, "0")}`), { recursive: true });
  }
  const sentinel = "CONTENT_MUST_NOT_APPEAR_IN_TRUNCATION_NOTE";
  writeFileSync(path.join(memory, "directory-109", "fact.md"), sentinel);
  const repository = new LocalRepository({ home: path.join(root, "store") });
  const discovery = await discoverCodingImports({
    repository,
    project,
    env: { ...process.env, HOME: ownerHome },
  });
  assert.equal(discovery.entries.some((item) => item.content === sentinel), false);
  assert.match(discovery.notes.join("\n"), /directory traversal was capped at 100 directories/);
  assert.equal(discovery.notes.join("\n").includes(sentinel), false);
  repository.close();
});

test("import save ids are replica-keyed and first-person preferences win categorization", async (t) => {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  mkdirSync(path.join(ownerHome, ".claude"), { recursive: true });
  writeFileSync(path.join(ownerHome, ".claude", "CLAUDE.md"), "I prefer tabs");
  const first = new LocalRepository({ home: path.join(root, "first-store") });
  const second = new LocalRepository({ home: path.join(root, "second-store") });
  const env = { ...process.env, HOME: ownerHome };
  const firstDiscovery = await discoverCodingImports({ repository: first, project: root, env });
  const repeated = await discoverCodingImports({ repository: first, project: root, env });
  const secondDiscovery = await discoverCodingImports({ repository: second, project: root, env });
  assert.equal(firstDiscovery.entries[0].category, "preference");
  assert.equal(firstDiscovery.entries[0].save_id, repeated.entries[0].save_id);
  assert.notEqual(firstDiscovery.entries[0].save_id, secondDiscovery.entries[0].save_id);
  first.close();
  second.close();
});
