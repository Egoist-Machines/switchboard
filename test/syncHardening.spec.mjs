import assert from "node:assert/strict";
import test from "node:test";

import { writeHostedLink } from "../src/hostedLink.js";
import { LocalRepository } from "../src/repository.js";
import { syncFailureMessage, syncOnce } from "../src/sync.js";
import { temporaryHome } from "./helpers.mjs";

const CREDENTIAL = `apsd_${"a".repeat(43)}`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyPage(cursor = "0") {
  return {
    format_version: 1,
    cursor,
    has_more: false,
    memories: [],
    proposals: [],
    tombstones: [],
    fences: [],
  };
}

function fencePage(cursor = "1") {
  return {
    ...emptyPage(cursor),
    fences: [{
      change_seq: cursor,
      entity_id: "83000000-0000-4000-8000-000000000001",
      hosted_proposal_id: null,
      hosted_memory_id: null,
      lifecycle_state: "fenced",
      category: null,
      origin_connector: null,
      deletion_fence_id: null,
      deleted_entity_version: null,
      occurred_at: "2026-08-26T12:00:00.000Z",
    }],
  };
}

function link(repository) {
  writeHostedLink(repository.home, {
    base_url: "https://passport.example",
    device_id: repository.metadata().replica_id,
    credential: CREDENTIAL,
    status: "approved",
  });
  repository.adoptOwnerScopeKey("c".repeat(64));
}

function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function repositoryFixture(t, { bootstrap = true } = {}) {
  const repository = new LocalRepository({ home: temporaryHome(t), initializeDefaults: false });
  t.after(() => repository.close());
  link(repository);
  if (bootstrap) {
    const fetchImpl = scriptedFetch((call) => {
      if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage());
      if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
      throw new Error("unexpected request");
    });
    assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  }
  return repository;
}

function addPendingProposals(repository, count, category = "project") {
  repository.setAutoApprove(false);
  const client = repository.addClient({ host: "codex", label: "Sync hardening" });
  return Array.from({ length: count }, (_, index) => repository.propose({
    client_id: client.client_id,
    client_secret: client.client_secret,
    save_id: `sync-hardening-${category}-${index}`,
    category,
    content: `Sync hardening content ${index}.`,
  }));
}

function cycleFetch(onEvents) {
  return scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) return jsonResponse(emptyPage());
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    if (call.url.endsWith("/sync/v1/events")) return onEvents(call);
    throw new Error("unexpected request");
  });
}

test("effect-level retryable outcomes stay pending and converge on the next cycle", async (t) => {
  const repository = await repositoryFixture(t);
  addPendingProposals(repository, 3);
  const uploads = [];
  const fetchImpl = cycleFetch((call) => {
    uploads.push(call.body.events);
    if (uploads.length === 1) {
      return jsonResponse({
        outcomes: call.body.events.map((event, index) => index === 1
          ? { event_id: event.event_id, status: "rejected", reason: "dependency_unavailable", retryable: true }
          : { event_id: event.event_id, status: "accepted" }),
        upload_seq: call.body.events.at(-1).replica_seq,
      });
    }
    return jsonResponse({
      outcomes: [{ event_id: call.body.events[0].event_id, status: "accepted" }],
      upload_seq: call.body.events[0].replica_seq,
    });
  });

  const first = await syncOnce({ repository, fetchImpl });
  assert.equal(first.status, "ok");
  assert.equal(first.pushed, 2);
  assert.equal(first.pending, 1);
  assert.deepEqual(repository.db.prepare(`
    SELECT state FROM hosted_sync_uploads ORDER BY upload_seq
  `).all().map((row) => row.state), ["complete", "pending", "complete"]);

  const second = await syncOnce({ repository, fetchImpl });
  assert.equal(second.status, "ok");
  assert.equal(second.pushed, 1);
  assert.equal(second.pending, 0);
  assert.equal(uploads[1].length, 1);
  assert.equal(uploads[1][0].event_id, uploads[0][1].event_id);
});

