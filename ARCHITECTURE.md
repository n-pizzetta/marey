# Architecture

Marey is a local dashboard for Claude Code and Codex sessions, packaged for npm (`npx marey`), Claude Code (`/marey:replay`) and Codex (the `marey:replay` skill). A Node server parses the files Claude Code already writes under `~/.claude/` (and Codex under `~/.codex/`, §3), keeps the result in memory and serves it to a React single-page app over a small local API.

There is no database, no network access beyond loopback except the daily update check (`scripts/update-check.mjs`), and no runtime dependency besides Node's standard library on the server side.

---

## 1. Overview

```
 ~/.claude/  (written by Claude Code)            ~/.claude/marey/  (written by Marey)
 ├── projects/<slug>/<id>.jsonl                  ├── cache/<id>.jsonl      ◀── hooks/capture.mjs
 ├── projects/<slug>/<id>/subagents/*.jsonl      ├── limits.json           ◀── statusline.mjs
 ├── sessions/<pid>.json                         ├── models.json           (user, optional)
 ├── usage-data/session-meta/<id>.json           ├── statusline.mjs/.json  ◀── install-statusline.mjs
 ├── usage-data/facets/<id>.json                 ├── badges.json           ◀── api.mjs
 │                                               └── sessions.json         ◀── `pnpm parse` only
 ├── usage-data/report.html
 ├── file-history/<id>/<hash>@v<n>
 ├── history.jsonl
                    │
                    ▼
      scripts/parse-sessions.mjs  ── parseAllSessions() / summarizeSession()
      scripts/codex.mjs           ── ~/.codex/sessions/**/rollout-*.jsonl → same shape
      scripts/models.mjs          ── pricing table, shared with the UI
                    │
                    ▼
      scripts/api.mjs   in-memory cache, fs watchers + periodic refresh,
                        /api/* routes, /usage-report.html, request guards
          │                                   │
          ▼                                   ▼
   scripts/serve.mjs                   vite.config.ts (dev middleware)
   static dist/ + API on 127.0.0.1     same API + HMR push after each parse
          │                                   │
          └──────────────┬────────────────────┘
                         ▼
      src/data/loadSessions.ts  (list, ETag-revalidated) · loadSessionDetail(id)
      src/utils/rateLimits.ts   (/api/limits)
                         │
                         ▼
      src/App.tsx ─┬─ AppHeader · ScopeBar (+ SessionFilters) · StatsRow
                   ├─ pages/: Now · Sessions (SessionList, SessionCompare) · Usage · Health · Progress
                   └─ SessionDetail overlay (Overview · Timeline · Tools · Tokens · Files)
```

---

## 2. Data sources

All paths are relative to the Claude config dir: `~/.claude`, or `$CLAUDE_CONFIG_DIR` when set (as in Claude Code). `pnpm seed:demo` writes a synthetic one to `.demo-claude/`, plus a Codex home to `.demo-codex/`, for development (`CLAUDE_CONFIG_DIR="$PWD/.demo-claude" CODEX_HOME="$PWD/.demo-codex" pnpm dev`).

### Read (owned by Claude Code, never modified except where noted)

| Path under `~/.claude/` | Used for |
|---|---|
| `projects/<slug>/<id>.jsonl` | Primary source: every number (tokens, cost, turns, tools, prompts, timeline, durations, commits). |
| `projects/<slug>/<id>/subagents/agent-<agentId>.jsonl` | Sub-agent transcripts, merged into the parent session; their tool calls are nested under the Agent call that ran them. `agent-<agentId>.meta.json` (type, description) names the run. |
| `sessions/<pid>.json` | Which sessions are running (pid + sessionId + startedAt). |
| `sessions/.stale/<id>.json` | Legacy: files older dashboard versions moved there; treated as dead sessions. |
| `usage-data/session-meta/<id>.json`, `usage-data/facets/<id>.json` | Written by `/insights`. Used only for qualitative fields (goal, summary, outcome, satisfaction, frictions), and as a numeric fallback when the transcript is gone. |
| `usage-data/report.html` | The `/insights` report, proxied at `/usage-report.html`. |
| `file-history/<id>/<hash>@v<n>` | File snapshots for the Files tab and diffs. |
| `history.jsonl` | Fallback first prompt when neither transcript nor meta has one. |

