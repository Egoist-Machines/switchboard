import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export function resolveSwitchboardHome(env = process.env) {
  const configured = typeof env.SWITCHBOARD_HOME === "string" ? env.SWITCHBOARD_HOME.trim() : "";
  return path.resolve(configured || path.join(os.homedir(), ".switchboard"));
}

export function ensurePrivateDirectory(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

export const plaintextPayloadCodec = Object.freeze({
  encode: (value) => value,
  decode: (value) => value,
});

// An opt-in encryption layer can supply a payload codec without changing repository callers.
export function openStore({
  home = resolveSwitchboardHome(),
  readonly = false,
  databaseFactory = Database,
  payloadCodec = plaintextPayloadCodec,
} = {}) {
  if (typeof payloadCodec?.encode !== "function" || typeof payloadCodec?.decode !== "function") {
    throw new TypeError("payloadCodec must provide encode and decode");
  }
  ensurePrivateDirectory(home);
  const databasePath = path.join(home, "passport.db");
  if (!readonly) {
    closeSync(openSync(databasePath, "a", 0o600));
    chmodSync(databasePath, 0o600);
  }
  const db = databaseFactory(databasePath, readonly ? { readonly: true, fileMustExist: true } : undefined);
  db.pragma("busy_timeout = 250");
  db.pragma("foreign_keys = ON");
  if (!readonly) {
    db.pragma("journal_mode = DELETE");
    db.pragma("secure_delete = ON");
    db.pragma("synchronous = FULL");
  }
  return { db, home, databasePath, payloadCodec };
}
