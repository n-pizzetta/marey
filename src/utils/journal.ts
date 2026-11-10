/**
 * The journal: what was done each day, by project. Sessions with a readable headline, the commits
 * they made and the pull requests they opened, ready to paste into a standup. Built in the
 * browser from the session list (turn times, `commitLog`, `prLog`). Pure, so it runs under
 * node:test: its only imports are files Node can load as they are.
 */
import type { Session } from "../types";
import { costOf } from "../../scripts/models.mjs";
import { formatLeft } from "./planFormat.ts";

/** Same cap as the parser's active time (`IDLE_CAP_MS` in scripts/transcript-utils.mjs). */
const IDLE_CAP_MS = 5 * 60_000;

export interface JournalPr {
  at: number;
  url: string;
  title: string | null;
  /** "365" from `…/pull/365`. */
  number: string | null;
}

/** One session's part of one day. */
export interface JournalSession {
  session: Session;
  headline: string;
  /** Its first activity that day. */
  firstAt: number;
  activeMs: number;
  cost: number;
  commits: Array<{ at: number; subject: string }>;
  prs: JournalPr[];
}

export interface JournalProject {
  project: string;
  /** Time with at least one of its sessions at work: sessions running side by side count once. */
  activeMs: number;
  cost: number;
  /** In the order they started that day. */
  sessions: JournalSession[];
}

export interface JournalDay {
  /** Local midnight. */
  startMs: number;
  /** Time with at least one session at work, across projects. */
  activeMs: number;
  cost: number;
  sessions: number;
  commits: number;
  prs: number;
  /** Most active first. */
  projects: JournalProject[];
}

