import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { discoverCodingImports, importCodingMemories } from "../src/codingImport.js";
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

test("coding import previews and skips every local content-screen refusal without prompting", async (t) => {
  const fixtures = [
    ["payment card", "Visa 4111 1111 1111 1111", "sensitive_content"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nFAKE BODY\n-----END PRIVATE KEY-----", "sensitive_content"],
    ["OpenAI token", `sk-${"EXAMPLE0".repeat(4)}`, "sensitive_content"],
    ["OpenAI project token", `sk-proj-${"EXAMPLE0".repeat(2)}`, "sensitive_content"],
    ["Anthropic token", `sk-ant-api03-${"EXAMPLE0".repeat(2)}`, "sensitive_content"],
    ["Stripe token", `sk_live_${"EXAMPLE0".repeat(2)}`, "sensitive_content"],
    ["AWS token", "AKIAEXAMPLE0EXAMPLE0", "sensitive_content"],
    ["Google token", `AIza${"EXAMPLE".repeat(5)}`, "sensitive_content"],
    ["GitHub token", `ghp_${"EXAMPLE0".repeat(3)}`, "sensitive_content"],
    ["GitHub fine-grained token", `github_pat_${"EXAMPLE0".repeat(3)}`, "sensitive_content"],
    ["Slack token", "xoxb-EXAMPLE0-EXAMPLE0", "sensitive_content"],
    ["credential assignment", "API_KEY='EXAMPLE0EXAMPLE0'", "sensitive_content"],
    ["opaque run", "0123456789abcdef".repeat(8), "sensitive_content"],
    ["binary content", "hello\0world", "binary_content"],
  ];

  for (const [label, content, reason] of fixtures) {
    const { discovery, repository } = await discoverGlobalFixture(t, content);
    assert.equal(discovery.entries.length, 1, label);
    assert.equal(discovery.entries[0].content_refusal, reason, label);
    assert.match(
      discovery.entries[0].note,
      new RegExp(`local content screen will refuse this Claude global instructions item \\(fact\\) with reason ${reason}`, "i"),
      label,
    );

    const dryOutput = textOutput();
    const dry = await importCodingMemories({ repository, discovery, dryRun: true, output: dryOutput });
    assert.equal(dry.imported, 0, label);
    assert.match(dryOutput.body, new RegExp(`local content screen.*reason ${reason}`, "i"), label);

    let prompts = 0;
    const output = textOutput();
    const result = await importCodingMemories({
      repository,
      discovery,
      output,
      confirm: () => { prompts += 1; return true; },
    });
    assert.equal(prompts, 0, label);
    assert.deepEqual({ imported: result.imported, skipped: result.skipped }, { imported: 0, skipped: 1 }, label);
    assert.match(output.body, /Imported: 0\. Skipped: 1\. Already present: 0\./, label);
    assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0, label);
  }
});

test("clean import content prompts, imports, and persists", async (t) => {
  const content = "Use the checked example configuration.";
  const { discovery, repository } = await discoverGlobalFixture(t, content);
  assert.equal(discovery.entries.length, 1);
  assert.equal(discovery.entries[0].note, null);
  assert.equal(discovery.entries[0].content_refusal, null);
  let prompts = 0;
  const output = textOutput();
  const result = await importCodingMemories({
    repository,
    discovery,
    output,
    confirm: () => { prompts += 1; return true; },
  });
  assert.equal(prompts, 1);
  assert.deepEqual({ imported: result.imported, skipped: result.skipped }, { imported: 1, skipped: 0 });
  assert.equal(repository.listMemories().some((item) => item.content === content), true);
});

test("oversize import handling remains unchanged", async (t) => {
  const { discovery } = await discoverGlobalFixture(t, "x".repeat((32 * 1024) + 1));
  assert.deepEqual(discovery.entries, []);
  assert.match(discovery.notes.join("\n"), /exceeds the 32768-byte import limit/);
  assert.doesNotMatch(discovery.notes.join("\n"), /content screen/i);
});
