import type { AgentContextData, ContextSession, ContextSubagent, MemoryMark, MemoryRow } from "../../utils/agentContext";
import { loadedName } from "../../utils/agentContext";
import { AGENT_LABEL, fmtDay, fmtTime, kChars, memoryStatus, plural, sessionName } from "./format";

const MARK_WORD: Record<MemoryMark, string> = { w: "wrote", r: "re-read", x: "deleted", u: "changed, writer unknown" };
const STATE_WORD = { committed: "committed", untracked: "untracked", deleted: "deleted since", ignored: "ignored by git", unknown: "" } as const;

function MarkGlyph({ set }: { set: Set<MemoryMark> }) {
  if (set.has("x")) return <span className="ctx-mk x" />;
  const cls = [set.has("w") && "w", set.has("r") && "r", !set.has("w") && !set.has("r") && "u"].filter(Boolean).join(" ");
  return <span className={`ctx-mk ${cls}`} />;
}

function Subagent({ a, memoryExisted }: { a: ContextSubagent; memoryExisted: boolean }) {
  const wrote = Object.entries(a.wrote).filter(([, n]) => n > 0).map(([k, n]) => plural(n, k === "repo" ? "repo file" : k === "worktree" ? "worktree file" : k === "scratch" ? "scratch file" : `${k} file`));
  const label = a.description && a.name && a.name !== a.type ? `${a.name} · ${a.description}` : a.description ?? a.name ?? a.type;
  let received: React.ReactNode;
  if (Array.isArray(a.received)) {
    const hasIndex = a.received.some((f) => f.type === "AutoMem" || /\/memory\/MEMORY\.md$/.test(f.path ?? ""));
    received = (
      <>
        {a.received.map((f, i) => <span key={i} className="ctx-chip v" title={f.path ?? undefined}>{loadedName(f)}</span>)}
        {!hasIndex && memoryExisted && <span className="ctx-chip ghost" title="The memory existed, but the session had loaded no index, so neither did its subagents.">no memory index, like its session</span>}
      </>
    );
  } else if (a.received === "none") received = <span className="ctx-chip warn">no instruction file, no memory · {a.type} skips them</span>;
  else if (a.received === "conversation") received = <span className="ctx-chip v">the whole conversation (fork)</span>;
  else if (a.received === "builtin") received = <span className="ctx-chip ghost">built-in instructions</span>;
  else received = <span className="ctx-chip ghost">instruction files not recorded</span>;
  return (
    <details className="ctx-sub">
      <summary>
        <span className="ctx-sub-who"><span className="ctx-sub-type">{a.type}</span><span className="ctx-sub-name">{label}</span></span>
        <span className="ctx-sub-did">{plural(a.toolCalls, "tool call")} · {wrote.length ? `wrote ${wrote.join(", ")}` : "wrote nothing"}</span>
        <span className="ctx-sub-got">
          <span>Received</span>
          {a.briefHidden ? <span className="ctx-chip ghost">brief encrypted by Codex</span> : <span className="ctx-chip">brief<small>{kChars(a.briefChars)} chars</small></span>}
          {received}
        </span>
      </summary>
      <pre className="ctx-brief">
        {a.briefHidden ? "Codex encrypts the brief it gives a sub-agent: only its task name is readable." : a.brief ?? "No brief recorded."}
        {a.brief && a.briefChars > a.brief.length && <em>{`\n… ${kChars(a.briefChars - a.brief.length)} more chars`}</em>}
      </pre>
    </details>
  );
}

interface SessionProps {
  data: AgentContextData;
  session: ContextSession;
  index: number;
  count: number;
  marks: Map<string, Set<MemoryMark>> | undefined;
  rows: MemoryRow[];
  onStep: (dir: -1 | 1) => void;
  onFile: (file: string) => void;
}

