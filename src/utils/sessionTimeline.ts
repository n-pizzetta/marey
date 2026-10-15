import type { Session } from "../types";
import { costOf } from "../../scripts/models.mjs";
import { frictionTimes, type TimelineFriction } from "./frictionTimes";
import { flattenCalls } from "./toolCalls";
import { freshTokens } from "./units";

/**
 * When the parser couldn't take the window from a live snapshot (`contextWindow`), the same rule as
 * scripts/quality.mjs: the window isn't in the transcript, a context over 200k proves a 1M window.
 */
const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
/** Idle gaps longer than this are drawn as a fixed-width break instead of to scale. */
export const TIMELINE_GAP_MS = 5 * 60_000;
const GAP_DRAWN_MS = 60_000;
/** A main-thread context that falls below half of the previous turn's, from at least this size, is a compaction. */
const COMPACTION_MIN_TOKENS = 30_000;

export interface TimelinePoint {
  t: number;
  /** Context size of this turn (input + cache read + cache write); null for sub-agent turns. */
  ctx: number | null;
  ctxPct: number | null;
  /** Fresh tokens of this turn (input + output + cache write). */
  fresh: number;
  cost: number;
  /** Cumulative API value up to and including this turn. */
  cumCost: number;
  sidechain: boolean;
  tools: string[];
  promptIdx?: number;
}

export interface TimelineTool {
  t: number;
  tool: string;
  preview: string;
  isError: boolean;
  /** Made by a sub-agent. */
  sub: boolean;
}

export interface TimelineGap {
  /** Session time where the gap starts and ends. */
  from: number;
  to: number;
}

export interface SessionTimelineData {
  points: TimelinePoint[];
  tools: TimelineTool[];
  prompts: Array<{ t: number; preview: string; idx: number }>;
  /** Approximate: see frictionTimes. */
  frictions: TimelineFriction[];
  compactions: number[];
  gaps: TimelineGap[];
  window: number;
  peakPct: number;
  totalCost: number;
  failedTools: number;
  start: number;
  end: number;
  /** Session time → position on a compressed axis where long idle gaps are shortened. */
  axis: (t: number) => number;
  axisEnd: number;
}

export function buildSessionTimeline(session: Session, nowOffsetMs?: number): SessionTimelineData | null {
  const turns = [...(session.turns ?? [])].sort((a, b) => a.t - b.t);
  if (turns.length === 0) return null;

  let peak = 0;
  for (const tu of turns) {
    if (tu.sidechain) continue;
    const ctx = tu.tokens.input + tu.tokens.cacheRead + tu.tokens.cacheWrite;
    if (ctx > peak) peak = ctx;
  }
  const window = session.contextWindow ?? (peak > STANDARD_WINDOW ? LARGE_WINDOW : STANDARD_WINDOW);

  let cumCost = 0;
  let prevCtx: number | null = null;
  const compactions: number[] = [];
  const points: TimelinePoint[] = turns.map((tu) => {
    const cost = costOf(tu.model ?? session.model, tu.tokens);
    cumCost += cost;
    let ctx: number | null = null;
    if (!tu.sidechain) {
      ctx = tu.tokens.input + tu.tokens.cacheRead + tu.tokens.cacheWrite;
      if (prevCtx !== null && prevCtx >= COMPACTION_MIN_TOKENS && ctx < prevCtx / 2) compactions.push(tu.t);
      prevCtx = ctx;
    }
    return {
      t: tu.t,
      ctx,
      ctxPct: ctx === null ? null : (ctx / window) * 100,
      fresh: freshTokens(tu.tokens),
      cost,
      cumCost,
      sidechain: !!tu.sidechain,
      tools: tu.tools,
      promptIdx: tu.promptIdx,
    };
  });

  // every call, sub-agent calls included (drawn tinted), as the Tools tab counts them
  const tools: TimelineTool[] = flattenCalls(session.toolSequence ?? []).map((e) => ({
    t: e.t,
    tool: e.tool,
    preview: e.preview,
    isError: !!e.result?.isError,
    sub: e.sub,
  }));
  const prompts = (session.prompts ?? []).map((p, idx) => ({ t: p.t, preview: p.preview, idx }));

  const times = [...points.map((p) => p.t), ...tools.map((e) => e.t), ...prompts.map((p) => p.t)];
  const start = Math.min(...times);
  let end = Math.max(...times);
  if (session.live && nowOffsetMs !== undefined && nowOffsetMs > end) end = nowOffsetMs;

  // Compress idle gaps so a session left open over lunch stays readable.
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const gaps: TimelineGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > TIMELINE_GAP_MS) gaps.push({ from: sorted[i - 1], to: sorted[i] });
  }
  if (end > sorted[sorted.length - 1] + TIMELINE_GAP_MS) gaps.push({ from: sorted[sorted.length - 1], to: end });
  const axis = (t: number) => {
    let x = t - start;
    for (const g of gaps) {
      if (t >= g.to) x -= g.to - g.from - GAP_DRAWN_MS;
      else if (t > g.from) x -= (t - g.from) * (1 - GAP_DRAWN_MS / (g.to - g.from));
    }
    return x;
  };

  return {
    points,
    tools,
    prompts,
    frictions: frictionTimes(session.frictions ?? [], start, end, axis),
    compactions,
    gaps,
    window,
    peakPct: (peak / window) * 100,
    totalCost: cumCost,
    failedTools: tools.filter((e) => e.isError).length,
    start,
    end,
    axis,
    axisEnd: Math.max(1, axis(end)),
  };
}
