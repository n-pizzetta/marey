import { useEffect, useState } from "react";

/** One call, whole, from `/api/sessions/:id/calls/:callId` (scripts/parse-sessions.mjs, sessionCall). */
export interface CallDetail {
  input: unknown;
  /** Null while the call runs. `cut`: the result's length when it was longer than what came back. */
  output: { text: string; cut?: number } | null;
  isError: boolean;
  /** The call as its transcript wrote it: Claude Code's tool_use block, Codex's payload, Copilot CLI's event. */
  raw?: unknown;
}

/** Calls that are done don't change: fetched once per page load. */
const done = new Map<string, CallDetail>();

/**
 * The whole input and result of a call once its row is open. `failed`: no server (the demo data) or
 * no such call; the row keeps the preview the session's payload carries.
 */
export function useCallDetail(sessionId: string, callId: string | undefined, open: boolean): { data: CallDetail | null; loading: boolean; failed: boolean } {
  const key = callId ? `${sessionId}/${callId}` : null;
  const [state, setState] = useState<{ key: string | null; data: CallDetail | null; failed: boolean }>({ key: null, data: null, failed: false });
  const cached = key ? done.get(key) ?? null : null;
  useEffect(() => {
    if (!open || !key || done.has(key)) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId!)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<CallDetail>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (data.output) done.set(key, data);
        if (!cancelled) setState({ key, data, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key, data: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, key, sessionId, callId]);
  if (cached) return { data: cached, loading: false, failed: false };
  const mine = state.key === key ? state : { data: null, failed: false };
  return { data: mine.data, loading: open && !!key && !mine.data && !mine.failed, failed: mine.failed };
}
