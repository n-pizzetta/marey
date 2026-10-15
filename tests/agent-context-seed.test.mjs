// The Context page end to end on the synthetic data from scripts/seed-demo.mjs: the parsers
// collect what each session loaded, remembered and wrote, and buildAgentContext joins it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-context-seed-"));
const CLAUDE = join(root, ".claude");
const CODEX = join(root, ".codex");
const COPILOT = join(root, ".copilot");

let sessions;
let buildAgentContext;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, CODEX, COPILOT], { stdio: "ignore" });
  // The parsers resolve their homes at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = CODEX;
  process.env.COPILOT_HOME = COPILOT;
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  ({ buildAgentContext } = await import("../scripts/agent-context.mjs"));
  ({ sessions } = await parseAllSessions());
});

after(() => rmSync(root, { recursive: true, force: true }));

const context = (project) => buildAgentContext(sessions, { project, home: root, claudeDir: CLAUDE });

test("every Claude Code session records the instruction files it loaded at start", () => {
  const claude = sessions.filter((s) => s.agent === "claude" && !s.transcriptMissing);
  assert.ok(claude.length > 0);
  for (const s of claude) {
    assert.ok(s.agentContext.loads.length >= 1, s.id);
    assert.ok(s.agentContext.loads[0].files.some((f) => f.path === join(CLAUDE, "CLAUDE.md") && f.type === "User"));
  }
});

test("the memory folder grows session by session and is re-read", () => {
  const ctx = context("acme-api");
  const claude = ctx.sessions.filter((s) => s.agent === "claude");
  const written = Math.min(4, claude.length);
  assert.equal(ctx.memory.files.length, written);
  assert.ok(ctx.memory.files.every((f) => f.exists && f.inIndex && f.hook && f.description));
  // The first session wrote the first memory; the third re-read it.
  assert.deepEqual(claude[0].memoryOps.map((o) => [o.op, o.file]), [["write", "project-rate-limits.md"]]);
  if (claude.length >= 3) assert.ok(claude[2].memoryOps.some((o) => o.op === "read" && o.file === "project-rate-limits.md"));
  // From the second session on, the index is among the files read at start.
  if (claude.length >= 2) assert.ok(claude[1].loads.at(-1).files.some((f) => f.type === "AutoMem"));
  // Read from the demo's Claude folder, shown from ~/.claude, never from the real home.
  const user = ctx.instructions.find((i) => i.type === "User");
  assert.deepEqual([user.path, user.lines, user.exists], ["~/.claude/CLAUDE.md", 5, true]);
});

test("sub-agents get their session's instruction files, except Explore", () => {
  const subs = sessions.filter((s) => s.agent === "claude").flatMap((s) => s.agentContext.subagents);
  assert.ok(subs.length > 0);
  assert.equal(subs.filter((a) => a.type === "Explore").length, 1);
  for (const a of subs) {
    if (a.type === "Explore") assert.equal(a.received, "none");
    else assert.ok(Array.isArray(a.received) && a.received.some((f) => f.type === "User"), a.id);
    assert.ok(a.briefChars > 0 && a.brief);
  }
});

test("Codex and Copilot CLI sessions list the files they wrote and their sub-agents", () => {
  const codex = sessions.filter((s) => s.agent === "codex");
  assert.ok(codex.some((s) => s.agentContext.writes.length > 0));
  // Codex encrypts sub-agent briefs.
  for (const a of codex.flatMap((s) => s.agentContext.subagents)) assert.equal(a.briefHidden, true);
  const copilot = sessions.filter((s) => s.agent === "copilot");
  const subs = copilot.flatMap((s) => s.agentContext.subagents);
  assert.ok(subs.length > 0);
  assert.ok(subs.every((a) => a.type && typeof a.toolCalls === "number"));
});
