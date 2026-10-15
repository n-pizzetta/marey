import { useEffect, useState } from "react";
import type { Agent } from "../types";

/** One instruction file (or Copilot CLI instruction block) a session or sub-agent read at start. */
export interface LoadedFile {
  path: string | null;
  type: string | null;
  lines: number | null;
  /** Copilot CLI: the block's first heading, when no file on disk matches it. */
  label?: string;
}

export interface MemoryOp {
  tsMs: number | null;
  op: "read" | "write" | "delete";
  file: string;
  via: string;
  /** Set when a sub-agent did it. */
  by?: string;
}

/** What a sub-agent received besides its brief. */
export type Received = LoadedFile[] | "none" | "unrecorded" | "conversation" | "builtin";

export interface ContextSubagent {
  id: string | null;
  type: string;
  name: string | null;
  description: string | null;
  model: string | null;
  tsMs: number | null;
  brief: string | null;
  briefChars: number;
  /** Codex encrypts the briefs it gives its sub-agents. */
  briefHidden?: boolean;
  received: Received;
  toolCalls: number;
  /** Files written, by where they live (repo, worktree, scratch, outside…). */
  wrote: Record<string, number>;
}

export interface ContextSession {
  id: string;
  agent: Agent;
  title: string;
  startedAt: string;
  endedAt: string;
  prompts: number;
  live: boolean;
  /** False when the transcript logs no instruction files (Codex, Claude Code before ~Sep 2026). */
  loadsRecorded: boolean;
  loads: Array<{ tsMs: number | null; files: LoadedFile[] }>;
  memoryOps: MemoryOp[];
  files: { repo: number; worktrees: string[]; scratch: number; outside: number };
  created: Array<{ path: string; state: "committed" | "untracked" | "deleted" | "ignored" | "unknown" }>;
  subagents: ContextSubagent[];
}

export interface MemoryFile {
  file: string;
  exists: boolean;
  inIndex: boolean;
  title: string;
  /** Its line in MEMORY.md: all a session sees of it until it opens the file. */
  hook: string | null;
  /** What the file says it is (front matter). */
  description: string | null;
  type: string | null;
  lines: number;
  modifiedMs: number | null;
}

export interface AgentContextData {
  project: string;
  root: string | null;
  generatedAt: string;
  agentsMd: boolean;
  sessions: ContextSession[];
  instructions: Array<{ path: string; type: string | null; lines: number | null; exists: boolean }>;
  memory: { dir: string | null; exists: boolean; files: MemoryFile[] };
  open: {
    untracked: Array<{ path: string; firstSession: string | null; firstMs: number | null }>;
    outside: Array<{ path: string; kind: string; edits: number; files?: number; lastMs: number | null; lastSession: string; exists: boolean }>;
    plans: number;
    scratch: { files: number; sessions: number };
    worktrees: Array<{ name: string; files: number; sessions: string[]; exists: boolean }>;
  };
}

/** The Context page of one project, refetched after each parse of the sessions. */
export function useAgentContext(project: string | null, generatedAt: string | undefined) {
  const [state, setState] = useState<{ project: string | null; data: AgentContextData | null; error: string | null }>({ project: null, data: null, error: null });
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    fetch(`/api/agent-context?project=${encodeURIComponent(project)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: AgentContextData) => { if (!cancelled) setState({ project, data, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState((prev) => ({ project, data: prev.project === project ? prev.data : null, error: e.message })); });
    return () => { cancelled = true; };
  }, [project, generatedAt]);
  return state.project === project ? state : { project, data: null, error: null };
}

/* ---------- derived views ---------- */

export const RECALL_DAYS = 7;
const DAY = 86_400_000;

/** A memory event in the grid: wrote, re-read, deleted, or changed on disk with no log naming the writer. */
export type MemoryMark = "w" | "r" | "x" | "u";

export interface MemoryRow extends MemoryFile {
  events: Array<{ session: string; tsMs: number | null; mark: MemoryMark; via?: string }>;
  lastRead: number;
  firstMs: number | null;
  /** lost: the whole memory folder is gone (moved with a renamed project, or deleted). */
  status: "live" | "idle" | "gone" | "lost";
}

const t = (iso: string) => Date.parse(iso);

/**
 * Memory files with their history, ordered by first write: re-read in the last 7 days (live),
 * known only by their index line (idle), or deleted. A file whose last change no log explains
 * (a script, another tool) gets a "changed" mark on the most recent Claude session running then.
 */
export function memoryRows(data: AgentContextData, now: number): MemoryRow[] {
  const claude = data.sessions.filter((s) => s.agent === "claude");
  return data.memory.files
    .map((m) => {
      const events: MemoryRow["events"] = [];
      for (const s of claude) {
        for (const o of s.memoryOps) {
          if (o.file !== m.file) continue;
          events.push({ session: s.id, tsMs: o.tsMs, mark: o.op === "delete" ? "x" : o.op === "read" ? "r" : "w", via: o.via });
        }
      }
      events.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
      const lastLogged = Math.max(0, ...events.filter((e) => e.mark !== "r").map((e) => e.tsMs ?? 0));
      if (m.exists && m.modifiedMs && m.modifiedMs - lastLogged > 120_000) {
        const running = claude.filter((s) => t(s.startedAt) <= m.modifiedMs! && m.modifiedMs! <= t(s.endedAt) + 60_000);
        const s = running.at(-1);
        if (s) events.push({ session: s.id, tsMs: m.modifiedMs, mark: "u" });
      }
      const lastRead = Math.max(0, ...events.filter((e) => e.mark === "r").map((e) => e.tsMs ?? 0));
      const firstMs = events[0]?.tsMs ?? m.modifiedMs;
      const status: MemoryRow["status"] = !data.memory.exists ? "lost" : !m.exists ? "gone" : lastRead && now - lastRead <= RECALL_DAYS * DAY ? "live" : "idle";
      return { ...m, events, lastRead, firstMs, status };
    })
    .sort((a, b) => (a.firstMs ?? Infinity) - (b.firstMs ?? Infinity));
}

/** Per session: the marks it left on each memory file (a write or delete hides the "changed" mark). */
export function memoryMarks(rows: MemoryRow[]): Map<string, Map<string, Set<MemoryMark>>> {
  const out = new Map<string, Map<string, Set<MemoryMark>>>();
  for (const m of rows) {
    for (const e of m.events) {
      const bySession = out.get(e.session) ?? new Map<string, Set<MemoryMark>>();
      const set = bySession.get(m.file) ?? new Set<MemoryMark>();
      set.add(e.mark);
      if (set.has("w") || set.has("x")) set.delete("u");
      bySession.set(m.file, set);
      out.set(e.session, bySession);
    }
  }
  return out;
}

export const fileName = (p: string | null) => (p ? p.split("/").pop() ?? p : "");

/** A loaded file's short name: the memory index, a file name, or a Copilot block's heading. */
export function loadedName(f: LoadedFile): string {
  if (f.type === "AutoMem" || /\/memory\/MEMORY\.md$/.test(f.path ?? "")) return "Memory index";
  return f.path ? fileName(f.path) : f.label || "Instructions";
}
