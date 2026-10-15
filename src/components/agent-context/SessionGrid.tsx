import { useEffect, useRef, useState } from "react";
import type { Provider } from "../../utils/providers";
import type { ContextSession, MemoryMark, MemoryRow } from "../../utils/agentContext";
import { loadedName } from "../../utils/agentContext";
import { AGENT_LABEL, fmtDay, memoryStatus, plural, sessionName } from "./format";

interface Props {
  cols: ContextSession[];
  /** Sessions of the project for this provider, shown or not. */
  total: number;
  provider: Provider;
  /** Null when the provider keeps no memory: one line says so instead of the rows. */
  rows: MemoryRow[] | null;
  marks: Map<string, Map<string, Set<MemoryMark>>>;
  /** Whether the project has a memory folder: a session without the index then shows an empty pip. */
  hasMemory: boolean;
  untrackedNow: number;
  selectedSession: string | null;
  selectedFile: string | null;
  hotFile: string | null;
  onSession: (id: string) => void;
  onFile: (file: string) => void;
}

const isIndex = (path: string | null, type: string | null) => type === "AutoMem" || /\/memory\/MEMORY\.md$/.test(path ?? "");

function Mark({ set }: { set: Set<MemoryMark> }) {
  if (set.has("x")) return <span className="ctx-mk x" />;
  const cls = [set.has("w") && "w", set.has("r") && "r", !set.has("w") && !set.has("r") && "u"].filter(Boolean).join(" ");
  return <span className={`ctx-mk ${cls}`} />;
}

/** The pips of what a session loaded at start: one per file, an empty one for a missing memory index. */
function Pips({ s, hasMemory }: { s: ContextSession; hasMemory: boolean }) {
  const files = s.loads.at(-1)?.files ?? [];
  if (!s.loadsRecorded) return <span className="ctx-na">·</span>;
  const missingIndex = s.agent === "claude" && hasMemory && !files.some((f) => isIndex(f.path, f.type));
  return (
    <span className="ctx-pips">
      {files.slice(0, 6).map((_, i) => <i key={i} className="on" />)}
      {missingIndex && <i />}
      {!files.length && !missingIndex && <i />}
    </span>
  );
}

/**
 * Sessions as columns, oldest on the left: what each loaded at start, the sub-agents it launched,
 * the repo files it wrote, then one row per memory file with what each session did to it. Memory
 * files are ordered by first write, so the staircase is the memory growing.
 */
