import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../types";
import { formatCost, formatDuration, formatRelative, formatTokens, outcomeColor, outcomeLabel } from "../utils/format";
import { projectColor } from "../utils/fleetStats";
import { PRODUCT_NAME } from "../utils/brand";
import { API_VALUE_HINT, freshTokens, formatUsage, useUnit } from "../utils/units";
import { ContextLine } from "./ContextCard";
import { useSnapshotMap } from "../utils/liveContext";
import { canOpenTerminal, openTerminal } from "../utils/openTerminal";
import { useNow } from "../utils/useNow";
import type { ContextSnapshot } from "../../scripts/context-advice.mjs";
import type { Sort, SortKey } from "../utils/sortSessions";

interface Props {
  sessions: Session[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Sortable headers; omitted on short lists (Now page). */
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
  compareMode?: boolean;
  compareIds?: Set<string>;
  onToggleCompare?: (id: string) => void;
  /** Max sessions selectable for a comparison; unlimited when undefined (ghost bulk delete). */
  compareLimit?: number;
  /** Clicking a row's project filters on that project. */
  onProjectClick?: (project: string) => void;
  /** Render every row at its natural height, without inner scroll (short lists). */
  autoHeight?: boolean;
  emptyText?: string;
}

const ROW_HEIGHT = 40;
/** Rows with a live context / cache line are taller. */
const ROW_HEIGHT_CTX = 62;
const HEAD_HEIGHT = 32;
const OVERSCAN_PX = 8 * ROW_HEIGHT;

type Item =
  | { kind: "head"; key: string; label: string; count: number; cost: number; fresh: number; top: number; h: number }
  | { kind: "row"; s: Session; top: number; h: number };

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Flat, virtualizable list. Sorted by date, a day header opens each day; otherwise rows only. */
function buildItems(sessions: Session[], snaps: Map<string, ContextSnapshot>, grouped: boolean): { items: Item[]; total: number } {
  const now = new Date();
  const groups: Array<{ label: string; rows: Session[] }> = [];
  for (const s of sessions) {
    const label = grouped ? dayLabel(s.startedAt, now) : "";
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(s);
    else groups.push({ label, rows: [s] });
  }
  const items: Item[] = [];
  let top = 0;
  for (const g of groups) {
    if (grouped) {
      items.push({ kind: "head", key: `h-${g.label}-${top}`, label: g.label, count: g.rows.length, cost: g.rows.reduce((a, s) => a + s.costUsd, 0), fresh: g.rows.reduce((a, s) => a + freshTokens(s.tokens), 0), top, h: HEAD_HEIGHT });
      top += HEAD_HEIGHT;
    }
    for (const s of g.rows) {
      const h = snaps.has(s.id) ? ROW_HEIGHT_CTX : ROW_HEIGHT;
      items.push({ kind: "row", s, top, h });
      top += h;
    }
  }
  return { items, total: top };
}

/** Index of the first item whose bottom edge is below `y`. */
function firstItemAt(items: Item[], y: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].top + items[mid].h <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Live, ghost and cleared sessions get a glyph; others an outcome dot whose fill reads without color. */
function StatusGlyph({ s }: { s: Session }) {
  if (s.live) return <span className="st-glyph glyph-live" title="Live session" />;
  if (s.ghost) return <span className="st-glyph glyph-ghost" title={`Ghost session (${s.ghostKind ?? "empty"})`} />;
  if (s.clearedInto) return <span className="st-glyph glyph-cleared" title="Context cleared: continues in the next session">⟲</span>;
  return (
    <span
      className={`st-glyph outcome-dot outcome-${s.outcome}`}
      style={{ "--oc": outcomeColor(s.outcome) } as React.CSSProperties}
      title={`Outcome: ${outcomeLabel(s.outcome)}`}
    />
  );
}

export function SessionList({
  sessions,
  selectedId = null,
  onSelect,
  sort,
  onSortChange,
  compareMode = false,
  compareIds,
  onToggleCompare,
  compareLimit,
  onProjectClick,
  autoHeight = false,
  emptyText = "No sessions in this scope",
}: Props) {
  const unit = useUnit();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || autoHeight) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const updateViewport = () => setViewport(el.clientHeight || 600);
    updateViewport();
    el.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(updateViewport);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [autoHeight]);

  const snapshots = useSnapshotMap();
  const now = useNow(30_000);
  const grouped = !sort || sort.key === "started";
  const { items, total } = useMemo(() => buildItems(sessions, snapshots, grouped && !autoHeight), [sessions, snapshots, grouped, autoHeight]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || autoHeight) return;
    const item = items.find((it) => it.kind === "row" && it.s.id === selectedId);
    if (!item) return;
    const rowTop = item.top;
    const rowBottom = rowTop + item.h;
    if (rowTop < el.scrollTop || rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: rowTop - el.clientHeight / 3, behavior: "smooth" });
    }
  }, [selectedId, items, autoHeight]);

  const startIdx = autoHeight ? 0 : firstItemAt(items, Math.max(0, scrollTop - OVERSCAN_PX));
  const endIdx = autoHeight ? items.length : Math.min(items.length, firstItemAt(items, scrollTop + viewport + OVERSCAN_PX) + 1);
  const offsetTop = items[startIdx]?.top ?? 0;
  const visible = items.slice(startIdx, endIdx);

  const sortHead = (k: SortKey, label: string, title?: string) => {
    if (!sort || !onSortChange) return <span className="st-num" title={title}>{label}</span>;
    const active = sort.key === k;
    return (
      <button
        className={`st-num st-sort ${active ? "active" : ""}`}
        title={title}
        aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}
        onClick={() => onSortChange({ key: k, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      >
        {label}
        <span className="st-sort-arrow" aria-hidden="true">{active ? (sort.dir === "desc" ? "↓" : "↑") : ""}</span>
      </button>
    );
  };

  return (
    <div className={`session-table ${autoHeight ? "auto-height" : ""} ${compareMode ? "compare-mode" : ""}`} role="table" aria-label="Sessions">
      <div className="st-head" role="row">
        <span aria-hidden="true" />
        <span>Session</span>
        <span className="st-col-project">Project</span>
        <span className="st-col-flags" />
        {sortHead("usage", unit === "tokens" ? "Tokens" : "API value", `${unit === "tokens" ? "Fresh tokens" : "API value"}\n${API_VALUE_HINT}`)}
        {sortHead("active", "Active", "Active time: idle gaps over 5 minutes are excluded")}
        {sortHead("started", "Started")}
      </div>
      <div className="st-scroll scrollbar" ref={scrollRef}>
        {sessions.length === 0 ? (
          <div className="list-empty dim">{emptyText}</div>
        ) : (
          <div className="st-inner" style={autoHeight ? undefined : { height: total }}>
            <div style={autoHeight ? undefined : { transform: `translateY(${offsetTop}px)` }}>
              {visible.map((it) => {
                if (it.kind === "head") {
                  return (
                    <div key={it.key} className="st-day" style={{ height: it.h }} role="row">
                      <span className="st-day-label">{it.label}</span>
                      <span className="st-day-meta mono tabular">
                        {it.count} session{it.count > 1 ? "s" : ""} · {unit === "tokens" ? formatTokens(it.fresh) : formatCost(it.cost)}
                      </span>
                    </div>
                  );
                }
                const s = it.s;
                const checked = !!compareIds?.has(s.id);
                const full = compareMode && !checked && !!compareLimit && (compareIds?.size ?? 0) >= compareLimit;
                const activate = () => (compareMode ? onToggleCompare?.(s.id) : onSelect(s.id));
                const snap = snapshots.get(s.id);
                return (
                  <div
                    key={s.id}
                    className={`st-row ${s.live ? "is-live" : ""} ${s.ghost ? "is-ghost" : ""} ${selectedId === s.id ? "selected" : ""} ${checked ? "checked" : ""} ${full ? "full" : ""}`}
                    style={{ height: it.h }}
                    role="row"
                    tabIndex={0}
                    aria-selected={compareMode ? checked : undefined}
                    aria-disabled={full || undefined}
                    aria-current={!compareMode && selectedId === s.id ? "true" : undefined}
                    onClick={activate}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate();
                      }
                    }}
                  >
                    <span className="st-status">
                      {compareMode ? (
                        <span className={`compare-check ${checked ? "on" : ""}`} aria-hidden="true">{checked ? "✓" : ""}</span>
                      ) : (
                        <StatusGlyph s={s} />
                      )}
                    </span>
                    <span className="st-main">
                      <span className="st-goal" title={s.goal}>{s.goal}</span>
                      {snap && <ContextLine snap={snap} now={now} />}
                    </span>
                    <span className="st-col-project">
                      <button
                        type="button"
                        tabIndex={-1}
                        className="st-project"
                        title={onProjectClick ? `Filter on ${s.project}` : s.project}
                        onClick={(e) => {
                          if (!onProjectClick) return;
                          e.stopPropagation();
                          onProjectClick(s.project);
                        }}
                      >
                        <span className="project-dot" style={{ background: projectColor(s.project) }} aria-hidden="true" />
                        <span className="mono">{s.project}</span>
                      </button>
                    </span>
                    <span className="st-col-flags">
                      {canOpenTerminal(s) && (
                        <button
                          type="button"
                          tabIndex={-1}
                          className="terminal-chip"
                          title="Open the terminal running this session"
                          aria-label="Open terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            openTerminal(s.id);
                          }}
                        >›_</button>
                      )}
                      {s.agent === "codex" && (
                        <span className="agent-tag" title="Codex session (~/.codex)">codex</span>
                      )}
                      {s.agent === "copilot" && (
                        <span className="agent-tag" title="Copilot CLI session (~/.copilot)">copilot</span>
                      )}
                      {s.frictions.length > 0 && (
                        <span className="friction-chip" title={`${s.frictions.length} friction point${s.frictions.length > 1 ? "s" : ""} (/insights)`}>
                          △<span className="tabular">{s.frictions.length}</span>
                        </span>
                      )}
                      {s.pluginCapture && (
                        <span className="plugin-chip" title={`Captured by the ${PRODUCT_NAME} plugin: ${s.pluginCapture.entries} tool events`}>◉</span>
                      )}
                    </span>
                    <span
                      className={`st-num mono tabular st-usage ${unit === "usd" ? "is-usd" : ""}`}
                      title={`${formatTokens(freshTokens(s.tokens))} fresh tokens · ${formatCost(s.costUsd)} API value`}
                    >
                      {formatUsage(unit, s.tokens, s.costUsd)}
                    </span>
                    <span className="st-num mono tabular">{formatDuration(s.durationMs)}</span>
                    <span className="st-num mono tabular dim" title={new Date(s.startedAt).toLocaleString()}>{formatRelative(s.startedAt)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ghost cleanup actions, shown above the table while ghosts are filtered and selection is on. */
export function BulkGhostBar({
  sessions,
  compareIds,
  onToggleCompare,
  onBulkDelete,
}: {
  sessions: Session[];
  compareIds: Set<string>;
  onToggleCompare: (id: string) => void;
  onBulkDelete?: (ids: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const emptyGhosts = sessions.filter((s) => s.ghost && s.ghostKind === "empty");
  const selected = Array.from(compareIds);
  const selectedInView = selected.filter((id) => sessions.some((s) => s.id === id));

  const selectEmpty = () => {
    for (const s of emptyGhosts) if (!compareIds.has(s.id)) onToggleCompare(s.id);
  };
  const selectAll = () => {
    for (const s of sessions) if (!compareIds.has(s.id)) onToggleCompare(s.id);
  };
  const clearAll = () => {
    for (const id of selected) if (sessions.some((s) => s.id === id)) onToggleCompare(id);
  };
  const bulkDelete = async () => {
    if (!onBulkDelete || selectedInView.length === 0) return;
    if (!confirm(`Delete ${selectedInView.length} ghost session(s) permanently?\n\nRemoves the transcript jsonl + any stale live file. Cannot be undone.`)) return;
    setBusy(true);
    try {
      await onBulkDelete(selectedInView);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bulk-bar">
      <button className="bulk-btn" onClick={selectEmpty} disabled={emptyGhosts.length === 0}>
        Select empty ({emptyGhosts.length})
      </button>
      <button className="bulk-btn" onClick={selectAll}>
        Select all ({sessions.length})
      </button>
      <button className="bulk-btn" onClick={clearAll} disabled={selectedInView.length === 0}>
        Clear
      </button>
      <button
        className="bulk-btn danger"
        onClick={bulkDelete}
        disabled={busy || selectedInView.length === 0}
      >
        {busy ? "Deleting…" : `Delete selected (${selectedInView.length})`}
      </button>
    </div>
  );
}
