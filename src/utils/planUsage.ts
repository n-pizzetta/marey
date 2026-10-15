import type { Agent, Session } from "../types";
import { costOfTokens, FIVE_HOUR_MS, sumTokens } from "./fleetStats";
import { SEVEN_DAY_MS, type LimitWindow, type ProviderLimits } from "./rateLimits";
import { formatCost, formatTokens } from "./format";
import { formatCredits, pctText } from "./planFormat";

export type PlanWindowKey = "fiveHour" | "sevenDay" | "month";

/** What one session used inside a plan window. */
export interface SessionShare {
  session: Session;
  tokens: number;
  /** API value of those tokens: how the windows are split, as the limits weigh models and token kinds. */
  cost: number;
  /** Copilot CLI: AI credits, what its quota counts. */
  credits: number;
  /** Share of what the window used that this session accounts for (0..1). */
  part: number;
  /** Points of the limit (0..100) this session used, when the limit is known. */
  limitPct: number | null;
}

export interface PlanWindow {
  key: PlanWindowKey;
  label: string;
  /** Null when the provider reported no limit for this window (Claude Code: status line not installed). */
  usedPct: number | null;
  resetsAt: number | null;
  /** Window start: from the reset time, else inferred from local activity (`estimated`). */
  fromMs: number | null;
  spanMs: number;
  estimated: boolean;
  /** Copilot CLI: AI credits used and included this month. */
  used?: number;
  entitlement?: number;
  /** Heaviest first. */
  shares: SessionShare[];
  total: { tokens: number; cost: number; credits: number };
}

export interface PlanUsage {
  provider: Agent;
  limits: ProviderLimits | null;
  /** The window to watch first: the 5h one, else the month. */
  windows: PlanWindow[];
  today: { tokens: number; cost: number; credits: number };
}

const DAY_MS = 86_400_000;

/** What each session used in [fromMs, toMs], weighed like the provider's limit counts it. */
function sharesIn(sessions: Session[], fromMs: number, toMs: number, weigh: "cost" | "credits") {
  const rows: Omit<SessionShare, "part" | "limitPct">[] = [];
  const total = { tokens: 0, cost: 0, credits: 0 };
  for (const s of sessions) {
    if (!s.turns?.length) continue;
    const startMs = Date.parse(s.startedAt);
    // Cheap skip: this runs every few seconds over the whole history.
    if (startMs > toMs || (s.lastEventAt && Date.parse(s.lastEventAt) < fromMs)) continue;
    let tokens = 0;
    let cost = 0;
    let credits = 0;
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts < fromMs || ts > toMs) continue;
      tokens += sumTokens(t.tokens);
      cost += costOfTokens(t.model ?? s.model, t.tokens);
      credits += t.credits ?? 0;
    }
    if (tokens === 0) continue;
    rows.push({ session: s, tokens, cost, credits });
    total.tokens += tokens;
    total.cost += cost;
    total.credits += credits;
  }
  const key: "credits" | "cost" | "tokens" = weigh === "credits" ? "credits" : total.cost > 0 ? "cost" : "tokens";
  rows.sort((a, b) => b[key] - a[key] || (a.session.id < b.session.id ? -1 : 1));
  return { rows, total, key };
}

/**
 * Start of the current 5h window without a reported reset time: the first message after the
 * previous window ended, walking forward over the last day's activity. Null while idle.
 */
export function inferWindowStart(sessions: Session[], now: number, anchor: number | null = null): number | null {
  if (anchor !== null && anchor <= now && now < anchor + FIVE_HOUR_MS) return anchor;
  const since = Math.max(anchor !== null ? anchor + FIVE_HOUR_MS : 0, now - DAY_MS);
  const times: number[] = [];
  for (const s of sessions) {
    if (!s.turns?.length || (s.lastEventAt && Date.parse(s.lastEventAt) < since)) continue;
    const startMs = Date.parse(s.startedAt);
    for (const t of s.turns) {
      const ts = startMs + t.t;
      if (ts > since && ts <= now) times.push(ts);
    }
  }
  times.sort((a, b) => a - b);
  let start: number | null = null;
  for (const ts of times) if (start === null || ts >= start + FIVE_HOUR_MS) start = ts;
  return start !== null && now < start + FIVE_HOUR_MS ? start : null;
}

