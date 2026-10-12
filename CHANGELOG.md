# Changelog

All notable changes to Marey (formerly ccblackbox) are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely;
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Recommendations backed by your own sessions, at the top of Now and Health: recurring setup errors (unmatched zsh globs, a shared Playwright browser, sandbox writes…), denied actions with narrow allow rules for the safe ones, and sessions left waiting on you, each in plain words with the sessions behind it, a line to copy and a prompt to paste into Claude Code. Marey never applies a fix itself.
- A global provider switcher lists detected Claude Code and Codex sessions, remembers the selection, and scopes every page. Claude limits and badges are labelled explicitly and hidden in Codex views, which show today's Codex activity instead.

### Fixed

- Codex installations now expose native `replay` and `update` skills through an explicit plugin manifest. The dashboard launcher resolves bundled scripts from the installed package, and updates use Codex's plugin manager.
- `/marey:replay` no longer prints `no matches found: …/marey-*.log` under zsh: old logs are cleared with `find` instead of a shell glob.

### Planned

- Front-end: split `SessionDetail.tsx` (66 KB → 4 sub-components per tab).
- Sub-Agent Tree component.
- Cross-Session Patterns component.
- Delta vs `~/.claude/usage-data/report.html` view.
- Tests: parser unit tests around `mapFrictions`, `linkClearedChains`,
  `reassignLiveToChainTail`, plugin-cache merge.
- CI: `.github/workflows/ci.yml` (lint + typecheck + build matrix
  macOS/Linux).
- Per-session disk cache (`~/.claude/marey/cache/parsed/{id}.json`)
  with mtime invalidation, so cold start doesn't re-parse the full set.

## [0.7.0] — 2026-10-06

### Changed

- The glass page navigation and session tabs are lit by a soft glint in the middle of their top edge instead of a white rim, and the selected tab by an even ring.
- **Session view header.** Calmer and shorter. The outcome, quality and project chips become one dim meta line over the title (*● project · model · date · Outcome in progress · Quality B 84.7*, colour on the values only; their explanations open under the title instead of over it). The summary leaves its Overview card for a dim two-line subtitle under the title, with "more" for the rest, and is skipped when it only repeats the title. The live status and context cards are gone: the context figures (*Context 7% · 67.5k / 1M · cache 57m*) and the verdict pill, whose reasons open from it, sit on the title's first line next to *Open terminal*, and the live state (running tool or idle, prompt and turns) is left to the session table, the Now page and the Tools tab. The tabs are built like the page navigation (a line icon before each label, the friction count as a plain amber number) and follow the title closely: the content starts up to about 190 px higher on a live session.
- The session view uses the same width and side gutter as the other pages instead of a narrower centred column, so its edges line up with the app header.
- **Tools tab.** The calls in order fill the main column, and a *By tool* card beside them counts the calls per tool, like the Overview's sidebar, instead of a Sequence / Summary toggle whose summary stretched across the whole width.
- The scope bar ends with the session count and the search field; the range and the filters stay on the left.
- **Session view structure.** Each tab answers one question, and each block has one home. *Overview* (how it went): four headline tiles that open their tab (active time and peak context, fresh tokens or API value, tool calls with failures and sub-agents), the Prompts chart without its Timeline / List toggle, frictions, and a summary of each other tab whose link lands on the right section. *Timeline* (what happened when): the chart, now with sub-agent calls and approximate friction markers, then the prompt list, which moved from the Overview. *Tools* (what Claude did): sub-agent calls nested under the Agent call that ran them, and a Failed view. *Tokens* (where the tokens and their API value went): By kind, and a new By prompt section that holds the per-prompt detail the Overview had. *Files* (what changed): the file versions, then the commits. "API value" is the only name for $, fresh or all tokens is always said, and "cacheR" / "cacheW" read "cache read" / "cache write".
- The demo data (`pnpm seed:demo`) runs a sub-agent from each Agent call and keeps a file history of the files it edits.

### Fixed

