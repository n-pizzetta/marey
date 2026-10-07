import { useEffect, useState, type ReactNode } from "react";
import { limitColor, useRateLimits, type LimitWindow } from "../utils/rateLimits";
import { FIVE_HOUR_MS } from "../utils/fleetStats";

const SEVEN_DAY_MS = 7 * 86_400_000;

function formatReset(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${(m % 60).toString().padStart(2, "0")}`;
  return `${m}m`;
}

function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Share of the window already elapsed (0..1), or null when the reset time is unknown. */
function elapsedFrac(w: LimitWindow, spanMs: number, now: number): number | null {
  if (w.resetsAt === null) return null;
  return Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / spanMs));
}

/** A button that opens the 5h window when the pill has somewhere to go, else a plain box. */
function Shell({ onOpen, className, label, title, children }: { onOpen?: () => void; className: string; label?: string; title?: string; children: ReactNode }) {
  if (!onOpen) return <div className={className} aria-label={label} title={title}>{children}</div>;
  return (
    <button className={`${className} clickable`} onClick={onOpen} aria-label={label ? `${label}: open the 5h window` : "Open the 5h window"} title={title ?? "Open the current 5h window"}>
      {children}
    </button>
  );
}

/**
 * The 5h and 7-day usage windows, rendered in the top bar and in the session view so they are
 * always on screen. The tick on each bar marks how much of the window has elapsed: a fill past
 * the tick means usage is running faster than time.
 */
export function LimitsPill({ onOpen }: { onOpen?: () => void } = {}) {
  const limits = useRateLimits();
  const now = useNow();
  const rows = [
    limits?.fiveHour && { key: "5h", window: limits.fiveHour, spanMs: FIVE_HOUR_MS },
    limits?.sevenDay && { key: "7d", window: limits.sevenDay, spanMs: SEVEN_DAY_MS },
  ].filter((r): r is { key: string; window: LimitWindow; spanMs: number } => !!r);

  if (rows.length === 0) {
    return (
      <Shell onOpen={onOpen} className="limits-pill off" title="Run /marey:limits in Claude Code to connect your real 5h and 7-day limits">
        <span className="limits-pill-label">Claude limits · not connected</span>
      </Shell>
    );
  }

  return (
    <Shell onOpen={onOpen} className="limits-pill" label="Claude Code usage limits">
      <span className="limits-pill-label">Claude</span>
      {rows.map(({ key, window: w, spanMs }) => {
        const frac = Math.min(1, w.usedPct / 100);
        const color = limitColor(frac);
        const elapsed = elapsedFrac(w, spanMs, now);
        const above = elapsed !== null && frac - elapsed > 0.1;
        return (
          <span
            key={key}
            className={`limits-pill-item ${frac >= 0.95 ? "critical" : ""}`}
            title={`${key} window: ${w.usedPct.toFixed(0)}% used${elapsed !== null ? ` · ${(elapsed * 100).toFixed(0)}% of the window elapsed${above ? " (above pace)" : ""}` : ""}`}
          >
            <span className="limits-pill-label">{key}</span>
            <span className="limits-pill-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPct)}>
              <span className="limits-pill-fill" style={{ width: `${Math.min(100, w.usedPct)}%`, background: color }} />
              {elapsed !== null && <span className="limits-pill-pace" style={{ left: `${elapsed * 100}%` }} />}
            </span>
            <span className="limits-pill-pct tabular" style={{ color }}>{Math.round(w.usedPct)}%</span>
            {w.resetsAt !== null && <span className="limits-pill-reset tabular">{formatReset(w.resetsAt - now)}</span>}
            {above && <span className="limits-pill-above" aria-label="above pace">▲</span>}
          </span>
        );
      })}
    </Shell>
  );
}
