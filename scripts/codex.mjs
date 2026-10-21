/**
 * Parses Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl,
 * and ~/.codex/archived_sessions/) into the same intermediate shape as
 * parseTranscriptFile in parse-sessions.mjs, so buildSession can assemble
 * Claude Code and Codex sessions alike. Read-only. See ARCHITECTURE.md.
 */
import { readdir, readFile, stat as fspStat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { normalizeModel } from "./models.mjs";
import { createContextCollector } from "./agent-context.mjs";
import {
  addTokens,
  countShellKinds,
  emptyTokens,
  firstLineSummary,
  IDLE_CAP_MS,
  jsonlLines,
  longestRun,
  toolKey,
} from "./transcript-utils.mjs";

// Codex moves ~/.codex when CODEX_HOME is set; so do we.
export const CODEX = process.env.CODEX_HOME || join(homedir(), ".codex");
const ROLLOUT_DIRS = [join(CODEX, "sessions"), join(CODEX, "archived_sessions")];
const SESSION_INDEX = join(CODEX, "session_index.jsonl");
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** A task still open in a rollout modified this recently, with a codex process running, is live. */
const LIVE_IDLE_MS = 30 * 60_000;

const SUBAGENT_TOOLS = new Set(["spawn_agent"]);
const TOOL_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);
const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);
/** Codex's own resource tools: `invocation.server` is the server they query, not one they call. */
const MCP_BUILTINS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
/** Item types a code-mode script logs for the tools it ran (messages and reasoning are items too). */
const SCRIPT_TOOL_ITEMS = new Set(["CommandExecution", "FileChange", "Extension", "ImageView"]);
/** The VS Code extension wraps prompts in IDE context; the request follows this heading. */
const IDE_REQUEST = "## My request for Codex:";

/** Thread names from session_index.jsonl (Codex 0.154 no longer writes them into the rollout). */
async function readThreadNames() {
  const names = new Map();
  let raw;
  try { raw = await readFile(SESSION_INDEX, "utf8"); } catch { return names; }
  for (const line of raw.split("\n")) {
    const j = parseJson(line);
    // Later lines are later renames.
    if (typeof j?.id === "string" && typeof j.thread_name === "string" && j.thread_name) names.set(j.id, j.thread_name);
  }
  return names;
}

/** Every rollout file, keyed by session id, with its thread name when Codex indexed one. */
export async function indexCodexRollouts() {
  const index = new Map();
  const names = await readThreadNames();
  for (const root of ROLLOUT_DIRS) {
    let files;
    try { files = await readdir(root, { recursive: true }); } catch { continue; }
    for (const rel of files) {
      const m = basename(rel).match(ROLLOUT_RE);
      if (!m || index.has(m[1])) continue;
      const path = join(root, rel);
      index.set(m[1], { path, dir: dirname(path), agent: "codex", title: names.get(m[1]) ?? null });
    }
  }
  return index;
}

/** True when a codex process (CLI or the IDE extension's app server) is running. */
export function isCodexRunning() {
  try {
    const out = execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").some((c) => /(^|\/)codex$/.test(c.trim()));
  } catch {
    return false;
  }
}

/**
 * Whether a codex process has the rollout open (it keeps it open while a task
 * runs). Null when lsof is unavailable, so the caller keeps its heuristic.
 */
async function codexHoldsFile(path) {
  try {
    const { stdout } = await promisify(execFile)("lsof", ["-Fc", "--", path], { encoding: "utf8", timeout: 2000 });
    return stdout.split("\n").some((l) => l.startsWith("c") && /codex/i.test(l));
  } catch (err) {
    // lsof exits 1 when no process has the file open.
    return err.code === 1 ? false : null;
  }
}

/**
 * Whether a parsed rollout is live: an open task, a recent write, a codex
 * process running and, when lsof can tell, a codex process holding the file
 * (another codex process, like the IDE extension's server, isn't enough).
 */
export async function isCodexLive(path, t, codexRunning, now) {
  if (!codexRunning || !t?.openTask) return false;
  try {
    if (now - (await fspStat(path)).mtimeMs >= LIVE_IDLE_MS) return false;
  } catch {
    return false;
  }
  return (await codexHoldsFile(path)) ?? true;
}

