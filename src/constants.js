export const MEMORY_CATEGORIES = Object.freeze([
  "preference",
  "fact",
  "project",
  "relationship",
  "instruction",
  "event",
  "purchase",
  "claim",
  "other",
]);

export const WRITABLE_MEMORY_CATEGORIES = Object.freeze(
  MEMORY_CATEGORIES.filter((category) => category !== "claim")
);

export const CODING_PROFILE_CATEGORIES = Object.freeze([
  "preference",
  "fact",
  "project",
  "instruction",
]);

export const SYNC_CAPABILITIES = Object.freeze(["null_tombstones"]);
export const SYNC_CAPABILITIES_HEADER = "x-switchboard-capabilities";

export const SCHEMA_VERSION = 12;
export const EVENT_FORMAT_VERSION = 1;
export const MAX_CONTENT_BYTES = 32 * 1024;
export const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ROW_CONTENT_CHARS = 8_000;
export const MAX_READ_CONTENT_CHARS = 32_000;
export const MAX_READ_ROWS = 50;
export const MAX_QUERY_CHARS = 1_024;
export const MAX_QUERY_TOKENS = 64;
export const SAVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
