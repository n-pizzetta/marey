<h1 align="center">
  <img src="./docs/logo.svg" alt="" width="64" valign="middle" /> Marey
</h1>

<p align="center">
  <a href="https://github.com/n-pizzetta/marey/releases"><img src="https://img.shields.io/github/v/release/n-pizzetta/marey?style=flat&amp;color=08C" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat" alt="Claude Code plugin" />
  <img src="https://img.shields.io/badge/100%25%20local-no%20telemetry-3DDC97?style=flat" alt="100% local, no telemetry" />
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
</p>

<p align="center">
  <strong>The flight recorder for your Claude Code, Codex and Copilot CLI sessions.</strong><br/>
  See how much of each plan you've used and which running session is using it, replay every turn, and spot the sessions that went sideways — all from data already on your disk.
</p>

<h3 align="center"><a href="#install"><ins>Install for Claude Code or Codex</ins></a></h3>

<p align="center">
  <img src="./docs/readme/hero.png" alt="The Marey dashboard, with a Claude Code terminal in front showing the context and prompt-cache segment Marey adds to the status line (synthetic demo data)" width="960" />
</p>

Marey reads the session data Claude Code already writes under `~/.claude/` (Codex under `~/.codex/`, Copilot CLI under `~/.copilot/`) and turns it into a local dashboard. The data is already there. Nothing visualizes it. This does.

## Features

