// A session started before the range only brings what it did inside it (src/utils/range.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeToRange } from "../src/utils/range.ts";

const now = new Date("2026-10-23T12:00:00");
const min = 60_000;
const tok = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
// Started yesterday at 09:00 with 200 Bash calls; today at 11:00, one prompt and one Read.
const yesterday = new Date("2026-10-22T09:00:00");
const today = new Date("2026-10-23T11:00:00").getTime() - yesterday.getTime();
const session = {
  id: "s",
  model: "opus-5.5",
  startedAt: yesterday.toISOString(),
  durationMs: 10 * 60 * min,
  tokens: tok,
  costUsd: 1,
  toolCounts: { Bash: 200, Read: 1 },
  prompts: [{ t: 0, preview: "yesterday" }, { t: today, preview: "today" }],
  turns: [
    { t: 1 * min, tokens: tok, tools: Array(200).fill("Bash") },
    { t: today + 2 * min, tokens: tok, tools: ["Read"] },
    { t: today + 4 * min, tokens: tok, tools: [] },
  ],
};

test("calls and active time are counted inside the range only", () => {
  const [s] = scopeToRange([session], "today", now);
  assert.deepEqual(s.toolCounts, { Read: 1 });
  assert.equal(s.durationMs, 4 * min);
});

test("a session started inside the range keeps its own figures", () => {
  const [s] = scopeToRange([session], "7d", now);
  assert.deepEqual(s.toolCounts, session.toolCounts);
  assert.equal(s.durationMs, session.durationMs);
});
