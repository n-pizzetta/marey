/** "4.2%" under 10, "13%" above: small shares keep a decimal. */
export function pctText(pct: number): string {
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct)}%`;
}

/** Hours and minutes only ("2h 14m", "12m", "2d 20h"): the page refreshes every few seconds. */
export function formatLeft(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${(m % 60).toString().padStart(2, "0")}m` : `${m}m`;
}

/** "11:00" today, "Sat 10:00" this week, "1 Nov" later: English names, like the rest of the UI. */
export function formatResetAt(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  if (ts - now < 6 * 86_400_000) return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

/** AI credits: whole numbers with separators, one decimal under 100. */
export function formatCredits(n: number): string {
  return n < 100 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n).toLocaleString("en-US");
}
