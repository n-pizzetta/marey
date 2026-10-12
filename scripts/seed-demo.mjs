#!/usr/bin/env node
/**
 * Generates a fake Claude config dir (what ~/.claude holds) and a fake Codex
 * home (what ~/.codex holds) with realistic, fully synthetic data, for
 * screenshots and for developing without exposing real sessions.
 *
 *   pnpm seed:demo                                    # writes .demo-claude/ and .demo-codex/
 *   CLAUDE_CONFIG_DIR="$PWD/.demo-claude" CODEX_HOME="$PWD/.demo-codex" pnpm dev    # or: pnpm serve
 *
 * Deterministic (seeded) except for timestamps, which are relative to now so
 * the "today", 7d and 5h views are populated.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const CLAUDE = resolve(process.argv[2] ?? ".demo-claude");
const CODEX = resolve(process.argv[3] ?? join(dirname(CLAUDE), ".demo-codex"));
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const PROJECTS = {
  "acme-api": [
    "Add rate limiting to the public REST endpoints",
    "Fix the flaky integration test in orders/checkout",
    "Migrate the auth middleware to the new session store",
    "Profile the slow /search endpoint and add an index",
  ],
  "web-dashboard": [
    "Build a dark-mode toggle that respects the system setting",
    "Refactor the chart components to share one tooltip",
    "Fix layout shift on the settings page",
    "Add keyboard navigation to the data table",
  ],
  "infra-terraform": [
    "Split the staging VPC module into reusable pieces",
    "Add alerts for queue backlog in the worker cluster",
    "Review the IAM policies for least privilege",
  ],
  "docs-site": [
    "Write a getting-started guide for the CLI",
    "Fix broken links reported by the link checker",
    "Generate API reference pages from the OpenAPI spec",
  ],
  "mobile-app": [
    "Debug the crash on cold start in release builds",
    "Add offline caching for the feed screen",
  ],
};

const FOLLOW_UPS = [
  "Looks good, now add tests for the edge cases",
  "Can you also update the README?",
  "That broke the build, check the CI log",
  "Use the existing helper instead of a new one",
  "Great, commit it with a conventional message",
  "Explain why this approach is safer",
];

const TOOLS = [
  ["Read", () => ({ file_path: `/Users/demo/dev/src/${pick(["index", "server", "utils", "config"])}.ts` })],
  ["Edit", () => ({ file_path: `/Users/demo/dev/src/${pick(["routes", "store", "chart", "auth"])}.ts`, old_string: "a", new_string: "b" })],
  ["Bash", () => ({ command: pick(["pnpm test", "pnpm lint", "git status", "rg -n TODO src", "pnpm build", "git commit -m \"fix: handle empty input\""]) })],
  ["Grep", () => ({ pattern: pick(["rateLimit", "useTheme", "TODO", "session"]) })],
  ["Write", () => ({ file_path: `/Users/demo/dev/src/${pick(["new-feature", "helpers", "types"])}.ts`, content: "…" })],
  ["TaskCreate", () => ({ subject: "Follow up on review comments" })],
  ["WebSearch", () => ({ query: "best practice for idempotent retries" })],
  ["mcp__github__create_pull_request", () => ({ title: "Improve error handling" })],
  ["Agent", () => ({ prompt: "Search the codebase for every caller of the old API and list them." })],
];

const MODELS = ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];

function writeJsonl(path, lines) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/**
 * One transcript: prompts, assistant turns with tool calls, tool results. In the main thread, an
 * Agent call runs a sub-agent (returned in `subs`, written to subagents/agent-<id>.jsonl) and its
 * result names it, like Claude Code's `toolUseResult.agentId`; a few results are plain text, like
 * older versions, so the parser has to match those on the prompt.
 */
