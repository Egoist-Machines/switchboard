# @egoistmachines/opencode-switchboard

AI Passport memory for OpenCode. The plugin gives OpenCode two explicit memory tools, optional ambient recall, and local task hand-offs, backed by the local store managed by the [Switchboard CLI](https://www.npmjs.com/package/@egoistmachines/switchboard). Installing the plugin grants no read access by itself. Every read is checked against the paired client and the category grants the owner controls.

## Requirements

- Node.js 22 or newer
- OpenCode 1.18
- The Switchboard CLI

## Install

Use the Switchboard installer from your project directory:

```bash
npm install --global @egoistmachines/switchboard
switchboard init
switchboard coding install --targets opencode
```

The installer records the plugin as a dependency in `.opencode/package.json`, installs it under `.opencode/node_modules/`, writes the plugin entry at `.opencode/plugin/ai-passport.js`, pairs one OpenCode client, and grants it the `coding` profile. Repeated runs reuse the same client and entry. Ambient memory and hand-offs are enabled by the installer; hosted fallback stays off.

Check or repair the installation:

```bash
switchboard coding status
switchboard coding doctor
```

Remove it:

```bash
switchboard coding uninstall --target opencode
```

## What the plugin adds

- `passport_recall`: an explicit read of approved memories, with optional query, categories, and row limit.
- `passport_remember`: a memory proposal. Auto-approved saves become readable through your existing grants right away; review-mode saves wait in the owner's inbox.
- Ambient memory: a short, bounded block of relevant approved memories is added to the session context. It is framed as read-only reference about the owner, never as instructions.
- Hand-offs: a snapshot created with `switchboard handoff create` can be claimed once by the next matching OpenCode session and is shown at the start of that session. Claims are at-most-once; an expired or already-claimed hand-off injects nothing.

## Configuration

The entry file passes options to the plugin:

```js
const options = {
  categories: ["preference", "fact", "project", "instruction"],
  ambient: { enabled: true, maxRows: 6, maxChars: 2000, timeoutMs: 1500 },
  handoff: { enabled: true },
  hostedFallback: { enabled: false },
};
```

- `categories`: governed memory categories the plugin requests.
- `ambient`: toggles ambient recall and bounds its size and time budget.
- `handoff`: enables claiming local hand-offs in this project.
- `hostedFallback`: lets a machine without a local store use a hosted AI Passport connection instead. Off by default; see [ego.ist](https://ego.ist) for hosted setup.

## Files and credentials

- Client credentials live in `switchboard-credentials.json`, mode 0600, in the OpenCode state directory (`$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` when unset; `OPENCODE_STATE_DIR` overrides it).
- Plugin status lives in `ai-passport-status.json` in the same directory and holds content-free counters only.
- The plugin locates the Switchboard binary through `~/.switchboard/runtime.json`. It never scans ports or guesses a binary from `PATH`.
- Credentials are sent to the local CLI on standard input only, never in command arguments or environment variables.

## Privacy

- Installing the plugin grants no read access. Reads use the exact paired client and its active category grants.
- Project memories are keyed to repository identity, so memories scoped to other projects never appear.
- Status output contains no memory text, queries, snapshots, tokens, file paths, or repository names.
- Ambient content is bounded in both rows and characters, and memory text is escaped so it cannot impersonate the framing block.

## Manual installation

Use this only when the installer cannot manage the project.

```bash
mkdir -p .opencode/plugin
cd .opencode && npm install @egoistmachines/opencode-switchboard
```

Create `.opencode/plugin/ai-passport.js`:

```js
import { AIPassportPlugin } from "@egoistmachines/opencode-switchboard";

const options = {
  categories: ["preference", "fact", "project", "instruction"],
  ambient: { enabled: true, maxRows: 6, maxChars: 2000, timeoutMs: 1500 },
  handoff: { enabled: true },
  hostedFallback: { enabled: false },
};

export const AIPassport = async (input) => AIPassportPlugin(input, options);
```

Pair and grant one client, then store the printed ID and secret as `switchboard-credentials.json` (JSON keys `client_id` and `client_secret`, mode 0600) in the OpenCode state directory:

```bash
switchboard client add --host opencode --label 'OpenCode coding install'
switchboard grant add --client <client-id> --profile coding
```

## Status

```bash
npx @egoistmachines/opencode-switchboard status
npx @egoistmachines/opencode-switchboard status --json
```

Status reports the active transport, discovery and pairing state, ambient configuration and compatibility, requested categories, content-free hand-off counters, and the last outcome class.

## Development

```bash
npm test
```

Tests use `node --test` with no test dependencies. The package pins `@opencode-ai/plugin` to the OpenCode release it was tested against.

## License

Apache-2.0.


## Agent messages

Version 0.1.3 receives local messages through Switchboard 0.3.0. The plugin tracks the latest session and injects untrusted message envelopes through the session prompt API. Before a session is known, messages stay pending and the next system transform can include them. `passport_send_message` sends with `to`, `body`, a UUID `idempotency_key`, and optional local `reply_to`. `passport_list_agents` lists paired clients and owner-approved hosted peers. The plugin starts the relay automatically for an approved linked store. `switchboard config messaging off` disables messaging. Messages grant no memory or source access.
