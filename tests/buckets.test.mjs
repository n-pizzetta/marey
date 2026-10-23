// The usage chart's buckets sit on clock boundaries (src/utils/fleetStats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketizeByProject } from "../src/utils/fleetStats.ts";

const at = (h, m) => new Date(2026, 9, 20, h, m).getTime();
const tok = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
const start = at(14, 0);
const session = {
  id: "s",
  project: "p",
  model: "opus-5.5",
  startedAt: new Date(start).toISOString(),
  turns: [14 * 60 + 20, 14 * 60 + 50, 15 * 60 + 10].map((min) => ({ t: (min - 14 * 60) * 60_000, tokens: tok, tools: [] })),
};

test("hourly bars run from the hour, and only count what came after the range start", () => {
  const buckets = bucketizeByProject([session], "7d", at(14, 37), at(16, 0));
  assert.deepEqual(buckets.map((b) => new Date(b.fromMs).getHours()), [14, 15]);
  assert.equal(buckets[0].fromMs, at(14, 0));
  // 14:20 is before the range start; 14:50 and 15:10 fall in their hours.
  assert.equal(buckets[0].byProject.get("p").input, 1);
  assert.equal(buckets[1].byProject.get("p").input, 1);
});

test("daily bars run from midnight", () => {
  const buckets = bucketizeByProject([session], "all", at(9, 12), at(9, 12) + 3 * 86_400_000);
  for (const b of buckets) {
    const d = new Date(b.fromMs);
    assert.equal(d.getHours() * 60 + d.getMinutes(), 0);
  }
});
