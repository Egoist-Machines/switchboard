import assert from "node:assert/strict";
import test from "node:test";

import {
  codexHookStateKey, codexHookTrustedHash, findSwitchboardHookIndices,
  readTrustEntry, removeTrustEntry, upsertTrustEntry,
} from "../src/codexTrust.js";

const handler = {
  type: "command",
  command: "'/opt/homebrew/bin/switchboard' hook codex-prefetch",
  timeout: 2,
  statusMessage: "Checking AI Passport memory",
};

test("Codex hook trust hashes use the Codex canonical identity", () => {
  assert.equal(
    codexHookTrustedHash(handler),
    "sha256:ba6785d730fd0579c22d4e1efdba154e1954d732cba31087285fd2e95e23d107",
  );
  const withoutDefaults = { type: "command", command: "switchboard hook codex-prefetch" };
  assert.equal(codexHookTrustedHash(withoutDefaults), codexHookTrustedHash({
    ...withoutDefaults, timeout: 600, async: false,
  }));
  assert.notEqual(codexHookTrustedHash(withoutDefaults), codexHookTrustedHash({
    ...withoutDefaults, statusMessage: "Checking memory",
  }));
  assert.equal(codexHookTrustedHash(handler), codexHookTrustedHash({
    statusMessage: handler.statusMessage, timeout: handler.timeout, command: handler.command, type: handler.type,
  }));
});

test("Codex trust keys and hook indices retain Codex addressing", () => {
  assert.equal(
    codexHookStateKey("/a/b/.codex/hooks.json", 1, 0),
    "/a/b/.codex/hooks.json:user_prompt_submit:1:0",
  );
  const foreign = { hooks: [{ type: "command", command: "foreign-hook" }] };
  const switchboard = { hooks: [handler] };
  const entryB64 = Buffer.from(JSON.stringify(switchboard), "utf8").toString("base64");
  assert.deepEqual(
    findSwitchboardHookIndices({ hooks: { UserPromptSubmit: [foreign, switchboard] } }, entryB64),
    { groupIndex: 1, handlerIndex: 0, handler },
  );
});

test("Codex trust TOML changes only its selected table", () => {
  const key = "/a/b/.codex/hooks.json:user_prompt_submit:1:0";
  const otherKey = "/a/b/.codex/hooks.json:user_prompt_submit:0:0";
  const first = upsertTrustEntry("", key, "sha256:first");
  assert.equal(readTrustEntry(first, key), "sha256:first");

  const unrelated = "model = \"gpt-5\"\n# Leave this byte sequence unchanged.\n";
  const withEntry = upsertTrustEntry(unrelated, key, "sha256:second");
  assert.equal(withEntry.slice(0, unrelated.length), unrelated);
  const disabled = withEntry.replace(
    `trusted_hash = \"sha256:second\"`,
    "enabled = false\ntrusted_hash = \"sha256:second\"",
  );
  const updated = upsertTrustEntry(disabled, key, "sha256:third");
  assert.match(updated, /enabled = false\ntrusted_hash = "sha256:third"/);

  const withForeign = upsertTrustEntry(updated, otherKey, "sha256:foreign");
  const removed = removeTrustEntry(withForeign, key);
  assert.equal(readTrustEntry(removed, key), null);
  assert.equal(readTrustEntry(removed, otherKey), "sha256:foreign");
  assert.equal(readTrustEntry(upsertTrustEntry(removed, key, "sha256:third"), key), "sha256:third");
});

test("Codex trust TOML escapes state keys", () => {
  const key = '/a/"quoted"/.codex/hooks.json:user_prompt_submit:0:0';
  const text = upsertTrustEntry("", key, "sha256:escaped");
  assert.ok(text.includes('[hooks.state."/a/\\"quoted\\"/.codex/hooks.json:user_prompt_submit:0:0"]'));
  assert.equal(readTrustEntry(text, key), "sha256:escaped");
});

test("Codex trust TOML recognizes inline comments without duplicating a table", () => {
  const key = "/a/b/.codex/hooks.json:user_prompt_submit:0:0";
  const header = `[hooks.state."${key}"]`;
  const original = `${header}\ntrusted_hash = "sha256:old" # Codex recorded this value\n`;
  assert.equal(readTrustEntry(original, key), "sha256:old");

  const updated = upsertTrustEntry(original, key, "sha256:new");
  assert.equal(readTrustEntry(updated, key), "sha256:new");
  assert.equal(updated.split(header).length - 1, 1);
  assert.match(updated, /trusted_hash = "sha256:new"\n/);
});

test("Codex trust TOML reads and replaces literal trusted_hash strings", () => {
  const key = "/a/b/.codex/hooks.json:user_prompt_submit:0:0";
  const header = `[hooks.state."${key}"]`;
  const original = `${header}\ntrusted_hash = 'sha256:old'\n`;
  assert.equal(readTrustEntry(original, key), "sha256:old");

  const updated = upsertTrustEntry(original, key, "sha256:new");
  assert.equal(readTrustEntry(updated, key), "sha256:new");
  assert.equal((updated.match(/^\s*trusted_hash\s*=/gm) ?? []).length, 1);
  assert.match(updated, /trusted_hash = "sha256:new"\n/);
});

test("Codex trust TOML accepts commented headers and preserves CRLF writes", () => {
  const key = "/a/b/.codex/hooks.json:user_prompt_submit:0:0";
  const otherKey = "/a/b/.codex/hooks.json:user_prompt_submit:1:0";
  const header = `[hooks.state."${key}"]`;
  const original = `model = "gpt-5"\r\n  ${header} # trust for the hook\r\n  trusted_hash = "sha256:old" # old value\r\n`;
  assert.equal(readTrustEntry(original, key), "sha256:old");

  const updated = upsertTrustEntry(original, key, "sha256:new");
  assert.equal(readTrustEntry(updated, key), "sha256:new");
  assert.equal(updated.split(header).length - 1, 1);
  const appended = upsertTrustEntry(updated, otherKey, "sha256:other");
  assert.equal(readTrustEntry(appended, otherKey), "sha256:other");
  assert.equal((appended.match(/(?<!\r)\n/g) ?? []).length, 0);
});
