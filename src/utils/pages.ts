/**
 * Top-level pages. Each answers one question:
 * now      how much of each plan is used, and which running sessions use it (ignores the scope)
 * sessions which sessions, in the scope (range + filters)
 * usage    where tokens and API value went: the current 5h window, then the scope
 * health   what to fix in how I work, in the scope
 * context  what agents have in mind at start and what they left on disk, per project
 * journal  what was done each day, by project: sessions, commits, pull requests (ignores the scope)
 */
export type Page = "now" | "sessions" | "usage" | "health" | "context" | "journal";

export const PAGE_IDS: Page[] = ["now", "sessions", "usage", "health", "context", "journal"];

/** Pages in the main navigation, in order; digits 1-6 switch between them. */
export const NAV_PAGES: Array<{ id: Page; label: string }> = [
  { id: "now", label: "Now" },
  { id: "sessions", label: "Sessions" },
  { id: "usage", label: "Usage" },
  { id: "health", label: "Health" },
  { id: "context", label: "Context" },
  { id: "journal", label: "Journal" },
];

/** Pages whose figures follow the range and filters: they show the scope bar. */
export const SCOPED_PAGES: ReadonlySet<Page> = new Set<Page>(["sessions", "usage", "health"]);
