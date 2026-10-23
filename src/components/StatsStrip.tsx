import type { Session } from "../types";
import { estimateHint, formatCost, formatDuration, formatTokens } from "../utils/format";
import { API_VALUE_HINT, freshTokens } from "../utils/units";
import { rangeLabel, type Range } from "../utils/range";
import { KpiRow } from "./Kpi";

interface StatsRowProps {
  sessions: Session[];
  totalInRange: number;
  range: Range;
  activeFilterCount: number;
}

function rangeSpanDays(sessions: Session[], range: Range): number {
  if (range === "today") return 1;
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (sessions.length === 0) return 1;
  const earliest = Math.min(...sessions.map((s) => new Date(s.startedAt).getTime()));
  return Math.max(1, Math.ceil((Date.now() - earliest) / 86_400_000));
}

/** Headline figures of the current scope (range + filters), under the scope bar. */
export function StatsRow({ sessions, totalInRange, range, activeFilterCount }: StatsRowProps) {
  const total = sessions.length;
  const isFiltered = activeFilterCount > 0;

  const totalDuration = sessions.reduce((a, s) => a + s.durationMs, 0);
  const avgDuration = total > 0 ? totalDuration / total : 0;

  const totalCost = sessions.reduce((a, s) => a + s.costUsd, 0);
  const avgCost = total > 0 ? totalCost / total : 0;
  const unpriced = new Set(sessions.flatMap((s) => s.unpricedModels ?? []));

  const totalFresh = sessions.reduce((a, s) => a + freshTokens(s.tokens), 0);
  const totalCached = sessions.reduce((a, s) => a + s.tokens.cacheRead, 0);
  const avgFresh = total > 0 ? totalFresh / total : 0;

  const spanDays = Math.max(1, rangeSpanDays(sessions, range));
  const perDay = total > 0 ? (total / spanDays).toFixed(1) : "0";

  if (total === 0) {
    return (
      <div className="empty-range">
        {isFiltered && totalInRange > 0 ? (
          <>No session matches the filters <span className="mono dim">{rangeLabel(range)}</span>. Reset them to see the {totalInRange} in range.</>
        ) : (
          <>No sessions <span className="mono dim">{rangeLabel(range)}</span>. Try a broader range.</>
        )}
      </div>
    );
  }

  return (
    <KpiRow
      items={[
        {
          label: "Sessions",
          value: total,
          sub: isFiltered ? `${total} of ${totalInRange} in range` : `${perDay} / day`,
        },
        {
          label: "Active time",
          value: formatDuration(totalDuration),
          sub: `${formatDuration(avgDuration)} avg / session`,
          title: "Idle gaps over 5 minutes are excluded",
        },
        {
          label: "API value",
          value: `${unpriced.size ? "~" : ""}${formatCost(totalCost)}`,
          sub: `${formatCost(avgCost)} avg / session`,
          title: unpriced.size ? `${API_VALUE_HINT}\n${estimateHint(unpriced)}` : API_VALUE_HINT,
        },
        {
          label: "Fresh tokens",
          value: formatTokens(totalFresh),
          sub: `+ ${formatTokens(totalCached)} cached reads`,
          title: `Input + output + cache writes (${formatTokens(avgFresh)} avg / session). Cached reads are counted apart: they weigh far less.`,
        },
      ]}
    />
  );
}