Codex (`~/.codex`, or `$CODEX_HOME`), also read-only: `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, `archived_sessions/` and `session_index.jsonl` (thread names). See "Codex rollouts" in §3.

### Written

- Everything Marey writes by itself lives under `~/.claude/marey/` (`scripts/data-dir.mjs`). Before the rename it was `~/.claude/ccblackbox/`: the first call to `dataDir()` (API, parser, plugin hook, `/marey:limits`) moves that folder and leaves a symlink at the old path, so a status line wrapper or an older plugin still writing there lands in the same place:
  - `cache/<id>.jsonl`: one line per tool call / stop, appended by the plugin hook (mode `0600`).
  - `limits.json`: latest `rate_limits` payload, written atomically by the status line wrapper. `limits-history.jsonl`: one line per change of either window (`{t, five:{p,r}, seven:{p,r}}`, trimmed at 512 KB), kept to calibrate "% of window" later.
  - `badges.json`: `{ startedAt, unlocked, xp }`. `startedAt` is written on the API's first parse (first launch); `unlocked` maps `<family>:<tier>` to the unlock date; `xp` maps a session id to the best XP it earned. See §5.
  - `live/<session_id>.json`: sanitized per-session snapshot (context size, prompt-cache state; no paths or prompts) written on every refresh; the API removes ones older than 3 days.
  - `statusline.mjs`, `context-advice.mjs`, `statusline.json`: installed wrapper, its shared helper, and the saved previous `statusLine` setting (plus `"verdict": false` to hide the terminal segment).
  - `sessions.json`: full parse dump, only when `pnpm parse` is run by hand. The app never reads it.
  - `models.json`: never written; the user creates it to override prices.
- `~/.claude/settings.json` is modified only by `install-statusline.mjs` (i.e. when the user runs `/marey:limits`), with a backup at `settings.json.marey.bak`. `--uninstall` restores the previous `statusLine`.
- Deletions and moves of Claude Code files happen only on explicit user action in the UI:
  - **Ghost delete** (single or bulk): unlinks `projects/<slug>/<id>.jsonl` and `sessions/.stale/<id>.json`, and only for sessions the parser currently classifies as ghosts.
  - **Trash a parse error**: moves an unparseable `usage-data/session-meta/<file>.json` to the macOS Trash (via Finder/`osascript`), or on other platforms to `usage-data/session-meta/.trash/`.
- `sessions/<pid>.json` files are never moved or deleted (see `classifyLiveFiles`).

---

## 3. Parser (`scripts/parse-sessions.mjs`)

Used as a library by `scripts/api.mjs`, and as a CLI (`pnpm parse`) that writes `~/.claude/marey/sessions.json`.

### Pipeline (`parseAllSessions`)

1. `loadModelOverrides()` reads `~/.claude/marey/models.json` and applies it via `setModelOverrides` (invalid file → warning, built-in table).
2. `classifyLiveFiles()` splits `sessions/*.json` into alive pid files and dead session ids. A pid is alive if `process.kill(pid, 0)` succeeds **and** `ps -p <pid> -o comm=` matches `claude`. Read-only. Ids in `sessions/.stale/` are added to the dead set.
3. `readHistoryBySession()` groups `history.jsonl` by session id.
4. `indexTranscripts()` maps every `projects/*/<id>.jsonl` by session id. Project directory names are lossy (`.`, `_`, `/` all become `-`), so lookups are by id only, never by reconstructed path.
5. `collectLive()` expands each alive pid file to its `/clear` chain (sibling transcripts in the same project dir with the same `custom-title`, modified later); only the newest in the chain is marked live.
6. Meta files are read; one without `session_id` or `start_time` is reported in `errors` (surfaced as a badge in the top bar with a Trash action).
7. `buildSession()` runs for the union of transcript ids, meta ids and live ids.
8. Codex rollouts (`indexCodexRollouts()`, see "Codex rollouts" below) are parsed, skipping ids already built from `~/.claude`. Sub-agent rollouts are merged into their root session (`codexRootOf`); every other rollout goes through the same `buildSession()` with `agent: "codex"`.
9. Post-passes: `linkClearedChains()` sets `clearedFrom` / `clearedInto` (same `cwd` + `customTitle`), `reassignLiveToChainTail()` moves the live flag to the chain tail, `markUnpriced()` lists models without a pricing row.

Sessions are returned sorted by `startedAt` descending. Helpers shared by both parsers (`countShellKinds`, `longestRun`, token sums) live in `scripts/transcript-utils.mjs`.

### Transcript parsing (`parseTranscriptFile`)

- Claude Code writes one line per content block (thinking / text / tool_use), each repeating the message id and the full `usage`. Lines are merged into one **turn per API message** (`message.id`, else `requestId`); the last line's `usage` wins. Summing lines would double-count.
- `<synthetic>` assistant messages are skipped. Each turn keeps its own normalized model, so sessions that switch models are priced per turn.
- Token fields per turn: `input`, `output`, `cacheRead`, `cacheWrite`, and the `cacheWrite5m` / `cacheWrite1h` split from `usage.cache_creation`.
- `tool_use` blocks are deduplicated by id. MCP tools are counted per server (`mcp__github__x` → `mcp:github`). `Agent` / `Task` calls produce `agent` timeline events; Bash commands matching `git commit` count as commits. Each Bash command is also split on `&& ; |` and newlines, and segment heads are classified into `shell: { prs, tests, lints, infra }` (`gh pr create`, test runners, lint / typecheck / build, docker / kubectl / terraform / gcloud…), counted once per command; `echo "npm test"` does not count.
- User lines: `tool_result` blocks attach a truncated result (text, bytes, `isError`) to their tool call, and an Agent / Task result's `toolUseResult.agentId` names the sub-agent it ran; `isMeta`, compact summaries and command / system-reminder / interruption lines are not counted as prompts.
- **Sub-agent calls** are nested (`children`) under the main-thread call that started the sub-agent (`scripts/subagent-calls.mjs`): matched by `agentId`, else by the sub-agent's first message (the call's prompt), else by time (the last free call before it started). A sub-agent no call matches gets a row of its own (`orphan`, not a call itself). Every call is then listed once, and the list, the tool counts and the Tools tab count add up.
- Active time sums gaps between events, capping each gap at 5 minutes (`IDLE_CAP_MS`); `wallMs` is wall-clock.
- `runningTool` is the last `tool_use` without a result (shown only for live sessions).
- **Incidents** (`incidents`, sub-agents included, absolute times): a failed call (`is_error`, its text with known noise stripped, e.g. zoxide's doctor message, and the noise ids), a denied action (`toolDenialKind` on the result line, with the reason Claude Code gave) and a wait on the user (`AskUserQuestion` / `ExitPlanMode`, call-to-result duration, the question or the plan's title). Capped at 500 per transcript, with `incidentStats.toolResults` beside them; kept out of the list payload. Read by §5's recommendations.
- Caps: prompt texts (first 100, truncated), tool sequence (first 300 entries per transcript, previews truncated), result previews.
- File paths from tool inputs are hashed (`sha256(path)` first 16 hex chars) to label `file-history` entries; unmatched hashes are shown without a path.

`readTranscriptFile` caches parsed results in `transcriptCache`, keyed by path and invalidated when `mtime` or `size` changes, so periodic re-parses only re-read transcripts that grew.

### Codex rollouts (`scripts/codex.mjs`)

`parseCodexRollout()` returns the same intermediate shape as `parseTranscriptFile`, so `buildSession` handles both. Formats seen from Codex 0.12x to 0.154 are supported:

- **Turns**: one per model response. Newer rollouts write a `token_usage_record` per response; older ones only `event_msg/token_count`, often repeated, so a count whose `total_token_usage` didn't change is skipped. OpenAI counts cached tokens inside `input_tokens` and reasoning inside `output_tokens`: `input` = `input_tokens − cached − cache writes`, `cacheRead` = `cached_input_tokens` (cache writes are assumed to be inside `input_tokens` too; they are 0 in every rollout seen so far). The model comes from the latest `turn_context`.
- **Prompts**: `event_msg/user_message` (older) or `item_completed` `UserMessage` items (newer). A prompt is only dropped as a duplicate when the same text arrives from the other kind within 5 s, so the same prompt sent twice still counts twice. The VS Code extension's IDE-context wrapper is cut at `## My request for Codex:`. Environment / instruction messages in `response_item` are not prompts.
- **Tools**: `function_call` / `custom_tool_call` / `local_shell_call` / `web_search_call` with their outputs. Errors: non-zero exit code (`exec_command_end`, `Process exited with code N`, patch metadata), failed patch, MCP error, and calls that never ran or were stopped (output starting with `exec_command failed for` or `aborted by user`). Shell commands are classified at call time, like Claude's (a denied `pytest` still counts as a test run).
- **MCP**: calls are regrouped as `mcp:<server>` from `mcp_tool_call_end` in the counts, the turn's tool list, the timeline and the tool sequence (as `mcp__<server>__<tool>`), whichever order the end event and the response's usage arrive in. Codex's own resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) keep their names: their `server` is the one they query.
- **Code mode** (models whose catalog entry is `code_mode_only`: GPT-6 and GPT-5.6): the model sends an `exec` script whose tool calls are logged as items (`CommandExecution`, `FileChange`, `Extension`, `ImageView`, `*Call` such as `CollabAgentToolCall`; messages and reasoning are items too and are ignored). They count as the tool calls, on the script's turn. A command still running when the script returns is listed in its output as `exec_command`'s yield result (`"wall_time_seconds":…,"session_id":N`, the pattern is anchored on that shape so data a script prints can't match); its item arrives later with that `process_id` and is attributed to the same script. The script itself counts (preview: its first line) when it ran nothing, or when the commands it left running never completed (interrupted turn, rollout cut). `McpToolCall` items are mapped to `mcp:<server>` from their `server` / `tool` fields, a shape assumed from the binary (none seen in a rollout yet).
- **Sub-agents**: a spawned agent writes its own rollout (`session_meta.thread_source: "subagent"`, `session_id` = root thread, `parent_thread_id`). It is merged into its root session like a Claude `subagents/` transcript (tokens, turns flagged `sidechain`, tool counts, its tool calls nested under the `spawn_agent` call, matched on the prompt or the time; no prompts) and counted in `subAgents`; `spawn_agent` produces an `agent` timeline event. A sub-agent whose parent rollout is missing stays a session of its own.
- **Files changed**: paths from `patch_apply_end`, patch headers and `FileChange` items. **Title**: `~/.codex/session_index.jsonl` (last entry per id; Codex 0.154 only writes names there), else `thread_name_updated` in the rollout. Used as the goal; not a `customTitle`, so no `/clear` chains.
- **Live**: a task started without `task_complete` / `turn_aborted`, a rollout written in the last 30 minutes, a running `codex` process and, when `lsof` is available (run asynchronously, only for those candidates), a codex process holding the rollout open (Codex keeps it open while a task runs). Without `lsof`, any running codex process (such as the IDE extension's server) is enough.
- **Not available**: context-quality score, ghosts (ghost actions only know `~/.claude/projects`), file-history snapshots, `/insights` fields, compaction counts. `contextWindow` comes from `model_context_window` and replaces the 200k / 1M guess in the Timeline tab.
- `codex resume <id>` replaces `claude --resume` in the session view.

## 4. Pricing and models (`scripts/models.mjs`)

A single table shared by the parser (Node) and the UI (imported by Vite; types in `scripts/models.d.mts`).

- `MODELS`: `label`, `in`, `out`, `cacheRead` in USD per million tokens (public API rates; Claude models for Claude Code, GPT models for Codex from `developers.openai.com/api/docs/models/<id>`, unknown `gpt-*` and `codex-*` ids falling back to `gpt-5.4`). OpenAI's long-context rate (prompts over 272k input tokens) and fast mode are not modelled: rollouts don't record a tier. Cache writes are derived: 1.25× input (5-minute TTL), 2× input (1-hour TTL).
- `normalizeModel()`: `claude-opus-5-5[1m]` → `opus-5.5`, date suffixes stripped, bare aliases (`opus`, `sonnet[1m]`) mapped to the family's latest model (`FAMILY_LATEST`), `<synthetic>` → `null`.
- `priceFor()`: unknown ids fall back to the family's latest price, then to `DEFAULT_MODEL`; `isKnownModel()` flags these as estimates (`unpricedModels` on the session, shown with a hint in the UI).
- `costOf()`: bills `cacheWrite1h` at the 1h rate and the remaining cache writes at the 5m rate.
- `setModelOverrides()`: rebuilds the table from the built-ins plus `~/.claude/marey/models.json` (keys raw or normalized; rows need numeric `in`, `out`, `cacheRead`; invalid rows skipped). The server sends the accepted overrides in `/api/sessions` (`models`), and `loadSessions()` applies them in the browser so UI-side costs match.
- `baselineCostUsd` (parser) is the same tokens priced without caching, used to show cache savings.

Costs are API-equivalent estimates; they are not what a subscription plan bills.

---

## 5. Usage limits and the 5-hour window

Claude Code exposes the real limits (`rate_limits.five_hour` / `seven_day`, as in `/usage`) only in the JSON it pipes to the status line command. Everything in this section is about Claude's limits: Codex sessions are left out of the 5h window, the burn tracker and the spike analysis (`FleetDashboard`). So:

1. `/marey:limits` runs [`scripts/install-statusline.mjs`](scripts/install-statusline.mjs): copies [`scripts/statusline.mjs`](scripts/statusline.mjs) to `~/.claude/marey/statusline.mjs` (stable path across plugin updates), saves the current `statusLine` to `statusline.json`, and points `settings.json` at the wrapper.
2. On every status line refresh the wrapper writes `limits.json`, then pipes the untouched payload to the user's previous status line command, or prints a minimal `model · 5h n% · 7d n%` line if there was none.
3. `/api/limits` serves `readLimits()` merged into what the server already holds (`mergeLimits`); [`src/utils/rateLimits.ts`](src/utils/rateLimits.ts) polls it every 5 s (`useRateLimits`). Every running session's status line overwrites `limits.json` with its own last-known limits, so an idle session writes a lower %, a window that has already reset, or no 5h window, every few seconds. The merge keeps, per window, the later reset and within a window the higher %, and never lets a reading without an open window replace one that is still open.

### Context and prompt-cache advice

The same payload carries `context_window` (size, % used, last-turn usage) and `prompt_cache` (`warm`, `ttl`, `expires_at`, hit ratio, misses, `recache_tokens_if_cold`). [`scripts/context-advice.mjs`](scripts/context-advice.mjs) (pure, shared by the wrapper and the dashboard like `models.mjs`) turns it into a snapshot (`toSnapshot`) and a verdict (`adviseContext`): *keep going*, *wrap up before pausing*, *compact at the next break*, *compact now*, or *clear if the task is done*, each with its reasons. Thresholds are heuristics (`THRESHOLDS`): context ≥ 70% / 85% of the window; a cold cache matters from 40% of the window or 100k tokens to re-cache; a warm cache is "expiring" under 10 min. A cold cache is the case where `/compact` is no cheaper than a normal message (it re-reads everything at full price), so `/clear` is advised.

The wrapper appends a short segment to the status line (`ctx ━━━───── 33% │ cache warm 59m`, colored by level, plus a hint when it matters). The dashboard polls `/api/live-context` once (`useLiveContext`, a shared store) and shows the result where the session is: a third line on session rows in the list (`ContextLine`: fill bar, cache countdown computed from `expires_at`, the verdict when it is not "keep going"; rows with it are taller, which the virtualized list accounts for) and figures in the session view's title row, right of the title and left of its primary action (`SessionContext` / `ContextSummary` in `ContextCard.tsx`: a small ring, used / window, cache countdown, and the verdict pill, which opens its reasons, the cold-start cost and the snapshot's age in a popover, also in its tooltip).

The 5h window in the UI (`fleet/FiveHourSession.tsx`, `utils/fleetStats.ts`):

- With real limits: window start = `resetsAt − 5h`; the used % is real. The start is also saved as the local anchor, so a moment without limits continues the same window.
- Without: the window is inferred locally. The first turn after the previous window expired anchors a new window, persisted in `localStorage` (`marey:window-start`, `utils/windowState.ts`), and the reset time is marked as estimated.
- Either way, shares are of the window's API value (`windowBreakdown`'s `weigh`; tokens only when nothing in it is priced), so the ranking never depends on whether the limits were read.
- `utils/burnTracker.ts` samples the real 5h % every 5 s (1 h buffer) and raises a spike banner when it climbs 4+ points within 5 minutes (critical at 10). It is inactive until limits are connected. `SpikeAnalysisOverlay` + `SpikeHeuristics` explain the spike from sessions, prompts and tools in that interval.

