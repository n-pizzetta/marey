// Which sessions show their status line snapshot as live (src/utils/liveContext.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSnapshot } from "../src/utils/liveContext.ts";

const ID = "0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const snap = { v: 1, sessionId: ID, capturedAt: Date.now() - 60_000, model: null, costUsd: null, context: { usedPct: 19, size: 200_000, tokens: 38_000 }, cache: null };
const snaps = new Map([[ID, snap]]);

test("a recent snapshot of a session that no longer runs gives no context line", () => {
  assert.equal(liveSnapshot({ id: ID, live: false }, snaps), undefined);
  assert.equal(liveSnapshot({ id: ID }, snaps), undefined);
});

test("a running session shows its snapshot, whatever its agent", () => {
  // Claude Code, Codex and Copilot CLI all write live/<id>.json; `live` comes from each one's own check.
  for (const agent of ["claude", "codex", "copilot"]) assert.equal(liveSnapshot({ id: ID, agent, live: true }, snaps), snap);
  assert.equal(liveSnapshot({ id: "another", live: true }, snaps), undefined);
});
