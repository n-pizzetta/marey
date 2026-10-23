// Prompts past the cap and renamed sessions (scripts/parse-sessions.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-edges-"));
const CLAUDE = join(root, ".claude");
const PROJECT = join(CLAUDE, "projects", "-tmp-x");

const LONG = "55555555-5555-4555-8555-555555555555";
const RENAMED = "66666666-6666-4666-8666-666666666666";

const ts = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + s * 1000).toISOString();
const user = (s, text) => JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), message: { role: "user", content: text } });
const asst = (s) => JSON.stringify({ type: "assistant", timestamp: ts(s), message: { id: `m${s}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } });
const title = (s, name) => JSON.stringify({ type: "custom-title", customTitle: name, sessionId: RENAMED, timestamp: ts(s) });
const transcript = (id, lines) => writeFileSync(join(PROJECT, `${id}.jsonl`), `${lines.join("\n")}\n`);

let sessions;

before(async () => {
  mkdirSync(PROJECT, { recursive: true });
  // 105 prompts, each answered by one turn.
  transcript(LONG, Array.from({ length: 105 }, (_, i) => [user(i * 10, `prompt ${i + 1}`), asst(i * 10 + 1)]).flat());
  transcript(RENAMED, [title(0, "first name"), user(1, "hi"), asst(2), title(3, "second name")]);
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  sessions = (await parseAllSessions()).sessions;
});

after(() => rmSync(root, { recursive: true, force: true }));

test("turns after the 100th prompt are attributed to no prompt, not to the 100th", () => {
  const s = sessions.find((x) => x.id === LONG);
  assert.equal(s.prompts.length, 100);
  const idx = s.turns.map((t) => t.promptIdx);
  assert.equal(idx.filter((i) => i === 99).length, 1);
  assert.equal(idx.filter((i) => i === undefined).length, 5);
});

test("a renamed session takes its latest title", () => {
  assert.equal(sessions.find((x) => x.id === RENAMED).customTitle, "second name");
});
