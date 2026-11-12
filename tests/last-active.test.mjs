// When a session was last active, which orders and groups the session table (src/utils/lastActive.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { byLastActive, lastActiveMs } from "../src/utils/lastActive.ts";

const session = (id, startedAt, lastEventAt) => ({ id, startedAt, lastEventAt });

test("a session started yesterday and used today sorts with today's", () => {
  const yesterdayStillOpen = session("open", "2026-11-11T09:00:00Z", "2026-11-12T10:30:00Z");
  const thisMorning = session("new", "2026-11-12T08:00:00Z", "2026-11-12T08:40:00Z");
  const lastWeek = session("old", "2026-11-05T08:00:00Z", "2026-11-05T09:00:00Z");
  const sorted = [lastWeek, thisMorning, yesterdayStillOpen].sort(byLastActive);
  assert.deepEqual(sorted.map((s) => s.id), ["open", "new", "old"]);
  assert.equal(lastActiveMs(yesterdayStillOpen), Date.parse("2026-11-12T10:30:00Z"));
});

test("a session without events falls back to its start", () => {
  assert.equal(lastActiveMs(session("x", "2026-11-12T08:00:00Z", undefined)), Date.parse("2026-11-12T08:00:00Z"));
});