### Badges (`scripts/badges.mjs`)

Computed server-side after every parse (`updateBadges` in the API), because they need full sessions (`shell`, `timeline`, `turns`) that the list payload omits. `App` fetches `/api/badges` whenever the session list changes (`useBadges`) and hands it to the header, the Now page and the Progress page.

- **Only Claude Code sessions count**: Codex tools and models don't map onto the families (Editor, Researcher, model tourist…), and unlocks are permanent. The level's XP ignores Codex too, since it is banked for good and Codex sessions have no context score; only the current streak (below) is overall activity and counts every agent.
- **Only sessions started after the first launch count** (`badges.json` `startedAt`). History stays in every other view; badges start from zero so they feel earned and don't depend on how much transcript history Claude Code kept (`cleanupPeriodDays`).
- **Unlocks are permanent**: stored with their date, so they survive transcript cleanup and 30-day windows sliding past them.
- **Families**: one metric per family, tiers only raise the target, so a lower tier can never be harder than a higher one. Some families have 2 or 3 tiers; `oneshot` starts at gold.
- **Tier names and cards**: each tier has its own name (`tierNames`, sent as `name` on each tier: Marathon goes 5K, 10K, Half marathon, Marathon), while unlock keys stay `<family>:<tier>`. The Progress page shows one foil card per family (`Badges.tsx`, `badges.css`) with the best tier's name and glyph, or the first tier's face down while locked. The finish is the only tier signal on the card (matte bronze, silver and gold sheen, holographic platinum), and the glyph develops a little at each tier (`BadgeGlyph.tsx`, one drawing per tier on a 32 grid, the family's emoji as fallback). Hovering only tilts the card; a click (or Enter / Space) brings it forward in a focus view (`BadgeFocus`, a modal dialog): the card large and still live, floating on the dimmed page, and beside it one panel with its tier ladder with targets and unlock dates, progress toward the next tier, the hint and whether it adds XP. Arrow keys page through the badges.
- **Calibration**: per-session records (Marathon, Orchestrator, File surgeon, Toolbox, Juggler) by rarity across real sessions; cumulative counters by time for a heavy user: bronze on day 1, silver in 1–2 weeks, gold in ~3 months, platinum in ~1 year.
- **Continuous work**: Marathon, Juggler and Hours use stretches of main-thread activity (turns and prompts) where no pause exceeds 15 minutes (`RUN_GAP_MS`), not `durationMs`, which accumulates capped gaps over sessions left open for days. Hours counts the union of stretches, so parallel sessions count once.
- **Streak** skips quiet Saturdays and Sundays.
- **Next up**: families flagged `nudge` reward good practice (tests, lint, commits, PRs, plan mode, cache, context hygiene, outcomes). Only they are suggested as the next goal, the locked tier closest to its target (`nextUp` in `utils/gamify.ts`), and only they add XP. Volume and spend families (Orchestrator, Juggler, Veteran…) still unlock but are never pushed and earn no XP. Streak isn't flagged: its badge is the best run since the first launch, which would contradict the current streak shown next to it.
- **Context hygiene** only counts ended sessions: a live session scores high early and falls as its context grows.

### Level, XP and streak (also `scripts/badges.mjs`, in the `/api/badges` payload)

- **XP rewards how sessions were run, never spend.** Per session: 5+ main-thread turns +1, a commit +3, tests +2, lint / typecheck / build +2, context score 90+ +1, so 9 at most. On real history nearly every session reaches 5 turns and a score of 90, so shipping and checks are weighted to make most of the XP. A good-practice badge adds 5 / 15 / 40 / 100 for its first to fourth tier when it unlocks, whatever the tier's color: One-shot, which starts at gold, earns 5 then 15 (`xp` on each tier in the payload). Like badges, only Claude Code sessions earn it; unlike badges, every session counts, including ones from before the first launch, so a new user starts at a real level.
- **XP is banked**: `badges.json` `xp` keeps each session's best score, so the level never drops when Claude Code deletes old transcripts, a session falls back to its `/insights` meta or its process crashes. A live session banks what can only go up (turns, commit, tests, lint); its context point stays provisional until it ends, since the score falls as the context grows. Ghosts earn nothing.
- **Level** n starts at 4 × (n − 1)² XP: a few levels on day one, then one every week or two for a heavy user (a heavy user with months of history opens around level 25). Titles change at levels 5, 10, 15, 20, 25, 30, 40 and 50.
- **Today** is the XP of the sessions worked in since local midnight (whenever they started) plus badges unlocked today.
- **Current streak** uses the badge streak's rule over all non-ghost sessions: quiet weekends are skipped, a quiet weekday ends it. A quiet weekday *today* doesn't end it yet; it is `atRisk` (the flame dims in the header and the Now page says "not yet today").
- **Moments** (`utils/progress.ts`, `useProgressEvents`): `localStorage` `marey:progress` holds the unlocks already announced, the unlocks already seen on the Progress page and the highest level announced. A new unlock or level-up raises an achievement toast (several unlocks at once share one); unlocks not yet seen count on the Progress tab and are flagged "new" there. The first run records the current state silently; a payload without a level (before the first parse) is ignored; nothing is announced while the tab is hidden, so a background tab doesn't use up a toast. Toasts pause while hovered, focused or hidden. The header chip shows "+N XP" for a moment whenever XP grows while the dashboard is open.
- `sniper` and `comeback` need `/insights` facets; `hygiene` needs scored sessions (5+ turns). They are hidden (`available: false`) when no session has that data.
- The shell-based families only see commands run by Claude, not ones typed in another terminal.

### Context quality (`scripts/quality.mjs`)

Measured while parsing each main-thread transcript (sub-agents are not scored), so it needs no other plugin. Sessions under 5 assistant turns get no score. Five signals, each 0–100 (100 = no waste), weighted into the score; waste tokens are estimated as characters / 4:

| Signal | Weight | Measure |
|---|---|---|
| Context fill | 0.3 | Peak context (`input + cacheRead + cacheWrite` of a turn) vs the window: 100 up to 50%, 0 at 95%. The window isn't in the transcript: a peak over 200k implies 1M. |
| Stale reads | 0.2 | `Read` of the same file and range with no edit to that file in between (−10 each). |
| Bloated results | 0.2 | Tool results over 25k characters (−15 each). |
| Compaction depth | 0.2 | `isCompactSummary` lines: 0 → 100, 1 → 70, 2 → 40, more → 10. |
| Duplicates | 0.1 | Same command, pattern, URL or query repeated with no edit in between (−10 each). |

Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F. The list payload keeps the score, grade, fill, band, waste and compaction count; signal details are in the session payload.

### Health check (`src/utils/healthRules.ts`)

The **Health** tab is a checklist of rules over the sessions in the selected range (ghosts excluded, except for the housekeeping rule). Each rule passes, warns or fails against a threshold written next to it, explains why it matters and what to do, and links up to 5 sessions behind a miss. Rules without data (for example outcomes before `/insights` ran) show as n/a and don't count. The checklist heading shows the result (`passed / total`), and the Health tab of the header counts the rules that warn or fail.

Rules: context quality, context headroom, compactions, prompt cache, startup cost (median first-turn context: system prompt, CLAUDE.md, memory, skills and MCP tools; this rule and the cache rule only count Claude Code sessions, the others need data Codex sessions don't have), outcomes, friction, forgotten sessions (process running over 24h, from the pid file's `startedAt`) and housekeeping (ghosts). Adding one means appending a function to `RULES`.

### Recommendations (`scripts/recommendations.mjs`, `scripts/known-frictions.mjs`)

Computed server-side after every parse from the sessions' incidents (Claude Code only; Codex rollouts don't expose them yet), over the last 30 days. Cards are written for the reader, not for a shell expert: the title gives the effect, counted ("41 commands failed because of a zsh setting"), `what` says what happens in one sentence, `action` what to do (a line to copy and a prompt to paste into Claude Code, which explains and applies the change), and `details` the mechanism. Marey only suggests: nothing is applied.