export function SessionGrid({ cols, total, provider, rows, marks, hasMemory, untrackedNow, selectedSession, selectedFile, hotFile, onSession, onFile }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const multi = provider === "all" && new Set(cols.map((s) => s.agent)).size > 1;

  // Newest sessions first in view: on a phone the grid opens scrolled to the right.
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [cols.length]);

  const sel = selectedFile ? -1 : cols.findIndex((s) => s.id === selectedSession);
  const cell = (i: number, extra = "") => `ctx-c${extra}${i === sel ? " sel" : ""}${i === hover ? " hl" : ""}`;
  const subCount = cols.reduce((n, s) => n + s.subagents.length, 0);
  const month = (s: ContextSession) => new Date(s.startedAt).toLocaleDateString("en-US", { month: "short" });
  // The month is written above the first session of each month.
  const months = cols.map((s, i) => (i === 0 || month(s) !== month(cols[i - 1]) ? month(s) : null));

  return (
    <div className="ctx-card ctx-grid-card">
      <div className="ctx-legend">
        {provider !== "codex" && <span><span className="ctx-pips"><i className="on" /><i className="on" /><i /></span>loaded at start, one per file</span>}
        <span><span className="ctx-subn">3</span>subagents</span>
        <span><span className="ctx-filn">4</span>repo files written</span>
        {rows && (
          <>
            <span><span className="ctx-mk w" />wrote</span>
            <span><span className="ctx-mk r" />re-read</span>
            <span><span className="ctx-mk x" />deleted</span>
            <span><span className="ctx-mk u" />changed, no log says who</span>
          </>
        )}
        {multi && <span>{[...new Set(cols.map((s) => s.agent))].map((a) => <span key={a} className={`provider-dot ${a}`} />)}provider</span>}
      </div>
      <div className="ctx-scroll scrollbar" ref={scroll} onMouseLeave={() => setHover(null)}>
        <div className={`ctx-mx${multi ? " multi" : ""}`} style={{ "--n": cols.length } as React.CSSProperties}>
          <div className="ctx-lab ctx-hd"><span className="ctx-txt"><span className="ctx-nm">Sessions</span><small>{cols.length} of {total} shown</small></span></div>
          {cols.map((s, i) => {
            const d = new Date(s.startedAt);
            return (
              <button key={s.id} className={cell(i, " ctx-hd")} title={`${sessionName(s)} · ${AGENT_LABEL[s.agent]} · ${fmtDay(s.startedAt)}`} onMouseEnter={() => setHover(i)} onClick={() => onSession(s.id)}>
                <span className="ctx-mon">{months[i] ?? "\u00a0"}</span>
                <span className="ctx-day">{d.getDate()}</span>
                {multi && <span className={`provider-dot ${s.agent}`} />}
              </button>
            );
          })}
          <div className="ctx-now ctx-hd"><b>Now</b></div>

          <div className="ctx-rule" />
          <div className="ctx-lab"><span className="ctx-txt"><span className="ctx-nm">Loaded at start</span><small>what every agent gets first</small></span></div>
          {cols.map((s, i) => {
            const files = s.loads.at(-1)?.files ?? [];
            const tip = s.agent === "codex" ? "Codex logs no instruction files" : !s.loadsRecorded ? "Not recorded" : files.map(loadedName).join(" · ") || "No instruction file";
            return <button key={s.id} className={cell(i)} title={tip} onMouseEnter={() => setHover(i)} onClick={() => onSession(s.id)}><Pips s={s} hasMemory={hasMemory} /></button>;
          })}
          <div className="ctx-now" />

          <div className="ctx-lab"><span className="ctx-txt"><span className="ctx-nm">Subagents</span><small>launched by the session</small></span></div>
          {cols.map((s, i) => {
            const n = s.subagents.length;
            const warn = s.subagents.some((a) => a.received === "none");
            const unrec = n > 0 && s.subagents.every((a) => a.received === "unrecorded");
            return (
              <button key={s.id} className={cell(i)} title={plural(n, "subagent")} onMouseEnter={() => setHover(i)} onClick={() => onSession(s.id)}>
                {n > 0 && <span className={`ctx-subn${warn ? " warn" : unrec ? " unrec" : ""}`}>{n}</span>}
              </button>
            );
          })}
          <div className="ctx-now"><b>{subCount}</b> in total</div>

          <div className="ctx-lab"><span className="ctx-txt"><span className="ctx-nm">Repo files written</span><small>created or edited</small></span></div>
          {cols.map((s, i) => (
            <button key={s.id} className={cell(i)} title={`${plural(s.files.repo, "repo file")} written`} onMouseEnter={() => setHover(i)} onClick={() => onSession(s.id)}>
              {s.files.repo > 0 && <span className="ctx-filn">{s.files.repo}</span>}
            </button>
          ))}
          <div className="ctx-now"><b>{untrackedNow}</b> still untracked</div>

          {rows ? (
            <>
              <div className="ctx-grp">
                <span>
                  Memory{" "}
                  <em>
                    {rows.some((m) => m.status === "lost")
                      ? `${plural(rows.length, "file")} · the memory folder no longer exists (moved or deleted)`
                      : `${plural(rows.filter((m) => m.exists).length, "file")}${rows.some((m) => !m.exists) ? ` · ${rows.filter((m) => !m.exists).length} deleted` : ""}`}
                    {provider === "all" ? " · Claude Code only" : ""}
                  </em>
                </span>
              </div>
              {rows.map((m) => {
                const sets = cols.map((s) => marks.get(s.id)?.get(m.file));
                const firstWrite = sets.findIndex((o) => o && (o.has("w") || o.has("u")));
                const start = firstWrite === -1 ? sets.findIndex(Boolean) : firstWrite;
                const del = sets.findIndex((o) => o?.has("x"));
                const dot = m.status === "live" ? "green" : m.status === "gone" ? "red" : "";
                return [
                  <button key={`${m.file}:lab`} className={`ctx-lab${m.status === "gone" ? " gone" : ""}${m.file === selectedFile ? " sel" : ""}${m.file === hotFile ? " hot" : ""}`} onClick={() => onFile(m.file)}>
                    <span className={`ctx-dot ${dot}`} />
                    <span className="ctx-txt"><span className="ctx-nm">{m.title}</span><small>{m.type ?? "memory"} · {m.status === "lost" ? "not on disk" : m.exists ? plural(m.lines, "line") : "removed"}</small></span>
                  </button>,
                  ...sets.map((o, i) => {
                    const life = start !== -1 && i >= start && (del === -1 || i <= del);
                    return (
                      <button key={`${m.file}:${i}`} className={cell(i, `${life ? " life" : ""}${i === start ? " first" : ""}${i === del ? " last" : ""}`)} onMouseEnter={() => setHover(i)} onClick={() => onSession(cols[i].id)}>
                        {o && <Mark set={o} />}
                      </button>
                    );
                  }),
                  <div key={`${m.file}:now`} className={`ctx-now${m.exists && start !== -1 ? " life" : ""}`}><span className={`ctx-dot ${dot}`} />{memoryStatus(m)}</div>,
                ];
              })}
            </>
          ) : (
            <div className="ctx-grp note"><span>{provider === "codex" || provider === "copilot" ? AGENT_LABEL[provider] : "This provider"} keeps no memory files for this project, so there is no memory to follow here.</span></div>
          )}
        </div>
      </div>
      <p className="ctx-foot">
        {total > cols.length && `${plural(total - cols.length, "session")} that touched no memory, launched no subagent and wrote no repo file ${total - cols.length === 1 ? "is" : "are"} hidden. `}
        {rows ? "Memories are ordered by first write, so the staircase is the memory growing." : ""}
      </p>
    </div>
  );
}