function transcript({ id, cwd, start, prompts, model, sidechain = false, agentId = null }) {
  const lines = [];
  const subs = [];
  let t = start;
  let ctx = int(8_000, 20_000);
  const base = { sessionId: id, cwd, ...(sidechain ? { isSidechain: true, agentId } : {}) };
  const stamp = () => new Date(t).toISOString();
  for (const text of prompts) {
    lines.push({ ...base, type: "user", timestamp: stamp(), message: { role: "user", content: text } });
    const turns = sidechain ? int(2, 5) : int(3, 12);
    for (let i = 0; i < turns; i++) {
      t += int(4, 40) * 1000;
      // Long main-thread sessions get compacted, like Claude Code's auto-compact.
      if (!sidechain && ctx > 150_000 && rand() < 0.5) {
        lines.push({ ...base, type: "user", isCompactSummary: true, timestamp: stamp(), message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } });
        ctx = int(20_000, 35_000);
        t += int(20, 60) * 1000;
      }
      // sub-agents don't start sub-agents
      const [name, makeInput] = pick(sidechain ? TOOLS.filter(([n]) => n !== "Agent") : TOOLS);
      const input = makeInput();
      const toolId = `toolu_${hex(20)}`;
      const write = int(1_000, 12_000);
      const oneHour = rand() < 0.7 ? write : 0;
      const msgId = `msg_${hex(20)}`;
      const usage = {
        input_tokens: int(2, 40),
        output_tokens: int(150, 2_500),
        cache_read_input_tokens: ctx,
        cache_creation_input_tokens: write,
        cache_creation: { ephemeral_5m_input_tokens: write - oneHour, ephemeral_1h_input_tokens: oneHour },
      };
      ctx += write;
      // Claude Code writes one line per content block, repeating id and usage.
      const message = (content) => ({ id: msgId, role: "assistant", model, usage, content });
      lines.push({ ...base, type: "assistant", timestamp: stamp(), requestId: `req_${hex(16)}`, message: message([{ type: "text", text: "Let me look at that." }]) });
      lines.push({ ...base, type: "assistant", timestamp: stamp(), message: message([{ type: "tool_use", id: toolId, name, input }]) });
      let ranAgent = null;
      if (name === "Agent" && !sidechain) {
        // The sub-agent runs while the call waits for its result.
        const subId = hex(17);
        const sub = transcript({ id, cwd, start: t + 1000, prompts: [input.prompt], model: "claude-haiku-4-5-20251001", sidechain: true, agentId: subId });
        subs.push({ agentId: subId, lines: sub.lines, description: "Find the callers of the old API" });
        t = sub.end;
        if (rand() < 0.8) ranAgent = subId;
      }
      t += int(1, 20) * 1000;
      const failed = rand() < 0.08;
      lines.push({
        ...base,
        type: "user",
        timestamp: stamp(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: failed ? "Error: command exited with code 1" : "ok", ...(failed ? { is_error: true } : {}) }] },
        ...(ranAgent ? { toolUseResult: { status: "completed", agentId: ranAgent, agentType: "general-purpose" } } : {}),
      });
    }
    // the pause before the next prompt (a sub-agent returns as soon as it is done)
    if (!sidechain) t += rand() < 0.2 ? int(8, 40) * MIN : int(20, 180) * 1000;
  }
  return { lines, subs, end: t };
}

/**
 * Recurring frictions for the recommendations, appended after the transcript's last line. Picked
 * from the session's index, not rand(), so the rest of the demo stays the same: an unmatched zsh
 * glob, two kinds of auto mode denial, a busy Playwright browser, and a long wait on a question.
 */
