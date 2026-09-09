#!/usr/bin/env node

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

if (request.fixture_behavior === "require_secret" && request.client_secret !== "never-in-argv") {
  process.exitCode = 8;
} else if (request.fixture_behavior === "hang") {
  setInterval(() => {}, 1000);
} else if (request.fixture_behavior === "garbage") {
  process.stdout.write("not json\n");
} else if (request.fixture_behavior === "nonzero") {
  process.exitCode = 7;
} else if (process.argv[2] === "message-propose") {
  process.stdout.write(JSON.stringify({ id: "proposal-1", state: "pending", kind: request.kind, purpose: request.purpose, duration_hours: request.duration_hours, sender: request.client_id }));
} else if (process.argv[2] === "message-proposal-status") {
  process.stdout.write(JSON.stringify({ id: request.proposal_id, state: "approved" }));
} else if (process.argv[2] === "message-send") {
  process.stdout.write(JSON.stringify({ message_id: "message-1", state: "held", proposal_id: "proposal-1" }));
} else if (process.argv[2] === "propose") {
  process.stdout.write(
    `${JSON.stringify({
      status: request.fixture_behavior === "pending" ? "recorded" : "recorded",
      proposal_id: "proposal-1",
      save_id: request.save_id,
      disposition: request.fixture_behavior === "pending" ? "pending" : "auto_approved",
    })}\n`
  );
} else if (process.argv[2] === "handoff-claim") {
  process.stdout.write(
    `${JSON.stringify(request.fixture_behavior === "none" ? {
      status: "none_pending",
      handoff_id: null,
      snapshot: null,
      expires_at: null,
    } : {
      status: "claimed",
      handoff_id: "handoff-1",
      snapshot: "Task hand-off",
      expires_at: "2026-08-25T12:00:00.000Z",
    })}\n`
  );
} else {
  const row = {
    memory_id: "memory-1",
    content: "Prefers dark roast coffee",
    source: "opencode",
    created_at: "2026-08-24T12:00:00.000Z",
    occurred_at: null,
    category: request.fixture_category ?? request.categories?.[0] ?? "preference",
    client_id: request.client_id,
    evidence_basis: "direct_user_save",
    record_kind: "memory",
    verified_issuer: null,
    verified_at: null
  };
  const status = request.fixture_behavior === "empty" ? "empty" : "results";
  process.stdout.write(
    `${JSON.stringify({
      status,
      transport: "local",
      connectivity: "online",
      freshness: "fresh",
      as_of: "2026-08-24T12:00:00.000Z",
      rows: status === "results" ? [row] : [],
      skipped_categories: [],
    })}\n`
  );
}