- `/marey:replay` opens the dashboard at once: the server takes the port before reading the sessions (a cold start could take 20 s, longer than the command waited), and the dashboard shows its loading screen until the first read is done. Each launch writes its own log, so a server being replaced can't garble it.
- On phones, the session view's close button is no longer pushed off screen by the usage limits: they move to a row of their own under the toolbar.
- The page navigation, the session tabs and the segmented toggles no longer show a focus ring after a mouse click followed by a key press; keyboard focus (Tab) still shows it.
- **Tool-call counts agree.** Sub-agent calls were counted in the tab, the headline tile and the By tool card, but missing from the list, the Timeline and the prompt badges (39 counted, 26 listed). The parser now nests each sub-agent's calls under the Agent call that ran it, matched by the agent id Claude Code writes in the call's result, else by its prompt, else by time, so every count is the same, the HTML export's list included.
- **One unit per figure.** A prompt shown in fresh tokens got its share of the session's API value (24.8k shown as 9.5% when it was 7.8% of the tokens); the share now follows the shown unit. The Overview's "Tokens" card, which drew API value shares under a token total, is now "API value by kind".

## [0.6.0] — 2026-10-06

### Added

- **Update notice.** When a newer Marey is published, a message says so as a session starts (*Marey 0.6.0 is available (you have 0.5.2) · run /marey:update*), the status line segment shows `↑ Marey 0.6.0 · /marey:update`, and the dashboard header shows `↑ 0.6.0`. `/marey:update` refreshes the marketplace and updates the plugin. The check reads the version in the repo's `plugin.json` on GitHub at most once a day, sends nothing else, and is off with `{"updateCheck": false}` in `~/.claude/marey/config.json` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. It is Marey's only network request.
- **Open a running session's terminal** (macOS). *Open terminal* in the session view, and a `›_` chip on live rows in the table and on the Now page, bring the terminal running that session to the front. In Ghostty 1.3+ it focuses the exact window, tab and split, matched on the session title Claude Code shows in the terminal title, with a short-lived title marker on the session's tty when titles don't tell terminals apart. Other terminal apps are brought to the front as a whole. New route: `POST /api/sessions/:id/focus` (#65).

## [0.5.1] — 2026-10-05

### Fixed

- **Updating needs no manual restart.** After a plugin update, `/marey:replay` used to reopen the dashboard from the previous version still running on the port. It now stops an older Marey (or ccblackbox) server and starts the new one, and refreshes the status line wrapper copied by `/marey:limits`, so re-running `/marey:limits` after an update is no longer needed. The server reports its version at `/api/version`.

## [0.5.0] — 2026-10-05

### Added

- Icons next to the page tabs (Now, Sessions, Usage, Health, Progress); the active one takes the accent colour.

### Changed

- **Progress: click a badge to bring it forward.** The hover card is gone: hovering still tilts the card and moves its foil, and a click (or Enter / Space) opens it large, floating on the dimmed page and still following the pointer and swaying on its own, beside one panel with everything about it: the current tier and finish, the tier ladder with each target and unlock date, progress toward the next tier, how to earn it and whether it adds XP. Locked badges open too. Escape, the close button or a click outside closes it; ← / → or the arrows under the card move between badges. On a phone the card floats above the panel; with reduced motion it stays still.
- **Now: the 5h window panel reads in order**: the limit used, when it resets and the window's API value as three tiles, then *What's using it*: one bar split by project (filled to the used %, so the full bar is the limit) and the five heaviest sessions and prompts, each with its share of the window and its API value. The #1 card, the prompt / project / tool cards, the Elapsed tile and the Tools list are gone (tools stay on the Usage page). Shares are always of the window's API value, whether or not the limits are connected. While the window is idle the same card shows today's biggest consumers.
- **Progress: the Records podium loses its fire.** The #1 card now stands out with a thin gold glint that runs around its frame every few seconds, then rests (CSS only, run by the compositor; with reduced motion it is a still gold edge). #2 and #3 are unchanged.

### Fixed

- The Progress tab's count of new badges no longer shows a box behind the number.
- The header no longer lets the page tabs cover the 5h / 7d limits on narrower windows.
- Badge cards' shadow follows their rounded corners: the radius was sized from the window instead of the card.
- **Now: the 5h window panel no longer jumps or swaps its top session every few seconds.** Every running Claude Code session's status line overwrote the limits with its own last-known ones (an idle session holds a lower %, a window that reset days ago, or none), so the panel flipped between the real window and an inferred one, changed its ranking unit and resized. The server now keeps the freshest limits (later reset, then higher %), which also steadies the header gauge and the burn-spike banner. The ranking no longer depends on the limits, ties break on the id, and a session only overtakes another by more than 1% of the window.