- **Known causes** (`CAUSES`): a failed call whose text matches one (unmatched zsh globs, the rtk hook, sandbox writes, a shared Playwright profile, Playwright file roots, the wrong directory, worktree isolation, an MCP server to reconnect) counts toward its card, shown from 3 sessions. **Noise** (`NOISE`) gets its own card. Harness retries (`File has not been read yet`, …) and user rejections are ignored.
- **Recurring errors**: other failures grouped by `errorKey` (paths, ids and numbers stripped first, bare exit codes dropped); the 3 widest groups seen in 3+ sessions become cards, naming the command only when it accounts for 80% of the group.
- **Denials**: grouped by command head (`commandHead`: no `cd`, env assignments, flags or arguments; `$(…)` unwrapped), with Claude Code's reason. Commands matching `PROTECTIVE` (merge, push, force, destructive, credentials) are marked "keep"; only repeated, non-protective commands get a narrow `Bash(<head> *)` allow rule (allow rules apply before the auto mode classifier).
- **Waits**: 3+ waits over 10 minutes in the last 7 days suggest `/bg` and agent view.

Each card also carries its count, sessions, trend (last 7 days vs the 7 before), latest error and up to 8 sessions. Cards with something to paste or try come first, then by spread. `coverage` says what was read (sessions, tool calls, results, failures, denials, waits) and warns when tool calls were found but no result could be read, so an empty list never hides a format change.