test("claim-level truncation settles its claimed prefix and leaves the refusal and tail pending", async (t) => {
  const repository = await repositoryFixture(t);
  addPendingProposals(repository, 3);
  let uploadCalls = 0;
  const fetchImpl = cycleFetch((call) => {
    uploadCalls += 1;
    return jsonResponse({
      outcomes: [
        { event_id: call.body.events[0].event_id, status: "accepted" },
        { event_id: call.body.events[1].event_id, status: "rejected", reason: "sequence_gap", retryable: true },
      ],
      upload_seq: call.body.events[0].replica_seq,
    });
  });

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.pushed, 1);
  assert.equal(result.pending, 2);
  assert.equal(uploadCalls, 1);
  assert.deepEqual(repository.db.prepare(`
    SELECT state FROM hosted_sync_uploads ORDER BY upload_seq
  `).all().map((row) => row.state), ["complete", "pending", "pending"]);
});

test("application_incomplete is tolerated as a claimed deferred outcome", async (t) => {
  const repository = await repositoryFixture(t);
  addPendingProposals(repository, 1);
  let uploadCalls = 0;
  const fetchImpl = cycleFetch((call) => {
    uploadCalls += 1;
    const event = call.body.events[0];
    return jsonResponse({
      outcomes: [{
        event_id: event.event_id,
        status: "rejected",
        reason: "application_incomplete",
        retryable: true,
      }],
      upload_seq: event.replica_seq,
    });
  });

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.pending, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(uploadCalls, 1);
});

test("a full-length terminal response still drains the upload journal", async (t) => {
  const repository = await repositoryFixture(t);
  addPendingProposals(repository, 3);
  const fetchImpl = cycleFetch((call) => jsonResponse({
    outcomes: call.body.events.map((event) => ({ event_id: event.event_id, status: "accepted" })),
    upload_seq: call.body.events.at(-1).replica_seq,
  }));

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.pushed, 3);
  assert.equal(result.pending, 0);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'complete'
  `).get().count, 3);
});

test("upload_seq must match the last claimed outcome", async (t) => {
  const repository = await repositoryFixture(t);
  addPendingProposals(repository, 3);
  const fetchImpl = cycleFetch((call) => jsonResponse({
    outcomes: [
      { event_id: call.body.events[0].event_id, status: "accepted" },
      {
        event_id: call.body.events[1].event_id,
        status: "rejected",
        reason: "dependency_unavailable",
        retryable: true,
      },
      { event_id: call.body.events[2].event_id, status: "rejected", reason: "prior_pending", retryable: true },
    ],
    upload_seq: call.body.events[0].replica_seq,
  }));

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "invalid_response");
  assert.equal(result.pending, 3);
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE state = 'pending'
  `).get().count, 3);
});

for (const [name, response] of [
  ["invalid JSON", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })],
  ["an empty object", () => jsonResponse({})],
  ["an outcome array without upload_seq", () => jsonResponse({ outcomes: [] })],
]) {
  test(`a 200 upload response with ${name} is invalid_response`, async (t) => {
    const repository = await repositoryFixture(t);
    addPendingProposals(repository, 3);
    let offered = [];
    const fetchImpl = cycleFetch((call) => {
      offered = call.body.events.map((event) => event.event_id);
      return response();
    });

    const result = await syncOnce({ repository, fetchImpl });
    assert.equal(result.status, "invalid_response");
    assert.equal(result.pending, offered.length);
    assert.equal(offered.length, 3);
    assert.deepEqual(repository.db.prepare(`
      SELECT event_id, state FROM hosted_sync_uploads ORDER BY upload_seq
    `).all(), offered.map((eventId) => ({ event_id: eventId, state: "pending" })));
  });
}