**Now: your plans and your running sessions.** The home page answers two questions. *How much of each plan have I used?* One card per provider: Claude Code's and Codex's 5-hour and weekly windows, Copilot CLI's monthly quota of AI credits, each with its reset time and a tick for the time elapsed (a fill past it runs faster than time). *Which session is using it?* Every bar is split by running session, in the colors of the sessions board below, where each running session shows what it needs from you (a question, a permission, your turn) and its share of the limit. Codex and Copilot CLI log their limits in their own session files, so they show up with no setup; Claude Code's need [`/marey:limits`](#as-a-claude-code-plugin).

<table>
<tr>
<td width="40%" valign="middle">

### Session Replay

Turn-by-turn view of prompts, tool calls and file diffs (versioned via `~/.claude/file-history/`), with quality signals and a friction breakdown. Export any session as a self-contained HTML snapshot.

</td>
<td width="60%">
  <img src="./docs/readme/replay.gif" alt="Replaying a session: overview, tool call sequence and token breakdown" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Timeline

Context fill, cumulative API value and tokens per turn, with compactions, prompts and failed tool calls marked. Hover any turn for its numbers, or click a prompt marker to see the tool calls it triggered.

</td>
<td width="60%">
  <img src="./docs/readme/timeline.gif" alt="Session timeline with context fill, API value and tokens per turn, and a compaction marker" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Live View

Running sessions show up in real time with the current tool, context fill and prompt-cache countdown, plus a *keep going / compact / clear* verdict and its reasons. On macOS, *Open terminal* brings the session's terminal to the front: the exact window, tab and split in Ghostty, the app itself elsewhere.

</td>
<td width="60%">
  <img src="./docs/readme/live.gif" alt="A live session updating in real time with its running tool and context verdict" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Fleet Dashboard

Usage and health across all your projects: what is using the current 5-hour window (by project, session and prompt), tokens over time, project league, model mix, tools heatmap, health checks and anomaly flags.

</td>
<td width="60%">
  <img src="./docs/readme/fleet.gif" alt="Fleet dashboard cycling through rankings, health checks and analysis" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Filter &amp; Compare

Filter by live / ghost / friction / low-outcome / low-quality or by project, navigate with `j`/`k`, and put up to three sessions side by side with min/max highlighting.

</td>
<td width="60%">
  <img src="./docs/readme/compare.gif" alt="Filtering sessions with friction and comparing three of them side by side" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Ghost Cleanup

Empty sessions and sessions whose Claude Code process died are flagged. Get the resume command, reveal the transcript, or delete it permanently.

</td>
<td width="60%">
  <img src="./docs/readme/ghost.gif" alt="Inspecting a crashed ghost session and its cleanup actions" width="100%" />
</td>
</tr>
</table>

**Codex and Copilot CLI sessions** show up next to Claude Code ones, tagged `codex` or `copilot`, with their tokens, pricing, prompts, tool calls and timeline; Copilot CLI sessions also show the AI credits they used. The provider switcher beside the logo shows the detected providers: choose **All providers** or one of them. The selection is remembered and applies to every page.

<p align="center"><sub>All screenshots use synthetic data from <code>pnpm seed:demo</code>.</sub></p>

---

## Install

### As a Claude Code plugin

**1. Add the plugin.** In Claude Code:

```
/plugin marketplace add n-pizzetta/marey
/plugin install marey@marey
```

**2. Open the dashboard.** `/marey:replay` parses `~/.claude` and opens `localhost:3333`.

**3. Connect your limits** *(recommended)*. `/marey:limits` turns on the real 5h and 7-day limits and the context advice; `/marey:limits --uninstall` undoes it.

Needs Node 20+ on your `PATH`.

<details>
<summary>What <code>/marey:limits</code> changes</summary>

Claude Code only exposes your 5-hour and 7-day usage limits (the numbers behind `/usage`) to the status line, so the command installs a small wrapper that records them for the dashboard:

- Your existing status line keeps rendering unchanged, and `settings.json` is backed up first.
- It also records each live session's context fill and prompt-cache warmth, which power the *keep going / compact / clear* verdict in the session view.
- A short `ctx ━━━───── 33% │ cache warm 59m` segment is appended to your status line, colored green / yellow / red by level. Hide it with `"verdict": false` in `~/.claude/marey/statusline.json`.
- `statusLine.refreshInterval` is set to 30 seconds (unless you already set one) so the cache countdown keeps moving while the session is idle.

If Codex or Copilot CLI is installed, the same command turns on the limits in their own status lines, which they can show but don't by default:

- Codex: `context-used`, `five-hour-limit` and `weekly-limit` are added to `[tui] status_line` in `~/.codex/config.toml` (backed up first), after the model: `GPT-6-Astra high · Context 12% used · 5h 42% left · weekly 76% left · ~/project`. Codex doesn't expose its prompt cache, so there is no cache countdown there.
- Copilot CLI: `footer.showQuota` is turned on, so the footer shows `Plan: 370/5,000 (7% used)`.

New sessions of either CLI pick it up. `--uninstall` puts both back as they were, unless you changed them since. A plugin update refreshes the Claude Code wrapper on its own, but not these settings: run `/marey:limits` again to get what a new version adds here.

Without it, the dashboard still shows tokens and cost for an inferred 5h window, just not Claude's limit percentages. Codex's and Copilot CLI's limits don't need it: the dashboard reads them from their session files.

</details>

The plugin also registers a `PostToolUse` hook that records fine-grained tool sequences to `~/.claude/marey/cache/{sessionId}.jsonl`, so sessions can be replayed call by call.

### Updating in Claude Code

When a new version is out, Marey tells you as a session starts (*Marey 0.6.0 is available (you have 0.5.2) · run /marey:update*), in its status line segment and in the dashboard header. `/marey:update` refreshes the marketplace and updates the plugin; then run `/reload-plugins` and `/marey:replay`.

You can also let Claude Code do it: turn on auto-update once in `/plugin` → **Marketplaces** → `marey` → **Enable auto-update** (it's off by default for marketplaces outside Anthropic's). Claude Code then fetches new versions shortly after you start a session and tells you to run `/reload-plugins`. Without auto-update: `/plugin` → **Installed** → `marey` → **Update now** (or `claude plugin update marey@marey`), then `/reload-plugins`.

Then run `/marey:replay`. If the dashboard from the previous version is still running, it is stopped and the new one takes its place, and the status line wrapper installed by `/marey:limits` is refreshed on the way: nothing to restart or re-install by hand.

### Upgrading from ccblackbox

Marey was called ccblackbox. The plugin id changed, so Claude Code won't update it by itself: remove the old plugin and add the new one.

```
/plugin uninstall ccblackbox@ccblackbox
/plugin marketplace remove ccblackbox
/plugin marketplace add n-pizzetta/marey
/plugin install marey@marey
/marey:limits
```

Your data moves on its own: the first run moves `~/.claude/ccblackbox/` (limits history, tool cache, model overrides) to `~/.claude/marey/` and leaves a link at the old path, so nothing breaks in between. `/marey:limits` points your status line at the new folder; your previous status line is kept. Dashboard settings saved in the browser carry over too.

### As a Codex plugin

Needs Node 20+ on your `PATH` and a Codex client with plugin support.

**1. Add the marketplace and install Marey.** In Codex's plugin management UI, add `https://github.com/n-pizzetta/marey.git`, then install and enable `marey@marey`. With a CLI that supports `codex plugin add`, you can also run:

```sh
codex plugin marketplace add https://github.com/n-pizzetta/marey.git
codex plugin add marey@marey
```

**2. Open the dashboard.** In Codex CLI or the IDE extension, open `/skills` or type `$` and select **Marey → replay** (namespaced as `marey:replay`). You can also ask “Open the Marey dashboard.” The launcher opens `http://localhost:3333`; request `--port 4444` for another port or `--no-open` to get the link without opening a browser. It reads both `~/.claude/` and `~/.codex/` (or their configured locations).

Codex uses skills rather than Claude Code's `/marey:replay` slash command. If an older install only shows `source-command-update`, update the plugin and restart Codex/start a fresh session to reload the skills.

Some clients also list the imported `source-command-update` alias alongside the native skills; it redirects to Codex's `update` skill.

**3. Update in Codex.** Select **Marey → update**, or run `codex plugin marketplace upgrade marey` followed by `codex plugin add marey@marey` on clients supporting those commands. Otherwise use Codex's plugin management UI to refresh/update Marey. Reload the session, then invoke **replay** again to replace an older running dashboard.

The status-line wrapper, `/marey:limits`, and capture hooks are **Claude Code-only**. The Codex plugin exposes the dashboard and update skills. Running `/marey:limits` in Claude Code also turns on the 5h and weekly limits in Codex's own status line (see [As a Claude Code plugin](#as-a-claude-code-plugin)). Marey's local dashboard state still lives in `~/.claude/marey/`, even when launched from Codex.

See OpenAI's [plugin packaging](https://developers.openai.com/plugins/build/plugins) and [skill invocation](https://learn.chatgpt.com/docs/build-skills) documentation for client support and discovery.

### From source

Requires Node 20+ and pnpm.

```sh
git clone https://github.com/n-pizzetta/marey && cd marey
pnpm install
pnpm serve                            # parse ~/.claude/, serve on :3333 and open the browser
node scripts/serve.mjs --help         # --port, --no-open
node scripts/install-statusline.mjs   # optional: real usage limits (see above)
```

---

## Privacy

**Everything runs locally, with no telemetry.** The one network request: once a day, Marey reads the version number in its own `plugin.json` on GitHub (`raw.githubusercontent.com`) to tell you when an update is out. Nothing about you or your sessions is sent. Turn it off with `{"updateCheck": false}` in `~/.claude/marey/config.json`; it is also off when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

Marey reads (from `~/.claude`, or `$CLAUDE_CONFIG_DIR` when set):

| Data | Source |
| --- | --- |
| Prompts and assistant outputs | `~/.claude/projects/*/*.jsonl`, `~/.claude/history.jsonl` |
| Session metadata, tool counts, tokens, cost | `~/.claude/usage-data/` |
| Versioned snapshots of files edited via Claude Code | `~/.claude/file-history/` |
| Live session state | `~/.claude/sessions/` |
| Codex rollouts and thread names (or under `$CODEX_HOME` when set) | `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session_index.jsonl` |
| Copilot CLI sessions, open sessions and the monthly quota (or under `$COPILOT_HOME` when set) | `~/.copilot/session-state/*/events.jsonl` and `workspace.yaml`, `~/.copilot/open-sessions-state.json` |

The server only listens on `127.0.0.1` and refuses state-changing requests from other websites. The optional `pnpm parse` dump is written to `~/.claude/marey/sessions.json`, never inside the repo.

## Pricing

Costs are estimates at Anthropic's and OpenAI's public API rates (no batch or negotiated discounts; on a Pro/Max plan they are an API-equivalent value, not what you pay). Copilot CLI sessions are priced the same way, plus the AI credits Copilot CLI logged for each request, which is what its monthly quota counts. The table lives in [`scripts/models.mjs`](./scripts/models.mjs) and every turn is priced with its own model.

A model missing from the table still gets a readable name and is priced like the latest model of its family. Costs that include it are marked `~` in the dashboard. To fix one without waiting for a release, add it to `~/.claude/marey/models.json` (prices in USD per million tokens; picked up on the next refresh):

```json
{
  "claude-opus-6": { "label": "Opus 6", "in": 6, "out": 30, "cacheRead": 0.6 }
}
```

Cache writes are derived from `in` (1.25x for the 5-minute TTL, 2x for 1 hour). Entries override built-in rows with the same id.

---

## Developing

```sh
pnpm dev          # Vite dev server with live re-parse on ~/.claude changes
pnpm lint         # ESLint
pnpm typecheck    # tsc
pnpm build        # typecheck + build → dist/ (committed: the plugin ships it prebuilt)
pnpm test         # node --test (parsers, limits, installers)
pnpm parse        # one-shot dump of every session to ~/.claude/marey/sessions.json
```

The dev server and `scripts/serve.mjs` mount the same API (`scripts/api.mjs`): it runs the parser in-process, keeps sessions in memory and re-parses when `~/.claude/` changes (unchanged transcripts are cached). The front-end fetches a lightweight list (`/api/sessions`) and loads each session's detail on demand (`/api/sessions/:id`). If the API is unreachable, it falls back to built-in demo data.

```
~/.claude/{projects, sessions, usage-data, file-history, history.jsonl}, ~/.codex, ~/.copilot
                  │
                  ▼
     scripts/parse-sessions.mjs      transcripts → sessions (+ codex.mjs, copilot.mjs, models.mjs pricing)
                  │
                  ▼
     scripts/api.mjs                 in-memory cache, re-parse on change, /api/*
     (mounted by scripts/serve.mjs and by vite.config.ts in dev)
                  │
                  ▼ fetch
   React 19 SPA (hash routing)
   ├─ Now: PlanCard per provider, SessionBoard
   ├─ Sessions: SessionList / SessionFilters / SessionCompare
   ├─ Usage and Health (src/components/fleet/)
   └─ SessionDetail (Overview / Timeline / Tools / Tokens / Files)
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the parser internals, component map and build pipeline.

**Stack:** React 19, TypeScript, Vite, `diff`, bundled Inter Tight / JetBrains Mono fonts. The server uses Node built-ins only.

### Known limitations

- Cold start re-parses every session (a few seconds with several hundred sessions).
- Live-session detection uses `ps`, so on Windows running sessions show as crashed. Windows is otherwise untested.
- *Open terminal* is macOS only. It picks the exact tab in Ghostty 1.3+ only, and not inside tmux, zellij or screen.
- Test coverage is thin: only the parser has tests (`pnpm test`).
- Codex and Copilot CLI sessions have no context-quality score, ghost detection, file-history diffs or `/insights` outcome (Claude Code only), and are kept out of the Claude-specific health rules and recommendations.
- A session's share of a limit is an estimate: the providers report the % used per account, not per session. Marey splits it by each session's API value in the window (AI credits for Copilot CLI). Codex's and Copilot CLI's limits are as fresh as the last request made with them on this machine.

---

## Community &amp; Support

- **Feedback &amp; ideas:** missing something? [Open an issue](https://github.com/n-pizzetta/marey/issues).
- **Contributing:** pull requests are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the synthetic demo data (`pnpm seed:demo`) and the privacy rules.
- **Security:** see [`SECURITY.md`](./SECURITY.md) to report a vulnerability.
- **Release notes &amp; roadmap:** [`CHANGELOG.md`](./CHANGELOG.md).
- **Show support:** [star the repo](https://github.com/n-pizzetta/marey) to follow along.

## License

Marey is free and open source under the [MIT License](./LICENSE).
