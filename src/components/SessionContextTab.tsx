import { useMemo, useState } from "react";
import type { Session } from "../types";
import { memoryMarks, memoryRows, useAgentContext } from "../utils/agentContext";
import { sessionProvider } from "../utils/providers";
import { FileView, SessionView } from "./agent-context/ContextDetail";
import { StillOpen } from "./agent-context/StillOpen";
import "../agent-context.css";

/** Another session of the project, opened like a link to it. */
const openSession = (id: string) => {
  window.location.hash = `#session/${id}`;
};

/**
 * What this session had in mind at start, what it did to the project's memory, what it left on disk
 * and what each of its sub-agents was given; then what is still open in its project. Its project
 * only: the session's own, never another picked for it.
 */
export function SessionContextTab({ session }: { session: Session }) {
  const project = session.project || null;
  const { data, error } = useAgentContext(project, undefined);
  const [file, setFile] = useState<string | null>(null);
  const now = data ? Date.parse(data.generatedAt) : 0;
  const rows = useMemo(() => (data ? memoryRows(data, now) : []), [data, now]);
  const marks = useMemo(() => memoryMarks(rows), [rows]);
  const mine = data?.sessions.find((s) => s.id === session.id);
  const fileRow = file ? rows.find((r) => r.file === file) : undefined;

  if (!project) return <div className="placeholder">This session has no project folder, so no context to show.</div>;
  if (!data) return <div className="placeholder">{error ? `Could not read ${project}: ${error}` : `Reading ${project}…`}</div>;
  return (
    <div className="ctx-tab">
      {!mine ? (
        <div className="placeholder">Nothing recorded for this session: it loaded no instruction file, touched no memory and wrote no file.</div>
      ) : fileRow ? (
        <FileView row={fileRow} sessions={data.sessions} backLabel="this session" onBack={() => setFile(null)} onSession={(id) => (id === session.id ? setFile(null) : openSession(id))} />
      ) : (
        <SessionView data={data} session={mine} marks={marks.get(mine.id)} rows={rows} onFile={setFile} />
      )}
      <div className="section-title ctx-tab-title">
        <span>Still open in {project}</span>
        <span className="dim">What its sessions left on disk that nobody committed or cleaned up</span>
      </div>
      <StillOpen data={data} provider={sessionProvider(session)} onSession={openSession} />
    </div>
  );
}
