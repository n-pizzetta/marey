import { useMemo, useState } from "react";
import type { Session } from "../types";
import { sessionProvider, type Provider } from "../utils/providers";
import { memoryMarks, memoryRows, useAgentContext } from "../utils/agentContext";
import { ProjectPicker } from "../components/ProjectPicker";
import { projectOptions } from "../utils/projectOptions";
import { HeadBar } from "../components/agent-context/HeadBar";
import { SessionGrid } from "../components/agent-context/SessionGrid";
import { FileView, SessionView } from "../components/agent-context/ContextDetail";
import { StillOpen } from "../components/agent-context/StillOpen";
import { AGENT_LABEL, fmtDay, plural, sessionName } from "../components/agent-context/format";
import { PageSection } from "./PageSection";
import "../agent-context.css";

interface Props {
  allSessions: Session[];
  provider: Provider;
  /** Context's own project, independent of the Sessions filter; null falls back to the latest one. */
  project: string | null;
  onProjectChange: (project: string | null) => void;
  generatedAt?: string;
}

/**
 * What agents have in mind at start, session by session, and what they left on disk, for one
 * project. Follows the provider switcher: each provider shows only what its logs hold.
 */
export function ContextPage({ allSessions, provider, project, onProjectChange, generatedAt }: Props) {
  const scoped = useMemo(() => (provider === "all" ? allSessions : allSessions.filter((s) => sessionProvider(s) === provider)), [allSessions, provider]);
  const projects = useMemo(() => projectOptions(scoped), [scoped]);
  const latest = useMemo(() => {
    let best: Session | null = null;
    for (const s of scoped) if (!best || (s.lastEventAt ?? s.startedAt) > (best.lastEventAt ?? best.startedAt)) best = s;
    return best?.project ?? null;
  }, [scoped]);
  const current = project && projects.some((p) => p.name === project) ? project : latest;
  const { data, error } = useAgentContext(current, generatedAt);

  const [picked, setPicked] = useState<{ session: string | null; file: string | null; key: string }>({ session: null, file: null, key: "" });
  const [hotFile, setHotFile] = useState<string | null>(null);

  const now = data ? Date.parse(data.generatedAt) : 0;
  const rows = useMemo(() => (data ? memoryRows(data, now) : []), [data, now]);
  const marks = useMemo(() => memoryMarks(rows), [rows]);
  const sessions = useMemo(() => (data ? data.sessions.filter((s) => provider === "all" || s.agent === provider) : []), [data, provider]);
  const cols = useMemo(
    () => sessions.filter((s) => marks.get(s.id)?.size || s.subagents.length || s.files.repo || s.created.length),
    [sessions, marks],
  );

  // A pick belongs to one project and provider: switching either starts from the default again.
  const key = `${current}|${provider}`;
  const showMemory = (provider === "all" || provider === "claude") && rows.length > 0;
  const fallback = [...cols].reverse().find((s) => s.subagents.length) ?? cols.at(-1) ?? null;
  const pickedSession = picked.key === key ? cols.find((s) => s.id === picked.session) : undefined;
  const selected = pickedSession ?? fallback;
  const selectedFile = picked.key === key && showMemory ? picked.file : null;
  const fileRow = selectedFile ? rows.find((r) => r.file === selectedFile) : undefined;
  const untrackedNow = data
    ? data.open.untracked.filter((u) => !u.firstSession || provider === "all" || data.sessions.find((s) => s.id === u.firstSession)?.agent === provider).length
      + sessions.flatMap((s) => s.created).filter((c) => c.state === "untracked" && !data.open.untracked.some((u) => u.path === c.path)).length
    : 0;

  const pickSession = (id: string) => setPicked({ session: id, file: null, key });
  const pickFile = (file: string) => setPicked({ session: selected?.id ?? null, file, key });
  const step = (dir: -1 | 1) => {
    const i = selected ? cols.indexOf(selected) : -1;
    const next = cols[i + dir];
    if (next) pickSession(next.id);
  };
  const openSession = (id: string) => {
    if (cols.some((s) => s.id === id)) {
      pickSession(id);
      document.querySelector(".ctx-dt")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const summary = data && sessions.length
    ? `${plural(sessions.length, "session")} · ${fmtDay(sessions[0].startedAt)} – ${fmtDay(sessions.at(-1)!.endedAt)}`
    : data ? "0 sessions" : "";

  return (
    <div className="page ctx-page">
      <div className="scope-bar ctx-scope" role="search" aria-label="Project">
        {projects.length > 0 && <ProjectPicker projects={projects} value={current} onChange={(p) => onProjectChange(p)} />}
        <div className="scope-summary">
          <span className="mono tabular">{summary}</span>
          {data && provider === "all" && (["claude", "codex", "copilot"] as const).filter((a) => sessions.some((s) => s.agent === a)).map((a) => (
            <span key={a} className="ctx-cov"><span className={`provider-dot ${a}`} aria-hidden="true" />{AGENT_LABEL[a]} {sessions.filter((s) => s.agent === a).length}</span>
          ))}
        </div>
      </div>

      {!current && <div className="ctx-card ctx-empty"><b>No session yet</b>Run a session with Claude Code, Codex or Copilot CLI: its project shows up here.</div>}
      {current && !data && !error && <div className="ctx-card ctx-empty">Reading {current}…</div>}
      {current && error && !data && <div className="ctx-card ctx-empty"><b>Could not read this project</b>{error}</div>}

      {data && (
        <>
          <HeadBar data={data} provider={provider} rows={showMemory ? rows : []} selectedFile={selectedFile} onFile={(f) => { pickFile(f); document.querySelector(".ctx-dt")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} onHoverFile={setHotFile} />

          {sessions.length > 0 && (
            <PageSection
              title="Session by session"
              note={showMemory ? "Oldest on the left. Click a session to see what it and its subagents had in mind, or a memory to see its history." : "Oldest on the left. Click a session to see what it had in mind and what it left on disk."}
            >
              {cols.length ? (
                <SessionGrid
                  cols={cols}
                  total={sessions.length}
                  provider={provider}
                  rows={showMemory ? rows : null}
                  marks={marks}
                  hasMemory={rows.length > 0}
                  untrackedNow={untrackedNow}
                  selectedSession={selected?.id ?? null}
                  selectedFile={selectedFile}
                  hotFile={hotFile}
                  onSession={pickSession}
                  onFile={pickFile}
                />
              ) : (
                <div className="ctx-card ctx-empty">{plural(sessions.length, "session")}, none touched memory, launched a subagent or wrote a repo file.</div>
              )}
              {fileRow ? (
                <FileView row={fileRow} sessions={data.sessions} backLabel={selected ? sessionName(selected) : null} onBack={() => setPicked({ session: selected?.id ?? null, file: null, key })} onSession={openSession} />
              ) : selected ? (
                <SessionView
                  data={data}
                  session={selected}
                  index={cols.indexOf(selected)}
                  count={cols.length}
                  marks={marks.get(selected.id)}
                  rows={rows}
                  onStep={step}
                  onFile={pickFile}
                />
              ) : null}
            </PageSection>
          )}

          {sessions.length > 0 && (
            <PageSection title="Still open" note="What sessions left on disk that nobody committed or cleaned up">
              <StillOpen data={data} provider={provider} onSession={openSession} />
            </PageSection>
          )}

          <p className="ctx-sources">
            <b>Sources.</b>{" "}
            {[
              (provider === "all" || provider === "claude") && "Claude Code logs the instruction files each session and subagent loaded at start, every memory read, write and delete, and each subagent's brief. Writes made through shell commands are read from the command text, so a few may be missed; a dashed ring marks a change on disk that no log explains.",
              (provider === "all" || provider === "codex") && "Codex logs the files it creates and changes and the subagents it spawns, whose briefs it encrypts; it logs no instruction files.",
              (provider === "all" || provider === "copilot") && "Copilot CLI logs the instruction files in its system prompt (matched to files on disk by content), its subagents and the files it creates.",
            ].filter(Boolean).join(" ")}
            {data.memory.dir && !data.memory.exists && ` This project's memory folder (${data.memory.dir}) no longer exists: its files show as deleted.`}
          </p>
        </>
      )}
    </div>
  );
}
