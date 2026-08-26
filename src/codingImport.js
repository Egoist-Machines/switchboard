import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import Database from "better-sqlite3";

import { resolveProjectIdentity, resolveProjectScope, scopeForRemote } from "./projectIdentity.js";

const INSTRUCTION_FILE = /^(?:claude|agents)(?:\.[^.]+)*\.md$|(?:instruction|instructions|rules)(?:\.[^.]+)*\.(?:md|rules)$/i;
const DISABLED_MEMORY_MODES = new Set(["0", "disabled", "false", "none", "off"]);
const MAX_IMPORT_FILE_BYTES = 32 * 1024;
const MAX_IMPORT_CANDIDATES = 100;
const MAX_VISITED_DIRECTORIES = 100;
const MAX_PREVIEW_CHARS = 2_000;
const THREAD_LOOKUP_BATCH = 100;

const HOSTED_CONTENT_SHAPES = [
  ["a private key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/],
  ["a provider token", /\b(?:sk-[A-Za-z0-9]{32,}|sk-(?:proj|live|test|svcacct)-[A-Za-z0-9_-]{16,}|sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/],
  ["a credential assignment", /(?:api[_-]?(?:key|secret)|client[_-]?secret|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i],
];

export function detectHostedContentShape(content) {
  if (typeof content !== "string") return null;
  return HOSTED_CONTENT_SHAPES.find(([, pattern]) => pattern.test(content))?.[0] ?? null;
}

function fileText(file, notes = null, label = "Import source") {
  let descriptor;
  try {
    if (!lstatSync(file).isFile()) return null;
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_IMPORT_FILE_BYTES) {
      notes?.push(`${label} was skipped because it exceeds the ${MAX_IMPORT_FILE_BYTES}-byte import limit.`);
      return null;
    }
    return buffer.toString("utf8", 0, bytes).trim();
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function bucket(content, projectScope) {
  const text = String(content).toLowerCase();
  if (/\b(?:i prefer|my preference|i like|i dislike)\b/.test(text)) return "preference";
  if (/\b(?:always|never|must|should|do not|don't|prefer|use|avoid)\b/.test(text)) return "instruction";
  return projectScope ? "project" : "fact";
}

function saveId(repository, sourceKey, content) {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const digest = repository.scopeFingerprint(`coding-import:${sourceKey}\0${contentHash}`);
  return `coding.${digest.slice(0, 56)}`;
}

function entry(repository, { source, sourceKey, content, projectScope = null, note = null, category = null }) {
  const resolvedCategory = category ?? bucket(content, projectScope);
  const hostedShape = detectHostedContentShape(content);
  const hostedNote = hostedShape
    ? `The hosted content screen is likely to refuse this ${source} item (${resolvedCategory}) at sync time because it matches ${hostedShape}; Switchboard will still import it locally.`
    : null;
  return {
    source,
    source_key: sourceKey,
    content,
    project_scope: projectScope,
    category: resolvedCategory,
    note: [note, hostedNote].filter(Boolean).join(" ") || null,
    save_id: saveId(repository, sourceKey, content),
  };
}

function globalFiles(repository, ownerHome, notes) {
  const files = [
    [path.join(ownerHome, ".claude", "CLAUDE.md"), "Claude global instructions", "claude-global"],
    [path.join(ownerHome, ".codex", "AGENTS.md"), "Codex global guidance", "codex-global"],
  ];
  const rules = path.join(ownerHome, ".codex", "rules");
  if (existsSync(rules)) {
    const names = readdirSync(rules).filter((name) => name.endsWith(".rules")).sort();
    if (names.length > MAX_IMPORT_CANDIDATES) {
      notes.push(`Codex global rule discovery was capped at ${MAX_IMPORT_CANDIDATES} candidate files.`);
    }
    for (const name of names.slice(0, MAX_IMPORT_CANDIDATES)) {
      files.push([path.join(rules, name), "Codex global rule", `codex-rule:${name}`]);
    }
  }
  return files.flatMap(([file, source, key]) => {
    const content = fileText(file, notes, source);
    return content ? [entry(repository, { source, sourceKey: key, content })] : [];
  });
}

function localProjectFiles(repository, project, notes) {
  if (!resolveProjectIdentity(project)) return [];
  const candidates = new Set();
  const explicit = path.join(project, "CLAUDE.local.md");
  if (fileText(explicit, notes, "Project-local instructions") && git(project, ["ls-files", "--error-unmatch", "--", "CLAUDE.local.md"]) === null) {
    candidates.add("CLAUDE.local.md");
  }
  const untracked = git(project, ["ls-files", "--others", "--exclude-standard"]);
  for (const relative of untracked?.split("\n").filter(Boolean) ?? []) {
    if (INSTRUCTION_FILE.test(path.basename(relative))) candidates.add(relative);
    if (candidates.size >= MAX_IMPORT_CANDIDATES) {
      notes.push(`Project-local instruction discovery was capped at ${MAX_IMPORT_CANDIDATES} candidate files.`);
      break;
    }
  }
  const projectScope = resolveProjectScope(repository, project);
  return [...candidates].sort().flatMap((relative) => {
    const content = fileText(path.join(project, relative), notes, "Project-local instructions");
    return content ? [entry(repository, {
      source: "Project-local instructions",
      sourceKey: `project-local:${projectScope}:${relative}`,
      content,
      projectScope,
      category: "instruction",
    })] : [];
  });
}

function resolveClaudeSlug(slug) {
  if (!slug.startsWith("-")) return { candidates: [], truncated: false };
  const found = [];
  const pending = [{
    directory: path.parse(path.resolve("/")).root,
    remaining: slug.slice(1),
    depth: 0,
  }];
  let visited = 0;
  while (pending.length && visited < MAX_VISITED_DIRECTORIES) {
    const { directory, remaining, depth } = pending.pop();
    visited += 1;
    if (!remaining) {
      try { found.push(realpathSync(directory)); } catch {}
      continue;
    }
    if (depth > 64) continue;
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const matches = children
      .filter((child) => {
        if (!(remaining === child.name || remaining.startsWith(`${child.name}-`))) return false;
        if (child.isDirectory()) return true;
        try { return child.isSymbolicLink() && statSync(path.join(directory, child.name)).isDirectory(); }
        catch { return false; }
      })
      .sort((left, right) => right.name.length - left.name.length);
    for (const child of matches.reverse()) {
      const suffix = remaining === child.name ? "" : remaining.slice(child.name.length + 1);
      pending.push({ directory: path.join(directory, child.name), remaining: suffix, depth: depth + 1 });
    }
  }
  return { candidates: [...new Set(found)].sort(), truncated: pending.length > 0 };
}

function factFiles(directory, notes) {
  const results = [];
  const pending = [directory];
  let visited = 0;
  let directoriesTruncated = false;
  while (pending.length && results.length < MAX_IMPORT_CANDIDATES) {
    if (visited >= MAX_VISITED_DIRECTORIES) {
      directoriesTruncated = true;
      break;
    }
    const current = pending.pop();
    visited += 1;
    let children;
    try { children = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const child of children.sort((left, right) => right.name.localeCompare(left.name))) {
      const target = path.join(current, child.name);
      if (child.isDirectory()) pending.push(target);
      else if (child.isFile() && child.name !== "MEMORY.md") results.push(target);
      if (results.length >= MAX_IMPORT_CANDIDATES) break;
    }
  }
  if (directoriesTruncated) {
    notes.push(`Claude Code auto-memory directory traversal was capped at ${MAX_VISITED_DIRECTORIES} directories.`);
  }
  if (results.length >= MAX_IMPORT_CANDIDATES) {
    notes.push(`Claude Code auto-memory discovery was capped at ${MAX_IMPORT_CANDIDATES} candidate files.`);
  }
  return results;
}

function claudeMemories(repository, ownerHome, project) {
  const root = path.join(ownerHome, ".claude", "projects");
  if (!existsSync(root)) return { entries: [], notes: [] };
  const entries = [];
  const notes = [];
  let selectedProject = null;
  try { selectedProject = realpathSync(project); } catch {}
  const slugs = readdirSync(root).sort();
  if (slugs.length > MAX_IMPORT_CANDIDATES) {
    notes.push(`Claude Code project discovery was capped at ${MAX_IMPORT_CANDIDATES} candidates.`);
  }
  for (const slug of slugs.slice(0, MAX_IMPORT_CANDIDATES)) {
    const memory = path.join(root, slug, "memory");
    if (!existsSync(memory)) continue;
    const resolved = resolveClaudeSlug(slug);
    if (resolved.truncated) {
      notes.push(`Claude Code project resolution was capped at ${MAX_VISITED_DIRECTORIES} directories.`);
    }
    const candidates = resolved.candidates;
    const directory = candidates.length === 1
      ? candidates[0]
      : (selectedProject && candidates.includes(selectedProject) ? selectedProject : null);
    const projectScope = directory && resolveProjectIdentity(directory) ? resolveProjectScope(repository, directory) : null;
    if (!projectScope) {
      notes.push(`Claude Code auto-memory was skipped because its project could not be resolved uniquely. Import from inside the checkout with --project.`);
      continue;
    }
    for (const file of factFiles(memory, notes)) {
      const content = fileText(file, notes, "Claude Code auto-memory");
      if (!content) continue;
      entries.push(entry(repository, {
        source: "Claude Code auto-memory",
        sourceKey: `claude-memory:${slug}:${path.relative(memory, file)}`,
        content,
        projectScope,
      }));
    }
  }
  return { entries, notes };
}

function highestNumbered(directory, prefix) {
  if (!existsSync(directory)) return null;
  return readdirSync(directory)
    .map((name) => ({ name, match: new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(name) }))
    .filter((item) => item.match)
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))
    .map((item) => ({ path: path.join(directory, item.name), number: Number(item.match[1]) }))[0] ?? null;
}

async function copiedDatabase(source, temporary, name) {
  if (!source) return null;
  const target = path.join(temporary, name);
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await live.backup(target);
  } finally {
    live.close();
  }
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("snapshot quick_check failed");
    }
    return copy;
  } catch (error) {
    try { copy.close(); } catch {}
    throw error;
  }
}

function columns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)); }
  catch { return new Set(); }
}

