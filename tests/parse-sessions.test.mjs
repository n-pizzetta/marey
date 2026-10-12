// Runs the parser against the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-test-"));
const CLAUDE = join(root, ".claude");
const PROJECTS = join(CLAUDE, "projects");
const CODEX = join(root, ".codex");

let parsed;
let claude;
let codex;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, CODEX], { stdio: "ignore" });
  // The parser resolves CLAUDE_CONFIG_DIR and CODEX_HOME at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = CODEX;
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  parsed = await parseAllSessions();
  claude = parsed.sessions.filter((s) => s.agent === "claude");
  codex = parsed.sessions.filter((s) => s.agent === "codex");
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Main transcript plus sub-agent transcripts of a session. */
function transcriptsOf(id) {
  for (const dir of readdirSync(PROJECTS)) {
    const main = join(PROJECTS, dir, `${id}.jsonl`);
    if (!existsSync(main)) continue;
    const subDir = join(PROJECTS, dir, id, "subagents");
    const subs = existsSync(subDir) ? readdirSync(subDir).map((f) => join(subDir, f)) : [];
    return [main, ...subs];
  }
  throw new Error(`no transcript for ${id}`);
}

/** Output tokens, counting each assistant message once (Claude Code repeats usage per content block). */
function outputTokens(files) {
  const byMessage = new Map();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      const o = JSON.parse(line);
      if (o.type === "assistant") byMessage.set(o.message.id, o.message.usage.output_tokens);
    }
  }
  return [...byMessage.values()].reduce((a, b) => a + b, 0);
}

test("parses every seeded session without errors", () => {
  const seeded = readdirSync(PROJECTS).flatMap((d) => readdirSync(join(PROJECTS, d)).filter((f) => f.endsWith(".jsonl")));
  assert.equal(parsed.errors.length, 0);
  assert.equal(claude.length, seeded.length);
});

test("sorts sessions newest first", () => {
  const starts = parsed.sessions.map((s) => new Date(s.startedAt).getTime());
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
});

test("counts output tokens once per message, sub-agents included", () => {
  for (const s of claude) {
    assert.equal(s.tokens.output, outputTokens(transcriptsOf(s.id)), `session ${s.id}`);
  }
});

test("prices every seeded model", () => {
  for (const s of parsed.sessions) {
    assert.equal(s.unpricedModels, undefined, `session ${s.id}`);
    assert.ok(s.costUsd > 0, `session ${s.id}`);
  }
});

test("attaches /insights facets to the sessions that have them", () => {
  const facets = new Set(readdirSync(join(CLAUDE, "usage-data", "facets")).map((f) => f.replace(/\.json$/, "")));
  assert.ok(facets.size > 0);
  for (const s of parsed.sessions.filter((s) => facets.has(s.id))) {
    assert.ok(s.outcome, `session ${s.id}`);
    assert.ok(s.goal, `session ${s.id}`);
  }
});

test("returns an empty result when there is no Claude data", async () => {
  // A fresh process: the config dir is read once, at import time.
  const empty = join(root, "empty");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'const m = await import("./scripts/parse-sessions.mjs"); console.log(JSON.stringify(await m.parseAllSessions()))'],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: empty, CODEX_HOME: join(root, "empty-codex") } },
  );
  const result = JSON.parse(out);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.errors, []);
});

/** Every seeded Codex rollout: id, lines and session_meta. */
function rollouts() {
  return readdirSync(join(CODEX, "sessions"), { recursive: true })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const lines = readFileSync(join(CODEX, "sessions", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const meta = lines.find((l) => l.type === "session_meta").payload;
      return { id: meta.id, lines, meta };
    });
}

/** A rollout and the sub-agent rollouts merged into it. */
function rolloutTree(id) {
  const all = rollouts();
  return all.filter((r) => r.id === id || (r.meta.thread_source === "subagent" && r.meta.session_id === id));
}

const ofType = (lines, type) => lines.filter((l) => l.payload?.type === type);
const TOOL_ITEMS = new Set(["CommandExecution", "FileChange", "CollabAgentToolCall", "Extension", "ImageView"]);
const outputText = (o) => (Array.isArray(o) ? o.map((c) => c.text).join("\n") : String(o));

/** Code-mode scripts that count as a tool themselves: no tool item ever came from them. */
function selfCountedScripts(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (l.payload?.type !== "custom_tool_call" || l.payload.name !== "exec") return;
    const end = lines.findIndex((x, k) => k > i && x.payload?.type === "custom_tool_call_output" && x.payload.call_id === l.payload.call_id);
    if (lines.slice(i, end).some((x) => x.payload?.type === "item_completed" && TOOL_ITEMS.has(x.payload.item.type))) return;
    const running = [...outputText(lines[end].payload.output).matchAll(/"wall_time_seconds":\s*[\d.]+,\s*"session_id":\s*(\d+)/g)].map((m) => m[1]);
    if (lines.slice(end).some((x) => running.includes(x.payload?.item?.process_id))) return;
    out.push(l.payload.input);
  });
  return out;
}

