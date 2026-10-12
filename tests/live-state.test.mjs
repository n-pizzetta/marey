import { test } from "node:test";
import assert from "node:assert/strict";
import { liveStateOf } from "../scripts/parse-sessions.mjs";

const now = Date.parse("2026-10-07T12:00:00Z");
const ago = (s) => now - s * 1000;

test("an open question or plan means the session needs you, whatever its status", () => {
  const q = liveStateOf({ live: { status: "busy" }, pending: { tool: "AskUserQuestion", tsMs: ago(600), ask: "Which branch?" }, now });
  assert.deepEqual(q, { state: "needs-you", reason: "question", text: "Which branch?", since: new Date(ago(600)).toISOString() });
  assert.equal(liveStateOf({ live: { status: "idle" }, pending: { tool: "ExitPlanMode", tsMs: ago(60), ask: "Plan" }, now }).reason, "plan");
});

test("idle with a call still open is a permission prompt; busy is working on that call", () => {
  const pending = { tool: "Bash", tsMs: ago(30), command: "pnpm test\nmore" };
  assert.deepEqual(liveStateOf({ live: { status: "idle" }, pending, now }), { state: "needs-you", reason: "permission", text: "Bash: pnpm test", since: new Date(ago(30)).toISOString() });
  const working = liveStateOf({ live: { status: "busy", statusAt: ago(90) }, pending, now });
  assert.equal(working.state, "working");
  assert.equal(working.since, new Date(ago(90)).toISOString());
});

test("idle with nothing open is your turn, with the last reply", () => {
  const st = liveStateOf({ live: { status: "idle", statusAt: ago(300) }, pending: null, lastText: "Done: 3 commits", now });
  assert.deepEqual(st, { state: "your-turn", text: "Done: 3 commits", since: new Date(ago(300)).toISOString() });
});

test("without a status, recent activity means working", () => {
  assert.equal(liveStateOf({ live: {}, pending: null, lastTs: ago(10), now }).state, "working");
  assert.equal(liveStateOf({ live: {}, pending: null, lastTs: ago(120), now }).state, "your-turn");
});

test("working between two calls shows the last one", () => {
  const st = liveStateOf({ live: { status: "busy" }, pending: null, lastCall: { tool: "Edit", tsMs: ago(5) }, now });
  assert.equal(st.text, "Edit");
});

test("a command's leading cd is left out", () => {
  const st = liveStateOf({ live: { status: "busy" }, pending: { tool: "Bash", tsMs: ago(5), command: "cd /Users/x/project && pnpm test" }, now });
  assert.equal(st.text, "Bash: pnpm test");
});
