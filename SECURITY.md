# Security

## Supported versions

Only the latest 0.x minor release receives security updates.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: [Report a vulnerability](https://github.com/Egoist-Machines/switchboard/security/advisories/new). Do not open a public issue.

Expect an acknowledgement within 3 business days.

## What data leaves the machine

Runtime memory operations are offline. They do not send memory text, proposals, queries, hand-off snapshots, or client secrets off the machine.

`switchboard coding install` for OpenCode runs `npm install` and may contact the npm registry. It does not send store content.

Hosted sync starts only after the owner explicitly runs `switchboard link`. Linking sends a device id, the local owner id, a device label, a hash of the device credential, and the client's sync capabilities. During sync, each lifecycle event carries identifiers, the acting client id, timestamps, the save id, the memory category, and a keyed project-scope id, but no memory text. Memory text travels only as separately deletable content records, and the hosted plane can reject content that the local screen accepted.

Client secrets are stored in the database only as salted hashes. Each installed editor adapter also keeps its own client id and secret in a private JSON file with mode `0600` so the editor can authenticate; treat those files like any other credential file.

## Local store protections

Switchboard sets its home directory to mode `0700` and store files to mode `0600`.

Payloads are plaintext by default. Use operating-system disk encryption to protect data at rest.

Each memory or hand-off payload is limited to 32 KiB. The local content screen rejects full payment-card numbers, private keys, known service secrets, binary content, and oversized content.
