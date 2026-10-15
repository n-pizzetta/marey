import { useEffect, useMemo, useState } from "react";
import type { Agent, Session } from "../../types";
import { FIVE_HOUR_MS } from "../../utils/fleetStats";
import { windowBreakdown } from "../../utils/windowBreakdown";
import { loadWindowStart, saveWindowStart } from "../../utils/windowState";
import { formatCost, formatTokens } from "../../utils/format";
import type { LimitWindow } from "../../utils/rateLimits";
import { inferWindowStart } from "../../utils/planUsage";
import { PROVIDER_LABELS } from "../../utils/providers";
import { KpiRow, type KpiItem } from "../Kpi";
import { WindowConsumers } from "./WindowConsumers";

interface Props {
  /** Claude Code or Codex: both have a 5h window. */
  provider: Agent;
  /** That provider's sessions. */
  sessions: Session[];
  /** The 5h window the provider reported, if any. */
  limit: LimitWindow | null;
  onSelectSession: (id: string) => void;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** Hours and minutes only: the panel refreshes every 5 s and seconds would flicker. */
function formatLeft(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "under 1m";
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${(m % 60).toString().padStart(2, "0")}m` : `${m}m`;
}

/**
 * The current 5h window, in reading order: how much of the limit is used and when it resets,
 * then what is using it. While the window is idle, today's biggest consumers.
 */
export function FiveHourSession({ provider, sessions, limit, onSelectSession }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Only Claude Code keeps an anchor: its status line may be missing for a while; Codex logs its window with each request.
  const keepsAnchor = provider === "claude";
  const [windowStart, setWindowStart] = useState<number | null>(() => (keepsAnchor ? loadWindowStart() : null));
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!keepsAnchor) return;
    const onWindow = () => setWindowStart(loadWindowStart());
    window.addEventListener("marey:window-changed", onWindow);
    window.addEventListener("storage", onWindow);
    return () => {
      window.removeEventListener("marey:window-changed", onWindow);
      window.removeEventListener("storage", onWindow);
    };
  }, [keepsAnchor]);
  // Exact window when the provider reported the reset time (Claude Code's status line, Codex's rollouts).
  const realStart = limit?.resetsAt ? limit.resetsAt - FIVE_HOUR_MS : null;

  // With real limits, keep the local anchor on the real window: a poll without them then
  // continues it instead of jumping to an inferred one. Without: persist an inferred anchor
  // as soon as a new message arrives after the previous window expired (or none was set yet).
  useEffect(() => {
    if (!keepsAnchor) return;
    if (realStart !== null) {
      if (realStart !== windowStart) saveWindowStart(realStart);
      return;
    }
    if (windowStart && now < windowStart + FIVE_HOUR_MS) return;
    const fresh = inferWindowStart(sessions, now, windowStart);
    if (fresh !== null && fresh !== windowStart) {
      saveWindowStart(fresh);
    }
  }, [keepsAnchor, realStart, windowStart, sessions, now]);

  const fromMs = useMemo(
    () => realStart ?? inferWindowStart(sessions, now, windowStart),
    [realStart, sessions, windowStart, now],
  );
  const pct = limit ? limit.usedPct / 100 : null;
  const title = `${PROVIDER_LABELS[provider]} · Current 5h window`;
  const data = useMemo(() => (fromMs !== null ? windowBreakdown(sessions, fromMs, now) : null), [sessions, fromMs, now]);
  const active = fromMs !== null && data !== null && data.total.tokens > 0;
  // While the window is idle, the consumers fall back to today so the page still says what used most.
  const today = useMemo(
    () => (active ? null : windowBreakdown(sessions, new Date(now).setHours(0, 0, 0, 0), now)),
    [active, sessions, now],
  );

  // One card in both states, so going idle or active changes its content, never the card.
  if (!active) {
    return (
      <div className="fleet-block five-hour-session five-hour-idle">
        <div className="section-title">
          <span>{title}</span>
          <span className="dim">{fromMs === null ? "Idle · waiting for the first message" : `Idle · no ${PROVIDER_LABELS[provider]} activity in the last 5h`}</span>
        </div>
        {today && <WindowConsumers key="today" data={today} scope="today" limitPct={null} onSelectSession={onSelectSession} />}
      </div>
    );
  }

  const endMs = fromMs + FIVE_HOUR_MS;
  const estimated = realStart === null;
  const tiles: KpiItem[] = [
    pct !== null
      ? {
          label: "Limit used",
          value: `${Math.round(pct * 100)}%`,
          sub: "of the 5h limit",
          tone: pct >= 0.95 ? "red" : pct >= 0.8 ? "amber" : undefined,
        }
      : {
          label: "Limit used",
          value: "—",
          sub: provider === "claude" ? "not connected" : "not in its sessions yet",
          title: provider === "claude" ? "Run /marey:limits in Claude Code to connect your real 5h and 7-day limits" : undefined,
        },
    {
      label: "Resets in",
      value: formatLeft(endMs - now),
      sub: `at ${formatClock(endMs)}${estimated ? " · estimated" : ""}`,
      title: estimated ? "Estimated from your first message after the previous window: no reset time was reported" : undefined,
    },
    {
      label: "API value",
      value: formatCost(data.total.cost),
      sub: `${formatTokens(data.total.tokens)} tokens`,
      title: "What this window's tokens would cost at API prices: a relative weight, not a bill",
    },
  ];

  return (
    <div className="fleet-block five-hour-session">
      <div className="section-title">
        <span>{title}</span>
        <span className="dim tabular">{formatClock(fromMs)} – {formatClock(endMs)}</span>
      </div>
      <KpiRow items={tiles} />
      <WindowConsumers key="window" data={data} scope="window" limitPct={pct} onSelectSession={onSelectSession} />
    </div>
  );
}
