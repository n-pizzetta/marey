// The x stretch a zoomable chart shows (src/utils/zoomRange.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSpan, isZoomed, panBy, zoomAround } from "../src/utils/zoomRange.ts";

const full = [0, 100];

test("a stretch stays inside the chart and no narrower than the least zoom", () => {
  assert.deepEqual(clampSpan([90, 120], full, 5), [70, 100]);
  assert.deepEqual(clampSpan([-10, 10], full, 5), [0, 20]);
  assert.deepEqual(clampSpan([50, 51], full, 6), [47.5, 53.5]);
  assert.deepEqual(clampSpan([-50, 500], full, 6), [0, 100]);
});

test("a pinch keeps the point under the pointer where it is", () => {
  const v = zoomAround([0, 100], 25, 0.5, full, 1);
  assert.deepEqual(v, [12.5, 62.5]);
  // 25 sits a quarter of the way in, before and after
  assert.equal((25 - v[0]) / (v[1] - v[0]), 0.25);
  assert.deepEqual(zoomAround(v, 25, 10, full, 1), [0, 100]);
});

test("a swipe moves a zoomed stretch up to the chart's edges", () => {
  assert.deepEqual(panBy([10, 30], 15, full), [25, 45]);
  assert.deepEqual(panBy([10, 30], 500, full), [80, 100]);
  assert.deepEqual(panBy([10, 30], -500, full), [0, 20]);
  assert.equal(isZoomed([0, 100], full), false);
  assert.equal(isZoomed([0, 99], full), true);
});
