import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../types";
import { classifyPrompt, PROMPT_KIND_COLOR, PROMPT_KIND_LABEL } from "../utils/classifyPrompt";
import { callsPerPrompt } from "../utils/toolCalls";
import { buildSessionTimeline, TIMELINE_GAP_MS, type TimelinePoint } from "../utils/sessionTimeline";
import { formatClockAt, formatCost, formatDuration, formatTokens } from "../utils/format";
import { KpiRow } from "./Kpi";
import "../timeline.css";

const PAD_L = 46;
const PAD_R = 64;
const LANE_GAP = 28;
const LANES = { ctx: 150, cost: 64, fresh: 56, activity: 34 } as const;
const AXIS_H = 20;
/** Context fill where the quality score starts to drop (scripts/quality.mjs bands). */
const WATCH_PCT = 70;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function useLiveOffset(session: Session) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!session.live) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [session.live]);
  return session.live ? now - Date.parse(session.startedAt) : undefined;
}

export function TimelineTab({
  session,
  onFocusTools,
}: {
  session: Session;
  onFocusTools: (promptIdx: number, start: number, end: number) => void;
}) {
  const liveOffset = useLiveOffset(session);
  const data = useMemo(() => buildSessionTimeline(session, liveOffset), [session, liveOffset]);
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; point: TimelinePoint } | null>(null);

  if (!data) return <div className="placeholder">No turn data for this session.</div>;

  const innerW = Math.max(1, width - PAD_L - PAD_R);
  const X = (t: number) => PAD_L + (data.axis(t) / data.axisEnd) * innerW;
  const top = { ctx: 18, cost: 0, fresh: 0, activity: 0, axis: 0 };
  top.cost = top.ctx + LANES.ctx + LANE_GAP;
  top.fresh = top.cost + LANES.cost + LANE_GAP;
  top.activity = top.fresh + LANES.fresh + LANE_GAP;
  top.axis = top.activity + LANES.activity + 6;
  const height = top.axis + AXIS_H;

  const main = data.points.filter((p) => p.ctxPct !== null);
  const yCtx = (pct: number) => top.ctx + LANES.ctx * (1 - Math.min(100, pct) / 100);
  const maxCost = Math.max(0.01, data.totalCost);
  const yCost = (c: number) => top.cost + LANES.cost * (1 - c / maxCost);
  const maxFresh = Math.max(1, ...data.points.map((p) => p.fresh));
  const barW = Math.max(1.5, Math.min(6, innerW / Math.max(1, data.points.length) - 1));

  // Context as a step line: the context holds until the next main-thread turn.
  let ctxPath = "";
  let ctxArea = "";
  main.forEach((p, i) => {
    const x = X(p.t), y = yCtx(p.ctxPct!);
    if (i === 0) { ctxPath = `M${x},${y}`; ctxArea = `M${x},${top.ctx + LANES.ctx} L${x},${y}`; }
    else { const prevY = yCtx(main[i - 1].ctxPct!); ctxPath += ` L${x},${prevY} L${x},${y}`; ctxArea += ` L${x},${prevY} L${x},${y}`; }
  });
  if (main.length) {
    const last = main[main.length - 1], xEnd = X(data.end), y = yCtx(last.ctxPct!);
    ctxPath += ` L${xEnd},${y}`;
    ctxArea += ` L${xEnd},${y} L${xEnd},${top.ctx + LANES.ctx} Z`;
  }
  let costPath = `M${X(data.start)},${yCost(0)}`;
  let prevCum = 0;
  for (const p of data.points) { costPath += ` L${X(p.t)},${yCost(prevCum)} L${X(p.t)},${yCost(p.cumCost)}`; prevCum = p.cumCost; }
  costPath += ` L${X(data.end)},${yCost(prevCum)}`;

  const ticks = axisTicks(Date.parse(session.startedAt), data.start, data.end, data.gaps, innerW);
  const lastMain = main[main.length - 1];
  const idleMs = data.gaps.reduce((a, g) => a + (g.to - g.from), 0);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < PAD_L || x > PAD_L + innerW) { setHover(null); return; }
    let best = data.points[0], bestD = Infinity;
    for (const p of data.points) { const d = Math.abs(X(p.t) - x); if (d < bestD) { bestD = d; best = p; } }
    setHover({ x: X(best.t), point: best });
  };

  // Context at the hovered moment: the last main-thread turn at or before it.
  const ctxAt = (t: number) => { let v: TimelinePoint | null = null; for (const p of main) { if (p.t <= t) v = p; else break; } return v; };
  const hoverCtx = hover ? ctxAt(hover.point.t) : null;
  const promptEnd = (idx: number) => data.prompts[idx + 1]?.t ?? Infinity;

  return (
    <>
      <KpiRow
        items={[
          { label: "Peak context", value: `${Math.round(data.peakPct)}%`, sub: `of ${formatTokens(data.window)}`, tone: data.peakPct >= 85 ? "red" : data.peakPct >= WATCH_PCT ? "amber" : undefined },
          { label: session.live ? "Context now" : "Context at end", value: lastMain ? `${Math.round(lastMain.ctxPct!)}%` : "—", sub: lastMain ? `${formatTokens(lastMain.ctx!)} · ${data.points.length} turns` : `${data.points.length} turns` },
          { label: "Compactions", value: data.compactions.length, sub: data.compactions.length ? "context dropped by half" : "none detected", tone: data.compactions.length ? "amber" : undefined },
          {
            label: "Idle",
            value: data.gaps.length ? formatDuration(idleMs) : "—",
            sub: data.gaps.length ? `${data.gaps.length} gap${data.gaps.length === 1 ? "" : "s"} over ${TIMELINE_GAP_MS / 60_000} min, shortened` : `no gap over ${TIMELINE_GAP_MS / 60_000} min`,
            title: "Pauses between events longer than 5 minutes: drawn as a short break on the chart",
          },
        ]}
      />

      <div className="d-panel tl-panel">
        <div className="section-title tl-head">
          <span>Flight data</span>
          {session.live && <span className="tl-live"><i aria-hidden="true" />live</span>}
          <span className="tl-legend mono">
            <span><i className="sw ctx" />context</span>
            <span><i className="sw cost" />API value</span>
            <span><i className="sw fresh" />fresh tokens / turn</span>
            <span><i className="sw agent" />sub-agent</span>
            <span><i className="sw err" />failed call</span>
            <span><i className="sw compact" />compaction</span>
            {data.frictions.length > 0 && <span><i className="sw friction" />friction (approx.)</span>}
          </span>
        </div>
        <div className="tl-wrap" ref={wrapRef}>
          {width > 0 && (
            <svg className="tl-svg" width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
              aria-label={`Session timeline: context peaks at ${Math.round(data.peakPct)}%, ${data.compactions.length} compactions, ${formatCost(data.totalCost)} API value, ${data.failedTools} failed tool calls`}>
              {/* lane labels */}
              <text className="tl-lane" x={PAD_L} y={top.ctx} dy={-7}>context</text>
              <text className="tl-lane" x={PAD_L} y={top.cost} dy={-7}>API value</text>
              <text className="tl-lane" x={PAD_L} y={top.fresh} dy={-7}>fresh tokens / turn</text>
              <text className="tl-lane" x={PAD_L} y={top.activity} dy={-7}>prompts and tool calls</text>

              {/* gaps */}
              {data.gaps.map((g) => {
                const x0 = X(g.from), x1 = X(g.to);
                return (
                  <g key={g.from} className="tl-gap">
                    <rect x={x0} y={top.ctx} width={Math.max(1, x1 - x0)} height={top.activity + LANES.activity - top.ctx} />
                    <title>{`${formatDuration(g.to - g.from)} idle`}</title>
                  </g>
                );
              })}

              {/* context lane */}
              {[0, 50, 100].map((v) => (
                <g key={v}>
                  <line className="tl-grid" x1={PAD_L} x2={PAD_L + innerW} y1={yCtx(v)} y2={yCtx(v)} />
                  <text className="tl-y" x={PAD_L - 8} y={yCtx(v)} dy={3}>{v}%</text>
                </g>
              ))}
              <rect className="tl-watch" x={PAD_L} y={yCtx(100)} width={innerW} height={yCtx(WATCH_PCT) - yCtx(100)} />
              <line className="tl-watch-line" x1={PAD_L} x2={PAD_L + innerW} y1={yCtx(WATCH_PCT)} y2={yCtx(WATCH_PCT)} />
              <text className="tl-watch-label" x={PAD_L + innerW - 6} y={yCtx(WATCH_PCT)} dy={-5}>compact above {WATCH_PCT}%</text>
              <path className="tl-ctx-area" d={ctxArea} />
              <path className="tl-ctx" d={ctxPath} />
              {data.compactions.map((t) => (
                <g key={t} className="tl-compact">
                  <line x1={X(t)} x2={X(t)} y1={top.ctx} y2={top.ctx + LANES.ctx} />
                  <title>{`Compaction at ${formatClockAt(session.startedAt, t)}`}</title>
                </g>
              ))}
              {lastMain && <text className="tl-end ctx" x={PAD_L + innerW + 6} y={yCtx(lastMain.ctxPct!)} dy={3}>{Math.round(lastMain.ctxPct!)}%</text>}

              {/* frictions from /insights: approximate moments, across every lane */}
              {data.frictions.map((f, i) => (
                <g key={`f${i}`} className="tl-friction">
                  <line x1={X(f.t)} x2={X(f.t)} y1={top.ctx} y2={top.activity + LANES.activity} />
                  <circle cx={X(f.t)} cy={top.ctx} r={3.5} />
                  <title>{`Friction (approximate time, from /insights) · ${f.kind.replace(/_/g, " ")}: ${f.detail}`}</title>
                </g>
              ))}

              {/* cost lane */}
              <line className="tl-grid" x1={PAD_L} x2={PAD_L + innerW} y1={yCost(0)} y2={yCost(0)} />
              <path className="tl-cost" d={costPath} />
              <text className="tl-end cost" x={PAD_L + innerW + 6} y={yCost(data.totalCost)} dy={3}>{formatCost(data.totalCost)}</text>

              {/* fresh tokens per turn */}
              <line className="tl-grid" x1={PAD_L} x2={PAD_L + innerW} y1={top.fresh + LANES.fresh} y2={top.fresh + LANES.fresh} />
              {data.points.map((p, i) => {
                const h = Math.max(1, (p.fresh / maxFresh) * LANES.fresh);
                return <rect key={i} className={`tl-bar ${p.sidechain ? "agent" : ""}`} x={X(p.t) - barW / 2} y={top.fresh + LANES.fresh - h} width={barW} height={h} />;
              })}
              <text className="tl-end" x={PAD_L + innerW + 6} y={top.fresh} dy={8}>{formatTokens(maxFresh)}</text>

              {/* activity: prompts above, tool calls below */}
              <line className="tl-grid" x1={PAD_L} x2={PAD_L + innerW} y1={top.activity + LANES.activity / 2} y2={top.activity + LANES.activity / 2} />
              {data.tools.map((e, i) => (
                <line key={i} className={`tl-tool ${e.isError ? "err" : e.sub ? "agent" : ""}`} x1={X(e.t)} x2={X(e.t)} y1={top.activity + LANES.activity / 2 + 3} y2={top.activity + LANES.activity - 2}>
                  <title>{`${e.tool}${e.sub ? " (sub-agent)" : ""}${e.isError ? " (failed)" : ""} · ${e.preview}`}</title>
                </line>
              ))}
              {data.prompts.map((p) => (
                <g key={p.idx} className="tl-prompt" transform={`translate(${X(p.t)},${top.activity + 8})`}
                  onClick={() => onFocusTools(p.idx, p.t, promptEnd(p.idx))} role="button" tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onFocusTools(p.idx, p.t, promptEnd(p.idx)); } }}
                  aria-label={`Prompt ${p.idx + 1}: ${p.preview}. Show its tool calls`}>
                  <rect x={-4} y={-4} width={8} height={8} rx={1.5} transform="rotate(45)" />
                  <title>{`#${p.idx + 1} · ${p.preview} — click to see its tool calls`}</title>
                </g>
              ))}

              {/* time axis */}
              {ticks.map((t) => (
                <text key={t} className="tl-x" x={X(t)} y={top.axis + 12}>{formatClockAt(session.startedAt, t, { seconds: false })}</text>
              ))}

              {hover && <line className="tl-cross" x1={hover.x} x2={hover.x} y1={top.ctx} y2={top.activity + LANES.activity} />}
            </svg>
          )}
          {hover && (
            <div className={`tl-tip ${hover.x > width - 220 ? "left" : ""}`} style={{ left: hover.x, top: top.cost }}>
              <div className="mono tl-tip-t">{formatClockAt(session.startedAt, hover.point.t)}{hover.point.sidechain ? " · sub-agent" : ""}</div>
              <div><span>Context</span><b>{hoverCtx ? `${Math.round(hoverCtx.ctxPct!)}% · ${formatTokens(hoverCtx.ctx!)}` : "—"}</b></div>
              <div><span>Turn</span><b>{formatTokens(hover.point.fresh)} fresh · {formatCost(hover.point.cost)}</b></div>
              <div><span>Total</span><b>{formatCost(hover.point.cumCost)}</b></div>
              {hover.point.tools.length > 0 && <div className="tl-tip-tools mono">{hover.point.tools.join(", ")}</div>}
            </div>
          )}
        </div>
        <p className="tl-note">
          Context is the prompt size of each main-thread turn (input + cache), against a {formatTokens(data.window)} window. Idle gaps over 5 minutes are shortened. Click a prompt marker to see its tool calls.
          {data.frictions.length > 0 && " Frictions come from /insights, which gives no time: their place is approximate."}
        </p>
      </div>

      <TimelinePrompts session={session} onFocusTools={onFocusTools} />
    </>
  );
}

