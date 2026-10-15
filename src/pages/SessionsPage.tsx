import type { Session } from "../types";
import { SessionList, BulkGhostBar } from "../components/SessionList";
import type { Sort } from "../utils/sortSessions";
import { SessionCompare } from "../components/SessionCompare";

interface Props {
  sessions: Session[];
  allSessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sort: Sort;
  onSortChange: (s: Sort) => void;
  onProjectClick: (project: string) => void;
  compareMode: boolean;
  onToggleCompareMode: () => void;
  compareIds: Set<string>;
  onToggleCompare: (id: string) => void;
  onRemoveCompare: (id: string) => void;
  compareLimit?: number;
  /** The status filter is on ghosts: selection serves bulk deletion instead of comparison. */
  ghostsFocused: boolean;
  onBulkDelete: (ids: string[]) => Promise<void>;
}

/** The sessions of the scope as a sortable table; selecting rows compares them side by side. */
export function SessionsPage({
  sessions,
  allSessions,
  selectedId,
  onSelect,
  sort,
  onSortChange,
  onProjectClick,
  compareMode,
  onToggleCompareMode,
  compareIds,
  onToggleCompare,
  onRemoveCompare,
  compareLimit,
  ghostsFocused,
  onBulkDelete,
}: Props) {
  const comparing = compareMode && !ghostsFocused;
  const hint = !compareMode
    ? "Open a session to replay it · ↑ ↓ move between sessions once open"
    : ghostsFocused
    ? `${compareIds.size} selected`
    : `Pick up to ${compareLimit} sessions to compare · ${compareIds.size} selected`;

  return (
    <div className="page page-sessions">
      <div className="sessions-toolbar">
        <span className="sessions-hint dim">{hint}</span>
        {compareMode && ghostsFocused && (
          <BulkGhostBar sessions={sessions} compareIds={compareIds} onToggleCompare={onToggleCompare} onBulkDelete={onBulkDelete} />
        )}
        <button className={`tool-btn ${compareMode ? "active" : ""}`} onClick={onToggleCompareMode}>
          {compareMode ? "Done" : ghostsFocused ? "Select" : "Compare"}
        </button>
      </div>
      <div className={`sessions-body ${comparing ? "comparing" : ""}`}>
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          onSelect={onSelect}
          sort={sort}
          onSortChange={onSortChange}
          compareMode={compareMode}
          compareIds={compareIds}
          onToggleCompare={onToggleCompare}
          compareLimit={compareLimit}
          onProjectClick={onProjectClick}
        />
        {comparing && (
          <SessionCompare
            sessions={allSessions.filter((s) => compareIds.has(s.id))}
            onClose={onToggleCompareMode}
            onRemove={onRemoveCompare}
            onPick={onSelect}
          />
        )}
      </div>
    </div>
  );
}
