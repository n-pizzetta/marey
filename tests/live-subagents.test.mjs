// A running session's sub-agents (liveSubagentsOf in scripts/parse-sessions.mjs), on the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-subagents-"));
const CLAUDE = join(root, ".claude");
const PROJECTS = join(CLAUDE, "projects");

let parser;
let child;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, join(root, ".codex"), join(root, ".copilot")], { stdio: "ignore" });
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  parser = await import("../scripts/parse-sessions.mjs");
});

after(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

const now = Date.now();
const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

test("running: not ended and written to lately; the others count as done", () => {
  const sub = (o) => ({ agentId: "a", agentName: null, agentType: "general-purpose", description: "Audit", firstTs: now - 600_000, lastTs: now - 60_000, ended: false, lastCall: null, ...o });
  const subs = [
    sub({ agentId: "late", agentName: "prover", firstTs: now - 120_000, lastCall: { tool: "Bash", command: "cd /x && pnpm test\nmore" } }),
    sub({ agentId: "early", agentType: null, lastCall: { tool: "Read", file: "/x/src/app.ts" } }),
    sub({ agentId: "done", ended: true }),
    sub({ agentId: "stopped", lastTs: now - 31 * 60_000 }),
  ];
  assert.deepEqual(parser.liveSubagentsOf(subs, now), {
    running: [
      { id: "early", name: "sub-agent", description: "Audit", startedAt: new Date(now - 600_000).toISOString(), call: "Read: app.ts" },
      { id: "late", name: "prover", description: "Audit", startedAt: new Date(now - 120_000).toISOString(), call: "Bash: pnpm test" },
    ],
    done: 2,
  });
});

const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 };
const prompt = (min) => ({ type: "user", timestamp: at(min), message: { role: "user", content: "Check the parser" } });
const call = (min, id, name = "Bash", input = { command: "pnpm test" }) => ({
  type: "assistant", timestamp: at(min), message: { id: `msg_${id}`, role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", usage, content: [{ type: "tool_use", id, name, input }] },
});
const result = (min, id, extra = {}) => ({ type: "user", timestamp: at(min), ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const reply = (min, id) => ({
  type: "assistant", timestamp: at(min), message: { id: `msg_${id}`, role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: "Done." }] },
});
const interrupted = (min) => ({ type: "user", timestamp: at(min), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });

test("a running session lists the sub-agents still at work, read from their transcripts", { skip: process.platform === "win32" }, async () => {
  // A seeded session with no sub-agents of its own, made running: a pid file and a process named claude.
  const dir = readdirSync(PROJECTS).map((d) => join(PROJECTS, d)).find((d) => readdirSync(d).some((f) => f.endsWith(".jsonl") && !existsSync(join(d, f.replace(/\.jsonl$/, ""), "subagents"))));
  const id = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !existsSync(join(dir, f.replace(/\.jsonl$/, ""), "subagents"))).replace(/\.jsonl$/, "");
  const claude = join(root, "claude");
  symlinkSync(process.execPath, claude);
  child = spawn(claude, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  mkdirSync(join(CLAUDE, "sessions"), { recursive: true });
  writeFileSync(join(CLAUDE, "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id, cwd: "/tmp/demo", startedAt: now - 3_600_000, status: "busy" }));

  const subDir = join(dir, id, "subagents");
  mkdirSync(subDir, { recursive: true });
  const write = (name, lines, meta) => {
    writeFileSync(join(subDir, `agent-${name}.jsonl`), lines.map((l) => JSON.stringify({ ...l, isSidechain: true, agentId: name, sessionId: id })).join("\n") + "\n");
    if (meta) writeFileSync(join(subDir, `agent-${name}.meta.json`), JSON.stringify(meta));
  };
  write("tester", [prompt(5), call(4, "t1"), result(3, "t1"), call(1, "t2", "Bash", { command: "pnpm lint" })], { agentType: "general-purpose", name: "tester", description: "Run the checks" });
  write("builder", [prompt(20), call(19, "t3", "Bash", { command: "pnpm build" })], { agentType: "general-purpose", description: "Build it" });
  write("replied", [prompt(10), call(9, "t4"), result(8, "t4"), reply(2, "r4")]);
  write("handed", [prompt(10), call(9, "t5", "SubagentHandback", {}), result(8, "t5", { toolEndsTurn: true })]);
  write("interrupted", [prompt(10), call(9, "t6"), interrupted(8)]);
  write("stopped", [prompt(120), call(100, "t7")]);

  const subagentsOf = async (light) => (await parser.parseAllSessions({ light })).sessions.find((s) => s.id === id);
  const s = await subagentsOf(true);
  assert.equal(s.live, true);
  assert.deepEqual(s.liveSubagents, {
    running: [
      { id: "builder", name: "general-purpose", description: "Build it", startedAt: at(20), call: "Bash: pnpm build" },
      { id: "tester", name: "tester", description: "Run the checks", startedAt: at(5), call: "Bash: pnpm lint" },
    ],
    done: 4,
  });
  assert.deepEqual(parser.summarizeSession(s).liveSubagents, s.liveSubagents);
  assert.deepEqual((await subagentsOf(false)).liveSubagents, s.liveSubagents);

  // The tester replies: read from where the last parse stopped, it is done too.
  appendFileSync(join(subDir, "agent-tester.jsonl"), [result(0.5, "t2"), reply(0.2, "r2")].map((l) => JSON.stringify({ ...l, isSidechain: true, agentId: "tester", sessionId: id })).join("\n") + "\n");
  const after = (await subagentsOf(true)).liveSubagents;
  assert.deepEqual(after.running.map((r) => r.id), ["builder"]);
  assert.equal(after.done, 5);
});
