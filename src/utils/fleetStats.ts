import type { Session } from "../types";
import type { Range } from "./range";
import { costOf } from "../../scripts/models.mjs";

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

/** A project's tokens in a bucket, and their API value priced turn by turn with each turn's model. */
export type BucketCell = TokenBundle & { cost: number };
export type TimeBucket = { fromMs: number; toMs: number; byProject: Map<string, BucketCell> };

export function bucketSizeMs(range: Range): number {
  switch (range) {
    case "today": return 15 * 60_000;     // 15 min
    case "7d": return 60 * 60_000;        // 1 h
    case "30d": return 6 * 60 * 60_000;   // 6 h
    case "all": return 24 * 60 * 60_000;  // 1 day
  }
}

export function bucketizeByProject(sessions: Session[], range: Range, fromMs: number, toMs: number): TimeBucket[] {
  const step = bucketSizeMs(range);
  if (step <= 0 || toMs <= fromMs) return [];
  const buckets: TimeBucket[] = [];
  for (let b = fromMs; b < toMs; b += step) {
    buckets.push({ fromMs: b, toMs: b + step, byProject: new Map() });
  }
  for (const s of sessions) {
    if (!s.turns || s.turns.length === 0) continue;
    const startMs = new Date(s.startedAt).getTime();
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts < fromMs || ts >= toMs) continue;
      const idx = Math.floor((ts - fromMs) / step);
      if (idx < 0 || idx >= buckets.length) continue;
      const proj = s.project || "unknown";
      const cur = buckets[idx].byProject.get(proj) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      cur.input += t.tokens.input;
      cur.output += t.tokens.output;
      cur.cacheRead += t.tokens.cacheRead;
      cur.cacheWrite += t.tokens.cacheWrite;
      cur.cost += costOfTokens(t.model ?? s.model, t.tokens);
      buckets[idx].byProject.set(proj, cur);
    }
  }
  return buckets;
}

export function topProjectsByTokens(sessions: Session[], limit = 5): string[] {
  const byProject = new Map<string, number>();
  for (const s of sessions) {
    const total = sumTokens(s.tokens);
    const proj = s.project || "unknown";
    byProject.set(proj, (byProject.get(proj) ?? 0) + total);
  }
  return Array.from(byProject.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
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

export const PROJECT_PALETTE = [
  "var(--c-cyan)",
  "var(--c-violet)",
  "var(--c-lime)",
  "var(--c-amber)",
  "var(--c-pink)",
  "var(--c-periwinkle)",
];
export const OTHER_COLOR = "var(--c-text-faint)";

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
