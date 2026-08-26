import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedTransport } from "../src/hostedTransport.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./vendor-agent-prefetch-response.json", import.meta.url), "utf8")
);

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function scriptedFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      ...options,
      body: typeof options.body === "string" ? JSON.parse(options.body) : options.body ?? null,
    });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fakeCredentials() {
  const calls = [];
  return {
    calls,
    async baseUrl() {
      return "https://passport.test";
    },
    async accessToken(options = {}) {
      calls.push(options);
      return options.force ? "access-refreshed" : "access-initial";
    },
  };
}

function makeTransport({ responses, now = () => Date.parse("2026-08-25T12:00:00.000Z") }) {
  const fetchImpl = scriptedFetch(responses);
  const credentials = fakeCredentials();
  const transport = createHostedTransport({ fetchImpl, credentials, now, timeoutMs: 1000 });
  return { transport, fetchImpl, credentials };
}

const read = (transport, overrides = {}) =>
  transport.prefetch({
    categories: ["preference", "project", "fact", "instruction"],
    limit: 6,
    ...overrides,
  });

test("hosted results preserve the complete row contract and request bounds", async () => {
  const { transport, fetchImpl } = makeTransport({ responses: [response(200, FIXTURE)] });
  const outcome = await read(transport, { query: "  dark\n roast  ", session_id: "session-1" });

  assert.equal(outcome.status, "results");
  assert.equal(outcome.transport, "hosted");
  assert.equal(outcome.freshness, "fresh");
  assert.equal(outcome.as_of, "2026-08-25T12:00:00.000Z");
  assert.deepEqual(outcome.rows, FIXTURE.rows);
  assert.deepEqual(outcome.skipped_categories, FIXTURE.skipped_categories);
  assert.deepEqual(fetchImpl.calls[0].body, {
    categories: ["preference", "project", "fact", "instruction"],
    query: "dark roast",
    session_key: "session-1",
    limit: 6,
  });
  assert.equal(fetchImpl.calls[0].redirect, "manual");
});

test("hosted results preserve a null created_at from the wire", async () => {
  const payload = structuredClone(FIXTURE);
  payload.rows[0].created_at = null;
  const { transport } = makeTransport({ responses: [response(200, payload)] });

  const outcome = await read(transport);
  assert.equal(outcome.status, "results");
  assert.equal(outcome.rows[0].created_at, null);
  assert.deepEqual(outcome.rows, payload.rows);
});

test("hosted empty and skipped reasons preserve the five-way outcome classes", async () => {
  for (const [skipped, expected] of [
    [[], "empty"],
    [[{ category: "fact", reason: "no_pass" }], "blocked"],
    [[{ category: "fact", reason: "once_only" }], "blocked"],
    [[{ category: "fact", reason: "locked" }], "locked"],
  ]) {
    const { transport } = makeTransport({
      responses: [response(200, { rows: [], skipped_categories: skipped })],
    });
    const outcome = await transport.prefetch({ categories: ["fact"] });
    assert.equal(outcome.status, expected);
    assert.deepEqual(outcome.skipped_categories, skipped);
  }
});

test("a readable empty category stays empty beside a skipped category", async () => {
  const { transport } = makeTransport({
    responses: [
      response(200, {
        rows: [],
        skipped_categories: [{ category: "fact", reason: "no_pass" }],
      }),
    ],
  });
  const outcome = await transport.prefetch({ categories: ["preference", "fact"] });
  assert.equal(outcome.status, "empty");
  assert.deepEqual(outcome.skipped_categories, [{ category: "fact", reason: "no_pass" }]);
});

test("a 401 refreshes and retries exactly once", async () => {
  const { transport, fetchImpl, credentials } = makeTransport({
    responses: [response(401, { error: "invalid_token" }), response(200, FIXTURE)],
  });
  const outcome = await read(transport);
  assert.equal(outcome.status, "results");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].headers.authorization, "Bearer access-refreshed");
  assert.deepEqual(credentials.calls, [{}, { force: true }]);
});

test("a 401 uses the shared rotating credential record and persists the rotation", async (t) => {
  const timestamp = Date.parse("2026-08-25T12:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-hosted-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, "credentials.json");
  await writeFile(
    credentialsPath,
    `${JSON.stringify({
      token_url: "https://passport.test/token",
      client_id: "client-1",
      refresh_token: "refresh-1",
      access_token: "access-1",
      access_token_expires_at: timestamp + 3_600_000,
    })}\n`,
    { mode: 0o600 }
  );
  const fetchImpl = scriptedFetch([
    response(401, { error: "invalid_token" }),
    response(200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
    response(200, FIXTURE),
  ]);
  const transport = createHostedTransport({ credentialsPath, fetchImpl, now: () => timestamp });

  assert.equal((await read(transport)).status, "results");
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url),
    [
      "https://passport.test/agent/prefetch",
      "https://passport.test/token",
      "https://passport.test/agent/prefetch",
    ]
  );
  assert.equal(fetchImpl.calls[2].headers.authorization, "Bearer access-2");
  const persisted = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(persisted.refresh_token, "refresh-2");
  assert.equal((await stat(credentialsPath)).mode & 0o077, 0);
});

