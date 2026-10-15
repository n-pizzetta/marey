import type { KeyboardEvent } from "react";
import type { LiveState, Session } from "../types";
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
  /** Each running session's share of its plan, and its color in the plan bars. */
  usage?: Map<string, RowUsage>;
  colors?: Map<string, string>;
  /** Name the provider on each row (several providers on the board). */
  showProvider?: boolean;
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

/** Every running session, grouped by what it needs from you; the longest wait first. */
export function SessionBoard({ sessions, onSelectSession, usage, colors, showProvider = false }: Props) {
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
                const color = colors?.get(s.id);
                return (
                  <li key={s.id}>
                    <div className="board-row" role="button" tabIndex={0} onClick={() => onSelectSession(s.id)} onKeyDown={open(s.id)}>
                      <span className="board-name">
                        {color && <span className="board-swatch" style={{ background: color }} aria-hidden="true" />}
                        <span className="board-name-text">{nameOf(s)}</span>
                      </span>
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
