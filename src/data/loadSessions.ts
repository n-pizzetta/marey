import type { Session } from "../types";
import { sessions as mockSessions } from "./mockSessions";
import { setModelOverrides } from "../../scripts/models.mjs";

/** Where the sessions on screen come from; "stale" keeps the last real list while the server doesn't answer. */
export type DataSource = "real" | "mock" | "stale";

export interface LoadResult {
  sessions: Session[];
  source: "real" | "mock";
  count: number;
  generatedAt?: string;
  error?: string;
  parseErrors?: string[];
}

interface Payload {
  generatedAt?: string;
  sessions?: Session[];
  errors?: string[];
  /** User pricing overrides applied by the server; mirrored so UI-side costs match. */
  models?: Record<string, unknown>;
}

/**
 * Loads the lightweight session list from the local server.
 *
 * Heavy fields (toolSequence, turns, prompts, fileHistory) are omitted on
 * purpose — `loadSessionDetail(id)` fetches the full session on demand.
 *
 * Falls back to the bundled mock data when the API is unreachable so the
 * dashboard still renders during local development without ~/.claude/.
 */
export async function loadSessions(): Promise<LoadResult> {
  try {
    // no-cache: revalidate with the ETag, so an unchanged list comes back as a cheap 304.
    const res = await fetch("/api/sessions", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Payload | Session[];
    const arr = Array.isArray(data) ? data : data.sessions;
    const generatedAt = Array.isArray(data) ? undefined : data.generatedAt;
    const parseErrors = Array.isArray(data) ? undefined : data.errors;
    if (!Array.isArray(data)) setModelOverrides(data.models);
    if (!Array.isArray(arr)) throw new Error("invalid payload");
    return {
      sessions: arr,
      source: "real",
      count: arr.length,
      generatedAt,
      parseErrors,
    };
  } catch (err) {
    return {
      sessions: mockSessions,
      source: "mock",
      count: mockSessions.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetches the full Session object for a single id. The summary returned by
 * `loadSessions()` is missing heavy fields; this hydrates them when the user
 * opens a session detail view.
 *
 * Returns `null` on 404, throws on other errors. Mock sessions short-circuit:
 * they already carry their full payload.
 */
export async function loadSessionDetail(id: string): Promise<Session | null> {
  const mock = mockSessions.find((s) => s.id === id);
  if (mock) return mock;
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Session;
}
