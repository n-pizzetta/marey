// One unexpected record leaves the rest of the parse alone (scripts/parse-sessions.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-malformed-"));
const CLAUDE = join(root, ".claude");
const PROJECT = join(CLAUDE, "projects", "-tmp-x");
const META = join(CLAUDE, "usage-data", "session-meta");

const GOOD = "11111111-1111-4111-8111-111111111111";
const NULL_LINE = "22222222-2222-4222-8222-222222222222";
const NULL_BLOCK = "33333333-3333-4333-8333-333333333333";
const BAD_META = "44444444-4444-4444-8444-444444444444";

const ts = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
const user = (s, text) => JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), message: { role: "user", content: text } });
const asst = (s, content) => JSON.stringify({ type: "assistant", timestamp: ts(s), message: { id: `m${s}`, role: "assistant", model: "claude-opus-5-5", content, usage: { input_tokens: 1, output_tokens: 1 } } });
const transcript = (id, lines) => writeFileSync(join(PROJECT, `${id}.jsonl`), `${lines.join("\n")}\n`);

let result;

before(async () => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(META, { recursive: true });
  transcript(GOOD, [user(0, "good"), asst(1, [{ type: "text", text: "ok" }])]);
  transcript(NULL_LINE, [user(0, "hi"), "null", asst(1, [{ type: "text", text: "ok" }])]);
  transcript(NULL_BLOCK, [user(0, "hi"), asst(1, [null, { type: "text", text: "ok" }])]);
  writeFileSync(join(META, `${BAD_META}.json`), JSON.stringify({ session_id: BAD_META, start_time: "not a date", project_path: "/tmp/x" }));
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  result = await parseAllSessions({ light: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a null line or a null content block is skipped, the session still parses", () => {
  const ids = result.sessions.map((s) => s.id);
  for (const id of [GOOD, NULL_LINE, NULL_BLOCK]) assert.ok(ids.includes(id), id);
});

test("a session-meta file with an invalid start time is a parse error, not a crash", () => {
  assert.ok(result.errors.includes(`${BAD_META}.json`));
  assert.ok(!result.sessions.some((s) => s.id === BAD_META));
});
