import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readHostedLink } from "./hostedLink.js";
import { acquireLock, lockPath, lockStatus, LockBlockedError } from "./messaging.js";

export const messagingLinkKey = link => createHash("sha256").update(`${link.base_url}\0${link.device_id}\0${link.credential}`).digest("hex");
export function approvedMessagingLink(repository) {
  if (!repository.messagingEnabled()) return null;
  const link = readHostedLink(repository.home);
  return link?.status === "approved" ? link : null;
}
const ERROR_CODES = new Set([
  "unavailable", "network_failure", "device_unauthorized", "agent_required", "invalid_response",
  "link_changed", "sender_revoked", "content_unavailable", "parent_pending", "messaging_unlinked_or_disabled",
  "messaging_disabled", "message_content_refused", "group_required", "group_not_found", "group_expired",
  "group_revoked", "group_not_approved", "not_authorized", "forbidden", "agent_not_found", "agent_revoked",
  "recipient_not_found", "conversation_not_found", "conversation_mismatch", "continuation_required",
  "purpose_required", "proposal_not_found", "proposal_limit",
  "idempotency_conflict", "rate_limited", "invalid_request", "unauthorized", "invalid_group",
]);
const errorCode = error => ERROR_CODES.has(error?.message) ? error.message : "unavailable";

