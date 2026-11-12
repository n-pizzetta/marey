import type { Session } from "../types";
import type { Range } from "./range";
import { costOf, modelFamily } from "../../scripts/models.mjs";

export type TokenBundle = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function costOfTokens(model: string, t: TokenBundle): number {
  return costOf(model, t);
}

export function sumTokens(t: TokenBundle): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** Every input token: fresh, read from the prompt cache and written to it. */
export function inputTokens(t: TokenBundle): number {
  return t.input + t.cacheRead + t.cacheWrite;
}

/**
 * Share of the input read from the prompt cache. A cache write is input read fresh too: Claude models
 * bill all but the last few tokens of an uncached prompt as cache write, so without it nearly every
 * Claude Code and Copilot session reads 100%. Codex never writes.
 */
export function cacheHit(t: TokenBundle): number {
  const all = inputTokens(t);
  return all > 0 ? t.cacheRead / all : 0;
}

/** Sum tokens from all turns whose absolute timestamp (startedAt + turn.t) falls in [fromMs, toMs]. */
export function tokensInWindow(sessions: Session[], fromMs: number, toMs: number): { tokens: TokenBundle; cost: number } {
  const tokens: TokenBundle = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  for (const s of sessions) {
    if (!s.turns || s.turns.length === 0) continue;
    const startMs = new Date(s.startedAt).getTime();
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts < fromMs || ts > toMs) continue;
      tokens.input += t.tokens.input;
      tokens.output += t.tokens.output;
      tokens.cacheRead += t.tokens.cacheRead;
      tokens.cacheWrite += t.tokens.cacheWrite;
      cost += costOfTokens(t.model ?? s.model, t.tokens);
    }
  }
  return { tokens, cost };
}

/** Sessions considered "active" for live monitoring: explicit live flag OR lastEventAt within freshWindowMs. */
export function activeSessions(sessions: Session[], freshWindowMs = 5 * 60_000, nowMs: number = Date.now()): Session[] {
  return sessions.filter((s) => {
    if (s.live) return true;
    if (s.lastEventAt) {
      const last = new Date(s.lastEventAt).getTime();
      return nowMs - last <= freshWindowMs;
    }
    return false;
  });
}

/** A series' tokens in a bucket, and their API value priced turn by turn with each turn's model. */
export type BucketCell = TokenBundle & { cost: number };
/** What the usage chart stacks: each project, or each model (a session that switched models splits). */
export type SeriesBy = "project" | "model";
export type TimeBucket = { fromMs: number; toMs: number; bySeries: Map<string, BucketCell> };

export function bucketSizeMs(range: Range): number {
  switch (range) {
    case "today": return 15 * 60_000;     // 15 min
    case "7d": return 60 * 60_000;        // 1 h
    case "30d": return 6 * 60 * 60_000;   // 6 h
    case "all": return 24 * 60 * 60_000;  // 1 day
  }
}

/** Bucket sizes a zoomed chart picks from, all on clock boundaries. */
const ZOOM_STEPS = [5, 15, 30, 60, 180, 360, 1440].map((m) => m * 60_000);
/** At most this many bars in a zoomed chart. */
const ZOOM_MAX_BARS = 96;

/** The finest bucket size that keeps a span of `spanMs` to at most 96 bars. */
export function zoomStep(spanMs: number): number {
  return ZOOM_STEPS.find((step) => spanMs / step <= ZOOM_MAX_BARS) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

/** The local clock time a bucket of `step` starts at: the hour, a quarter, 00/06/12/18 h or midnight. */
function bucketStart(ms: number, step: number): number {
  const d = new Date(ms);
  if (step >= 86_400_000) d.setHours(0, 0, 0, 0);
  else if (step >= 3_600_000) d.setHours(d.getHours() - (d.getHours() % (step / 3_600_000)), 0, 0, 0);
  else d.setMinutes(d.getMinutes() - (d.getMinutes() % (step / 60_000)), 0, 0);
  return d.getTime();
}

/** The next bucket's start, on the local clock (a day around a DST change is 23 or 25 hours). */
function nextBucket(ms: number, step: number): number {
  const d = new Date(ms);
  if (step >= 3_600_000) d.setHours(d.getHours() + step / 3_600_000);
  else d.setMinutes(d.getMinutes() + step / 60_000);
  return d.getTime();
}

/**
 * Tokens per project or per model in buckets of `step` on clock boundaries (a 1 h bar is
 * 14:00–15:00, not 14:37–15:37). The first bucket starts before `fromMs` but only holds what came
 * after it.
 */
export function bucketize(sessions: Session[], fromMs: number, toMs: number, step: number, by: SeriesBy = "project"): TimeBucket[] {
  if (step <= 0 || toMs <= fromMs) return [];
  const buckets: TimeBucket[] = [];
  for (let b = bucketStart(fromMs, step); b < toMs; ) {
    const next = nextBucket(b, step);
    buckets.push({ fromMs: b, toMs: next, bySeries: new Map() });
    b = next;
  }
  for (const s of sessions) {
    if (!s.turns || s.turns.length === 0) continue;
    const startMs = new Date(s.startedAt).getTime();
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts < fromMs || ts >= toMs) continue;
      // last bucket starting at or before ts
      let lo = 0;
      let hi = buckets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (buckets[mid].fromMs <= ts) lo = mid;
        else hi = mid - 1;
      }
      const model = t.model ?? s.model;
      const key = by === "model" ? model : s.project || "unknown";
      const cur = buckets[lo].bySeries.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      cur.input += t.tokens.input;
      cur.output += t.tokens.output;
      cur.cacheRead += t.tokens.cacheRead;
      cur.cacheWrite += t.tokens.cacheWrite;
      cur.cost += costOfTokens(model, t.tokens);
      buckets[lo].bySeries.set(key, cur);
    }
  }
  return buckets;
}

