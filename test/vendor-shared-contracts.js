// Vendored wire-contract vocabulary so the standalone suite can pin the
// client's categories and sync capabilities against the hosted plane.
export const MEMORY_CATEGORIES = Object.freeze([
  "preference", "fact", "project", "relationship", "instruction", "event", "purchase", "claim", "other",
]);

// Closed sync-wire vocabulary. A new row shape must add one capability here
// before the server can gate delivery on it.
export const LOCAL_SYNC_CAPABILITIES = Object.freeze(["null_tombstones"]);
