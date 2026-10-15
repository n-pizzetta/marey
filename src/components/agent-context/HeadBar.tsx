import { useRef, useState } from "react";
import type { Provider } from "../../utils/providers";
import type { AgentContextData, LoadedFile, MemoryRow } from "../../utils/agentContext";
import { loadedName, RECALL_DAYS } from "../../utils/agentContext";
import { AGENT_LABEL, fmtDay, plural } from "./format";

interface Segment {
  key: string;
  /** Set on memory files: a click opens them. */
  file?: string;
  title: string;
  path: string;
  lines: number;
  status: "loaded" | "live" | "idle";
  note: string;
}

interface Props {
  data: AgentContextData;
  provider: Provider;
  rows: MemoryRow[];
  selectedFile: string | null;
  onFile: (file: string) => void;
  onHoverFile: (file: string | null) => void;
}

const shortPath = (p: string) => p.replace(/^~\/\.claude\/projects\/[^/]+\//, "~/.claude/projects/…/");

/** What Codex and Copilot CLI load at start, in one line. */
function otherNote(agent: "codex" | "copilot", data: AgentContextData): string {
  if (agent === "codex") {
    return data.agentsMd
      ? "Built-in instructions plus the project's AGENTS.md (on disk; Codex logs no instruction files) · no memory files"
      : "Built-in instructions only (no AGENTS.md in this project) · no memory files";
  }
  return "The instruction files in its system prompt; explore, research and code-review sub-agents get none · no memory files";
}

/**
 * Everything the agent has in mind at start, one segment per file sized by its lines: the files
 * read in full at every start, then the memory behind the index, green when re-read lately.
 */
export function HeadBar({ data, provider, rows, selectedFile, onFile, onHoverFile }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ seg: Segment; left: number; top: number; below: boolean } | null>(null);

  const showClaude = provider === "all" || provider === "claude";
  const copilot = data.sessions.filter((s) => s.agent === "copilot");
  const codex = data.sessions.filter((s) => s.agent === "codex");

  let groups: Array<{ label: React.ReactNode; segments: Segment[] }> = [];
  if (showClaude && data.instructions.length) {
    const start: Segment[] = data.instructions.filter((i) => i.exists).map((i) => ({
      key: i.path,
      title: loadedName(i as LoadedFile),
      path: shortPath(i.path),
      lines: i.lines ?? 1,
      status: "loaded",
      note: "read in full at every start",
    }));
    const behind = rows
      .filter((m) => m.exists)
      .sort((a, b) => (a.status === b.status ? b.lastRead - a.lastRead : a.status === "live" ? -1 : 1));
    const reread = behind.filter((m) => m.status === "live");
    const sum = (arr: Array<{ lines: number }>) => arr.reduce((n, x) => n + x.lines, 0);
    groups = [
      {
        label: <>{provider === "all" && <span className="provider-dot claude" aria-hidden="true" />}<b>{sum(start)}</b> lines read at every start</>,
        segments: start,
      },
    ];
    if (behind.length) {
      groups.push({
        label: <><b>{sum(behind)}</b> lines of memory behind the index · <b className="ctx-g">{sum(reread)}</b> re-read in {RECALL_DAYS} days</>,
        segments: behind.map((m) => ({
          key: m.file,
          file: m.file,
          title: m.title,
          path: `memory/${m.file}`,
          lines: m.lines,
          status: m.status === "live" ? "live" : "idle",
          note: m.status === "live" ? `re-read ${fmtDay(m.lastRead)}` : m.lastRead ? `not re-read since ${fmtDay(m.lastRead)}` : "never re-read",
        })),
      });
    }
  } else if (provider === "copilot" && copilot.length) {
    const last = [...copilot].reverse().find((s) => s.loads.length)?.loads.at(-1);
    const files = last?.files ?? [];
    if (files.length) {
      groups = [{
        label: <><b>{files.reduce((n, f) => n + (f.lines ?? 0), 0)}</b> lines in Copilot CLI's system prompt</>,
        segments: files.map((f, i) => ({ key: `${i}`, title: loadedName(f), path: f.path ? shortPath(f.path) : "no matching file on disk", lines: f.lines ?? 1, status: "loaded", note: "in the system prompt at start" })),
      }];
    }
  }

  const show = (seg: Segment, el: HTMLElement) => {
    onHoverFile(seg.file ?? null);
    const box = card.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    // Centered on the segment, kept inside the card (the label is at most 300 px wide).
    const half = Math.min(150, box.width / 2 - 12);
    const left = Math.min(Math.max(r.left + r.width / 2 - box.left, half + 12), box.width - half - 12);
    setTip({ seg, left, top: r.top - box.top, below: r.top - box.top < 80 });
  };
  const hide = () => {
    setTip(null);
    onHoverFile(null);
  };

  const legend = showClaude && groups.length > 1;
  const live = rows.filter((m) => m.exists && m.status === "live").length;
  const idle = rows.filter((m) => m.exists && m.status !== "live").length;

  return (
    <div className="ctx-card ctx-head" ref={card} onMouseLeave={hide}>
      {groups.length ? (
        <div className="ctx-map">
          {groups.map((g, gi) => (
            <div key={gi} className="ctx-map-group" style={{ flex: `${g.segments.reduce((n, s) => n + s.lines, 0)} 1 0` }}>
              <div className="ctx-map-label">{g.label}</div>
              <div className="ctx-map-bar">
                {g.segments.map((s) => {
                  const common = {
                    className: `ctx-sg ${s.status}${s.file && s.file === selectedFile ? " sel" : ""}`,
                    style: { flex: `${s.lines} 1 0` },
                    "aria-label": `${s.title}, ${s.lines} lines, ${s.note}`,
                    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(s, e.currentTarget),
                    onFocus: (e: React.FocusEvent<HTMLElement>) => show(s, e.currentTarget),
                    onBlur: hide,
                  };
                  return s.file
                    ? <button key={s.key} {...common} onClick={() => { hide(); onFile(s.file!); }} />
                    : <span key={s.key} role="img" {...common} />;
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="ctx-void">
          <div className="ctx-map-label"><b>{provider === "all" || provider === "claude" ? "Claude Code" : AGENT_LABEL[provider]}</b> · what it has in mind at start</div>
          <div className="ctx-void-bar">
            {provider === "codex" ? (data.agentsMd ? "AGENTS.md on disk; Codex logs no instruction files" : "No AGENTS.md in this project: built-in instructions only")
              : provider === "copilot" ? (copilot.length ? "No instruction file in Copilot CLI's system prompt" : "No Copilot CLI session in this project")
              : "No instruction file recorded for this project"}
          </div>
          {provider === "codex" && <p>Codex starts from its built-in instructions plus every AGENTS.md from the project root to its working folder, and logs none of them. It keeps no memory files here.</p>}
          {provider === "copilot" && <p>Copilot CLI puts CLAUDE.md, AGENTS.md and .github/copilot-instructions.md in its system prompt, matched here to the files on disk; its explore, research and code-review sub-agents get none of them. It keeps no memory files.</p>}
        </div>
      )}
      {legend && (
        <div className="ctx-head-foot">
          <span><span className="ctx-sw loaded" />Loaded at start · {groups[0].segments.length}</span>
          <span><span className="ctx-sw live" />Re-read in {RECALL_DAYS} days · {live}</span>
          <span><span className="ctx-sw idle" />Index line only · {idle}</span>
          <span className="ctx-hint">Click a segment to open that memory.</span>
        </div>
      )}
      {provider === "all" && (codex.length > 0 || copilot.length > 0) && (
        <div className="ctx-pstrip">
          {(["codex", "copilot"] as const).filter((a) => data.sessions.some((s) => s.agent === a)).map((a) => (
            <div key={a}>
              <span className={`provider-dot ${a}`} aria-hidden="true" />
              <b>{AGENT_LABEL[a]}</b>
              <span>{plural(data.sessions.filter((s) => s.agent === a).length, "session")} · {otherNote(a, data)}</span>
            </div>
          ))}
        </div>
      )}
      {tip && (
        <div className={`ctx-tip${tip.below ? " below" : ""}`} style={{ left: tip.left, top: tip.below ? tip.top + 32 : tip.top - 8 }} role="tooltip">
          <b>{tip.seg.title}</b>
          <code>{tip.seg.path}</code>
          <span><i className={tip.seg.status} />{plural(tip.seg.lines, "line")} · {tip.seg.note}</span>
        </div>
      )}
    </div>
  );
}
