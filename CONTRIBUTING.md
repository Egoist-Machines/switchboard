# Contributing

This repository is the home of Switchboard development. Issues and pull requests are welcome here.

Releases publish to npm as [@egoistmachines/switchboard](https://www.npmjs.com/package/@egoistmachines/switchboard) from a GitHub Release through the publish workflow.

## Run the suite

You must install Node.js 22 or newer.

Run the suite from the Switchboard repository root.

1. Install the locked dependencies.
2. Run the complete Switchboard test suite.
3. Confirm that every test passes.

```sh
npm ci
npm test
```

## Change behavior

The shared behavior fixtures live in `shared/local-runtime-contract/` in the Egoist Machines monorepo.

Changes to events or outcomes must update those fixtures and their contract tests.

Switchboard also checks its local category vocabulary against `shared/contracts.js`.

Describe any behavior change in the pull request.

Keep events, receipts, status, and hand-off lists free of user content.

Do not add memory text, queries, secrets, paths, or hand-off snapshots to those records.

## End-to-end testing posture

Never run end-to-end tests against the owner's real linked device or the production plane. A test-window wedge must only ever fence a disposable journal.

Use one of these postures:

1. Create a throwaway `SWITCHBOARD_HOME`, then link it to staging with `switchboard link <staging-url>`. Run `test/e2e/disposable-home.sh` and copy the printed export line into the caller's shell.
2. Enroll a disposable second device for the run against a non-production plane, then revoke that device when the run finishes.

For either posture, run `switchboard unlink` against the disposable home, revoke the disposable device in the hosted device settings, and remove the temporary home. The helper prints cleanup commands with the exact temporary path so they cannot target the real `~/.switchboard`.

Never run destructive sync experiments on a store whose `link.json` points at production. Inspect the disposable store's link target before opening a test window or forcing journal recovery.
