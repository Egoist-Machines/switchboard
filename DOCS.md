# Switchboard reference

This page contains the complete command reference and the JSON contract for agent integrations. It also covers pairing, storage, privacy, upgrades, and errors. Start with the product overview and quickstart in [README.md](README.md).

## Pairing and grants

Use one client for each coding-agent installation. The supported host values are `codex`, `claude-code`, `opencode`, and `other`. A paired client may propose memory, but it needs an active grant for every category it reads.

1. Run **`switchboard client add --host <host> --label <label>`**.
2. Store the printed client ID and client secret.
3. Run **`switchboard grant add --client <client-id> --profile coding`**.
4. Give both client credentials to the local host adapter.

You may grant explicit categories instead of a profile. A profile grant freezes its profile version, category list, and project scopes when it is created, so later profile changes do not widen an existing grant. Use `--project` to constrain an explicit grant to the stable identity of one repository.

```sh
switchboard grant add --client <client-id> --categories fact,project
switchboard grant add --client <client-id> --categories project --project <directory>
```

New local stores approve proposals automatically. Use review mode when the owner should decide each proposal; this setting applies only to the local replica and event replay does not copy it to another replica.

```sh
switchboard config set auto_approve off
switchboard inbox list
switchboard inbox approve <proposal-id>
```

## Command-line reference