/** One session: what it had in mind at start, what it did to the memory, what it left on disk, its sub-agents. */
export function SessionView({ data, session: s, index, count, marks, rows, onStep, onFile }: SessionProps) {
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.endedAt);
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  const mins = Math.max(1, Math.round((end - start) / 60_000));
  const files = s.loads.at(-1)?.files ?? [];
  const hasIndex = files.some((f) => f.type === "AutoMem" || /\/memory\/MEMORY\.md$/.test(f.path ?? ""));
  const known = rows.filter((m) => m.firstMs != null && m.firstMs < start && (m.exists || (m.events.find((e) => e.mark === "x")?.tsMs ?? 0) > start));
  const opened = known.filter((m) => marks?.get(m.file)?.has("r")).length;

  let had: React.ReactNode;
  if (s.agent === "codex") {
    had = (
      <>
        <div className="ctx-chips"><span className="ctx-chip ghost">built-in instructions</span><span className="ctx-chip ghost">{data.agentsMd ? "AGENTS.md on disk" : "no AGENTS.md in this project"}</span></div>
        <p>{data.agentsMd ? "Codex reads every AGENTS.md from the project root to its working folder, but logs none of it." : "Nothing project-specific was loaded. Codex would read every AGENTS.md from the project root to its working folder."}</p>
      </>
    );
  } else if (!s.loadsRecorded) had = <p>Not recorded: older sessions don't log their instruction files.</p>;
  else {
    had = (
      <>
        <div className="ctx-chips">
          {files.map((f, i) => <span key={i} className="ctx-chip v" title={f.path ?? undefined}>{loadedName(f)}{f.lines ? <small>{plural(f.lines, "line")}</small> : null}</span>)}
          {s.agent === "claude" && !hasIndex && <span className="ctx-chip ghost">no memory index</span>}
        </div>
        {s.agent === "claude" && (
          <p>
            {hasIndex
              ? known.length ? `${plural(known.length, "memory", "memories")} existed: it saw their index line and opened ${opened}.` : "The memory was still empty."
              : known.length ? `${plural(known.length, "memory", "memories")} existed on disk, but this session started without the index.` : "No memory yet for this project."}
          </p>
        )}
      </>
    );
  }

  const memoryList = marks ? [...marks.entries()] : [];
  const memory = s.agent !== "claude"
    ? <p>{AGENT_LABEL[s.agent]} keeps no memory files for this project.</p>
    : memoryList.length ? (
      <ul className="ctx-ev">
        {memoryList.map(([file, set]) => {
          const m = rows.find((r) => r.file === file);
          if (!m) return null;
          const what = (["x", "w", "r", "u"] as MemoryMark[]).filter((k) => set.has(k)).map((k) => {
            const e = [...m.events].reverse().find((ev) => ev.session === s.id && ev.mark === k);
            return `${MARK_WORD[k]}${e?.tsMs ? ` ${fmtTime(e.tsMs)}` : ""}`;
          });
          return (
            <li key={file}>
              <MarkGlyph set={set} />
              <span className="ctx-what"><button onClick={() => onFile(file)}>{m.title}</button></span>
              <span className="ctx-when">{what.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    ) : <p>{hasIndex ? "Opened no memory beyond the index." : "Read and wrote no memory."}</p>;

  const untracked = data.open.untracked.filter((u) => u.firstSession === s.id);
  const left = [
    ...untracked.map((u) => <li key={`u:${u.path}`}><span className="ctx-bul amber" /><span className="ctx-what mono">{u.path}</span><span className="ctx-when">untracked</span></li>),
    ...s.created.map((c) => <li key={`c:${c.path}`}><span className={`ctx-bul${c.state === "untracked" ? " amber" : ""}`} /><span className="ctx-what mono">{c.path}</span><span className="ctx-when">created{STATE_WORD[c.state] ? ` · ${STATE_WORD[c.state]}` : ""}</span></li>),
    s.files.repo > 0 && <li key="repo"><span className="ctx-bul" /><span className="ctx-what">{plural(s.files.repo, "repo file")} written</span><span className="ctx-when" /></li>,
    s.files.worktrees.length > 0 && <li key="wt"><span className="ctx-bul" /><span className="ctx-what">{plural(s.files.worktrees.length, "worktree")}: {s.files.worktrees.join(", ")}</span><span className="ctx-when">{data.open.worktrees.some((w) => s.files.worktrees.includes(w.name) && w.exists) ? "still there" : "removed"}</span></li>,
    s.files.scratch > 0 && <li key="scratch"><span className="ctx-bul" /><span className="ctx-what">{plural(s.files.scratch, "scratch file")} in temp dirs</span><span className="ctx-when" /></li>,
    s.files.outside > 0 && <li key="out"><span className="ctx-bul" /><span className="ctx-what">{plural(s.files.outside, "file")} outside the repo</span><span className="ctx-when" /></li>,
  ].filter(Boolean);

  return (
    <div className="ctx-card ctx-dt">
      <div className="ctx-dt-head">
        <div className="ctx-dt-nav">
          <button onClick={() => onStep(-1)} disabled={index <= 0} aria-label="Previous session">‹</button>
          <button onClick={() => onStep(1)} disabled={index >= count - 1} aria-label="Next session">›</button>
        </div>
        <div className="ctx-dt-title">
          <div className="ctx-kicker"><span className={`provider-dot ${s.agent}`} /> {AGENT_LABEL[s.agent]}{s.live ? " · running" : ""}</div>
          <h3>{sessionName(s)}</h3>
          <div className="ctx-meta">
            {sameDay ? `${fmtDay(start)}, ${fmtTime(start)} → ${fmtTime(end)}` : `${fmtDay(start)}, ${fmtTime(start)} → ${fmtDay(end)}, ${fmtTime(end)}`}
            {" · "}{mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`} · {plural(s.prompts, "prompt")}
          </div>
        </div>
      </div>
      <div className="ctx-cols3">
        <div className="ctx-blk"><h4>Had in mind at start</h4>{had}</div>
        <div className="ctx-blk"><h4>Memory</h4>{memory}</div>
        <div className="ctx-blk"><h4>Left behind</h4><ul className="ctx-ev">{left.length ? left : <li><span className="ctx-bul" /><span className="ctx-what">Nothing on disk</span><span className="ctx-when" /></li>}</ul></div>
      </div>
      {s.subagents.length > 0 && (
        <div className="ctx-subs">
          <div className="ctx-subs-head">
            <h4>Subagents · {s.subagents.length}</h4>
            <span className="ctx-note">
              {s.agent === "codex"
                ? "Codex encrypts each sub-agent's brief; only its task name and what it did are logged."
                : s.agent === "copilot"
                  ? "Each one starts from its brief and its own system prompt: general-purpose ones get the instruction files, explore, research and code-review ones don't."
                  : "Each one starts from its brief and the instruction files its session had loaded at its own start. It never sees the conversation."}
            </span>
          </div>
          {s.subagents.map((a, i) => <Subagent key={a.id ?? i} a={a} memoryExisted={a.tsMs != null && rows.some((m) => m.firstMs != null && m.firstMs < a.tsMs!)} />)}
        </div>
      )}
    </div>
  );
}

interface FileProps {
  row: MemoryRow;
  sessions: ContextSession[];
  backLabel: string | null;
  onBack: () => void;
  onSession: (id: string) => void;
}

/** One memory file: its index line next to what it says it is, then its history. */
export function FileView({ row: m, sessions, backLabel, onBack, onSession }: FileProps) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return (
    <div className="ctx-card ctx-dt">
      {backLabel && <button className="ctx-back" onClick={onBack}>‹ Back to {backLabel}</button>}
      <div className="ctx-dt-title">
        <div className="ctx-kicker">Memory · {m.type ?? "file"} · {m.exists ? plural(m.lines, "line") : "deleted"} · {memoryStatus(m)}</div>
        <h3>{m.title}</h3>
        <div className="ctx-meta mono">memory/{m.file}</div>
      </div>
      <div className="ctx-vs">
        <div><h4>What every session sees · index line</h4><p>{m.hook ?? <em>Not in the index: no session sees it unless it opens the folder.</em>}</p></div>
        <div><h4>What the file says it is · description</h4><p>{m.description ?? <em>No description.</em>}</p></div>
      </div>
      <div className="ctx-blk">
        <h4>History</h4>
        <ul className="ctx-ev">
          {m.events.length ? m.events.map((e, i) => {
            const s = byId.get(e.session);
            return (
              <li key={i}>
                <MarkGlyph set={new Set([e.mark])} />
                <span className="ctx-what">
                  {e.mark === "u" ? "Changed during" : `${MARK_WORD[e.mark][0].toUpperCase()}${MARK_WORD[e.mark].slice(1)} in`}{" "}
                  <button onClick={() => onSession(e.session)}>{sessionName(s)}</button>
                </span>
                <span className="ctx-when">{e.tsMs ? `${fmtDay(e.tsMs)} · ${fmtTime(e.tsMs)}` : ""}{e.via ? ` · ${e.via}` : e.mark === "u" ? " · no log says who" : ""}</span>
              </li>
            );
          }) : <li><span /><span className="ctx-what">No session log touches it.</span><span /></li>}
        </ul>
      </div>
    </div>
  );
}
