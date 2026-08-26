import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sharedDir = path.resolve(fileURLToPath(new URL("../src/shared/", import.meta.url)));

function findModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findModules(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const modules = findModules(sharedDir);
const staticImport = /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']/g;

test("shared agent modules import only built-ins and other shared modules", () => {
  assert.ok(modules.length > 0, "the synced shared core must not be empty");
  for (const file of modules) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [staticImport, dynamicImport]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) continue;
        assert.ok(specifier.startsWith("."), `${path.basename(file)} imports non-neutral dependency ${specifier}`);
        const target = path.resolve(path.dirname(file), specifier);
        assert.ok(
          target === sharedDir || target.startsWith(`${sharedDir}${path.sep}`),
          `${path.basename(file)} imports outside src/shared: ${specifier}`
        );
      }
    }
  }
});

test("the OpenCode runtime and shared core contain no unrelated host branding", () => {
  const runtimeDir = path.resolve(sharedDir, "..");
  for (const file of findModules(runtimeDir)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\b(?:claude|cursor|copilot)\b/i, `${path.basename(file)} names another host`);
  }
});
