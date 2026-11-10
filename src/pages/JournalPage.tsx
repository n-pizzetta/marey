import { useMemo, useState } from "react";
import type { Session } from "../types";
import { buildJournal, dayLabel, journalMarkdown, prLabel, type JournalDay, type JournalSession } from "../utils/journal";
import { projectColor } from "../utils/fleetStats";
import { formatCost } from "../utils/format";
import { formatLeft } from "../utils/planFormat";
import { useNow } from "../utils/useNow";
import "../journal.css";

interface Props {
  /** The selected provider's sessions. */
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

const STEP_DAYS = 7;
/** Lines of commits and pull requests shown under a session before "Show more". */
const SHIPPED_SHOWN = 6;
const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What was done each day, by project: sessions, their commits and pull requests, ready to copy. */
export function JournalPage({ sessions, onSelectSession }: Props) {
  const now = useNow(60_000);
  const [days, setDays] = useState(STEP_DAYS);
  const journal = useMemo(() => buildJournal(sessions, { now, days }), [sessions, now, days]);

  return (
    <div className="page page-journal">
      <section className="page-section">
        <div className="page-section-head">
          <h2>Journal</h2>
          <span className="page-section-note">What you and your agents did each day, by project</span>
        </div>
        {journal.length === 0 && <p className="journal-empty">No sessions in the last {days} days.</p>}
        {journal.map((day) => (
          <Day key={day.startMs} day={day} now={now} onSelectSession={onSelectSession} />
        ))}
        <button className="link-btn journal-more" onClick={() => setDays((d) => d + STEP_DAYS)}>Show {STEP_DAYS} more days</button>
      </section>
    </div>
  );
}

function Day({ day, now, onSelectSession }: { day: JournalDay; now: number; onSelectSession: (id: string) => void }) {
  const label = dayLabel(day.startMs, now);
  const date = new Date(day.startMs).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <article className="journal-day">
      <header className="journal-day-head">
        <h3 title={date}>{label}</h3>
        {(label === "Today" || label === "Yesterday") && <span className="journal-day-date">{date}</span>}
        <span className="journal-day-stats tabular">
          <span title="Time with at least one session at work: sessions running side by side count once">{formatLeft(day.activeMs)} active</span> · {count(day.sessions, "session")}
          {day.commits > 0 && <> · {count(day.commits, "commit")}</>}
          {day.prs > 0 && <> · {count(day.prs, "PR")}</>}
          <span className="journal-day-cost" title="What the day's tokens would cost at API prices: a relative weight, not a bill"> · {formatCost(day.cost)} API value</span>
        </span>
        <CopyDay day={day} />
      </header>
      {day.projects.map((p) => (
        <section key={p.project} className="journal-project">
          <div className="journal-project-head">
            <span className="project-dot" style={{ background: projectColor(p.project) }} aria-hidden="true" />
            <span className="journal-project-name">{p.project}</span>
            <span className="journal-project-time tabular" title="Time with at least one of its sessions at work">{formatLeft(p.activeMs)}</span>
          </div>
          <ul className="journal-sessions">
            {p.sessions.map((e) => (
              <Entry key={e.session.id} entry={e} onSelectSession={onSelectSession} />
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

function Entry({ entry: e, onSelectSession }: { entry: JournalSession; onSelectSession: (id: string) => void }) {
  const agent = e.session.agent ?? "claude";
  const [all, setAll] = useState(false);
  // Pull requests first: they say more than the commits inside them.
  const shipped = [
    ...e.prs.map((pr) => (
      <li key={pr.url} className="journal-pr">
        <a href={pr.url} target="_blank" rel="noreferrer">{prLabel(pr)}</a>
      </li>
    )),
    ...e.commits.map((c) => (
      <li key={`${c.at}-${c.subject}`} className="journal-commit" title={`Committed at ${clock(c.at)}`}>{c.subject}</li>
    )),
  ];
  const hidden = all ? 0 : Math.max(0, shipped.length - SHIPPED_SHOWN);
  return (
    <li className="journal-entry">
      <span className="journal-entry-time tabular">{clock(e.firstAt)}</span>
      <div className="journal-entry-body">
        <div className="journal-entry-line">
          <button className="journal-entry-headline" onClick={() => onSelectSession(e.session.id)} title="Open the session">{e.headline}</button>
          {e.session.live && <span className="journal-live" title="Still running">running</span>}
          {agent !== "claude" && <span className="agent-tag">{agent}</span>}
          <span className="journal-entry-time-spent tabular">{formatLeft(e.activeMs)}</span>
        </div>
        {shipped.length > 0 && (
          <ul className="journal-shipped">
            {hidden > 0 ? shipped.slice(0, SHIPPED_SHOWN) : shipped}
            {hidden > 0 && (
              <li><button className="link-btn" onClick={() => setAll(true)}>Show {hidden} more</button></li>
            )}
          </ul>
        )}
      </div>
    </li>
  );
}

function CopyDay({ day }: { day: JournalDay }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(journalMarkdown(day));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard blocked: nothing to do */ }
  };
  return (
    <button className="journal-copy" onClick={copy} title="Copy this day as Markdown: projects, sessions, commits and pull requests">
      {copied ? "Copied" : "Copy as Markdown"}
    </button>
  );
}
