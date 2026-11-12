import { useMemo, useRef, useState } from "react";
import type { Session } from "../../types";
import type { Range } from "../../utils/range";
import { keepFocus } from "../../utils/keepFocus";
import {
  bucketize,
  bucketSizeMs,
  rangeBoundsMs,
  sumTokens,
  zoomStep,
  OTHER_COLOR,
  type BucketCell,
  type SeriesBy,
  type TimeBucket,
} from "../../utils/fleetStats";
import { formatCost, formatTokens } from "../../utils/format";
import { modelLabel } from "../../../scripts/models.mjs";
import { useZoomGestures, useZoomView } from "../../utils/chartZoom";

interface Props {
  sessions: Session[];
  range: Range;
  by: SeriesBy;
  onBy: (by: SeriesBy) => void;
  /** The color of each project or model (the page's, shared with the card it pairs with); the rest fold into "other". */
  colors: Map<string, string>;
}

type Axis = "tokens" | "cost";

const OTHER = "other";
const DAY = 86_400_000;

/** A bar segment's height: its tokens, or their API value (priced per turn when bucketed). */
const cellValue = (axis: Axis, cell: BucketCell) => (axis === "tokens" ? sumTokens(cell) : cell.cost);

/** Fewest buckets drawn once the empty start of the range is cut. */
const MIN_BUCKETS = 12;

const pad2 = (n: number) => n.toString().padStart(2, "0");

