/**
 * Parses GitHub Copilot CLI sessions (~/.copilot/session-state/<id>/events.jsonl
 * and workspace.yaml) into the same intermediate shape as parseTranscriptFile in
 * parse-sessions.mjs, so buildSession can assemble them like Claude Code and
 * Codex sessions. Also reads the account's monthly quota, which Copilot CLI logs
 * with each model call. Read-only. See ARCHITECTURE.md.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeModel } from "./models.mjs";
import { addTokens, countShellKinds, emptyTokens, firstLineSummary, IDLE_CAP_MS, jsonlLines, longestRun } from "./transcript-utils.mjs";
import { briefOf, createContextCollector, instructionBlocksOf } from "./agent-context.mjs";

// Copilot CLI moves ~/.copilot when COPILOT_HOME is set; so do we.
export const COPILOT = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE_DIR = join(COPILOT, "session-state");
const OPEN_SESSIONS = join(COPILOT, "open-sessions-state.json");
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_RE = /^inuse\.(\d+)\.lock$/;

/** Event types the parser reads; the others (hooks, model snapshots, assets) are skipped unparsed. */
const READ = new Set([
  "session.start",
  "session.resume",
  "session.model_change",
  "session.usage_checkpoint",
  "session.shutdown",
  "session.task_complete",
  "user.message",
  "assistant.message",
  "assistant.turn_end",
  "session.usage_record",
  "tool.execution_start",
  "tool.execution_complete",
  "subagent.started",
  "subagent.completed",
  "system.message",
  "permission.requested",
  "permission.completed",
  "abort",
]);
/** Copilot logs the account's quota with each model call; only the last one is parsed. */
const QUOTA_EVENT = "model.model_call_success";
const TYPE_RE = /^\{"type":"([^"]+)"/;

const SUBAGENT_TOOLS = new Set(["task"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const parseJson = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** Top-level `key: value` scalars of workspace.yaml (the only shape Copilot writes there). */
export function parseWorkspaceYaml(raw) {
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Every session with an events file, keyed by id, with its workspace (name, cwd) and the pid holding it. */
export async function indexCopilotSessions() {
  const index = new Map();
  let dirs;
  try { dirs = await readdir(STATE_DIR); } catch { return index; }
  for (const id of dirs) {
    if (!SESSION_ID_RE.test(id)) continue;
    const dir = join(STATE_DIR, id);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    if (!files.includes("events.jsonl")) continue;
    let workspace = {};
    try { workspace = parseWorkspaceYaml(await readFile(join(dir, "workspace.yaml"), "utf8")); } catch { /* optional */ }
    const pids = files.map((f) => f.match(LOCK_RE)?.[1]).filter(Boolean).map(Number);
    index.set(id, {
      path: join(dir, "events.jsonl"),
      dir,
      agent: "copilot",
      title: workspace.name || null,
      cwd: workspace.cwd || null,
      pids,
    });
  }
  return index;
}

/** Running copilot processes by pid (a session's in-use lock names the pid that holds it). */
export function copilotPids() {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m && /(^|\/)copilot$/.test(m[2].trim())) pids.add(Number(m[1]));
    }
    return pids;
  } catch {
    return new Set();
  }
}

