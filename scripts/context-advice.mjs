/**
 * Context and prompt-cache advice for a live Claude Code session: "keep going, compact, or clear?"
 *
 * Pure and dependency-free, shared by the status line wrapper (Node, installed next to
 * statusline.mjs) and the dashboard (bundled by Vite), like models.mjs.
 *
 * Input is the status line payload Claude Code pipes on every refresh: `context_window` (size, %
 * used, last-turn usage) and `prompt_cache` (warm / ttl / expires_at / recache_tokens_if_cold ...).
 * The thresholds are heuristics; every verdict comes with the reasons it was based on.
 */

const UUID_RE = /^[a-f0-9-]{36}$/i;

export const THRESHOLDS = {
  /** % of the window: from here, plan a /compact at the next natural break. */
  watch: 70,
  /** % of the window: compact now (auto-compaction is near, quality and speed degrade). */
  act: 85,
  /** A cold cache matters from this % of the window or from this many tokens to re-cache (windows can be 1M). */
  coldMatters: 40,
  coldTokens: 100_000,
  /** Seconds left on a warm cache under which a pause is risky (a third of a shorter TTL: `expiringSoon()`). */
  expiringSoon: 600,
};

const TTL_UNIT = { s: 1, m: 60, h: 3600 };

/**
 * Seconds left under which a warm cache is "expiring": 10 min, or a third of a shorter TTL, so a
 * 5-minute cache (Copilot CLI's, or Claude's 5m one) isn't always about to expire.
 */
export function expiringSoon(ttl) {
  const m = /^(\d+)(s|m|h)$/.exec(typeof ttl === "string" ? ttl.trim() : "");
  const secs = m ? Number(m[1]) * TTL_UNIT[m[2]] : null;
  return secs ? Math.min(THRESHOLDS.expiringSoon, secs / 3) : THRESHOLDS.expiringSoon;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Sanitized snapshot of the payload: no paths, no prompts. This is what the wrapper writes to
 * ~/.claude/marey/live/<session_id>.json and what the dashboard reads.
 */
export function toSnapshot(payload, now = Date.now()) {
  const sessionId = payload?.session_id;
  const cw = payload?.context_window;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId) || !cw) return null;
  const u = cw.current_usage ?? {};
  const tokens = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0);
  const pc = payload.prompt_cache;
  return {
    v: 1,
    sessionId,
    capturedAt: now,
    model: typeof payload.model?.id === "string" ? payload.model.id : null,
    costUsd: num(payload.cost?.total_cost_usd),
    context: {
      usedPct: num(cw.used_percentage),
      size: num(cw.context_window_size),
      tokens,
    },
    cache: pc
      ? {
          observed: !!pc.caching_observed,
          warm: !!pc.warm,
          ttl: typeof pc.ttl === "string" ? pc.ttl : null,
          /** Epoch seconds. */
          expiresAt: num(pc.expires_at),
          requests: num(pc.requests) ?? 0,
          misses: num(pc.misses) ?? 0,
          hitRatio: num(pc.hit_ratio),
          lastMissCause: typeof pc.last_miss_cause === "string" ? pc.last_miss_cause : null,
          recacheTokensIfCold: num(pc.recache_tokens_if_cold),
        }
      : null,
  };
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

