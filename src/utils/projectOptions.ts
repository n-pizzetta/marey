import type { Agent } from "../types";

export interface ProjectOption {
  name: string;
  /** Sessions per provider. */
  counts: Partial<Record<Agent, number>>;
}

export const projectTotal = (p: ProjectOption) => Object.values(p.counts).reduce((a, b) => a + (b ?? 0), 0);

/** Projects of these sessions with their session count per provider, busiest first. */
export function projectOptions(sessions: Array<{ project: string; agent?: Agent }>): ProjectOption[] {
  const by = new Map<string, ProjectOption>();
  for (const s of sessions) {
    const p = by.get(s.project) ?? { name: s.project, counts: {} };
    const a = s.agent ?? "claude";
    p.counts[a] = (p.counts[a] ?? 0) + 1;
    by.set(s.project, p);
  }
  return [...by.values()].sort((a, b) => projectTotal(b) - projectTotal(a) || a.name.localeCompare(b.name));
}
