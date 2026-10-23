import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../types";
import type { Spike } from "../../utils/burnTracker";
import { sumTokens, costOfTokens } from "../../utils/fleetStats";
import type { PromptStats } from "../../utils/aggregateByPrompt";
import { windowBreakdown } from "../../utils/windowBreakdown";
import { loadSessionDetail } from "../../data/loadSessions";
import { formatCost, formatDuration, formatTokens } from "../../utils/format";
import { runHeuristics, type HeuristicHit } from "./SpikeHeuristics";

interface Props {
  spike: Spike;
  sessions: Session[];
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

/** Sessions whose details are fetched for the heuristics: the heaviest in the window. */
const MAX_DETAILS = 8;

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export function SpikeAnalysisOverlay({ spike, sessions, onClose, onSelectSession }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { fromMs, toMs } = spike;

  // Each prompt counts only its turns inside the window, the one still running included.
  const breakdown = useMemo(() => windowBreakdown(sessions, fromMs, toMs), [sessions, fromMs, toMs]);
  const sessionsInWindow = breakdown.sessions;
  const promptsInWindow = breakdown.prompts.slice(0, 10);

  // The list has no calls: the heuristics on tool results need the details of the sessions that burned.
  const [details, setDetails] = useState<Map<string, Session>>(new Map());
  const burnedIds = sessionsInWindow.slice(0, MAX_DETAILS).map((r) => r.s.id).join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = burnedIds ? burnedIds.split(",") : [];
    Promise.all(ids.map((id) => loadSessionDetail(id).catch(() => null))).then((list) => {
      if (!cancelled) setDetails(new Map(list.filter((d): d is Session => !!d).map((d) => [d.id, d])));
    });
    return () => { cancelled = true; };
  }, [burnedIds]);

  const toolBreakdown = useMemo(() => {
    const counts = new Map<string, { calls: number; turns: number }>();
    for (const s of sessions) {
      if (!s.turns) continue;
      const startMs = new Date(s.startedAt).getTime();
      for (const t of s.turns) {
        const ts = startMs + t.t;
        if (ts < fromMs || ts > toMs) continue;
        for (const tool of t.tools) {
          const cur = counts.get(tool) ?? { calls: 0, turns: 0 };
          cur.calls += 1;
          counts.set(tool, cur);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([tool, v]) => ({ tool, ...v }))
      .sort((a, b) => b.calls - a.calls);
  }, [sessions, fromMs, toMs]);

  const heuristics: HeuristicHit[] = useMemo(
    () => runHeuristics(sessionsInWindow.map((r) => details.get(r.s.id) ?? r.s), fromMs, toMs),
    [sessionsInWindow, details, fromMs, toMs],
  );

  const totalBurn = breakdown.total;

  return (
    <div className="spike-analysis-overlay" role="dialog" aria-label="Spike analysis">
      <div className="spike-analysis-head">
        <div className="spike-analysis-head-left">
          <div className="spike-analysis-title mono caps dim">Spike analysis</div>
          <div className="spike-analysis-window mono">
            {formatClock(spike.fromMs)} → {formatClock(spike.toMs)}
            <span className="dim"> · {formatDuration(spike.toMs - spike.fromMs)}</span>
          </div>
          <div className="spike-analysis-burn mono">
            <strong>{formatTokens(totalBurn.tokens)}</strong>
            <span className="dim"> tokens · </span>
            <strong style={{ color: "var(--c-amber)" }}>{formatCost(totalBurn.cost)}</strong>
            <span className="dim"> · </span>
            <strong style={{ color: spike.critical ? "var(--c-red)" : "var(--c-amber)" }}>
              +{(spike.deltaPct * 100).toFixed(1)}pp
            </strong>
            <span className="dim"> ({(spike.fromPct * 100).toFixed(1)}% → {(spike.toPct * 100).toFixed(1)}%)</span>
          </div>
        </div>
        <button className="spike-analysis-close" onClick={onClose} aria-label="Close (Esc)">✕</button>
      </div>

      <div className="spike-analysis-body scrollbar">
        <SpikeHeuristicsPanel hits={heuristics} />

        <SpikeSessionsTable rows={sessionsInWindow} totalTokens={totalBurn.tokens} onSelect={onSelectSession} />

        <SpikePromptsTable rows={promptsInWindow} onSelect={onSelectSession} />

        <SpikeToolBreakdown rows={toolBreakdown} sessions={sessions} fromMs={fromMs} toMs={toMs} />
      </div>
    </div>
  );
}

function SpikeHeuristicsPanel({ hits }: { hits: HeuristicHit[] }) {
  return (
    <div className="spike-section">
      <div className="section-title">
        <span>What could've been avoided</span>
        <span className="dim mono tabular">{hits.length} signal{hits.length === 1 ? "" : "s"}</span>
      </div>
      {hits.length === 0 ? (
        <div className="clean-row">
          <span style={{ color: "var(--c-green)" }}>✓</span> Spike pattern looks normal — no obvious avoidable cause detected.
        </div>
      ) : (
        <div className="spike-heuristics">
          {hits.map((h, i) => (
            <div key={i} className={`spike-heuristic kind-${h.severity}`}>
              <span className="spike-heuristic-icon">{h.severity === "warn" ? "⚠️" : "ℹ️"}</span>
              <div>
                <div className="spike-heuristic-title">{h.title}</div>
                <div className="mono dim spike-heuristic-detail">{h.detail}</div>
                <div className="mono spike-heuristic-recommend">→ {h.recommend}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpikeSessionsTable({
  rows,
  totalTokens,
  onSelect,
}: {
  rows: Array<{ s: Session; tokens: number; cost: number }>;
  totalTokens: number;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="spike-section">
        <div className="section-title"><span>Sessions in window</span></div>
        <div className="placeholder mono dim">No session activity captured in the window.</div>
      </div>
    );
  }
  return (
    <div className="spike-section">
      <div className="section-title">
        <span>Sessions in window</span>
        <span className="dim mono tabular">{rows.length}</span>
      </div>
      <div className="spike-table">
        <div className="spike-table-head spike-sessions-grid mono dim caps">
          <span>#</span><span>Project</span><span>Goal</span>
          <span className="right">Tokens</span><span className="right">Cost</span><span className="right">% of spike</span>
        </div>
        {rows.map((r, i) => {
          const share = totalTokens > 0 ? (r.tokens / totalTokens) * 100 : 0;
          return (
            <button key={r.s.id} className="spike-table-row spike-sessions-grid" onClick={() => onSelect(r.s.id)}>
              <span className="mono dim tabular">{i + 1}</span>
              <span className="mono spike-cell-trunc">{r.s.project}</span>
              <span className="spike-cell-trunc">{r.s.goal || "—"}</span>
              <span className="mono tabular right">{formatTokens(r.tokens)}</span>
              <span className="mono tabular right" style={{ color: "var(--c-amber)" }}>{formatCost(r.cost)}</span>
              <span className="mono tabular right">{share.toFixed(1)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpikePromptsTable({
  rows,
  onSelect,
}: {
  rows: Array<{ session: Session; stat: PromptStats }>;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="spike-section">
        <div className="section-title"><span>Prompts in window</span></div>
        <div className="placeholder mono dim">No prompt-level activity captured.</div>
      </div>
    );
  }
  return (
    <div className="spike-section">
      <div className="section-title">
        <span>Top prompts in window</span>
        <span className="dim mono tabular">top {rows.length}</span>
      </div>
      <div className="spike-table">
        <div className="spike-table-head spike-prompts-grid mono dim caps">
          <span>#</span><span>Project</span><span>Prompt</span>
          <span className="right">Cost</span><span className="right">Turns</span><span className="right">Output</span>
        </div>
        {rows.map((r, i) => {
          const p = r.session.prompts?.[r.stat.promptIdx];
          return (
            <button key={`${r.session.id}-${r.stat.promptIdx}`} className="spike-table-row spike-prompts-grid" onClick={() => onSelect(r.session.id)}>
              <span className="mono dim tabular">{i + 1}</span>
              <span className="mono spike-cell-trunc">{r.session.project}</span>
              <span className="mono spike-cell-trunc">{p ? p.preview.slice(0, 80) : "—"}</span>
              <span className="mono tabular right" style={{ color: "var(--c-amber)" }}>{formatCost(r.stat.cost)}</span>
              <span className="mono tabular right">{r.stat.turnCount}</span>
              <span className="mono tabular right">{formatTokens(r.stat.tokens.output)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpikeToolBreakdown({
  rows,
  sessions,
  fromMs,
  toMs,
}: {
  rows: Array<{ tool: string; calls: number }>;
  sessions: Session[];
  fromMs: number;
  toMs: number;
}) {
  // Per-tool token accounting: assistant turn that called the tool gets attributed.
  // Simplification: split turn tokens equally across its tools, then sum per tool.
  const tokensByTool = useMemo(() => {
    const m = new Map<string, { tokens: number; cost: number }>();
    for (const s of sessions) {
      if (!s.turns) continue;
      const startMs = new Date(s.startedAt).getTime();
      for (const t of s.turns) {
        const ts = startMs + t.t;
        if (ts < fromMs || ts > toMs) continue;
        if (t.tools.length === 0) continue;
        const turnTokens = sumTokens(t.tokens);
        const turnCost = costOfTokens(t.model ?? s.model, t.tokens);
        for (const tool of t.tools) {
          const cur = m.get(tool) ?? { tokens: 0, cost: 0 };
          cur.tokens += turnTokens / t.tools.length;
          cur.cost += turnCost / t.tools.length;
          m.set(tool, cur);
        }
      }
    }
    return m;
  }, [sessions, fromMs, toMs]);

  if (rows.length === 0) {
    return (
      <div className="spike-section">
        <div className="section-title"><span>Tool breakdown</span></div>
        <div className="placeholder mono dim">No tool calls captured in window.</div>
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.calls));
  const totalCalls = rows.reduce((a, r) => a + r.calls, 0);
  return (
    <div className="spike-section">
      <div className="section-title">
        <span>Tool breakdown</span>
        <span className="dim mono tabular">{totalCalls} calls</span>
      </div>
      <div className="spike-tools">
        {rows.map((r) => {
          const pct = (r.calls / max) * 100;
          const tk = tokensByTool.get(r.tool);
          return (
            <div key={r.tool} className="spike-tool-row">
              <span className="mono spike-tool-name">{r.tool}</span>
              <div className="spike-tool-bar-wrap">
                <div className="spike-tool-bar" style={{ width: `${pct}%` }} />
              </div>
              <span className="mono tabular right">{r.calls}</span>
              <span className="mono dim tabular right">{tk ? formatTokens(Math.round(tk.tokens)) : "—"}</span>
              <span className="mono dim tabular right">{tk ? formatCost(tk.cost) : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
