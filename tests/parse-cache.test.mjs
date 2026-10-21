// The parser's in-memory caches, against the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-cache-test-"));
const CLAUDE = join(root, ".claude");
const PROJECTS = join(CLAUDE, "projects");

let parser;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, join(root, ".codex"), join(root, ".copilot")], { stdio: "ignore" });
  // The parser resolves CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  parser = await import("../scripts/parse-sessions.mjs");
});

after(() => rmSync(root, { recursive: true, force: true }));

/** A seeded Claude transcript and how many sub-agent transcripts it has. */
function someTranscript() {
  for (const dir of readdirSync(PROJECTS)) {
    const file = readdirSync(join(PROJECTS, dir)).find((f) => f.endsWith(".jsonl"));
    if (!file) continue;
    const subDir = join(PROJECTS, dir, file.replace(/\.jsonl$/, ""), "subagents");
    const subagents = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).length : 0;
    return { path: join(PROJECTS, dir, file), subagents };
  }
  throw new Error("no seeded transcript");
}

test("light sessions match the full parse in the list, and in the detail once opened", async () => {
  const full = await parser.parseAllSessions();
  const light = await parser.parseAllSessions({ light: true });
  assert.equal(light.sessions.length, full.sessions.length);
  const byId = new Map(full.sessions.map((s) => [s.id, s]));
  for (const s of light.sessions) {
    const want = byId.get(s.id);
    assert.deepEqual(parser.summarizeSession(s), parser.summarizeSession(want), `list of ${s.id}`);
    assert.deepEqual(await parser.sessionDetail(s), want, `detail of ${s.id}`);
  }
});

test("light sessions keep no calls, timeline, file paths or prompt texts", async () => {
  const { sessions } = await parser.parseAllSessions({ light: true });
  assert.deepEqual(sessions.filter((s) => s.toolSequence.length || s.timeline.length || s.fileHistory.length).map((s) => s.id), []);
  assert.ok(sessions.some((s) => s.prompts.length > 0));
  assert.ok(sessions.every((s) => s.prompts.every((p) => p.text === undefined && "preview" in p)));
});

test("counts the plugin hook's captures like a full parse, and again after the hook appends", async () => {
  const { sessions } = await parser.parseAllSessions();
  const s = sessions.find((x) => x.agent === "claude" && !x.ghost);
  const dir = join(CLAUDE, "marey", "cache");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.id}.jsonl`);
  const t0 = Date.parse(s.startedAt);
  const call = (i) => JSON.stringify({ kind: "tool", t: t0 + i * 1000, tool: "Bash", inPreview: `{"command":"echo ${i}"}`, outPreview: `${i}` }) + "\n";
  const capture = async (opts) => (await parser.parseAllSessions(opts)).sessions.find((x) => x.id === s.id).pluginCapture;
  writeFileSync(file, call(1) + call(2));
  const full = await capture();
  assert.equal(full.entries, 2);
  // Light parses in a row: the second one reuses the counts, the one after the append reads again.
  assert.deepEqual(await capture({ light: true }), full);
  assert.deepEqual(await capture({ light: true }), full);
  appendFileSync(file, call(3) + JSON.stringify({ kind: "stop", t: t0 + 9000 }) + "\n");
  const appended = await capture({ light: true });
  assert.equal(appended.entries, 3);
  assert.deepEqual(appended, await capture());
});

test("tells running Claude Code processes from other and finished ones with one ps", { skip: process.platform === "win32" }, async () => {
  // A process whose command is named claude: node behind a symlink.
  const claude = join(root, "claude");
  symlinkSync(process.execPath, claude);
  const child = spawn(claude, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const finished = 2 ** 22 + 1; // above any pid macOS or Linux hands out by default
    assert.deepEqual([...parser.claudePids([child.pid, process.pid, finished, null])], [child.pid]);
  } finally {
    child.kill();
  }
});

test("drops a deleted transcript and its sub-agents from the cache at the next parse", async () => {
  await parser.parseAllSessions();
  const before = parser.cachedTranscriptCount();
  const { path, subagents } = someTranscript();
  rmSync(path);
  await parser.parseAllSessions();
  assert.equal(parser.cachedTranscriptCount(), before - 1 - subagents);
});
