/**
 * Where a plan window is heading: the % of the limit at its reset if the pace holds, and when the
 * limit is reached if that comes first. A projection of a pace, not a prediction: nobody keeps one
 * rhythm for hours. Pure, so it runs under node:test (no value imports).
 *
 * The 5h window is projected from its last hour: the lower of the paces of the last 15 and the
 * last 60 minutes, so a burst that already stopped and a session that only just started both
 * count for less. Of the estimators tried on 37 recorded Claude windows (limits-history.jsonl,
 * 2026-11-09), it had the smallest typical error: within about 5 points of where the window ended
 * with under 2 hours left, about 19 beyond, where none did better. The week and the month are
 * projected from their pace so far (three recorded weeks: too few to compare anything).
 */
export interface Forecast {
  /** % of the limit at the reset if the pace holds; can pass 100. */
  atReset: number;
  /** When the limit is reached, if before the reset. */
  hitAt: number | null;
  /** %-points per hour the projection assumes. */
  perHour: number;
  /** What the pace was read from: the window's last hour, or the whole window so far. */
  basis: "recent" | "window";
}

export const RECENT_SHORT_MS = 15 * 60_000;
export const RECENT_LONG_MS = 60 * 60_000;
/** A whole-window pace says nothing before this share of the window has elapsed. */
const MIN_ELAPSED = 0.15;
/** How far ahead the last hour's pace is worth a warning (see `forecastLevel`). */
const RELIABLE_MS = 2 * 60 * 60_000;
const HOUR_MS = 3_600_000;

export interface ForecastInput {
  usedPct: number | null;
  resetsAt: number | null;
  fromMs: number | null;
  spanMs: number;
  /**
   * Use inside the window so far (`total`) and in its last 15 (`short`) and 60 (`long`) minutes,
   * in the unit that splits the window between sessions. Given for the 5h window; without it the
   * pace is the window's own.
   */
  recent?: { total: number; short: number; long: number };
}

export function forecastWindow(w: ForecastInput, now: number): Forecast | null {
  const { usedPct, resetsAt, fromMs } = w;
  if (usedPct === null || resetsAt === null || fromMs === null) return null;
  const elapsed = now - fromMs;
  const left = resetsAt - now;
  // Nothing to project once the limit is reached, before anything was used, or outside the window.
  if (!(usedPct > 0) || usedPct >= 100 || left <= 0 || elapsed <= 0) return null;

  let perMs: number;
  if (w.recent) {
    if (elapsed < RECENT_SHORT_MS || !(w.recent.total > 0)) return null;
    // %-points per unit of use, from what the window used so far.
    const points = usedPct / w.recent.total;
    const short = (points * w.recent.short) / Math.min(RECENT_SHORT_MS, elapsed);
    const long = (points * w.recent.long) / Math.min(RECENT_LONG_MS, elapsed);
    perMs = Math.max(0, Math.min(short, long));
  } else {
    if (elapsed / w.spanMs < MIN_ELAPSED) return null;
    perMs = usedPct / elapsed;
  }
  const atReset = usedPct + perMs * left;
  return {
    atReset,
    hitAt: perMs > 0 && atReset >= 100 ? now + (100 - usedPct) / perMs : null,
    perHour: perMs * HOUR_MS,
    basis: w.recent ? "recent" : "window",
  };
}

/** How a forecast reads: a limit reached well before the reset is worth a warning, the rest a note. */
export type ForecastLevel = "hit" | "rise" | "flat";

/**
 * `hit` when the limit comes at least 5% of the window before its reset (15 minutes of a 5h
 * window, 8 hours of a week): closer than that, the pace's own noise decides. From the last
 * hour's pace, also only when it comes within 2 hours: further out the projection is too rough to
 * warn on. On the recorded windows that rule warned 40 to 154 minutes before each of the 4 that
 * reached the limit, and in 5 of the 33 that did not (11 without it). `flat` when the projection
 * adds under 3 points, which is not worth a line.
 */
export function forecastLevel(f: Forecast, w: Pick<ForecastInput, "usedPct" | "resetsAt" | "spanMs">, now: number): ForecastLevel {
  const beforeReset = f.hitAt !== null && w.resetsAt !== null && w.resetsAt - f.hitAt >= 0.05 * w.spanMs;
  if (beforeReset && (f.basis === "window" || f.hitAt! - now <= RELIABLE_MS)) return "hit";
  return f.atReset - (w.usedPct ?? 0) >= 3 ? "rise" : "flat";
}