export class MessagingRelay {
  constructor(repository, { fetchImpl = globalThis.fetch, hostname = os.hostname(), signal } = {}) {
    this.repository = repository;
    this.fetch = fetchImpl;
    this.hostname = hostname;
    this.signal = signal;
    this.streams = new Map();
    this.pulls = new Map();
  }
  link() {
    const link = approvedMessagingLink(this.repository);
    if (!link) throw new Error("messaging_unlinked_or_disabled");
    return link;
  }
  async request(route, { agentId, body, signal = this.signal, stream = false } = {}) {
    const link = this.link();
    const url = new URL(`${link.base_url}/messaging/v1/${route}`);
    if (agentId && body === undefined) url.searchParams.set("agent_id", agentId);
    const response = await this.fetch(url.toString(), {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${link.credential}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify({ ...body, ...(agentId ? { agent_id: agentId } : {}) }) }),
      signal: stream ? signal : AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]),
    });
    if (stream && response.ok) return response;
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("invalid_response");
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("invalid_response"); }
    if (!response.ok) throw new Error(errorCode({ message: data?.error }));
    // Stop a response from an old account crossing an unlink/relink or consent change.
    if (messagingLinkKey(this.link()) !== messagingLinkKey(link)) throw new Error("link_changed");
    return data;
  }
  async register() {
    const key = messagingLinkKey(this.link());
    const clients = this.repository.listClients().filter(c => !c.revoked_at);
    const rows = [];
    for (const client of clients) {
      const runtime = client.host === "claude-code" ? "claude_code" : client.host;
      const label = `${client.label} on ${this.hostname}`.slice(0, 80);
      const { agent } = await this.request("register", { body: { installation: client.client_id, label, runtime } });
      if (!agent || !/^[0-9a-f-]{36}$/i.test(agent.id) || agent.installation !== client.client_id) throw new Error("invalid_response");
      if (!this.repository.listClients().some(c => c.client_id === client.client_id && !c.revoked_at)) continue;
      this.repository.db.prepare("INSERT INTO messaging_agents(client_id, agent_id, link_key, label, runtime) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET agent_id=excluded.agent_id, link_key=excluded.link_key, label=excluded.label, runtime=excluded.runtime")
        .run(client.client_id, agent.id, key, label, runtime);
      rows.push({ client_id: client.client_id, agent_id: agent.id, link_key: key });
    }
    return rows;
  }
  registrations() {
    const key = messagingLinkKey(this.link());
    return this.repository.db.prepare("SELECT a.* FROM messaging_agents a JOIN clients c USING(client_id) WHERE c.revoked_at IS NULL AND a.link_key = ?").all(key);
  }
  async peers(clientId = null) {
    let registrations = await this.register();
    if (clientId) registrations = registrations.filter(a => a.client_id === clientId);
    const agents = new Map(), groups = new Map(), proposals = new Map(), routes = [];
    for (const registration of registrations) {
      const result = await this.request("agents", { agentId: registration.agent_id });
      if (!Array.isArray(result.agents) || !Array.isArray(result.groups) || result.self?.id !== registration.agent_id) throw new Error("invalid_response");
      for (const proposal of result.proposals ?? []) {
        proposals.set(proposal.id, proposal);
        this.cacheProposal(proposal);
      }
      for (const group of result.groups) groups.set(group.id, group);
      for (const agent of result.agents) {
        const shared = result.groups.filter(g => g.agent_ids.includes(registration.agent_id) && g.agent_ids.includes(agent.id));
        const sharedIds = agent.shared_group_ids ?? shared.map(g => g.id);
        agents.set(agent.id, { ...agent, shared_group_ids: [...new Set([...(agents.get(agent.id)?.shared_group_ids ?? []), ...sharedIds])] });
        if (!shared.length) routes.push({ ref: agent.id, group_id: null, sender_id: registration.agent_id, client_id: registration.client_id });
        for (const group of shared) {
          routes.push({ ref: agent.id, group_id: group.id, sender_id: registration.agent_id, client_id: registration.client_id });
        }
      }
    }
    return { agents: [...agents.values()], groups: [...groups.values()], proposals: [...proposals.values()], routes };
  }
  cacheProposal(proposal) {
    if (!proposal?.id || !["pending", "approved", "denied", "expired"].includes(proposal.state)) throw new Error("invalid_response");
    this.repository.db.prepare("INSERT INTO messaging_proposals(proposal_id, link_key, payload) VALUES (?, ?, ?) ON CONFLICT(proposal_id, link_key) DO UPDATE SET payload=excluded.payload")
      .run(proposal.id, messagingLinkKey(this.link()), JSON.stringify(proposal));
  }
  async reconcileHeld(registration, messageId = null) {
    if (!this.registrations().some(a => a.agent_id === registration.agent_id && a.link_key === registration.link_key)) return;
    const rows = this.repository.db.prepare(`SELECT * FROM messages WHERE origin = 'local' AND to_kind = 'hosted'
      AND state = 'held' AND hosted_sender_id = ? AND link_key = ?
      AND (? IS NULL OR hosted_receipt_id = ?)`).all(registration.agent_id, registration.link_key, messageId, messageId);
    for (const row of rows) {
      try {
        const result = await this.request(`status?message_id=${encodeURIComponent(row.hosted_receipt_id)}`, { agentId: registration.agent_id });
        if (result.id !== row.hosted_receipt_id || result.sender_agent_id !== row.hosted_sender_id || result.recipient_agent_id !== row.to_ref) throw new Error("invalid_response");
        if (!this.registrations().some(a => a.agent_id === registration.agent_id && a.link_key === registration.link_key)) continue;
        this.repository.completeOutbound(row.message_id, result);
        if (row.proposal_id && result.state !== "held") {
          const proposal = await this.request(`proposals?proposal_id=${encodeURIComponent(row.proposal_id)}`, { agentId: registration.agent_id });
          this.cacheProposal(proposal);
        }
      } catch (error) { this.recordError(error); }
    }
  }
  async inbound(registration) {
    if (this.pulls.has(registration.agent_id)) return this.pulls.get(registration.agent_id);
    const run = async () => {
      // Only acknowledge after the body and receipt have committed to SQLite.
      for (let page = 0; page < 100; page++) {
        if (!this.registrations().some(a => a.agent_id === registration.agent_id)) return;
        const result = await this.request("receive", { agentId: registration.agent_id, body: { limit: 10 } });
        if (!Array.isArray(result.messages) || result.messages.length > 10) throw new Error("invalid_response");
        for (const message of result.messages) {
          if (message.recipient_agent_id !== registration.agent_id) throw new Error("invalid_response");
          this.repository.acceptHostedMessage(registration.client_id, message, registration.link_key);
          await this.request("ack", { agentId: registration.agent_id, body: { message_id: message.id } });
        }
        if (result.messages.length < 10) break;
      }
    };
    const pending = run().finally(() => this.pulls.delete(registration.agent_id));
    this.pulls.set(registration.agent_id, pending);
    return pending;
  }
  recordError(error) {
    this.repository.db.prepare("INSERT INTO meta(key,value) VALUES ('messaging_last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(errorCode(error));
  }
  async outbound(messageId = null) {
    const key = messagingLinkKey(this.link());
    this.repository.expireMessages();
    const rows = this.repository.db.prepare("SELECT * FROM messages WHERE to_kind = 'hosted' AND origin = 'local' AND state = 'pending' AND (retry_at IS NULL OR retry_at <= ?) AND (? IS NULL OR message_id = ?) ORDER BY created_at").all(new Date().toISOString(), messageId, messageId);
    for (const row of rows) {
      try {
        if (row.link_key !== key) throw new Error("link_changed");
        const registration = this.registrations().find(a => a.agent_id === row.hosted_sender_id);
        if (!registration || (row.from_kind === "client" && row.from_ref !== registration.client_id)) throw new Error("sender_revoked");
        const content = this.repository.db.prepare("SELECT content FROM content_records WHERE entity_id = ?").get(row.message_id);
        if (!content) throw new Error("content_unavailable");
        const parent = row.reply_to ? this.repository.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(row.reply_to) : null;
        const parentHostedId = parent?.origin === "hosted" ? parent.hosted_message_id : parent?.hosted_receipt_id;
        if (parent && !parentHostedId) throw new Error("parent_pending");
        const body = {
          recipient_agent_id: row.to_ref, ...(row.hosted_group_id ? { group_id: row.hosted_group_id } : {}),
          ...(row.send_options ? JSON.parse(this.repository.payloadCodec.decode(row.send_options)) : {}),
          idempotency_key: row.idempotency_key, body: this.repository.payloadCodec.decode(content.content),
          ...(row.hosted_conversation_id ? { conversation_id: row.hosted_conversation_id } : {}),
          ...(parent ? { reply_to: parentHostedId } : {}),
        };
        const result = await this.request("send", { agentId: row.hosted_sender_id, body });
        const unapprovedProposal = ["held", "denied", "expired"].includes(result.state)
          && result.group_id === null && /^[0-9a-f-]{36}$/i.test(result.proposal_id ?? "");
        if (result.sender_agent_id !== row.hosted_sender_id || result.recipient_agent_id !== row.to_ref
          || (row.hosted_group_id && result.group_id !== row.hosted_group_id && !unapprovedProposal)) throw new Error("invalid_response");
        this.repository.completeOutbound(row.message_id, result);
        if (result.state === "held") {
          try { this.cacheProposal(await this.request(`proposals?proposal_id=${encodeURIComponent(result.proposal_id)}`, { agentId: row.hosted_sender_id })); }
          catch (error) { this.recordError(error); }
        }
      } catch (error) {
        this.repository.db.prepare("UPDATE messages SET attempts=attempts+1, last_error=?, retry_at=? WHERE message_id=? AND state='pending'")
          .run(errorCode(error), new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))).toISOString(), row.message_id);
        this.recordError(error);
      }
    }
  }
  async stream(registration, signal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const response = await this.request("events", { agentId: registration.agent_id, stream: true, signal });
        if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new Error("invalid_response");
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          if (buffer.length > 65536) throw new Error("invalid_response");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (/^event:\s*(ready|message)$/m.test(event)) {
              // The status endpoint supplies the canonical receipt, including the approved group.
              const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              let messageId = null;
              if (/^event:\s*message$/m.test(event)) {
                try { messageId = JSON.parse(data).message_id; } catch { throw new Error("invalid_response"); }
                if (typeof messageId !== "string") throw new Error("invalid_response");
              }
              await this.reconcileHeld(registration, messageId);
              await this.inbound(registration);
            }
          }
          backoff = 1000;
          if (signal.aborted) break;
        }
      } catch (error) { if (!signal.aborted) this.recordError(error); }
      await delay(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(20000, backoff * 2);
    }
  }
  async run() {
    this.link();
    let release;
    try { release = acquireLock(lockPath(this.repository.home)); }
    catch (error) {
      if (error instanceof LockBlockedError) return { status: "blocked", guard: error.guard, recovery: error.recovery };
      throw error;
    }
    if (!release) return { status: "already_running" };
    try {
      let reconciliation = 0;
      while (!this.signal?.aborted && approvedMessagingLink(this.repository)) {
        if (Date.now() >= reconciliation) {
          try {
            const registrations = await this.register();
            // Passport accepts at most eight streams for a device principal.
            const active = registrations.slice(0, 8);
            for (const [id, running] of this.streams) {
              if (!active.some(a => a.agent_id === id && a.link_key === running.key)) {
                running.controller.abort(); await running.promise; this.streams.delete(id);
              }
            }
            for (const registration of active) {
              if (!this.streams.has(registration.agent_id)) {
                const controller = new AbortController();
                const signal = this.signal ? AbortSignal.any([controller.signal, this.signal]) : controller.signal;
                this.streams.set(registration.agent_id, { controller, key: registration.link_key, promise: this.stream(registration, signal) });
              }
            }
            await Promise.all(registrations.map(async r => {
              try {
                await this.reconcileHeld(r);
                await this.inbound(r);
                const discovery = await this.request("agents", { agentId: r.agent_id });
                for (const proposal of discovery.proposals ?? []) this.cacheProposal(proposal);
              } catch (error) { this.recordError(error); }
            }));
          } catch (error) { this.recordError(error); }
          reconciliation = Date.now() + 20000;
        }
        // Consent can be withdrawn while the reconciliation above awaits; a
        // withdrawn link is a clean stop, not a relay fault.
        if (!approvedMessagingLink(this.repository)) break;
        try { await this.outbound(); }
        catch (error) {
          if (error?.message === "messaging_unlinked_or_disabled") break;
          this.recordError(error);
        }
        await delay(500, undefined, { signal: this.signal }).catch(() => {});
      }
    } finally {
      for (const running of this.streams.values()) running.controller.abort();
      await Promise.allSettled([...this.streams.values()].map(r => r.promise));
      release();
    }
    return { status: "stopped" };
  }
}