## [0.4.0] — 2026-10-05

### Changed

- **Renamed to Marey.** The plugin is `marey@marey` and its commands are `/marey:replay` and `/marey:limits`; the repository is `n-pizzetta/marey`. Data moves from `~/.claude/ccblackbox/` to `~/.claude/marey/` on first run, with a link left at the old path so an installed status line keeps working; re-run `/marey:limits` to point it at the new folder. Browser settings carry over. See *Upgrading from ccblackbox* in the README.
- **Glass design**: a graphite palette and one glass element per view (the page navigation, or the tabs in the session view); everything else is flat or sits in one opaque card. The scope bar and header widgets are flat, headline figures share one card, table rows are rounded, numbers use the UI face with neutral amounts, and session panels get segmented toggles, neutral bars and quieter banners. The session view has a flat toolbar and a primary resume button.
- **Next up** shows a mini card of the next tier instead of a glyph; the tier colour now lives only on that card.
- **Badge cards**: each badge is a foil collector card whose finish is the tier (matte bronze, silver and gold sheen, holographic platinum that follows the pointer), with a line-art glyph in place of the emoji. Every tier has its own name and glyph that grows with it (Marathon: 5K, 10K, Half marathon, then Marathon, from jog to finish tape). Locked badges are face down. Progress, targets and unlock dates moved from the card to its hover card.

## [0.3.0] — 2026-10-05

### Added