/** `working` per open session, from open-sessions-state.json (Copilot keeps it while a session is open). */
export async function readOpenSessions() {
  try {
    const raw = parseJson(await readFile(OPEN_SESSIONS, "utf8")) ?? {};
    const out = new Map();
    for (const [id, v] of Object.entries(raw)) {
      if (v && typeof v === "object") out.set(id, { working: v.working === true, at: Date.parse(v.refreshedAt ?? "") || null });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** The short form of a tool call for the tool list: the command, the path, or what it is for. */
function previewOf(name, args) {
  if (!args || typeof args !== "object") return { preview: "(no arguments)", full: "" };
  if (typeof args.command === "string") return { preview: args.command, full: args.command };
  if (typeof args.path === "string") return { preview: args.path, full: "" };
  if (typeof args.pattern === "string") return { preview: args.pattern, full: "" };
  if (typeof args.url === "string") return { preview: args.url, full: "" };
  if (typeof args.query === "string") return { preview: args.query, full: "" };
  if (typeof args.question === "string") return { preview: args.question, full: args.question };
  if (typeof args.prompt === "string") return { preview: firstLineSummary(args.prompt), full: args.prompt };
  if (typeof args.description === "string") return { preview: args.description, full: "" };
  if (typeof args.summary === "string") return { preview: firstLineSummary(args.summary), full: args.summary };
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim());
  return { preview: first ? firstLineSummary(first) : Object.keys(args).join(", ") || "(no arguments)", full: "" };
}

/** The text of a tool result, which Copilot writes as a string or as `{ content }`. */
function resultText(data) {
  if (data.success === false) return String(data.error?.message ?? "Failed");
  const r = data.result;
  if (typeof r === "string") return r;
  if (typeof r?.content === "string") return r.content;
  if (Array.isArray(r?.content)) return r.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/**
 * The monthly quota from a quotaSnapshots object, or null when the plan has none. Still named
 * `premium_interactions`, it counts AI credits since GitHub's switch to them.
 */
function quotaOf(snapshots, tsMs) {
  const q = snapshots?.premium_interactions;
  if (!q || typeof q !== "object") return null;
  const resetsAt = Date.parse(q.resetDate ?? "");
  return {
    tsMs,
    unlimited: q.isUnlimitedEntitlement === true,
    entitlement: typeof q.entitlementRequests === "number" ? q.entitlementRequests : null,
    used: typeof q.usedRequests === "number" ? q.usedRequests : null,
    remainingPct: typeof q.remainingPercentage === "number" ? q.remainingPercentage : null,
    overage: typeof q.overage === "number" ? q.overage : 0,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
  };
}

/**
 * One pass over a Copilot CLI events file. Each model call writes a
 * `session.usage_record` (the turn), then the assistant message with the tool
 * calls it asked for, then the calls. Input tokens include cache reads and
 * writes, as with OpenAI. Every call is billed in AI credits (`totalNanoAiu`,
 * priced per token type), whoever started it: the monthly quota counts those.
 * `cost`, the premium request multiplier of calls the user started, predates
 * the switch to AI credits and no longer tracks the quota.
 */
export async function parseCopilotEvents(path) {
  const toolCounts = {};
  const absEvents = [];
  const prompts = [];
  // Prompts past the first 100 are not kept: their turns are attributed to none (`promptsCutAt`).
  let promptsCutAt = null;
  const toolSequence = [];
  const turns = [];
  const resultById = new Map();
  const callById = new Map();
  const shell = { prs: 0, tests: 0, lints: 0, infra: 0 };
  const files = new Set();
  /** Permission prompts not answered yet, by request id. */
  const openPermissions = new Map();
  let userMessages = 0;
  let commits = 0;
  let subAgents = 0;
  let model = null;
  let firstTs = null;
  let lastTs = null;
  let activeMs = 0;
  let cwd = null;
  let firstUserText = null;
  let version = null;
  let contextWindow = null;
  let creditsTotal = null;
  let lastQuotaLine = null;
  let lastQuotaTs = null;
  let lastCallId = null;
  let lastText = null;
  let openTask = false;
  let pendingIn = { bytes: 0, preview: "" };
  // The Context page: instruction files in each system prompt, files written, and per sub-agent
  // (by agentId) what it was started with, the brief its task call gave and what its prompt held.
  const context = createContextCollector();
  const subStarted = new Map();
  const subPromptBlocks = new Map();
  const subCalls = new Map();
  const subDone = new Map();
  const taskBriefs = new Map();

  for await (const line of jsonlLines(path)) {
    const type = line.match(TYPE_RE)?.[1];
    if (!type) continue;
    if (type === QUOTA_EVENT) {
      // Large lines (the response chunk): keep the raw text, parse only the last one.
      if (line.includes('"quotaSnapshots"')) lastQuotaLine = line;
      continue;
    }
    if (!READ.has(type)) continue;
    const j = parseJson(line);
    if (!j) continue;
    const d = j.data ?? {};
    const tsMs = Date.parse(j.timestamp ?? "") || null;
    if (tsMs) {
      if (firstTs === null || tsMs < firstTs) firstTs = tsMs;
      if (lastTs !== null) activeMs += Math.min(Math.max(0, tsMs - lastTs), IDLE_CAP_MS);
      if (lastTs === null || tsMs > lastTs) lastTs = tsMs;
    }
    const sub = typeof j.agentId === "string";

    if (type === "session.start" || type === "session.resume") {
      cwd = d.context?.cwd ?? cwd;
      version = d.copilotVersion ?? version;
      if (!model && d.selectedModel) model = normalizeModel(d.selectedModel);
    } else if (type === "session.model_change") {
      if (d.newModel) model = normalizeModel(d.newModel);
    } else if (type === "session.usage_checkpoint" || type === "session.shutdown") {
      if (typeof d.totalNanoAiu === "number") creditsTotal = d.totalNanoAiu / 1e9;
      if (type === "session.shutdown") openTask = false;
    } else if (type === "session.task_complete" || type === "abort") {
      openTask = false;
    } else if (type === "user.message") {
      const text = typeof d.content === "string" ? d.content.trim() : "";
      // A prompt the agent sent a sub-agent, or autopilot moving on by itself: not the user's.
      const auto = typeof d.source === "string" && (d.source.startsWith("agent-") || d.source === "autopilot");
      if (!text || sub || auto || d.isAutopilotContinuation) continue;
      userMessages++;
      openTask = true;
      if (!firstUserText) firstUserText = text;
      pendingIn = { bytes: pendingIn.bytes + text.length, preview: text.slice(0, 200) };
      absEvents.push({ tsMs, kind: "prompt", label: userMessages === 1 ? "Initial prompt" : "User prompt" });
      if (prompts.length < 100) prompts.push({ tsMs, text: text.slice(0, 1500), preview: firstLineSummary(text) });
      else promptsCutAt ??= tsMs;
    } else if (type === "session.usage_record") {
      const u = d.usage ?? {};
      const cacheRead = u.cacheReadTokens ?? 0;
      const cacheWrite = u.cacheWriteTokens ?? 0;
      const turnModel = u.model ? normalizeModel(u.model) : model;
      if (!model) model = turnModel;
      if (typeof u.maxPromptTokens === "number" && !sub) contextWindow = u.maxPromptTokens;
      turns.push({
        tsMs,
        model: turnModel,
        tokens: {
          ...emptyTokens(),
          input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
          output: u.outputTokens ?? 0,
          cacheRead,
          cacheWrite,
          cacheWrite5m: cacheWrite,
        },
        tools: [],
        // BYOK calls are billed by the user's own provider, not against the quota.
        credits: !u.isByok && typeof u.copilotUsage?.totalNanoAiu === "number" ? u.copilotUsage.totalNanoAiu / 1e9 : 0,
        ...(sub || u.initiator === "sub-agent" ? { sidechain: true } : {}),
        inBytes: pendingIn.bytes,
        inPreview: pendingIn.preview,
        outBytes: 0,
        outPreview: "",
      });
      pendingIn = { bytes: 0, preview: "" };
    } else if (type === "assistant.message") {
      const text = typeof d.content === "string" ? d.content.trim() : "";
      const turn = turns.at(-1);
      if (turn && text) {
        turn.outBytes += text.length;
        if (!turn.outPreview) turn.outPreview = text.slice(0, 200);
      }
      if (text && !sub) lastText = text.slice(0, 200);
    } else if (type === "tool.execution_start") {
      const name = typeof d.toolName === "string" ? d.toolName : null;
      if (!name) continue;
      const args = d.arguments ?? {};
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      turns.at(-1)?.tools.push(name);
      absEvents.push({ tsMs, kind: SUBAGENT_TOOLS.has(name) ? "agent" : "tool", tool: name, label: name });
      if (SHELL_TOOLS.has(name) && typeof args.command === "string") {
        countShellKinds(args.command, shell);
        if (/\bgit\s+commit\b/.test(args.command)) {
          commits++;
          absEvents.push({ tsMs, kind: "commit", label: "git commit" });
        }
      }
      if ((name === "edit" || name === "create") && typeof args.path === "string") {
        files.add(args.path);
        context.write(tsMs, args.path, name, sub ? j.agentId : null);
      }
      if (SHELL_TOOLS.has(name) && typeof args.command === "string") context.bash(tsMs, args.command);
      if (SUBAGENT_TOOLS.has(name) && d.toolCallId && typeof args.prompt === "string") taskBriefs.set(d.toolCallId, args.prompt);
      if (sub) subCalls.set(j.agentId, (subCalls.get(j.agentId) ?? 0) + 1);
      const { preview, full } = previewOf(name, args);
      const call = { tool: name, tsMs, ask: name === "ask_user" ? preview : null, preview: preview.slice(0, 160) };
      if (d.toolCallId) {
        callById.set(d.toolCallId, call);
        if (!sub) lastCallId = d.toolCallId;
      }
      if (toolSequence.length < 300) {
        const entry = { tsMs, tool: name, preview: preview.slice(0, 160), id: d.toolCallId };
        if (full.length > 160) entry.full = full.slice(0, 8000);
        toolSequence.push(entry);
      }
    } else if (type === "tool.execution_complete") {
      if (!d.toolCallId) continue;
      const body = resultText(d);
      resultById.set(d.toolCallId, { text: body.slice(0, 240), truncated: body.length > 240, isError: d.success === false, bytes: body.length });
      pendingIn.bytes += body.length;
      if (!pendingIn.preview) pendingIn.preview = `[tool_result] ${body.slice(0, 200)}`;
    } else if (type === "system.message") {
      const blocks = instructionBlocksOf((d.contentBlocks ?? []).map((b) => b?.content ?? "").join("\n") || (typeof d.content === "string" ? d.content : ""));
      if (sub) subPromptBlocks.set(j.agentId, [...(subPromptBlocks.get(j.agentId) ?? []), ...blocks]);
      else context.instructionBlocks(tsMs, blocks);
    } else if (type === "subagent.started") {
      subAgents++;
      const id = typeof j.agentId === "string" ? j.agentId : d.toolCallId;
      if (id) subStarted.set(id, { tsMs, toolCallId: d.toolCallId ?? null, type: d.agentType ?? d.agentName ?? "subagent", name: d.agentDisplayName ?? d.agentName ?? null, description: d.agentDescription ?? null, model: d.model ?? null });
    } else if (type === "subagent.completed") {
      const id = typeof j.agentId === "string" ? j.agentId : d.toolCallId;
      if (id && typeof d.totalToolCalls === "number") subDone.set(id, d.totalToolCalls);
    } else if (type === "permission.requested") {
      const req = d.permissionRequest ?? {};
      openPermissions.set(d.requestId, {
        tool: "permission",
        tsMs,
        preview: String(req.fullCommandText ?? req.intention ?? req.kind ?? "an action").slice(0, 160),
      });
    } else if (type === "permission.completed") {
      openPermissions.delete(d.requestId);
    }
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

  const quotaEvent = lastQuotaLine ? parseJson(lastQuotaLine) : null;
  if (quotaEvent) lastQuotaTs = Date.parse(quotaEvent.timestamp ?? "") || null;
  const tokens = turns.reduce((acc, tu) => addTokens(acc, tu.tokens), emptyTokens());
  const pendingCall = lastCallId && !resultById.has(lastCallId) ? callById.get(lastCallId) : null;
  const ctx = context.finish();
  // Explore, research and code-review sub-agents get no instruction file; general-purpose ones do.
  const subagentContexts = [...subStarted].map(([id, a]) => {
    const blocks = subPromptBlocks.get(id);
    return {
      id,
      type: a.type,
      name: a.name,
      description: a.description,
      model: a.model,
      tsMs: a.tsMs,
      ...briefOf(taskBriefs.get(a.toolCallId)),
      received: !blocks ? "unrecorded" : blocks.length ? blocks.map((b) => ({ path: null, label: b.heading, type: "Copilot", hash: b.hash })) : "none",
      toolCalls: subDone.get(id) ?? subCalls.get(id) ?? 0,
      writes: ctx.writes.filter((w) => w.by === id).map((w) => w.path),
    };
  });
  return {
    longestRunMs: longestRun([...turns.filter((tu) => !tu.sidechain).map((tu) => tu.tsMs), ...prompts.map((p) => p.tsMs)]),
    tokens,
    toolCounts,
    absEvents,
    prompts,
    promptsCutAt,
    toolSequence,
    turns,
    assistantMessages: turns.filter((tu) => !tu.sidechain).length,
    userMessages,
    commits,
    shell,
    model,
    firstTs,
    lastTs,
    activeMs,
    cwd,
    firstUserText,
    pathByHash: new Map(),
    runningTool,
    customTitle: null,
    version,
    quality: null,
    contextWindow,
    openTask,
    subAgents,
    filesChanged: files.size,
    // AI credits this session used: the sum per call, which is ahead of Copilot's own checkpoints.
    // Older CLIs logged neither: unknown, not zero.
    aiCredits: turns.length || creditsTotal !== null ? Math.max(creditsTotal ?? 0, turns.reduce((n, tu) => n + tu.credits, 0)) : null,
    // An open question (ask_user) or permission prompt, for the sessions board.
    pendingCall: [...openPermissions.values()].at(-1) ?? (pendingCall?.tool === "ask_user" ? { ...pendingCall, tool: "AskUserQuestion" } : pendingCall),
    lastCall: lastCallId ? callById.get(lastCallId) : null,
    lastText,
    quota: quotaEvent ? quotaOf(quotaEvent.data?.quotaSnapshots, lastQuotaTs) : null,
    context: ctx,
    subagentContexts,
  };
}

/**
 * Live state of a running Copilot session: an open question or permission prompt needs the
 * user; `working` in open-sessions-state.json (or activity in the last 30 s) means busy.
 */
export function copilotLiveState(t, open, now) {
  const iso = (ms) => new Date(ms ?? now).toISOString();
  const p = t.pendingCall;
  if (p?.tool === "AskUserQuestion") return { state: "needs-you", reason: "question", text: p.ask ?? null, since: iso(p.tsMs) };
  if (p?.tool === "permission") return { state: "needs-you", reason: "permission", text: p.preview, since: iso(p.tsMs) };
  const busy = open ? open.working : !!t.lastTs && now - t.lastTs < 30_000;
  const call = p ?? t.lastCall;
  // "bash: pnpm test", as Claude Code sessions read on the board; the folder is already on the row.
  const text = call ? `${call.tool}: ${call.preview.split("\n")[0].replace(/^cd\s+\S+\s*&&\s*/, "")}` : null;
  if (busy) return { state: "working", text, since: iso(t.lastTs) };
  return { state: "your-turn", text: t.lastText, since: iso(t.lastTs) };
}
