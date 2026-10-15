import { useMemo } from "react";
import type { Session } from "../types";
import { ProjectPicker } from "./ProjectPicker";
import { projectOptions } from "../utils/projectOptions";

export type FilterId = "all" | "live" | "ghost" | "friction" | "failed" | "lowquality";

// `sessions` is the time-scoped (inRange) set. Counts are computed from this pre-filter
// baseline so an active filter never zeroes out its siblings.
interface Props {
  filter: FilterId;
  onFilterChange: (f: FilterId) => void;
  projectFilter: string | null;
  onProjectFilterChange: (p: string | null) => void;
  sessions: Session[];
}

type Item = { id: FilterId; label: string; count: number; tip: string };

/** Option labels, also for a persisted filter whose item is hidden in the current range. */
const FILTER_LABELS: Record<FilterId, string> = {
  all: "All sessions",
  live: "Live",
  ghost: "Ghosts",
  friction: "Friction",
  failed: "Low outcome",
  lowquality: "Low quality",
};

function statusItems(sessions: Session[]): Item[] {
  const ghostByKind = { crashed: 0, empty: 0 } as Record<string, number>;
  for (const s of sessions) if (s.ghost) ghostByKind[s.ghostKind ?? "empty"] += 1;
  const ghostCount = ghostByKind.crashed + ghostByKind.empty;
  const anyQuality = sessions.some((s) => s.quality);
  return [
    { id: "all", label: "All sessions", count: sessions.length, tip: "" },
    { id: "live", label: "Live", count: sessions.filter((s) => s.live).length, tip: "Claude Code: running process · Codex: task in progress" },
    {
      id: "ghost",
      label: "Ghosts",
      count: ghostCount,
      tip: `Empty sessions (no prompt, no tool call) and sessions whose process died.\n${ghostByKind.crashed} crashed · ${ghostByKind.empty} empty`,
    },
    { id: "friction", label: "Friction", count: sessions.filter((s) => s.frictions.length > 0).length, tip: "Sessions flagged for wrong approach, tool errors, interruptions, etc." },
    {
      id: "failed",
      label: "Low outcome",
      count: sessions.filter((s) => !s.ghost && (s.outcome === "not_achieved" || s.outcome === "partially_achieved")).length,
      tip: "Sessions labelled 'partially' or 'not' achieved (excludes ghosts)",
    },
    ...(anyQuality
      ? [{
          id: "lowquality" as FilterId,
          label: "Low quality",
          count: sessions.filter((s) => s.quality && s.quality.score < 70).length,
          tip: "Context quality score < 70 (context fill, stale reads, bloated results, compactions, duplicates)",
        }]
      : []),
  ];
}

/** Status and project pickers of the scope bar. Counts come from the range, before filtering. */
export function SessionFilters({ filter, onFilterChange, projectFilter, onProjectFilterChange, sessions }: Props) {
  const items = useMemo(() => statusItems(sessions), [sessions]);
  const projects = useMemo(() => projectOptions(sessions), [sessions]);
  const activeStatus = items.find((i) => i.id === filter);

  return (
    <>
      <ProjectPicker projects={projects} value={projectFilter} onChange={onProjectFilterChange} allowAll />
      <label className={`scope-select ${filter !== "all" ? "set" : ""}`} title={activeStatus?.tip || undefined}>
        <span className="scope-select-label">Show</span>
        <select value={filter} onChange={(e) => onFilterChange(e.target.value as FilterId)}>
          {items.map((i) => (
            <option key={i.id} value={i.id} disabled={i.count === 0 && filter !== i.id}>
              {i.id === "all" ? "All" : i.label} ({i.count})
            </option>
          ))}
          {/* a filter from the URL whose option is hidden in this range */}
          {!activeStatus && <option value={filter}>{FILTER_LABELS[filter]} (0)</option>}
        </select>
      </label>
    </>
  );
}
