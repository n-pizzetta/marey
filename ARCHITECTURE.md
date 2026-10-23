# Architecture

Marey is a local dashboard for Claude Code, Codex and Copilot CLI sessions, packaged for npm (`npx marey`), Claude Code (`/marey:replay`) and Codex (the `marey:replay` skill). A Node server parses the files Claude Code already writes under `~/.claude/` (Codex under `~/.codex/`, Copilot CLI under `~/.copilot/`, §3), keeps the result in memory and serves it to a React single-page app over a small local API.

There is no database, no network access beyond loopback except the daily update check (`scripts/update-check.mjs`), and no runtime dependency besides Node's standard library on the server side.

---

## 1. Overview

```
 ~/.claude/  (written by Claude Code)            ~/.claude/marey/  (written by Marey)
 ├── projects/<slug>/<id>.jsonl                  ├── cache/<id>.jsonl      ◀── hooks/capture.mjs
 ├── projects/<slug>/<id>/subagents/*.jsonl      ├── limits.json           ◀── statusline.mjs
 ├── sessions/<pid>.json                         ├── models.json           (user, optional)
 ├── usage-data/session-meta/<id>.json           ├── statusline.mjs/.json  ◀── install-statusline.mjs
 ├── usage-data/facets/<id>.json                 └── sessions.json         ◀── `pnpm parse` only
 ├── usage-data/report.html
 ├── file-history/<id>/<hash>@v<n>
 ├── history.jsonl
                    │
                    ▼
      scripts/parse-sessions.mjs  ── parseAllSessions() / summarizeSession()
      scripts/codex.mjs           ── ~/.codex/sessions/**/rollout-*.jsonl → same shape
      scripts/copilot.mjs         ── ~/.copilot/session-state/*/events.jsonl → same shape
      scripts/provider-limits.mjs ── Codex limits and Copilot quota from those files
      scripts/codex-live-limits.mjs ── Codex limits asked live (`codex app-server`)
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
      src/utils/rateLimits.ts   (/api/limits, every provider)
                         │
                         ▼
      src/App.tsx ─┬─ AppHeader · ScopeBar (+ SessionFilters) · StatsRow
                   ├─ pages/: Now (PlanCard, SessionBoard) · Sessions (SessionList, SessionCompare) · Usage · Health
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
| `projects/<slug>/memory/` | Claude Code's memory folder (`MEMORY.md` index + one file per memory): read for the Context page (§5). |

Codex (`~/.codex`, or `$CODEX_HOME`), also read-only: `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, `archived_sessions/` and `session_index.jsonl` (thread names). See "Codex rollouts" in §3.

Copilot CLI (`~/.copilot`, or `$COPILOT_HOME`), also read-only: `session-state/<id>/events.jsonl` (the session), `workspace.yaml` (name, cwd), `inuse.<pid>.lock` (the process holding it) and `open-sessions-state.json` (whether an open session is working). See "Copilot CLI sessions" in §3.

### Written

- Everything Marey writes by itself lives under `~/.claude/marey/` (`scripts/data-dir.mjs`). Before the rename it was `~/.claude/ccblackbox/`: the first call to `dataDir()` (API, parser, plugin hook, `/marey:limits`) moves that folder and leaves a symlink at the old path, so a status line wrapper or an older plugin still writing there lands in the same place:
  - `cache/<id>.jsonl`: one line per tool call / stop, appended by the plugin hook (mode `0600`). A light parse keeps each file's counts (calls, last capture, last stop) and reads it again only when its `mtime` or size changes (`readPluginCache`); the calls themselves are read with a session's detail, and listed only when the session has no transcript: next to one they are duplicates (a long call is logged when it ends, a sub-agent's calls land in its parent's file).
  - `limits.json`: latest `rate_limits` payload, written atomically by the status line wrapper. `limits-history.jsonl`: one line per change of either window (`{t, five:{p,r}, seven:{p,r}}`, trimmed at 512 KB), kept to calibrate "% of window" later.
  - `live/<session_id>.json`: sanitized per-session snapshot (context size, prompt-cache state; no paths or prompts) written on every refresh; the API removes ones older than 3 days.
  - `statusline.mjs`, `context-advice.mjs`, `statusline.json`: installed wrapper, its shared helper, and the saved previous `statusLine` setting (plus `"verdict": false` to hide the terminal segment).
  - `host-limits.json`: what `/marey:limits` changed in Codex and Copilot CLI (the previous `[tui] status_line` items, whether `footer.showQuota` was set), for `--uninstall`.
  - `sessions.json`: full parse dump, only when `pnpm parse` is run by hand. The app never reads it.
  - `models.json`: never written; the user creates it to override prices.
- `~/.claude/settings.json` is modified only by `install-statusline.mjs` (i.e. when the user runs `/marey:limits`), with a backup at `settings.json.marey.bak`. `--uninstall` restores the previous `statusLine`.
- The same command also edits, when they are installed, `~/.codex/config.toml` (`$CODEX_HOME`; `[tui] status_line`, backup at `config.toml.marey.bak`) and Copilot CLI's `footer.showQuota` (through `copilot config`). See §5.
- Deletions and moves of Claude Code files happen only on explicit user action in the UI:
  - **Ghost delete** (single or bulk): unlinks `projects/<slug>/<id>.jsonl` and `sessions/.stale/<id>.json`, and only for sessions the parser currently classifies as ghosts.
  - **Trash a parse error**: moves an unparseable `usage-data/session-meta/<file>.json` to the macOS Trash (via Finder/`osascript`), or on other platforms to `usage-data/session-meta/.trash/`.
- `sessions/<pid>.json` files are never moved or deleted (see `classifyLiveFiles`).

---

## 3. Parser (`scripts/parse-sessions.mjs`)

Used as a library by `scripts/api.mjs`, and as a CLI (`pnpm parse`) that writes `~/.claude/marey/sessions.json`.

### Pipeline (`parseAllSessions`)

