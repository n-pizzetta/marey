---
description: Connect Marey to your real Claude usage limits (5h / 7d) via the status line, and show Codex's and Copilot CLI's limits in theirs (plus the context used in Codex)
argument-hint: "[--uninstall]"
---

Install the Marey status line wrapper so the dashboard can show the real 5-hour and 7-day usage limits (the same numbers as `/usage`), plus the context fill and prompt-cache state of live sessions (a keep going / compact / clear verdict). After a plugin update, `/marey:replay` refreshes the installed wrapper, so there is no need to run this again for Claude Code. Codex's and Copilot CLI's settings are only changed when this command runs.

Execute this command:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-statusline.mjs" $ARGUMENTS
```

It saves the user's current `statusLine` setting and keeps rendering it, so their existing status line does not change. A backup of `settings.json` is written next to it (`settings.json.marey.bak`).

If Codex or Copilot CLI is installed, it also turns on their native items: `context-used`, `five-hour-limit` and `weekly-limit` in Codex's `[tui] status_line` (`~/.codex/config.toml`, backed up to `config.toml.marey.bak`), and `footer.showQuota` in Copilot CLI. They show up in new sessions of those CLIs.

With `--uninstall`, the script restores the previous status line and removes the wrapper, and puts Codex and Copilot CLI back as they were.

Report the script's output back to the user.
