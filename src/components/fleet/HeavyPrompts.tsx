import { useMemo } from "react";
import type { Session } from "../../types";
import { aggregateByPrompt, type PromptStats } from "../../utils/aggregateByPrompt";
import { cacheHit, inputTokens } from "../../utils/fleetStats";
import { formatCost, formatTokens } from "../../utils/format";

interface Props {
  sessions: Session[];
  onSelectSession: (id: string) => void;
  limit?: number;
}

function formatClockFrom(startedAt: string, t: number): string {
  const d = new Date(new Date(startedAt).getTime() + t);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

function promptHit(t: PromptStats["tokens"]): number | null {
  if (inputTokens(t) < 5_000) return null;
  return cacheHit(t);
}

function hitColor(hit: number): string {
  if (hit >= 0.9) return "var(--c-green)";
  if (hit >= 0.7) return "var(--c-amber)";
  return "var(--c-red)";
}

export function HeavyPrompts({ sessions, onSelectSession, limit = 10 }: Props) {
  const top = useMemo(() => {
    type Row = { session: Session; stat: PromptStats };
    const all: Row[] = [];
    for (const s of sessions) {
      if (!s.turns || !s.prompts || s.turns.length === 0 || s.prompts.length === 0) continue;
      const stats = aggregateByPrompt(s.turns, s.model, s.prompts);
      for (const st of stats) {
        if (st.cost > 0) all.push({ session: s, stat: st });
      }
    }
    all.sort((a, b) => b.stat.cost - a.stat.cost);
    return all.slice(0, limit);
  }, [sessions, limit]);

  if (top.length === 0) {
    return (
      <div className="fleet-block">
        <div className="section-title"><span>Heaviest prompts</span></div>
        <div className="placeholder mono dim">No per-prompt data in range.</div>
      </div>
    );
  }

  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>Heaviest prompts · cross-session</span>
        <span className="dim mono tabular">top {top.length}</span>
      </div>
      <div className="heavy-prompts">
        <div className="heavy-prompts-head mono dim caps">
          <span>#</span>
          <span>Project</span>
          <span>Time</span>
          <span>Prompt</span>
          <span className="right">Cost</span>
          <span className="right">Output</span>
          <span className="right">Cache hit</span>
        </div>
        {top.map((r, i) => {
          const p = r.session.prompts?.[r.stat.promptIdx];
          const hit = promptHit(r.stat.tokens);
          return (
            <button
              key={`${r.session.id}-${r.stat.promptIdx}`}
              className="heavy-prompts-row"
              onClick={() => onSelectSession(r.session.id)}
            >
              <span className="mono dim tabular">{i + 1}</span>
              <span className="mono heavy-prompts-project">{r.session.project}</span>
              <span className="mono dim tabular">{formatClockFrom(r.session.startedAt, r.stat.t)}</span>
              <span className="mono heavy-prompts-preview">{p ? p.preview.slice(0, 80) : "—"}</span>
              <span className="mono tabular right" style={{ color: "var(--c-text)", fontWeight: 600 }}>{formatCost(r.stat.cost)}</span>
              <span className="mono tabular right">{formatTokens(r.stat.tokens.output)}</span>
              <span
                className="mono tabular right"
                style={{ color: hit !== null ? hitColor(hit) : "var(--c-text-faint)" }}
                title={hit !== null ? `cacheRead / (input + cacheRead + cacheWrite) = ${formatTokens(r.stat.tokens.cacheRead)} / ${formatTokens(inputTokens(r.stat.tokens))}` : "not enough input data"}
              >
                {hit !== null ? `${(hit * 100).toFixed(0)}%` : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
