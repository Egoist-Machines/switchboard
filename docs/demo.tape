# Regenerate docs/demo.gif from the repository root:
#   vhs docs/demo.tape
# Requires vhs (https://github.com/charmbracelet/vhs). The recording runs
# against a throwaway store so it never touches ~/.switchboard.

Output docs/demo.gif

Require node

Set Shell bash
Set FontSize 16
Set Width 1120
Set Height 460
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type `SWITCHBOARD_HOME=$(mktemp -d) && [ -n "$SWITCHBOARD_HOME" ] && export SWITCHBOARD_HOME || exit 1; switchboard() { node ./src/cli.js "$@"; }; clear`
Enter
Sleep 500ms
Show

Type "switchboard init"
Sleep 400ms
Enter
Sleep 1.8s

Type `switchboard remember "New test files use the .spec.mjs suffix" --category preference`
Sleep 400ms
Enter
Sleep 1.4s

Type `switchboard remember "Releases go through the GitHub workflow, not by hand" --category instruction`
Sleep 400ms
Enter
Sleep 1.6s

Type "switchboard recall"
Sleep 400ms
Enter
Sleep 4s
