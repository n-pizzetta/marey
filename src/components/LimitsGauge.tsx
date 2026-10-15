import type { ReactNode } from "react";
import type { Agent } from "../types";
import { limitColor, SEVEN_DAY_MS, useRateLimits, type LimitWindow, type RateLimits } from "../utils/rateLimits";
import { FIVE_HOUR_MS } from "../utils/fleetStats";
import { monthStart } from "../utils/planUsage";
import { formatLeft, pctText } from "../utils/planFormat";
import { useNow } from "../utils/useNow";

const SHORT: Record<Agent, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

type Row = { key: string; window: LimitWindow; spanMs: number };

/** A provider's known windows: 5h and 7d (Claude Code, Codex), the month (Copilot CLI). */
function windowsOf(limits: RateLimits | null, provider: Agent, now: number): Row[] {
  const l = limits?.[provider];
  if (!l) return [];
  const rows: Row[] = [];
  if (l.fiveHour) rows.push({ key: "5h", window: l.fiveHour, spanMs: FIVE_HOUR_MS });
  if (l.sevenDay) rows.push({ key: "7d", window: l.sevenDay, spanMs: SEVEN_DAY_MS });
  if (l.month) rows.push({ key: "mo", window: l.month, spanMs: l.month.resetsAt ? l.month.resetsAt - monthStart(l.month.resetsAt, now) : 31 * 86_400_000 });
  return rows;
}

/** Share of the window already elapsed (0..1), or null when the reset time is unknown. */
function elapsedFrac(w: LimitWindow, spanMs: number, now: number): number | null {
  if (w.resetsAt === null) return null;
  return Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / spanMs));
}

/** A button that opens the Now page when the pill has somewhere to go, else a plain box. */
function Shell({ onOpen, className, title, children }: { onOpen?: () => void; className: string; title?: string; children: ReactNode }) {
  if (!onOpen) return <div className={className} title={title}>{children}</div>;
  return (
    <button className={`${className} clickable`} onClick={onOpen} title={title ?? "Open plan usage"} aria-label="Plan usage: open the Now page">
      {children}
    </button>
  );
}

function Item({ label, row, now }: { label: string; row: Row; now: number }) {
  const w = row.window;
  const frac = Math.min(1, w.usedPct / 100);
  const color = limitColor(frac);
  const elapsed = elapsedFrac(w, row.spanMs, now);
  const above = elapsed !== null && frac - elapsed > 0.1;
  return (
    <span
      className={`limits-pill-item ${frac >= 0.95 ? "critical" : ""}`}
      title={`${label} ${row.key}: ${pctText(w.usedPct)} used${w.resetsAt !== null ? ` · resets in ${formatLeft(w.resetsAt - now)}` : ""}${elapsed !== null ? ` · ${Math.round(elapsed * 100)}% of the window elapsed${above ? " (above pace)" : ""}` : ""}`}
    >
      <span className="limits-pill-label">{row.key}</span>
      <span className="limits-pill-bar" role="progressbar" aria-label={`${label} ${row.key}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPct)}>
        <span className="limits-pill-fill" style={{ width: `${Math.min(100, w.usedPct)}%`, background: color }} />
        {elapsed !== null && <span className="limits-pill-pace" style={{ left: `${elapsed * 100}%` }} />}
      </span>
      <span className="limits-pill-pct tabular" style={{ color }}>{Math.round(w.usedPct)}%</span>
      {above && <span className="limits-pill-above" aria-label="above pace">▲</span>}
    </span>
  );
}

/**
 * Plan usage, always on screen: the top bar shows each provider's fullest window (`compact`),
 * the session view every window of the session's provider. The tick on each bar marks how much
 * of the window has elapsed: a fill past it means usage runs faster than time.
 */
export function LimitsPill({ providers, compact = false, onOpen }: { providers: Agent[]; compact?: boolean; onOpen?: () => void }) {
  const limits = useRateLimits();
  const now = useNow(30_000);
  const groups = providers
    .map((p) => {
      const rows = windowsOf(limits, p, now);
      return { p, rows: compact && rows.length > 1 ? [rows.reduce((a, b) => (b.window.usedPct > a.window.usedPct ? b : a))] : rows };
    })
    .filter((g) => g.rows.length > 0);

  if (groups.length === 0) {
    if (!providers.includes("claude")) return null;
    return (
      <Shell onOpen={onOpen} className="limits-pill off" title="Run /marey:limits in Claude Code to connect your real 5h and 7-day limits">
        <span className="limits-pill-label">Claude limits · not connected</span>
      </Shell>
    );
  }

  return (
    <Shell onOpen={onOpen} className="limits-pill">
      {groups.map(({ p, rows }) => (
        <span key={p} className="limits-pill-group">
          <span className="limits-pill-label limits-pill-provider">{SHORT[p]}</span>
          {rows.map((row) => <Item key={row.key} label={SHORT[p]} row={row} now={now} />)}
        </span>
      ))}
    </Shell>
  );
}
