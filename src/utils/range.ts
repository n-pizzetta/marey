import type { Session, ToolName } from "../types";
import { costOf } from "../../scripts/models.mjs";

/** Gaps longer than this are idle, not active time: `IDLE_CAP_MS` in scripts/transcript-utils.mjs. */
const IDLE_CAP_MS = 5 * 60_000;

export type Range = "today" | "7d" | "30d" | "all";

export const RANGE_OPTIONS: Array<{ id: Range; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

export function rangeStart(range: Range, now: Date = new Date()): Date | null {
  if (range === "all") return null;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = range === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function filterByRange(sessions: Session[], range: Range, now: Date = new Date()): Session[] {
  const start = rangeStart(range, now);
  if (!start) return sessions;
  const startMs = start.getTime();
  return sessions.filter((s) => {
    if (s.live) return true;
    const started = new Date(s.startedAt).getTime();
    const last = s.lastEventAt ? new Date(s.lastEventAt).getTime() : 0;
    return Math.max(started, last) >= startMs;
  });
}

/**
 * Sessions with tokens and cost restricted to the turns inside the range, and
 * per-model usage (sessions can switch models). Aggregates (header totals,
 * fleet cards) use these; a session started before the range only contributes
 * what it spent inside it, its tool calls and active time included (the latter
 * from its turns and prompts: close to the parser's, which counts every event).
 * Sessions without turns keep their totals. Turns stay whole: a widget that
 * reads them filters by `rangeStart` itself.
 */
export function scopeToRange(sessions: Session[], range: Range, now: Date = new Date()): Session[] {
  const fromMs = rangeStart(range, now)?.getTime() ?? null;
  return sessions.map((s) => {
    if (!s.turns?.length) {
      return { ...s, modelUsage: { [s.model]: { tokens: sumAll(s.tokens), cost: s.costUsd } } };
    }
    const base = new Date(s.startedAt).getTime();
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const modelUsage: NonNullable<Session["modelUsage"]> = {};
    let costUsd = 0;
    const partial = fromMs !== null && base < fromMs;
    const toolCounts = {} as Record<ToolName, number>;
    const times: number[] = [];
    for (const t of s.turns) {
      if (fromMs !== null && base + t.t < fromMs) continue;
      if (partial) {
        for (const tool of t.tools) toolCounts[tool as ToolName] = (toolCounts[tool as ToolName] ?? 0) + 1;
        times.push(t.t);
      }
      const model = t.model ?? s.model;
      const cost = costOf(model, t.tokens);
      tokens.input += t.tokens.input;
      tokens.output += t.tokens.output;
      tokens.cacheRead += t.tokens.cacheRead;
      tokens.cacheWrite += t.tokens.cacheWrite;
      costUsd += cost;
      const m = (modelUsage[model] ??= { tokens: 0, cost: 0 });
      m.tokens += sumAll(t.tokens);
      m.cost += cost;
    }
    if (!partial) return { ...s, tokens, costUsd, modelUsage };
    for (const pr of s.prompts ?? []) if (base + pr.t >= fromMs) times.push(pr.t);
    times.sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < times.length; i++) activeMs += Math.min(times[i] - times[i - 1], IDLE_CAP_MS);
    return { ...s, tokens, costUsd, modelUsage, toolCounts, durationMs: Math.max(1, activeMs) };
  });
}

function sumAll(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function rangeLabel(range: Range): string {
  switch (range) {
    case "today":
      return "today";
    case "7d":
      return "last 7 days";
    case "30d":
      return "last 30 days";
    case "all":
      return "all time";
  }
}
