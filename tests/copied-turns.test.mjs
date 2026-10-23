// A message copied into another transcript counts once (scripts/parse-sessions.mjs, copiedTurns).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-copies-"));
const CLAUDE = join(root, ".claude");
const PROJECT = join(CLAUDE, "projects", "-tmp-x");

const ORIGINAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SNAPSHOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASIDE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ts = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + s * 1000).toISOString();
/** Lines as Claude Code writes them: `sessionId` and `session_id` both name the session. */
const user = (s, text, ids, extra = {}) =>
  JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), ...ids, ...extra, message: { role: "user", content: text } });
const asst = (s, msgId, ids, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts(s),
    requestId: `req_${msgId}`,
    ...ids,
    ...extra,
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: `tu_${msgId}`, name: "Bash", input: { command: "ls" } }],
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
const of = (id) => ({ sessionId: id, session_id: id });
const write = (path, lines) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
};

let sessions;
let sessionDetail;
const byId = (id) => sessions.find((s) => s.id === id);

before(async () => {
  const original = [user(0, "start", of(ORIGINAL)), asst(1, "msg_o1", of(ORIGINAL)), user(2, "more", of(ORIGINAL)), asst(3, "msg_o2", of(ORIGINAL))];
  write(join(PROJECT, `${ORIGINAL}.jsonl`), [...original, user(900, "later", of(ORIGINAL)), asst(901, "msg_o3", of(ORIGINAL))]);
  // A background fork: the conversation so far under the fork's sessionId and the original's
  // session_id, then its own work.
  const copy = { sessionId: FORK, session_id: ORIGINAL, sessionKind: "bg" };
  write(join(PROJECT, `${FORK}.jsonl`), [
    user(0, "start", copy), asst(1, "msg_o1", copy), user(2, "more", copy), asst(3, "msg_o2", copy),
    user(600, "go on", of(FORK)), asst(601, "msg_f1", of(FORK)),
  ]);
  // Another transcript holding the start of the original, under the original's ids, that stops first.
  write(join(PROJECT, `${SNAPSHOT}.jsonl`), original.slice(0, 2));
  // An aside question starts from a copy of its session's conversation.
  write(join(PROJECT, `${ASIDE}.jsonl`), [user(0, "hi", of(ASIDE)), asst(1, "msg_a1", of(ASIDE)), user(2, "and", of(ASIDE)), asst(3, "msg_a2", of(ASIDE))]);
  const side = { ...of(ASIDE), isSidechain: true, agentId: "aside_question-1" };
  write(join(PROJECT, ASIDE, "subagents", "agent-aside_question-1.jsonl"), [
    user(4, "a side question", side), asst(1, "msg_a1", side), asst(3, "msg_a2", side), asst(5, "msg_s1", side),
  ]);
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  const parser = await import("../scripts/parse-sessions.mjs");
  sessions = (await parser.parseAllSessions({ light: true })).sessions;
  sessionDetail = parser.sessionDetail;
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a background fork counts only what it did after the fork", () => {
  assert.equal(byId(ORIGINAL).turns.length, 3);
  assert.equal(byId(ORIGINAL).tokens.input, 30);
  const fork = byId(FORK);
  assert.equal(fork.turns.length, 1);
  assert.equal(fork.tokens.input, 10);
  assert.deepEqual(fork.toolCounts, { Bash: 1 });
});

test("a copy under the original's session id leaves the messages to the original", () => {
  assert.equal(byId(SNAPSHOT).turns.length, 0);
  assert.equal(byId(SNAPSHOT).costUsd, 0);
  assert.equal(byId(ORIGINAL).turns.length, 3);
});

test("a sub-agent's copy of its session's conversation is not counted again", () => {
  const s = byId(ASIDE);
  assert.equal(s.turns.length, 3);
  assert.equal(s.tokens.input, 30);
  assert.deepEqual(s.toolCounts, { Bash: 3 });
});

test("the opened session drops the same copies", async () => {
  const detail = await sessionDetail(byId(FORK));
  assert.equal(detail.turns.length, 1);
});