/**
 * Root session of a sub-agent rollout among the parsed ones: its own id when
 * it isn't a sub-agent, or when its parent isn't on disk (archived, deleted).
 */
export function codexRootOf(id, parsed) {
  const seen = new Set([id]);
  let cur = id;
  for (;;) {
    const sub = parsed.get(cur)?.subagentOf;
    const next = [sub?.rootId, sub?.parentId].find((p) => p && parsed.has(p) && !seen.has(p));
    if (!next) return cur;
    seen.add(next);
    cur = next;
  }
}

/**
 * The account's Codex limits as a token count logs them: `primary` (the 5h window) and
 * `secondary` (the weekly one), each with its % used and reset time. Older rollouts give
 * `resets_in_seconds` instead of `resets_at`. Other limit ids (per-model limits) are skipped.
 */
export function codexRateLimits(rl, tsMs) {
  if (!rl || typeof rl !== "object" || (rl.limit_id && rl.limit_id !== "codex")) return null;
  const win = (w) => {
    if (!w || typeof w.used_percent !== "number") return null;
    const resetsAt =
      typeof w.resets_at === "number" ? w.resets_at * 1000
      : typeof w.resets_in_seconds === "number" && tsMs ? tsMs + w.resets_in_seconds * 1000
      : null;
    return { usedPct: w.used_percent, resetsAt, windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null };
  };
  const primary = win(rl.primary);
  const secondary = win(rl.secondary);
  if (!primary && !secondary) return null;
  return { tsMs, plan: typeof rl.plan_type === "string" ? rl.plan_type : null, primary, secondary };
}

const parseJson = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

function promptText(raw) {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf(IDE_REQUEST);
  return (i >= 0 ? raw.slice(i + IDE_REQUEST.length) : raw).trim() || null;
}

/** `exec_command` has `cmd`; older `shell` calls have `command: ["bash", "-lc", "…"]`. */
function commandOf(input) {
  if (typeof input.cmd === "string") return input.cmd;
  if (typeof input.command === "string") return input.command;
  if (Array.isArray(input.command)) return String(input.command.at(-1) ?? "");
  return null;
}

