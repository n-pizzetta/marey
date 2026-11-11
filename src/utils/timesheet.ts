/**
 * Time by client: the journal's active time over a week or a month, grouped by the folder each
 * session ran under, with a CSV to start a timesheet from. Built in the browser from the session
 * list. Pure, so it runs under node:test: its only imports are files Node can load as they are.
 */
import type { Session } from "../types";
import { activeTogether, buildJournal, type JournalSession } from "./journal.ts";

export type PeriodId = "week" | "last-week" | "month" | "last-month";
export const PERIODS: Array<{ id: PeriodId; label: string }> = [
  { id: "week", label: "This week" },
  { id: "last-week", label: "Last week" },
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
];

/** Sessions outside the groups' folder. */
export const OTHER = "Other";

/** The period's days, `from` included and `to` excluded, both local midnights. Weeks start on Monday. */
export function periodOf(id: PeriodId, now: number): { from: number; to: number } {
  const d = new Date(now);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  const at = (...ymd: [number, number, number]) => new Date(...ymd).getTime();
  if (id === "month") return { from: at(y, m, 1), to: at(y, m + 1, 1) };
  if (id === "last-month") return { from: at(y, m - 1, 1), to: at(y, m, 1) };
  const monday = day - ((d.getDay() + 6) % 7) - (id === "last-week" ? 7 : 0);
  return { from: at(y, m, monday), to: at(y, m, monday + 7) };
}

/**
 * The folder whose sub-folders are the groups, read from where sessions ran: `~/work` when they
 * run in `~/work/<client>/<project>`. It is the folder with the most sub-folders that each hold
 * at least two projects, and it needs two of them; the deepest wins a tie. Null when the folders
 * show no such layout (every project side by side in one folder). Folders a tool manages (a
 * dot-folder on the way: `~/.copilot/chats/…`) are left out.
 */
export function groupRoot(cwds: Iterable<string | undefined>): string | null {
  // For each folder on the way to a session's folder, the names right under it that lead to one.
  const under = new Map<string, Set<string>>();
  for (const cwd of new Set(cwds)) {
    if (!cwd?.startsWith("/")) continue;
    const parts = cwd.replace(/\/+$/, "").split("/");
    if (parts.some((p) => p.startsWith("."))) continue;
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      let names = under.get(dir);
      if (!names) under.set(dir, (names = new Set()));
      names.add(parts[i]);
    }
  }
  let best: string | null = null;
  let bestScore = 1;
  for (const [dir, names] of under) {
    const score = [...names].filter((n) => (under.get(`${dir}/${n}`)?.size ?? 0) >= 2).length;
    if (score > bestScore || (score === bestScore && best !== null && dir.length > best.length)) {
      best = dir;
      bestScore = score;
    }
  }
  return best;
}

/** The group a session's folder falls in: the sub-folder of `root` it is under, else `OTHER`. */
export function groupOf(cwd: string | undefined, root: string): string {
  if (!cwd?.startsWith(`${root}/`)) return OTHER;
  return cwd.slice(root.length + 1).split("/")[0] || OTHER;
}

export interface TimesheetPart {
  name: string;
  activeMs: number;
}

/** One group on one day. */
export interface TimesheetRow {
  dayMs: number;
  group: string;
  /** Time with at least one of the group's sessions at work that day. */
  activeMs: number;
  /** Its projects that day, most active first. Side by side, they add up to more than the group. */
  projects: TimesheetPart[];
}

export interface TimesheetGroup extends TimesheetPart {
  /** Days it was worked on. */
  days: number;
  projects: TimesheetPart[];
}

export interface Timesheet {
  from: number;
  to: number;
  /** The folder the groups are sub-folders of, or null: then each project is its own group. */
  root: string | null;
  /** Time with at least one session at work, all groups together. */
  activeMs: number;
  /** Most active first, `OTHER` last. */
  groups: TimesheetGroup[];
  /** Oldest day first, then by group. */
  rows: TimesheetRow[];
}

const byTime = (a: TimesheetPart, b: TimesheetPart) => b.activeMs - a.activeMs || (a.name < b.name ? -1 : 1);

/**
 * The active time of `from`–`to` by group and by day. A group's time on a day is the time with
 * at least one of its sessions at work (`activeTogether`): two groups worked side by side each
 * count that time, so groups can add up to more than the total.
 */
export function buildTimesheet(sessions: Session[], { from, to }: { from: number; to: number }): Timesheet {
  const root = groupRoot(sessions.filter((s) => !s.ghost).map((s) => s.cwd));
  const days = buildJournal(sessions, { now: to - 1, days: Math.round((to - from) / 86_400_000) });
  const rows: TimesheetRow[] = [];
  for (const day of [...days].reverse()) {
    const groups = new Map<string, Map<string, JournalSession[]>>();
    for (const p of day.projects) {
      for (const e of p.sessions) {
        const name = root ? groupOf(e.session.cwd, root) : p.label;
        let projects = groups.get(name);
        if (!projects) groups.set(name, (projects = new Map()));
        projects.set(p.label, [...(projects.get(p.label) ?? []), e]);
      }
    }
    for (const [group, projects] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const activeMs = activeTogether([...projects.values()].flat());
      // Under a minute is a session opened and closed: not a line of a timesheet.
      if (activeMs < 60_000) continue;
      rows.push({ dayMs: day.startMs, group, activeMs, projects: [...projects].map(([name, entries]) => ({ name, activeMs: activeTogether(entries) })).sort(byTime) });
    }
  }
  const totals = new Map<string, TimesheetGroup & { parts: Map<string, number> }>();
  for (const r of rows) {
    let g = totals.get(r.group);
    if (!g) totals.set(r.group, (g = { name: r.group, activeMs: 0, days: 0, projects: [], parts: new Map() }));
    g.activeMs += r.activeMs;
    g.days++;
    for (const p of r.projects) g.parts.set(p.name, (g.parts.get(p.name) ?? 0) + p.activeMs);
  }
  const groups = [...totals.values()]
    .map(({ parts, ...g }) => ({ ...g, projects: [...parts].map(([name, activeMs]) => ({ name, activeMs })).sort(byTime) }))
    .sort((a, b) => Number(a.name === OTHER) - Number(b.name === OTHER) || byTime(a, b));
  return { from, to, root, activeMs: days.reduce((n, d) => n + d.activeMs, 0), groups, rows };
}

/** "103h 05m", "42m": hours never roll over into days, unlike a time left. */
export function formatHours(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const hours = (ms: number) => (ms / 3_600_000).toFixed(2);
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The sheet as CSV, one line per day and group: date, group, hours (decimal), and the projects behind them. */
export function timesheetCsv(sheet: Timesheet): string {
  const lines = ["date,group,hours,projects"];
  for (const r of sheet.rows) {
    const projects = r.projects.map((p) => `${p.name} (${hours(p.activeMs)} h)`).join("; ");
    lines.push([isoDay(r.dayMs), r.group, hours(r.activeMs), projects].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** `timesheet-2026-11-09_2026-11-15.csv`: the period's first and last day. */
export const timesheetFileName = (sheet: Timesheet) => `timesheet-${isoDay(sheet.from)}_${isoDay(sheet.to - 1)}.csv`;