1. `loadModelOverrides()` reads `~/.claude/marey/models.json` and applies it via `setModelOverrides` (invalid file → warning, built-in table).
2. `classifyLiveFiles()` splits `sessions/*.json` into alive pid files and dead session ids. A pid is alive if `process.kill(pid, 0)` succeeds **and** its `comm` matches `claude` (`claudePids`: one `ps -p <pids> -o pid=,comm=` for all the pid files). Read-only. Ids in `sessions/.stale/` are added to the dead set.
3. `readHistoryBySession()` groups `history.jsonl` by session id.
4. `indexTranscripts()` maps every `projects/*/<id>.jsonl` by session id. Project directory names are lossy (`.`, `_`, `/` all become `-`), so lookups are by id only, never by reconstructed path.
5. `collectLive()` expands each alive pid file to its `/clear` chain (sibling transcripts in the same project dir with the same `custom-title`, modified later); only the newest in the chain is marked live.
6. Meta files are read; one without `session_id` or `start_time` is reported in `errors` (surfaced as a badge in the top bar with a Trash action).
7. `buildSession()` runs for the union of transcript ids, meta ids and live ids.
8. Codex rollouts (`indexCodexRollouts()`, see "Codex rollouts" below) are parsed, skipping ids already built from `~/.claude`. Sub-agent rollouts are merged into their root session (`codexRootOf`); every other rollout goes through the same `buildSession()` with `agent: "codex"`. Then Copilot CLI sessions (`indexCopilotSessions()`, see "Copilot CLI sessions" below), with `agent: "copilot"`. The freshest Codex limits and Copilot quota any of them logged are returned as `readings` (§5).
9. Post-passes: `linkClearedChains()` sets `clearedFrom` / `clearedInto` (same `cwd` + `customTitle`), `reassignLiveToChainTail()` moves the live flag to the chain tail, `markUnpriced()` lists models without a pricing row.

Sessions are returned sorted by `startedAt` descending. Helpers shared by both parsers (`countShellKinds`, `longestRun`, token sums) live in `scripts/transcript-utils.mjs`.

### Transcript parsing (`parseTranscriptFile`)