- **Pages**: the dashboard is split into **Now** (5h window, live burn, live or latest sessions), **Sessions** (full-width sortable table, compare beside it), **Usage** (tokens over time, projects, models, tools, heaviest prompts) and **Health** (checklist, anomalies), switched from the header or with keys 1–4. Badges move to a page reached from the profile menu.
- **Scope bar**: range, project, status and search in one place, with the resulting count and a reset. Only Sessions, Usage and Health follow it; Now and Badges say they ignore it.
- Session **Timeline** tab: context fill, cumulative API value and fresh tokens per turn over time, with compactions, prompts and failed tool calls marked. It loads when you open a session, for review after the fact.
- Demo data (`pnpm seed:demo`) now includes compactions and failed tool calls.
- **Codex support**: sessions from the Codex CLI and IDE extension (`~/.codex/sessions/`, `$CODEX_HOME`) are parsed next to Claude Code ones: tokens (cached input apart), GPT pricing (GPT-6 and GPT-5.6 families, GPT-5.5, GPT-5.4), prompts, commands, patches, MCP calls and failures, code-mode scripts (including commands that outlive their script), sub-agents merged into their parent, thread names, the timeline against the reported context window, and `codex resume` in the session view. Rows are tagged `codex`; a Claude Code / Codex filter shows when both are present. Codex sessions stay out of Claude's 5h window, badges and Claude-specific health rules. `pnpm seed:demo` also writes `.demo-codex/`.
- **Progress** tab (key 5, was the profile menu's Badges page) with a count of unlocks you haven't seen.
- Achievement toasts when a badge unlocks or you level up, wherever you are in the dashboard.
- **Next up**: the badges closest to unlocking, limited to ones that reward good practice, on the Now page and the Progress page.
- Header chip: XP bar, "+N XP" when XP comes in, and a dimmed flame when today's streak is still to be earned.
- **Hot spots** on the Now page: the session eating most of the 5h window as a hero card, with the runners-up and the leading prompt, project and tool. It turns amber when one session takes half the window and red, with a warning, when one of three or more takes three quarters. While the window is idle it shows today's biggest consumers instead of an empty panel.

### Changed

- Logo and favicon: the red recording dot is gone, leaving the session trace.
- README: hero image, one animated demo per feature, and install via `/plugin`.
- The session list is a sortable table (status glyph with one dot per outcome, project, flags, usage, active time, start) with day headers; its order drives ↑ / ↓ in the session view. The help explains its glyphs.
- One headline-tile style (`KpiRow`) for the scope, the session view and the 5h window; the Tokens tab merges its bars, table and total into one Breakdown panel.
- One type scale (nine sizes, `--fs-xs` to `--fs-3xl`), sentence-case sans labels, mono only for values and code; about 260 CSS rules for removed markup are gone.
- Session view: one line per tool call in fixed columns, one chip style in the header, tool and file counts on the tabs, Export as a labeled button.
- On phones the Sessions page scrolls as a whole, and the limits and the profile chip get their own header row.
- The level now comes from XP earned by how Claude Code sessions were run (commits, tests, lint, context score, good-practice badges) instead of tokens spent. XP is kept per session in `badges.json`, so the level no longer drops when old transcripts are cleaned up or a session crashes. Level titles no longer borrow job titles.
- Context hygiene only counts ended sessions.
- Toasts stay while hovered, focused or in a background tab.
- The header streak follows the badge rule: a quiet weekend no longer resets it.
- The Now page's Projects card uses each project's color from the session list instead of a color by rank (a clash in the card takes the next free color).
- The Now page's session and project lists are ranked by what their % shows (API value when limits are connected).

### Fixed

- The Now page's Top prompts counted the whole cost of a prompt that started before the 5h window; only its turns inside the window count now.

## [0.2.0] — 2026-10-02

### Security

- The server now listens on `127.0.0.1` only (it was reachable from the local
  network), rejects foreign `Host` headers (DNS rebinding) and cross-site
  state-changing requests (CSRF), in production and in the Vite dev server.
- Delete endpoints only accept sessions classified as ghosts.
- `pnpm parse` writes its dump to `~/.claude/ccblackbox/sessions.json`
  instead of `public/` (the build copied it into `dist/`, so it would have
  been published to npm); `dist/sessions.json` is excluded from the package.
- The capture hook writes owner-only files (0600) and validates the session id.
- Fonts are bundled instead of loaded from Google Fonts: the dashboard makes
  no network requests. The insights report is served with a CSP sandbox.

### Added

- Context and prompt-cache advice for live sessions: the status line wrapper
  records a sanitized per-session snapshot and appends a short
  `ctx ━━━───── 33% │ cache warm 59m` segment to the status line (values colored
  by level; the fallback line shows the 5h window and its reset, and the 7d
  window only from 80%); session rows show the context
  fill and a cache countdown, and the session view a keep going / compact /
  clear verdict with its reasons.
  The wrapper also keeps a small history of the 5h / 7d limits. Re-run
  `/ccblackbox:limits` to refresh an installed wrapper.
- Rankings tab with podium, badges, health / streak / level banner and project
  league; usage unit selector (fresh tokens or API value) in settings. The
  dashboard has two tabs (Rankings, Analysis): the current 5h window and a live
  burn line moved to Analysis, and the Live sessions block is gone (the session
  list shows live sessions with their context and cache state).
- Session view: panels on a darker page, headline tiles (time, tokens, messages,
  tools, files, commits, sub-agents), a two-column overview with previews of
  the Tools, Tokens and Files tabs, prompts in the chosen usage unit, and a
  "Copy resume command" button in the header.
- Sticky top bar with the usage limits, in-list filters with removable chips,
  day-grouped session cards. The sidebar is gone.
- `CLAUDE_CONFIG_DIR` support: parser, API, hook and status line read the
  Claude config dir from it when set, like Claude Code does.
- `pnpm seed:demo` (`scripts/seed-demo.mjs`) generates a synthetic Claude
  config dir for development and screenshots; the README screenshot uses it.
- `CONTRIBUTING.md`.
- Real usage limits: `/ccblackbox:limits` installs a status line wrapper
  that records Claude Code's `rate_limits` (5h and 7-day `used_percentage`,
  `resets_at`) to `~/.claude/ccblackbox/limits.json` and keeps rendering the
  user's previous status line. The dashboard shows both limits, anchors
  the 5h window exactly on `resets_at` and runs spike detection on the
  real %. New `/api/limits` endpoint.
- Pricing overrides: `~/.claude/ccblackbox/models.json` adds or corrects
  model prices locally. Costs that include a model missing from the table
  are marked `~` with a tooltip (header, model mix, session detail,
  compare).
- A Settings button in the sidebar (with the current 5h limit as a hint)
  replaces the fake profile block, which showed a hardcoded name and email.
- Logo and favicon.

### Fixed

- The status line cache countdown no longer freezes while a session is idle:
  `/ccblackbox:limits` sets `statusLine.refreshInterval` to 30 seconds (an
  existing value is kept). Re-run it to apply to an installed wrapper.