test("pending upload count uses the partial pending index", async (t) => {
  const repository = await repositoryFixture(t);
  const key = repository.db.prepare("SELECT link_key FROM hosted_sync_state").get().link_key;
  const plan = repository.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT count(*) AS count FROM hosted_sync_uploads WHERE link_key = ? AND state = 'pending'
  `).all(key).map((row) => row.detail).join("\n");
  assert.match(plan, /hosted_sync_uploads_pending/);
});

test("cursor reconciliation adopts a fully applied gap and continues pulling", async (t) => {
  const repository = await repositoryFixture(t);
  const key = repository.db.prepare("SELECT link_key FROM hosted_sync_state").get().link_key;
  const insert = repository.db.prepare(`
    INSERT INTO hosted_sync_changes(link_key, change_seq, kind, entity_id, applied_at)
    VALUES (?, ?, 'memory', ?, ?)
  `);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    insert.run(key, String(sequence), `81000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, new Date().toISOString());
  }
  const pulls = [];
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      pulls.push("0");
      return jsonResponse({ error: "cursor_not_current", cursor: "3" }, 409);
    }
    if (call.url.includes("/sync/v1/changes?cursor=3")) {
      pulls.push("3");
      return jsonResponse(emptyPage("3"));
    }
    if (call.url.endsWith("/sync/v1/ack")) return jsonResponse({ ok: true, cursor: call.body.cursor });
    throw new Error("unexpected request");
  });

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.new_cursor, "3");
  assert.deepEqual(pulls, ["0", "3"]);
  assert.equal(repository.db.prepare("SELECT bootstrap_complete FROM hosted_sync_state").get().bootstrap_complete, 1);
});

test("cursor reconciliation fails closed when an applied change is missing", async (t) => {
  const repository = await repositoryFixture(t);
  const key = repository.db.prepare("SELECT link_key FROM hosted_sync_state").get().link_key;
  repository.db.prepare(`
    INSERT INTO hosted_sync_changes(link_key, change_seq, kind, entity_id, applied_at)
    VALUES (?, '1', 'memory', ?, ?), (?, '3', 'memory', ?, ?)
  `).run(
    key, "82000000-0000-4000-8000-000000000001", new Date().toISOString(),
    key, "82000000-0000-4000-8000-000000000003", new Date().toISOString(),
  );
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      return jsonResponse({ error: "cursor_not_current", cursor: "3" }, 409);
    }
    throw new Error("unexpected request");
  });

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "cursor_desync");
  assert.deepEqual(result.failure_detail, { local_cursor: "0", server_cursor: "3" });
  assert.equal(
    syncFailureMessage(result),
    "Hosted sync cursors have diverged (local 0, server 3). Hosted sync stays paused. Unlink and relink this device to re-bootstrap from the hosted snapshot, or contact support.",
  );
});

test("equal local and server cursors in a 409 stay sync_refused", async (t) => {
  const repository = await repositoryFixture(t);
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.includes("/sync/v1/changes?cursor=0")) {
      return jsonResponse({ error: "cursor_not_current", cursor: "0" }, 409);
    }
    throw new Error("unexpected request");
  });

  const result = await syncOnce({ repository, fetchImpl });
  assert.equal(result.status, "sync_refused");
  assert.equal(result.new_cursor, "0");
  assert.equal(fetchImpl.calls.length, 1);
});

test("a lost acknowledgement reconciles the applied page on the next sync", async (t) => {
  const repository = await repositoryFixture(t, { bootstrap: false });
  let cycle = 1;
  let reconciliationOffered = false;
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) {
      if (cycle === 1) return jsonResponse(fencePage());
      if (!reconciliationOffered) {
        reconciliationOffered = true;
        return jsonResponse({ error: "cursor_not_current", cursor: "1" }, 409);
      }
      return jsonResponse(emptyPage("1"));
    }
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      if (cycle === 1) throw new Error("ack response lost");
      return jsonResponse({ ok: true, cursor: call.body.cursor });
    }
    throw new Error("unexpected request");
  });

  const first = await syncOnce({ repository, fetchImpl });
  assert.equal(first.status, "network_failure");
  assert.equal(first.applied, 1);
  assert.equal(first.new_cursor, "0");
  assert.equal(repository.db.prepare(`
    SELECT count(*) AS count FROM hosted_sync_changes WHERE change_seq = '1'
  `).get().count, 1);
  assert.equal(acknowledgements, 2);

  cycle = 2;
  const second = await syncOnce({ repository, fetchImpl });
  assert.equal(second.status, "ok");
  assert.equal(second.new_cursor, "1");
  assert.equal(second.applied, 0);
  assert.equal(acknowledgements, 3);
  assert.equal(repository.db.prepare("SELECT bootstrap_complete FROM hosted_sync_state").get().bootstrap_complete, 1);
});