- Claude Code writes one line per content block (thinking / text / tool_use), each repeating the message id and the full `usage`. Lines are merged into one **turn per API message** (`message.id`, else `requestId`); the last line's `usage` wins. Summing lines would double-count.
- `<synthetic>` assistant messages are skipped. Each turn keeps its own normalized model, so sessions that switch models are priced per turn.
- Token fields per turn: `input`, `output`, `cacheRead`, `cacheWrite`, and the `cacheWrite5m` / `cacheWrite1h` split from `usage.cache_creation`.
- `tool_use` blocks are deduplicated by id. MCP tools are counted per server (`mcp__github__x` → `mcp:github`). `Agent` / `Task` calls produce `agent` timeline events; Bash commands matching `git commit` count as commits. Each Bash command is also split on `&& ; |` and newlines, and segment heads are classified into `shell: { prs, tests, lints, infra }` (`gh pr create`, test runners, lint / typecheck / build, docker / kubectl / terraform / gcloud…), counted once per command; `echo "npm test"` does not count.
- User lines: `tool_result` blocks attach a truncated result (text, bytes, `isError`) to their tool call, and an Agent / Task result's `toolUseResult.agentId` names the sub-agent it ran; `isMeta`, compact summaries and command / system-reminder / interruption lines are not counted as prompts.
- **Sub-agent calls** are nested (`children`) under the main-thread call that started the sub-agent (`scripts/subagent-calls.mjs`): matched by `agentId` (for every sub-agent first, so none takes a call another's id names), else by the sub-agent's first message (the call's prompt), else by its description (a call the plugin hook captured past the 300 kept per transcript has no id, and its input as JSON for preview), else by time (the last free call before it started). The call keeps the sub-agent's id (`subagentId`). A sub-agent no call matches gets a row of its own (`orphan`, not a call itself). Every call is then listed once, and the list, the tool counts and the Tools tab count add up.
- Active time sums gaps between events, capping each gap at 5 minutes (`IDLE_CAP_MS`); `wallMs` is wall-clock.
- `runningTool` is the last `tool_use` without a result (shown only for live sessions).
- **Live state** (`liveState`, running sessions only, in the list payload; `liveStateOf`): *needs-you* when the last call without a result is a question (`AskUserQuestion`) or a plan (`ExitPlanMode`), or when the pid file says `idle` while a call is still open (a permission prompt, by elimination); *working* when it says `busy` (with the open or last call, minus a leading `cd … &&`); else *your-turn* with the start of the last reply. `since` comes from the call or the pid file's `statusUpdatedAt`. Without a `status` (older Claude Code, Codex), activity in the last 30 s means working. `liveName` is the name Claude Code gives the session.
- **Live sub-agents** (`liveSubagents`, running Claude Code sessions with sub-agents, in the list payload; `liveSubagentsOf`): the sub-agents at work, oldest first, each with its name (`name`, else `agentType` from its `.meta.json`), description, start and last call; and how many are done. A sub-agent is done once its last turn ended: a reply with no call (`stop_reason: end_turn`), a call that ends it (`toolEndsTurn`, as `SubagentHandback` does) or an interruption. One whose turn is still open but that has written nothing for 30 minutes (`SUBAGENT_STALE_MS`) was stopped, killed or interrupted with its session, and counts as done too.
- **Incidents** (`incidents`, sub-agents included, absolute times): a failed call (`is_error`, its text with known noise stripped, e.g. zoxide's doctor message, and the noise ids), a denied action (`toolDenialKind` on the result line, with the reason Claude Code gave) and a wait on the user (`AskUserQuestion` / `ExitPlanMode`, call-to-result duration, the question or the plan's title). Capped at 500 per transcript, with `incidentStats.toolResults` beside them; kept out of the list payload. Read by §5's recommendations.
- Caps: prompt texts (first 100, truncated), tool sequence (first 300 entries per transcript, previews truncated), result previews.
- File paths from tool inputs are hashed (`sha256(path)` first 16 hex chars) to label `file-history` entries; unmatched hashes are shown without a path.

`readTranscriptFile` caches parsed results in `transcriptCache`, keyed by path and invalidated when `mtime` or `size` changes, so periodic re-parses only re-read transcripts that grew. A transcript the parse did not read (deleted, or a Codex rollout already built from `~/.claude`) leaves the cache when the parse ends.

**Light sessions.** The server parses with `parseAllSessions({ light: true })`: the cache keeps `lightTranscript` of each transcript, without the tool sequence, the timeline events, the file paths, the prompt texts and the turn previews (it keeps the start of the last reply, `lastReplyText`, for the live state). Its sessions have everything the list, the recommendations and the Context page read, and empty `toolSequence`, `timeline` and `fileHistory`. `sessionDetail(session)` fills those and the full `prompts` and `turns` (`DETAIL_FIELDS`) when a session is opened: it parses the session's files again (`cached: false`, kept by nobody) from what the last parse built it from (`buildInputs`); the rest stays as the parse left it. The light copy is made with `structuredClone`: a preview cut with `slice` would otherwise keep the whole tool output or message it came from in memory. `pnpm parse` and the tests parse in full.

**Transcripts being written.** `createTranscriptParser` takes a transcript one parsed line at a time and says what the lines so far add up to without changing its state, so lines appended later can follow; what it keeps across lines is copied (`clip`, `own` in `transcript-utils.mjs`). A light read of a Claude Code transcript written to in the last 10 minutes (`HOT_MS`) keeps its parser in the cache entry, with the offset after the last line read, the file's inode and its first bytes and last bytes before that offset (`marksOf`). The next read feeds the parser only the lines appended since (`feedFrom`); another inode, a shorter file or other bytes at those marks mean a rewrite, and the file is read again from the start. The parser goes once the file has not changed for 10 minutes. Codex rollouts and Copilot CLI sessions are read whole when they change. In every JSONL file Marey reads, lines end at `\n` only (`feedFrom`, and `jsonlLines` in `transcript-utils.mjs`): readline also ends them at U+2028 and U+2029, which JSON strings may hold, and dropped those lines.

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
- **Limits** (`rateLimits`): every `token_count` event carries the account's `rate_limits`: `primary` (5h, `window_minutes: 300`) and `secondary` (weekly), each with `used_percent` and `resets_at` (older CLIs: `resets_in_seconds`), plus `plan_type`. The last one of each rollout is kept with its time (`codexRateLimits`); limit ids other than `codex` are skipped.

### Copilot CLI sessions (`scripts/copilot.mjs`)

`parseCopilotEvents()` returns the same intermediate shape from Copilot CLI's `events.jsonl` (one event per line: `type`, `timestamp`, `data`, and `agentId` on a sub-agent's events). Only the event types it uses are parsed; hooks, model snapshots and binary assets are skipped from the line's prefix, unparsed, since a long session's file reaches tens of MB.

- **Turns**: one per `session.usage_record` (each model call). `inputTokens` includes cache reads and writes, as with OpenAI: `input = inputTokens − cacheReadTokens − cacheWriteTokens`; cache writes are 5-minute ones (`cacheTtlSeconds: 300`). A sub-agent's calls (`agentId`, or `initiator: "sub-agent"`) are flagged `sidechain`. `maxPromptTokens` is the context window.
- **AI credits**: each call's price in AI credits is `copilotUsage.totalNanoAiu / 1e9`, whoever started it (user, agent or sub-agent); it is the turn's `credits`, and the session's `aiCredits` is their sum (or the larger `totalNanoAiu` of a `session.usage_checkpoint`). An older CLI that logged no usage records leaves it `null` (unknown, not zero). BYOK calls (`isByok`) count 0: the user's own provider bills them. `cost` and `totalPremiumRequests`, the premium request multiplier of calls the user started, predate GitHub's switch to AI credits and are ignored.
- **Prompts**: `user.message` `content`, except a prompt the agent sent a sub-agent (`source: "agent-…"`) and autopilot continuations (`source: "autopilot"`, `isAutopilotContinuation`). **Replies** come from `assistant.message`; the tool calls an assistant message asks for follow its usage record, so they belong to that turn.
- **Tools**: `tool.execution_start` (name, arguments: command, path, pattern, url, question…) and `tool.execution_complete` (`success: false` with `error.message` is a failure). `bash` commands are classified like Claude's and `git commit` counts; `edit` / `create` paths are the files changed. `task` starts a sub-agent (`subagent.started` counts them).
- **Title and folder**: `workspace.yaml` `name` (Copilot names the session) and `cwd`.
- **Live**: a session directory holds `inuse.<pid>.lock` while a copilot process has it open; it is live when that pid is a running `copilot` process (`copilotPids`, one `ps -A`). Its state (`copilotLiveState`): *needs you* while a `permission.requested` has no `permission.completed`, or an `ask_user` call has no result; *working* when `open-sessions-state.json` says `working` (or, without it, activity in the last 30 s); else *your turn* with the start of the last reply.
- **Quota** (`quota`): every `model.model_call_success` event carries the account's `quotaSnapshots`. `premium_interactions` (named after premium requests, it counts AI credits now) gives `entitlementRequests`, `usedRequests`, `remainingPercentage` and `resetDate`, the first of next month. Only the file's last such line is parsed. The entitlement can change within a month (plan change), so only the latest reading is used.
- **Not available yet**: context-quality score, ghosts, file-history diffs, `/insights` fields, incidents (so no recommendations), the context and cache verdict. `copilot --resume <id>` is the resume command.

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

## 5. Plan usage and the 5-hour window

Each provider reports its plan usage per account, in its own place, and [`scripts/provider-limits.mjs`](scripts/provider-limits.mjs) puts them in one shape for `/api/limits` (`{ claude, codex, copilot }`, null for a provider with nothing to read):

- **Claude Code**: the 5h and weekly windows, only in the JSON it pipes to the status line command (steps 1–4 below).
- **Codex**: the same two windows, in every rollout's `token_count` events (§3), and live from its server: once a minute while the dashboard polls `/api/limits`, [`scripts/codex-live-limits.mjs`](scripts/codex-live-limits.mjs) starts `codex app-server` (the JSON-RPC interface its editor extensions use), sends `initialize` then `account/rateLimits/read`, and stops it (about half a second). That is what Codex's own TUI asks every minute, and it catches what the rollouts miss until the next request: an early reset, use from another machine or the web. It runs in the background (the route answers with what it holds) and only once a rollout has logged limits, since only a ChatGPT sign-in has them; a failure (Codex missing, an API key, offline) falls back to the rollouts and retries after 10 minutes. A window at 0% whose reset is a full window away has not started (Codex reports the reset a window opened now would have), so its reset is dropped. `codexLimits` takes whichever reading is fresher, the live one or the freshest among all rollouts, and places each window by its length (a 300-minute one is the 5h window, one over a day the weekly), so a plan with a weekly limit only has no 5h window. `capturedAt` is the time of that reading, and `live` marks a live one (the card says "live" instead of "last request").
- **Copilot CLI**: the monthly quota of AI credits, in every session's `model.model_call_success` events (§3). `copilotLimits` turns the freshest reading into a `month` window: `usedPct` from `usedRequests / entitlementRequests` (past 100 is overage), with `used` and `entitlement`. Null on an unlimited plan.

A window whose reset time has passed since the reading starts over at 0% with an unknown reset. Copilot's readings, and Codex's when it can't be asked live, are as fresh as the last request made with them on this machine (the cards say how old); use from other machines, IDEs or the web shows up with the next one.

The burn tracker and the spike analysis only follow Claude's 5h window. For Claude Code:

1. `/marey:limits` runs [`scripts/install-statusline.mjs`](scripts/install-statusline.mjs): copies [`scripts/statusline.mjs`](scripts/statusline.mjs) to `~/.claude/marey/statusline.mjs` (stable path across plugin updates), saves the current `statusLine` to `statusline.json`, and points `settings.json` at the wrapper.
2. On every status line refresh the wrapper writes `limits.json`, then pipes the untouched payload to the user's previous status line command, or prints a minimal `model · 5h n% · 7d n%` line if there was none.
3. The same command shows the limits in the other CLIs' own status lines ([`scripts/host-limits.mjs`](scripts/host-limits.mjs)). Neither can run a wrapper for this: Codex's status line is a list of built-in items with no custom command, and Copilot CLI's `statusLine.command` payload has no limits. So Codex's `[tui] status_line` gets `context-used`, `five-hour-limit` and `weekly-limit` after the model item (its defaults are written out first when the user never picked items; the TOML is edited line by line, and a `tui` set as a dotted key or inline table is left alone with a hint to use `/statusline`; a status line set up by an earlier version that added only the limits gets `context-used` too, and `--uninstall` still restores the user's original line), and Copilot CLI gets `footer.showQuota` (`Plan: 370/5,000 (7% used)`). The dashboard reads those limits from the session files instead (above). Copilot CLI can run a status line command, and its 5-minute prompt cache is where a pause costs most, so when it has none, it gets [`scripts/copilot-statusline.mjs`](scripts/copilot-statusline.mjs) (copied with `context-advice.mjs` to `~/.claude/marey/`, `statusLine.refreshInterval` 30 s; one the user set is left alone, with a hint). Its payload (`session_id`, `transcript_path`, `context_window`, `cost`…) has no cache state, so the script reads the session's last main-thread `session.usage_record` from the end of `events.jsonl` (`cacheExpiresAt`, `cacheTtlSeconds`, cached tokens), prints the same `ctx │ cache` segment as Claude Code's wrapper and writes the same `live/<session_id>.json` snapshot, so the dashboard shows it on the session's row too. `--uninstall` removes it if it is still Marey's.
4. `/api/limits` serves `readLimits()` merged into what the server already holds (`mergeLimits`) as `claude`; [`src/utils/rateLimits.ts`](src/utils/rateLimits.ts) polls it every 5 s (`useRateLimits`, one poll shared by every component). Every running session's status line overwrites `limits.json` with its own last-known limits, so an idle session writes a lower %, a window that has already reset, or no 5h window, every few seconds. The merge keeps, per window, the later reset and within a window the higher %, and never lets a reading without an open window replace one that is still open.

### Context and prompt-cache advice

The same payload carries `context_window` (size, % used, last-turn usage) and `prompt_cache` (`warm`, `ttl`, `expires_at`, hit ratio, misses, `recache_tokens_if_cold`). [`scripts/context-advice.mjs`](scripts/context-advice.mjs) (pure, shared by the wrapper and the dashboard like `models.mjs`) turns it into a snapshot (`toSnapshot`) and a verdict (`adviseContext`): *keep going*, *wrap up before pausing*, *compact at the next break*, *compact now*, or *clear if the task is done*, each with its reasons. Thresholds are heuristics (`THRESHOLDS`): context ≥ 70% / 85% of the window; a cold cache matters from 40% of the window or 100k tokens to re-cache; a warm cache is "expiring" under 10 min, or under a third of a shorter TTL (`expiringSoon`: 100 s for a 5-minute cache). A cold cache is the case where `/compact` is no cheaper than a normal message (it re-reads everything at full price), so `/clear` is advised.

The wrapper appends a short segment to the status line (`ctx ━━━───── 33% │ cache warm 59m`, colored by level, plus a hint when it matters). The dashboard polls `/api/live-context` once (`useLiveContext`, a shared store) and shows the result where the session is, only while it runs: `liveSnapshot` returns a session's snapshot only when the parser marks it `live` (Claude Code's pid files, Codex's and Copilot CLI's own checks), since a snapshot outlives its session (kept 3 days on disk for `applyContextWindows`, shown up to 6 hours) and a cache countdown or a "clear" means nothing once it has ended. A running session gets a third line on its row in the list (`ContextLine`: fill bar, cache countdown computed from `expires_at`, the verdict when it is not "keep going"; rows with it are taller, and the virtualized list sizes them on the same `liveSnapshot` test, so heights and lines always agree) and figures in the session view's title row, right of the title and left of its primary action (`SessionContext` / `ContextSummary` in `ContextCard.tsx`: a small ring, used / window, cache countdown, and the verdict pill, which opens its reasons, the cold-start cost and the snapshot's age in a popover, also in its tooltip). An ended session's view only keeps its last reported fill, in neutral tones and labelled "Last context" (`LastContext`): no cache, no verdict.

