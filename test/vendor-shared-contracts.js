// Vendored from the Egoist Machines monorepo shared/contracts.js so the
// standalone suite can pin the client vocabulary against the wire contract.
// Consumed by the backend and owner web app to validate and present normal-memory categories.
export const MEMORY_CATEGORIES = Object.freeze([
  "preference", "fact", "project", "relationship", "instruction", "event", "purchase", "claim", "other",
]);

// A claim is a statement Passport computed from a source the owner authorized
// (ADR-0027; rung 3 of the ADR-0010 provenance ladder). Server-asserted like
// the derived evidence bases: the MCP write schemas, the owner import lane,
// and the owner capture pickers all use WRITABLE_MEMORY_CATEGORIES so no
// caller or hand-save can mint one, while recall keeps the full vocabulary so
// a partner can request an exact claim pass.
export const DERIVED_MEMORY_CATEGORIES = Object.freeze(["claim"]);
export const WRITABLE_MEMORY_CATEGORIES = Object.freeze(
  MEMORY_CATEGORIES.filter((category) => !DERIVED_MEMORY_CATEGORIES.includes(category))
);

// Closed sync-wire vocabulary. A new row shape must add one capability here
// before the server can gate delivery on it.
export const LOCAL_SYNC_CAPABILITIES = Object.freeze(["null_tombstones"]);

// Consumed by the backend to validate memory provenance (evidence_basis: how
// Passport came to believe a memory, ADR-0010). The engine's Python allowlist
// and the memory_proposals CHECK constraint restate this set; the parity is
// pinned by scripts/vocab_contract_smoke.mjs. Only the first two values are
// caller-suppliable over MCP; connector_hit and derived_from_history are
// server-asserted (lib/ingest.js, and the ADR-0027 derived-ingestion lane) and
// deliberately absent from the wire schemas so a calling model cannot claim them.
// derived_from_document is likewise server-asserted: the document ingestion lane
// (share-file-types program) mints it for claims extracted from an owner-shared
// document, where the source is a file the owner picked rather than their bulk
// interaction history.
export const EVIDENCE_BASES = Object.freeze([
  "direct_user_save", "assistant_saved_from_chat", "connector_hit", "derived_from_history",
  "derived_from_document",
]);

// Consumed by backend, marketing, and owner web sign-in surfaces to restrict social providers.
export const SOCIAL_PROVIDER_ALLOWLIST = Object.freeze(["google", "apple", "facebook"]);

// Consumed by marketing and the owner web app when writing shared production auth cookies.
export const SHARED_COOKIE_DOMAIN = ".ego.ist";

// Consumed by the owner web app to match the cookie derived from the marketing Supabase project URL, api.ego.ist.
export const SHARED_COOKIE_NAME = "sb-api-auth-token";

// Server-readable analytics-consent mirror cookies, one per surface: each
// app's banner writes its own host cookie, holding the value literals from
// consent-storage.js. Consumed by marketing's server-capture gate
// (marketing/lib/request.js) and by the owner web app's page-editor proxy,
// which translates its own cookie onto the forwarded header under marketing's
// name so proxied server captures keep honoring the owner's recorded choice.
// Both sides compare these exact names; renaming one without the other sends
// marketing's proxied server events silently dark (that is how they were lost
// between #472 and 2026-08-18), which is why they live here and not as
// module-local literals.
export const WEB_ANALYTICS_CONSENT_COOKIE = "ai_passport_analytics_consent";
export const MARKETING_ANALYTICS_CONSENT_COOKIE = "egoist_analytics_consent";

// Consumed by backend and marketing login-code mail; update Supabase dashboard email templates by hand.
export const LOGIN_CODE_FROM = "Egoist Machines <noreply@ego.ist>";

// Consumed by backend and marketing login-code mail; update Supabase dashboard email templates by hand.
export const LOGIN_CODE_SUBJECT = "Your Egoist login code";

// The Accept media type that opts a client into the decision routes' JSON
// outcome replies (/inbox/:id/approve|reject and the protected/tool-approval
// decisions). Consumed by the backend's wantsDecisionJson and sent by the
// owner web app's mutation proxy. DELIBERATELY not bare application/json:
// the iOS client stamps that generic type on every control-plane request
// while its decision posts require the 303 redirect, so negotiating on it
// silently broke every in-app approve/reject the day the owner queue
// shipped. Both sides compare this exact string, which is why it lives here
// and not as module-local literals.
export const DECISION_JSON_MEDIA_TYPE = "application/vnd.passport.decisions+json";
