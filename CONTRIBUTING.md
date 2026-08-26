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