const patchFiles = (patch) => [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

/** Output text and exit status of a tool call output item. */
function readOutput(p) {
  const raw = p.output?.content ?? p.output;
  let text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
  const full = text;
  let exitCode = null;
  const wrapped = text.startsWith("{") ? parseJson(text) : null;
  if (wrapped && typeof wrapped.output === "string") {
    text = wrapped.output;
    if (typeof wrapped.metadata?.exit_code === "number") exitCode = wrapped.metadata.exit_code;
  }
  const m = text.match(/^Process exited with code (-?\d+)$/m);
  if (m) exitCode = Number(m[1]);
  // Calls that never ran (sandbox denial, spawn failure) or that the user stopped have no exit line.
  const failed = /^(exec_command failed for |aborted by user\b)/.test(text);
  // exec_command output starts with a header (chunk id, wall time, exit code, token count).
  const body = text.includes("\nOutput:\n") ? text.slice(text.indexOf("\nOutput:\n") + 9) : text;
  return { body, full, isError: failed || (exitCode !== null && exitCode !== 0) };
}

/**
 * One pass over a Codex rollout. Each model response ends with a `token_count`
 * event whose `last_token_usage` is that response's usage; repeated events
 * with an unchanged total are skipped. OpenAI counts cached tokens inside
 * `input_tokens` and reasoning inside `output_tokens`.
 */
export async function parseCodexRollout(path) {
  const toolCounts = {};
  const absEvents = [];
  const prompts = [];
  const toolSequence = [];
  const turns = [];
  const resultById = new Map();
  /** call id → where the call was recorded, so a later event can rename it. */
  const calls = new Map();
  const files = new Set();
  // The Context page: files created, edited or deleted, and the sub-agents this thread spawned.
  const context = createContextCollector();
  const spawns = [];
  let spawn = null;
  const shell = { prs: 0, tests: 0, lints: 0, infra: 0 };
  let userMessages = 0;
  let commits = 0;
  let model = null;
  let firstModel = null;
  let firstTs = null;
  let lastTs = null;
  let activeMs = 0;
  let cwd = null;
  let firstUserText = null;
  let title = null;
  let version = null;
  let contextWindow = null;
  let openTask = false;
  let subagentOf = null;
  let rateLimits = null;
  let metaSeen = false;
  let lastTotal = null;
  let lastPrompt = null;
  // Newer rollouts log one token_usage_record per response; older ones only token_count.
  let usageRecords = false;
  // Code mode: the model sends a script (`exec`) whose tool calls are logged as items.
  let openScript = null;
  /** Processes still running when their script returned (by process id): they complete later. */
  const lateByProcess = new Map();
  let pending = { tools: [], inBytes: 0, inPreview: "", outBytes: 0, outPreview: "" };

  const onPrompt = (raw, tsMs, kind) => {
    const text = promptText(raw);
    if (!text) return;
    // Some versions may log a prompt both as an item and as a user_message event.
    if (lastPrompt && lastPrompt.kind !== kind && lastPrompt.text === text && Math.abs((tsMs ?? 0) - (lastPrompt.tsMs ?? 0)) < 5000) return;
    lastPrompt = { text, tsMs, kind };
    userMessages++;
    if (!firstUserText) firstUserText = text;
    pending.inBytes += text.length;
    pending.inPreview = text.slice(0, 200);
    absEvents.push({ tsMs, kind: "prompt", label: userMessages === 1 ? "Initial prompt" : "User prompt" });
    if (prompts.length < 100) prompts.push({ tsMs, text: text.slice(0, 1500), preview: firstLineSummary(text) });
  };

  const toolInput = (p) => {
    if (p.type === "custom_tool_call") return { patch: p.input };
    if (p.type === "local_shell_call") return p.action ?? {};
    return parseJson(p.arguments) ?? p.action ?? {};
  };

  /** Records a tool call in `into`, the tool list of the turn it belongs to (default: the next turn). */
  const onToolCall = (p, tsMs, input = toolInput(p), into = pending.tools) => {
    const rawName = p.type === "web_search_call" ? "web_search" : p.type === "local_shell_call" ? "shell" : p.name;
    if (typeof rawName !== "string") return;
    const name = toolKey(rawName);
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    into.push(name);
    const event = { tsMs, kind: SUBAGENT_TOOLS.has(rawName) ? "agent" : "tool", tool: name, label: name };
    absEvents.push(event);
    const command = commandOf(input);
    if (command) {
      countShellKinds(command, shell);
      if (/\bgit\s+commit\b/.test(command)) {
        commits++;
        absEvents.push({ tsMs, kind: "commit", label: "git commit" });
      }
    }
    const patched = typeof input.patch === "string" ? patchFiles(input.patch) : [];
    for (const f of patched) files.add(f.startsWith("/") || !cwd ? f : join(cwd, f));
    if (typeof input.patch === "string") {
      for (const m of input.patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
        context.write(tsMs, m[2].startsWith("/") || !cwd ? m[2] : join(cwd, m[2]), m[1] === "Add" ? "create" : m[1] === "Delete" ? "delete" : "edit");
      }
    }
    if (rawName === "spawn_agent") {
      spawns.push({ task: typeof input.task_name === "string" ? input.task_name : null, fork: typeof input.fork_turns === "string" ? input.fork_turns !== "none" : input.fork_turns != null });
    }
    const id = p.call_id ?? p.id;
    let entry = null;
    if (toolSequence.length < 300) {
      let preview = "";
      let full = "";
      if (command) { preview = command; full = command; }
      else if (patched.length) preview = patched.join(", ");
      else if (typeof input.script === "string") { preview = firstLineSummary(input.script); full = input.script; }
      else if (typeof input.query === "string") preview = input.query;
      else if (typeof input.prompt === "string") { preview = input.prompt; full = input.prompt; }
      else if (typeof input.path === "string") preview = input.path;
      else if (typeof input.label === "string") preview = input.label;
      else if (typeof input.patch === "string") { preview = input.patch; full = input.patch; }
      else preview = Object.keys(input).join(", ") || "(no arguments)";
      entry = { tsMs, tool: rawName, preview: preview.slice(0, 160), id };
      if (full.length > 160) entry.full = full.slice(0, 8000);
      toolSequence.push(entry);
    }
    if (id) calls.set(id, { name, tools: into, index: into.length - 1, event, entry });
  };

  /** Renames a recorded call everywhere it was counted (`raw` as in the tool sequence). */
  const renameCall = (call, raw) => {
    const to = toolKey(raw);
    if (call.name === to) return;
    if (toolCounts[call.name] && !--toolCounts[call.name]) delete toolCounts[call.name];
    toolCounts[to] = (toolCounts[to] ?? 0) + 1;
    call.tools[call.index] = to;
    call.event.tool = call.event.label = to;
    if (call.entry) call.entry.tool = raw;
    call.name = to;
  };

  const onToolOutput = (p, out = readOutput(p)) => {
    if (!p.call_id) return;
    const { body, isError } = out;
    const prev = resultById.get(p.call_id);
    resultById.set(p.call_id, {
      text: body.slice(0, 240),
      truncated: body.length > 240,
      isError: isError || !!prev?.isError,
      bytes: body.length,
    });
    pending.inBytes += body.length;
    if (!pending.inPreview) pending.inPreview = `[tool_result] ${body.slice(0, 200)}`;
  };

  /** A tool call made from a code-mode script, logged as a completed item with its result. */
  const onScriptItem = (item, tsMs, script) => {
    const type = item.type;
    if (typeof type !== "string" || !(SCRIPT_TOOL_ITEMS.has(type) || type.endsWith("Call"))) return;
    let name;
    let input = {};
    let body = "";
    let isError = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
    if (type === "CommandExecution") {
      name = "exec_command";
      input = { cmd: Array.isArray(item.command) ? String(item.command.at(-1) ?? "") : String(item.command ?? "") };
      body = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    } else if (type === "FileChange") {
      const changed = Array.isArray(item.changes) ? item.changes : Object.keys(item.changes ?? {});
      name = "apply_patch";
      input = { path: changed.join(", ") };
      for (const f of changed) {
        files.add(f);
        const kind = Array.isArray(item.changes) ? null : item.changes[f]?.type;
        context.write(tsMs, f, kind === "add" ? "create" : kind === "delete" ? "delete" : "edit");
      }
      body = typeof item.stdout === "string" ? item.stdout : "";
    } else if (type === "Extension") {
      name = item.kind === "web.search" ? "web_search" : typeof item.kind === "string" ? item.kind : "extension";
      if (typeof item.query === "string") input = { query: item.query };
    } else if (type === "ImageView") {
      name = "view_image";
      if (typeof item.path === "string") input = { path: item.path };
    } else if (type === "CollabAgentToolCall") {
      name = typeof item.tool === "string" ? item.tool : "agent";
      const agents = (item.receiver_agents ?? []).map((a) => a?.agent_nickname ?? a?.thread_id).filter(Boolean);
      input = typeof item.prompt === "string" ? { prompt: item.prompt } : { label: [name, ...agents].join(" ") };
    } else if (type === "McpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
      // Not seen in a rollout yet: shape assumed from the binary's item names.
      name = `mcp__${item.server}__${item.tool}`;
    } else {
      name = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : type;
    }
    script.inner++;
    const id = `${script.callId}:${script.inner}`;
    // The script's response may already be counted: its tools belong to that turn.
    onToolCall({ type: "function_call", name, call_id: id }, tsMs, input, script.turn?.tools ?? pending.tools);
    resultById.set(id, { text: body.slice(0, 240), truncated: body.length > 240, isError, bytes: body.length });
  };

  const onScriptOutput = (p) => {
    const out = readOutput(p);
    const script = openScript;
    openScript = null;
    // Commands still running when the script returned report their session id (exec_command's
    // yield result); they complete later. Anchored on that shape so printed data can't match.
    let running = 0;
    for (const m of out.full.matchAll(/"wall_time_seconds":\s*[\d.]+,\s*"session_id":\s*(\d+)/g)) {
      lateByProcess.set(m[1], script);
      running++;
    }
    // A script that ran no tool is itself the tool call.
    if (script.inner === 0 && running === 0) onToolCall(script.p, script.tsMs, { script: String(script.p.input ?? "") }, script.turn?.tools ?? pending.tools);
    onToolOutput(p, out);
  };

  const markError = (callId) => {
    const r = resultById.get(callId);
    if (r) r.isError = true;
    else resultById.set(callId, { text: "", truncated: false, isError: true, bytes: 0 });
  };

  const onTokens = (info, tsMs) => {
    if (!info) return;
    if (typeof info.model_context_window === "number") contextWindow = info.model_context_window;
    const total = info.total_token_usage?.total_tokens;
    if (usageRecords || total === lastTotal) return;
    lastTotal = total;
    onUsage(info.last_token_usage, tsMs);
  };

  const onUsage = (u, tsMs) => {
    if (!u) return;
    const cached = u.cached_input_tokens ?? 0;
    // Assumed to be counted inside input_tokens, like cached tokens (always 0 in rollouts seen so far).
    const written = u.cache_write_input_tokens ?? 0;
    const tokens = {
      ...emptyTokens(),
      input: Math.max(0, (u.input_tokens ?? 0) - cached - written),
      output: u.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: written,
      cacheWrite5m: written,
    };
    turns.push({
      tsMs,
      model,
      tokens,
      tools: pending.tools,
      inBytes: pending.inBytes,
      outBytes: pending.outBytes,
      inPreview: pending.inPreview.slice(0, 240),
      outPreview: pending.outPreview,
    });
    if (openScript && !openScript.turn) openScript.turn = turns.at(-1);
    pending = { tools: [], inBytes: 0, inPreview: "", outBytes: 0, outPreview: "" };
  };

  for await (const line of jsonlLines(path)) {
    if (!line.trim()) continue;
    const j = parseJson(line);
    if (!j) continue;
    const p = j.payload ?? {};
    const tsMs = j.timestamp ? new Date(j.timestamp).getTime() : null;
    if (tsMs) {
      if (firstTs === null) firstTs = tsMs;
      if (lastTs !== null && tsMs > lastTs) activeMs += Math.min(tsMs - lastTs, IDLE_CAP_MS);
      lastTs = Math.max(lastTs ?? tsMs, tsMs);
    }

    if (j.type === "session_meta") {
      if (!cwd && typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.cli_version === "string") version = p.cli_version;
      if (!metaSeen) {
        metaSeen = true;
        // A sub-agent thread gets its own rollout; `session_id` is the root thread.
        const thread = p.source?.subagent?.thread_spawn;
        if (p.thread_source === "subagent" || p.source?.subagent) {
          spawn = { name: typeof thread?.agent_nickname === "string" ? thread.agent_nickname : null, task: typeof thread?.agent_path === "string" ? thread.agent_path : null };
          subagentOf = {
            rootId: typeof p.session_id === "string" && p.session_id !== p.id ? p.session_id : null,
            parentId: p.parent_thread_id ?? thread?.parent_thread_id ?? null,
          };
        }
      }
    } else if (j.type === "turn_context") {
      if (typeof p.model === "string") {
        model = normalizeModel(p.model);
        firstModel ??= model;
      }
      if (!cwd && typeof p.cwd === "string") cwd = p.cwd;
    } else if (j.type === "response_item") {
      if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
        for (const c of p.content) {
          if (typeof c?.text !== "string") continue;
          pending.outBytes += c.text.length;
          if (!pending.outPreview) pending.outPreview = c.text.slice(0, 240);
        }
      } else if (p.type === "custom_tool_call" && p.name === "exec") {
        openScript = { p, tsMs, callId: p.call_id, inner: 0, turn: null };
      } else if (TOOL_CALLS.has(p.type)) onToolCall(p, tsMs);
      else if (TOOL_OUTPUTS.has(p.type)) {
        if (openScript && p.call_id === openScript.callId) onScriptOutput(p);
        else onToolOutput(p);
      }
    } else if (j.type === "token_usage_record") {
      usageRecords = true;
      onUsage(p.usage, tsMs);
    } else if (j.type === "event_msg") {
      switch (p.type) {
        case "user_message":
          onPrompt(p.message, tsMs, "event");
          break;
        case "item_completed": {
          const item = p.item;
          if (!item) break;
          if (item.type === "UserMessage" && Array.isArray(item.content)) {
            onPrompt(item.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n"), tsMs, "item");
            break;
          }
          // A command that outlived its script belongs to that script, even if another one is running.
          const pid = item.process_id != null ? String(item.process_id) : null;
          const script = (pid && lateByProcess.get(pid)) || openScript;
          if (pid) lateByProcess.delete(pid);
          if (script) onScriptItem(item, tsMs, script);
          break;
        }
        case "token_count":
          onTokens(p.info, tsMs);
          if (p.rate_limits) rateLimits = codexRateLimits(p.rate_limits, tsMs) ?? rateLimits;
          break;
        case "task_started":
          openTask = true;
          if (typeof p.model_context_window === "number") contextWindow = p.model_context_window;
          break;
        case "task_complete":
        case "turn_aborted":
          openTask = false;
          break;
        case "exec_command_end":
          if (typeof p.exit_code === "number" && p.exit_code !== 0 && p.call_id) markError(p.call_id);
          break;
        case "patch_apply_end":
          if (p.success === false && p.call_id) markError(p.call_id);
          for (const [f, change] of Object.entries(p.changes ?? {})) {
            files.add(f);
            context.write(tsMs, f, change?.type === "add" ? "create" : change?.type === "delete" ? "delete" : "edit");
          }
          break;
        case "mcp_tool_call_end": {
          if (p.result?.Err || p.result?.Ok?.isError) markError(p.call_id);
          // MCP calls share the function_call stream; group them per server like Claude's mcp__ tools.
          const { server, tool } = p.invocation ?? {};
          const call = calls.get(p.call_id);
          if (!call || typeof server !== "string" || typeof tool !== "string" || server === "codex" || MCP_BUILTINS.has(tool)) break;
          renameCall(call, `mcp__${server}__${tool}`);
          break;
        }
        case "thread_name_updated":
          if (typeof p.thread_name === "string" && p.thread_name) title = p.thread_name;
          break;
      }
    }
  }

  // A script whose running commands never completed (interrupted, rollout cut) still ran a tool.
  for (const script of new Set(lateByProcess.values())) {
    if (script.inner > 0) continue;
    onToolCall(script.p, script.tsMs, { script: String(script.p.input ?? "") }, script.turn?.tools ?? turns.at(-1)?.tools ?? pending.tools);
    toolSequence.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  }
  for (const entry of toolSequence) {
    if (entry.id && resultById.has(entry.id)) entry.result = resultById.get(entry.id);
  }
  let runningTool = null;
  for (let i = toolSequence.length - 1; i >= 0; i--) {
    const entry = toolSequence[i];
    if (entry.id && !entry.result) {
      runningTool = { tool: entry.tool, preview: entry.preview, tsMs: entry.tsMs };
      break;
    }
    if (entry.result) break;
  }
  for (const entry of toolSequence) delete entry.id;

  const tokens = turns.reduce((acc, tu) => addTokens(acc, tu.tokens), emptyTokens());
  return {
    longestRunMs: longestRun([...turns.map((tu) => tu.tsMs), ...prompts.map((pr) => pr.tsMs)]),
    tokens,
    toolCounts,
    absEvents,
    prompts,
    toolSequence,
    turns,
    assistantMessages: turns.length,
    userMessages,
    commits,
    shell,
    model: firstModel,
    firstTs,
    lastTs,
    activeMs,
    cwd,
    firstUserText,
    pathByHash: new Map(),
    runningTool,
    // Not customTitle: that one links /clear chains, which Codex doesn't have.
    title,
    customTitle: null,
    version,
    quality: null,
    contextWindow,
    openTask,
    subagentOf,
    context: context.finish(),
    spawns,
    spawn,
    filesChanged: files.size,
    rateLimits,
  };
}
