import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function temporaryHome(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "switchboard-test-"));
  const home = path.join(root, "store");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return home;
}