/** What was asked when: every prompt in order, its kind, the calls it led to (→ Tools), its text. */
function TimelinePrompts({
  session,
  onFocusTools,
}: {
  session: Session;
  onFocusTools: (promptIdx: number, start: number, end: number) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const prompts = session.prompts ?? [];
  const calls = callsPerPrompt(session.toolSequence ?? [], prompts);
  if (prompts.length === 0) return null;
  const toggle = (i: number) => setOpenIdx((o) => (o === i ? null : i));
  return (
    <div className="d-panel tl-prompts">
      <div className="section-title">
        <span>Prompts</span>
        <span className="dim tabular">{prompts.length} prompt{prompts.length === 1 ? "" : "s"}</span>
      </div>
      <div className="prompt-list">
        <div className="prompt-row prompt-row-head mono dim caps">
          <span>#</span>
          <span>Time</span>
          <span>Kind</span>
          <span className="right">Tool calls</span>
          <span>Prompt</span>
        </div>
        {prompts.map((p, i) => {
          const kind = classifyPrompt(p.text ?? p.preview);
          const end = prompts[i + 1]?.t ?? Infinity;
          const open = openIdx === i;
          return (
            <Fragment key={i}>
              <div
                className={`prompt-row ${open ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggle(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(i);
                  }
                }}
              >
                <span className="mono dim tabular">{String(i + 1).padStart(2, "0")}</span>
                <span className="mono dim tabular">{formatClockAt(session.startedAt, p.t)}</span>
                <span className="tl-prompt-kind">
                  <span className="prompt-row-cat" style={{ background: PROMPT_KIND_COLOR[kind] }} aria-hidden="true" />
                  {PROMPT_KIND_LABEL[kind]}
                </span>
                {calls[i] > 0 ? (
                  <button
                    type="button"
                    className="mono tabular right prompt-row-tools-link"
                    title={`Show the ${calls[i]} tool call${calls[i] === 1 ? "" : "s"} this prompt led to`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocusTools(i, p.t, end);
                    }}
                  >
                    {calls[i]} →
                  </button>
                ) : (
                  <span className="mono tabular right dim">—</span>
                )}
                <span className="prompt-row-preview mono">{p.preview}</span>
              </div>
              {open && <pre className="prompt-panel-body">{p.text ?? p.preview}</pre>}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** About one label per 110px, on round wall-clock steps, skipping compressed gaps. Returns session offsets. */
function axisTicks(base: number, start: number, end: number, gaps: Array<{ from: number; to: number }>, innerW: number) {
  const span = end - start;
  if (span <= 0) return [start];
  const want = Math.max(2, Math.floor(innerW / 110));
  const steps = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];
  const active = span - gaps.reduce((a, g) => a + (g.to - g.from), 0);
  const step = steps.find((st) => active / st <= want) ?? steps[steps.length - 1];
  const out: number[] = [];
  for (let abs = Math.ceil((base + start) / step) * step; abs <= base + end; abs += step) {
    const t = abs - base;
    if (!gaps.some((g) => t > g.from && t < g.to)) out.push(t);
  }
  return out.length ? out : [start];
}