The 5h window in the UI (`utils/planUsage.ts`, `fleet/FiveHourSession.tsx`):

- With a reported reset: window start = `resetsAt − 5h` (weekly: `resetsAt − 7d`; Copilot's month: the first of the month that `resetDate` ends); the used % is real. Claude's start is also saved as the local anchor, so a moment without limits continues the same window.
- Without: the 5h window is inferred locally (`inferWindowStart`): walking forward over the last day's turns, each one after the previous window ended starts a new one. Claude's is persisted in `localStorage` (`marey:window-start`, `utils/windowState.ts`), and the reset time is marked as estimated.
- **Share of a limit per session** (`planUsage`): providers report the % per account, never per session, so each window is split between the sessions active in it by what they used there: API value for Codex (tokens when nothing is priced), the same for Claude Code but with cache reads at a tenth of their price (`READ_WEIGHT`: fitting %-points per unit of use on `limits-history.jsonl` put reads at 0–25% of their price, while they are ~45% of the API value of long-context sessions; tentative, on 17 hours of data), and AI credits for Copilot CLI, which is exactly what its quota counts. A session's points of the limit are its share times the used % (Copilot: its credits over the entitlement). For Claude Code and Codex, the shares of the sessions on this machine add up to the whole %, which also counts use on the web or another machine: that use is spread over them (an order of magnitude, said in the board's tooltip), and the rest of the bar is this machine's ended sessions. For Copilot CLI the rest is ended sessions and use from elsewhere. The Now page draws the running sessions' points as slices of each bar (`sessionColors`: muted `--slice-*` tokens with no blue or green, numbered across providers so no two running sessions share one under seven) and lists them on the sessions board (`runningUsage`). The board has no colors of its own: pointing at a row or a slice lights up the other, and the bar's line reads out that session's share.
- `utils/burnTracker.ts` samples the real 5h % every 5 s (1 h buffer) and raises a spike banner when it climbs 4+ points within 5 minutes (critical at 10). It is inactive until limits are connected. `SpikeAnalysisOverlay` + `SpikeHeuristics` explain the spike from sessions, prompts and tools in that interval.