async function codexMemories(repository, ownerHome) {
  const codex = path.join(ownerHome, ".codex");
  const stateFile = highestNumbered(codex, "state");
  const memoryFile = highestNumbered(codex, "memories");
  if (!stateFile || !memoryFile) return { entries: [], notes: [] };
  if (stateFile.number !== memoryFile.number) {
    return { entries: [], notes: ["Codex memories were skipped because the state and memory database snapshots are inconsistent."] };
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "switchboard-coding-import-"));
  let state;
  let memories;
  try {
    state = await copiedDatabase(stateFile.path, temporary, "state.sqlite");
    memories = await copiedDatabase(memoryFile.path, temporary, "memories.sqlite");
    const stateColumns = columns(state, "threads");
    const memoryColumns = columns(memories, "stage1_outputs");
    const expectedState = ["thread_id", "cwd", "git_origin_url", "git_sha", "memory_mode"];
    const expectedMemory = ["thread_id", "raw_memory", "rollout_summary", "selected_for_phase2"];
    if (expectedState.some((name) => !stateColumns.has(name)) || expectedMemory.some((name) => !memoryColumns.has(name))) {
      return { entries: [], notes: ["Codex memories were skipped because the database schema is not recognized."] };
    }
    const selected = memories.prepare(`
      SELECT thread_id,
        CASE WHEN length(CAST(raw_memory AS BLOB)) <= ? THEN raw_memory ELSE NULL END AS raw_memory,
        length(CAST(raw_memory AS BLOB)) > ? AS raw_memory_oversize,
        CASE WHEN length(CAST(rollout_summary AS BLOB)) <= ? THEN rollout_summary ELSE NULL END AS rollout_summary,
        length(CAST(rollout_summary AS BLOB)) > ? AS rollout_summary_oversize,
        selected_for_phase2
      FROM stage1_outputs
      WHERE selected_for_phase2 = 1
      LIMIT ?
    `).all(
      MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILE_BYTES,
      MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILE_BYTES,
      MAX_IMPORT_CANDIDATES + 1,
    );
    const truncated = selected.length > MAX_IMPORT_CANDIDATES;
    if (truncated) selected.length = MAX_IMPORT_CANDIDATES;
    const threadIds = [...new Set(selected.map((row) => String(row.thread_id)))];
    const threads = new Map();
    for (let start = 0; start < threadIds.length; start += THREAD_LOOKUP_BATCH) {
      const batch = threadIds.slice(start, start + THREAD_LOOKUP_BATCH);
      const placeholders = batch.map(() => "?").join(",");
      for (const thread of state.prepare(
        `SELECT thread_id, cwd, git_origin_url, git_sha, memory_mode FROM threads WHERE thread_id IN (${placeholders})`
      ).all(...batch)) threads.set(String(thread.thread_id), thread);
    }
    const discovered = [];
    let inconsistent = 0;
    let unresolved = 0;
    let oversized = 0;
    for (const row of selected) {
      const thread = threads.get(String(row.thread_id));
      if (!thread) { inconsistent += 1; continue; }
      if (DISABLED_MEMORY_MODES.has(String(thread.memory_mode ?? "").toLowerCase())) continue;
      let projectScope = thread.git_origin_url ? scopeForRemote(repository, thread.git_origin_url) : null;
      if (!thread.git_origin_url && typeof thread.cwd === "string" && thread.cwd) {
        projectScope = resolveProjectScope(repository, thread.cwd);
      }
      if (!projectScope) { unresolved += 1; continue; }
      for (const [field, source] of [["raw_memory", "Codex session memory"], ["rollout_summary", "Codex rollout summary"]]) {
        if (row[`${field}_oversize`]) { oversized += 1; continue; }
        const content = typeof row[field] === "string" ? row[field].trim() : "";
        if (!content) continue;
        discovered.push(entry(repository, {
          source,
          sourceKey: `codex:${row.thread_id}:${field}`,
          content,
          projectScope,
        }));
      }
    }
    const notes = [];
    if (truncated) notes.push(`Codex discovery was capped at ${MAX_IMPORT_CANDIDATES} selected stage rows.`);
    if (inconsistent) notes.push(`${inconsistent} Codex selected row(s) were skipped because their thread snapshot was inconsistent.`);
    if (unresolved) notes.push(`${unresolved} Codex selected row(s) were skipped because their project could not be resolved.`);
    if (oversized) notes.push(`${oversized} Codex memory value(s) were skipped because they exceed the ${MAX_IMPORT_FILE_BYTES}-byte import limit.`);
    return { entries: discovered, notes };
  } catch {
    return { entries: [], notes: ["Codex memories were skipped because their database copy could not be read."] };
  } finally {
    try { state?.close(); } catch {}
    try { memories?.close(); } catch {}
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function discoverCodingImports({ repository, project = process.cwd(), env = process.env } = {}) {
  const ownerHome = typeof env.HOME === "string" && env.HOME.trim() ? path.resolve(env.HOME) : os.homedir();
  const notes = [];
  const resolvedProject = path.resolve(project);
  const codex = await codexMemories(repository, ownerHome);
  const claude = claudeMemories(repository, ownerHome, resolvedProject);
  let entries = [
    ...globalFiles(repository, ownerHome, notes),
    ...localProjectFiles(repository, resolvedProject, notes),
    ...claude.entries,
    ...codex.entries,
  ];
  if (entries.length > MAX_IMPORT_CANDIDATES) {
    notes.push(`Coding memory discovery was capped at ${MAX_IMPORT_CANDIDATES} candidates; ${entries.length - MAX_IMPORT_CANDIDATES} were not previewed or imported.`);
    entries = entries.slice(0, MAX_IMPORT_CANDIDATES);
  }
  const present = new Set();
  for (let start = 0; start < entries.length; start += THREAD_LOOKUP_BATCH) {
    const batch = entries.slice(start, start + THREAD_LOOKUP_BATCH).map((item) => item.save_id);
    if (!batch.length) continue;
    const placeholders = batch.map(() => "?").join(",");
    for (const row of repository.db.prepare(`SELECT save_id FROM proposals WHERE save_id IN (${placeholders})`).all(...batch)) {
      present.add(row.save_id);
    }
  }
  entries = entries.map((item) => ({
    ...item,
    already_present: present.has(item.save_id),
  }));
  return { entries, notes: [...notes, ...claude.notes, ...codex.notes] };
}

export function printCodingImportPreview({ entries, notes }, write = (text) => process.stdout.write(text)) {
  write(`Coding memory import preview: ${entries.length} item(s).\n`);
  for (const [index, item] of entries.entries()) {
    const scope = item.project_scope ? "project" : "global";
    const present = item.already_present ? " | already present" : "";
    write(`\n[${index + 1}] ${item.source} | ${item.category} | ${scope}${present}\n`);
    if (item.note) write(`Note: ${item.note}\n`);
    const preview = item.content.length > MAX_PREVIEW_CHARS
      ? `${item.content.slice(0, MAX_PREVIEW_CHARS)}\n[Preview truncated; ${item.content.length - MAX_PREVIEW_CHARS} characters remain in the imported item.]`
      : item.content;
    write(`${preview}\n`);
  }
  for (const note of notes) write(`\nNote: ${note}\n`);
}

export async function importCodingMemories({
  repository, discovery, dryRun = false, input = process.stdin, output = process.stdout, confirm = null,
} = {}) {
  printCodingImportPreview(discovery, (text) => output.write(text));
  if (dryRun) return { imported: 0, skipped: 0, already_present: discovery.entries.filter((item) => item.already_present).length };
  let pipedAnswers = null;
  if (!confirm && !input.isTTY) {
    let answers = "";
    for await (const chunk of input) {
      answers += chunk;
      if (answers.length > 64 * 1024) break;
    }
    pipedAnswers = answers.split(/\r?\n/);
  }
  const reader = confirm || pipedAnswers ? null : createInterface({ input, output, terminal: true });
  let imported = 0;
  let skipped = 0;
  try {
    for (const [index, item] of discovery.entries.entries()) {
      if (item.already_present) continue;
      let accepted = false;
      if (confirm) accepted = Boolean(await confirm(item, index));
      else {
        output.write(`Import item ${index + 1}? [y/N] `);
        let answer = pipedAnswers ? pipedAnswers.shift() ?? "" : "";
        try {
          if (reader) answer = await reader.question("");
        } catch { answer = ""; }
        accepted = /^(?:y|yes)$/i.test(answer.trim());
      }
      if (!accepted) {
        skipped += 1;
        continue;
      }
      const result = repository.propose({
        content: item.content,
        category: item.category,
        save_id: item.save_id,
        project_scope: item.project_scope,
      }, { owner: true, source: item.source });
      if (["recorded", "duplicate"].includes(result.status)) imported += result.status === "recorded" ? 1 : 0;
      else skipped += 1;
    }
  } finally {
    reader?.close();
  }
  output.write(`\nImported: ${imported}. Skipped: ${skipped}. Already present: ${discovery.entries.filter((item) => item.already_present).length}.\n`);
  return { imported, skipped, already_present: discovery.entries.filter((item) => item.already_present).length };
}
