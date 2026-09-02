# Regenerate docs/social-preview.png (1280x640, the size GitHub uses for the
# repository social preview) from the repository root:
#   vhs docs/social-preview.tape
# Upload the PNG under Settings > General > Social preview.


Require node

Set Shell bash
Set FontSize 20
Set Width 1280
Set Height 640
Set Padding 40
Set Theme "Catppuccin Mocha"
Set TypingSpeed 1ms
Set WindowBar Colorful

Hide
Type `SWITCHBOARD_HOME=$(mktemp -d) && [ -n "$SWITCHBOARD_HOME" ] && export SWITCHBOARD_HOME || exit 1; switchboard() { node ./src/cli.js "$@"; }; clear`
Enter
Type `switchboard remember "New test files use the .spec.mjs suffix" --category preference >/dev/null; switchboard remember "Ask before touching the payments module" --category instruction >/dev/null; clear`
Enter
Sleep 500ms
Show

Type "# One local memory store for OpenCode, Claude Code, Codex, and Cursor"
Enter
Type "switchboard recall"
Enter
Sleep 1s
Screenshot docs/social-preview.png
Sleep 500ms
