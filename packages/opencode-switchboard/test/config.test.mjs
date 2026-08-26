import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CODING_PROFILE_DEFAULT_CATEGORIES,
  DEFAULTS,
  GOVERNED_CATEGORIES,
  passportPaths,
  resolveConfig,
} from "../src/config.js";

const schema = JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("schema keys and runtime reads agree in both directions", () => {
  const resolved = resolveConfig();
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(resolved).sort());
  for (const group of ["ambient", "handoff", "hostedFallback"]) {
    assert.deepEqual(Object.keys(schema.properties[group].properties).sort(), Object.keys(resolved[group]).sort());
    assert.equal(schema.properties[group].additionalProperties, false);
  }
  assert.equal(schema.additionalProperties, false);
});

test("the category schema follows the canonical contract", async () => {
  const { MEMORY_CATEGORIES } = await import("./vendor-shared-contracts.js");
  assert.deepEqual(GOVERNED_CATEGORIES, [...MEMORY_CATEGORIES]);
  assert.deepEqual(schema.properties.categories.items.enum, GOVERNED_CATEGORIES);
});

test("config defaults are the coding profile defaults", () => {
  const config = resolveConfig();
  assert.deepEqual(DEFAULTS.categories, CODING_PROFILE_DEFAULT_CATEGORIES);
  assert.deepEqual(config.categories, ["preference", "fact", "project", "instruction"]);
  assert.deepEqual(schema.properties.categories.default, CODING_PROFILE_DEFAULT_CATEGORIES);
  assert.deepEqual(config.ambient, { enabled: false, maxRows: 6, maxChars: 2000, timeoutMs: 1500 });
  assert.deepEqual(config.handoff, { enabled: false });
  assert.equal(schema.properties.handoff.properties.enabled.default, false);
  assert.deepEqual(config.hostedFallback, { enabled: false });
});

test("bad values fall back or clamp without throwing", () => {
  const config = resolveConfig({
    categories: ["nope", "fact", "fact"],
    ambient: { enabled: "yes", maxRows: 0, maxChars: 99_999, timeoutMs: -5 },
    handoff: { enabled: "yes" },
    hostedFallback: { enabled: "yes" },
  });
  assert.deepEqual(config.categories, ["fact"]);
  assert.deepEqual(config.ambient, { enabled: false, maxRows: 1, maxChars: 20_000, timeoutMs: 200 });
  assert.deepEqual(config.handoff, { enabled: false });
  assert.deepEqual(config.hostedFallback, { enabled: false });
});

test("state paths honor OpenCode and XDG conventions", () => {
  const explicit = passportPaths({ env: { OPENCODE_STATE_DIR: "/state/opencode" }, home: "/home/owner" });
  assert.equal(explicit.credentialsPath, path.join("/state/opencode", "switchboard-credentials.json"));
  assert.equal(
    explicit.hostedCredentialsPath,
    path.join("/state/opencode", "ai-passport-credentials-hosted.json")
  );
  assert.equal(explicit.discoveryPath, path.join("/home/owner", ".switchboard", "runtime.json"));
  const xdg = passportPaths({ env: { XDG_DATA_HOME: "/data" }, home: "/home/owner" });
  assert.equal(xdg.statusPath, path.join("/data", "opencode", "ai-passport-status.json"));
});

test("the package exports the host shim and pins the verified host API", () => {
  assert.equal(packageJson.exports, "./src/index.js");
  assert.equal(packageJson.dependencies["@opencode-ai/plugin"], "1.18.22");
  assert.ok(packageJson.files.includes("src"));
  assert.ok(packageJson.files.includes("src/shared"));
  assert.ok(!packageJson.files.includes("vendor"));
});