/** First day of the month a monthly quota resetting at `resetsAt` covers (UTC, as GitHub bills). */
export function monthStart(resetsAt: number | null, now: number): number {
  const d = new Date(resetsAt ?? now);
  return resetsAt !== null ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate()) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function makeWindow(
  key: PlanWindowKey,
  sessions: Session[],
  limit: LimitWindow | null,
  fromMs: number | null,
  spanMs: number,
  now: number,
  extra: Partial<PlanWindow> = {},
): PlanWindow {
  const label = key === "fiveHour" ? "5h window" : key === "sevenDay" ? "Week" : "Month";
  const usedPct = limit?.usedPct ?? null;
  const base = { key, label, usedPct, resetsAt: limit?.resetsAt ?? null, fromMs, spanMs, estimated: false, ...extra };
  if (fromMs === null) return { ...base, shares: [], total: { tokens: 0, cost: 0, credits: 0 } };
  const { rows, total, key: weigh } = sharesIn(sessions, fromMs, now, key === "month" ? "credits" : "cost");
  const of = weigh === "credits" ? (extra.used ?? total.credits) : total[weigh];
  const shares = rows.map((r) => {
    const part = of > 0 ? Math.min(1, r[weigh] / of) : 0;
    let limitPct: number | null = null;
    if (key === "month") {
      if (extra.entitlement && r.session.aiCredits !== null) limitPct = (r.credits / extra.entitlement) * 100;
    } else if (usedPct !== null) limitPct = part * usedPct;
    return { ...r, part, limitPct };
  });
  return { ...base, shares, total };
}

/** A provider's plan windows and what each session used of them; `sessions` are that provider's. */
export function planUsage(provider: Agent, sessions: Session[], limits: ProviderLimits | null, now: number, anchor: number | null = null): PlanUsage {
  const windows: PlanWindow[] = [];
  if (provider === "copilot") {
    const m = limits?.month ?? null;
    const fromMs = monthStart(m?.resetsAt ?? null, now);
    const spanMs = m?.resetsAt ? m.resetsAt - fromMs : 31 * DAY_MS;
    windows.push(makeWindow("month", sessions, m, fromMs, spanMs, now, m ? { used: m.used, entitlement: m.entitlement } : {}));
  } else {
    const five = limits?.fiveHour ?? null;
    const fromMs = five?.resetsAt ? five.resetsAt - FIVE_HOUR_MS : inferWindowStart(sessions, now, five ? null : anchor);
    windows.push(makeWindow("fiveHour", sessions, five, fromMs, FIVE_HOUR_MS, now, { estimated: !five?.resetsAt }));
    const week = limits?.sevenDay ?? null;
    if (week) windows.push(makeWindow("sevenDay", sessions, week, week.resetsAt ? week.resetsAt - SEVEN_DAY_MS : null, SEVEN_DAY_MS, now));
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const { total } = sharesIn(sessions, midnight, now, "cost");
  return { provider, limits, windows, today: total };
}

/** Share of a window already elapsed (0..1), or null when its reset time is unknown. */
export function elapsedFrac(w: Pick<PlanWindow, "resetsAt" | "spanMs" | "fromMs">, now: number): number | null {
  if (w.resetsAt !== null) return Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / w.spanMs));
  return null;
}

/** Colors for running sessions, matched between the plan bars and the sessions board. */
export const SESSION_PALETTE = [
  "var(--c-cyan)",
  "var(--c-violet)",
  "var(--c-lime)",
  "var(--c-coral)",
  "var(--c-pink)",
  "var(--c-teal)",
  "var(--c-periwinkle)",
];

/**
 * One color per running session, by start time within its provider: distinct inside each plan card,
 * and a session keeps its color while others come and go.
 */
export function sessionColors(sessions: Session[]): Map<string, string> {
  const out = new Map<string, string>();
  const next = new Map<string, number>();
  const live = sessions.filter((s) => s.live).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.id < b.id ? -1 : 1));
  for (const s of live) {
    const p = s.agent ?? "claude";
    const i = next.get(p) ?? 0;
    next.set(p, i + 1);
    out.set(s.id, SESSION_PALETTE[i % SESSION_PALETTE.length]);
  }
  return out;
}

/** A running session's use of its plan, as the sessions board shows it. */
export type RowUsage = { value: string; of: string; title: string };

/**
 * What each running session used of its plan's main window: points of the 5h limit (Claude Code,
 * Codex) or of the month's AI credits (Copilot CLI), else its share of the window's use.
 */
export function runningUsage(plans: PlanUsage[]): Map<string, RowUsage> {
  const out = new Map<string, RowUsage>();
  for (const plan of plans) {
    const w = plan.windows[0];
    if (!w) continue;
    const window = w.key === "month" ? "this month" : "this 5h window";
    for (const s of w.shares) {
      if (!s.session.live) continue;
      const used = w.key === "month" ? `${formatCredits(s.credits)} AI credits` : `${formatTokens(s.tokens)} tokens · ${formatCost(s.cost)} API value`;
      if (w.key === "month" && s.session.aiCredits === null) {
        out.set(s.session.id, { value: "—", of: "", title: "This Copilot CLI version doesn't log what each request costs" });
      } else if (s.limitPct !== null) {
        out.set(s.session.id, {
          value: pctText(s.limitPct),
          of: w.key === "month" ? "of month" : "of 5h",
          title: `${pctText(s.limitPct)} of the ${w.key === "month" ? "monthly quota" : "5h limit"} · ${pctText(s.part * 100)} of what ${window} used\n${used}`,
        });
      } else {
        out.set(s.session.id, { value: pctText(s.part * 100), of: w.key === "month" ? "of month" : "of window", title: `${pctText(s.part * 100)} of what ${window} used (limit not connected)\n${used}` });
      }
    }
  }
  return out;
}
