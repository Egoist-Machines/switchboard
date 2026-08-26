import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  detectHostedContentShape, discoverCodingImports, importCodingMemories,
} from "../src/codingImport.js";
import { LocalRepository } from "../src/repository.js";
import { temporaryHome } from "./helpers.mjs";

function textOutput() {
  return { body: "", write(chunk) { this.body += String(chunk); return true; } };
}

async function discoverGlobalFixture(t, content) {
  const root = temporaryHome(t);
  const ownerHome = path.join(root, "owner");
  mkdirSync(path.join(ownerHome, ".claude"), { recursive: true });
  writeFileSync(path.join(ownerHome, ".claude", "CLAUDE.md"), content);
  const repository = new LocalRepository({ home: path.join(root, "switchboard") });
  t.after(() => repository.close());
  const discovery = await discoverCodingImports({
    repository,
    project: root,
    env: { ...process.env, HOME: ownerHome },
  });
  return { discovery, repository };
}

test("hosted content shape screening recognizes only the requested high-confidence classes", () => {
  assert.equal(detectHostedContentShape(
    "-----BEGIN PRIVATE KEY-----\nFAKE BODY\n-----END PRIVATE KEY-----",
  ), "a private key");

  const providerTokens = [
    `sk-${"EXAMPLE0".repeat(4)}`,
    `sk-proj-${"EXAMPLE0".repeat(2)}`,
    `sk-ant-api03-${"EXAMPLE0".repeat(2)}`,
    `sk_live_${"EXAMPLE0".repeat(2)}`,
    "AKIAEXAMPLE0EXAMPLE0",
    `AIza${"EXAMPLE".repeat(5)}`,
    `ghp_${"EXAMPLE0".repeat(3)}`,
    `github_pat_${"EXAMPLE0".repeat(3)}`,
    "xoxb-EXAMPLE0-EXAMPLE0",
  ];
  for (const content of providerTokens) {
    assert.equal(detectHostedContentShape(content), "a provider token", content);
  }

  assert.equal(
    detectHostedContentShape("API_KEY='EXAMPLE0EXAMPLE0'"),
    "a credential assignment",
  );
});

test("coding import attaches the matched shape and item identity to its note", async (t) => {
  const { discovery } = await discoverGlobalFixture(t, "AWS example: AKIAEXAMPLE0EXAMPLE0");
  assert.equal(discovery.entries.length, 1);
  assert.match(
    discovery.entries[0].note,
    /hosted content screen.*Claude global instructions item \(fact\).*a provider token.*still import it locally/i,
  );
});

test("clean import content has no hosted-screen note", async (t) => {
  const { discovery } = await discoverGlobalFixture(t, "Use the checked example configuration.");
  assert.equal(discovery.entries.length, 1);
  assert.equal(discovery.entries[0].note, null);
  assert.equal(detectHostedContentShape(discovery.entries[0].content), null);
});

test("dry-run prints hosted-screen warnings without saving", async (t) => {
  const content = "-----BEGIN PRIVATE KEY-----\nFAKE BODY\n-----END PRIVATE KEY-----";
  const { discovery, repository } = await discoverGlobalFixture(t, content);
  const output = textOutput();
  const result = await importCodingMemories({ repository, discovery, dryRun: true, output });
  assert.equal(result.imported, 0);
  assert.match(output.body, /hosted content screen.*a private key.*still import it locally/i);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);
});

test("oversize import handling remains unchanged", async (t) => {
  const { discovery } = await discoverGlobalFixture(t, "x".repeat((32 * 1024) + 1));
  assert.deepEqual(discovery.entries, []);
  assert.match(discovery.notes.join("\n"), /exceeds the 32768-byte import limit/);
  assert.doesNotMatch(discovery.notes.join("\n"), /hosted content screen/i);
});
