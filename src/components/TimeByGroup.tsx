import { useMemo, useState } from "react";
import type { Session } from "../types";
import { buildTimesheet, formatHours, OTHER, periodOf, PERIODS, timesheetCsv, timesheetFileName, type PeriodId } from "../utils/timesheet";
import { projectColor } from "../utils/fleetStats";
import { useNow } from "../utils/useNow";

/** Groups shown before "Show all": the sheet stays a glance, not a table. */
const SHOWN = 6;
/** `…/Dev/work` for `/Users/me/Dev/work`: enough to recognize the folder. */
const short = (path: string) => `…/${path.split("/").filter(Boolean).slice(-2).join("/")}`;

/**
 * Active time over a week or a month, by the folder sessions ran under (a client, when projects
 * sit in one folder per client), with a CSV to start a timesheet from. A row opens on its projects.
 */
export function TimeByGroup({ sessions }: { sessions: Session[] }) {
  const now = useNow(60_000);
  const [period, setPeriod] = useState<PeriodId>("week");
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const sheet = useMemo(() => buildTimesheet(sessions, periodOf(period, now)), [sessions, period, now]);
  const longest = Math.max(1, ...sheet.groups.map((g) => g.activeMs));
  const groups = all ? sheet.groups : sheet.groups.slice(0, SHOWN);

  const download = () => {
    const url = URL.createObjectURL(new Blob([timesheetCsv(sheet)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = timesheetFileName(sheet);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="page-section">
      <div className="page-section-head">
        <h2>Time</h2>
        <span className="page-section-note" title="The time with at least one session at work, idle gaps over 5 minutes left out. Two folders worked side by side each count that time.">
          {sheet.root ? `Active time by folder of ${short(sheet.root)}` : "Active time by project"}
        </span>
      </div>
      <div className="journal-time">
        <div className="journal-time-head">
          <div className="range-picker" role="radiogroup" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.id} role="radio" aria-checked={period === p.id} className={`range-opt ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <span className="journal-time-total tabular" title="Time with at least one session at work, all of them together">{formatHours(sheet.activeMs)}</span>
          <button className="journal-copy" onClick={download} disabled={sheet.rows.length === 0} title="One line per day and folder: date, hours, and the projects behind them">
            Export CSV
          </button>
        </div>
        {sheet.groups.length === 0 && <p className="journal-empty">No sessions in this period.</p>}
        <ul className="journal-time-rows">
          {groups.map((g) => {
            const opens = g.projects.length > 1 || g.projects[0]?.name !== g.name;
            return (
              <li key={g.name}>
                <button
                  className="journal-time-row"
                  aria-expanded={opens ? open === g.name : undefined}
                  disabled={!opens}
                  onClick={() => setOpen(open === g.name ? null : g.name)}
                  title={`${g.days} day${g.days === 1 ? "" : "s"}${opens ? " · show its projects" : ""}`}
                >
                  <span className="project-dot" style={{ background: g.name === OTHER ? "var(--c-text-faint)" : projectColor(g.name) }} aria-hidden="true" />
                  <span className="journal-time-name">{g.name}</span>
                  <span className="journal-time-bar" aria-hidden="true"><span style={{ width: `${(g.activeMs / longest) * 100}%` }} /></span>
                  <span className="journal-time-value tabular">{formatHours(g.activeMs)}</span>
                </button>
                {open === g.name && (
                  <ul className="journal-time-projects">
                    {g.projects.map((p) => (
                      <li key={p.name}>
                        <span>{p.name}</span>
                        <span className="tabular">{formatHours(p.activeMs)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {sheet.groups.length > SHOWN && !all && (
          <button className="link-btn journal-more" onClick={() => setAll(true)}>Show all {sheet.groups.length}</button>
        )}
      </div>
    </section>
  );
}