A valid command exits with code 0 unless a section states otherwise. Invalid syntax or input exits with code 2 and prints an error to standard error. A store open failure exits with code 1 for owner commands, while machine commands follow the [JSON integration contract](#json-contract-for-integrators).

### Help

**`switchboard`**, **`switchboard help`**, **`switchboard --help`**, and **`switchboard <command> --help`** print the general usage line and command list. They exit with code 0 without opening the store.

```text
switchboard
switchboard help
switchboard --help
switchboard <command> --help
```

**`switchboard --version`**, **`switchboard -v`**, and **`switchboard version`** print the version and exit with code 0 without opening the store.

```text
switchboard --version
switchboard -v
switchboard version
```

### Initialize the store

**`switchboard init`** creates or opens the store and writes **`runtime.json`**. Repeated calls keep existing state and print this line:

```text
Switchboard is ready. Memories saved by paired coding agents are kept automatically in your AI Passport and are readable by clients you grant. Review mode is available through config. Nothing leaves this machine.
```

### Show status

**`switchboard status`** prints the schema, policy, store type, category counts, clients, and active grant categories. **`switchboard status --json`** prints `schema_version`, `policy_mode`, `store`, `memory_counts`, and `clients`. Neither form includes memory text.

```text
switchboard status
switchboard status --json
```

### Save owner memory

**`switchboard remember`** saves approved owner memory in a writable category. It prints `Saved to your Passport. Proposal <proposal-id>.` Use `--project` to scope the memory to that repository.

```text
switchboard remember <text> --category <category> [--project <directory>]
```

### Recall owner memory

**`switchboard recall`** uses the `coding` profile categories unless `--categories` supplies a comma-separated list. Each result prints `<memory-id>  <category>  <content>`, while an empty result prints `No matching memories.` Owner recall creates no receipt. With `--project`, it reads global memory plus memory for that repository. Without it, it reads global memory only.

```text
switchboard recall [--categories <category-list>] [--query <text>] [--project <directory>]
```

### Review the inbox

**`switchboard inbox list`** prints `<proposal-id>  <category>  <content>` for each pending proposal and prints nothing for an empty inbox. Approval prints `Approved.` or `No pending proposal.`, while rejection prints `Rejected.` or `No pending proposal.`

```text
switchboard inbox list
switchboard inbox approve <proposal-id>
switchboard inbox reject <proposal-id>
```

### Manage clients

**`switchboard client add`** prints the client ID, client secret, and a one-time storage reminder. **`switchboard client list`** prints a JSON array with public client state. Revocation prints `Client revoked.` or `Unknown client.`

```text
switchboard client add --host <host> --label <label>
switchboard client list
switchboard client revoke <client-id>
```

### Manage grants

**`switchboard grant add`** prints the created grant as JSON, including its frozen profile version, categories, and project scopes. **`switchboard grant list`** prints matching grants as a JSON array. Revocation prints `Grant revoked.` or `Unknown grant.`

```text
switchboard grant add --client <client-id> --profile <profile>
switchboard grant add --client <client-id> --categories <category-list>
switchboard grant list [--client <client-id>]
switchboard grant revoke <grant-id>
```

### Show a profile

**`switchboard profile show`** prints the latest profile row as JSON and defaults to `coding`. The row includes its name, version, categories, project scopes, and creation time.

```text
switchboard profile show [profile]
```

### Configure approval

**`switchboard config get`** prints `auto_approve on` or `auto_approve off`. The set forms change the local setting and print its new value.

```text
switchboard config get
switchboard config set auto_approve on
switchboard config set auto_approve off
```

### Manage memory

**`switchboard memory list`** prints `<memory-id>  <category>  <content>` for each approved memory. Owner deletion prints a JSON `deleted` or `not_found` outcome. JSON deletion reads `client_id`, `client_secret`, and `memory_id` from standard input and prints a JSON `deleted`, `not_found`, or `refused` outcome.

```text
switchboard memory list
switchboard memory delete <memory-id>
switchboard memory delete --json
```

Malformed JSON deletion exits with code 2 and prints `Malformed invocation.` A client may delete only memory that it sourced.

### Manage hand-offs

**`switchboard handoff create`** reads a non-empty snapshot from standard input and prints `status`, `handoff_id`, and `expires_at` as JSON. Select one exact client with `--to`, or select the `coding` profile and an optional project. An exact-client hand-off cannot include a project value.

```text
switchboard handoff create --to <client-id> [--expires <duration>]
switchboard handoff create --profile coding [--project <project>] [--expires <duration>]
switchboard handoff list
```

Use `--expires 30m`, `--expires 12h`, or `--expires 2d` to change the default 24-hour duration. **`switchboard handoff list`** prints pending state as a JSON array without the snapshot or project value.

For example, create and inspect a project hand-off as follows:

```sh
printf '%s\n' 'Task: finish the parser. Plan: add the failing case. Constraint: preserve the public API.' | switchboard handoff create --profile coding --project "$PWD"
switchboard handoff list
```

A paired client with an active `coding` grant and the same project value may claim a profile hand-off. A successful claim commits a deletion fence, erases the snapshot, and returns it once. Switchboard expires an unclaimed hand-off on the first store access after its deadline; claims and expiries create content-free receipts and deletion fences.

### Check the store

**`switchboard doctor`** prints four JSON Boolean values that cover directory permissions, database permissions, the schema, and runtime discovery. It exits with code 1 when any check is false.

```text
switchboard doctor
```

The printed fields are:

- `store_directory_private`
- `database_private`
- `schema_current`
- `discovery_consistent`

### Install coding hosts

Initialize Switchboard before installing a host. **`switchboard coding install`** finds supported host binaries and config directories without uploading discovery data. Without `--targets`, it installs every host it finds; with `--targets`, it installs only the named hosts.

```text
switchboard init
switchboard coding install [--targets opencode,claude-code,codex] [--project <directory>] [--global]
```

The installer pairs one exact client for each host and creates a `coding` grant. It reuses an active client and grant on repeated runs, then prints the client ID, granted categories, verification result, and uninstall command. It attempts every requested host. If one host fails, it prints these lines to standard error, continues with the other requested hosts, and exits with code 1 after the remaining installs finish:

```text
<host>: install failed: <reason>
remediation: switchboard coding install --targets <host> [--project .]
```

Claude Code uses **`~/.claude/settings.json`** by default. Use `--project <directory>` for the project's **`.claude/settings.json`**, or `--global` to request user scope explicitly. Switchboard installs the Codex hook in the user-level **`$CODEX_HOME/hooks.json`** (default **`~/.codex/hooks.json`**), because Codex loads a project's `.codex` directory only for projects explicitly marked trusted in the Codex user config and skips project hooks silently otherwise, including in `codex exec`. The hook reads the working directory from each prompt event, so project-scoped memory continues to resolve per repository. Codex runs a hook only when **`$CODEX_HOME/config.toml`** (default **`~/.codex/config.toml`**) contains a matching `trusted_hash` in its `[hooks.state]` entry keyed to the user-level hooks path. Hooks without a matching hash are skipped silently. The installer records the hash, backs up `config.toml` before changing it, and prints `hook trust: recorded` or `hook trust: already recorded`. Uninstall removes the trust entry. Existing project-scoped Codex installs remain visible and can be removed with `switchboard coding uninstall --target codex --project <directory>`. If the entry cannot be recorded, the install still succeeds and prints this guidance to standard error:

```text
codex: hook trust could not be recorded: <reason>. Open codex in this project and trust the hook via /hooks.
```

OpenCode installs **`@egoistmachines/opencode-switchboard`** in the project and writes **`.opencode/plugin/ai-passport.js`**. That entry enables ambient memory and hand-offs, treats the install as the owner-present ceremony, and keeps hosted fallback off. The installer records the plugin as a regular dependency in **`.opencode/package.json`**, creates that manifest when needed, and merges into an existing manifest after creating a timestamped backup. It runs `npm install` inside **`.opencode/`**, which installs the package at **`.opencode/node_modules/@egoistmachines/opencode-switchboard`**. Later npm activity at the project root does not touch that directory. When the directory is missing, OpenCode reinstalls the plugin from the manifest at startup. For development, use a local package archive:

```text
switchboard coding install --targets opencode --project <directory> --opencode-plugin-tarball <archive>
```

The tarball form reads the plugin name from the archive and records a `file:` dependency with the archive's absolute path in the manifest. Uninstall removes that dependency entry and installed package. It deletes the manifest only when the installer created it and no other manifest content remains.

For Claude Code and Codex, Switchboard appends only its own hook to existing JSON config and keeps unrelated settings and hooks. OpenCode uses its exact managed entry file and refuses to replace a foreign entry. Each host has one paired client shared across that host's installed project or user scopes; versioned per-host state records every scope, installed entry, and config file identity.

Changing an existing Claude Code or Codex config creates a timestamped backup beside it. Repeated unchanged runs do not add another hook or backup. Credentials use mode `0600` at these locations:

- Claude Code: **`~/.local/share/switchboard/claude-code-credentials.json`**
- Codex: **`~/.local/share/switchboard/codex-credentials.json`**
- OpenCode: **`switchboard-credentials.json`** in the OpenCode state directory

Use **`switchboard coding status`** to print install state, client ID, active coding categories, config state, and the last verification result for each host. When a host has scopes installed for other projects but not the selected project, status prints `installed=no (N other scopes)`. Codex normally has one user scope, so `--project` does not change its hook location; legacy project-scoped Codex records still use the selected project for status, doctor, and uninstall. The Codex line also prints `hook_trust=ok`, `hook_trust=missing`, `hook_trust=stale`, or `hook_trust=unknown` for the selected installed scope. Use **`switchboard coding doctor`** to repeat discovery and adapter verification and check credential permissions, store health, and Codex hook trust. Doctor exits with code 1 when Codex trust is missing or stale and prints these remediation lines:

```text
remediation: switchboard coding install --targets codex --project .
or open codex in this project and trust the hook via /hooks.
```

Failed store and adapter checks print an exact initialization or install command, while invalid install state prints fail-closed repair guidance.

```text
switchboard coding status [--project <directory>]
switchboard coding doctor [--project <directory>]
```

Both commands keep memory text, queries, secrets, and project values out of their output. Remove one host integration with:

```text
switchboard coding uninstall --target <host> [--project <directory>] [--keep-client]
```

Uninstall removes only the exact entry recorded for that scope and leaves unrelated config entries and other installed scopes unchanged. When the last scope is removed, it deletes the credential and revokes the client and grant; use `--keep-client` only when they must remain. Missing or malformed install state fails closed without touching config, credentials, clients, or grants, and deleting local memories remains a separate owner action.

### Import coding memory

**`switchboard coding import`** discovers existing coding-agent guidance and shows every candidate before it saves anything. Each candidate has a source label, category, and global or project scope. The command asks for an individual `y` or `n` decision. `--dry-run` prints the same preview without prompting or saving.

```text
switchboard coding import [--project <directory>] [--dry-run]
```

The import reads these sources:

- `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.codex/rules/*.rules` as global guidance.
- `CLAUDE.local.md` and other untracked instruction files in the selected checkout as project memory. Checked-in `CLAUDE.md` and `AGENTS.md` files are repository truth and are not offered.
- Per-fact files below `~/.claude/projects/<path-slug>/memory/`. It does not import the `MEMORY.md` index. If the original slug is unresolved or ambiguous, Switchboard skips those facts with a note instead of guessing a project or offering them as global memory.
- Selected Codex session memory from the highest numbered `~/.codex/memories_*.sqlite` and matching thread metadata from the highest numbered `~/.codex/state_*.sqlite`. Disabled memory modes are excluded. Switchboard copies both databases before opening the copies read-only. An unknown schema is skipped with a note.

Import never changes its source files. Its source-plus-content fingerprint is the save idempotency key. A rerun labels prior items `already present` and does not duplicate them. Accepted items are ordinary owner saves, so they sync, remain individually deletable, and obey tombstones.

### Project identity and scoped injection

Switchboard derives project identity from Git, never from a checkout path. It normalizes the `origin` remote, or the first configured remote when `origin` is absent, by removing the scheme, credentials, and trailing `.git` and by case-folding the host. A repository without a remote uses its first root commit. A non-Git directory has no project identity.

The raw identity is HMAC-SHA256 fingerprinted with the owner's scope key in the `hmac-sha256-v1` format. Only the 64-hex fingerprint enters memory events and sync payloads. Raw remote identities, repository names, and paths do not enter events, receipts, logs, status output, the hosted link, or server storage. A worktree, another clone, or another linked machine with the same remote resolves to the same scope.

An unlinked store starts with a replica-local scope key. Every fresh link ceremony attempts to download the served Passport owner's 32-byte scope key and makes a successfully delivered key the active primary. The replica key remains a read-side-only legacy fallback. If the store relinks to a different Passport owner, the former active owner key also moves into that store's read-side legacy fallback set and never remains primary; new fingerprints use only the newly served owner key. `switchboard unlink` removes only the hosted credential and leaves these local fallback keys untouched, and the next fresh link ceremony decides the active primary.

A server version without the scope-key route, or any other non-authentication failure of that route, does not block linking or syncing: adoption stays pending and a store without an active owner key retries the download on later syncs. HTTP 401 and 403 still stop sync. After adoption, new project saves converge across that owner's linked machines. Rows saved before adoption or under a former linked owner cannot be re-derived because the store deliberately did not retain their raw repository identities. Those rows stay readable on the machine that created them through its legacy fallback keys. Re-save one of those memories under the active owner to make its new project scope converge across that owner's machines.

The hosted account already stores the owner's memory content. Holding the owner's scope key on that same server is therefore not a privacy regression. The fingerprints remain opaque to third parties and other owners. Repository identities still never appear on the wire or in server storage.

Scope-key rotation within one hosted owner is a future compatibility contract. This release does not rotate an owner's key. Relinking through a different account intentionally gives the store a different active owner key, so new project fingerprints diverge from the old account's fingerprints while old rows remain locally readable through the former-key fallback.

Claude Code and Codex prefetch hooks and the OpenCode system transform resolve the current repository before recall. They inject global memory plus memory with that exact project scope. A different project scope never matches. Outside Git they inject global memory only. Project scope is an additional filter and never grants a category or widens an existing pass.

### Prefetch and propose

**`switchboard prefetch --json`** and **`switchboard propose --json`** read one JSON request from standard input and print one JSON outcome to standard output. Their fields and exit behavior are defined in the [JSON integration contract](#json-contract-for-integrators).

```text
switchboard prefetch --json
switchboard propose --json
```

### Create and claim machine hand-offs

**`switchboard handoff-create --json`** and **`switchboard handoff-claim --json`** read one JSON request from standard input and print one JSON outcome to standard output. Their fields and exit behavior are defined below.

```text
switchboard handoff-create --json
switchboard handoff-claim --json
```

## JSON contract for integrators

Run **`switchboard init`** before an adapter uses this contract. The command writes **`runtime.json`** in the Switchboard home with `version`, `home`, `transport`, and an absolute `bin` path. An adapter must execute that exact path, pass `--json` for every machine command, and write one JSON object to standard input.

Input must not exceed 131,072 UTF-16 code units. Each command writes one newline-terminated JSON object to standard output. Client secrets, memory text, queries, and hand-off snapshots must stay out of command arguments, and `save_id` must match `^[A-Za-z0-9._-]{1,64}$`.

A malformed request prints `Malformed invocation.` and exits with code 2. An invalid `save_id` prints its exact pattern requirement and exits with code 2. A machine dependency failure prints an error, returns an `unavailable` outcome, and exits with code 0; other domain outcomes also exit with code 0.

Claude Code and Codex ambient hooks use **`switchboard hook claude-prefetch`** and **`switchboard hook codex-prefetch`**. Each reads the host's `UserPromptSubmit` JSON from standard input, reads only that host's credential file, and calls the local store in process. It writes host hook JSON with an `<ai-passport>` reference block when a readable or blocked result needs context; empty results, unavailable stores, malformed input, unsafe credentials, and deadline overruns write nothing and exit with code 0.

### Prefetch request and response

Syntax:

```text
switchboard prefetch --json
```

Request:

```json
{"client_id":"2be63745-593a-4d98-bf83-9fd0819ef149","client_secret":"local-client-secret","categories":["instruction"],"query":"ERR_RUNTIME_42","limit":20,"ambient":true}
```

Response:

```json
{"status":"results","transport":"local","connectivity":"offline","freshness":"fresh","as_of":"2026-08-24T19:00:00.000Z","rows":[{"memory_id":"314738f2-2681-4381-9714-edf0377096b0","content":"Use exact-token tests for ERR_RUNTIME_42","source":"My Codex install","created_at":"2026-08-24T18:59:00.000Z","occurred_at":"2026-08-24T18:59:00.000Z","category":"instruction","client_id":"2be63745-593a-4d98-bf83-9fd0819ef149","evidence_basis":"assistant_saved_from_chat","record_kind":"memory","verified_issuer":null,"verified_at":null}],"skipped_categories":[]}
```

The request requires string `client_id` and `client_secret` values. Optional fields are `categories`, `query`, `limit`, `ambient`, and local `project`; omitted categories default to the `coding` profile, and the result limit is clamped between 1 and 50 rows. The local adapter resolves `project` to an opaque scope before reading. `ambient: false` creates a content-free read receipt, while other values create no read receipt.

The local command returns `results`, `empty`, `blocked`, or `unavailable`. Each outcome keeps `transport`, `connectivity`, `freshness`, `as_of`, `rows`, and `skipped_categories`, so an empty result remains distinct from a blocked read or dependency outage.

### Propose request and response

Syntax:

```text
switchboard propose --json
```

Request:

```json
{"client_id":"2be63745-593a-4d98-bf83-9fd0819ef149","client_secret":"local-client-secret","save_id":"adapter-save-42","category":"instruction","content":"Use exact-token tests for ERR_RUNTIME_42"}
```

Response:

```json
{"status":"recorded","proposal_id":"711e9848-7340-452a-9158-46ebea731dcb","save_id":"adapter-save-42","disposition":"auto_approved"}
```

The request requires string values for all five shown fields. Optional `occurred_at` records the memory occurrence time, and local `project` scopes the proposal to its repository identity. The status is `recorded`, `duplicate`, `rejected`, or `unavailable`, and a recorded proposal has disposition `auto_approved` or `pending`.

Repeating a `save_id` from the same client returns `duplicate` without another event. A save-time content or category refusal returns `rejected` with no recorded proposal; later owner rejection is a separate inbox lifecycle decision.

### Hand-off creation request and response

Syntax:

```text
switchboard handoff-create --json
```

Request:

```json
{"client_id":"2be63745-593a-4d98-bf83-9fd0819ef149","client_secret":"local-client-secret","snapshot":"Task: finish the parser. Plan: add the failing case.","profile":"coding","project":"/work/parser","expires":"24h"}
```

Response:

```json
{"status":"created","handoff_id":"349c0846-94d3-47b4-9454-b1cb401b45f3","expires_at":"2026-08-25T19:00:00.000Z"}
```

The request requires string `client_id`, `client_secret`, and `snapshot` values. It must include exactly one string field named `to_client_id` or `profile`; the only supported profile is `coding`. Optional `project` works only with that profile, while optional `expires` uses a positive integer followed by `m`, `h`, or `d`.

The status is `created` or `unavailable`.

### Hand-off claim request and response

Syntax:

```text
switchboard handoff-claim --json
```

Request:

```json
{"client_id":"88e12ec8-e069-4532-839b-43b3a1e188f4","client_secret":"receiving-client-secret","project":"/work/parser"}
```

Response:

```json
{"status":"claimed","handoff_id":"349c0846-94d3-47b4-9454-b1cb401b45f3","snapshot":"Task: finish the parser. Plan: add the failing case.","expires_at":"2026-08-25T19:00:00.000Z"}
```

The request requires string `client_id` and `client_secret` values. Optional `project` selects a matching profile hand-off. The status is `claimed`, `expired`, `none_pending`, or `unavailable`, and only `claimed` contains a snapshot.

## Storage and privacy

The default **Switchboard home** is **`~/.switchboard`**; set **`SWITCHBOARD_HOME`** to choose another directory. Switchboard sets the home directory to mode `0700` and **`passport.db`** plus **`runtime.json`** to mode `0600`. Payloads are plaintext by default, so the owner should enable operating-system disk encryption; the storage interface provides a payload codec for optional encryption.

Runtime memory operations run offline: Switchboard sends no memory text, proposal, query, hand-off snapshot, or client secret off the machine. The one exception is `switchboard coding install` for OpenCode, which runs `npm install` and may contact the npm registry to fetch the plugin package; no store content is involved. Memory text and snapshots stay outside events, receipts, status output, and hand-off lists. Client secrets enter machine commands through local standard input, appear once when created, and persist only as salted hashes in the store.

Switchboard does not store recall queries. Events store a keyed project fingerprint instead of the project value. Linked stores keep the hosted owner scope key and their original replica scope key in private database metadata. Content screening rejects full payment-card numbers, private keys, known service secrets, binary content, and oversized content; each memory or hand-off payload has a 32 KiB limit.

## Upgrading

Switchboard checks and migrates the schema whenever it opens the store. Versions 4 and 5 migrate through version 6, version 6 migrates through version 7, and version 7 migrates forward to version 8. The version 5-to-6 migration expires pending project-scoped hand-offs because old scope values cannot be converted safely, but it preserves pending unscoped hand-offs. The version 7-to-8 migration retains the old replica scope key. It adds the hosted owner scope key only after an approved link delivers it.

The version 8 migration is forward-only, like the earlier schema bumps. Before upgrading, stop Switchboard and copy the entire Switchboard home directory (by default `~/.switchboard`) to a private backup location. That directory contains the database and the local keys needed to interpret its keyed identifiers. The single-writer guidance still applies: do not intentionally open one store from concurrent Switchboard processes during the upgrade. If another process nevertheless reaches the guarded upgrade while the writer holds it, bounded contention handling returns a retryable unavailable outcome rather than partially applying or corrupting the migration. After a version 8 binary opens the store, a version 7 binary refuses it; restore the copied directory before running the older binary instead of trying to downgrade the live store.

Other unsupported schema versions fail closed. Keep the pre-upgrade directory copy until the upgraded binary and sync flow have been verified.

Hosted sync negotiates row-shape capabilities before it downloads a page. An older client keeps its hosted cursor when a newer shape appears and receives actionable upgrade guidance.

## Sync reference

Hosted sync is optional and runs through the owner's AI Passport account.

```bash
switchboard link                      # Links to https://passport.ego.ist
switchboard link https://example.dev  # Optional override for development or a self-hosted plane
```

A bare host argument normalizes to https. Plain http stays available for loopback development hosts only.

Switchboard creates the device credential locally. It sends only the credential
hash when it creates a ten-minute link ticket. No owner credential enters the
terminal.

The command prints a browser URL and a six-character match code. On macOS it
also tries to open the URL. Sign in to Passport in that browser, confirm that
the browser and terminal show the same match code, then approve or refuse the
device. The code is display-only and cannot approve a device.

Switchboard polls with the ticket's separate poll secret. Approval enrolls the
device as approved and binds it to the locally generated credential. Refusal
and expiry are terminal and the command exits nonzero.

Before opening the browser, Switchboard stores a versioned pending ceremony in
`~/.switchboard/pending-link.json` with mode `0600`. It contains the local device
credential, ticket id, poll secret, and expiry so an interrupted command resumes
the same ticket instead of minting another device. Approval atomically writes
`link.json` before removing the pending record; refusal and expiry remove it.

On a headless machine or cloud runner, copy the printed URL to any browser.
The browser does not need to run on the same machine. Confirm the printed match
code before approving.

Switchboard stores that credential in `~/.switchboard/link.json` with mode `0600`. Once the device is approved, it uses that credential to fetch the hosted owner's scope key. An upgraded linked store also fetches the key at the start of its first sync. Pending and revoked devices cannot fetch it.

The unauthenticated mint endpoint also has two abuse backstops. Its IP throttle
is per process, so production's multiple app instances do not share that
counter. Postgres separately enforces an owner-independent global ceiling of
10,000 live minted-or-opened tickets under an atomic count-and-insert lock. The
five-minute local-sync effect sweep expires untouched tickets and deletes
terminal or past-expiry ticket rows after a fixed 24-hour retention interval.

Use `switchboard link --status` to inspect local link state.

Run one full sync cycle as follows.

```sh
switchboard sync
switchboard sync --json
switchboard sync --replay-from 12
```

Every cycle pulls before it pushes.

The first pull uses the hosted snapshot.

Later pulls use ordered change pages from the last acknowledged cursor.

A successful cycle has status `ok`. It may still report `pending` uploads when
the hosted plane asks the client to retry an item or truncates a batch at a
claim refusal. Those rows keep their event IDs and upload sequences and are
offered again on the next cycle. The client stops pushing for the current cycle
so it does not bypass hosted backoff.

JSON summaries include `pending`, `content_rejected_rows`, and
`failure_detail`. `pending` is the number of assigned upload rows still queued.
Each `content_rejected_rows` entry contains `event_id`, `entity_id`, `category`,
and `created_at`, never the rejected content. `failure_detail` is normally null
and carries the local and server cursors for `cursor_desync`.

Sync failures keep distinct statuses. `sync_refused` means the hosted plane
refused the sync request. `ack_refused` means it refused the cursor
acknowledgement. `invalid_response` means the response shape was not recognized.
`pull_required_loop` means push remained fenced behind repeated pulls.
`hosted_unavailable` means the hosted plane returned server errors.
`cursor_desync` means the local and server cursors cannot be reconciled safely.
Network failure, device approval, and client upgrade failures remain
`network_failure`, `not_approved`, and `upgrade_required`.

### Sync capabilities

The closed capability vocabulary is currently `null_tombstones`. It means the client can ingest tombstone fence rows whose hosted memory ID and category are null. The current Switchboard release declares every capability in the vocabulary when it mints a link ticket.

Every authenticated `GET /sync/v1/changes` and `GET /sync/v1/snapshot` request sends `X-Switchboard-Capabilities` as a comma-separated list. The server refreshes the device's stored declaration from that header. A missing header is the legacy empty set. Unknown or duplicate values are rejected with the content-free `invalid_capabilities` error.

If a selected page contains a row that requires a capability the device did not declare, the server sends HTTP 426 before hydration or cursor offering:

```json
{"error":"upgrade_required","missing_capability":"null_tombstones"}
```

The response contains no row data. `switchboard sync` prints an instruction to upgrade Switchboard and exits nonzero. JSON mode returns the distinct `upgrade_required` status and `missing_capability`; it does not collapse this outcome into `unavailable`.

The server may require a new capability when it introduces another wire row shape. Old clients receive `upgrade_required` instead of a silently withheld row. Capabilities are not used to widen authorization, and the server does not silently deprecate a shape while devices still need an actionable upgrade path.

Switchboard applies every page before it acknowledges the exact offered boundary.

It retries an acknowledgement once after a network failure or server error. If
an acknowledgement response was lost after the page committed locally, the
next `cursor_not_current` response can move the local cursor forward only when
every intervening change sequence is already recorded locally. The pull loop
then continues from the reconciled cursor. A missing sequence, or a server
cursor behind the local cursor, returns `cursor_desync` with both cursor values.

It does not push while a deletion or account fence is unacknowledged.

A deletion uploaded by this device creates a self-fence.

Switchboard pulls and acknowledges that fence before it retries later events.

Upload progress is durable.

A retry uses the same event ID and hosted upload sequence.

The server may return that replay as a duplicate.

If the server instead replays a recorded `invalid_event` rejection for a sequence
it already claimed, Switchboard marks only that upload row `rejected_recorded`,
leaves the underlying proposal or memory local, and continues draining later sequences. At
the start of a later cycle, Switchboard automatically emits a fresh event when
that row is still the latest local event and the entity is not tombstoned. A
locally approved proposal emits an owner-authored creation and approval pair. A
review-mode proposal emits only a new pending creation, preserving its original
actor, client, provenance, and disposition, so it remains in the inbox. The new
creation carries the same separately stored content at the next content version
and follows the normal upload path. The journal records the link so later cycles
do not emit it again. A tombstoned entity, an entity with a later local event, or
an entity whose content is no longer available is marked terminally evaluated
and stays local with the recorded outcome `kept`.

Use `switchboard sync --replay-from <seq>` to recover a hosted device journal
that is stuck in `claimed` or `effects_pending`. The sequence must be a positive
integer in this link's assigned upload range. Switchboard queues that sequence
and every later assigned upload row, clears their local outcomes, and runs the
normal pull-then-push cycle. It does not modify events or content records. Hosted
replay makes the command safe to repeat. Final events return their existing
outcomes, while pending content-bearing events rerun with the inline content
still held by the device. If that content was deleted locally, Switchboard sends
no content record and keeps the server's terminal outcome. Human output reports
replay, reemit, rejection, pending, and conflict counts. A hosted content-screen
rejection also prints one local edit-or-delete instruction with its category,
creation time, and entity ID. `switchboard sync --json` carries opaque event,
entity, and winner identifiers in `conflict_rows`, plus the local metadata in
`content_rejected_rows`, so local integrators can automate recovery. It does not
carry memory content, `save_id`-derived text, credentials, paths, or repository
names. Other null-event rejection reasons fail closed and leave every offered
upload pending.

Review-mode proposals sync as pending proposals with separate content records.

Approval policy remains local to each replica.

The hosted receiver currently accepts only `proposal_created`, `proposal_approved`, `proposal_rejected`, and `memory_deleted`.

It does not accept `handoff_created`, `handoff_claimed`, or `handoff_expired`.

Switchboard therefore skips hand-off events and content and reports a content-free `skipped_handoffs` count.

Sync sends approved memory content and pending proposal content only as separately deletable content records.

It never sends recall queries, receipts, client secrets, project paths, repository names, scope keys, or local policy settings from the device to the server. The approved-device scope-key route sends the hosted owner scope key from the server to the device.

Run `switchboard unlink` to remove the local credential.

Unlinking does not revoke the hosted device.

The owner must revoke that device in the signed-in Passport device settings.

## Troubleshooting

Each heading below matches the exact error text printed by the command.

### `Switchboard store is unavailable.`

Check that **`SWITCHBOARD_HOME`** points to a writable directory and that Switchboard supports the store schema. Run **`switchboard doctor`** after the store opens again.

### `Malformed invocation.`

Send one JSON object to standard input and check every required field and field type. Keep the input at or below 131,072 UTF-16 code units.

### `save_id must match ^[A-Za-z0-9._-]{1,64}$`

Use 1 to 64 letters, numbers, periods, underscores, or hyphens. Do not put content or a path in `save_id`.

### `invalid categories`

Use comma-separated values from `preference`, `fact`, `project`, `relationship`, `instruction`, `event`, `purchase`, `claim`, and `other`. The `claim` category is read-only.

### `unknown client`

Run **`switchboard client list`** and copy an existing client ID.

### `unknown or revoked target client`

Select an active client for the exact hand-off target.

### `invalid handoff duration`

Use a positive integer followed by `m`, `h`, or `d`.

### `memory was refused`

Remove payment-card numbers, private keys, service secrets, or binary content. Keep memory content at or below 32 KiB.

### `OpenCode plugin tarball is unreadable`

Pass a readable gzip package archive with a `package/package.json` file that contains a non-empty package name.

### `.opencode/package.json exists and is not valid JSON`

Repair or replace the manifest with one JSON object, then run the install command again. Switchboard does not install an OpenCode plugin when it cannot read the manifest.

### `OpenCode plugin installation failed: <npm reason>`

The installer includes the final npm error lines after this prefix. Check the npm reason, then rerun **`switchboard coding install --targets opencode --project <directory>`**. The failure does not stop the installer from attempting other requested hosts.

### Codex hook trust

When `coding status` shows `hook_trust=missing` or `hook_trust=stale`, run **`switchboard coding doctor --project <directory>`**. It exits with code 1 and prints the install command plus `or open codex in this project and trust the hook via /hooks.` Open Codex and use `/hooks` to trust the user-level hook when Switchboard cannot record the trust entry itself.