- Dev and production servers share one API module (`scripts/api.mjs`): the
  insights report and `/api/report-status` now work under `pnpm dev`, and
  "reveal in file manager" works on Linux and Windows.
- Status line: if the chained status line fails or prints nothing, the
  wrapper shows its own line instead of a blank one. The installer refuses a
  non-object `settings.json`, writes atomically, and `--uninstall` always
  cleans up its files.
- Range totals (header, model mix, project rollup, top sessions) only count
  the turns inside the selected range, per model; "Today" used to include
  the whole cost of any session touched today.
- Price ratios in tooltips are computed from the session's model (cache read
  is 0.05x input on Opus 5.5, not 10%); stale advice (Glob/Grep, "caveman
  mode") removed; help overlay shortcuts match the code.
- Session compare shows files edited; the tools chart shares are of all
  calls; long tool names (MCP servers) are truncated with a tooltip.
- /insights friction kinds (tool_failure, user_rejected_action,
  misunderstood_request…) map to the right category.
- Deleting a ghost also removes its sub-agent transcripts and capture file.
- An empty ~/.claude shows an empty dashboard instead of demo data; demo data
  is dated relative to now and priced from the model table.
- `/ccblackbox:replay` starts the server in the background and forwards its
  arguments.
- Tokens and costs were counted about 2x: Claude Code writes one transcript
  line per content block, each repeating the message's usage. Lines are now
  merged per API message (last usage wins).
- Sub-agent transcripts (`<session>/subagents/*.jsonl`) are now read: their
  tokens, cost and tool calls were missing (up to 3x the main thread).
- Transcripts are looked up by session id: the cwd-based path missed projects
  whose path contains `.` or `_` (their sessions showed a fraction of their
  real cost), and worktree sessions.
- Numbers (tokens, cost, durations, counts, timeline) now always come from the
  transcript. `/insights` session-meta is a snapshot written in batch, so it
  only enriches goal, summary, outcome and frictions.
- Every tool is counted (MCP tools grouped per server, Task*, Skill,
  WebSearch, AskUserQuestion…); ~15% of tool calls were dropped.
- Durations are active time (idle gaps over 5 min excluded); wall-clock is
  kept as `wallMs`. Timelines use real timestamps instead of evenly spread
  placeholders; commits come from `git commit` calls in the transcript.
- Sessions without a facet show outcome "unknown" instead of
  "partially_achieved"; commands, interrupts and compaction summaries no
  longer count as user prompts.
- "Ghost" now means an empty session or one whose Claude Code process died.
  Sessions `/insights` hadn't analyzed were all shown as ghosts.
- 1h cache writes are priced at 2x input in the cost breakdowns.
- Re-parsing: unchanged transcripts are cached (a full pass is ~0.4 s instead
  of ~3.4 s), re-parses are throttled to one per 5 s, and `/api/sessions`
  answers 304 via an ETag when nothing changed (it resent ~15 MB every 5 s).
- The capture hook kept every tool call waiting ~1.5 s (an un-cleared stdin
  timeout); it now exits in ~25 ms. Bash output previews are captured.
- The parser no longer moves Claude Code's own `~/.claude/sessions` pid files
  into `.stale/`; dead sessions are classified in memory.
- Server: a clear message instead of a crash when the port is taken; invalid
  `--port` values are rejected.

- Models and costs: only Opus 4.7 / Sonnet 4.6 / Haiku 4.5 were known, and
  every other model (Opus 5.5, Fable 5.x, Sonnet 5.x, Opus 4.8…) was shown as
  "opus-4.7" and priced at a stale $15/$75 per MTok, inflating costs roughly
  4x. Model ids are now normalized generically (`claude-opus-5-5[1m]` →
  `opus-5.5`, future ids included), priced from current public rates
  (per-model cache reads, 5m vs 1h cache writes), and priced per turn so
  sessions that switch models cost right. Pricing lives in one place:
  `scripts/models.mjs`, shared by the parser and the UI.

### Removed

- Dead code: `FrictionPanel`, `Heatmap`, the `StatsStrip` wrapper, and ~110
  CSS rules that matched nothing.
- `--export`: it always crashed, and an exported page had no data source.

### Changed

- Renamed from `claude-replay` to `ccblackbox` (the former name is taken on
  npm). The plugin cache moved from `~/.claude/claude-replay/cache/` to
  `~/.claude/ccblackbox/cache/`.
- The 5h budget setting (hand-picked USD cap, default "$165") and the manual
  window "calibrate" control are gone. They are replaced by the real usage
  limits Claude Code reports to the status line.
- Fixed all ESLint errors (React hooks purity / set-state-in-effect rules,
  typed Vite dev middleware).

## [0.1.0] — 2026-04-28

First version. Pre-release, not yet published to GitHub.

### Added

- Initial Vite + React 19 + TypeScript 6 dashboard with:
  - Session list (virtualised, filterable, keyboard-navigable).
  - Session detail overlay (Turns / Artifacts / Quality / Frictions tabs).
  - Session compare view.
  - Fleet dashboard (13 analytics cards: live ticker, 5h burn, top
    sessions, token time series, model mix, project rollup, tools
    heatmap, anomaly flags, burn-spike banner / drill-down, etc.).
  - Activity heatmap, friction panel, budget editor, help overlay.
- `scripts/parse-sessions.mjs` (979 lines) parsing every session
  reachable from `~/.claude/`:
  - `usage-data/session-meta/*.json`, `usage-data/facets/*.json`
  - `sessions/*.json` (live PIDs, with liveness recheck)
  - `projects/{slug}/*.jsonl` (full transcripts)
  - `file-history/{id}/{hash}@v{n}` (versioned file snapshots)
  - `token-optimizer/quality-cache-*.json`
  - `history.jsonl`
  - `ccblackbox/cache/{id}.jsonl` (PostToolUse hook output)
- Cleared-chain linkage (sibling sessions sharing `cwd` + `customTitle`
  with sequential `mtime`) and live-tail reassignment.
- Ghost-session detection (empty / crashed / orphan) with Trash /
  `.stale/` quarantine.
- Vite dev middleware exposing `/api/ghost/*`, `/api/file-history/*`,
  `/api/parse-error/*` for in-dashboard cleanup.
- Mock data fallback (8 sessions) so the UI renders without
  `~/.claude/` populated.
- `LICENSE` (MIT), `README.md`, `ARCHITECTURE.md`.

### Plugin packaging

- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
  registering ccblackbox as a Claude Code plugin (validated with
  `claude plugin validate`).
- `commands/replay.md` — `/replay` slash command spawns the dashboard
  server and opens the browser.
- `hooks/hooks.json` + `hooks/capture.mjs` — `PostToolUse` and `Stop`
  hooks append per-tool entries to `~/.claude/ccblackbox/cache/{sessionId}.jsonl`.
- Parser merges those entries into `Session.toolSequence` (transcript
  entries take precedence on near-simultaneous duplicates within
  500 ms). Adds `Session.pluginCapture` metadata
  (`{ entries, lastEventAt, stoppedAt }`) and a cyan badge in
  `SessionList` when present.
- `scripts/serve.mjs` — production HTTP server (also the npm `bin`):
  - In-memory parsed cache, refreshed on `~/.claude/` change.
  - SPA fallback for `dist/`.
  - Migrated `/api/ghost/*`, `/api/file-history/*`,
    `/api/parse-error/*` from `vite.config.ts` so they work in
    production builds and from the plugin.
  - Flags: `--port`, `--no-open`, `--export <path>`.

### Refactored

- `scripts/parse-sessions.mjs` exports `parseAllSessions()` and
  `summarizeSession()`; runs as CLI only when invoked directly.
- `serve.mjs` and `vite.config.ts` both serve the same API:
  - `GET /api/sessions` → light summaries (~400 KB for 387 sessions,
    96% smaller than the previous monolith).
  - `GET /api/sessions/:id` → full Session detail.
- `src/data/loadSessions.ts` — `loadSessions()` hits `/api/sessions`;
  new `loadSessionDetail(id)` fetches full data on overlay open.
- `App.tsx` hydrates `SessionDetail` lazily: list-derived summary
  first, then merges full payload once the fetch resolves.

### Removed

- `public/sessions.json` and `dist/sessions.json` (10 MB monolith).
  No longer the data path; gitignored.
- `pnpm parse` from `pnpm build` (parser only runs at server startup
  or on demand now).

### Privacy

- `public/sessions.json` and `dist/sessions.json` ignored from day one.
- Plugin install via local `directory` source intentionally pulls the
  working tree (including untracked files) — published `github` source
  installs respect gitignore.
