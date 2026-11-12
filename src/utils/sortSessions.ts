import type { Session } from "../types";
import { freshTokens } from "./units";
import { lastActiveMs } from "./lastActive";

export type SortKey = "recent" | "usage" | "active";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Sorts a copy for the session table; ties keep the most recently active first. */
export function sortSessions(sessions: Session[], sort: Sort, unit: "tokens" | "usd"): Session[] {
  const value = (s: Session): number => {
    if (sort.key === "usage") return unit === "tokens" ? freshTokens(s.tokens) : s.costUsd;
    if (sort.key === "active") return s.durationMs;
    return lastActiveMs(s);
  };
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...sessions].sort((a, b) => sign * (value(a) - value(b)) || lastActiveMs(b) - lastActiveMs(a));
}
