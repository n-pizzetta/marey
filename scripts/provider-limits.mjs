/**
 * Plan usage of each provider in one shape for /api/limits, so the dashboard draws them alike:
 *
 * - Claude Code: the 5h and weekly windows its status line reports (limits.json, read and merged
 *   in parse-sessions.mjs).
 * - Codex: the same two windows, logged with every token count in its rollouts (codex.mjs).
 * - Copilot CLI: the monthly quota of AI credits, logged with every model call (copilot.mjs).
 *
 * The last two are per account: the freshest reading among all sessions wins. They are as fresh as
 * the last request made with that CLI on this machine (`capturedAt`), unless Codex's live reading
 * (codex-live-limits.mjs) is fresher.
 */

const FIVE_HOUR_MIN = 300;

/** A window whose reset time has passed is a fresh one: nothing used yet, reset time unknown. */
function current(w, now) {
  if (!w) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return { usedPct: 0, resetsAt: null };
  return { usedPct: w.usedPct, resetsAt: w.resetsAt };
}

/** The freshest reading (by `tsMs`) of a per-account field among parsed sessions. */
export function freshest(parsed, key) {
  let best = null;
  for (const t of parsed) {
    const r = t?.[key];
    if (r && (best === null || (r.tsMs ?? 0) > (best.tsMs ?? 0))) best = r;
  }
  return best;
}

/**
 * Codex limits from a rollout's reading (`rateLimits` from codex.mjs) or a live one, each window
 * placed by its length: the 5h one, then anything longer than a day as the weekly one.
 */
export function codexLimits(best, now = Date.now()) {
  if (!best) return null;
  const out = { capturedAt: best.tsMs ?? null, plan: best.plan, ...(best.live ? { live: true } : {}), fiveHour: null, sevenDay: null };
  for (const [slot, w] of [["fiveHour", best.primary], ["sevenDay", best.secondary]]) {
    if (!w) continue;
    const key = w.windowMinutes === null ? slot : w.windowMinutes <= 1440 ? "fiveHour" : "sevenDay";
    if (key === "fiveHour" && w.windowMinutes !== null && w.windowMinutes !== FIVE_HOUR_MIN) continue;
    out[key] ??= current(w, now);
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

/**
 * Copilot's quota of AI credits (`quota` from copilot.mjs) as a monthly window. Use past the
 * entitlement is overage: the % goes over 100. Null without a quota or on an unlimited plan.
 */
export function copilotLimits(q, now = Date.now()) {
  if (!q || q.unlimited || !q.entitlement) return null;
  const reset = q.resetsAt !== null && q.resetsAt <= now;
  const used = reset ? 0 : (q.used ?? (q.remainingPct !== null ? q.entitlement * (1 - q.remainingPct / 100) : 0));
  return {
    capturedAt: q.tsMs ?? null,
    plan: null,
    month: {
      usedPct: (used / q.entitlement) * 100,
      resetsAt: reset ? null : q.resetsAt,
      used,
      entitlement: q.entitlement,
    },
  };
}
