import type { Provider } from "../../utils/providers";
import type { AgentContextData } from "../../utils/agentContext";
import { AGENT_LABEL, fmtDay, plural, sessionName } from "./format";

interface Props {
  data: AgentContextData;
  provider: Provider;
  onSession: (id: string) => void;
}

/** What sessions left on disk that nobody committed or cleaned up: untracked files, files outside the repo. */
export function StillOpen({ data, provider, onSession }: Props) {
  const byId = new Map(data.sessions.map((s) => [s.id, s]));
  const mine = (id: string | null) => !id || provider === "all" || byId.get(id)?.agent === provider;
  const untracked = data.open.untracked.filter((u) => mine(u.firstSession));
  const outside = data.open.outside.filter((o) => mine(o.lastSession));
  const sessions = data.sessions.filter((s) => provider === "all" || s.agent === provider);
  const created = sessions.flatMap((s) => s.created);
  const rows: React.ReactNode[] = [];

  for (const u of untracked) {
    const s = u.firstSession ? byId.get(u.firstSession) : undefined;
    rows.push(
      <div className="ctx-or" key={`u:${u.path}`}>
        <span className="ctx-p"><span className="ctx-tag amber">untracked</span><span>{u.path}</span></span>
        <span className="ctx-m">
          {s ? <>left by <button onClick={() => onSession(s.id)}>{sessionName(s)}</button></> : "no session wrote it with a tool"}
          {u.firstMs ? ` · ${fmtDay(u.firstMs)}` : ""}
        </span>
      </div>,
    );
  }
  for (const o of outside) {
    const s = byId.get(o.lastSession);
    const tag = !o.exists ? "gone" : o.kind === "agent-config" ? "agent config" : o.kind === "folder" ? "other folder" : "outside repo";
    rows.push(
      <div className="ctx-or" key={`o:${o.path}`}>
        <span className={`ctx-p${o.exists ? "" : " gone"}`}><span className={`ctx-tag ${o.exists ? "grey" : "red"}`}>{tag}</span><span>{o.path}</span></span>
        <span className="ctx-m">
          {o.files ? `${plural(o.files, "file")} · ` : ""}{plural(o.edits, "edit")}{o.lastMs ? ` · ${fmtDay(o.lastMs)}` : ""}
          {s && <> · <button onClick={() => onSession(s.id)}>{sessionName(s)}</button></>}
        </span>
      </div>,
    );
  }
  if (!rows.length && provider !== "all" && provider !== "claude") {
    rows.push(
      <div className="ctx-or ctx-sum" key="none">
        {created.length ? `Nothing left open by ${AGENT_LABEL[provider]} sessions: the ${plural(created.length, "file")} they created in the repo are ${created.every((c) => c.state === "committed") ? "all committed" : "accounted for"}.` : `Nothing left open by ${AGENT_LABEL[provider]} sessions.`}
      </div>,
    );
  }
  if (provider === "all" || provider === "claude") {
    const wt = data.open.worktrees;
    const still = wt.filter((w) => w.exists).length;
    const parts = [
      data.open.plans > 0 && `${plural(data.open.plans, "plan")} in ~/.claude/plans/`,
      data.open.scratch.files > 0 && `${data.open.scratch.files} scratch files in temp dirs from ${plural(data.open.scratch.sessions, "session")}`,
      wt.length > 0 && `${plural(wt.length, "worktree")} created, ${still ? `${still} still on disk` : "all removed"}`,
    ].filter(Boolean);
    if (parts.length) rows.push(<div className="ctx-or ctx-sum" key="sum">{rows.length ? "Also: " : ""}{parts.join(" · ")}.</div>);
  }
  if (!rows.length) rows.push(<div className="ctx-or ctx-sum" key="empty">Nothing left open.</div>);
  return <div className="ctx-card ctx-open">{rows}</div>;
}