test("403 and 404 are plane-closed unavailable outcomes", async () => {
  for (const status of [403, 404]) {
    const { transport } = makeTransport({ responses: [response(status, { error: "forbidden" })] });
    const outcome = await read(transport);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.internalReason, "hosted_plane_closed");
  }
});

test("429 spends no retry loop and enters the route backoff", async () => {
  const { transport, fetchImpl } = makeTransport({
    responses: [response(429, { error: "rate_limited" }), response(200, FIXTURE)],
  });
  const first = await read(transport);
  const second = await read(transport);
  assert.equal(first.status, "unavailable");
  assert.equal(first.internalReason, "hosted_rate_limited");
  assert.equal(second.status, "unavailable");
  assert.equal(fetchImpl.calls.length, 1);
});

test("the hosted route budget stops the thirty-first novel read", async () => {
  const responses = Array.from({ length: 31 }, () => response(200, { rows: [], skipped_categories: [] }));
  const { transport, fetchImpl } = makeTransport({ responses });
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await read(transport, { query: `query ${index}` })).status, "empty");
  }
  const overBudget = await read(transport, { query: "over budget" });
  assert.equal(overBudget.status, "unavailable");
  assert.equal(fetchImpl.calls.length, 30);
});

test("concurrent credential loading cannot bypass the hosted route budget", async () => {
  const gate = Promise.withResolvers();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { rows: [], skipped_categories: [] });
  };
  const credentials = {
    async baseUrl() {
      await gate.promise;
      return "https://passport.test";
    },
    async accessToken() {
      return "access-initial";
    },
  };
  const transport = createHostedTransport({ fetchImpl, credentials, timeoutMs: 1000 });
  const reads = Array.from({ length: 31 }, (_, index) => read(transport, { query: `concurrent ${index}` }));

  gate.resolve();
  const outcomes = await Promise.all(reads);
  assert.ok(calls.length <= 30);
  assert.equal(outcomes.filter((outcome) => outcome.status === "unavailable").length, 1);
});

test("a 401 retry spends a second hosted route-budget slot", async () => {
  const responses = Array.from({ length: 15 }, () => [response(401, {}), response(200, FIXTURE)]).flat();
  const { transport, fetchImpl } = makeTransport({ responses });
  for (let index = 0; index < 15; index += 1) {
    assert.equal((await read(transport, { query: `refresh ${index}` })).status, "results");
  }

  assert.equal((await read(transport, { query: "budget spent by retries" })).status, "unavailable");
  assert.equal(fetchImpl.calls.length, 30);
});

test("503, network failures, and non-object 200 responses are outages", async () => {
  for (const failure of [
    response(503, { error: "unavailable" }),
    new Error("socket closed"),
    response(200, "[]"),
  ]) {
    const { transport } = makeTransport({ responses: [failure] });
    const outcome = await read(transport);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.internalReason, "hosted_unavailable");
  }
});

test("an expired cached result is served stale after a dependency failure", async () => {
  let timestamp = Date.parse("2026-08-25T12:00:00.000Z");
  const { transport } = makeTransport({
    responses: [response(200, FIXTURE), new Error("offline")],
    now: () => timestamp,
  });
  const fresh = await read(transport, { query: "same" });
  timestamp += 61_000;
  const stale = await read(transport, { query: "same" });
  assert.equal(stale.status, "results");
  assert.equal(stale.connectivity, "offline");
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.as_of, fresh.as_of);
  assert.deepEqual(stale.rows, fresh.rows);
});

test("an expired cached result is served stale after a malformed object response", async () => {
  let timestamp = Date.parse("2026-08-25T12:00:00.000Z");
  const { transport } = makeTransport({
    responses: [response(200, FIXTURE), response(200, { rows: "invalid", skipped_categories: [] })],
    now: () => timestamp,
  });
  const fresh = await read(transport, { query: "same malformed" });
  timestamp += 61_000;
  const stale = await read(transport, { query: "same malformed" });

  assert.equal(stale.status, "results");
  assert.equal(stale.connectivity, "offline");
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.as_of, fresh.as_of);
  assert.deepEqual(stale.rows, fresh.rows);
});

test("the hosted credentials file must be owner-only", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-hosted-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, "credentials.json");
  await writeFile(
    credentialsPath,
    `${JSON.stringify({
      token_url: "https://passport.test/token",
      client_id: "client-1",
      refresh_token: "refresh-1",
      access_token: "access-1",
      access_token_expires_at: Date.now() + 3_600_000,
    })}\n`,
    { mode: 0o644 }
  );
  const fetchImpl = scriptedFetch([response(200, FIXTURE)]);
  const transport = createHostedTransport({ credentialsPath, fetchImpl });

  const outcome = await read(transport);
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.internalReason, "hosted_auth");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal((await transport.status()).paired, false);
});