---

## 6. API (`scripts/api.mjs`)

Shared by the production server and the Vite dev server, so both expose the same routes with the same checks.

**Cache and refresh.** `startApi()` parses once, then keeps the in-memory cache (`sessions`, `byId`, `errors`, serialized list + ETag) fresh:
- `fs.watch` on `sessions/`, `usage-data/session-meta/`, `usage-data/facets/`, `marey/cache/` (missing dirs are skipped with a warning);
- a 10 s interval (transcripts under `projects/` are not watched);
- events are coalesced: at most one parse every 5 s (minimum 600 ms delay), and a parse requested during a parse runs right after it.
- An `onParsed` callback runs after each parse (the dev server uses it for HMR).

| Method | Path | Purpose | Guards |
|---|---|---|---|
| GET | `/api/sessions` | Session summaries + `errors` + `models` overrides + `generatedAt`. | `ETag` / `If-None-Match` → 304; `cache-control: no-cache`. |
| GET | `/api/sessions/:id` | Full session from the cache. | id must be a 36-char UUID; 404 if unknown. |
| POST | `/api/sessions/:id/focus` | Bring the terminal running a live Claude Code session to the front (see below). Returns `{ app, exact }`. | UUID check; POST only; 409 unless the session is live with a pid; 501 off macOS. |
| GET | `/api/file-history/:id/:hash@v:n` | Raw snapshot from `file-history/`. | id and file name regex-validated (no path traversal). |
| GET | `/api/recommendations` | Recommendation cards and `coverage` from the last parse (§5). | `no-store`. |
| GET | `/api/badges` | Badge families with per-tier progress and unlock dates, level and XP, current streak (§5). | `no-store`. |
| GET | `/api/limits` | `readLimits()` or `null`. | `no-store`. |
| GET | `/api/live-context` | `readLiveContext()`: context / prompt-cache snapshots per session, newest first. | `no-store`. |
| GET | `/api/report-status` | Whether `usage-data/report.html` exists, and its mtime. | `no-store`. |
| POST | `/api/ghost/:id/reveal` | Reveal the transcript in the OS file manager (`open -R`, `explorer /select`, `xdg-open` on the folder). | UUID check; POST only. |
| POST | `/api/ghost/:id/delete` | Delete one ghost's transcript (+ `.stale` file), then re-parse. | UUID check; 409 unless currently classified ghost. |
| POST | `/api/ghost/bulk-delete` | Body `{ ids: [...] }`; same as above for each id. | Ids filtered to valid UUIDs that are ghosts; 400 if none remain. |
| POST | `/api/parse-error/:file/trash` | Trash an unparseable session-meta file, then re-parse. | File name must be `<uuid>.json`; POST only. |
| GET | `/usage-report.html` | Proxies the `/insights` report (placeholder page with 404 if missing). | `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`. |

