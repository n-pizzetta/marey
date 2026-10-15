import { useMemo } from "react";
import type { Session } from "../../types";
import type { Range } from "../../utils/range";
import { projectColor } from "../../utils/fleetStats";
import { projectLeague, type ProjectRow } from "../../utils/projectLeague";
import "../../league.css";
import { formatCost, formatTokens } from "../../utils/format";
import { useUnit } from "../../utils/units";

interface Props {
  sessions: Session[];
  allSessions: Session[];
  range: Range;
  limit?: number;
}

function Movement({ row }: { row: ProjectRow }) {
  if (row.isNew) return <span className="league-move new" title="Not in the previous period">new</span>;
  if (row.delta === null || row.delta === 0) return <span className="league-move flat">–</span>;
  const up = row.delta > 0;
  return (
    <span className={`league-move ${up ? "up" : "down"}`} title="Rank change vs the previous period">
      {up ? "▲" : "▼"} {Math.abs(row.delta)}
    </span>
  );
}

export function ProjectRollup({ sessions, allSessions, range, limit = 6 }: Props) {
  const unit = useUnit();
  const rows = useMemo(() => projectLeague(sessions, allSessions, range).slice(0, limit), [sessions, allSessions, range, limit]);

  if (rows.length === 0) {
    return (
      <div className="fleet-block">
        <div className="section-title"><span>Project league</span></div>
        <div className="placeholder mono dim">No project data.</div>
      </div>
    );
  }

  const max = rows[0].cost > 0 ? rows[0].cost : rows[0].tokens;

  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>Project league</span>
        <span className="dim mono tabular" title="Ranked by API value, a relative weight across token kinds and models">{range === "all" ? "by API value" : "by API value · vs previous period"}</span>
      </div>
      <div className="league">
        {rows.map((r, i) => {
          const color = projectColor(r.project);
          return (
            <div key={r.project} className={`league-row ${i === 0 ? "leader" : ""}`}>
              <span className="league-rank mono tabular">{i === 0 ? "👑" : i + 1}</span>
              <div className="league-main">
                <div className="league-line">
                  <span className="league-name mono">{r.project}</span>
                  <span className="dim mono tabular league-count">{r.count} session{r.count > 1 ? "s" : ""}</span>
                  <Movement row={r} />
                </div>
                <div className="league-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(3, ((rows[0].cost > 0 ? r.cost : r.tokens) / max) * 100)}%`, background: color }} />
                </div>
              </div>
              <div className="league-nums mono tabular">
                {unit === "tokens" ? (
                  <>
                    <span>{formatTokens(r.tokens)}</span>
                    <span style={{ color: "var(--c-text)", fontWeight: 600 }}>{formatCost(r.cost)}</span>
                  </>
                ) : (
                  <>
                    <span style={{ color: "var(--c-text)", fontWeight: 600 }}>{formatCost(r.cost)}</span>
                    <span>{formatTokens(r.tokens)}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
