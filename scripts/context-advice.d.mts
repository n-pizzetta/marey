export type CacheSnapshot = {
  observed: boolean;
  warm: boolean;
  ttl: string | null;
  /** Epoch seconds. */
  expiresAt: number | null;
  requests: number;
  misses: number;
  hitRatio: number | null;
  lastMissCause: string | null;
  recacheTokensIfCold: number | null;
};

export type ContextSnapshot = {
  v: 1;
  sessionId: string;
  /** Epoch ms of the status line refresh. */
  capturedAt: number;
  model: string | null;
  costUsd: number | null;
  context: { usedPct: number | null; size: number | null; tokens: number };
  cache: CacheSnapshot | null;
};

export type Verdict = "keep" | "wrap_up" | "compact_soon" | "compact" | "clear";
export type AdviceLevel = "ok" | "watch" | "act";

export type ContextAdvice = {
  verdict: Verdict;
  label: string;
  level: AdviceLevel;
  reasons: string[];
  cache: { state: "warm" | "cold" | "unknown"; secsLeft: number | null; ttl: string | null; recacheTokens: number | null };
  context: { usedPct: number | null; tokens: number; size: number | null };
};

export const THRESHOLDS: { watch: number; act: number; coldMatters: number; coldTokens: number; expiringSoon: number };
export function expiringSoon(ttl: string | null | undefined): number;
export function toSnapshot(payload: unknown, now?: number): ContextSnapshot | null;
export function adviseContext(snap: ContextSnapshot, now?: number): ContextAdvice;
export function fmtLeft(secs: number): string;
export const SEP: string;
export function gauge(pct: number, width?: number): { filled: string; empty: string };
export function statusSegment(snap: ContextSnapshot, now?: number): string;
