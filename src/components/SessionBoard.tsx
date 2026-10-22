import { useState, type KeyboardEvent } from "react";
import type { LiveState, LiveSubagents, Session } from "../types";
import { canOpenTerminal, openTerminal } from "../utils/openTerminal";
import { useNow } from "../utils/useNow";
import { runningSessions } from "../utils/liveState";
import { PROVIDER_LABELS, sessionProvider } from "../utils/providers";
import type { RowUsage } from "../utils/planUsage";
import "../board.css";
import "../plan.css";

interface Props {
  sessions: Session[];
  onSelectSession: (id: string) => void;
  /** A sub-agent at work: open its session on its calls. */
  onSelectSubagent?: (sessionId: string, agentId: string) => void;
  /** Each running session's share of its plan. */
  usage?: Map<string, RowUsage>;
  /** Name the provider on each row (several providers on the board). */
  showProvider?: boolean;
  /** The session pointed at here or in a plan bar: its row and its slice light up together. */
  hovered?: string | null;
  onHover?: (id: string | null) => void;
}

const GROUPS: Array<{ key: LiveState["state"]; label: string; hint: string }> = [
  { key: "needs-you", label: "Needs you", hint: "a question, a plan to approve or a permission" },
  { key: "your-turn", label: "Your turn", hint: "done, waiting for your next prompt" },
  { key: "working", label: "Working", hint: "" },
];

/** The name Claude Code gives the session (as in `claude agents`), else its project. */
const nameOf = (s: Session) => s.liveName ?? s.project;

/** One line out of a markdown reply. */
const plain = (text: string) => text.replace(/[#*`>_]+/g, "").replace(/\s+/g, " ").trim();

function lineOf(st: LiveState): string {
  const text = st.text ? plain(st.text) : null;
  if (st.state === "needs-you") {
    if (st.reason === "question") return text ? `Asks: ${text}` : "Asks you a question";
    if (st.reason === "plan") return text ? `Plan to approve: ${text}` : "Has a plan for you to approve";
    return text ? `Wants to run ${text}` : "Waits for a permission";
  }
  if (st.state === "working") return text ?? "Thinking";
  return text ?? "Done";
}

function elapsed(since: string, now: number): string {
  const m = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} d`;
}

/** Sub-agents listed under a session before "+ n more". */
const SHOWN_SUBAGENTS = 8;

/** A session's sub-agents at work, under its row: name, task, last call and time since it started. Each opens onto its calls. */
function SubagentList({ subs, now, onOpen }: { subs: LiveSubagents; now: number; onOpen: (agentId: string | null) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? subs.running : subs.running.slice(0, SHOWN_SUBAGENTS);
  const more = subs.running.length - shown.length;
  return (
    <div className="board-subs">
      <div className="board-subs-head tabular">
        {subs.running.length} sub-agent{subs.running.length > 1 ? "s" : ""} running{subs.done > 0 && ` · ${subs.done} done`}
      </div>
      <ul>
        {shown.map((a, i) => (
          <li
            key={a.id ?? i}
            className="board-sub"
            role="button"
            tabIndex={0}
            title="Show its calls"
            onClick={() => onOpen(a.id)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpen(a.id); }}
          >
            <span className="board-sub-name mono">{a.name}</span>
            <span className="board-sub-task">
              <span className="board-sub-desc" title={a.description ?? undefined}>{a.description}</span>
              <span className="board-sub-call mono" title={a.call ?? undefined}>{a.call}</span>
            </span>
            <span className="board-sub-since mono tabular" title={`Started ${new Date(a.startedAt).toLocaleTimeString()}`}>{elapsed(a.startedAt, now)}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <button className="board-subs-more" onClick={() => setAll(true)}>+ {more} more</button>}
    </div>
  );
}

/** Every running session, grouped by what it needs from you; the longest wait first. */
export function SessionBoard({ sessions, onSelectSession, onSelectSubagent, usage, showProvider = false, hovered = null, onHover }: Props) {
  const now = useNow(15_000);
  const live = runningSessions(sessions);
  const open = (id: string) => (e: KeyboardEvent) => { if (e.key === "Enter") onSelectSession(id); };

  return (
    <div className="board">
      {GROUPS.map((g) => {
        const rows = live
          .filter((s) => s.liveState!.state === g.key)
          .sort((a, b) => Date.parse(a.liveState!.since) - Date.parse(b.liveState!.since));
        if (rows.length === 0) return null;
        return (
          <section key={g.key} className={`board-group board-${g.key}`}>
            <header className="board-group-head">
              <span className="board-dot" aria-hidden="true" />
              <h3>{g.label}</h3>
              <span className="board-count mono tabular">{rows.length}</span>
              {g.hint && <span className="board-hint">{g.hint}</span>}
            </header>
            <ul>
              {rows.map((s) => {
                const st = s.liveState!;
                const u = usage?.get(s.id);
                return (
                  <li key={s.id}>
                    <div
                      className={`board-row ${hovered === s.id ? "linked" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectSession(s.id)}
                      onKeyDown={open(s.id)}
                      onMouseEnter={() => onHover?.(s.id)}
                      onMouseLeave={() => onHover?.(null)}
                      onFocus={() => onHover?.(s.id)}
                      onBlur={() => onHover?.(null)}
                    >
                      <span className="board-name">{nameOf(s)}</span>
                      <span className="board-project mono">
                        {s.project}
                        {showProvider && <span className="board-provider"> · {PROVIDER_LABELS[sessionProvider(s)]}</span>}
                      </span>
                      <span className="board-line" title={st.text ?? undefined}>{lineOf(st)}</span>
                      {usage ? (
                        <span className="board-usage" title={u?.title ?? "Nothing used in the current window"}>
                          <span className="board-usage-pct tabular">{u?.value ?? "—"}</span>
                          {u?.of && <span className="board-usage-of">{u.of}</span>}
                        </span>
                      ) : <span />}
                      <span className="board-since mono tabular" title={`Since ${new Date(st.since).toLocaleTimeString()}`}>{elapsed(st.since, now)}</span>
                      {canOpenTerminal(s) ? (
                        <button className="board-open" onClick={(e) => { e.stopPropagation(); openTerminal(s.id); }}>Open terminal</button>
                      ) : <span />}
                    </div>
                    {!!s.liveSubagents?.running.length && (
                      <SubagentList
                        subs={s.liveSubagents}
                        now={now}
                        onOpen={(agentId) => (agentId && onSelectSubagent ? onSelectSubagent(s.id, agentId) : onSelectSession(s.id))}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