### Context quality (`scripts/quality.mjs`)

Measured while parsing each main-thread transcript (sub-agents are not scored), so it needs no other plugin. Sessions under 5 assistant turns get no score. Five signals, each 0–100 (100 = no waste), weighted into the score; waste tokens are estimated as characters / 4:

| Signal | Weight | Measure |
|---|---|---|
| Context fill | 0.3 | Peak context (`input + cacheRead + cacheWrite` of a turn) vs the window: 100 up to 50%, 0 at 95%. The window isn't in the transcript (Opus 5.5 can run at 1M with no `[1m]` in its id): after parsing, `applyContextWindows` takes it from the session's status line snapshot (`live/<id>.json`, `context.size`), else the latest snapshot of the same model, and re-scores (`withWindow`); without one, a peak over 200k implies 1M, else 200k. |
| Stale reads | 0.2 | `Read` of the same file and range with no edit to that file in between (−10 each). |
| Bloated results | 0.2 | Tool results over 25k characters (−15 each). |
| Compaction depth | 0.2 | `isCompactSummary` lines: 0 → 100, 1 → 70, 2 → 40, more → 10. |
| Duplicates | 0.1 | Same command, pattern, URL or query repeated with no edit in between (−10 each). |

Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F. The list payload keeps the score, grade, fill, band, waste and compaction count; signal details are in the session payload.

### Health check (`src/utils/healthRules.ts`)

The **Health** tab is a checklist of rules over the sessions in the selected range (ghosts excluded, except for the housekeeping rule). Each rule passes, warns or fails against a threshold written next to it, explains why it matters and what to do, and links up to 5 sessions behind a miss. Rules without data (for example outcomes before `/insights` ran) show as n/a and don't count. The checklist heading shows the result (`passed / total`).

Rules: context quality, context headroom, compactions, prompt cache, startup cost (median first-turn context: system prompt, CLAUDE.md, memory, skills and MCP tools; this rule and the cache rule only count Claude Code sessions, the others need data Codex sessions don't have), outcomes, friction, forgotten sessions (process running over 24h, from the pid file's `startedAt`) and housekeeping (ghosts). Adding one means appending a function to `RULES`.

### Recommendations (`scripts/recommendations.mjs`, `scripts/known-frictions.mjs`)

Computed server-side after every parse from the sessions' incidents (Claude Code only; Codex rollouts don't expose them yet), over the last 30 days. Cards are written for the reader, not for a shell expert: the title gives the effect, counted ("41 commands failed because of a zsh setting"), `what` says what happens in one sentence, `action` what to do (a line to copy and a prompt to paste into Claude Code, which explains and applies the change), and `details` the mechanism. Marey only suggests: nothing is applied.

- **Known causes** (`CAUSES`): a failed call whose text matches one (unmatched zsh globs, the rtk hook, sandbox writes, a shared Playwright profile, Playwright file roots, the wrong directory, worktree isolation, an MCP server to reconnect) counts toward its card, shown from 3 sessions. **Noise** (`NOISE`) gets its own card. Harness retries (`File has not been read yet`, …) and user rejections are ignored.
- **Recurring errors**: other failures grouped by `errorKey` (paths, ids and numbers stripped first, bare exit codes dropped); the 3 widest groups seen in 3+ sessions become cards, naming the command only when it accounts for 80% of the group.
- **Denials**: grouped by command head (`commandHead`: no `cd`, env assignments, flags or arguments; `$(…)` unwrapped), with Claude Code's reason. Commands matching `PROTECTIVE` (merge, push, force, destructive, credentials) are marked "keep"; only repeated, non-protective commands get a narrow `Bash(<head> *)` allow rule (allow rules apply before the auto mode classifier).
- **Waits**: 3+ waits over 10 minutes in the last 7 days suggest `/bg` and agent view.

Each card also carries its count, sessions, trend (last 7 days vs the 7 before), latest error and up to 8 sessions. Cards with something to paste or try come first, then by spread. `coverage` says what was read (sessions, tool calls, results, failures, denials, waits) and warns when tool calls were found but no result could be read, so an empty list never hides a format change.

### Context page (`scripts/agent-context.mjs`)

