# Switchboard

**Switchboard gives OpenCode, Claude Code, Codex, Cursor, and any Cloud Agent one shared, owner-governed memory.**

*Built by [Egoist Machines, Inc.](https://egoistmachines.com/) - efficient full-stack infrastructure for reliable AI systems.*

Switchboard is local-first, model-neutral memory for coding agents. It keeps approved preferences, facts, project context, and instructions available when you change models, editors, sessions, or checkouts. Optional hosted sync carries the same governed memory across machines.

```console
# OpenCode, session one
You: Remember that new test files use the .spec.mjs suffix.
OpenCode: I'll save that to your Passport.

# OpenCode, a fresh session with another model
You: Add a test for the parser.
OpenCode: I'll add parser.spec.mjs to match the project's test naming convention.

# Claude Code, a fresh session
You: What suffix should new test files use?
Claude Code: Use .spec.mjs for new test files.
```

## Why Switchboard

Coding agents usually lose context when a session ends. Claude Code and Codex have their own memory systems, while OpenCode [closed native memory as not planned](https://github.com/anomalyco/opencode/issues/8043). Even when an editor remembers something, that context stays trapped in one tool.

Switchboard gives every supported editor the same owner-governed store. Memory can follow the repository and the person doing the work without turning approval into permanent access or tying context to one checkout path.

## Features

- **One memory across editors.** OpenCode, Claude Code, Codex, and Cursor read from the same local store, subject to each client's grant.
- **Owner-governed access.** Pair exact clients, grant only named categories, and revoke a client or grant at any time.
- **Optional cross-machine sync.** Content-free lifecycle events sync separately from deletable content records, and hosted sync stays off until you link it.
- **Stable project scope.** Project memories are keyed to Git repository identity, not an absolute checkout path, so worktrees and clones of the same remote share scope.
- **Editor hand-offs.** Send a short-lived task snapshot to one exact client or the `coding` profile, then let the next editor claim it once.
- **Guided import.** Preview and selectively import existing Claude Code guidance and memory plus supported Codex guidance and session memory.

## Quick start

### 1. Install the CLI

Switchboard requires Node.js 22 or newer. Install the package globally so each editor can reach the same command.

```bash
npm install --global @egoistmachines/switchboard # Install the CLI
```

### 2. Initialize the store

Create or open the private local store before installing an editor adapter.

```bash
switchboard init # Create the local store
```

### 3. Connect your editors

The coding installer attempts every supported host it finds. A failure for one host does not prevent the other detected editors from installing. Each successful install pairs one exact client, creates its frozen `coding` grant for `preference`, `fact`, `project`, and `instruction`, stores private credentials, and verifies the adapter against the local store.

```bash
switchboard coding install # Install detected editor adapters
```

Run the installer with `--targets opencode,claude-code,codex,cursor` when you want to select exact hosts. Host-specific scopes, paths, status checks, and uninstall commands are covered in [coding host installation](DOCS.md#install-coding-hosts).

OpenCode installs in `$XDG_CONFIG_HOME/opencode` by default, or `~/.config/opencode` when `XDG_CONFIG_HOME` is unset, so the adapter follows the owner into every project. Use `--project <directory>` for an isolated `.opencode` install. Project installs create `.opencode/.gitignore` with `*` only when no ignore file already exists. For an installer-owned manifest with no foreign dependencies, uninstall also removes the generated dependency tree, lock files, managed ignore file, and an empty project `.opencode` directory. It never removes the global config directory or user files inside it.

### 4. Link sync, if you want it

Hosted sync across machines runs through [AI Passport](https://ego.ist), the hosted memory plane behind Switchboard. Create your Passport at [ego.ist](https://ego.ist), then link each machine to it.

```bash
switchboard link                   # Print a link and a match code
switchboard sync                          # Pull, apply, acknowledge, then push
```

The link command prints an approval URL and a six-character match code, and opens the URL in your browser. Sign in to your Passport, check that the code on the page matches your terminal, and approve. The device shows up in your Passport's Devices panel, where you can revoke it at any time. On a machine with no browser, open the printed URL anywhere you are signed in.

See the [sync reference](DOCS.md#sync-reference) for headless linking, replay, and unlinking. To bring in existing editor memory, start with the [import preview](DOCS.md#import-coding-memory).

## How it works

1. **Editors save proposals.** A paired editor proposes a memory in a named category. Switchboard keeps proposal text separate from its content-free lifecycle event and deduplicates retries from the same client.

2. **The owner sets approval policy.** New local stores auto-approve proposals by default. The owner can enable review mode to approve or reject each proposal, and approval does not grant read access.

3. **Grants gate recall.** Every read checks the exact client and its active category grants before returning approved memory. Project recall adds an exact repository-scope filter and never widens a grant.

4. **Sync moves governed state.** When hosted sync is linked, Switchboard pulls before it pushes and ships content-free lifecycle events. Approved memory and pending proposal text travel only as separately deletable content records; hand-offs remain local.

## Learn more

- [Pairing and grants](DOCS.md#pairing-and-grants)
- [Complete command-line reference](DOCS.md#command-line-reference)
- [Coding host installation](DOCS.md#install-coding-hosts)
- [Importing coding memory](DOCS.md#import-coding-memory)
- [Project identity and scoped injection](DOCS.md#project-identity-and-scoped-injection)
- [Storage and privacy](DOCS.md#storage-and-privacy)
- [Hosted sync](DOCS.md#sync-reference)
- [OpenCode plugin package](packages/opencode-switchboard/README.md)
- [Contributing](CONTRIBUTING.md)
- [Apache License 2.0](LICENSE)
