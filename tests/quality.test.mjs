// Context quality against a known window (scripts/quality.mjs): the transcript has none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQualityTracker, withWindow } from "../scripts/quality.mjs";

/** A session whose context peaked at `peak` tokens over `n` turns, with nothing else wasted. */
function quality(peak, n = 6) {
  const turns = Array.from({ length: n }, (_, i) => ({ tokens: { input: 0, cacheRead: Math.round((peak * (i + 1)) / n), cacheWrite: 0 } }));
  return createQualityTracker().finish(turns);
}

test("a peak under 200k is read against 200k until the window is known", () => {
  const q = quality(180_000);
  assert.equal(q.window, 200_000);
  assert.equal(Math.round(q.fillPct), 90);
  assert.equal(q.band, "critical");

  const known = withWindow(q, 1_000_000);
  assert.equal(known.window, 1_000_000);
  assert.equal(Math.round(known.fillPct), 18);
  assert.equal(known.band, "healthy");
  assert.ok(known.score > q.score);
  assert.equal(known.signals.find((s) => s.kind === "context_fill").detail, "Peak context 180k of 1000k (18%)");
  // The other signals are kept as they were.
  assert.deepEqual(known.signals.filter((s) => s.kind !== "context_fill"), q.signals.filter((s) => s.kind !== "context_fill"));
});

test("a window smaller than the peak, the same one, or none changes nothing", () => {
  const q = quality(500_000);
  assert.equal(q.window, 1_000_000);
  assert.equal(withWindow(q, 200_000), q);
  assert.equal(withWindow(q, 1_000_000), q);
  assert.equal(withWindow(q, null), q);
  assert.equal(withWindow(null, 1_000_000), null);
});
