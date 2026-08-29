#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { runCodingCommand, STATE_REMEDIATION } from "./coding.js";
import { discoverCodingImports, importCodingMemories } from "./codingImport.js";
import { CODING_PROFILE_CATEGORIES, MEMORY_CATEGORIES, SCHEMA_VERSION } from "./constants.js";
import { runPrefetchHook, runPrefetchWorker } from "./hook.js";
import { forgetHostedLink, HostedLinkError, linkHosted, readHostedLink } from "./hostedLink.js";
import { syncFailureMessage, syncOnce } from "./sync.js";
import { LocalRepository } from "./repository.js";
import { resolveProjectIdentity, resolveProjectScope, resolveProjectScopes } from "./projectIdentity.js";
import { resolveSwitchboardHome } from "./storage.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A downstream pipe closing early (status | head) is a normal way to consume
// this CLI, not an error worth a stack trace.
process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function has(args, name) {
  return args.includes(name);
}

function categories(value, fallback = []) {
  if (value == null) return fallback;
  const result = [...new Set(String(value).split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (!result.length || result.some((category) => !MEMORY_CATEGORIES.includes(category))) throw new Error("invalid categories");
  return result;
}

function explicitProjectScope(repository, project) {
  if (project == null) return null;
  if (typeof project !== "string" || !project.trim()) throw new Error("project must be a Git checkout path");
  const scope = resolveProjectScope(repository, project);
  if (!scope) throw new Error("project must resolve to a Git repository");
  return scope;
}

function explicitProjectScopes(repository, project) {
  if (project == null) return [];
  if (typeof project !== "string" || !project.trim()) throw new Error("project must be a Git checkout path");
  const scopes = resolveProjectScopes(repository, project);
  if (!scopes.length) throw new Error("project must resolve to a Git repository");
  return scopes;
}

function rejectWireProjectScope(input) {
  if (Object.hasOwn(input, "project_scope") || Object.hasOwn(input, "project_scopes")) {
    throw new Error("project_scope is not accepted; supply project");
  }
}

async function readJsonInput() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 128 * 1024) throw new Error("input too large");
  }
  if (!body.trim()) throw new Error("JSON input is required");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed;
}

async function readTextInput() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 128 * 1024) throw new Error("input too large");
  }
  if (!body.trim()) throw new Error("snapshot input is required");
  return body;
}

