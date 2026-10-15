import { useSyncExternalStore } from "react";
import type { Agent } from "../types";
import { FIVE_HOUR_MS } from "./fleetStats";
import { loadWindowStart } from "./windowState";

/** One usage window of a plan: % used and when it resets (null: unknown, or reset since the reading). */
export type LimitWindow = { usedPct: number; resetsAt: number | null };

/**
 * One provider's plan usage (scripts/provider-limits.mjs): Claude Code and Codex have a 5h and a
 * weekly window; Copilot CLI a monthly quota of AI credits.
 */
export type ProviderLimits = {
  /** When the reading was taken: Codex and Copilot only log their limits with a request. */
  capturedAt: number | null;
  plan?: string | null;
  fiveHour?: LimitWindow | null;
  sevenDay?: LimitWindow | null;
  month?: (LimitWindow & { used: number; entitlement: number }) | null;
};

/** Null per provider until it reports limits (Claude Code: until /marey:limits installs the status line). */
export type RateLimits = Record<Agent, ProviderLimits | null>;

export const SEVEN_DAY_MS = 7 * 86_400_000;
const POLL_MS = 5_000;

// One poll for every component that shows the limits.
let current: RateLimits | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function load() {
  fetch("/api/limits", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      current = d && typeof d === "object" && "claude" in d ? (d as RateLimits) : null;
      for (const l of listeners) l();
    })
    .catch(() => { /* static export: no API */ });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    load();
    timer = setInterval(load, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useRateLimits(): RateLimits | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Exact Claude 5h window start when the real reset time is known, else the locally inferred anchor. */
export function windowStartFrom(limits: RateLimits | null): number | null {
  const resetsAt = limits?.claude?.fiveHour?.resetsAt;
  return resetsAt ? resetsAt - FIVE_HOUR_MS : loadWindowStart();
}

/** `frac` is 0..1. */
export function limitColor(frac: number): string {
  if (frac >= 0.95) return "var(--c-red)";
  if (frac >= 0.8) return "var(--c-amber)";
  // neutral until it matters: colour is a warning, not a progress meter
  return "var(--c-text)";
}