/** A bucket's start, as precise as its size and the span shown call for (with the day once it crosses midnight). */
function formatBucketTime(ms: number, step: number, spanMs: number, multiDay = spanMs > DAY): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (step >= DAY) return date;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanMs > 6 * DAY) return `${date} ${d.getHours()}h`;
  if (multiDay) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${step < 3_600_000 ? hm : `${d.getHours()}h`}`;
  return hm;
}

const emptyCell = (): BucketCell => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

const W = 1000;
const H = 180;
const PAD_L = 48;
const PAD_R = 12;
const PAD_T = 8;
const PAD_B = 22;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/**
 * Tokens or API value over the range, stacked by project or by model. Drag across the bars to zoom
 * on a stretch (finer bars, down to 5 minutes), pinch to zoom in or out, swipe sideways to move;
 * double-click or "Reset zoom" to come back (utils/chartZoom.ts, like the session charts).
 */
export function TokenTimeSeries({ sessions, range, by, onBy, colors }: Props) {
  const [axis, setAxis] = useState<Axis>("tokens");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const labelOf = (key: string) => (key === OTHER ? OTHER : by === "model" ? modelLabel(key) : key);
  const colorOf = (key: string) => colors.get(key) ?? OTHER_COLOR;

  // The whole range, from where the usage starts, not the range's start (midnight for Today), so the
  // bars aren't all squeezed on the right; a few buckets kept so a short burst doesn't fill the width.
  const whole = useMemo(() => {
    const bounds = rangeBoundsMs(sessions, range);
    const all = bucketize(sessions, bounds.fromMs, bounds.toMs, bucketSizeMs(range), by);
    const firstUsed = all.findIndex((b) => b.bySeries.size > 0);
    return firstUsed > 0 ? all.slice(Math.min(firstUsed, Math.max(0, all.length - MIN_BUCKETS))) : all;
  }, [sessions, range, by]);
  const full: [number, number] = whole.length ? [whole[0].fromMs, whole[whole.length - 1].toMs] : [0, 1];
  // a zoom belongs to the range it was made in; 30 minutes at the closest
  const zoom = useZoomView(full, 30 * 60_000, range);
  const zoomFrom = zoom.zoomed ? zoom.view[0] : null;
  const zoomTo = zoom.zoomed ? zoom.view[1] : null;

  const { buckets, series, step, spanMs, multiDay, maxTotal } = useMemo(() => {
    const step = zoomFrom !== null && zoomTo !== null ? zoomStep(zoomTo - zoomFrom) : bucketSizeMs(range);
    const raw = zoomFrom !== null && zoomTo !== null ? bucketize(sessions, zoomFrom, zoomTo, step, by) : whole;

    // Series with a color of their own, heaviest in view at the bottom; the rest fold into "other".
    const totals = new Map<string, number>();
    for (const b of raw) for (const [key, cell] of b.bySeries) totals.set(key, (totals.get(key) ?? 0) + sumTokens(cell));
    const named = [...totals.entries()].filter(([key]) => colors.has(key)).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const collapsed: TimeBucket[] = raw.map((b) => {
      const bySeries = new Map<string, BucketCell>();
      const other = emptyCell();
      for (const [key, cell] of b.bySeries) {
        if (colors.has(key)) bySeries.set(key, cell);
        else for (const k of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) other[k] += cell[k];
      }
      if (sumTokens(other) > 0) bySeries.set(OTHER, other);
      return { ...b, bySeries };
    });
    const series = collapsed.some((b) => b.bySeries.has(OTHER)) ? [...named, OTHER] : named;

    let maxTotal = 0;
    for (const b of collapsed) {
      let total = 0;
      for (const cell of b.bySeries.values()) total += cellValue(axis, cell);
      if (total > maxTotal) maxTotal = total;
    }
    const spanMs = collapsed.length ? collapsed[collapsed.length - 1].toMs - collapsed[0].fromMs : 0;
    const multiDay = collapsed.length > 0 && new Date(collapsed[0].fromMs).toDateString() !== new Date(collapsed[collapsed.length - 1].toMs - 1).toDateString();
    return { buckets: collapsed, series, step, spanMs, multiDay, maxTotal };
  }, [sessions, range, axis, by, colors, whole, zoomFrom, zoomTo]);

  const barW = buckets.length ? PLOT_W / buckets.length : PLOT_W;
  const indexAt = (clientX: number): number => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    const x = ((clientX - r.left) / r.width) * W;
    return Math.min(buckets.length - 1, Math.max(0, Math.floor((x - PAD_L) / barW)));
  };
  const { sel, handlers } = useZoomGestures(svgRef, zoom, () => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    const sx = r.width / W;
    return { left: r.left + PAD_L * sx, width: PLOT_W * sx };
  });

  const byToggle = (
    <span className="timeseries-toggle" role="group" aria-label="Stack by">
      <button className={by === "project" ? "active" : ""} onMouseDown={keepFocus} onClick={() => onBy("project")}>by project</button>
      <button className={by === "model" ? "active" : ""} onMouseDown={keepFocus} onClick={() => onBy("model")}>by model</button>
    </span>
  );

  if (buckets.length === 0 || maxTotal === 0) {
    return (
      <div className="fleet-block">
        <div className="section-title">
          <span>Tokens over time</span>
          {zoom.zoomed ? <button className="link-btn" onClick={zoom.reset}>Reset zoom</button> : byToggle}
        </div>
        <div className="placeholder mono dim">No turn-level data in {zoom.zoomed ? "this stretch" : "range"}.</div>
      </div>
    );
  }

  const selBox = sel ? { x: PAD_L + Math.min(sel.f0, sel.f1) * PLOT_W, x1: PAD_L + Math.max(sel.f0, sel.f1) * PLOT_W } : null;

  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>
          Tokens over time
          {zoom.zoomed && (
            <span className="dim mono timeseries-zoom">
              {" · "}{formatBucketTime(buckets[0].fromMs, step, spanMs, multiDay)} → {formatBucketTime(buckets[buckets.length - 1].toMs, step, spanMs, multiDay)}
            </span>
          )}
        </span>
        <span className="timeseries-controls">
          {zoom.zoomed && <button className="link-btn" onClick={zoom.reset}>Reset zoom</button>}
          {byToggle}
          <span className="timeseries-toggle" role="group" aria-label="Measure">
            <button className={axis === "tokens" ? "active" : ""} onMouseDown={keepFocus} onClick={() => setAxis("tokens")}>tokens</button>
            <button className={axis === "cost" ? "active" : ""} onMouseDown={keepFocus} onClick={() => setAxis("cost")}>$</button>
          </span>
        </span>
      </div>
      <div className="timeseries-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="timeseries-svg zoomable"
          preserveAspectRatio="none"
          {...handlers}
          onMouseMove={(e) => setHover(indexAt(e.clientX))}
          onMouseLeave={() => setHover(null)}
        >
          <text x={8} y={PAD_T + 10} className="timeseries-axis">
            {axis === "tokens" ? formatTokens(maxTotal) : formatCost(maxTotal)}
          </text>
          <text x={8} y={H - PAD_B - 2} className="timeseries-axis">0</text>
          {buckets.map((b, i) => {
            let yOffset = 0;
            const x = PAD_L + i * barW;
            return (
              <g key={b.fromMs}>
                {series.map((key) => {
                  const cell = b.bySeries.get(key);
                  if (!cell) return null;
                  const v = cellValue(axis, cell);
                  if (v <= 0) return null;
                  const h = (v / maxTotal) * PLOT_H;
                  const y = PAD_T + PLOT_H - yOffset - h;
                  yOffset += h;
                  return (
                    <rect
                      key={key}
                      x={x + 0.5}
                      y={y}
                      width={Math.max(1, barW - 1)}
                      height={h}
                      fill={colorOf(key)}
                      opacity={sel || hover === null || hover === i ? 0.9 : 0.35}
                    />
                  );
                })}
              </g>
            );
          })}
          {selBox && <rect className="timeseries-selection" x={selBox.x} y={PAD_T} width={Math.max(0, selBox.x1 - selBox.x)} height={PLOT_H} />}
          {/* X axis ticks (first, middle, last) */}
          {/* the outer labels align on the plot's edges, so the last one isn't cut */}
          {[0, Math.floor(buckets.length / 2), buckets.length - 1].map((i, k) => (
            <text
              key={k}
              x={k === 0 ? PAD_L : k === 2 ? PAD_L + PLOT_W : PAD_L + i * barW + barW / 2}
              y={H - 6}
              textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"}
              className="timeseries-axis"
            >
              {buckets[i] ? formatBucketTime(k === 2 ? buckets[i].toMs : buckets[i].fromMs, step, spanMs, multiDay) : ""}
            </text>
          ))}
        </svg>
        <div className="timeseries-legend mono dim">
          {series.map((key) => (
            <span key={key} className="timeseries-legend-item">
              <span className="timeseries-legend-swatch" style={{ background: colorOf(key) }} />
              {labelOf(key)}
            </span>
          ))}
          <span className="timeseries-hint">{zoom.zoomed ? "double-click to zoom out" : "drag to zoom · pinch to zoom in or out"}</span>
        </div>
        {hover !== null && !sel && buckets[hover] && (
          <TimeSeriesTooltip
            bucket={buckets[hover]}
            axis={axis}
            series={series}
            colorOf={colorOf}
            labelOf={labelOf}
            when={(ms) => formatBucketTime(ms, step, spanMs, multiDay)}
          />
        )}
      </div>
    </div>
  );
}

function TimeSeriesTooltip({
  bucket,
  axis,
  series,
  colorOf,
  labelOf,
  when,
}: {
  bucket: TimeBucket;
  axis: Axis;
  series: string[];
  colorOf: (key: string) => string;
  labelOf: (key: string) => string;
  when: (ms: number) => string;
}) {
  const rows = series
    .map((key) => {
      const cell = bucket.bySeries.get(key);
      return cell ? { key, v: cellValue(axis, cell) } : null;
    })
    .filter((r): r is { key: string; v: number } => !!r && r.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, r) => a + r.v, 0);
  return (
    <div className="timeseries-tooltip mono">
      <div className="timeseries-tooltip-head dim">
        {when(bucket.fromMs)} → {when(bucket.toMs)}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="timeseries-tooltip-row">
          <span className="swatch" style={{ background: colorOf(r.key) }} />
          <span>{labelOf(r.key)}</span>
          <span className="tabular right">{axis === "tokens" ? formatTokens(r.v) : formatCost(r.v)}</span>
        </div>
      ))}
      <div className="timeseries-tooltip-foot">
        <strong>{axis === "tokens" ? formatTokens(total) : formatCost(total)}</strong>
      </div>
    </div>
  );
}