What agents have in mind at start and what they left on disk, per project. Each parser feeds a collector (`createContextCollector`) per transcript, stored on the full session as `agentContext` (left out of `/api/sessions` and `/api/sessions/:id`):

- **Instruction files**: Claude Code's `instructions` attachment (paths, type User / Project / Local / AutoMem, line counts), logged at start and after each compaction; a logged `prompt_snapshot` without it means none (Explore and Plan). Copilot CLI: the `<custom_instruction>` blocks of each `system.message` (no path: a hash, matched later to CLAUDE.md, AGENTS.md, `.github/copilot-instructions.md`, `.github/instructions/*`, `~/.copilot/copilot-instructions.md`). Codex logs none.
- **Memory**: Read / Write / Edit on `projects/<slug>/memory/*.md`, and shell commands on those paths (`bashMemoryOps`: `rm` deletes; a redirection, `tee`, `sed -i`, `perl -pi` write; `cat`, `head`, `sed -n`, a grep read). Interpreter scripts are missed.
- **Files written**: Write / Edit / MultiEdit / NotebookEdit (Claude), `FileChange` items and `apply_patch` (Codex, with add / update / delete), `create` / `edit` (Copilot CLI).
- **Sub-agents**: Claude Code: brief = first user message (teammate wrapper stripped), received = its own `instructions` attachment (the session's copy as loaded at the session's start, not a fresh read), `none`, `unrecorded` or `conversation` (fork). Copilot CLI: `subagent.started` + the `task` call's `prompt`; received = the sub-agent's own system prompt blocks (general-purpose ones get them, explore / research / code-review don't). Codex: child rollouts; the brief is encrypted on both sides.

`buildAgentContext(sessions, { project })` keeps the project's sessions that did something, finds the repository (git root of the shortest working folder, a worktree's main checkout, in the sessions' spelling of the path), reads the memory folder (index lines, front matter `name` / `description` / `type`, line counts, mtimes; files logged then removed; a folder that no longer exists), checks git (`ls-files`, untracked files, whether or not a session wrote them with a tool), classifies written paths (repo, worktree under `.claude/worktrees/` or a sibling `<repo>-<name>`, scratch, plans, agent config, outside; outside folders with 3+ files grouped) and takes the instruction files from the latest Claude Code session. The browser derives the rest (`src/utils/agentContext.ts`): per memory file its events by session, a "changed, no log says who" mark when its mtime is over 2 minutes past its last logged write (on the latest Claude session running then), and its status (re-read in 7 days, index line only, deleted, folder gone).

---

## 6. API (`scripts/api.mjs`)

Shared by the production server and the Vite dev server, so both expose the same routes with the same checks.

**Cache and refresh.** `startApi()` parses once, then keeps the in-memory cache (`sessions`, `byId`, `errors`, serialized list + ETag) fresh:
- `fs.watch` on `sessions/`, `usage-data/session-meta/`, `usage-data/facets/`, `marey/cache/` (missing dirs are skipped with a warning);
- a 10 s interval (transcripts under `projects/` are not watched);
- events are coalesced: at most one parse every 5 s (minimum 600 ms delay), and a parse requested during a parse runs right after it.
- re-parses stop while nobody looks: with no request for the parsed sessions in 2 minutes (`idleAfter`; the dashboard only polls from a visible tab), refresh ticks and watcher events are ignored, and the next such request waits for a fresh parse. Routes the dashboard keeps polling from a hidden tab (`/api/limits`, `/api/live-context`, `/api/report-status`) don't count. The dev server passes `idleAfter: Infinity`: its UI refetches on the HMR push instead of polling.
- An `onParsed` callback runs after each parse (the dev server uses it for HMR).

| Method | Path | Purpose | Guards |
|---|---|---|---|
| GET | `/api/sessions` | Session summaries + `errors` + `models` overrides + `generatedAt`. | `ETag` / `If-None-Match` → 304; `cache-control: no-cache`. |
| GET | `/api/sessions/:id` | Full session: the cached light session with its calls, prompts, turns, timeline and file history parsed again (`sessionDetail`, §3). | id must be a 36-char UUID; 404 if unknown. |
| POST | `/api/sessions/:id/focus` | Bring the terminal running a live Claude Code session to the front (see below). Returns `{ app, exact }`. | UUID check; POST only; 409 unless the session is live with a pid; 501 off macOS. |
| GET | `/api/file-history/:id/:hash@v:n` | Raw snapshot from `file-history/`. | id and file name regex-validated (no path traversal). |
| GET | `/api/recommendations` | Recommendation cards and `coverage` from the last parse (§5). | `no-store`. |
| GET | `/api/agent-context?project=<name>` | The Context page of one project (§5): sessions with what they loaded, remembered and wrote, the memory folder, instruction files, what is still open. | `no-store`; cached per project until the next parse or 30 s; 400 without `project`. |
| GET | `/api/limits` | `{ claude, codex, copilot }`: each provider's plan usage or `null` (§5). | `no-store`. |
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
- **Polling / HMR.** In production `App.tsx` refreshes every 5 s while the tab is visible (cheap thanks to 304s), and at once when it becomes visible again: a hidden tab lets the server stop re-parsing (§6). In dev, polling is off and the app refetches on the `marey:sessions-updated` HMR event pushed after each server-side parse. `/api/report-status` is fetched on each refresh; `/api/limits` and `/api/live-context` are polled separately (5 s).

### State and routing (`App.tsx`)

- Page (`now` / `sessions` / `usage` / `health`, see `utils/pages.ts`), selected session, range (`today` / `7d` / `30d` / `all`), list filter (`all`, `live`, `ghost`, `friction`, `failed`, `lowquality`), project and search are mirrored to the URL hash (`#<page>?range=…&filter=…&project=…&q=…`, or `#session/<id>?…` while a session is open; Now has no path) and to `localStorage` (`marey:state`).
- **Scope.** Sessions, Usage and Health follow the range and filters; Now ignores them. The scope bar sits where it applies: on top of Sessions, which is all scoped (with the headline tiles, `StatsRow`); on Usage and Health, at the head of the section it drives ("History", "Checks"), sticky while that section scrolls, below the sections it doesn't (the current 5h window, the recommendations), which carry no controls. Usage keeps the tiles in its History section; Health has none. The table sort (`utils/sortSessions.ts`) also orders ↑ / ↓ in the session view.
- The detail view merges the list summary with the fetched full session.
- Keyboard: `1`–`5` (Now, Sessions, Usage, Health, Context), `j`/`k` or arrows (next/previous session while one is open), `Esc` (close), `?` (help).

### Components

| Component | Role |
|---|---|
| `AppHeader` | Brand, provider switcher, page navigation (sessions that need you on Now, also in the browser tab title; session count on Sessions), `LimitsPill` (opens Now), `ParseErrors`, `ProfileMenu`. |
| `ScopeBar` / `SessionFilters` | Range, project and status pickers (counts from the range, before filtering; ghosts split by crashed / empty in the tooltip), search, the resulting count and a reset. Clicking a project in the sessions table filters on it. |
| `ProjectPicker` | The project picker of Sessions and Context: a button opening a list with a search field (↑ ↓ Enter Esc), sessions per provider, "All projects" where it applies. |
| `ContextPage` (`components/agent-context/`) | The Context page: `HeadBar` (one segment per file read at start or behind the memory index, a label on hover, a click opens the memory), `SessionGrid` (sessions as columns: loaded at start, sub-agents, repo files written, one row per memory file; scrolled to the newest), `SessionView` / `FileView` (one session with its sub-agents' briefs and what they received; one memory file with its index line, description and history), `StillOpen`. Follows the provider switcher; the project is its own pick, independent of the Sessions project filter, else the latest one. |
| `Kpi` / `KpiRow` | The one headline-tile style (label, value, context line), used by `StatsRow`, the session view and the 5h window. Up to six tiles share a row. |
| `LimitsPill` | Plan usage always on screen (fill, elapsed-time tick): in the top bar, each selected provider's fullest window, a click opening Now; in the session view, every window of the session's provider. |
| `PlanCard` | One provider's plan on the Now page: each window's % used (5h and week, or the month of AI credits with used / included), reset time, elapsed-time tick, and the bar split into the running sessions' slices (pointing at one lights up its row on the board and reads out its share under the bar; a click opens the session) and the rest; how fresh the reading is; today's tokens, AI credits and API value; "What used it" opens Usage. Without limits it says how to get them, and splits the bar by the window's use instead. |
| `SessionBoard` | Every running session grouped by its live state (Needs you, longest wait first; Your turn; Working), each with its name, project and provider, the question / plan / call or the start of its last reply, its share of the limit (`of 5h`, or `of month` for Copilot CLI; tooltip with tokens, API value or credits), how long, and "Open terminal" for Claude Code. Under a Claude Code session, its sub-agents at work (name, description, last call, how long; the first 8, then "+ n more") and how many are done; one opens the session's Tools tab on its calls. |
| `units` (`utils/units.ts`, `UnitSetting`) | Display unit for usage: **tokens** (fresh = input + output + cache writes; cached reads are shown apart) or **API value** ($ at API prices, read as a relative weight, since a subscription is limited by the 5h / 7d windows rather than dollars). Persisted in `localStorage` (`marey:unit`), set from the profile menu. The project league ranks by API value. |
| `ParseErrors` / `ProfileMenu` | Top-bar badge listing unreadable session-meta files with a Trash action (only shown when there are some). Settings button, its dot amber when a data source needs a look, opening a menu in one font: the usage unit with what it means, one status line (`SourcesStatus`: "All sources live · parsed 38s ago", then only what needs a look with its fix, from `utils/sourceIssues.tsx`: demo data, Claude Code limits not connected, context advice waiting, no Codex limits or Copilot quota yet), then insights report, keyboard shortcuts and bug report links. |
| `Recommendations` | The cards from `/api/recommendations` (`utils/recommendations.ts`): kind, title, sessions and when it was last seen, what happens, denied commands, the action ("Copy a prompt for Claude", "Copy the line", docs), and folded details (mechanism, latest error, the sessions behind it). "Done" / "Not relevant" hide a card in `localStorage` (`marey:recs-dismissed`) until its count grows. Health shows them all. |
| `StatsStrip` (`StatsRow`) | Headline tiles of the scope: sessions, active time, API value, fresh tokens. |
| `SessionList` | The sessions table: status glyph (live, ghost, cleared, or an outcome dot filled as far as the goal was met), goal, project, flags (open-terminal chip on live Claude Code rows on macOS, Codex or Copilot tag, friction, plugin capture), usage, active time, start; sortable headers; day headers when sorted by date; virtualized against the page's scroll (the content area scrolls, not the table: the tiles above leave the screen first, then the rows pass under a sticky column header; ↑ / ↓ in the session view scroll the page to keep the selected row in view). Also renders the short lists of the Now page, and `BulkGhostBar`. |
| `SessionCompare` | Side-by-side metrics for selected sessions. |
| `SessionDetail` | Full-screen overlay, one scroll: the header scrolls away and the tabs stay on top (`.detail-tabs-bar`, on the page backdrop). Header (a meta line with project, model, date, outcome and quality; the goal as title, with the summary as a two-line subtitle (`GoalSummary`, "more" for the rest) unless it only repeats the title; on the title's first line, the context / cache figures and verdict, then "Open terminal" on a live Claude Code session on macOS, else "Copy resume command"; export), cleared-chain / ghost banners (reveal, delete), and five tabs, each answering one question, with figures in one unit per block (the usage unit where a block shows one weight) and "API value" as the only name for $: **Overview**, how the session went in one screen (`SessionOverview`: four headline tiles that open their tab: active time and peak context → Timeline, fresh tokens or API value → Tokens, tool calls with failures and sub-agents → Tools; the Prompts chart, one bar per prompt in the usage unit, coloured by its costliest kind, a bar opening a card with its share in the same unit (`utils/promptShare.ts`) and links to its tool calls and to Tokens › By prompt; on the right, Frictions with their approximate time and a link to the Timeline, then Top tools → Tools, API value by kind → Tokens › By kind, Files → Files), **Timeline**, what happened when (`SessionTimeline`, data from `src/utils/sessionTimeline.ts`: context fill per main-thread turn against the session's window (`contextWindow`: reported by Codex and Copilot CLI, taken from the live snapshots for Claude Code, else 200k or 1M from the peak), compactions detected as a drop below half of the previous context, cumulative API value, fresh tokens per turn, prompts and every tool call, sub-agent ones tinted, failures in red; frictions drawn at their fraction of the chart, approximate (`utils/frictionTimes.ts`); idle gaps over 5 minutes are shortened; clicking a prompt focuses the Tools tab on it; then the Prompts list: time, kind, the calls each led to, its text), **Tools**, what Claude did (every call, newest first, with its result; a call that started a sub-agent opens onto the sub-agent's calls; All / Failed; can be focused on one prompt, or opened from a sub-agent on Now onto that sub-agent's calls (`focusSubagent`, matched on `subagentId`); a By tool card beside them. One helper counts calls for the tab, the tiles, the Timeline and the prompts: `utils/toolCalls.ts`), **Tokens**, where the tokens and their API value went (headline tiles, By kind: tokens and API value per kind, By prompt: each prompt's fresh tokens, API value, share, costliest kind and idle cache rewrite, a row opening its tokens and API value per kind, cache-write split and per-turn table), **Files**, what changed (file-history versions with diffs via `diff`, then the commits from its `git commit` calls). |
| `HelpOverlay` | Keyboard shortcuts, the table glyphs, glossary, data sources. |
| `Toaster` | Error toasts (`toastError`). |

`pages/` (one question each) compose `fleet/`:
- **Now**: how much of each plan is used and which running session uses it, ignoring the range and filters. One `PlanCard` per selected provider, then `SessionBoard` with the same colors; the latest sessions when none runs.
- **Sessions**: the table, and `SessionCompare` beside it in compare mode (up to 3, sticky while the rows scroll), or `BulkGhostBar` when the ghost filter is on.
- **Usage**: the current 5h window of Claude Code and Codex (`FiveHourSession`: limit used, reset and API value as tiles, then `WindowConsumers`), not scoped; then, in the scope, the headline tiles, `TokenTimeSeries`, `ProjectRollup`, `ModelMix` and `ToolsHeatmap` side by side, then `HeavyPrompts`.
- **Health**: the recommendations (last 30 days), then Checks in the scope: `HealthCheck` (rule checklist, score in its heading), `AnomalyFlags`.

`WindowConsumers` says what used the window: one bar split by project (filled to the used 5h % when the limits are connected, so the full bar is the limit) with its legend, then the five heaviest sessions and prompts. Every share is of the window's API value (tokens when nothing is priced), and a prompt started before the window only counts its turns inside it. Rows keep the order shown last time unless one overtakes another by more than 1% of the window (`useStickyRank`, `utils/stickyRank.ts`), so near ties don't swap on every poll; equal weights break on the id. When one of three or more sessions takes three quarters, an amber "one session is using N%" line says so. While the window is idle the same card shows today's consumers. Data from `utils/windowBreakdown.ts` (`windowBreakdown(sessions, from, to)`). Project colors follow the session list, and a clash in the card takes the next free color.

`BurnSpikeBanner` (+ `SpikeAnalysisOverlay`, `SpikeHeuristics`) shows above any page.

`utils/`: `planUsage` (plan windows and each session's share), `fleetStats` (window/bucket aggregations, costs via `models.mjs`), `aggregateByPrompt`, `classifyPrompt`, `burnTracker`, `rateLimits`, `windowState`, `range`, `format`, `planFormat`, `projectLeague`, `exportSession` (standalone HTML export of a session).

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
| `pnpm seed:demo` | Writes synthetic data to `.demo-claude/`, `.demo-codex/` and `.demo-copilot/` (`scripts/seed-demo.mjs`). |

- `dist/` is committed (`!dist/` in `.gitignore`); rebuild and commit it with UI changes.
- npm `files`: `dist` (minus `sessions.json`), `scripts`, `hooks`, `commands`, `.claude-plugin`, `.codex-plugin`, `codex-skills`, `ARCHITECTURE.md`. Runtime dependencies are only needed for the bundle; the server uses the Node standard library. Node ≥ 20.

---

## 11. Known limitations

- **Live detection needs `ps`.** `claudePids` shells out to `ps`, which does not exist on Windows; there, running sessions are not detected and their pid files make them look crashed.
- **Copilot limits are as fresh as their last request** on this machine: they are only logged with a request. Use elsewhere (another machine, an IDE, the web) shows up with the next one. Codex's too when `codex app-server` can't be asked (Codex not on the `PATH`, signed in with an API key, offline).
- **Codex live detection needs `lsof`** to tell which codex process writes a rollout. Without it, a killed CLI whose task was open shows as live for up to 30 minutes while another codex process (the IDE extension's server) runs. An open TUI waiting for the next prompt has no open task, so it is not live.
- **Transcript changes are picked up by polling.** `projects/` and `~/.codex/sessions/` are not watched; updates arrive through the 10 s refresh or through a change in a watched dir (the plugin hook's cache writes trigger one on every tool call), and only while a dashboard asks for them (§6).
- **Opening a terminal is macOS only and exact in Ghostty only.** Other apps (iTerm2, Terminal, VS Code…) are only brought to the front; a session inside tmux, zellij or screen is refused.
- **`/clear` chains are heuristic.** They are linked by identical `custom-title` in the same project/cwd.
- **Qualitative fields depend on `/insights`.** Without it, outcome is `unknown`, satisfaction defaults to 0.5, frictions are empty. Friction positions (`at`) are synthetic, not timestamps: the Timeline draws them at that fraction of its chart, marked approximate.
- **Truncation.** Prompts, tool sequences (per transcript) and previews are capped.
- **Costs are estimates** at public API prices; unknown models are priced at their family's latest model. A session's share of a limit is pro rata to its API value in the window (Copilot: its AI credits), not the providers' actual weighting, which they don't report per session.
- **Commits** are counted by matching `git commit` in Bash commands.
- **Mock fallback.** An unreachable API shows bundled mock data; an empty `~/.claude` shows an empty dashboard.