/** Local midnight of the day `ts` falls in. */
export function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// What a prompt can start with that is not something the user asked for.
const NOT_A_HEADLINE = /^\s*(<(bash-input|bash-stdout|local-command|command-name|command-message|task-notification|system-reminder)\b|This session is being continued|\[Request interrupted|Caveat:)/i;

/** `text` as one line a reader can scan, or "" when it is no headline (a shell input, a continuation notice). */
function readable(text: string | undefined | null): string {
  if (!text || NOT_A_HEADLINE.test(text)) return "";
  // Pasted blocks and other wrappers keep their content: only the tags go.
  const line = text.replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
  return line.length > 110 ? `${line.slice(0, 109).trimEnd()}…` : line;
}

/**
 * What a session was about, in one line: its goal (a title when the CLI or the user gave one),
 * else its first prompt that reads as a request. A running session's own name (`marey-0b`) says
 * less than its prompt, so it comes last.
 */
export function headlineOf(s: Session): string {
  const goal = s.goal && s.goal !== s.liveName ? readable(s.goal) : "";
  if (goal) return goal;
  for (const p of s.prompts ?? []) {
    const line = readable(p.preview);
    if (line) return line;
  }
  return readable(s.summary) || s.liveName || "Untitled session";
}

type Span = [from: number, to: number];
/** One session's activity on one day: the stretches between its events (capped like the parser's active time), their sum, API value and first event. */
interface DayActivity {
  spans: Span[];
  gaps: number;
  cost: number;
  firstAt: number;
  events: number;
}

/** Total length covered by `spans`, overlaps counted once. */
function covered(spans: Span[]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/** A session's activity split by day. */
function byDay(s: Session): Map<number, DayActivity> {
  const start = Date.parse(s.startedAt);
  const days = new Map<number, DayActivity>();
  const slot = (ts: number) => {
    const key = dayStart(ts);
    let d = days.get(key);
    if (!d) days.set(key, (d = { spans: [], gaps: 0, cost: 0, firstAt: ts, events: 0 }));
    return d;
  };
  const times: number[] = [];
  for (const t of s.turns ?? []) {
    const ts = start + t.t;
    times.push(ts);
    slot(ts).cost += costOf(t.model ?? s.model, t.tokens);
  }
  for (const p of s.prompts ?? []) times.push(start + p.t);
  // No turns (the transcript is gone): the whole session on the day it started.
  if (times.length === 0) {
    const d = slot(start);
    d.cost = s.costUsd;
    d.events = 1;
    return days;
  }
  times.sort((a, b) => a - b);
  let prev: number | null = null;
  for (const ts of times) {
    const d = slot(ts);
    d.events++;
    if (ts < d.firstAt) d.firstAt = ts;
    if (prev !== null) {
      const gap = Math.min(ts - prev, IDLE_CAP_MS);
      d.gaps += gap;
      d.spans.push([ts - gap, ts]);
    }
    prev = ts;
  }
  return days;
}

/**
 * The last `days` days up to `now` (today included) that saw any activity, newest first. A session
 * spanning several days appears in each, with that day's share of its active time (the parser's
 * `durationMs`, split like the gaps between its events) and the API value of that day's turns.
 * A project's and a day's time is the time with at least one session at work: sessions running
 * side by side count once (`together`). Ghosts are left out. A commit or a pull request two
 * sessions both hold (a fork's copy) counts once.
 */
export function buildJournal(sessions: Session[], { now, days = 7 }: { now: number; days?: number }): JournalDay[] {
  const today = new Date(dayStart(now));
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
  const out = new Map<number, Map<string, JournalProject>>();
  const seenPr = new Set<string>();
  const activity = new Map<JournalSession, DayActivity>();
  /**
   * The time `entries` were at work, overlaps counted once: the sum of their own times, scaled by
   * how much of their stretches overlap. One session alone, or sessions one after the other, keep their sum.
   */
  const together = (entries: JournalSession[]) => {
    const sum = entries.reduce((n, e) => n + e.activeMs, 0);
    const gaps = entries.reduce((n, e) => n + (activity.get(e)?.gaps ?? 0), 0);
    return gaps > 0 ? (sum * covered(entries.flatMap((e) => activity.get(e)?.spans ?? []))) / gaps : sum;
  };

  // Oldest first, so the session a commit or a pull request is kept under is the one that made it first.
  const ordered = sessions
    .filter((s) => !s.ghost && Date.parse(s.lastEventAt ?? s.startedAt) >= since)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.id < b.id ? -1 : 1));

  for (const s of ordered) {
    const split = byDay(s);
    const totalGaps = [...split.values()].reduce((n, d) => n + d.gaps, 0);
    const totalEvents = [...split.values()].reduce((n, d) => n + d.events, 0);
    const mine = new Map<number, JournalSession>();
    for (const [key, d] of split) {
      if (key < since || key > now) continue;
      const share = split.size === 1 ? 1 : totalGaps > 0 ? d.gaps / totalGaps : d.events / totalEvents;
      let projects = out.get(key);
      if (!projects) out.set(key, (projects = new Map()));
      const name = s.project || "unknown";
      let project = projects.get(name);
      if (!project) projects.set(name, (project = { project: name, activeMs: 0, cost: 0, sessions: [] }));
      const entry: JournalSession = { session: s, headline: headlineOf(s), firstAt: d.firstAt, activeMs: s.durationMs * share, cost: d.cost, commits: [], prs: [] };
      project.sessions.push(entry);
      project.cost += entry.cost;
      activity.set(entry, d);
      mine.set(key, entry);
    }
    for (const c of s.commitLog ?? []) {
      const entry = mine.get(dayStart(c.at));
      if (!entry) continue;
      // The same subject within the same minute in the same project is one commit, read twice.
      const twice = out.get(dayStart(c.at))?.get(s.project || "unknown")?.sessions.some((o) => o.commits.some((x) => x.subject === c.subject && Math.abs(x.at - c.at) < 60_000));
      if (!twice) entry.commits.push({ at: c.at, subject: c.subject });
    }
    for (const p of s.prLog ?? []) {
      const entry = mine.get(dayStart(p.at));
      if (!entry || seenPr.has(p.url)) continue;
      seenPr.add(p.url);
      entry.prs.push({ at: p.at, url: p.url, title: p.title, number: /\/pull\/(\d+)$/.exec(p.url)?.[1] ?? null });
    }
  }

  return [...out.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([startMs, projects]) => {
      for (const p of projects.values()) {
        p.sessions.sort((a, b) => a.firstAt - b.firstAt);
        p.activeMs = together(p.sessions);
      }
      const list = [...projects.values()].sort((a, b) => b.activeMs - a.activeMs || (a.project < b.project ? -1 : 1));
      const all = list.flatMap((p) => p.sessions);
      return {
        startMs,
        activeMs: together(all),
        cost: list.reduce((n, p) => n + p.cost, 0),
        sessions: all.length,
        commits: all.reduce((n, e) => n + e.commits.length, 0),
        prs: all.reduce((n, e) => n + e.prs.length, 0),
        projects: list,
      };
    });
}

/** "Today", "Yesterday", else "Mon 9 Nov". */
export function dayLabel(startMs: number, now: number): string {
  const today = new Date(dayStart(now));
  if (startMs === today.getTime()) return "Today";
  if (startMs === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return "Yesterday";
  return new Date(startMs).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export const prLabel = (p: JournalPr) => `PR${p.number ? ` #${p.number}` : ""}${p.title ? `: ${p.title}` : ""}`;

/**
 * A day as Markdown, to paste into a standup or a note: a heading, then each project with its
 * sessions, and under each session its pull requests and commits. No figures but the time spent:
 * what was done, not what it cost.
 */
export function journalMarkdown(day: JournalDay): string {
  const lines = [`## ${new Date(day.startMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`];
  for (const p of day.projects) {
    lines.push("", `**${p.project}** (${formatLeft(p.activeMs)})`);
    for (const e of p.sessions) {
      lines.push(`- ${e.headline}`);
      for (const pr of e.prs) lines.push(`  - ${prLabel(pr)} (${pr.url})`);
      for (const c of e.commits) lines.push(`  - ${c.subject}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
