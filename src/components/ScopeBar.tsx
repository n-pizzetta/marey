import type { Session } from "../types";
import { keepFocus } from "../utils/keepFocus";
import { RANGE_OPTIONS, rangeLabel, type Range } from "../utils/range";
import { SessionFilters, type FilterId } from "./SessionFilters";

interface Props {
  range: Range;
  onRangeChange: (r: Range) => void;
  filter: FilterId;
  onFilterChange: (f: FilterId) => void;
  projectFilter: string | null;
  onProjectFilterChange: (p: string | null) => void;
  search: string;
  onSearchChange: (s: string) => void;
  /** Sessions in the range, before filters: the counts in the pickers. */
  inRange: Session[];
  /** Sessions left after the filters. */
  count: number;
  onReset: () => void;
}

/**
 * The scope of the Sessions, Usage and Health pages: one bar, one place.
 * Every figure under it follows it; the Now page, which has none, ignores it.
 */
export function ScopeBar({
  range,
  onRangeChange,
  filter,
  onFilterChange,
  projectFilter,
  onProjectFilterChange,
  search,
  onSearchChange,
  inRange,
  count,
  onReset,
}: Props) {
  const filtered = filter !== "all" || !!projectFilter || !!search;
  return (
    <div className="scope-bar" role="search" aria-label="Scope">
      <div className="range-picker" role="radiogroup" aria-label="Time range">
        {RANGE_OPTIONS.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={range === r.id}
            className={`range-opt ${range === r.id ? "active" : ""}`}
            onMouseDown={keepFocus}
            onClick={() => onRangeChange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <SessionFilters
        filter={filter}
        onFilterChange={onFilterChange}
        projectFilter={projectFilter}
        onProjectFilterChange={onProjectFilterChange}
        sessions={inRange}
      />
      {/* filters on the left; what they add up to, then the search, on the right */}
      <div className="scope-summary">
        <span className="mono tabular">
          {filtered ? `${count} of ${inRange.length}` : count} session{count === 1 ? "" : "s"}
        </span>
        <span className="dim">{rangeLabel(range)}</span>
        {filtered && (
          <button className="scope-reset" onClick={onReset}>Reset filters</button>
        )}
      </div>
      <input
        className={`scope-search ${search ? "set" : ""}`}
        type="search"
        placeholder="Search goals and summaries…"
        aria-label="Search sessions"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );
}