test("acknowledgement retries one server error and succeeds", async (t) => {
  const repository = await repositoryFixture(t, { bootstrap: false });
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage());
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      return acknowledgements === 1
        ? jsonResponse({ error: "temporary" }, 503)
        : jsonResponse({ ok: true, cursor: call.body.cursor });
    }
    throw new Error("unexpected request");
  });

  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  assert.equal(acknowledgements, 2);
});

test("acknowledgement retries one network failure and succeeds", async (t) => {
  const repository = await repositoryFixture(t, { bootstrap: false });
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage());
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      if (acknowledgements === 1) throw new Error("temporary network failure");
      return jsonResponse({ ok: true, cursor: call.body.cursor });
    }
    throw new Error("unexpected request");
  });

  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ok");
  assert.equal(acknowledgements, 2);
});

test("two acknowledgement server errors return hosted_unavailable", async (t) => {
  const repository = await repositoryFixture(t, { bootstrap: false });
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage());
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      return jsonResponse({ error: "temporary" }, 503);
    }
    throw new Error("unexpected request");
  });

  assert.equal((await syncOnce({ repository, fetchImpl })).status, "hosted_unavailable");
  assert.equal(acknowledgements, 2);
});

test("a non-server acknowledgement refusal is not retried", async (t) => {
  const repository = await repositoryFixture(t, { bootstrap: false });
  let acknowledgements = 0;
  const fetchImpl = scriptedFetch((call) => {
    if (call.url.endsWith("/sync/v1/snapshot")) return jsonResponse(emptyPage());
    if (call.url.endsWith("/sync/v1/ack")) {
      acknowledgements += 1;
      return jsonResponse({ error: "refused" }, 409);
    }
    throw new Error("unexpected request");
  });

  assert.equal((await syncOnce({ repository, fetchImpl })).status, "ack_refused");
  assert.equal(acknowledgements, 1);
});

test("sync failure messages distinguish transport failures", () => {
  assert.equal(syncFailureMessage({ status: "sync_refused" }), "The hosted plane refused the sync request.");
  assert.equal(syncFailureMessage({ status: "ack_refused" }), "The hosted plane refused the cursor acknowledgement.");
  assert.equal(
    syncFailureMessage({ status: "invalid_response" }),
    "The hosted plane answered with a response shape this Switchboard client does not recognize.",
  );
  assert.equal(syncFailureMessage({ status: "pull_required_loop" }), "Hosted sync push kept being fenced behind pulls.");
  assert.equal(syncFailureMessage({ status: "hosted_unavailable" }), "The hosted plane answered with server errors.");
  assert.equal(syncFailureMessage({
    status: "cursor_desync",
    failure_detail: { local_cursor: "4", server_cursor: "2" },
  }), "Hosted sync cursors have diverged (local 4, server 2). Hosted sync stays paused. Unlink and relink this device to re-bootstrap from the hosted snapshot, or contact support.");
});

test("content_rejected exposes local item metadata without changing conflict accounting", async (t) => {
  const repository = await repositoryFixture(t);
  const [saved] = addPendingProposals(repository, 1, "instruction");
  let rejectedEvent;
  const fetchImpl = cycleFetch((call) => {
    rejectedEvent = call.body.events[0];
    return jsonResponse({
      outcomes: [{ event_id: rejectedEvent.event_id, status: "rejected", reason: "content_rejected" }],
      upload_seq: rejectedEvent.replica_seq,
    });
  });

  const result = await syncOnce({ repository, fetchImpl });
  const proposal = repository.db.prepare(`
    SELECT category, created_at FROM proposals WHERE proposal_id = ?
  `).get(saved.proposal_id);
  assert.equal(result.status, "ok");
  assert.equal(result.conflicts, 1);
  assert.equal(result.rejected, 0);
  assert.deepEqual(result.content_rejected_rows, [{
    event_id: rejectedEvent.event_id,
    entity_id: saved.proposal_id,
    category: proposal.category,
    created_at: proposal.created_at,
  }]);
});