test("lists every Codex rollout except sub-agents merged into their parent", () => {
  const all = rollouts();
  const ids = new Set(all.map((r) => r.id));
  const merged = all.filter((r) => r.meta.thread_source === "subagent" && ids.has(r.meta.session_id));
  assert.ok(merged.length > 0);
  assert.deepEqual(new Set(codex.map((s) => s.id)), new Set(all.filter((r) => !merged.includes(r)).map((r) => r.id)));
  // An orphan sub-agent (parent rollout gone) stays a session of its own.
  assert.ok(all.some((r) => r.meta.thread_source === "subagent" && !ids.has(r.meta.session_id) && codex.some((s) => s.id === r.id)));
  for (const s of codex) assert.equal(s.ghost, undefined, `session ${s.id}`);
});

test("counts Codex tokens once per response, sub-agents included, cached input apart", () => {
  for (const s of codex) {
    const totals = rolloutTree(s.id).map((r) => ofType(r.lines, "token_count").at(-1).payload.info.total_token_usage);
    const sum = (k) => totals.reduce((a, t) => a + t[k], 0);
    assert.equal(s.tokens.output, sum("output_tokens"), `session ${s.id}`);
    assert.equal(s.tokens.cacheRead, sum("cached_input_tokens"), `session ${s.id}`);
    assert.equal(s.tokens.input + s.tokens.cacheRead, sum("input_tokens"), `session ${s.id}`);
  }
});

test("reads Codex prompts in both rollout formats", () => {
  for (const s of codex) {
    const { lines } = rollouts().find((r) => r.id === s.id);
    // One prompt per task, including the same prompt re-sent seconds later.
    assert.equal(s.prompts.length, ofType(lines, "task_started").length, `session ${s.id}`);
    // The IDE wrapper is stripped from prompts.
    assert.ok(!s.goal.includes("Context from my IDE"), `session ${s.id}`);
  }
});

test("counts every Codex tool call once, code-mode scripts as the tools they ran", () => {
  for (const s of codex) {
    let expected = 0;
    for (const { lines, meta } of rolloutTree(s.id)) {
      if (meta.cli_version.startsWith("0.122")) expected += ofType(lines, "function_call").length + ofType(lines, "custom_tool_call").length;
      else expected += ofType(lines, "item_completed").filter((l) => TOOL_ITEMS.has(l.payload.item.type)).length;
    }
    const scripts = rolloutTree(s.id).flatMap((r) => selfCountedScripts(r.lines));
    expected += scripts.length;
    const counted = Object.values(s.toolCounts).reduce((a, b) => a + b, 0);
    assert.equal(s.toolCounts.exec ?? 0, scripts.length, `session ${s.id}`);
    // Shown with the script's first line, not a blank row.
    const previews = s.toolSequence.filter((e) => e.tool === "exec").map((e) => e.preview);
    assert.deepEqual(previews.sort(), scripts.map((js) => js.split("\n")[0]).sort(), `session ${s.id}`);
    assert.equal(counted, expected, `session ${s.id}`);
    assert.equal(s.turns.reduce((a, tu) => a + tu.tools.length, 0), counted, `session ${s.id}`);
  }
});

test("flags failed Codex tool calls, with or without an exit code", () => {
  for (const s of codex) {
    const { lines } = rollouts().find((r) => r.id === s.id);
    const failed =
      ofType(lines, "exec_command_end").filter((l) => l.payload.exit_code !== 0).length +
      ofType(lines, "function_call_output").filter((l) => /^(exec_command failed for |aborted by user)/.test(l.payload.output)).length +
      ofType(lines, "mcp_tool_call_end").filter((l) => l.payload.result.Err).length +
      ofType(lines, "item_completed").filter((l) => l.payload.item.status === "failed").length;
    assert.equal(s.toolSequence.filter((e) => e.result?.isError).length, failed, `session ${s.id}`);
  }
  // Including a build that outlived its script.
  assert.ok(codex.some((s) => s.toolSequence.some((e) => e.preview === "pnpm build" && e.result?.isError)));
});

test("groups real MCP calls per server everywhere, not Codex's resource tools", () => {
  const s = codex.find((x) => x.toolCounts["mcp:linear"]);
  assert.ok(s);
  assert.equal(s.toolCounts["mcp:linear"], 1);
  assert.equal(s.toolCounts.list_mcp_resources, 1);
  assert.ok(!Object.keys(s.toolCounts).includes("mcp:docs"));
  assert.ok(s.turns.some((tu) => tu.tools.includes("mcp:linear")));
  assert.ok(!s.turns.some((tu) => tu.tools.includes("linear__list_issues")));
  assert.ok(s.timeline.some((e) => e.tool === "mcp:linear"));
});

