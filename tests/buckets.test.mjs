// The usage chart's buckets sit on clock boundaries (src/utils/fleetStats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERIES_PALETTE, bucketize, bucketSizeMs, distinctColors, zoomStep } from "../src/utils/fleetStats.ts";

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
  const buckets = bucketize([session], at(14, 37), at(16, 0), bucketSizeMs("7d"));
  assert.deepEqual(buckets.map((b) => new Date(b.fromMs).getHours()), [14, 15]);
  assert.equal(buckets[0].fromMs, at(14, 0));
  // 14:20 is before the range start; 14:50 and 15:10 fall in their hours.
  assert.equal(buckets[0].bySeries.get("p").input, 1);
  assert.equal(buckets[1].bySeries.get("p").input, 1);
});

test("daily bars run from midnight", () => {
  const buckets = bucketize([session], at(9, 12), at(9, 12) + 3 * 86_400_000, bucketSizeMs("all"));
  for (const b of buckets) {
    const d = new Date(b.fromMs);
    assert.equal(d.getHours() * 60 + d.getMinutes(), 0);
  }
});

test("a zoomed stretch gets the finest clock bars that keep it to 96", () => {
  const h = 3_600_000;
  assert.equal(zoomStep(2 * h), 5 * 60_000);
  assert.equal(zoomStep(20 * h), 15 * 60_000);
  assert.equal(zoomStep(3 * 24 * h), 60 * 60_000);
  assert.equal(zoomStep(400 * 24 * h), 24 * h);
  const buckets = bucketize([session], at(14, 0), at(16, 0), zoomStep(2 * h));
  assert.equal(buckets.length, 24);
  assert.equal(buckets.reduce((n, b) => n + (b.bySeries.get("p")?.input ?? 0), 0), 3);
});

test("each series keeps its own color unless a heavier one took it, and past the palette folds", () => {
  const [a, b, c] = SERIES_PALETTE;
  const preferred = { x: a, y: a, z: c };
  const colors = distinctColors(["x", "y", "z"], (k) => preferred[k] ?? a);
  assert.deepEqual([...colors], [["x", a], ["y", b], ["z", c]]);
  const many = distinctColors(Array.from({ length: 9 }, (_, i) => `p${i}`), () => a);
  assert.equal(many.size, SERIES_PALETTE.length);
  assert.equal(new Set(many.values()).size, SERIES_PALETTE.length);
});
