// Where a plan window is heading if the pace holds (src/utils/forecast.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastLevel, forecastWindow } from "../src/utils/forecast.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 14, 0);

/** A 5h window `elapsed` old at NOW, with what it used so far and in its last 15 and 60 minutes. */
const five = (usedPct, elapsed, recent) => ({ usedPct, fromMs: NOW - elapsed, resetsAt: NOW - elapsed + 5 * HOUR, spanMs: 5 * HOUR, recent });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} ${a} vs ${b}`);

test("the 5h window is projected from the lower of its last 15 and last 60 minutes' pace", () => {
  // 40% for 100 units of use: 0.4 points a unit. Last hour 30 units (12 points/h), last 15 min 10 units (16 points/h).
  const f = forecastWindow(five(40, 2 * HOUR, { total: 100, short: 10, long: 30 }), NOW);
  assert.equal(f.basis, "recent");
  near(f.perHour, 12);
  near(f.atReset, 40 + 12 * 3);
  assert.equal(f.hitAt, null);
  // A session that only just started: the last 15 minutes run hot, the hour holds the projection back.
  near(forecastWindow(five(40, 2 * HOUR, { total: 100, short: 25, long: 25 }), NOW).perHour, 10);
});

test("says when the limit is reached, if before the reset", () => {
  // 70% used, 35 points an hour on both spans: 30 points to go, so in 30/35 of an hour, with 3h left.
  const w = five(70, 2 * HOUR, { total: 100, short: 12.5, long: 50 });
  const f = forecastWindow(w, NOW);
  near(f.perHour, 35);
  near(f.atReset, 175);
  near(f.hitAt, NOW + (30 / 35) * HOUR);
  assert.equal(forecastLevel(f, w, NOW), "hit");
});

test("a burst that already stopped projects nothing more", () => {
  const w = five(55, 3 * HOUR, { total: 100, short: 0, long: 60 });
  const f = forecastWindow(w, NOW);
  assert.equal(f.perHour, 0);
  assert.equal(f.atReset, 55);
  assert.equal(f.hitAt, null);
  assert.equal(forecastLevel(f, w, NOW), "flat");
});

test("a window younger than an hour is read over its own age, and not at all under 15 minutes", () => {
  // 30 minutes old: everything it used is its last hour's use, over 30 minutes, not 60.
  const f = forecastWindow(five(10, 30 * MIN, { total: 50, short: 25, long: 50 }), NOW);
  near(f.perHour, 20);
  near(f.atReset, 10 + 20 * 4.5);
  assert.equal(forecastWindow(five(4, 10 * MIN, { total: 50, short: 50, long: 50 }), NOW), null);
  assert.equal(forecastWindow(five(40, 2 * HOUR, { total: 0, short: 0, long: 0 }), NOW), null);
});

test("the week and the month are projected from their pace so far", () => {
  const week = (usedPct, elapsedDays) => ({ usedPct, fromMs: NOW - elapsedDays * DAY, resetsAt: NOW + (7 - elapsedDays) * DAY, spanMs: 7 * DAY });
  // 60% in half the week: 120% at the reset, the limit at 100/60 of the time elapsed.
  const w = week(60, 3.5);
  const f = forecastWindow(w, NOW);
  assert.equal(f.basis, "window");
  near(f.atReset, 120);
  near(f.hitAt, w.fromMs + (100 / 60) * 3.5 * DAY);
  near(f.perHour, 60 / (3.5 * 24));
  assert.equal(forecastLevel(f, w, NOW), "hit");
  // Under pace: no limit in sight.
  const slow = forecastWindow(week(30, 3.5), NOW);
  near(slow.atReset, 60);
  assert.equal(slow.hitAt, null);
  // The first day says nothing about the week.
  assert.equal(forecastWindow(week(10, 1), NOW), null);
  assert.notEqual(forecastWindow(week(10, 1.1), NOW), null);
});

test("nothing to project without a limit, a reset time, any use, or once the limit is reached", () => {
  const recent = { total: 100, short: 10, long: 30 };
  assert.equal(forecastWindow({ ...five(40, 2 * HOUR, recent), usedPct: null }, NOW), null);
  assert.equal(forecastWindow({ ...five(40, 2 * HOUR, recent), resetsAt: null }, NOW), null);
  assert.equal(forecastWindow({ ...five(40, 2 * HOUR, recent), fromMs: null }, NOW), null);
  assert.equal(forecastWindow(five(0, 2 * HOUR, recent), NOW), null);
  assert.equal(forecastWindow(five(100, 2 * HOUR, recent), NOW), null);
  assert.equal(forecastWindow(five(40, 5 * HOUR + MIN, recent), NOW), null);
});

test("a limit over 2 hours away, or within the last 5% of the window, is a note, not a warning, and under 3 points nothing", () => {
  // 3h left, 40% used. 40 points/h reaches 100% in 1h30; 22 points/h in 2h44, 16 minutes before the
  // reset: too far for the last hour's pace to warn on; 20.5 points/h 4 minutes before the reset.
  const at = (perHourUnits) => five(40, 2 * HOUR, { total: 100, short: perHourUnits / 4 / 0.4, long: perHourUnits / 0.4 });
  const warn = at(40);
  assert.equal(forecastLevel(forecastWindow(warn, NOW), warn, NOW), "hit");
  const far = at(22);
  assert.notEqual(forecastWindow(far, NOW).hitAt, null);
  assert.equal(forecastLevel(forecastWindow(far, NOW), far, NOW), "rise");
  // Half an hour from the reset the same limit is within reach of the pace: a warning if it leaves 15 minutes.
  const late = five(90, 4.5 * HOUR, { total: 100, short: 12.5, long: 50 });
  assert.equal(forecastLevel(forecastWindow(late, NOW), late, NOW), "hit");
  const close = at(20.5);
  const f = forecastWindow(close, NOW);
  assert.notEqual(f.hitAt, null);
  assert.equal(forecastLevel(f, close, NOW), "rise");
  const calm = at(0.9);
  assert.equal(forecastLevel(forecastWindow(calm, NOW), calm, NOW), "flat");
});