test("merges Codex sub-agent rollouts into their parent", () => {
  const children = rollouts().filter((r) => r.meta.thread_source === "subagent");
  let merged = 0;
  for (const s of codex) {
    const kids = children.filter((r) => r.meta.session_id === s.id);
    if (!kids.length) continue;
    merged++;
    assert.equal(s.subAgents, kids.length, `session ${s.id}`);
    const sideTurns = kids.reduce((a, r) => a + ofType(r.lines, "token_count").length, 0);
    assert.ok(s.turns.filter((tu) => tu.sidechain).length > 0 && s.turns.filter((tu) => tu.sidechain).length <= sideTurns, `session ${s.id}`);
    assert.ok(s.timeline.some((e) => e.kind === "agent"), `session ${s.id}`);
  }
  assert.ok(merged > 0);
});

test("lists every tool call once, sub-agent calls under the Agent call that ran them", async () => {
  const { countNestedCalls } = await import("../scripts/subagent-calls.mjs");
  let nested = 0;
  for (const s of parsed.sessions) {
    const total = Object.values(s.toolCounts).reduce((a, n) => a + n, 0);
    // the tab, the KPI and the list count the same calls
    assert.equal(countNestedCalls(s.toolSequence), total, `session ${s.id}`);
    if (s.agent !== "claude") continue;
    const subDir = transcriptsOf(s.id).find((f) => f.includes("/subagents/"))?.replace(/\/[^/]+$/, "");
    for (const e of s.toolSequence) {
      if (!e.children) continue;
      assert.ok(!e.orphan, `session ${s.id}: every seeded sub-agent has its Agent call`);
      assert.equal(e.tool, "Agent");
      assert.ok(e.children.every((c) => c.t >= e.t), "a sub-agent's calls come after the call that started it");
      nested++;
    }
    if (subDir) {
      const runs = readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
      assert.equal(s.toolSequence.filter((e) => e.children).length, runs.length, `session ${s.id}`);
    }
  }
  assert.ok(nested > 0);
});

test("reads the file history of edited files, with their paths", () => {
  const edited = claude.filter((s) => s.toolSequence.some((e) => e.tool === "Edit" || e.tool === "Write"));
  assert.ok(edited.length > 0);
  for (const s of edited) {
    assert.ok(s.fileHistory.length > 0, `session ${s.id}`);
    assert.equal(s.filesChanged, s.fileHistory.length, `session ${s.id}`);
    assert.ok(s.fileHistory.every((f) => f.path?.startsWith("/Users/demo/") && f.versions.length >= 2), `session ${s.id}`);
  }
});

test("names Codex sessions from session_index.jsonl", () => {
  const names = readFileSync(join(CODEX, "session_index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(names.length > 0);
  for (const { id, thread_name } of names) assert.equal(codex.find((s) => s.id === id)?.goal, thread_name, `session ${id}`);
});

test("prices Codex's internal models like GPT, flagged as estimates", async () => {
  const { isKnownModel, normalizeModel, priceFor } = await import("../scripts/models.mjs");
  const id = normalizeModel("codex-auto-review");
  assert.equal(isKnownModel(id), false);
  assert.deepEqual(priceFor(id), priceFor("gpt-5.4"));
});

test("leaves Codex sessions out of badges", async () => {
  const { computeBadges } = await import("../scripts/badges.mjs");
  const state = () => ({ version: 1, startedAt: new Date(0).toISOString(), unlocked: {} });
  const now = Date.now();
  assert.ok(codex.length > 0);
  const all = computeBadges(parsed.sessions, state(), now);
  const claudeOnly = computeBadges(claude, state(), now);
  // Badges and the level's XP ignore Codex; only the streak is overall activity and counts every agent.
  assert.deepEqual(all.families, claudeOnly.families);
  assert.deepEqual(all.level, claudeOnly.level);
});

test("prices every seeded Codex model", () => {
  for (const s of codex) {
    assert.equal(s.unpricedModels, undefined, `session ${s.id}`);
    assert.ok(s.model.startsWith("gpt-"), `session ${s.id}`);
    assert.ok(s.costUsd > 0, `session ${s.id}`);
  }
});

test("keeps incidents (failures, denials, waits on the user) out of the list payload", async () => {
  const all = claude.flatMap((s) => s.incidents);
  assert.ok(all.some((i) => i.kind === "denial" && i.denial === "automode-blocked" && /gh pr merge/.test(i.command)));
  assert.ok(all.some((i) => i.kind === "error" && /no matches found/.test(i.text)));
  const wait = all.find((i) => i.kind === "wait");
  assert.ok(wait.ms >= 18 * 60_000);
  assert.match(wait.text, /retry budget/);
  for (const s of claude) assert.ok(s.incidentStats.toolResults >= s.incidents.filter((i) => i.kind !== "wait").length);
  const { summarizeSession } = await import("../scripts/parse-sessions.mjs");
  assert.equal(summarizeSession(claude[0]).incidents, undefined);
});

test("recommends the seeded frictions", async () => {
  const { buildRecommendations } = await import("../scripts/recommendations.mjs");
  const ids = buildRecommendations(parsed.sessions).cards.map((c) => c.id);
  for (const id of ["cause:zsh-nomatch", "cause:playwright-profile", "denials", "waits"]) assert.ok(ids.includes(id), id);
});
