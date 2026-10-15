---
name: replay
description: Open the local Marey dashboard in a browser: plan usage, running sessions and replay for Claude Code, Codex and Copilot CLI sessions. Use when the user asks to launch or open Marey.
---

Start the bundled dashboard with Node.js 20+:

1. Resolve `../../scripts/launch.mjs` relative to **this SKILL.md's directory**, using the absolute skill path supplied by Codex. This points into the installed plugin, independently of the user's working directory. Quote the resolved path.
2. Run `node "<resolved absolute path to scripts/launch.mjs>"`. Append `--port <n>` or `--no-open` only if requested. The default port is 3333; the launcher opens the browser and returns while the server keeps running.
3. Report the URL and any startup error from the output. A same/newer Marey server is reused; an older one is replaced. If another application owns the port, report the conflict and suggest another port. The output includes a per-launch log path for diagnostics.

If the host requires permission to start a local server, write Marey's data directory, or open the browser, use its normal approval flow. With `--no-open`, give the user the URL to open manually.

The dashboard reads both hosts' existing session files. Claude usage limits and the status-line wrapper are Claude Code-only; launching from Codex does not install that wrapper.