function frictionLines({ id, cwd, model, at, n, recent }) {
  const lines = [];
  let t = at;
  const base = { sessionId: id, cwd };
  const call = (name, input, result, { error = false, denial = null, after = 4_000 } = {}) => {
    const toolId = `toolu_${n}_${lines.length}`;
    t += 5_000;
    lines.push({ ...base, type: "assistant", timestamp: new Date(t).toISOString(), message: { id: `msg_friction_${n}_${lines.length}`, role: "assistant", model, usage: { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }, content: [{ type: "tool_use", id: toolId, name, input }] } });
    t += after;
    lines.push({ ...base, type: "user", timestamp: new Date(t).toISOString(), ...(denial ? { toolDenialKind: denial } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: result, ...(error || denial ? { is_error: true } : {}) }] } });
  };
  if (n % 3 === 0) call("Bash", { command: "find . -name *.pyc -delete" }, "Exit code 1\n(eval):1: no matches found: *.pyc", { error: true });
  if (n % 4 === 1) call("Bash", { command: "gh pr merge 42 --squash" }, "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. If you have other tasks that don't depend on this action, continue working on those.", { denial: "automode-blocked" });
  if (n % 4 === 2) call("Bash", { command: "pnpm dlx depcheck" }, "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier. If you have other tasks that don't depend on this action, continue working on those.", { denial: "automode-blocked" });
  if (n % 5 === 3) call("mcp__playwright__browser_navigate", { url: "http://localhost:5173" }, "### Error\nError: Browser is already in use for /Users/demo/Library/Caches/ms-playwright-mcp/mcp-chrome-1a2b3c, use --isolated to run multiple instances of the same browser", { error: true });
  if (recent && n % 2 === 0) {
    call("AskUserQuestion", { questions: [{ question: "Should the retry budget be per user or per endpoint?", header: "Retries", multiSelect: false, options: [{ label: "Per endpoint" }, { label: "Per user" }] }] },
      'User has answered your questions: "Should the retry budget be per user or per endpoint?"="Per endpoint".', { after: (18 + (n % 4) * 9) * MIN });
  }
  return lines;
}

/**
 * file-history/<sessionId>/<sha256(path)[:16]>@v<n>, like Claude Code: a file's content before each
 * edit and after the last, so the Files tab has versions and diffs. Deterministic: no rand().
 */
function writeFileHistory(id, lines) {
  const edits = new Map();
  for (const l of lines) {
    for (const c of Array.isArray(l.message?.content) ? l.message.content : []) {
      if (c.type === "tool_use" && (c.name === "Edit" || c.name === "Write") && typeof c.input?.file_path === "string") {
        edits.set(c.input.file_path, (edits.get(c.input.file_path) ?? 0) + 1);
      }
    }
  }
  const dir = join(CLAUDE, "file-history", id);
  for (const [path, n] of edits) {
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 16);
    const name = path.split("/").pop().replace(/\.ts$/, "");
    const versions = Math.min(4, n + 1);
    for (let v = 1; v <= versions; v++) {
      const body = [
        `// ${name}.ts`,
        `export const ${name.replace(/-(\w)/g, (_, ch) => ch.toUpperCase())}Version = ${v};`,
        ...Array.from({ length: v }, (_, k) => `export function step${k + 1}(input: string) {\n  return input${k === v - 1 ? ".trim()" : ""};\n}`),
        "",
      ].join("\n");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hash}@v${v}`), body);
    }
  }
}

rmSync(CLAUDE, { recursive: true, force: true });

let sessionCount = 0;
const projectNames = Object.keys(PROJECTS);
for (let day = 6; day >= 0; day--) {
  const perDay = day === 0 ? 6 : int(3, 6);
  for (let k = 0; k < perDay; k++) {
    const project = pick(projectNames);
    const cwd = `/Users/demo/dev/${project}`;
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const id = uuid();
    const start = day === 0 ? NOW - int(10, 280) * MIN : NOW - day * 24 * HOUR - int(1, 10) * HOUR;
    const goal = pick(PROJECTS[project]);
    const prompts = [goal, ...Array.from({ length: int(1, 5) }, () => pick(FOLLOW_UPS))];
    const model = pick(MODELS);
    const { lines, subs, end } = transcript({ id, cwd, start, prompts, model });
    lines.push(...frictionLines({ id, cwd, model, at: end, n: sessionCount, recent: day >= 1 && day <= 3 }));
    if (rand() < 0.3) lines.push({ type: "custom-title", customTitle: goal.toLowerCase().split(" ").slice(0, 4).join("-"), sessionId: id });
    writeJsonl(join(CLAUDE, "projects", slug, `${id}.jsonl`), lines);

    // The sub-agents its Agent calls ran, with the meta file Claude Code writes beside them.
    const subDir = join(CLAUDE, "projects", slug, id, "subagents");
    for (const sub of subs) {
      writeJsonl(join(subDir, `agent-${sub.agentId}.jsonl`), sub.lines);
      writeFileSync(join(subDir, `agent-${sub.agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: sub.description }));
    }

    // The versions Claude Code keeps of the files it edits: one per Edit / Write of a file.
    writeFileHistory(id, lines);

    // /insights enrichment for older sessions.
    if (day > 0 && rand() < 0.6) {
      const outcome = pick(["fully_achieved", "fully_achieved", "mostly_achieved", "partially_achieved"]);
      const frictions = rand() < 0.4 ? { [pick(["tool_failure", "wrong_approach", "misunderstood_request", "buggy_code"])]: int(1, 2) } : {};
      writeFileSync(join(mkdirp(join(CLAUDE, "usage-data", "session-meta")), `${id}.json`), JSON.stringify({ session_id: id, start_time: new Date(start).toISOString(), project_path: cwd }));
      writeFileSync(join(mkdirp(join(CLAUDE, "usage-data", "facets")), `${id}.json`), JSON.stringify({
        outcome,
        underlying_goal: goal,
        brief_summary: `${goal}. ${outcome === "fully_achieved" ? "Done and tested." : "Partly done; follow-ups noted."}`,
        friction_counts: frictions,
        friction_detail: Object.keys(frictions).length ? "A command failed once before the fix landed." : "",
        user_satisfaction_counts: { likely_satisfied: int(1, 3), neutral: int(0, 1) },
      }));
    }
    sessionCount++;
  }
}

