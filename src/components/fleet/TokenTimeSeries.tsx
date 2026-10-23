import { useMemo, useState } from "react";
import type { Session } from "../../types";
import type { Range } from "../../utils/range";
import { keepFocus } from "../../utils/keepFocus";
import {
  bucketizeByProject,
  rangeBoundsMs,
  topProjectsByTokens,
  sumTokens,
  PROJECT_PALETTE,
  OTHER_COLOR,
  type BucketCell,
} from "../../utils/fleetStats";
import { formatCost, formatTokens } from "../../utils/format";

interface Props {
  sessions: Session[];
  range: Range;
}

type Axis = "tokens" | "cost";

/** A bar segment's height: its tokens, or their API value (priced per turn when bucketed). */
const cellValue = (axis: Axis, cell: BucketCell) => (axis === "tokens" ? sumTokens(cell) : cell.cost);

/** Fewest buckets drawn once the empty start of the range is cut. */
const MIN_BUCKETS = 12;

function formatBucketTime(ms: number, range: Range): string {
  const d = new Date(ms);
  if (range === "today") return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (range === "7d") return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getHours()}h`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TokenTimeSeries({ sessions, range }: Props) {
  const [axis, setAxis] = useState<Axis>("tokens");
  const [hover, setHover] = useState<number | null>(null);

  const { buckets, projects, colorFor, maxTotal } = useMemo(() => {
    const top = topProjectsByTokens(sessions, 5);
    const projects = [...top, "other"];
    const colorFor = new Map<string, string>();
    top.forEach((p, i) => colorFor.set(p, PROJECT_PALETTE[i] ?? "var(--c-text-dim)"));
    colorFor.set("other", OTHER_COLOR);

    const { fromMs, toMs } = rangeBoundsMs(sessions, range);
    const allBuckets = bucketizeByProject(sessions, range, fromMs, toMs);
    // Start where the usage starts, not at the range's start (midnight for Today), so the bars
    // aren't all squeezed on the right; keep a few buckets so a short burst doesn't fill the width.
    const firstUsed = allBuckets.findIndex((b) => b.byProject.size > 0);
    const rawBuckets = firstUsed > 0 ? allBuckets.slice(Math.min(firstUsed, Math.max(0, allBuckets.length - MIN_BUCKETS))) : allBuckets;

    // Collapse non-top projects into "other"
    const collapsed = rawBuckets.map((b) => {
      const byProject = new Map<string, BucketCell>();
      const other: BucketCell = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const [proj, tb] of b.byProject.entries()) {
        if (top.includes(proj)) byProject.set(proj, tb);
        else {
          other.input += tb.input;
          other.output += tb.output;
          other.cacheRead += tb.cacheRead;
          other.cacheWrite += tb.cacheWrite;
          other.cost += tb.cost;
        }
      }
      if (sumTokens(other) > 0) byProject.set("other", other);
      return { ...b, byProject };
    });

    let maxTotal = 0;
    for (const b of collapsed) {
      let total = 0;
      for (const tb of b.byProject.values()) total += cellValue(axis, tb);
      if (total > maxTotal) maxTotal = total;
    }

    return { buckets: collapsed, projects, colorFor, maxTotal };
  }, [sessions, range, axis]);

  if (buckets.length === 0 || maxTotal === 0) {
    return (
      <div className="fleet-block">
        <div className="section-title">
          <span>Tokens over time</span>
        </div>
        <div className="placeholder mono dim">No turn-level data in range.</div>
      </div>
    );
  }

  const W = 1000;
  const H = 180;
  const PAD_L = 48;
  const PAD_R = 12;
  const PAD_T = 8;
  const PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const barW = plotW / buckets.length;

  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>Tokens over time · stacked by project</span>
        <span className="timeseries-toggle">
          <button className={axis === "tokens" ? "active" : ""} onMouseDown={keepFocus} onClick={() => setAxis("tokens")}>tokens</button>
          <button className={axis === "cost" ? "active" : ""} onMouseDown={keepFocus} onClick={() => setAxis("cost")}>$</button>
        </span>
      </div>
      <div className="timeseries-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="timeseries-svg" preserveAspectRatio="none">
          {/* Y axis label */}
          <text x={8} y={PAD_T + 10} className="timeseries-axis">
            {axis === "tokens" ? formatTokens(maxTotal) : formatCost(maxTotal)}
          </text>
          <text x={8} y={H - PAD_B - 2} className="timeseries-axis">0</text>
          {/* bars */}
          {buckets.map((b, i) => {
            let yOffset = 0;
            const x = PAD_L + i * barW;
            return (
              <g
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              >
                {projects.map((proj) => {
                  const tb = b.byProject.get(proj);
                  if (!tb) return null;
                  const v = cellValue(axis, tb);
                  if (v <= 0) return null;
                  const h = (v / maxTotal) * plotH;
                  const y = PAD_T + plotH - yOffset - h;
                  yOffset += h;
                  return (
                    <rect
                      key={proj}
                      x={x + 0.5}
                      y={y}
                      width={Math.max(1, barW - 1)}
                      height={h}
                      fill={colorFor.get(proj)}
                      opacity={hover === null || hover === i ? 0.9 : 0.35}
                    />
                  );
                })}
              </g>
            );
          })}
          {/* X axis ticks (first, middle, last) */}
          {[0, Math.floor(buckets.length / 2), buckets.length - 1].map((i) => (
            <text
              key={i}
              x={PAD_L + i * barW + barW / 2}
              y={H - 6}
              textAnchor="middle"
              className="timeseries-axis"
            >
              {buckets[i] ? formatBucketTime(buckets[i].fromMs, range) : ""}
            </text>
          ))}
        </svg>
        <div className="timeseries-legend mono dim">
          {projects.map((p) => (
            <span key={p} className="timeseries-legend-item">
              <span className="timeseries-legend-swatch" style={{ background: colorFor.get(p) }} />
              {p}
            </span>
          ))}
        </div>
        {hover !== null && buckets[hover] && (
          <TimeSeriesTooltip
            bucket={buckets[hover]}
            axis={axis}
            projects={projects}
            colorFor={colorFor}
            range={range}
          />
        )}
      </div>
    </div>
  );
}

function TimeSeriesTooltip({
  bucket,
  axis,
  projects,
  colorFor,
  range,
}: {
  bucket: ReturnType<typeof bucketizeByProject>[number];
  axis: Axis;
  projects: string[];
  colorFor: Map<string, string>;
  range: Range;
}) {
  const rows = projects
    .map((p) => {
      const tb = bucket.byProject.get(p);
      if (!tb) return null;
      const v = cellValue(axis, tb);
      return { proj: p, v };
    })
    .filter((r): r is { proj: string; v: number } => !!r && r.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, r) => a + r.v, 0);
  return (
    <div className="timeseries-tooltip mono">
      <div className="timeseries-tooltip-head dim">
        {formatBucketTime(bucket.fromMs, range)} → {formatBucketTime(bucket.toMs, range)}
      </div>
      {rows.map((r) => (
        <div key={r.proj} className="timeseries-tooltip-row">
          <span className="swatch" style={{ background: colorFor.get(r.proj) }} />
          <span>{r.proj}</span>
          <span className="tabular right">
            {axis === "tokens" ? formatTokens(r.v) : formatCost(r.v)}
          </span>
        </div>
      ))}
      <div className="timeseries-tooltip-foot">
        <strong>{axis === "tokens" ? formatTokens(total) : formatCost(total)}</strong>
      </div>
    </div>
  );
}
