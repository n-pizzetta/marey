import { useSyncExternalStore } from "react";
import { formatCost, formatTokens } from "./format";

/**
 * How usage is displayed. Subscribers are limited by the 5h / 7d windows, not by dollars, and raw
 * token totals are dominated by cheap cached reads, so:
 *  - "tokens": fresh tokens only (input + output + cache writes); cached reads are shown apart;
 *  - "usd":    API value, i.e. a relative weight across token kinds and models, not a bill.
 * A "% of window" unit needs a calibration against the real limits and comes later.
 */
export type Unit = "tokens" | "usd";

export const UNITS: Array<{ id: Unit; label: string; hint: string }> = [
  { id: "tokens", label: "Tokens", hint: "Fresh tokens: input + output + cache writes. Cached reads are shown separately." },
  { id: "usd", label: "API value", hint: "What this usage would cost at API prices. Read it as a relative weight: a subscription is limited by the 5h / 7d windows, not dollars." },
];

type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * Tokens that weigh on Claude Code's limits: everything but cached reads, which count about a tenth
 * there. Not on Copilot CLI's quota, which bills reads too: its sessions show their AI credits.
 */
export const freshTokens = (t: Pick<TokenCounts, "input" | "output" | "cacheWrite">): number => t.input + t.output + t.cacheWrite;

export const API_VALUE_HINT = "API value: what this would cost at API prices, used as a relative weight. A subscription is limited by the 5h / 7d windows, not dollars.";

/** Primary figure for a unit, formatted. */
export function formatUsage(unit: Unit, tokens: TokenCounts, costUsd: number): string {
  return unit === "tokens" ? formatTokens(freshTokens(tokens)) : formatCost(costUsd);
}

const KEY = "marey:unit";
const listeners = new Set<() => void>();

function read(): Unit {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "tokens" || v === "usd") return v;
  } catch {
    /* ignore */
  }
  return "tokens";
}

let current: Unit = read();

export function setUnit(u: Unit): void {
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUnit(): Unit {
  return useSyncExternalStore(subscribe, () => current, () => "tokens");
}
