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

test("drops a deleted transcript and its sub-agents from the cache at the next parse", async () => {
  await parser.parseAllSessions();
  const before = parser.cachedTranscriptCount();
  const { path, subagents } = someTranscript();
  rmSync(path);
  await parser.parseAllSessions();
  assert.equal(parser.cachedTranscriptCount(), before - 1 - subagents);
});
