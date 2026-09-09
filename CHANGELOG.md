# Changelog

## 0.3.0 (2026-09-09)

- Add local messages between paired clients: screened bodies in the existing content store, atomic inbox claims, acknowledgement, expiry, and content-free receipts. Messaging is on by default and can be switched off with `switchboard config messaging off`.
- Deliver into every coding host: a Claude Code channel MCP server installed by `coding install`, OpenCode push through the plugin, and a next-prompt inbox for Codex and Cursor through the existing hook. One untrusted-peer envelope everywhere.
- Reuse the approved Passport device link for hosted messaging: registration of paired clients as device agents, peer discovery, a singleton relay with SSE reconciliation, custody acknowledgements, and an idempotent outbox.
- Discover every hosted agent of the owner and propose collaborations, renewals, or continuations from the CLI, the Claude channel, and the OpenCode tools. A send to a peer without a shared group carries a purpose and stays `held` until the owner approves in the Passport Inbox on web or iOS, with a push notification.
- Migrate the store forward to schema 11 while preserving messages, bodies, events, and hosted receipts. Back up `~/.switchboard` before upgrading.
- Bump the OpenCode plugin to 0.1.3.

## 0.2.3 (2026-09-02)

- Included the Cursor adapter in the published npm package. It landed in the repository after 0.2.2 shipped.
- Rewrote the README around a local-first opening with a recorded demo.
- Changed init output so it no longer calls the local store "your AI Passport."
- Added SECURITY.md and CHANGELOG.md.
- Corrected the npm keywords.

## 0.2.2 (2026-08-26)

- Made OpenCode installation global by default, with project installation available through `--project`.
- Added guarded cleanup for managed OpenCode files while preserving files owned by the user.
- Improved sync handling for retries, cursor mismatches, incomplete responses, and per-item content rejection.
- Added local content screening to coding imports and documented the difference between local and hosted screening.
- Added npm provenance metadata and guarded publishing for packages that already exist in the registry.

## 0.2.1 (2026-08-26)

- Moved the OpenCode plugin into this repository and added its tests to CI.
- Limited the vendored shared contract to the values used by the plugin tests.
- Updated the installer to use OpenCode plugin version 0.1.2.
- Updated the publish workflow to use npm 11 only for publishing.

## 0.2.0 (2026-08-26)

- Isolated host installation failures so other requested hosts can still install.
- Installed the OpenCode plugin through a managed `.opencode` package manifest.
- Installed the Codex hook at user scope and added hook trust checks to status and doctor.
- Added version commands and clearer status for installations in other project scopes.
- Updated the pinned OpenCode plugin after its first package was replaced.

## 0.1.0 (2026-08-25)

- Published the first public release of the Switchboard CLI.
- Added a local store for approved preferences, facts, project context, and instructions.
- Added pairing and category grants for OpenCode, Claude Code, and Codex.
- Added local hand-offs, coding memory import, and optional hosted sync.
- Scoped project memory by repository identity so clones and worktrees can share it.