export function fmtLeft(secs) {
  if (secs < 60) return `${Math.max(0, Math.floor(secs))}s`;
  const m = Math.ceil(secs / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const LABELS = {
  keep: "Keep going",
  wrap_up: "Wrap up or clear before pausing",
  compact_soon: "Compact at the next break",
  compact: "Compact now",
  clear: "Clear if the task is done",
};
/** Short wording for the terminal status line. */
const SHORT = { keep: "", wrap_up: "wrap up?", compact_soon: "compact soon", compact: "compact now", clear: "clear?" };
const RANK = { ok: 0, watch: 1, act: 2 };

/**
 * @returns {{ verdict: string, label: string, level: "ok" | "watch" | "act", reasons: string[],
 *   cache: { state: "warm" | "cold" | "unknown", secsLeft: number | null, ttl: string | null, recacheTokens: number | null },
 *   context: { usedPct: number | null, tokens: number, size: number | null } }}
 */
export function adviseContext(snap, now = Date.now()) {
  const c = snap.cache;
  const secsLeft = c?.expiresAt ? Math.max(0, c.expiresAt - now / 1000) : null;
  // `warm` is only refreshed with the payload: trust the clock once expires_at has passed.
  const state = !c || !c.observed ? "unknown" : c.warm && (secsLeft === null || secsLeft > 0) ? "warm" : "cold";
  const used = snap.context.usedPct;
  const recache = c?.recacheTokensIfCold ?? null;
  const coldMatters = (used ?? 0) >= THRESHOLDS.coldMatters || (recache ?? snap.context.tokens) >= THRESHOLDS.coldTokens;

  /** @type {Array<{ verdict: string, level: "ok" | "watch" | "act" }>} */
  const signals = [];
  const reasons = [];

  if (used !== null) {
    if (used >= THRESHOLDS.act) {
      signals.push({ verdict: "compact", level: "act" });
      reasons.push(`Context is ${used}% full: auto-compaction is near and quality and speed degrade. Compact on your own terms first.`);
    } else if (used >= THRESHOLDS.watch) {
      signals.push({ verdict: "compact_soon", level: "watch" });
      reasons.push(`Context is ${used}% full: compact at a natural break, before it degrades.`);
    }
  }

  if (state === "cold") {
    if (coldMatters) {
      signals.push({ verdict: "clear", level: "act" });
      reasons.push(
        `Cache is cold: your next message re-caches ${recache ? `~${fmtTok(recache)} tokens` : "the whole context"}. ` +
          "/compact must read all of it too, so it costs about as much as that message; /clear skips it.",
      );
    } else {
      reasons.push("Cache is cold, but the context is small: re-caching it is cheap.");
    }
  } else if (state === "warm") {
    if (secsLeft !== null && secsLeft < expiringSoon(c?.ttl) && coldMatters) {
      signals.push({ verdict: "wrap_up", level: "watch" });
      reasons.push(`Cache expires in ${fmtLeft(secsLeft)}: if you pause past that, the next message re-caches ${recache ? `~${fmtTok(recache)} tokens` : "the whole context"}.`);
    }
  } else {
    reasons.push("Cache state unknown (no caching observed yet).");
  }

  if (signals.length === 0 && state !== "unknown") reasons.unshift("Context and cache are healthy.");

  if (c && c.requests >= 10 && c.hitRatio !== null) {
    reasons.push(
      `Cache hit ${(c.hitRatio * 100).toFixed(0)}% over ${c.requests} requests` +
        (c.misses > 0 ? `, ${c.misses} miss${c.misses > 1 ? "es" : ""}${c.lastMissCause ? ` (last: ${c.lastMissCause})` : ""}.` : "."),
    );
  }

  signals.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const top = signals[0] ?? { verdict: "keep", level: "ok" };
  return {
    verdict: top.verdict,
    label: LABELS[top.verdict],
    level: top.level,
    reasons,
    cache: { state, secsLeft, ttl: c?.ttl ?? null, recacheTokens: recache },
    context: { usedPct: used, tokens: snap.context.tokens, size: snap.context.size },
  };
}

const C = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const LEVEL_COLOR = { ok: C.green, watch: C.yellow, act: C.red };
const paint = (color, s) => `${color}${s}${C.reset}`;
/** Separator between status line groups, shared with statusline.mjs. */
export const SEP = paint(C.dim, " │ ");

/** Gauge drawn with box-drawing glyphs (rendered natively by most terminals), e.g. "━━━─────" for 40%. */
export function gauge(pct, width = 8) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return { filled: "━".repeat(filled), empty: "─".repeat(width - filled) };
}

/**
 * Terminal status line segment, e.g. "ctx ━─────── 8% │ cache warm 59m", plus a hint when it matters.
 * Values are colored by level (green / yellow / red); labels stay in the default color to remain legible.
 */
export function statusSegment(snap, now = Date.now()) {
  const a = adviseContext(snap, now);
  const groups = [];
  const used = a.context.usedPct;
  if (used !== null) {
    const level = used >= THRESHOLDS.act ? "act" : used >= THRESHOLDS.watch ? "watch" : "ok";
    const g = gauge(used);
    groups.push(`ctx ${paint(LEVEL_COLOR[level], g.filled)}${paint(C.dim, g.empty)} ${paint(LEVEL_COLOR[level], `${used}%`)}`);
  }
  if (a.cache.state === "warm") {
    const left = a.cache.secsLeft;
    const color = left !== null && left < expiringSoon(a.cache.ttl) ? C.yellow : C.green;
    groups.push(`cache ${paint(color, left !== null ? `warm ${fmtLeft(left)}` : "warm")}`);
  } else if (a.cache.state === "cold") {
    groups.push(`cache ${paint(a.verdict === "clear" ? C.red : C.yellow, "cold")}`);
  }
  if (SHORT[a.verdict]) groups.push(paint(LEVEL_COLOR[a.level], `→ ${SHORT[a.verdict]}`));
  return groups.join(SEP);
}
