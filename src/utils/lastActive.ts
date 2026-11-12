import type { Session } from "../types";

/** When the session last did something: a session started yesterday and used today counts for today. */
export function lastActiveMs(s: Pick<Session, "startedAt" | "lastEventAt">): number {
  const started = new Date(s.startedAt).getTime();
  const last = s.lastEventAt ? new Date(s.lastEventAt).getTime() : 0;
  return Math.max(started, Number.isFinite(last) ? last : 0);
}

/** Most recently active first. */
export const byLastActive = (a: Pick<Session, "startedAt" | "lastEventAt">, b: Pick<Session, "startedAt" | "lastEventAt">) => lastActiveMs(b) - lastActiveMs(a);
