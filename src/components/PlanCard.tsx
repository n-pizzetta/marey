import type { PlanUsage, PlanWindow } from "../utils/planUsage";
import { elapsedFrac } from "../utils/planUsage";
import { PROVIDER_LABELS } from "../utils/providers";
import { limitColor } from "../utils/rateLimits";
import { formatCost, formatTokens } from "../utils/format";
import { formatCredits, formatLeft, formatResetAt, pctText } from "../utils/planFormat";
import { forecastLevel } from "../utils/forecast";
import "../plan.css";

interface Props {
  usage: PlanUsage;
  /** Running sessions' slice colors. */
  colors: Map<string, string>;
  /** The session pointed at here or on the sessions board: its slice and its row light up together. */
  hovered: string | null;
  onHover: (id: string | null) => void;
  now: number;
  onSelectSession: (id: string) => void;
  /** Opens the breakdown of the current window (Usage page). */
  onDetails?: () => void;
}

/** Where a provider's numbers come from, and how fresh they are. */
function sourceNote(usage: PlanUsage, now: number): string | null {
  const at = usage.limits?.capturedAt;
  if (!at) return null;
  const ago = now - at;
  if (usage.provider === "claude" || usage.limits?.live) return ago < 120_000 ? "live" : `as of ${formatLeft(ago)} ago`;
  // Otherwise Codex and Copilot log their limits with each request: as old as the last one.
  return ago < 120_000 ? "last request just now" : `last request ${formatLeft(ago)} ago`;
}

/**
 * One provider's plan: each window's % used, split by running session (one slice each) and the
 * rest (ended sessions, other machines), a tick for the time elapsed, when it resets, and where
 * it is heading if the pace holds.
 */
export function PlanCard({ usage, colors, hovered, onHover, now, onSelectSession, onDetails }: Props) {
  const { provider, limits, windows, today } = usage;
  const note = sourceNote(usage, now);
  const connected = windows.some((w) => w.usedPct !== null);
  return (
    <article className={`plan-card plan-${provider}`}>
      <header className="plan-head">
        <span className={`provider-dot ${provider}`} aria-hidden="true" />
        <h3>{PROVIDER_LABELS[provider]}</h3>
        {limits?.plan && <span className="plan-tier">{limits.plan}</span>}
        {note && <span className="plan-source" title={limits?.capturedAt ? new Date(limits.capturedAt).toLocaleString() : undefined}>{note}</span>}
      </header>

      {windows.map((w) => (
        <Meter key={w.key} window={w} colors={colors} hovered={hovered} onHover={onHover} now={now} onSelectSession={onSelectSession} />
      ))}

      {!connected && <NotConnected provider={provider} />}

      <footer className="plan-foot">
        <span className="plan-foot-label">Today</span>
        <span className="tabular">{formatTokens(today.tokens)} tokens</span>
        {provider === "copilot" && today.credits > 0 && <span className="tabular">{formatCredits(today.credits)} AI credits</span>}
        <span className="tabular dim" title="What these tokens would cost at API prices: a relative weight, not a bill">{formatCost(today.cost)} API value</span>
        {onDetails && windows[0]?.key === "fiveHour" && (
          <button className="link-btn plan-details" onClick={onDetails}>What used it →</button>
        )}
      </footer>
    </article>
  );
}

function NotConnected({ provider }: { provider: PlanUsage["provider"] }) {
  if (provider === "claude") {
    return <p className="plan-hint">Run <code>/marey:limits</code> in Claude Code to see the % of your plan. The split below is of this window's use.</p>;
  }
  if (provider === "codex") return <p className="plan-hint">No limits in your Codex sessions yet: they come with its next request.</p>;
  return <p className="plan-hint">No quota in your Copilot CLI sessions yet: it comes with its next request.</p>;
}

interface MeterProps {
  window: PlanWindow;
  colors: Map<string, string>;
  hovered: string | null;
  onHover: (id: string | null) => void;
  now: number;
  onSelectSession: (id: string) => void;
}