/** Projects or models, heaviest in tokens first. */
export function seriesByTokens(sessions: Session[], by: SeriesBy): string[] {
  const total = new Map<string, number>();
  for (const s of sessions) {
    const usage = by === "model" ? s.modelUsage ?? { [s.model]: { tokens: sumTokens(s.tokens) } } : { [s.project || "unknown"]: { tokens: sumTokens(s.tokens) } };
    for (const [key, u] of Object.entries(usage)) if (u.tokens > 0) total.set(key, (total.get(key) ?? 0) + u.tokens);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function rangeBoundsMs(sessions: Session[], range: Range, now: number = Date.now()): { fromMs: number; toMs: number } {
  const toMs = now;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { fromMs: d.getTime(), toMs };
  }
  if (range === "7d") return { fromMs: now - 7 * 86_400_000, toMs };
  if (range === "30d") return { fromMs: now - 30 * 86_400_000, toMs };
  // all — earliest session start
  if (sessions.length === 0) return { fromMs: now - 86_400_000, toMs };
  const earliest = Math.min(...sessions.map((s) => new Date(s.startedAt).getTime()));
  return { fromMs: earliest, toMs };
}

export const FIVE_HOUR_MS = 5 * 60 * 60_000;
export const SESSION_IDLE_GAP_MS = 30 * 60_000;

/**
 * First turn timestamp strictly after `afterMs` and at or before `nowMs`.
 * Used to anchor a fresh 5h window on the first message that arrives after
 * the previous window expired (or after epoch if none was recorded).
 */
export function firstEventAfter(sessions: Session[], afterMs: number, nowMs: number = Date.now()): number | null {
  let earliest: number | null = null;
  for (const s of sessions) {
    if (!s.turns || s.turns.length === 0) continue;
    const startMs = new Date(s.startedAt).getTime();
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts <= afterMs || ts > nowMs) continue;
      if (earliest === null || ts < earliest) earliest = ts;
    }
  }
  return earliest;
}

/**
 * Resolve the start of the current 5h window.
 *
 * - If a stored `windowStart` is still inside its 5h, honor it (manual
 *   calibration or previously detected anchor stay sticky).
 * - Otherwise look for the first message that arrived after the previous
 *   window expired. That message starts the next window.
 * - Returns null when no eligible message exists yet.
 */
export function resolveWindowStartMs(
  sessions: Session[],
  windowStart: number | null,
  nowMs: number = Date.now(),
): number | null {
  if (windowStart && windowStart <= nowMs && nowMs < windowStart + FIVE_HOUR_MS) {
    return windowStart;
  }
  const lastExpiry = windowStart ? windowStart + FIVE_HOUR_MS : 0;
  return firstEventAfter(sessions, lastExpiry, nowMs);
}

const ZERO_BURN: { tokens: TokenBundle; cost: number } = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
};

export function tokensIn5h(
  sessions: Session[],
  nowMs: number = Date.now(),
  windowStart: number | null = null,
): { tokens: TokenBundle; cost: number } {
  const fromMs = resolveWindowStartMs(sessions, windowStart, nowMs);
  if (fromMs === null) return { tokens: { ...ZERO_BURN.tokens }, cost: 0 };
  return tokensInWindow(sessions, fromMs, nowMs);
}

/**
 * The colors of chart series (projects, models), in this order: six hues checked for colorblind and
 * normal-vision separation side by side on the dark surface (`--series-*` in index.css). A seventh
 * series folds into "other".
 */
export const SERIES_PALETTE = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
export const PROJECT_PALETTE = SERIES_PALETTE;
export const OTHER_COLOR = "var(--c-text-faint)";

/**
 * Each key, heaviest first, gets its own color (`preferred`), unless a heavier one took it: then the
 * next free one. Keys past the palette are left out (they fold into "other"). So a color follows its
 * project or model, and two series on screen never share one.
 */
export function distinctColors(keys: string[], preferred: (key: string) => string): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const key of keys) {
    let color: string | undefined = preferred(key);
    if (used.has(color)) color = SERIES_PALETTE.find((c) => !used.has(c));
    if (!color) break;
    used.add(color);
    out.set(key, color);
  }
  return out;
}

/** A model family's own slot: the same model keeps its color across ranges and filters. */
const FAMILY_SLOT: Record<string, number> = { sonnet: 0, fable: 1, mythos: 1, haiku: 2, opus: 3, gpt: 4, codex: 4 };

export function modelColor(model: string): string {
  const slot = FAMILY_SLOT[modelFamily(model)];
  return SERIES_PALETTE[slot ?? 5];
}

let projectOrder = new Map<string, number>();

/**
 * Call when the session list loads: projects get palette slots in alphabetical order, so a
 * project keeps its color across ranges and filters, with no collision up to the palette size.
 */
export function registerProjects(names: Iterable<string>): void {
  projectOrder = new Map([...new Set(names)].sort().map((p, i) => [p, i]));
}

export function projectColor(project: string): string {
  let idx = projectOrder.get(project);
  if (idx === undefined) {
    idx = 0;
    for (let i = 0; i < project.length; i++) idx = (idx * 31 + project.charCodeAt(i)) >>> 0;
  }
  return PROJECT_PALETTE[idx % PROJECT_PALETTE.length];
}
