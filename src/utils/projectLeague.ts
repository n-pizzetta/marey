import type { Session } from "../types";
import type { Range } from "./range";
import { costOfTokens, rangeBoundsMs } from "./fleetStats";
import { freshTokens } from "./units";

const DAY_MS = 86_400_000;

export type ProjectRow = {
  project: string;
  /** Fresh tokens (input + output + cache writes). */
  tokens: number;
  cost: number;
  count: number;
  /** Positive = climbed, negative = dropped, null = no previous rank ("new" or range "all"). */
  delta: number | null;
  isNew: boolean;
};

/** Per-project API value (relative weight) inside a time window. */
function projectTotalsInWindow(sessions: Session[], fromMs: number, toMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (!s.turns?.length) continue;
    const base = new Date(s.startedAt).getTime();
    let sum = 0;
    for (const t of s.turns) {
      const ts = base + t.t;
      if (ts >= fromMs && ts < toMs) sum += costOfTokens(t.model ?? s.model, t.tokens);
    }
    if (sum > 0) out.set(s.project || "unknown", (out.get(s.project || "unknown") ?? 0) + sum);
  }
  return out;
}

function ranksOf(totals: Map<string, number>): Map<string, number> {
  return new Map([...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p], i) => [p, i + 1]));
}

/** Projects ranked by API value in the scope, with their rank movement against the previous period. */
export function projectLeague(sessions: Session[], allSessions: Session[], range: Range): ProjectRow[] {
  const byProj = new Map<string, { tokens: number; cost: number; count: number }>();
  for (const s of sessions) {
    const key = s.project || "unknown";
    const prev = byProj.get(key) ?? { tokens: 0, cost: 0, count: 0 };
    prev.tokens += freshTokens(s.tokens);
    prev.cost += s.costUsd;
    prev.count += 1;
    byProj.set(key, prev);
  }

  let curRank: Map<string, number> | null = null;
  let prevRank: Map<string, number> | null = null;
  if (range !== "all") {
    const { fromMs, toMs } = rangeBoundsMs(allSessions, range);
    const span = range === "today" ? DAY_MS : toMs - fromMs;
    curRank = ranksOf(projectTotalsInWindow(allSessions, fromMs, toMs));
    prevRank = ranksOf(projectTotalsInWindow(allSessions, fromMs - span, fromMs));
  }

  return [...byProj.entries()]
    .map(([project, v]) => ({ project, ...v }))
    .filter((r) => r.cost > 0 || r.tokens > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    .map((r) => {
      const cur = curRank?.get(r.project);
      const prev = prevRank?.get(r.project);
      const comparable = curRank !== null && prevRank !== null && prevRank.size > 0 && cur !== undefined;
      return {
        ...r,
        delta: comparable && prev !== undefined ? prev - cur : null,
        isNew: comparable && prev === undefined,
      };
    });
}