export function ensureMessagingRelay(repository) {
  if (!approvedMessagingLink(repository) || lockStatus(lockPath(repository.home)).status !== "stopped") return false;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "messaging", "relay"], {
    env: { ...process.env, SWITCHBOARD_HOME: repository.home }, detached: true, stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return true;
}

export async function messageAgents(repository, input = null, options = {}) {
  if (input) repository.requireMessagingClient(input);
  else if (!repository.messagingEnabled()) return { status: "disabled", local: [], agents: [], groups: [], proposals: [] };
  const local = repository.listClients().filter(c => !c.revoked_at);
  if (!approvedMessagingLink(repository)) return { status: "ok", local, agents: [], groups: [], proposals: [] };
  try {
    const { agents, groups, proposals } = await new MessagingRelay(repository, options).peers(input?.client_id);
    if (input) repository.requireMessagingClient(input);
    return { status: "ok", local, agents, groups, proposals };
  } catch {
    if (input) repository.requireMessagingClient(input);
    return { status: "hosted_unavailable", local, agents: [], groups: [], proposals: [] };
  }
}

export async function sendMessage(repository, input, { owner = false, ...options } = {}) {
  repository.requireMessagingClient(input, { owner });
  if (typeof input.to !== "string" || !input.to.trim()) throw new Error("invalid message target");
  const local = repository.listClients().find(c => c.client_id === input.to);
  if (local) return repository.sendMessage(input, { owner });
  const relay = new MessagingRelay(repository, options);
  const peers = await relay.peers(owner ? null : input.client_id);
  const matches = peers.agents.filter(a => a.id === input.to || a.label === input.to);
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous hosted label: ${matches.map(a => a.id).join(", ")}` : "invalid message target");
  const peer = matches[0];
  const parent = input.reply_to ? repository.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(input.reply_to) : null;
  const routes = peers.routes.filter(r => r.ref === peer.id && (!parent || r.sender_id === parent.hosted_sender_id));
  const route = parent
    ? routes.find(r => r.group_id === parent.hosted_group_id) ?? (routes[0] ? { ...routes[0], group_id: parent.hosted_group_id } : null)
    : routes.find(r => r.group_id) ?? routes[0];
  if (!route) throw new Error("invalid message group");
  if (!route.group_id && !(typeof input.purpose === "string" && input.purpose.trim())) throw new Error("purpose_required");
  validateProposalOptions(input);
  const result = repository.sendMessage({ ...input, to: peer.id }, {
    owner, target: { kind: "hosted", ...route, link_key: messagingLinkKey(relay.link()) },
  });
  // Attempt this send before returning so a live background relay does not hide
  // a held receipt. Concurrent attempts use the same durable idempotency key.
  await relay.outbound(result.message_id);
  const receipt = withApprovalNotice(repository.messageStatus(result.message_id));
  return !route.group_id && receipt.state === "pending" ? { ...receipt, notice: `Waiting to submit to Passport. ${APPROVAL_NOTICE}` } : receipt;
}

export const APPROVAL_NOTICE = "The owner must approve this collaboration in Passport Inbox on web or iOS. Passport sends a push notification.";
export function withApprovalNotice(value) {
  return value.state === "held" || value.state === "pending" && value.kind
    ? { ...value, notice: APPROVAL_NOTICE } : value;
}
function validateProposalOptions(input) {
  if (input.duration_hours != null && (!Number.isInteger(input.duration_hours) || input.duration_hours < 1 || input.duration_hours > 720)) throw new Error("invalid duration_hours");
  for (const field of ["purpose", "name", "project_boundary"]) {
    if (input[field] != null && (typeof input[field] !== "string" || !input[field].trim())) throw new Error(`invalid ${field}`);
  }
}
export async function proposeCollaboration(repository, input, { owner = false, ...options } = {}) {
  repository.requireMessagingClient(input, { owner });
  validateProposalOptions(input);
  const kind = input.kind ?? "create";
  if (!["create", "renew", "continue"].includes(kind)) throw new Error("invalid proposal kind");
  if (kind !== "create" && typeof input[kind === "renew" ? "group_id" : "conversation_id"] !== "string") throw new Error("invalid proposal target");
  const relay = new MessagingRelay(repository, options);
  const discovery = await relay.peers(owner ? null : input.client_id);
  const registrations = relay.registrations();
  const explicitSender = owner && input.client_id != null;
  let registration = registrations.find(r => (owner && !explicitSender) || r.client_id === input.client_id);
  if (explicitSender && !registration) throw new Error("--from must name an active local client_id");
  if (owner && !explicitSender && kind === "renew") {
    const group = discovery.groups.find(g => g.id === input.group_id);
    const members = new Set(group?.agent_ids ?? []);
    if (!group) {
      const key = messagingLinkKey(relay.link());
      for (const row of repository.db.prepare("SELECT payload FROM messaging_proposals WHERE link_key = ?").all(key)) {
        const proposal = JSON.parse(row.payload);
        if (proposal.group_id === input.group_id && (proposal.kind !== "create" || proposal.state === "approved")) {
          for (const id of proposal.agent_ids ?? []) members.add(id);
        }
      }
      for (const row of repository.db.prepare("SELECT DISTINCT hosted_sender_id FROM messages WHERE hosted_group_id = ? AND link_key = ?").all(input.group_id, key)) {
        members.add(row.hosted_sender_id);
      }
    }
    registration = registrations.find(r => members.has(r.agent_id));
    if (!registration) throw new Error("Cannot determine a local member of this group; pass --from <client_id> to select the sending installation");
  } else if (owner && !explicitSender && kind === "continue") {
    const local = repository.db.prepare("SELECT hosted_sender_id FROM messages WHERE hosted_conversation_id = ? LIMIT 1").get(input.conversation_id ?? null);
    registration = registrations.find(r => r.agent_id === local?.hosted_sender_id) ?? registration;
  }
  if (!registration) throw new Error("agent_required");
  const body = { kind };
  for (const field of ["name", "purpose", "project_boundary", "duration_hours", "group_id", "conversation_id"]) {
    if (input[field] != null) body[field] = input[field];
  }
  if (kind === "create") {
    const targets = input.peer_agent_ids ?? (typeof input.to === "string" ? input.to.split(",").map(s => s.trim()) : []);
    if (!Array.isArray(targets) || !targets.length) throw new Error("invalid proposal peers");
    const peers = targets.map(target => {
      const matches = discovery.agents.filter(a => a.id === target || a.label === target);
      if (matches.length !== 1) throw new Error(matches.length ? `ambiguous hosted label: ${matches.map(a => a.id).join(", ")}` : "invalid message target");
      return matches[0].id;
    });
    if (owner && !explicitSender) registration = registrations.find(r => !peers.includes(r.agent_id)) ?? registration;
    body.agent_ids = [...new Set([registration.agent_id, ...peers])];
    if (body.agent_ids.length < 2 || body.agent_ids.length > 16) throw new Error("invalid proposal peers");
    if (!input.purpose?.trim()) throw new Error("purpose_required");
  } else if (typeof body[kind === "renew" ? "group_id" : "conversation_id"] !== "string") {
    throw new Error("invalid proposal target");
  }
  repository.requireMessagingClient(input, { owner });
  const proposal = await relay.request("proposals", { agentId: registration.agent_id, body });
  repository.requireMessagingClient(input, { owner });
  relay.cacheProposal(proposal);
  return withApprovalNotice(proposal);
}
export async function proposalStatus(repository, input, { owner = false, ...options } = {}) {
  repository.requireMessagingClient(input, { owner });
  if (typeof input.proposal_id !== "string" || !input.proposal_id) throw new Error("invalid proposal_id");
  const relay = new MessagingRelay(repository, options);
  const registrations = await relay.register();
  const cached = owner ? repository.db.prepare("SELECT payload FROM messaging_proposals WHERE proposal_id = ? AND link_key = ?").get(input.proposal_id, messagingLinkKey(relay.link())) : null;
  const proposer = cached ? JSON.parse(cached.payload).proposer_agent_id : null;
  const registration = (owner && registrations.find(r => r.agent_id === proposer)) || registrations.find(r => owner || r.client_id === input.client_id);
  if (!registration) throw new Error("agent_required");
  const proposal = await relay.request(`proposals?proposal_id=${encodeURIComponent(input.proposal_id)}`, { agentId: registration.agent_id });
  repository.requireMessagingClient(input, { owner });
  relay.cacheProposal(proposal);
  return withApprovalNotice(proposal);
}
export async function refreshMessagingStatus(repository, options = {}) {
  if (approvedMessagingLink(repository)) {
    const relay = new MessagingRelay(repository, options);
    try {
      await relay.peers();
      for (const registration of relay.registrations()) await relay.reconcileHeld(registration);
    } catch (error) { relay.recordError(error); }
  }
  return messagingStatus(repository);
}

export function messagingStatus(repository) {
  let link;
  try { link = readHostedLink(repository.home); } catch { link = { status: "invalid" }; }
  repository.expireMessages();
  const pending = repository.db.prepare("SELECT count(*) AS count FROM messages WHERE state IN ('pending', 'notified')").get().count;
  const failureCount = repository.db.prepare("SELECT count(*) AS count FROM messages WHERE last_error IS NOT NULL").get().count;
  const relay = lockStatus(lockPath(repository.home));
  return {
    enabled: repository.messagingEnabled(), link: link?.status ?? "unlinked",
    relay: relay.status,
    ...(relay.status === "blocked" ? { guard: relay.guard, recovery: relay.recovery } : {}),
    registered_agents: repository.db.prepare("SELECT a.client_id, a.agent_id, a.label, a.runtime FROM messaging_agents a JOIN clients c USING(client_id) WHERE c.revoked_at IS NULL AND a.link_key = ?").all(link?.device_id ? messagingLinkKey(link) : ""),
    pending,
    held: repository.db.prepare("SELECT message_id, proposal_id, hosted_receipt_id, hosted_sender_id, to_ref, expires_at FROM messages WHERE state = 'held' ORDER BY created_at").all(),
    proposals: repository.db.prepare("SELECT payload FROM messaging_proposals WHERE link_key = ?").all(link?.device_id ? messagingLinkKey(link) : "")
      .map(row => JSON.parse(row.payload)).filter(p => p.state === "pending" && Date.parse(p.expires_at) > Date.now()),
    last_error: repository.db.prepare("SELECT value FROM meta WHERE key = 'messaging_last_error'").get()?.value ?? null,
    failure_count: failureCount,
    failures: repository.db.prepare("SELECT message_id, last_error AS error FROM messages WHERE last_error IS NOT NULL ORDER BY created_at DESC").all(),
  };
}