Any other `/api/*` path returns 404; non-API paths fall through to static files (prod) or Vite (dev).

**Focusing a terminal** (`scripts/focus-terminal.mjs`, macOS only). One `ps -A` gives the session's process chain: the pid must still be a `claude` process, and the first ancestor inside an `.app` bundle is the host app (tmux, zellij and screen in between are refused, since the pane can't be reached). In Ghostty 1.3+, AppleScript lists every terminal's id, working directory and title, and the session's terminal is found in this order:
1. **Title.** Claude Code shows its session title in the terminal title (`✳ <title>`, another glyph while working) and writes it to the transcript (`ai-title`, or `custom-title` after `/rename`). The latest of each is compared without the glyph; equal titles are told apart by working directory.
2. **Marker.** When that is still ambiguous (or there is no title yet), a unique title escape sequence (`OSC 2`) is written to the session's tty, the terminal showing it is looked up for up to a second, and its previous title is written back.
3. **Working directory**, when it belongs to one terminal only (titles locked by the Ghostty config).

The match is focused (`focus terminal id …`: window, tab and split), then the app is activated with `open -a` (AppleScript's `activate` can block for seconds). Any other host app, an older Ghostty or no match only gets `open -a`, with `exact: false`, which the UI explains in a toast. A denied Automation permission (`-1743`) returns 403 with the System Settings path.

---

## 7. Security model

The API serves prompts, file snapshots and account info, and can delete files, so it is local-only and defends against other web pages in the same browser:

- **Loopback bind.** `serve.mjs` listens on `127.0.0.1` only.
- **DNS rebinding.** Every request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (any port) gets 403, in prod and dev.
- **Cross-site writes.** Non-GET/HEAD requests are rejected when `Sec-Fetch-Site` is present and not `same-origin`, or when `Origin` does not match `Host`. Local non-browser clients (curl) send neither header and are allowed. Cross-origin GETs cannot read responses since no CORS headers are sent.
- **Input validation.** Session ids, snapshot names and meta file names are regex-checked before touching the filesystem; the static server normalizes paths and refuses anything outside `dist/`.
- **Destructive actions are narrow.** Deletes only apply to sessions the parser currently classifies as ghosts; parse-error cleanup moves to a trash rather than unlinking.
- **Terminal focus is narrow.** It only targets the pid of a session the parser currently classifies as live, checked again as a `claude` process. Terminal ids reach `osascript` as `argv`, never inside the script. Its only write is the marker title to that session's own tty, written back right after.
- **Generated HTML is sandboxed.** `/usage-report.html` is served with a CSP `sandbox` so it cannot run scripts on the API origin.
- **Hook output is private.** Plugin cache files are created with mode `0600` (previews can contain secrets from tool I/O).
- **No personal data in the repo or package.** `pnpm parse` writes to `~/.claude/marey/`, and `public/sessions.json` / `dist/sessions.json` are gitignored and excluded from the npm `files`.

---

## 8. Front end (`src/`)

React 19 + TypeScript, bundled by Vite. No router or state library.

### Data loading

- [`src/data/loadSessions.ts`](src/data/loadSessions.ts): `loadSessions()` fetches `/api/sessions` with `cache: "no-cache"` (ETag revalidation) and applies the `models` overrides; `loadSessionDetail(id)` fetches `/api/sessions/:id` when a session is opened. If the API is unreachable or returns no sessions, the app falls back to `src/data/mockSessions.ts` (shown as an amber status dot and "mock data" in the profile menu).
- **Polling / HMR.** In production `App.tsx` refreshes every 5 s (cheap thanks to 304s). In dev, polling is off and the app refetches on the `marey:sessions-updated` HMR event pushed after each server-side parse. `/api/report-status` is fetched on each refresh; `/api/limits` and `/api/live-context` are polled separately (5 s).

### State and routing (`App.tsx`)

- Page (`now` / `sessions` / `usage` / `health` / `badges`, the last labeled "Progress", see `utils/pages.ts`), selected session, range (`today` / `7d` / `30d` / `all`), list filter (`all`, `live`, `ghost`, `friction`, `failed`, `lowquality`), project and search are mirrored to the URL hash (`#<page>?range=…&filter=…&project=…&q=…`, or `#session/<id>?…` while a session is open; Now has no path) and to `localStorage` (`marey:state`).
- **Scope.** Sessions, Usage and Health follow the range and filters and show the scope bar and the headline tiles (`StatsRow`); Now and Progress ignore them and say so in their headings. The table sort (`utils/sortSessions.ts`) also orders ↑ / ↓ in the session view.
- The detail view merges the list summary with the fetched full session.
- Keyboard: `1`–`5` (Now, Sessions, Usage, Health, Progress), `j`/`k` or arrows (next/previous session while one is open), `Esc` (close), `?` (help).

### Components

| Component | Role |
|---|---|
| `AppHeader` | Brand, page navigation (session count on Sessions, failing checks on Health, unseen unlocks on Progress), `LimitsPill`, `ParseErrors`, `ProfileMenu`. |
| `ScopeBar` / `SessionFilters` | Range, project and status pickers (counts from the range, before filtering; ghosts split by crashed / empty in the tooltip; Claude Code / Codex when both are present), search, the resulting count and a reset. Clicking a project in the sessions table filters on it. |
| `Kpi` / `KpiRow` | The one headline-tile style (label, value, context line), used by `StatsRow`, the session view and the 5h window. Up to six tiles share a row. |
| `LimitsPill` | The 5h and 7-day usage windows (fill, elapsed-time tick, reset countdown); rendered in the top bar and in the session view so they are always on screen. |
| `units` (`utils/units.ts`, `UnitSetting`) | Display unit for usage: **tokens** (fresh = input + output + cache writes; cached reads are shown apart) or **API value** ($ at API prices, read as a relative weight, since a subscription is limited by the 5h / 7d windows rather than dollars). Persisted in `localStorage` (`marey:unit`), set from the profile menu. Rankings by weight (podium "Heaviest", project league) use API value. The podium "Longest" ranks by `longestRunMs` (longest main-thread stretch with no pause over 15 min), not `durationMs`, which adds up to 5 min per gap and so favors sessions left open for days. |
| `ParseErrors` / `ProfileMenu` | Top-bar badge listing unreadable session-meta files with a Trash action (only shown when there are some). Profile chip (data status dot, level, XP bar, streak, dimmed when at risk; "+N XP" when XP comes in) opening a menu: level progress and today's XP (opens Progress), Health link, usage unit, data status and insights report, `LimitsSection`, keyboard shortcuts, bug report link. |
| `Recommendations` | The cards from `/api/recommendations` (`utils/recommendations.ts`): kind, title, sessions and when it was last seen, what happens, denied commands, the action ("Copy a prompt for Claude", "Copy the line", docs), and folded details (mechanism, latest error, the sessions behind it). "Done" / "Not relevant" hide a card in `localStorage` (`marey:recs-dismissed`) until its count grows. Health shows them all; Now shows three as one-line rows, or nothing when there are none. |
| `StatsStrip` (`StatsRow`) | Headline tiles of the scope: sessions, active time, API value, fresh tokens. |
| `SessionList` | The sessions table: status glyph (live, ghost, cleared, or an outcome dot filled as far as the goal was met), goal, project, flags (open-terminal chip on live Claude Code rows on macOS, Codex tag, friction, plugin capture), usage, active time, start; sortable headers; day headers when sorted by date; virtualized. Also renders the short lists of the Now page, and `BulkGhostBar`. |
| `SessionCompare` | Side-by-side metrics for selected sessions. |
| `SessionDetail` | Full-screen overlay: header (a meta line with project, model, date, outcome and quality; the goal as title, with the summary as a two-line subtitle (`GoalSummary`, "more" for the rest) unless it only repeats the title; on the title's first line, the context / cache figures and verdict, then "Open terminal" on a live Claude Code session on macOS, else "Copy resume command"; export), cleared-chain / ghost banners (reveal, delete), and five tabs, each answering one question, with figures in one unit per block (the usage unit where a block shows one weight) and "API value" as the only name for $: **Overview**, how the session went in one screen (`SessionOverview`: four headline tiles that open their tab: active time and peak context → Timeline, fresh tokens or API value → Tokens, tool calls with failures and sub-agents → Tools; the Prompts chart, one bar per prompt in the usage unit, coloured by its costliest kind, a bar opening a card with its share in the same unit (`utils/promptShare.ts`) and links to its tool calls and to Tokens › By prompt; on the right, Frictions with their approximate time and a link to the Timeline, then Top tools → Tools, API value by kind → Tokens › By kind, Files → Files), **Timeline**, what happened when (`SessionTimeline`, data from `src/utils/sessionTimeline.ts`: context fill per main-thread turn against a 200k or 1M window, compactions detected as a drop below half of the previous context, cumulative API value, fresh tokens per turn, prompts and every tool call, sub-agent ones tinted, failures in red; frictions drawn at their fraction of the chart, approximate (`utils/frictionTimes.ts`); idle gaps over 5 minutes are shortened; clicking a prompt focuses the Tools tab on it; then the Prompts list: time, kind, the calls each led to, its text), **Tools**, what Claude did (every call, newest first, with its result; a call that started a sub-agent opens onto the sub-agent's calls; All / Failed; can be focused on one prompt; a By tool card beside them. One helper counts calls for the tab, the tiles, the Timeline and the prompts: `utils/toolCalls.ts`), **Tokens**, where the tokens and their API value went (headline tiles, By kind: tokens and API value per kind, By prompt: each prompt's fresh tokens, API value, share, costliest kind and idle cache rewrite, a row opening its tokens and API value per kind, cache-write split and per-turn table), **Files**, what changed (file-history versions with diffs via `diff`, then the commits from its `git commit` calls). |
| `HelpOverlay` | Keyboard shortcuts, the table glyphs, glossary, data sources. |
| `Toaster` | Error toasts (`toastError`) and achievement toasts (`toastAchievement`: tier-colored, with a View action). |

`pages/` (one question each) compose `fleet/`:
- **Now**: `LiveTicker` (one line of live burn), `FiveHourSession` (current 5h window: limit used, reset and API value as tiles, then `WindowConsumers`; all sessions, ignoring the scope), a **Next up** strip (level, today's XP, streak and the three closest good-practice badges), then live sessions, or the latest ones when none runs.
- **Sessions**: the table, and `SessionCompare` beside it in compare mode (up to 3), or `BulkGhostBar` when the ghost filter is on.
- **Usage**: `TokenTimeSeries`, then `ProjectRollup`, `ModelMix` and `ToolsHeatmap` side by side, then `HeavyPrompts`.
- **Health**: `HealthCheck` (rule checklist, score in its heading), `AnomalyFlags`.
- **Progress** (page id `badges`, key 5): level, next level, today's XP and streak, the XP rules, **Next up** (six), `Badges` (foil cards, unseen unlocks flagged "new"), then `TopSessions` as all-time records (podium; a gold glint runs around the #1 card's frame, CSS only).

`WindowConsumers` says what used the window: one bar split by project (filled to the used 5h % when the limits are connected, so the full bar is the limit) with its legend, then the five heaviest sessions and prompts. Every share is of the window's API value (tokens when nothing is priced), and a prompt started before the window only counts its turns inside it. Rows keep the order shown last time unless one overtakes another by more than 1% of the window (`useStickyRank`, `utils/stickyRank.ts`), so near ties don't swap on every poll; equal weights break on the id. When one of three or more sessions takes three quarters, an amber "one session is using N%" line says so. While the window is idle the same card shows today's consumers. Data from `utils/windowBreakdown.ts` (`windowBreakdown(sessions, from, to)`). Project colors follow the session list, and a clash in the card takes the next free color.

`BurnSpikeBanner` (+ `SpikeAnalysisOverlay`, `SpikeHeuristics`) shows above any page.

`utils/`: `fleetStats` (window/bucket aggregations, costs via `models.mjs`), `aggregateByPrompt`, `classifyPrompt`, `burnTracker`, `rateLimits`, `windowState`, `range`, `format`, `exportSession` (standalone HTML export of a session).

---

## 9. Plugin packaging

- [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json): native Codex manifest declaring [`codex-skills/`](codex-skills/) with `replay` and `update`. The separate skill directory avoids exposing Codex update instructions through Claude Code's default `skills/` discovery. Codex reuses the repository-root entry in `.claude-plugin/marketplace.json`. The replay skill resolves [`scripts/launch.mjs`](scripts/launch.mjs) relative to its installed `SKILL.md`; the launcher detaches `serve.mjs`, waits for startup and prints the URL or error plus a private per-launch log path. The update skill uses Codex's plugin manager; clients that also migrate `commands/update.md` get a redirect to it. The inline `"hooks": { "hooks": {} }` overrides default discovery of Claude's `hooks/hooks.json` (an empty array still falls back to that file in Codex CLI 0.160.1).
- [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) and [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json): plugin `marey`, source `./` (the repo root is the plugin).
- [`hooks/hooks.json`](hooks/hooks.json): runs [`hooks/capture.mjs`](hooks/capture.mjs) on `PostToolUse` (tool name + truncated input/output previews) and on `Stop` (`--stop` marker). The hook validates the session id, reads stdin with a timeout, never writes to stdout and swallows every error so it cannot break Claude Code. On `SessionStart`, [`hooks/session-start.mjs`](hooks/session-start.mjs) runs the update check: at most once a day it reads the `version` of the repo's `.claude-plugin/plugin.json` on GitHub (2 s timeout; offline keeps the last answer), caches it in `~/.claude/marey/update-check.json` with the version running, and prints a `systemMessage` when a newer one is out. The status line wrapper appends `↑ Marey <latest> · /marey:update` from that file, and `GET /api/update` feeds the dashboard header's notice. Off with `{"updateCheck": false}` in `~/.claude/marey/config.json` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. [`commands/update.md`](commands/update.md) → `/marey:update` runs `claude plugin marketplace update marey && claude plugin update marey@marey`.
- [`commands/replay.md`](commands/replay.md) → `/marey:replay`: starts `scripts/serve.mjs` (flags forwarded: `--port <n>`, `--no-open`).
- [`commands/limits.md`](commands/limits.md) → `/marey:limits`: runs `install-statusline.mjs` (`--uninstall` forwarded).
- The server needs the prebuilt `dist/`, which is why it is committed (plugins install from the repo, with no build step).

---

## 10. Build and release

| Script | Does |
|---|---|
| `pnpm dev` | Vite dev server with the API middleware (`vite.config.ts`) and HMR push. |
| `pnpm build` | `tsc -b && vite build` → `dist/`. |
| `pnpm serve` | `node scripts/serve.mjs` (default port 3333; `--port`, `--no-open`). Also the `marey` bin. If the port is taken by an older Marey or ccblackbox server (`/api/version` older or missing, recognized by its command line and page title; `scripts/takeover.mjs`), it stops that server and takes the port; if the same or a newer version runs there, it opens it and exits. On start it also refreshes an installed status line wrapper whose copy differs from this version. It takes the port before the first parse, so the browser opens at once: data routes wait for that parse (the dashboard shows its loading screen), while `/api/version`, `/api/update` and `/api/limits` answer right away. |
| `pnpm parse` | One-off parse to `~/.claude/marey/sessions.json`. |
| `pnpm lint`, `pnpm typecheck` | ESLint, `tsc -b --noEmit`. |
| `pnpm seed:demo` | Writes synthetic data to `.demo-claude/` and `.demo-codex/` (`scripts/seed-demo.mjs`). |

- `dist/` is committed (`!dist/` in `.gitignore`); rebuild and commit it with UI changes.
- npm `files`: `dist` (minus `sessions.json`), `scripts`, `hooks`, `commands`, `.claude-plugin`, `.codex-plugin`, `codex-skills`, `ARCHITECTURE.md`. Runtime dependencies are only needed for the bundle; the server uses the Node standard library. Node ≥ 20.

---

## 11. Known limitations

- **Live detection needs `ps`.** `isClaudePidAlive` shells out to `ps`, which does not exist on Windows; there, running sessions are not detected and their pid files make them look crashed.
- **Codex limits are not shown.** Codex reports its own 5h / weekly windows in `token_count.rate_limits`; the limits pill only shows Claude's.
- **Codex live detection needs `lsof`** to tell which codex process writes a rollout. Without it, a killed CLI whose task was open shows as live for up to 30 minutes while another codex process (the IDE extension's server) runs. An open TUI waiting for the next prompt has no open task, so it is not live.
- **Transcript changes are picked up by polling.** `projects/` and `~/.codex/sessions/` are not watched; updates arrive through the 10 s refresh or through a change in a watched dir (the plugin hook's cache writes trigger one on every tool call).
- **Opening a terminal is macOS only and exact in Ghostty only.** Other apps (iTerm2, Terminal, VS Code…) are only brought to the front; a session inside tmux, zellij or screen is refused.
- **`/clear` chains are heuristic.** They are linked by identical `custom-title` in the same project/cwd.
- **Qualitative fields depend on `/insights`.** Without it, outcome is `unknown`, satisfaction defaults to 0.5, frictions are empty. Friction positions (`at`) are synthetic, not timestamps: the Timeline draws them at that fraction of its chart, marked approximate.
- **Truncation.** Prompts, tool sequences (per transcript) and previews are capped.
- **Costs are estimates** at public API prices; unknown models are priced at their family's latest model. The per-session share of the real 5h % is pro rata to cost, not Anthropic's actual weighting.
- **Commits** are counted by matching `git commit` in Bash commands.
- **Mock fallback.** An unreachable API shows bundled mock data; an empty `~/.claude` shows an empty dashboard.