function expiry(value, now = Date.now()) {
  if (value == null) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(String(value).trim());
  if (!match) throw new Error("invalid handoff duration");
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = Number(match[1]) * units[match[2]];
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("invalid handoff duration");
  return new Date(now + milliseconds).toISOString();
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function discoveryRecord(home) {
  // Host adapters refuse a non-absolute bin: spawning a bare name would defer
  // to PATH, which the discovery record exists to avoid. Record the entry the
  // owner actually invoked (the npm bin shim or this file), resolved.
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  return { version: packageJson.version, home, transport: "cli", bin: invoked };
}

function writeDiscovery(home) {
  const target = path.join(home, "runtime.json");
  const temporary = path.join(home, `.runtime-${process.pid}.json`);
  writeFileSync(temporary, `${JSON.stringify(discoveryRecord(home), null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function printUsage() {
  process.stdout.write(`Usage: switchboard <command>\n\n` +
    "Commands: init, status, remember, recall, inbox, client, grant, profile, config, memory, handoff, link, unlink, sync [--replay-from <seq>], doctor, coding, hook, prefetch, propose, handoff-create, handoff-claim\n" +
    "Version: switchboard --version, switchboard -v, switchboard version\n" +
    "Coding: switchboard coding import [--project <path>] [--dry-run]\n");
}

function humanRows(rows) {
  for (const row of rows) {
    process.stdout.write(`${row.memory_id}  ${row.category}  ${row.content}\n`);
  }
}

function unavailableOutcome(command, saveId = "") {
  if (command === "prefetch") {
    return {
      status: "unavailable",
      transport: "local",
      connectivity: "offline",
      freshness: "fresh",
      as_of: null,
      rows: [],
      skipped_categories: [],
    };
  }
  if (command === "handoff-create") {
    return { status: "unavailable", handoff_id: null, expires_at: null };
  }
  if (command === "handoff-claim") {
    return { status: "unavailable", handoff_id: null, snapshot: null, expires_at: null };
  }
  return { status: "unavailable", proposal_id: null, save_id: saveId, disposition: "pending" };
}

async function runMachine(command, repository, preparedInput = null) {
  let input = preparedInput;
  try {
    input ??= await readJsonInput();
    if (command === "prefetch") {
      rejectWireProjectScope(input);
      if (typeof input.client_id !== "string" || typeof input.client_secret !== "string") throw new Error("client credentials required");
      if (input.categories != null && !Array.isArray(input.categories)) throw new Error("categories must be an array");
      if (input.query != null && typeof input.query !== "string") throw new Error("query must be a string");
      if (input.limit != null && (typeof input.limit !== "number" || !Number.isFinite(input.limit))) throw new Error("limit must be a number");
      if (input.ambient != null && typeof input.ambient !== "boolean") throw new Error("ambient must be a boolean");
      if (input.project != null && typeof input.project !== "string") throw new Error("project must be a string");
      const requested = input.categories ?? CODING_PROFILE_CATEGORIES;
      if (requested.some((category) => !MEMORY_CATEGORIES.includes(category))) throw new Error("invalid category");
      writeJson(repository.read({
        ...input,
        categories: requested,
        project_scopes: explicitProjectScopes(repository, input.project),
      }, { receipt: input.ambient === false }));
      return 0;
    }
    if (command === "propose") {
      rejectWireProjectScope(input);
      for (const field of ["client_id", "client_secret", "save_id", "content", "category"]) {
        if (typeof input[field] !== "string") throw new Error(`${field} is required`);
      }
      if (input.project != null && typeof input.project !== "string") throw new Error("project must be a string");
      writeJson(repository.propose({
        ...input,
        project_scope: explicitProjectScope(repository, input.project),
      }));
      return 0;
    }
    if (command === "handoff-create") {
      for (const field of ["client_id", "client_secret", "snapshot"]) {
        if (typeof input[field] !== "string") throw new Error(`${field} is required`);
      }
      if ((typeof input.to_client_id === "string") === (typeof input.profile === "string")) {
        throw new Error("one handoff target is required");
      }
      if (input.project != null && typeof input.project !== "string") throw new Error("project must be a string");
      if (input.expires != null && typeof input.expires !== "string") throw new Error("expires must be a duration");
      writeJson(repository.createHandoff({ ...input, expires_at: expiry(input.expires) }));
      return 0;
    }
    if (command === "handoff-claim") {
      for (const field of ["client_id", "client_secret"]) {
        if (typeof input[field] !== "string") throw new Error(`${field} is required`);
      }
      if (input.project != null && typeof input.project !== "string") throw new Error("project must be a string");
      writeJson(repository.claimHandoff(input));
      return 0;
    }
    throw new Error("unknown machine command");
  } catch (error) {
    if (error instanceof SyntaxError || /required|must be|invalid|handoff|target client|project|authentication failed|input too large|unknown machine|save_id must match/.test(error.message)) {
      process.stderr.write(error.message.startsWith("save_id must match") ? `${error.message}\n` : "Malformed invocation.\n");
      return 2;
    }
    process.stderr.write("Switchboard could not complete the request.\n");
    writeJson(unavailableOutcome(command, typeof input?.save_id === "string" ? input.save_id : ""));
    return 0;
  }
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (["--version", "-v", "version"].includes(command)) {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (!command || has(args, "--help") || command === "help") {
    printUsage();
    return 0;
  }

  const home = resolveSwitchboardHome();
  if (command === "link" && has(args, "--status")) {
    try {
      const linked = readHostedLink(home);
      if (!linked) process.stdout.write("Switchboard is not linked.\n");
      else process.stdout.write(`linked: ${linked.status}\nbase_url: ${linked.base_url}\ndevice_id: ${linked.device_id}\n`);
      return 0;
    } catch {
      process.stderr.write("The local hosted link record is invalid.\n");
      return 1;
    }
  }
  if (command === "unlink") {
    try {
      forgetHostedLink(home);
      process.stdout.write("Local sync credentials were removed. Revoke this device in the signed-in Passport device settings.\n");
      return 0;
    } catch {
      process.stderr.write("Local sync credentials could not be removed.\n");
      return 1;
    }
  }
  const invokedBin = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  if (command === "hook") {
    const host = args[1] === "claude-prefetch" ? "claude-code" : args[1] === "codex-prefetch" ? "codex" :
      args[1] === "cursor-prefetch" ? "cursor" : null;
    return host ? await runPrefetchHook({ host, binPath: invokedBin }) : 0;
  }
  if (command === "coding" && args[1] === "install" && !existsSync(path.join(home, "runtime.json"))) {
    process.stderr.write("Run switchboard init first\n");
    return 2;
  }
  const machineCommand = ["prefetch", "propose", "handoff-create", "handoff-claim"].includes(command) && has(args, "--json");
  let machineInput = null;
  if (machineCommand) {
    try {
      machineInput = await readJsonInput();
      if (["prefetch", "propose"].includes(command)) rejectWireProjectScope(machineInput);
      if (["prefetch", "propose"].includes(command) && machineInput.project != null &&
        (typeof machineInput.project !== "string" || !machineInput.project.trim() || !resolveProjectIdentity(machineInput.project))) {
        throw new Error("project must resolve to a Git repository");
      }
    } catch {
      process.stderr.write("Malformed invocation.\n");
      return 2;
    }
  }
  const humanScopedCommand = ["remember", "recall"].includes(command) || (command === "coding" && args[1] === "import");
  if (humanScopedCommand && has(args, "--project")) {
    const project = option(args, "--project");
    if (!project || !resolveProjectIdentity(project)) {
      process.stderr.write("Project must resolve to a Git repository.\n");
      return 2;
    }
  }
  let repository;
  try {
    repository = new LocalRepository({ home });
  } catch {
    if (command === "hook-worker") return 0;
    if (machineCommand) {
      process.stderr.write("Switchboard store is unavailable.\n");
      writeJson(unavailableOutcome(command, typeof machineInput.save_id === "string" ? machineInput.save_id : ""));
      return 0;
    }
    process.stderr.write("Switchboard store is unavailable.\n");
    return 1;
  }

  try {
    if (command === "hook-worker") {
      const host = ["claude-code", "codex", "cursor"].includes(args[1]) ? args[1] : null;
      return host ? await runPrefetchWorker({ host, repository }) : 0;
    }

    if (machineCommand) {
      return await runMachine(command, repository, machineInput);
    }

    if (command === "init") {
      writeDiscovery(home);
      process.stdout.write(
        "Switchboard is ready. Memories saved by paired coding agents are kept automatically in your AI Passport and are readable by clients you grant. " +
        "Review mode is available through config. Nothing leaves this machine.\n"
      );
      return 0;
    }

    if (command === "status") {
      const status = repository.status();
      if (has(args, "--json")) writeJson(status);
      else {
        process.stdout.write(`schema: ${status.schema_version}\npolicy: ${status.policy_mode}\nstore: ${status.store}\n`);
        for (const category of MEMORY_CATEGORIES) process.stdout.write(`${category}: ${status.memory_counts[category] ?? 0}\n`);
        process.stdout.write(`clients: ${status.clients.length}\n`);
        for (const client of status.clients) {
          const grants = client.grants.flatMap((grant) => grant.categories).join(",") || "none";
          process.stdout.write(`${client.client_id}  ${client.host}  ${client.label}  grants=${grants}  ${client.revoked_at ? "revoked" : "active"}\n`);
        }
      }
      return 0;
    }

    if (command === "remember") {
      const content = args[1];
      const category = option(args, "--category");
      if (!content || !category) throw new Error("remember requires text and --category");
      const result = repository.propose({
        content,
        category,
        save_id: `owner.${crypto.randomUUID()}`,
        project_scope: explicitProjectScope(repository, option(args, "--project")),
      }, { owner: true });
      if (result.status !== "recorded") throw new Error("memory was refused");
      process.stdout.write(`Saved to your Passport. Proposal ${result.proposal_id}.\n`);
      return 0;
    }

    if (command === "recall") {
      const requested = categories(option(args, "--categories"), CODING_PROFILE_CATEGORIES);
      const result = repository.read({
        categories: requested,
        query: option(args, "--query") ?? "",
        project_scopes: explicitProjectScopes(repository, option(args, "--project")),
      }, { owner: true, receipt: false });
      humanRows(result.rows);
      if (!result.rows.length) process.stdout.write("No matching memories.\n");
      return 0;
    }

    if (command === "inbox") {
      const action = args[1];
      if (action === "list") humanRows(repository.listInbox().map((row) => ({ memory_id: row.proposal_id, ...row })));
      else if (action === "approve" && args[2]) process.stdout.write(repository.approveProposal(args[2]) ? "Approved.\n" : "No pending proposal.\n");
      else if (action === "reject" && args[2]) process.stdout.write(repository.rejectProposal(args[2]) ? "Rejected.\n" : "No pending proposal.\n");
      else throw new Error("inbox requires list, approve, or reject");
      return 0;
    }

    if (command === "client") {
      const action = args[1];
      if (action === "add") {
        const created = repository.addClient({ host: option(args, "--host"), label: option(args, "--label") });
        process.stdout.write(`client_id: ${created.client_id}\nclient_secret: ${created.client_secret}\nStore this secret now. It is not shown again.\n`);
      } else if (action === "list") writeJson(repository.listClients());
      else if (action === "revoke" && args[2]) process.stdout.write(repository.revokeClient(args[2]) ? "Client revoked.\n" : "Unknown client.\n");
      else throw new Error("client requires add, list, or revoke");
      return 0;
    }

    if (command === "grant") {
      const action = args[1];
      if (action === "add") {
        const project = option(args, "--project");
        const projectScope = project ? resolveProjectScope(repository, project) : null;
        if (project && !projectScope) throw new Error("project has no repository identity");
        const created = repository.addGrant({
          clientId: option(args, "--client"),
          profile: option(args, "--profile"),
          categories: option(args, "--categories") ? categories(option(args, "--categories")) : null,
          projectScopes: projectScope ? [projectScope] : [],
        });
        writeJson(created);
      } else if (action === "list") writeJson(repository.listGrants(option(args, "--client")));
      else if (action === "revoke" && args[2]) process.stdout.write(repository.revokeGrant(args[2]) ? "Grant revoked.\n" : "Unknown grant.\n");
      else throw new Error("grant requires add, list, or revoke");
      return 0;
    }

    if (command === "profile" && args[1] === "show") {
      const requested = args[2] ?? "coding";
      const profile = repository.profile(requested);
      if (!profile) throw new Error("unknown profile");
      writeJson(profile);
      return 0;
    }

    if (command === "config") {
      const action = args[1];
      if (action === "get") {
        process.stdout.write(`auto_approve ${repository.metadata().auto_approve ? "on" : "off"}\n`);
      } else if (action === "set" && args[2] === "auto_approve" && ["on", "off"].includes(args[3])) {
        repository.setAutoApprove(args[3] === "on");
        process.stdout.write(`auto_approve ${args[3]}\n`);
      } else throw new Error("config requires get or set auto_approve on|off");
      return 0;
    }

    if (command === "memory") {
      const action = args[1];
      if (action === "list") humanRows(repository.listMemories());
      else if (action === "delete" && has(args, "--json")) {
        let input;
        try {
          input = await readJsonInput();
          for (const field of ["client_id", "client_secret", "memory_id"]) if (typeof input[field] !== "string") throw new Error("field required");
        } catch {
          process.stderr.write("Malformed invocation.\n");
          return 2;
        }
        writeJson(repository.deleteMemory(input.memory_id, {
          owner: false,
          clientId: input.client_id,
          clientSecret: input.client_secret,
        }));
      } else if (action === "delete" && args[2]) writeJson(repository.deleteMemory(args[2]));
      else throw new Error("memory requires list or delete");
      return 0;
    }

    if (command === "handoff") {
      const action = args[1];
      if (action === "create") {
        const snapshot = await readTextInput();
        const result = repository.createHandoff({
          snapshot,
          to_client_id: option(args, "--to"),
          profile: option(args, "--profile"),
          project: option(args, "--project"),
          expires_at: expiry(option(args, "--expires")),
        }, { owner: true });
        writeJson(result);
      } else if (action === "list") {
        writeJson(repository.listHandoffs());
      } else throw new Error("handoff requires create or list");
      return 0;
    }

    if (command === "link") {
      // AI Passport is the hosted plane; the URL argument is an override for
      // development and self-hosted planes.
      const baseUrl = !args[1] || args[1].startsWith("--") ? "https://passport.ego.ist" : args[1];
      try {
        const linked = await linkHosted({
          repository,
          baseUrl,
          onInstruction: ({
            link_url: linkUrl, match_code: matchCode,
            legacy_pending: legacyPending, resuming_pending: resumingPending,
          }) => {
            if (legacyPending) {
              process.stdout.write("This device has an older pending enrollment. Approve or revoke it in Passport Devices.\nWaiting for approval.\n");
              return;
            }
            if (resumingPending) {
              process.stdout.write("Resuming the pending device link. Waiting for its original approval result.\n");
              return;
            }
            process.stdout.write(
              `Open this URL in any signed-in browser:\n${linkUrl}\n` +
              `Match code: ${matchCode}\nWaiting for approval.\n`,
            );
          },
        });
        process.stdout.write(linked.status === "approved" ? "Switchboard is linked.\n" : "Device approval is still pending.\n");
        return linked.status === "approved" ? 0 : 1;
      } catch (error) {
        if (error instanceof HostedLinkError && error.code === "link_refused") {
          process.stderr.write("Device linking was refused.\n");
          return 1;
        }
        if (error instanceof HostedLinkError && error.code === "link_expired") {
          process.stderr.write("Device linking expired. Run switchboard link again.\n");
          return 1;
        }
        throw error;
      }
    }

    if (command === "sync") {
      const replayValue = option(args, "--replay-from");
      let replayFrom = null;
      if (has(args, "--replay-from")) {
        if (!/^[1-9][0-9]*$/.test(String(replayValue || ""))) {
          throw new Error("replay sequence must be a positive integer within the assigned range");
        }
        replayFrom = Number(replayValue);
        if (!Number.isSafeInteger(replayFrom)) {
          throw new Error("replay sequence must be a positive integer within the assigned range");
        }
      }
      const result = await syncOnce({ repository, replayFrom });
      if (!has(args, "--json") && replayFrom != null) {
        process.stdout.write(`queued_for_replay: ${result.replay_queued}\n`);
      }
      if (has(args, "--json")) writeJson(result);
      else if (result.status === "ok") {
        process.stdout.write(
          `pulled: ${result.pulled}\napplied: ${result.applied}\ntombstones: ${result.tombstones}\n` +
          `pushed: ${result.pushed}\npending: ${result.pending}\nrejected: ${result.rejected}\nreemitted: ${result.reemitted}\n` +
          `superseded: ${result.superseded}\nconflicts: ${result.conflicts}\n` +
          `skipped: ${result.skipped}\nskipped_handoffs: ${result.skipped_handoffs}\nnew_cursor: ${result.new_cursor}\n`,
        );
        for (const row of result.content_rejected_rows) {
          const article = row.category === "instruction" ? "an" : "a";
          const memory = row.category ? `${article} ${row.category} memory` : "a memory";
          const created = row.created_at ? ` created ${row.created_at}` : " with an unknown creation time";
          process.stdout.write(
            `The hosted content screen rejected ${memory}${created} (entity ${row.entity_id}). ` +
            "Edit or delete it locally, then run switchboard sync.\n",
          );
        }
        if (result.rejected > 0) {
          process.stdout.write(
            "Issue #916: A memory could not sync and stays local; re-save it to retry.\n" +
            "Re-emission queued the memory; run another sync to complete it.\n",
          );
        }
        if (result.conflicts > 0) process.stdout.write("Run switchboard memory list.\n");
      } else process.stderr.write(`${syncFailureMessage(result)}\n`);
      return result.status === "ok" ? 0 : 1;
    }

    if (command === "doctor") {
      const discoveryPath = path.join(home, "runtime.json");
      let discovery = null;
      try {
        discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
      } catch {}
      const report = {
        store_directory_private: (statSync(home).mode & 0o777) === 0o700,
        database_private: (statSync(repository.databasePath).mode & 0o777) === 0o600,
        schema_current: repository.metadata().schema_version === SCHEMA_VERSION,
        discovery_consistent: Boolean(discovery && JSON.stringify(discovery) === JSON.stringify(discoveryRecord(home)) && (statSync(discoveryPath).mode & 0o777) === 0o600),
      };
      writeJson(report);
      return Object.values(report).every(Boolean) ? 0 : 1;
    }

    if (command === "coding") {
      if (args[1] === "import") {
        const discovery = await discoverCodingImports({
          repository,
          project: option(args, "--project") ?? process.cwd(),
        });
        await importCodingMemories({ repository, discovery, dryRun: has(args, "--dry-run") });
        return 0;
      }
      return runCodingCommand({
        args,
        repository,
        home,
        binPath: process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url),
      });
    }

    throw new Error("unknown command");
  } catch (error) {
    const safeMessages = new Set([
      "link requires a base URL",
      "replay sequence must be a positive integer within the assigned range",
      "invalid categories",
      "remember requires text and --category",
      "memory was refused",
      "inbox requires list, approve, or reject",
      "client requires add, list, or revoke",
      "grant requires add, list, or revoke",
      "unknown profile",
      "config requires get or set auto_approve on|off",
      "memory requires list or delete",
      "handoff requires create or list",
      "handoff requires one exact client or the coding profile",
      "unknown or revoked target client",
      "project scope requires the coding profile",
      "handoff expiry must be in the future",
      "invalid handoff duration",
      "unknown command",
      "invalid host",
      "invalid label",
      "unknown client",
      "categories are required",
      "invalid project scope",
      "invalid project scopes",
      "project has no repository identity",
      "Run switchboard init first",
      "Use either --project or --global",
      "Only Claude Code and OpenCode support --global",
      "No supported coding host was found",
      "invalid coding target",
      "host config must contain one JSON object",
      "UserPromptSubmit hooks must be an array",
      "OpenCode plugin installation failed",
      "OpenCode plugin entry already exists and is not managed by Switchboard",
      ".opencode/package.json exists and is not valid JSON",
      "host config hooks must be an object",
      "UserPromptSubmit entries must contain a hooks array",
      "UserPromptSubmit contains an invalid hook entry",
      "Cursor hooks version must be 1",
      "Cursor hooks must be an object",
      "Cursor sessionStart hooks must be an array",
      "Cursor sessionStart contains an invalid hook entry",
      "host config symlink must resolve to a regular file",
      "host config must be a regular file",
      "host config identity no longer matches install state",
      "host config identity changed during installation",
      "host config changed twice; refusing to overwrite it",
      "recorded hook changed; refusing to replace an unowned entry",
      "OpenCode plugin entry changed during installation",
      "host credentials exist without install state; refusing to take ownership",
      STATE_REMEDIATION,
      "uninstall requires one valid --target",
      "coding requires install, status, doctor, or uninstall",
    ]);
    const safe = safeMessages.has(error.message) ||
      /^Coding host not found: (opencode|claude-code|codex|cursor)$/.test(error.message) ||
      /^OpenCode node_modules contains entries npm does not track: .+\. Remove them or declare them in this directory's package\.json before reinstalling\.$/.test(error.message);
    process.stderr.write(`${safe ? error.message : "Command could not be completed."}\n`);
    return 2;
  } finally {
    repository.close();
  }
}

process.exitCode = await main();
