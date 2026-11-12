/**
 * Top-level pages. Each answers one question:
 * now      how much of each plan is used, and which running sessions use it (ignores the scope)
 * sessions which sessions, in the scope (range + filters)
 * usage    where tokens and API value went: the current 5h window, then the scope, then what is worth fixing
 * journal  what was done each day, by project: sessions, commits, pull requests (ignores the scope)
 */
export type Page = "now" | "sessions" | "usage" | "journal";

export const PAGE_IDS: Page[] = ["now", "sessions", "usage", "journal"];

/** Pages in the main navigation, in order; digits 1-4 switch between them. */
export const NAV_PAGES: Array<{ id: Page; label: string }> = [
  { id: "now", label: "Now" },
  { id: "sessions", label: "Sessions" },
  { id: "usage", label: "Usage" },
  { id: "journal", label: "Journal" },
];

/** Pages whose figures follow the range and filters: they show the scope bar. */
export const SCOPED_PAGES: ReadonlySet<Page> = new Set<Page>(["sessions", "usage"]);