// Usage limits as recorded by the status line wrapper.
mkdirSync(join(CLAUDE, "marey"), { recursive: true });
writeFileSync(join(CLAUDE, "marey", "limits.json"), JSON.stringify({
  capturedAt: NOW,
  rate_limits: {
    five_hour: { used_percentage: 58, resets_at: Math.floor((NOW + 2 * HOUR + 14 * MIN) / 1000) },
    seven_day: { used_percentage: 31, resets_at: Math.floor((NOW + 3 * 24 * HOUR) / 1000) },
  },
}));

// Badges count from the first launch; backdate it so the demo history counts.
writeFileSync(join(CLAUDE, "marey", "badges.json"), JSON.stringify({ version: 1, startedAt: new Date(NOW - 365 * 24 * HOUR).toISOString(), unlocked: {} }));

/**
 * One Codex rollout. `legacy` mimics older CLIs (user_message events, direct
 * function calls, token_count only); otherwise newer ones (UserMessage items,
 * code-mode `exec` scripts whose tool calls are logged as items, one
 * token_usage_record per response). `extras` adds the edge cases the parser
 * must handle: failures without an exit code, MCP calls (built-in and real),
 * a prompt re-sent quickly, a command that outlives its script, a sub-agent.
 */
function codexRollout({ id, cwd, start, prompts, model, legacy, extras = false, child = null }) {
  const lines = [];
  let t = start;
  let ordinal = 0;
  const stamp = () => new Date(t).toISOString();
  const push = (type, payload) => lines.push({ timestamp: stamp(), ordinal: ordinal++, type, payload });
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  let ctx = int(9_000, 16_000);
  const respond = () => {
    const usage = { input_tokens: ctx, cached_input_tokens: Math.floor(ctx * 0.9 / 128) * 128, cache_write_input_tokens: 0, output_tokens: int(80, 1_500), reasoning_output_tokens: int(0, 300) };
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    for (const k of Object.keys(total)) total[k] += usage[k];
    if (!legacy) push("token_usage_record", { session_id: id, usage });
    const info = { total_token_usage: { ...total }, last_token_usage: usage, model_context_window: 258_400 };
    push("event_msg", { type: "token_count", info });
    // Codex often repeats the last token_count: the parser must not count it twice.
    if (rand() < 0.3) push("event_msg", { type: "token_count", info });
    ctx += int(1_000, 6_000);
  };
  const item = (turnId, it) => push("event_msg", { type: "item_completed", turn_id: turnId, item: it });
  const command = (cmd, failed, pid = String(int(10_000, 99_999))) => ({ type: "CommandExecution", process_id: pid, command: ["/bin/zsh", "-lc", cmd], status: failed ? "failed" : "completed", exit_code: failed ? 1 : 0, aggregated_output: failed ? "Error: 1 test failed" : "ok" });
  const scriptOutput = (callId, text) => push("response_item", { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text }] });

  push("session_meta", {
    id,
    session_id: child?.rootId ?? id,
    timestamp: stamp(),
    cwd,
    originator: "codex-tui",
    cli_version: legacy ? "0.122.0" : "0.154.0",
    model_provider: "openai",
    ...(child ? { parent_thread_id: child.parentId, thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: child.parentId, depth: 1 } } } } : {}),
  });
  const turnIds = [];
  prompts.forEach((text, n) => {
    const turnId = uuid();
    turnIds.push(turnId);
    push("turn_context", { turn_id: turnId, cwd, model });
    push("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 258_400 });
    // The VS Code extension wraps the first prompt in IDE context.
    const raw = n === 0 && legacy ? `# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## My request for Codex:\n${text}\n` : text;
    if (legacy) push("event_msg", { type: "user_message", message: raw });
    else item(turnId, { type: "UserMessage", content: [{ type: "text", text: raw }] });
    if (child) {
      t += int(3, 20) * 1000;
      push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] });
      respond();
      push("event_msg", { type: "task_complete", turn_id: turnId });
      return;
    }
    for (let i = 0; i < int(2, 6); i++) {
      t += int(3, 30) * 1000;
      const callId = `call_${hex(24)}`;
      const cmd = pick(["pnpm test", "rg -n TODO src", "git status --short", "pnpm lint", "sed -n '1,120p' src/app.ts"]);
      const failed = rand() < 0.1;
      if (legacy) {
        if (rand() < 0.3) {
          const file = pick(["src/app.ts", "src/routes.ts", "README.md"]);
          push("response_item", { type: "custom_tool_call", status: "completed", call_id: callId, name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch` });
          respond();
          push("event_msg", { type: "patch_apply_end", call_id: callId, success: true, changes: { [`${cwd}/${file}`]: { type: "update" } } });
          push("response_item", { type: "custom_tool_call_output", call_id: callId, output: JSON.stringify({ output: `Success. Updated the following files:\nM ${file}\n`, metadata: { exit_code: 0 } }) });
        } else {
          push("response_item", { type: "function_call", name: "exec_command", call_id: callId, arguments: JSON.stringify({ cmd, workdir: cwd }) });
          respond();
          push("event_msg", { type: "exec_command_end", call_id: callId, exit_code: failed ? 1 : 0 });
          push("response_item", { type: "function_call_output", call_id: callId, output: `Process exited with code ${failed ? 1 : 0}\nOutput:\n${failed ? "Error: 1 test failed" : "ok"}` });
        }
      } else {
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: callId, name: "exec", input: `await tools.exec_command({cmd: ${JSON.stringify(cmd)}})` });
        respond();
        item(turnId, command(cmd, failed));
        if (rand() < 0.3) item(turnId, { type: "FileChange", changes: { [`${cwd}/src/${pick(["app", "routes", "store"])}.ts`]: { type: "update" } }, status: "completed", stdout: "Success." });
        scriptOutput(callId, failed ? "Error: 1 test failed" : "ok");
      }
    }
    if (extras && n === 0) {
      t += 5_000;
      if (legacy) {
        // Calls that never ran or that the user stopped: no exit line, no exec_command_end.
        for (const output of ["exec_command failed for `/bin/zsh -lc 'uv run pytest -q'`: CreateProcess { message: \"Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 2 } }))\" }", "aborted by user after 12.0s"]) {
          const callId = `call_${hex(24)}`;
          push("response_item", { type: "function_call", name: "exec_command", call_id: callId, arguments: JSON.stringify({ cmd: "uv run pytest -q" }) });
          respond();
          push("response_item", { type: "function_call_output", call_id: callId, output });
        }
        // Codex's own resource tool (names the server it queries) and a real MCP call, whose end comes after the response.
        const builtin = `call_${hex(24)}`;
        push("response_item", { type: "function_call", name: "list_mcp_resources", call_id: builtin, arguments: "{}" });
        push("event_msg", { type: "mcp_tool_call_end", call_id: builtin, invocation: { server: "docs", tool: "list_mcp_resources", arguments: {} }, result: { Err: "resources/list failed: unknown MCP server 'docs'" } });
        respond();
        push("response_item", { type: "function_call_output", call_id: builtin, output: "resources/list failed: unknown MCP server 'docs'" });
        const mcp = `call_${hex(24)}`;
        push("response_item", { type: "function_call", name: "linear__list_issues", call_id: mcp, arguments: JSON.stringify({ team: "core" }) });
        respond();
        push("event_msg", { type: "mcp_tool_call_end", call_id: mcp, invocation: { server: "linear", tool: "list_issues", arguments: { team: "core" } }, result: { Ok: { content: [{ type: "text", text: "[]" }], isError: false } } });
        push("response_item", { type: "function_call_output", call_id: mcp, output: "[]" });
      } else {
        // A build that outlives its script (yield_time_ms): it completes after the script's output.
        const callId = `call_${hex(24)}`;
        const pid = String(int(10_000, 99_999));
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: callId, name: "exec", input: "await tools.exec_command({cmd: \"pnpm build\", yield_time_ms: 10000})" });
        respond();
        scriptOutput(callId, `{"i":0,"status":"fulfilled","value":{"wall_time_seconds":10.0,"session_id":${pid},"output":"> vite build"}}`);
        t += 4_000;
        item(turnIds.at(-1), command("pnpm build", true, pid));
        // A sub-agent, spawned and awaited from a script.
        const spawn = `call_${hex(24)}`;
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: spawn, name: "exec", input: "const a = await tools.spawn_agent({message: \"Survey the tests\"}); await tools.wait({targets: [a.id]})" });
        respond();
        item(turnIds.at(-1), { type: "CollabAgentToolCall", tool: "spawn_agent", status: "completed", prompt: "Survey the tests", receiver_agents: [{ agent_nickname: "Ada" }] });
        item(turnIds.at(-1), { type: "CollabAgentToolCall", tool: "wait", status: "completed", receiver_agents: [{ agent_nickname: "Ada" }] });
        scriptOutput(spawn, "ok");
        // Scripts that ran no tool count as `exec`. One prints data that looks like a session id,
        // matching the pid of a later command: that command must not be credited to it.
        const echoed = String(int(10_000, 99_999));
        for (const [input, output] of [["const rows = data.filter(Boolean);\nreturn rows.length;", "3"], ["return JSON.stringify({ session_id: echoed });", `{"session_id": ${echoed}}`]]) {
          const js = `call_${hex(24)}`;
          push("response_item", { type: "custom_tool_call", status: "completed", call_id: js, name: "exec", input });
          respond();
          scriptOutput(js, output);
        }
        const next = `call_${hex(24)}`;
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: next, name: "exec", input: "await tools.exec_command({cmd: \"git status --short\"})" });
        respond();
        item(turnIds.at(-1), command("git status --short", false, echoed));
        scriptOutput(next, "ok");
        // A test run cut short: its command never completes, the script still ran a tool.
        const cut = `call_${hex(24)}`;
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: cut, name: "exec", input: "await tools.exec_command({cmd: \"pnpm test\", yield_time_ms: 10000})" });
        respond();
        scriptOutput(cut, `{"i":0,"status":"fulfilled","value":{"wall_time_seconds":10.0,"session_id":${int(10_000, 99_999)},"output":""}}`);
        // A web search and an image view from a script.
        const look = `call_${hex(24)}`;
        push("response_item", { type: "custom_tool_call", status: "completed", call_id: look, name: "exec", input: "await tools.web_search({q: \"vite build cache\"}); await tools.view_image({path: \"shot.png\"})" });
        respond();
        item(turnIds.at(-1), { type: "Extension", kind: "web.search", query: "vite build cache", status: "completed" });
        item(turnIds.at(-1), { type: "ImageView", path: `${cwd}/shot.png`, status: "completed" });
        scriptOutput(look, "ok");
      }
    }
    t += int(5, 30) * 1000;
    push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: the change is in and the tests pass." }] });
    respond();
    push("event_msg", { type: "task_complete", turn_id: turnId });
    // The same prompt re-sent right after an interrupted turn is a second prompt, not a duplicate.
    if (extras && legacy && n === 0) {
      for (let k = 0; k < 2; k++) {
        t += 2_000;
        const again = uuid();
        push("turn_context", { turn_id: again, cwd, model });
        push("event_msg", { type: "task_started", turn_id: again });
        push("event_msg", { type: "user_message", message: "continue" });
        t += 1_000;
        push("event_msg", { type: "turn_aborted", turn_id: again, reason: "interrupted" });
      }
    }
    t += int(30, 600) * 1000;
  });
  return lines;
}

rmSync(CODEX, { recursive: true, force: true });
// Slugs from Codex 0.154's model catalog (~/.codex/models_cache.json).
const CODEX_MODELS = ["gpt-5.4", "gpt-5.6-luna", "gpt-6-astra", "gpt-5.6-terra"];
const threadNames = [];
const writeRollout = (id, start, lines) => {
  const date = new Date(start);
  const pad = (n) => String(n).padStart(2, "0");
  const dir = join(CODEX, "sessions", String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
  writeJsonl(join(dir, `rollout-${date.toISOString().slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`), lines);
};
let codexCount = 0;
for (let day = 6; day >= 0; day -= 2) {
  const project = pick(projectNames);
  const cwd = `/Users/demo/dev/${project}`;
  const id = uuid();
  const start = NOW - day * 24 * HOUR - int(1, 8) * HOUR;
  const legacy = day >= 4;
  const extras = day === 6 || day === 2;
  const prompts = [pick(PROJECTS[project]), ...Array.from({ length: int(1, 3) }, () => pick(FOLLOW_UPS))];
  writeRollout(id, start, codexRollout({ id, cwd, start, prompts, model: pick(CODEX_MODELS), legacy, extras }));
  // Codex 0.154 names threads in session_index.jsonl only.
  if (!legacy) threadNames.push({ id, thread_name: prompts[0].split(" ").slice(0, 4).join(" "), updated_at: new Date(start).toISOString() });
  if (extras && !legacy) {
    // The spawned sub-agent writes its own rollout; session_id is the root thread.
    const childId = uuid();
    writeRollout(childId, start + 60_000, codexRollout({ id: childId, cwd, start: start + 60_000, prompts: ["Survey the tests"], model: "gpt-5.6-luna", legacy: false, child: { rootId: id, parentId: id } }));
  }
  codexCount++;
}
// A sub-agent whose parent rollout is gone stays a session of its own.
const orphanId = uuid();
writeRollout(orphanId, NOW - 3 * HOUR, codexRollout({ id: orphanId, cwd: "/Users/demo/dev/docs-site", start: NOW - 3 * HOUR, prompts: ["Check the broken links"], model: "gpt-5.6-luna", legacy: false, child: { rootId: uuid(), parentId: uuid() } }));
codexCount++;
writeFileSync(join(CODEX, "session_index.jsonl"), threadNames.map((l) => JSON.stringify(l)).join("\n") + "\n");

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

console.log(`[seed-demo] wrote ${sessionCount} synthetic sessions to ${CLAUDE}`);
console.log(`[seed-demo] wrote ${codexCount} synthetic Codex sessions to ${CODEX}`);
console.log(`[seed-demo] run: CLAUDE_CONFIG_DIR="${CLAUDE}" CODEX_HOME="${CODEX}" pnpm dev`);