function Meter({ window: w, colors, hovered, onHover, now, onSelectSession }: MeterProps) {
  const known = w.usedPct !== null;
  const used = known ? Math.min(100, w.usedPct!) : 100;
  const elapsed = known ? elapsedFrac(w, now) : null;
  const running = w.shares.filter((s) => colors.has(s.session.id));
  // Each running session's slice of the bar: points of the limit, or of the window's use when the limit is unknown.
  const slice = (s: (typeof running)[number]) => (known ? (s.limitPct ?? 0) : s.part * 100);
  const runningPts = running.reduce((n, s) => n + slice(s), 0);
  const rest = Math.max(0, (known ? used : w.shares.length ? 100 : 0) - runningPts);
  const color = known ? limitColor(used / 100) : "var(--c-text)";
  const level = w.forecast ? forecastLevel(w.forecast, w, now) : "flat";
  // The stretch of the bar the pace would still fill by the reset.
  const ahead = w.forecast && level !== "flat" ? Math.min(100, w.forecast.atReset) - used : 0;
  // A slice only lights up in the card whose window the session used; elsewhere nothing dims.
  const pointed = running.find((s) => s.session.id === hovered) ?? null;
  const state = (id: string) => (pointed ? (id === pointed.session.id ? " on" : " off") : "");

  return (
    <div className={`plan-meter ${known ? "" : "unknown"}`}>
      <div className="plan-meter-head">
        <span className="plan-meter-label">{w.label}</span>
        {known ? (
          <span className="plan-meter-pct tabular" style={{ color }}>{pctText(w.usedPct!)}</span>
        ) : (
          <span className="plan-meter-pct off">limit not connected</span>
        )}
        {w.used !== undefined && w.entitlement !== undefined && (
          <span className="plan-meter-count tabular">{formatCredits(w.used)} / {formatCredits(w.entitlement)} AI credits</span>
        )}
        <span className="plan-meter-reset tabular" title={w.estimated && w.fromMs !== null ? "Estimated from your first message after the previous window" : undefined}>
          {resetText(w, now)}
        </span>
      </div>
      <div
        className="plan-bar"
        role="progressbar"
        aria-label={`${w.label}${known ? `: ${pctText(w.usedPct!)} used` : ""}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(used) : undefined}
      >
        {running.map((s) => (
          <button
            key={s.session.id}
            className={`plan-bar-seg${state(s.session.id)}`}
            style={{ width: `${slice(s)}%`, background: colors.get(s.session.id) }}
            aria-label={shareTitle(w, s)}
            onClick={() => onSelectSession(s.session.id)}
            onMouseEnter={() => onHover(s.session.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(s.session.id)}
            onBlur={() => onHover(null)}
          />
        ))}
        {rest > 0 && (
          <span
            className={`plan-bar-rest${pointed ? " off" : ""}`}
            style={{ width: `${rest}%`, background: known ? color : undefined }}
            title={
              w.key === "month"
                ? "Sessions that are no longer running, and use from elsewhere (other machines, IDEs, the web)"
                : "Sessions on this machine that are no longer running"
            }
          />
        )}
        {ahead > 0 && <span className={`plan-bar-ahead${level === "hit" ? " hit" : ""}${pointed ? " off" : ""}`} style={{ width: `${ahead}%` }} aria-hidden="true" />}
        {elapsed !== null && <span className="plan-bar-pace" style={{ left: `${elapsed * 100}%` }} title={`${Math.round(elapsed * 100)}% of the ${w.label.toLowerCase()} elapsed`} />}
      </div>
      {pointed ? (
        // The slice's readout, right under it: which session, how much.
        <div className="plan-meter-note">
          <b>{nameOf(pointed.session)}</b>: <b className="tabular">{pctText(slice(pointed))}</b>{" "}
          {known ? `of the ${pctText(w.usedPct!)}` : "of this window's use"} · {usedText(w, pointed)}
        </div>
      ) : running.length > 0 && (
        <div className="plan-meter-note">
          {known
            ? <>Running sessions: <b className="tabular">{pctText(runningPts)}</b> of the {pctText(w.usedPct!)}</>
            : <>Running sessions: <b className="tabular">{pctText(runningPts)}</b> of this window's use</>}
        </div>
      )}
      {w.forecast && level !== "flat" && (
        <div className={`plan-meter-note plan-forecast ${level}`} title={forecastTitle(w)}>
          {forecastText(w, level, now)}
          {level === "hit" && w.driver && <> · <b>{nameOf(w.driver.session)}</b> is {pctText(w.driver.part * 100)} of it</>}
        </div>
      )}
    </div>
  );
}

/** "At the last hour's pace: limit at 16:40, 50m before the reset", or "≈ 78% at the reset". */
function forecastText(w: PlanWindow, level: "hit" | "rise", now: number): string {
  const f = w.forecast!;
  const pace = f.basis === "recent" ? "At the last hour's pace" : `At this ${w.key === "month" ? "month" : "week"}'s pace`;
  if (level === "hit") return `${pace}: limit ${dayOrTime(f.hitAt!, now)}, ${formatLeft(w.resetsAt! - f.hitAt!)} before the reset`;
  return `${pace}: ≈ ${Math.min(100, Math.round(f.atReset))}% at the reset`;
}

/** "at 16:40" today, "on Sat 10:00" or "on 1 Nov" later. */
const dayOrTime = (ts: number, now: number) => `${new Date(ts).toDateString() === new Date(now).toDateString() ? "at" : "on"} ${formatResetAt(ts, now)}`;

function forecastTitle(w: PlanWindow): string {
  const f = w.forecast!;
  const rate = `${pctText(f.perHour >= 1 ? f.perHour : f.perHour * 24)} of the limit per ${f.perHour >= 1 ? "hour" : "day"}`;
  return f.basis === "recent"
    ? `A projection, not a prediction: ${rate}, the lower of the last 15 and the last 60 minutes' pace, held until the reset. Rough while the reset is hours away.`
    : `A projection, not a prediction: ${rate}, this ${w.key === "month" ? "month" : "week"}'s average so far, held until the reset.`;
}

function resetText(w: PlanWindow, now: number): string {
  if (w.resetsAt !== null) return `resets in ${formatLeft(w.resetsAt - now)} · ${formatResetAt(w.resetsAt, now)}`;
  if (w.key === "fiveHour" && w.fromMs !== null) return `resets in ~${formatLeft(w.fromMs + w.spanMs - now)}`;
  // A week at 0% with no reset time has not started either (Codex reports it so while unopened).
  if (w.key === "fiveHour" || (w.key === "sevenDay" && w.usedPct === 0)) return "idle";
  return "";
}

/** The name the sessions board shows. */
const nameOf = (s: PlanWindow["shares"][number]["session"]) => s.liveName ?? s.project;

const usedText = (w: PlanWindow, s: PlanWindow["shares"][number]) =>
  w.key === "month" ? `${formatCredits(s.credits)} AI credits` : `${formatTokens(s.tokens)} tokens · ${formatCost(s.cost)} API value`;

function shareTitle(w: PlanWindow, s: PlanWindow["shares"][number]): string {
  const name = nameOf(s.session);
  const what = usedText(w, s);
  const pts = s.limitPct !== null ? `${pctText(s.limitPct)} of the limit` : `${pctText(s.part * 100)} of this ${w.label.toLowerCase()}'s use`;
  return `${name}: ${pts} · ${what}`;
}
