// The parser's in-memory caches, against the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("drops a deleted transcript and its sub-agents from the cache at the next parse", async () => {
  await parser.parseAllSessions();
  const before = parser.cachedTranscriptCount();
  const { path, subagents } = someTranscript();
  rmSync(path);
  await parser.parseAllSessions();
  assert.equal(parser.cachedTranscriptCount(), before - 1 - subagents);
});
