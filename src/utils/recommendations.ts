import { useEffect, useState } from "react";

/** Mirrors scripts/recommendations.mjs. */
export type RecKind = "setup" | "permissions" | "feature" | "habit" | "recurring";

export interface RecSession { id: string; goal: string; project: string; count: number; lastAt: string; detail?: string; /** Longest wait on the user, for the waits card. */ waitMs?: number }
export interface RecRow { label: string; count: number; tool: string | null; protective: boolean; reason: string | null }
/** What to do: a line to copy, and a prompt to paste into Claude Code, which explains and applies it. */
export interface RecAction { text: string; snippet?: string; prompt?: string; docs?: string }

export interface Recommendation {
  id: string;
  kind: RecKind;
  /** The effect, counted, in plain words. */
  title: string;
  /** What happens, in one sentence. */
  what: string;
  action?: RecAction;
  /** The mechanism, shown folded. */
  details?: string;
  /** Latest error text, noise stripped. */
  sample?: string;
  /** Denied commands, for the permissions card. */
  rows?: RecRow[];
  count: number;
  sessionCount: number;
  lastAt: string;
  trend: { last7: number; prev7: number };
  /** Sessions started since it last happened. */
  sessionsSince: number;
  sessions: RecSession[];
}

/** What was read: an empty list only means "nothing to fix" when this is not empty. */
export interface RecCoverage {
  windowDays: number;
  sessions: number;
  toolCalls: number;
  toolResults: number;
  failed: number;
  denied: number;
  waits: number;
  warning?: string;
}

export interface RecommendationsPayload { generatedAt: string | null; windowDays: number; cards: Recommendation[]; coverage: RecCoverage | null }

/** Fetches /api/recommendations whenever `version` changes (pass generatedAt); null without the API. */
export function useRecommendations(version: unknown): RecommendationsPayload | null {
  const [data, setData] = useState<RecommendationsPayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/recommendations", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setData(d && Array.isArray(d.cards) ? d : null); })
      .catch(() => { /* static export or mock data: no API */ });
    return () => { cancelled = true; };
  }, [version]);
  return data;
}

const DISMISS_KEY = "marey:recs-dismissed";

/** Card id → its count when dismissed. */
export type Dismissed = Record<string, { count: number; at: string; reason: "done" | "irrelevant" }>;

export function readDismissed(): Dismissed {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function writeDismissed(d: Dismissed) {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

/** A dismissed card comes back once it happens again after the dismissal. */
export function isDismissed(card: Recommendation, d: Dismissed): boolean {
  const x = d[card.id];
  return !!x && card.count <= x.count;
}
