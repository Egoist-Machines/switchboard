#!/usr/bin/env bash
set -euo pipefail

switchboard_e2e_home="$(mktemp -d "${TMPDIR:-/tmp}/switchboard-e2e.XXXXXX")"

printf 'export SWITCHBOARD_HOME=%q\n' "$switchboard_e2e_home"
printf '\nCleanup:\n'
printf 'SWITCHBOARD_HOME=%q switchboard unlink\n' "$switchboard_e2e_home"
printf '# Revoke the disposable device in the hosted staging device settings.\n'
printf 'rm -rf -- %q\n' "$switchboard_e2e_home"
