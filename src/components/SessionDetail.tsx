import { LimitsPill } from "./LimitsGauge";
import { SessionContext, StatusSep } from "./ContextCard";
import { GoalSummary } from "./GoalSummary";
import { TimelineTab } from "./SessionTimeline";
import { FrictionsCard, SessionKpis, TabPreviews, type OverviewLink } from "./SessionOverview";
import { KpiRow } from "./Kpi";
import { freshTokens, useUnit, type Unit } from "../utils/units";
import { promptWeights } from "../utils/promptShare";
import { cacheHit, inputTokens, projectColor } from "../utils/fleetStats";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPatch } from "diff";
import type { Session, SessionQuality, ToolCall, ToolName } from "../types";
import { callsBetween, callsPerPrompt, countCalls, countFailed, countSubCalls, flattenCalls, onlyFailed } from "../utils/toolCalls";
import { estimateHint, formatBytes, formatClockAt, formatCost, formatDuration, formatTokens, outcomeColor, outcomeLabel } from "../utils/format";
import { SESSION_IDLE_GAP_MS } from "../utils/fleetStats";
import { downloadSessionHtml } from "../utils/exportSession";
import { classifyPrompt, PROMPT_KIND_COLOR, PROMPT_KIND_LABEL } from "../utils/classifyPrompt";
import { costOf, modelLabel, priceFor, type CostTokens, type ModelPrice } from "../../scripts/models.mjs";
import { toastError } from "../utils/toast";
import { canOpenTerminal, openTerminal } from "../utils/openTerminal";
import { keepFocus } from "../utils/keepFocus";

function gradeColor(grade: string): string {
  if (grade === "S" || grade === "A") return "var(--c-green)";
  if (grade === "B") return "var(--c-cyan)";
  if (grade === "C") return "var(--c-amber)";
  return "var(--c-red)";
}

function signalColor(score: number): string {
  if (score >= 90) return "var(--c-green)";
  if (score >= 70) return "var(--c-cyan)";
  if (score >= 50) return "var(--c-amber)";
  return "var(--c-red)";
}

function QualitySignalRow({ signal }: { signal: SessionQuality["signals"][number] }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const info = SIGNAL_INFO[signal.kind];
  const color = signalColor(signal.score);
  return (
    <div className="quality-pop-signal">
      <div className="quality-pop-signal-head">
        <span className="mono quality-pop-signal-label">
          {signal.label}
          {info && (
            <button
              type="button"
              className="signal-info-btn"
              onClick={(e) => { e.stopPropagation(); setInfoOpen((v) => !v); }}
              aria-label={infoOpen ? "Hide explanation" : "Show explanation"}
              aria-expanded={infoOpen}
            >ⓘ</button>
          )}
        </span>
        <span className="mono tabular" style={{ color }}>{signal.score}/100</span>
      </div>
      <div className="quality-pop-meter">
        <div className="quality-pop-meter-fill" style={{ width: `${signal.score}%`, background: color }} />
      </div>
      {infoOpen && info && (
        <div className="signal-info-text">{info}</div>
      )}
      {signal.detail && <div className="quality-pop-detail dim">{signal.detail}</div>}
      {signal.wasteTokens > 0 && (
        <div className="quality-pop-waste-line mono dim tabular">
          ~{signal.wasteTokens.toLocaleString()} waste tokens
        </div>
      )}
    </div>
  );
}

const SIGNAL_INFO: Record<string, string> = {
  context_fill_degradation: "How full the context window got. Past ~70% fill, Claude starts losing early context and repeating itself.",
  stale_reads: "Files re-read after they were already in context. Each duplicate Read wastes input tokens.",
  bloated_results: "Tool results longer than necessary (huge Bash output, oversized Read ranges). Truncate or narrow to save tokens.",
  duplicates: "Exact same tool call repeated back-to-back. Usually wasted work — result was already known.",
  compaction_depth: "Number of /compact operations. Each compaction loses detail irreversibly. Deep chains lose most of the original context.",
  decision_density: "Ratio of substantive assistant turns (tool calls, edits) vs filler. Low = lots of chit-chat per useful action.",
  agent_efficiency: "How effectively sub-agents were used. Zero agents in a long session often means work that could have been parallelized.",
};

/** Popovers opened from the meta line go under the title, so they never hide it; elsewhere, under their trigger. */
function popoverTop(trigger: Element, gap: number): number {
  const title = trigger.closest(".meta-line")?.parentElement?.querySelector(".goal-row");
  return (title ?? trigger).getBoundingClientRect().bottom + gap;
}

function QualityChip({ quality }: { quality: SessionQuality }) {
  const c = gradeColor(quality.grade);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const btn = btnRef.current;
      if (!btn) return;
      setPos({ top: popoverTop(btn, 8), left: btn.getBoundingClientRect().left });
    };
    updatePos();
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let App's Escape handler close the session view as well.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sortedSignals = [...quality.signals].sort((a, b) => a.score - b.score);

  return (
    <span className="meta-item" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="meta-quality"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Quality ${quality.grade} ${quality.score.toFixed(1)}: score details`}
      >
        Quality <b className="tabular" style={{ color: c }}>{quality.grade} {quality.score.toFixed(1)}</b>
        <span className="meta-info" aria-hidden="true">ⓘ</span>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="quality-popover"
          role="dialog"
          aria-label="Quality breakdown"
          style={{ top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${Math.round(pos.top) + 16}px)` }}
        >
          <div className="quality-pop-head">
            <span className="mono dim">Measured from the transcript</span>
          </div>
          <div className="quality-pop-top">
            <div>
              <div className="dim mono caps">Grade</div>
              <div className="quality-pop-grade" style={{ color: c }}>{quality.grade}</div>
            </div>
            <div>
              <div className="dim mono caps">Score</div>
              <div className="quality-pop-score tabular">{quality.score.toFixed(1)} <span className="dim">/ 100</span></div>
            </div>
            {quality.band && (
              <div>
                <div className="dim mono caps">Band</div>
                <div className="mono">{quality.band}</div>
              </div>
            )}
            {quality.fillPct !== null && (
              <div>
                <div className="dim mono caps">Context fill</div>
                <div className="mono tabular">{Math.round(quality.fillPct)}%</div>
              </div>
            )}
          </div>
          {quality.wasteTokens > 0 && (
            <div className="quality-pop-waste mono">
              ~ <strong className="tabular">{quality.wasteTokens.toLocaleString()}</strong> tokens estimated wasted
            </div>
          )}
          <div className="quality-pop-signals">
            <div className="dim mono caps quality-pop-signals-head">Signals</div>
            {sortedSignals.length === 0 ? (
              <div className="placeholder">No signals recorded.</div>
            ) : (
              sortedSignals.map((s) => <QualitySignalRow key={s.kind} signal={s} />)
            )}
          </div>
        </div>
      )}
    </span>
  );
}

interface Props {
  session: Session;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose?: () => void;
  onNavigate?: (dir: "prev" | "next") => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  position?: number;
  total?: number;
  /** Open on the Tools tab, with the calls of this sub-agent (its id) shown. */
  focusSubagent?: string | null;
}

type Tab = "overview" | "timeline" | "tools" | "tokens" | "files";

/** Line icons on a 24 grid, drawn like the page navigation's. */
const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  {
    id: "overview",
    label: "Overview",
    icon: (
      <>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
      </>
    ),
  },
  { id: "timeline", label: "Timeline", icon: <path d="M4 4.5v15h16M7.5 15.5l3.5-4.5 3 2.5 5-6.5" /> },
  {
    id: "tools",
    label: "Tools",
    icon: <path d="M15 3.8a5 5 0 0 0-5 6.6l-5.6 5.6a2.3 2.3 0 0 0 3.3 3.3l5.6-5.6a5 5 0 0 0 6.6-5l-2.9 2.9-2.8-.5-.5-2.8z" />,
  },
  {
    id: "tokens",
    label: "Tokens",
    icon: (
      <>
        <circle cx="9.5" cy="9.5" r="5.5" />
        <path d="M15.6 9.9a5.5 5.5 0 1 1-5.7 5.7" />
      </>
    ),
  },
  { id: "files", label: "Files", icon: <path d="M13.5 3.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-10zM13.5 3.5v5h5" /> },
];

export function SessionDetail({
  session,
  fullscreen = false,
  onToggleFullscreen,
  onClose,
  onNavigate,
  hasPrev = false,
  hasNext = false,
  position,
  total,
  focusSubagent = null,
}: Props) {
  const [tab, setTab] = useState<Tab>(focusSubagent ? "tools" : "overview");
  // One scroll for the whole view: the header scrolls away under the tabs, which stay on top.
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // past the header, another tab starts at its top, right under the tabs
  const showTab = (to: Tab) => {
    setTab(to);
    const root = rootRef.current;
    const top = topRef.current;
    if (!root || !top) return;
    const below = top.offsetTop + top.offsetHeight;
    if (root.scrollTop > below) root.scrollTop = below;
  };
  const [toolFocus, setToolFocus] = useState<{ promptIdx: number; start: number; end: number } | null>(null);
  // a link from the Overview into the Tokens tab, consumed once it has scrolled there
  const [tokensFocus, setTokensFocus] = useState<TokensFocus | null>(null);
  const clearTokensFocus = useCallback(() => setTokensFocus(null), []);
  const [resumeCopied, setResumeCopied] = useState(false);
  const c = outcomeColor(session.outcome);
  const toolCallCount = Object.values(session.toolCounts ?? {}).reduce((a, n) => a + n, 0);

  const shellEscape = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const resume =
    session.agent === "codex" ? `codex resume ${session.id}`
    : session.agent === "copilot" ? `copilot --resume ${session.id}`
    : `claude --resume ${session.id}`;
  const resumeCmd = session.cwd ? `cd ${shellEscape(session.cwd)} && ${resume}` : resume;
  const copyResume = async () => {
    try {
      await navigator.clipboard.writeText(resumeCmd);
      setResumeCopied(true);
      setTimeout(() => setResumeCopied(false), 1800);
    } catch {
      alert("Clipboard unavailable — command:\n" + resumeCmd);
    }
  };

  // A running session is picked up in its terminal, not resumed in a second one.
  const [opening, setOpening] = useState(false);
  const openSessionTerminal = async () => {
    setOpening(true);
    await openTerminal(session.id);
    setOpening(false);
  };

  const focusToolsForPrompt = (promptIdx: number, start: number, end: number) => {
    setToolFocus({ promptIdx, start, end });
    showTab("tools");
  };
  // the Overview's summaries open their tab; the API value one lands on Tokens › By kind
  const openFromOverview = (to: OverviewLink) => {
    if (to === "tokens") setTokensFocus({ section: "kind" });
    if (to === "tools") setToolFocus(null);
    showTab(to);
  };
  const openPromptCost = (idx: number) => {
    setTokensFocus({ section: "prompt", idx });
    showTab("tokens");
  };

  return (
    <div className={`detail ${fullscreen ? "fullscreen" : ""}`} key={session.id} ref={rootRef}>
      <div className="detail-top" ref={topRef}>
        <div className="detail-toolbar">
          <div className="detail-nav">
            <button
              className="toolbar-btn"
              onClick={() => onNavigate?.("prev")}
              disabled={!hasPrev}
              title="Previous (↑ / k)"
              aria-label="Previous session"
            >↑</button>
            <button
              className="toolbar-btn"
              onClick={() => onNavigate?.("next")}
              disabled={!hasNext}
              title="Next (↓ / j)"
              aria-label="Next session"
            >↓</button>
            {position && total ? (
              <span className="mono dim toolbar-pos tabular">{position} / {total}</span>
            ) : null}
          </div>
          <div className="detail-toolbar-right">
            <LimitsPill providers={[session.agent ?? "claude"]} />
            <button
              className="toolbar-btn wide"
              onClick={() => downloadSessionHtml(session)}
              title="Export session as HTML"
            >
              Export
            </button>
            {onClose ? (
              <button
                className="toolbar-btn"
                onClick={onClose}
                title="Close (Esc)"
                aria-label="Close session"
              >
                ✕
              </button>
            ) : onToggleFullscreen ? (
              <button
                className="toolbar-btn"
                onClick={onToggleFullscreen}
                title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (⌘F)"}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? "⊗" : "⤢"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="detail-header">
          {/* one quiet line over the title: where and when, then how it went; colour only on the values */}
          <div className="meta-line">
            <span className="meta-group">
              <span className="meta-item">
                <span className="project-dot" style={{ background: projectColor(session.project) }} aria-hidden="true" />
                {session.project}
              </span>
              <StatusSep />
              <span className="meta-item">{modelLabel(session.model)}</span>
              <StatusSep />
              <span className="meta-item tabular">
                {new Date(session.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </span>
            </span>
            <StatusSep className="meta-group-sep" />
            <span className="meta-group">
              <span className="meta-item">
                Outcome <b style={{ color: c }}>{outcomeLabel(session.outcome)}</b>
                <InfoDot
                  title={
                    session.outcome === "in_progress"
                      ? "Session is currently running. Outcome is set to 'in progress' while live; an outcome is assessed later when /insights analyzes it."
                      : session.agent === "codex" || session.agent === "copilot"
                      ? "Outcome unknown: /insights only analyzes Claude Code sessions."
                      : session.outcome === "unknown"
                      ? "Outcome unknown: /insights hasn't analyzed this session yet (it assesses sessions in batch). Run /insights in Claude Code to fill it in."
                      : "Outcome assessed by /insights from the transcript. Subjective: 'fully / mostly / partially / not' achieved. Not a hard metric — useful as a rough signal."
                  }
                />
              </span>
              {session.quality && (
                <>
                  <StatusSep />
                  <QualityChip quality={session.quality} />
                </>
              )}
            </span>
          </div>
          <div className="goal-row">
            <div className="goal">{session.goal}</div>
            {/* on the title's first line, right-aligned: the context figures and verdict, then the primary action */}
            <div className="goal-actions">
              <SessionContext session={session} />
              {canOpenTerminal(session) ? (
                <button className="resume-btn" onClick={openSessionTerminal} disabled={opening} title="Bring the terminal running this session to the front">
                  {opening ? "Opening…" : "Open terminal"}
                </button>
              ) : (
                <button className="resume-btn" onClick={copyResume} title={resumeCmd}>
                  {resumeCopied ? "✓ Copied" : "Copy resume command"}
                </button>
              )}
            </div>
          </div>
          <GoalSummary summary={session.summary} goal={session.goal} />
        </div>

        {(session.clearedFrom || session.clearedInto) && (
          <ClearedBanner session={session} />
        )}
        {session.ghost && <GhostBanner session={session} />}
      </div>

      <div className="detail-tabs-bar">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onMouseDown={keepFocus}
              onClick={() => showTab(t.id)}
            >
              <svg className="tab-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                {t.icon}
              </svg>
              {t.label}
              {t.id === "overview" && session.frictions.length > 0 && (
                <span className="tab-count warn mono tabular" title={`${session.frictions.length} friction${session.frictions.length > 1 ? "s" : ""}`}>
                  {session.frictions.length}
                </span>
              )}
              {t.id === "tools" && <span className="tab-count mono tabular">{toolCallCount}</span>}
              {t.id === "files" && session.filesChanged > 0 && <span className="tab-count mono tabular">{session.filesChanged}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-body scrollbar">
        {tab === "overview" && (
          <OverviewTab session={session} onFocusTools={focusToolsForPrompt} onOpen={openFromOverview} onOpenPromptCost={openPromptCost} />
        )}
        {tab === "timeline" && <TimelineTab session={session} onFocusTools={focusToolsForPrompt} />}
        {tab === "tools" && (
          <ToolsTab session={session} focus={toolFocus} onClearFocus={() => setToolFocus(null)} focusSubagent={focusSubagent} />
        )}
        {tab === "tokens" && <TokensTab session={session} focus={tokensFocus} onFocusDone={clearTokensFocus} />}
        {tab === "files" && <FilesTab session={session} />}
      </div>

      <div className="detail-footer">
        <span className="mono">
          <button
            className="footer-id-copy"
            onClick={copyResume}
            title={resumeCopied ? "Copied!" : `Copy resume command\n${resumeCmd}`}
            aria-label="Copy resume command"
          >
            {resumeCopied ? "✓ copied" : session.id}
          </button>
        </span>
      </div>
    </div>
  );
}

function ClearedBanner({ session }: { session: Session }) {
  const jump = (id: string) => {
    window.location.hash = `session/${id}`;
  };
  return (
    <div className="cleared-banner mono">
      <span className="cleared-banner-icon">⟲</span>
      <span className="cleared-banner-text">
        {session.clearedFrom && (
          <>
            Context cleared from{" "}
            <button className="cleared-link" onClick={() => jump(session.clearedFrom!)}>
              prev session
            </button>
            .
          </>
        )}
        {session.clearedInto && (
          <>
            {session.clearedFrom ? " · " : ""}
            Context cleared. Continues in{" "}
            <button className="cleared-link" onClick={() => jump(session.clearedInto!)}>
              next session →
            </button>
          </>
        )}
      </span>
    </div>
  );
}

const GHOST_KIND_COPY: Record<string, { label: string; desc: string }> = {
  empty: {
    label: "Ghost · empty",
    desc: "This session was aborted before any prompt was sent (startup canceled). Usually safe to delete.",
  },
  crashed: {
    label: "Ghost · crashed",
    desc: "Claude Code was killed while running (kill -9, reboot, or force-quit). Resume to pick up where it stopped.",
  },
};


function GhostBanner({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const kind = session.ghostKind ?? "empty";
  const copy = GHOST_KIND_COPY[kind];
  const cwd = session.cwd || "";
  const shellEscape = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const resumeCmd = cwd
    ? `cd ${shellEscape(cwd)} && claude --resume ${session.id}`
    : `claude --resume ${session.id}`;

  const openTranscript = async () => {
    try {
      const res = await fetch(`/api/ghost/${session.id}/reveal`, { method: "POST" });
      if (!res.ok) toastError("Could not open the transcript file.");
    } catch (e) {
      toastError("Request failed: " + e);
    }
  };

  const copyResume = async () => {
    try {
      await navigator.clipboard.writeText(resumeCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError("Clipboard unavailable. Run manually: " + resumeCmd);
    }
  };

  const deletePermanently = async () => {
    if (!confirm(
      "Delete this ghost session permanently?\n\n" +
        "This removes the transcript jsonl and its stale live file. Cannot be undone.",
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ghost/${session.id}/delete`, { method: "POST" });
      if (!res.ok) {
        const err = await res.text();
        toastError("Delete failed: " + err);
        return;
      }
      location.reload();
    } finally {
      setBusy(false);
    }
  };

  if (!expanded) {
    return (
      <button className={`ghost-chip ghost-kind-${kind}`} onClick={() => setExpanded(true)} title={copy.desc}>
        <span className="ghost-chip-icon">⚠</span>
        <span className="ghost-chip-text">{copy.label}</span>
        <span className="ghost-chip-more mono dim">details ▸</span>
      </button>
    );
  }

  return (
    <div className={`ghost-banner ghost-kind-${kind}`}>
      <div className="ghost-banner-head">
        <span className="ghost-banner-icon">⚠</span>
        <div className="ghost-banner-title">{copy.label}</div>
        <button className="ghost-banner-toggle" onClick={() => setExpanded(false)}>
          Hide
        </button>
      </div>
      <div className="ghost-banner-body">
        <p>
          This session is flagged as a ghost. Its transcript is still in{" "}
          <code>~/.claude/projects/</code>.
        </p>
        <p className="mono dim">{copy.desc}</p>
      </div>
      {kind !== "empty" && (
        <div className="ghost-resume-block">
          <div className="ghost-resume-label mono dim caps">Resume command</div>
          <div className="ghost-resume-row">
            <code className="ghost-resume-code mono">{resumeCmd}</code>
            <button className="ghost-action primary" onClick={copyResume} disabled={busy}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="mono dim ghost-resume-hint">
            Run in a terminal. <code>cd</code> matters — Claude CLI looks up sessions by current project slug.
          </div>
        </div>
      )}
      <div className="ghost-banner-actions">
        <button className="ghost-action" onClick={openTranscript} disabled={busy}>
          Reveal transcript
        </button>
        <button className="ghost-action danger" onClick={deletePermanently} disabled={busy}>
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </div>
  );
}

/**
 * How this session went, in one screen: the headline figures (each opening its tab), the prompts
 * chart, frictions, and a summary of each other tab.
 */
function OverviewTab({
  session,
  onFocusTools,
  onOpen,
  onOpenPromptCost,
}: {
  session: Session;
  onFocusTools: (promptIdx: number, start: number, end: number) => void;
  onOpen: (to: OverviewLink) => void;
  onOpenPromptCost: (promptIdx: number) => void;
}) {
  const unit = useUnit();
  const liveEmpty = session.live && (session.timeline?.length ?? 0) === 0;
  const [selectedPrompt, setSelectedPrompt] = useState<number | null>(null);
  const prompts = session.prompts ?? [];
  const toolSeq = session.toolSequence ?? [];
  const stats: PromptStats[] = session.turns && prompts.length > 0
    ? aggregateByPrompt(session.turns, session.model, prompts)
    : [];
  // each prompt's weight and share, both in the usage unit
  const weights = promptWeights(stats.map((s) => ({ fresh: freshTokens(s.tokens), cost: s.cost })), unit);
  const fmt = (v: number) => (unit === "tokens" ? formatTokens(v) : formatCost(v));
  const unitLabel = unit === "tokens" ? "fresh tokens" : "API value";
  const totalVal = weights.reduce((a, w) => a + w.value, 0);
  const maxPromptT = prompts.reduce((a, p) => Math.max(a, p.t), 0);
  const effDurationMs = Math.max(session.durationMs, maxPromptT, 1);
  const durationMin = effDurationMs / 60_000;
  // calls made while each prompt ran, sub-agent calls included
  const promptTools = callsPerPrompt(toolSeq, prompts);

  if (liveEmpty) {
    return (
      <div className="live-empty">
        <div className="live-empty-dot"><span className="live-dot" /></div>
        <div className="live-empty-title">Session in progress</div>
        <div className="live-empty-text mono dim">
          Running for {Math.max(1, Math.round(durationMin))}m · summary and timeline populate on exit.
        </div>
      </div>
    );
  }

  const sel = selectedPrompt !== null && prompts[selectedPrompt] ? selectedPrompt : null;

  return (
    <div className="overview-grid">
      <div className="overview-main">
        <SessionKpis session={session} onOpen={onOpen} />
        <div className="d-panel">
          <div className="section-title">
            <span>
              Prompts <InfoDot title={`One bar per prompt: its ${unitLabel}, sub-agents included, and the tool calls it led to. The colour is its costliest kind (by API value). Click a bar for the prompt.`} />
            </span>
            <span className="dim tabular">
              {prompts.length} prompt{prompts.length === 1 ? "" : "s"}
              {totalVal > 0 && ` · ${fmt(totalVal)} ${unitLabel}`}
            </span>
          </div>
          {stats.length === 0 ? (
            <div className="placeholder">No usage captured for its prompts.</div>
          ) : (() => {
            const maxVal = Math.max(1e-9, ...weights.map((w) => w.value));
            return (
              <>
                <div className="prompt-chart-wrap">
                  <div className="prompt-chart-axis">
                    <span className="mono dim tabular">{fmt(maxVal)}</span>
                    <span className="mono dim tabular">0</span>
                  </div>
                  <div className="prompt-chart">
                    {stats.map((s, i) => {
                      const heightPct = (weights[i].value / maxVal) * 100;
                      const isSelected = sel === i;
                      const showGap = i > 0 && s.gapBeforeMs >= SESSION_IDLE_GAP_MS;
                      const tc = promptTools[i];
                      return (
                        <div key={i} className="prompt-bar-slot">
                          {showGap && (
                            <span
                              className={`prompt-gap-marker ${s.cacheRewriteFlag ? "warn" : ""}`}
                              title={`${formatDuration(s.gapBeforeMs)} idle before #${i + 1}${s.cacheRewriteFlag ? ", then the cache was rewritten" : ""}`}
                              aria-hidden="true"
                            />
                          )}
                          <button
                            className={`prompt-bar kind-${KIND_CLS[s.dominantKind]} ${isSelected ? "pinned" : ""}`}
                            style={{ height: `${Math.max(1.5, heightPct)}%` }}
                            onClick={() => setSelectedPrompt((p) => (p === i ? null : i))}
                            aria-label={`Prompt ${i + 1}`}
                            aria-pressed={isSelected}
                            title={`#${i + 1} · ${fmt(weights[i].value)} ${unitLabel}${showGap ? ` · ${formatDuration(s.gapBeforeMs)} idle before` : ""} · ${tc} tool call${tc === 1 ? "" : "s"}`}
                          >
                            {tc > 0 && <span className="prompt-bar-turn-badge tabular">{tc}</span>}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="prompt-chart-x mono dim tabular">
                    <span>{stats[0] ? formatClockAt(session.startedAt, stats[0].t, { seconds: false }) : ""}</span>
                    <span>{stats[Math.floor(stats.length / 2)] ? formatClockAt(session.startedAt, stats[Math.floor(stats.length / 2)].t, { seconds: false }) : ""}</span>
                    <span>{stats[stats.length - 1] ? formatClockAt(session.startedAt, stats[stats.length - 1].t, { seconds: false }) : ""}</span>
                  </div>
                </div>
                <div className="prompt-legend mono dim" style={{ marginTop: 10 }}>
                  <span className="dim">costliest kind:</span>
                  <span className="prompt-legend-item"><span className="prompt-legend-swatch tokens-seg output" /> output</span>
                  <span className="prompt-legend-item"><span className="prompt-legend-swatch tokens-seg cache-read" /> cache read</span>
                  <span className="prompt-legend-item"><span className="prompt-legend-swatch tokens-seg cache-write" /> cache write</span>
                  <span className="prompt-legend-item"><span className="prompt-legend-swatch tokens-seg input" /> input</span>
                </div>
              </>
            );
          })()}
          {sel !== null && (() => {
            const p = prompts[sel];
            const kind = classifyPrompt(p.text);
            const tc = promptTools[sel];
            const w = weights[sel];
            return (
              <div className="prompt-card">
                <div className="prompt-card-head">
                  <span className="mono dim">
                    #{sel + 1} · {formatClockAt(session.startedAt, p.t)} ·{" "}
                    <span style={{ color: PROMPT_KIND_COLOR[kind] }}>{PROMPT_KIND_LABEL[kind]}</span>
                  </span>
                  <button className="prompt-panel-close" onClick={() => setSelectedPrompt(null)} aria-label="Close the prompt">✕</button>
                </div>
                {w && (
                  <div className="prompt-card-weight tabular">
                    <b>{fmt(w.value)}</b> {unitLabel}
                    <span className="dim"> · {(w.share * 100).toFixed(1)}% of the session's {unitLabel}</span>
                  </div>
                )}
                <div className="prompt-card-links">
                  {tc > 0 && (
                    <button className="preview-more" onClick={() => onFocusTools(sel, p.t, prompts[sel + 1]?.t ?? Infinity)}>
                      {tc} tool call{tc === 1 ? "" : "s"} →
                    </button>
                  )}
                  {stats[sel] && (
                    <button className="preview-more" onClick={() => onOpenPromptCost(sel)}>
                      Tokens and API value per kind →
                    </button>
                  )}
                </div>
                <pre className="prompt-panel-body">{p.text}</pre>
              </div>
            );
          })()}
        </div>
      </div>
      <div className="overview-rail">
        {session.frictions.length > 0 ? (
          <FrictionsCard session={session} onOpen={onOpen} />
        ) : session.outcome === "unknown" || session.outcome === "in_progress" ? (
          <div className="clean-row dim">
            {session.agent === "codex" || session.agent === "copilot" ? "Frictions not analyzed · /insights only covers Claude Code" : "Frictions not analyzed yet · run /insights in Claude Code"}
          </div>
        ) : (
          <div className="clean-row">
            <span style={{ color: "var(--c-green)" }}>✓</span> Clean session · no friction detected
          </div>
        )}
        <TabPreviews session={session} onOpen={onOpen} />
      </div>
    </div>
  );
}

function ToolsTab({
  session,
  focus,
  onClearFocus,
  focusSubagent,
}: {
  session: Session;
  focus: { promptIdx: number; start: number; end: number } | null;
  onClearFocus: () => void;
  /** A sub-agent picked on Now: the call that started it opens onto its calls, scrolled into view once. */
  focusSubagent: string | null;
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const focusRef = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!focusSubagent || scrolledTo.current === focusSubagent || !focusRef.current) return;
    focusRef.current.scrollIntoView({ block: "start" });
    scrolledTo.current = focusSubagent;
  });
  const sortedTools = (Object.entries(session.toolCounts) as Array<[ToolName, number]>)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);
  const maxTool = Math.max(...sortedTools.map(([, v]) => v), 1);
  const all = session.toolSequence ?? [];
  const total = countCalls(all);
  const inFocus = focus ? callsBetween(all, focus.start, focus.end) : all;
  const failed = countFailed(inFocus);
  const subCalls = countSubCalls(inFocus);
  const shown = failedOnly && failed > 0 ? onlyFailed(inFocus) : inFocus;
  // newest first; the newest call of a live session may still be running
  const sequence = [...shown].reverse();
  const truncated = all.length >= 300;

  // the calls in order on the left; their count per tool in a card on the right (above it on narrow screens)
  return (
    <div className="overview-grid tools-grid">
      <div className="overview-main">
        <div className="d-panel tools-tab">
          <div className="section-title">
            <span>
              Tool calls <InfoDot title="Every tool call of the session, newest first, with its result size: a call that started a sub-agent holds the sub-agent's calls. Click a row to expand its input and result. The By tool card counts the calls per tool." />
            </span>
            <span className="tools-head-meta">
              <span className="dim tabular">
                {focus ? `${countCalls(inFocus)} of ${total} calls` : `${total} calls`}
                {subCalls > 0 && ` · ${subCalls} in sub-agents`}
              </span>
              {failed > 0 && (
                <span className="seg" role="group" aria-label="Show">
                  <button className={`tool-view-btn ${failedOnly ? "" : "active"}`} onMouseDown={keepFocus} onClick={() => setFailedOnly(false)} aria-pressed={!failedOnly}>
                    All
                  </button>
                  <button className={`tool-view-btn ${failedOnly ? "active" : ""}`} onMouseDown={keepFocus} onClick={() => setFailedOnly(true)} aria-pressed={failedOnly}>
                    Failed <span className="tools-failed-n tabular">{failed}</span>
                  </button>
                </span>
              )}
            </span>
          </div>
          {focus && (
            <div className="tools-focus-chip mono">
              <span>
                Showing tools after prompt <strong>#{focus.promptIdx + 1}</strong>
                <span className="dim">
                  {" "}· {formatClockAt(session.startedAt, focus.start)}
                  {focus.end !== Infinity && ` → ${formatClockAt(session.startedAt, focus.end)}`}
                </span>
              </span>
              <button className="tools-focus-clear" onClick={onClearFocus} aria-label="Show all tools">
                show all ✕
              </button>
            </div>
          )}
          {sequence.length === 0 ? (
            <div className="placeholder">No tool sequence available. The By tool card has the counts.</div>
          ) : (
            <div className="tool-sequence">
              {sequence.map((s, i) => {
                const picked = !!focusSubagent && s.subagentId === focusSubagent;
                return (
                  <ToolSeqRow
                    key={`${s.t}-${i}`}
                    entry={s}
                    startedAt={session.startedAt}
                    pending={!!session.live && i === 0 && !s.result && !s.orphan && !failedOnly}
                    openSub={failedOnly || picked}
                    rowRef={picked ? focusRef : undefined}
                  />
                );
              })}
              {truncated && (
                <div className="mono dim" style={{ padding: "8px 10px", fontSize: "var(--fs-sm)" }}>
                  (later tool calls truncated — showing the first 300 of each transcript)
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="overview-rail">
        <div className="d-panel preview">
          <div className="preview-head">
            <span className="preview-title">By tool</span>
            <span className="preview-meta mono tabular">{total} calls</span>
          </div>
          {sortedTools.length === 0 ? (
            <div className="preview-note mono dim">No tool calls.</div>
          ) : (
            <div className="preview-bars">
              {sortedTools.map(([name, count]) => (
                <div key={name} className="preview-bar-row">
                  <span className="mono preview-bar-name" title={name}>{name}</span>
                  <span className="preview-bar-track"><span style={{ width: `${(count / maxTool) * 100}%` }} /></span>
                  <span className="mono tabular preview-bar-n">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One call. A call that started a sub-agent opens onto the sub-agent's calls, nested under it. */
function ToolSeqRow({
  entry,
  startedAt,
  pending,
  openSub = false,
  rowRef,
}: {
  entry: ToolCall;
  startedAt: string;
  pending?: boolean;
  /** Start with the sub-agent's calls shown (the failed-only view, a sub-agent picked on Now). */
  openSub?: boolean;
  /** Set on the row of a sub-agent picked on Now. */
  rowRef?: Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(openSub);
  const hasResult = !!entry.result;
  const hasFull = !!entry.full;
  const expandable = hasResult || hasFull;
  const isError = !!entry.result?.isError;
  const resultOneLine = entry.result?.text.replace(/\s+/g, " ").trim() ?? "";
  const status = entry.orphan ? "sub-agent" : pending ? "running" : isError ? "error" : hasResult ? "ok" : "no result";
  const kids = entry.children ?? [];
  const kidsFailed = kids.filter((c) => c.result?.isError).length;
  // newest first, like the calls around them; the newest one runs while its sub-agent does
  const kidsShown = [...kids].reverse();
  return (
    <div ref={rowRef} className={`tool-seq-row ${expandable ? "has-result" : ""} ${open ? "open" : ""} ${pending ? "pending" : ""} ${entry.orphan ? "orphan" : ""} ${rowRef ? "picked" : ""}`}>
      <button
        className="tool-seq-main"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
        aria-label={expandable ? (open ? "Collapse tool details" : "Expand tool details") : undefined}
        title={entry.orphan ? "A sub-agent whose starting call isn't in the transcript" : undefined}
      >
        <span className="tool-seq-time mono dim tabular">{formatClockAt(startedAt, entry.t)}</span>
        <span className={`tool-seq-status ${pending ? "run" : isError ? "err" : hasResult ? "ok" : ""}`} title={status} aria-label={status}>
          {pending ? "▶" : isError ? "✗" : hasResult ? "✓" : "·"}
        </span>
        <span className="tool-seq-name mono" title={entry.tool}>{entry.orphan ? "Sub-agent" : entry.tool}</span>
        <span className="tool-seq-preview mono dim">{entry.preview}</span>
        <span className="tool-seq-size">
          {entry.result?.bytes != null && entry.result.bytes > 0 && (
            <span
              className={`result-size-chip mono tabular ${entry.result.bytes > 30_000 ? "hot" : entry.result.bytes > 8_000 ? "warm" : ""}`}
              title="Size of the tool result sent back to the model"
            >
              {formatBytes(entry.result.bytes)}
            </span>
          )}
        </span>
        <span className="tool-seq-toggle mono dim" aria-hidden="true">{expandable ? (open ? "▾" : "▸") : ""}</span>
      </button>
      {open && (
        <pre className="tool-seq-command mono">{entry.full ?? entry.preview}</pre>
      )}
      {hasResult && open && (
        <pre className={`tool-seq-result mono ${isError ? "is-error" : ""}`}>
          {entry.result!.text}
          {entry.result!.truncated && <span className="dim"> …</span>}
        </pre>
      )}
      {/* successes stay one line; failures show why */}
      {isError && !open && (
        <div className="tool-seq-result-hint mono">
          {resultOneLine.slice(0, 140)}{resultOneLine.length > 140 ? "…" : ""}
        </div>
      )}
      {kids.length > 0 && (
        <>
          <button className="tool-seq-sub-toggle mono" onClick={() => setSubOpen((v) => !v)} aria-expanded={subOpen}>
            <span aria-hidden="true">{subOpen ? "▾" : "▸"}</span>
            {" "}{kids.length} call{kids.length === 1 ? "" : "s"} in the sub-agent
            {entry.agentLabel && <span className="dim"> · {entry.agentLabel}</span>}
            {kidsFailed > 0 && <span className="tool-seq-sub-failed"> · {kidsFailed} failed</span>}
          </button>
          {subOpen && (
            <div className="tool-seq-children">
              {kidsShown.map((c, i) => (
                <ToolSeqRow key={`${c.t}-${i}`} entry={c} startedAt={startedAt} pending={pending && i === 0 && !c.result} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Cache writes at the 5-minute rate, except the 1-hour share (2x input) when known. */
function cacheWriteCost(p: ModelPrice, t: { cacheWrite: number; cacheWrite1h?: number }) {
  const oneHour = Math.min(t.cacheWrite, t.cacheWrite1h ?? 0);
  return ((t.cacheWrite - oneHour) * p.cacheWrite + oneHour * p.cacheWrite1h) / 1e6;
}

function costPerKind(model: string, tokens: Session["tokens"]) {
  const p = priceFor(model);
  return {
    input: (tokens.input / 1e6) * p.in,
    output: (tokens.output / 1e6) * p.out,
    cacheRead: (tokens.cacheRead / 1e6) * p.cacheRead,
    cacheWrite: cacheWriteCost(p, tokens),
  };
}

/** Per-kind cost priced turn by turn with each turn's model, so it adds up to costUsd. */
function sessionCostPerKind(session: Session) {
  if (!session.turns?.length) return costPerKind(session.model, session.tokens);
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of session.turns) {
    const c = costPerKind(t.model ?? session.model, t.tokens);
    out.input += c.input;
    out.output += c.output;
    out.cacheRead += c.cacheRead;
    out.cacheWrite += c.cacheWrite;
  }
  return out;
}

const ratio = (n: number) => `${Number(n.toFixed(3))}×`;

/** Token-kind explanations with this model's actual price ratios (scripts/models.mjs). */
function tokenInfo(model: string): Record<string, string> {
  const p = priceFor(model);
  const name = modelLabel(model);
  return {
    input: `Fresh input tokens billed at the full input rate ($${p.in}/MTok on ${name}): new prompts, context not yet cached.`,
    output: `Tokens Claude generates, billed at ${ratio(p.out / p.in)} the input rate on ${name}. Long assistant turns inflate this.`,
    cacheRead: `Tokens served from the prompt cache, billed at ${ratio(p.cacheRead / p.in)} the input rate on ${name}. High cache read = prior context reused efficiently.`,
    cacheWrite: `Tokens written to the prompt cache: ${ratio(p.cacheWrite / p.in)} the input rate for the 5-minute cache, ${ratio(p.cacheWrite1h / p.in)} for the 1-hour cache. Pays off on later cache reads.`,
  };
}

function InfoDot({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const POP_W = 300;
      let left = btn.getBoundingClientRect().left;
      if (left + POP_W > window.innerWidth - 16) left = window.innerWidth - POP_W - 16;
      setPos({ top: popoverTop(btn, 6), left });
    };
    updatePos();
    const onClick = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let App's Escape handler close the session view as well.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="info-dot"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open}
        aria-label="Show explanation"
      >ⓘ</button>
      {open && pos && (
        <div
          ref={popRef}
          className="info-popover"
          role="dialog"
          style={{ top: pos.top, left: pos.left }}
        >
          {title}
        </div>
      )}
    </>
  );
}

/** Where a link from the Overview lands in the Tokens tab: the By kind section, or one prompt's detail. */
type TokensFocus = { section: "kind" } | { section: "prompt"; idx: number };

/** Where the tokens and their API value went: by kind (with the cache), then by prompt. */
function TokensTab({ session, focus, onFocusDone }: { session: Session; focus: TokensFocus | null; onFocusDone: () => void }) {
  const unit = useUnit();
  const allTokens =
    session.tokens.input +
    session.tokens.output +
    session.tokens.cacheRead +
    session.tokens.cacheWrite;

  const costs = sessionCostPerKind(session);
  const totalCost = session.costUsd;
  const baseline = session.baselineCostUsd ?? totalCost;
  const savings = Math.max(0, baseline - totalCost);
  const savingsPct = baseline > 0 ? (savings / baseline) * 100 : 0;

  const hit = cacheHit(session.tokens);
  const promptCount = session.prompts?.length ?? 0;
  const costPerPrompt = promptCount > 0 ? totalCost / promptCount : 0;

  type Kind = "input" | "output" | "cacheRead" | "cacheWrite";
  const rows: Array<{ key: Kind; label: string; cls: string; tokens: number; cost: number }> = [
    { key: "input", label: "input", cls: "input", tokens: session.tokens.input, cost: costs.input },
    { key: "output", label: "output", cls: "output", tokens: session.tokens.output, cost: costs.output },
    { key: "cacheRead", label: "cache read", cls: "cache-read", tokens: session.tokens.cacheRead, cost: costs.cacheRead },
    { key: "cacheWrite", label: "cache write", cls: "cache-write", tokens: session.tokens.cacheWrite, cost: costs.cacheWrite },
  ];

  const pct = (v: number, t: number) => (t > 0 ? (v / t) * 100 : 0);
  const hitTone = hit >= 0.9 ? "green" : hit >= 0.4 ? undefined : "red";
  const estimated = session.unpricedModels?.length ? "~" : "";

  // a link from the Overview to By kind: scroll there, once (a link to a prompt is By prompt's to handle)
  const kindRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus?.section !== "kind") return;
    kindRef.current?.scrollIntoView({ block: "start" });
    onFocusDone();
  }, [focus, onFocusDone]);

  return (
    <>
      <KpiRow
        items={[
          {
            label: "API value",
            value: `${estimated}${formatCost(totalCost)}`,
            sub: baseline > totalCost ? `${formatCost(baseline)} without cache` : "public per-token prices",
            title: session.unpricedModels?.length ? estimateHint(session.unpricedModels) : "Public per-token pricing for this session's models. Excludes batch discounts and negotiated rates.",
          },
          {
            label: "Cache hit",
            value: `${(hit * 100).toFixed(1)}%`,
            sub: `${formatTokens(session.tokens.cacheRead)} of ${formatTokens(inputTokens(session.tokens))} input tokens`,
            tone: hitTone,
            title: "cacheRead / (input + cacheRead + cacheWrite): input served from the prompt cache instead of read fresh (a cache write is read fresh too). Aim for 90% or more.",
          },
          {
            label: "Cache savings",
            value: formatCost(savings),
            sub: `${savingsPct.toFixed(0)}% off the API value without cache`,
            tone: savings > 0 ? "green" : undefined,
            title: "API value vs every cached token billed as fresh input: what the prompt cache is worth here.",
          },
          {
            label: "Per prompt",
            value: promptCount > 0 ? formatCost(costPerPrompt) : "—",
            sub: promptCount > 0 ? `API value ÷ ${promptCount} user prompts` : "no prompts captured",
            title: "API value ÷ user prompts: a rough weight of each turn, inflated by tool-heavy turns and long replies.",
          },
        ]}
      />

      <div className="d-panel" ref={kindRef}>
        <div className="section-title">
          <span>
            By kind <InfoDot title="Tokens and API value per kind. They differ: cache reads are cheap, output costs several times input, so the API value is often dominated by output and cache writes even when cache reads dominate the tokens." />
          </span>
          <span className="dim tabular">{formatTokens(allTokens)} tokens in all · {estimated}{formatCost(totalCost)} API value</span>
        </div>
        <div className="tokens-bars">
          {([["Tokens", "tokens"], ["API value", "cost"]] as const).map(([label, field]) => (
            <div key={field} className="tokens-bars-row">
              <span className="tokens-bars-label">{label}</span>
              <div className="tokens-bar" aria-label={`${label} by token kind`}>
                {rows.map((r) => (
                  <div
                    key={r.key}
                    className={`tokens-seg ${r.cls}`}
                    style={{ flex: r[field] || 0.0001 }}
                    title={`${r.label}: ${field === "tokens" ? `${formatTokens(r.tokens)} tokens` : `${formatCost(r.cost)} API value`} (${pct(r[field], field === "tokens" ? allTokens : totalCost).toFixed(1)}%)`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="tokens-table">
          <div className="tokens-table-head">
            <span />
            <span>Kind</span>
            <span className="tabular right">Tokens</span>
            <span className="tabular right">Share</span>
            <span className="tabular right">API value</span>
            <span className="tabular right">Share</span>
          </div>
          {rows.map((r) => (
            <div key={r.key} className="tokens-table-row">
              <span className={`swatch ${r.cls}`} />
              <span>
                {r.label} <InfoDot title={tokenInfo(session.model)[r.key]} />
              </span>
              <span className="tabular mono right">{formatTokens(r.tokens)}</span>
              <span className="tabular mono dim right">{pct(r.tokens, allTokens).toFixed(1)}%</span>
              <span className="tabular mono right">{formatCost(r.cost)}</span>
              <span className="tabular mono dim right">{pct(r.cost, totalCost).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>

      <TokensByPrompt
        session={session}
        unit={unit}
        openIdx={focus?.section === "prompt" ? focus.idx : null}
        onOpened={onFocusDone}
      />
    </>
  );
}

/** Each prompt's fresh tokens and API value, its share, its costliest kind and idle cache rewrite; a row opens its detail. */
function TokensByPrompt({ session, unit, openIdx, onOpened }: { session: Session; unit: Unit; openIdx: number | null; onOpened: () => void }) {
  const prompts = session.prompts ?? [];
  const stats = session.turns && prompts.length > 0 ? aggregateByPrompt(session.turns, session.model, prompts) : [];
  const weights = promptWeights(stats.map((s) => ({ fresh: freshTokens(s.tokens), cost: s.cost })), unit);
  // a link from the Overview opens the tab on that prompt: it starts open, and is brought into view
  const [open, setOpen] = useState<number | null>(openIdx);
  const [heaviest, setHeaviest] = useState(false);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    if (openIdx === null) return;
    rowRefs.current.get(openIdx)?.scrollIntoView({ block: "center" });
    onOpened();
  }, [openIdx, onOpened]);

  if (stats.length === 0) return null;
  const rewrites = stats.filter((s) => s.cacheRewriteFlag);
  const rewriteCost = rewrites.reduce((a, s) => a + (s.cacheRewriteFlag?.cacheWriteCost ?? 0), 0);
  const order = stats.map((_, i) => i);
  if (heaviest) order.sort((a, b) => weights[b].value - weights[a].value);
  const unitLabel = unit === "tokens" ? "fresh tokens" : "API value";

  return (
    <div className="d-panel tok-prompts">
      <div className="section-title">
        <span>
          By prompt <InfoDot title="What each prompt's turns used, sub-agents included. Share is of the session's fresh tokens or API value, following the usage unit. Open a prompt for its tokens and API value per kind, cache rewrites and turns." />
        </span>
        <span className="tools-head-meta">
          <span className="dim tabular">
            {stats.length} prompts
            {rewrites.length > 0 && (
              <span className="tok-rewrite-meta"> · {rewrites.length} idle cache rewrite{rewrites.length > 1 ? "s" : ""}, {formatCost(rewriteCost)} API value</span>
            )}
          </span>
          <span className="seg" role="group" aria-label="Order">
            <button className={`tool-view-btn ${heaviest ? "" : "active"}`} onMouseDown={keepFocus} onClick={() => setHeaviest(false)} aria-pressed={!heaviest}>In order</button>
            <button className={`tool-view-btn ${heaviest ? "active" : ""}`} onMouseDown={keepFocus} onClick={() => setHeaviest(true)} aria-pressed={heaviest}>Heaviest first</button>
          </span>
        </span>
      </div>
      <div className="prompt-list">
        <div className="prompt-row prompt-row-head mono dim caps">
          <span>#</span>
          <span>Time</span>
          <span className="right">Fresh tokens</span>
          <span className="right">API value</span>
          <span className="right" title={`Share of the session's ${unitLabel}`}>Share</span>
          <span>Costliest</span>
          <span />
          <span>Prompt</span>
        </div>
        {order.map((i) => {
          const s = stats[i];
          const p = prompts[i];
          const isOpen = open === i;
          const toggle = () => setOpen(isOpen ? null : i);
          return (
            <Fragment key={i}>
              <div
                ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i); }}
                className={`prompt-row ${isOpen ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle();
                  }
                }}
              >
                <span className="mono dim tabular">{String(i + 1).padStart(2, "0")}</span>
                <span className="mono dim tabular">{formatClockAt(session.startedAt, s.t)}</span>
                <span className="mono tabular right">{formatTokens(freshTokens(s.tokens))}</span>
                <span className="mono tabular right">{formatCost(s.cost)}</span>
                <span className="mono tabular right dim">{(weights[i].share * 100).toFixed(1)}%</span>
                <span className="tok-kind">
                  <span className={`swatch ${KIND_CLS[s.dominantKind]}`} aria-hidden="true" />
                  {KIND_LABEL[s.dominantKind]}
                </span>
                <span
                  className="prompt-row-warn"
                  title={s.cacheRewriteFlag ? `${formatDuration(s.cacheRewriteFlag.gapMs)} idle, then the cache was rewritten: ${formatCost(s.cacheRewriteFlag.cacheWriteCost)} API value in cache writes` : ""}
                >
                  {s.cacheRewriteFlag ? "⚠" : ""}
                </span>
                <span className="prompt-row-preview mono">{p?.preview}</span>
              </div>
              {isOpen && (
                <div className="prompt-panel">
                  <PromptCostBreakdown s={s} model={session.model} />
                  {p && <pre className="prompt-panel-body">{p.text}</pre>}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function turnCost(model: string, tokens: CostTokens) {
  return costOf(model, tokens);
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_TTL_EXTENDED_MS = 60 * 60_000;
const CACHE_REWRITE_SHARE_MIN = 0.4;
const CACHE_REWRITE_COST_MIN = 1.0;

type PromptStats = {
  promptIdx: number;
  t: number;
  endT: number;
  turnCount: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number };
  cost: number;
  tools: string[];
  dominantKind: "input" | "output" | "cacheRead" | "cacheWrite";
  gapBeforeMs: number;
  turnDetails: Array<{
    t: number;
    gapBeforeMs: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    tools: string[];
    inBytes: number;
    outBytes: number;
    inPreview: string;
    outPreview: string;
  }>;
  cacheRewriteFlag?: {
    severity: "warn" | "info";
    gapMs: number;
    cacheWriteCost: number;
    cacheWriteShare: number;
  };
};

function aggregateByPrompt(
  turns: NonNullable<Session["turns"]>,
  model: string,
  prompts: NonNullable<Session["prompts"]>,
): PromptStats[] {
  const stats: PromptStats[] = prompts.map((p, i) => ({
    promptIdx: i,
    t: p.t,
    endT: prompts[i + 1]?.t ?? Infinity,
    turnCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    cost: 0,
    tools: [],
    dominantKind: "input",
    gapBeforeMs: 0,
    turnDetails: [],
  }));
  const lastTurnTByPrompt: number[] = prompts.map((p) => p.t);
  const prevTurnTByPrompt: number[] = prompts.map(() => -1);
  for (const tn of turns) {
    if (tn.promptIdx === undefined) continue;
    const s = stats[tn.promptIdx];
    if (!s) continue;
    s.turnCount++;
    s.tokens.input += tn.tokens.input;
    s.tokens.output += tn.tokens.output;
    s.tokens.cacheRead += tn.tokens.cacheRead;
    s.tokens.cacheWrite += tn.tokens.cacheWrite;
    s.tokens.cacheWrite5m += tn.tokens.cacheWrite5m ?? 0;
    s.tokens.cacheWrite1h += tn.tokens.cacheWrite1h ?? 0;
    s.cost += turnCost(tn.model ?? model, tn.tokens);
    for (const t of tn.tools) s.tools.push(t);
    const prevT = prevTurnTByPrompt[tn.promptIdx] >= 0 ? prevTurnTByPrompt[tn.promptIdx] : s.t;
    s.turnDetails.push({
      t: tn.t,
      gapBeforeMs: Math.max(0, tn.t - prevT),
      input: tn.tokens.input,
      output: tn.tokens.output,
      cacheRead: tn.tokens.cacheRead,
      cacheWrite: tn.tokens.cacheWrite,
      cacheWrite5m: tn.tokens.cacheWrite5m ?? 0,
      cacheWrite1h: tn.tokens.cacheWrite1h ?? 0,
      tools: tn.tools,
      inBytes: tn.inBytes ?? 0,
      outBytes: tn.outBytes ?? 0,
      inPreview: tn.inPreview ?? "",
      outPreview: tn.outPreview ?? "",
    });
    prevTurnTByPrompt[tn.promptIdx] = tn.t;
    if (tn.t > lastTurnTByPrompt[tn.promptIdx]) lastTurnTByPrompt[tn.promptIdx] = tn.t;
  }
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const p = priceFor(model);
    const contrib = {
      input: (s.tokens.input / 1e6) * p.in,
      output: (s.tokens.output / 1e6) * p.out,
      cacheRead: (s.tokens.cacheRead / 1e6) * p.cacheRead,
      cacheWrite: cacheWriteCost(p, s.tokens),
    } as const;
    let max: PromptStats["dominantKind"] = "output";
    let maxV = -1;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (contrib[k] > maxV) { maxV = contrib[k]; max = k; }
    }
    s.dominantKind = max;

    if (i > 0) {
      s.gapBeforeMs = Math.max(0, s.t - lastTurnTByPrompt[i - 1]);
      const cwShare = s.cost > 0 ? contrib.cacheWrite / s.cost : 0;
      if (
        s.gapBeforeMs >= CACHE_TTL_MS &&
        cwShare >= CACHE_REWRITE_SHARE_MIN &&
        s.cost >= CACHE_REWRITE_COST_MIN
      ) {
        s.cacheRewriteFlag = {
          severity: s.gapBeforeMs >= CACHE_TTL_EXTENDED_MS ? "warn" : "info",
          gapMs: s.gapBeforeMs,
          cacheWriteCost: contrib.cacheWrite,
          cacheWriteShare: cwShare,
        };
      }
    }
  }
  return stats;
}


const KIND_CLS: Record<PromptStats["dominantKind"], string> = {
  input: "input",
  output: "output",
  cacheRead: "cache-read",
  cacheWrite: "cache-write",
};
const KIND_LABEL: Record<PromptStats["dominantKind"], string> = {
  input: "input",
  output: "output",
  cacheRead: "cache read",
  cacheWrite: "cache write",
};

function PromptCostBreakdown({ s, model }: { s: PromptStats; model: string }) {
  const pr = priceFor(model);
  const rows: Array<{ key: "input" | "output" | "cacheRead" | "cacheWrite"; label: string; cls: string; val: number; cost: number }> = [
    { key: "input",      label: "input",  cls: "input",       val: s.tokens.input,      cost: (s.tokens.input / 1e6) * pr.in },
    { key: "output",     label: "output", cls: "output",      val: s.tokens.output,     cost: (s.tokens.output / 1e6) * pr.out },
    { key: "cacheRead",  label: "cache read", cls: "cache-read",  val: s.tokens.cacheRead,  cost: (s.tokens.cacheRead / 1e6) * pr.cacheRead },
    { key: "cacheWrite", label: "cache write", cls: "cache-write", val: s.tokens.cacheWrite, cost: cacheWriteCost(pr, s.tokens) },
  ];
  return (
    <div className="prompt-cost-panel-body">
      <div className="prompt-cost-panel-grid">
        {rows.map((r) => {
          const isDom = r.key === s.dominantKind;
          return (
            <div key={r.key} className={`prompt-cost-panel-cell ${isDom ? "dominant" : ""}`}>
              <span className={`swatch ${r.cls}`} />
              <span className="dim">{r.label}</span>
              <span className="tabular mono">{formatTokens(r.val)}</span>
              <span className="tabular mono prompt-cost-panel-cell-usd" title={`$${r.cost.toFixed(4)} API value`}>
                {formatCost(r.cost)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="prompt-cost-panel-note mono dim">
        costliest kind = the highest API value, not the most tokens (on {modelLabel(model)}, a cache write costs{" "}
        {ratio(pr.cacheWrite / pr.cacheRead)} a cache read).
      </div>
      {s.cacheRewriteFlag && (
        <div className={`prompt-cost-warn kind-${s.cacheRewriteFlag.severity}`}>
          <span className="prompt-cost-warn-icon">{s.cacheRewriteFlag.severity === "warn" ? "⚠" : "ℹ"}</span>
          <div>
            <div className="prompt-cost-warn-title">
              Cache rewritten after {formatDuration(s.cacheRewriteFlag.gapMs)} idle:{" "}
              <strong className="tabular">{formatCost(s.cacheRewriteFlag.cacheWriteCost)}</strong> API value in cache writes
              {" ("}{(s.cacheRewriteFlag.cacheWriteShare * 100).toFixed(0)}% of this prompt's API value).
            </div>
            <div className="prompt-cost-warn-detail">
              The prompt cache expires (5 min, or 1 h for the extended cache). Resuming after that re-uploads the context as a fresh
              cache write, {ratio(pr.cacheWrite / pr.cacheRead)} the price of a cache read on {modelLabel(model)}.
            </div>
            <div className="prompt-cost-warn-recommend">
              Avoid: <code>/clear</code> before unrelated work, or start a new session when prior context isn't needed.
            </div>
          </div>
        </div>
      )}
      {s.tokens.cacheWrite > 0 && (
        <div className="prompt-cost-cw-split mono dim">
          cache writes:
          {" "}
          <span className="tabular">{formatTokens(s.tokens.cacheWrite1h)}</span> in the 1h block
          {" · "}
          <span className="tabular">{formatTokens(s.tokens.cacheWrite5m)}</span> in the 5m block
          {" "}
          <InfoDot title="Anthropic prompt cache has two TTL tiers. 1h block = system prompt, tools, memory (the long-lived prefix). 5m block = recent conversation. Writes to the 1h block usually mean the system block changed (new tool, hook, env var) or the 1h TTL expired. Writes to the 5m block are normal when conversation extends past the previous breakpoint or 5m idle elapsed." />
        </div>
      )}
      {s.turnDetails.length > 1 && (
        <TurnBreakdown details={s.turnDetails} />
      )}
    </div>
  );
}

function TurnBreakdown({ details }: { details: PromptStats["turnDetails"] }) {
  const [open, setOpen] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const cacheWTurns = details.filter((t) => t.cacheWrite > 0).length;
  const totalIn = details.reduce((a, d) => a + d.inBytes, 0);
  const totalOut = details.reduce((a, d) => a + d.outBytes, 0);
  return (
    <div className="turn-breakdown">
      <button
        type="button"
        className="turn-breakdown-toggle mono dim"
        onClick={() => setOpen((p) => !p)}
      >
        {open ? "▾" : "▸"} per-turn breakdown · {details.length} turns
        {cacheWTurns > 0 && `, ${cacheWTurns} with cache writes`}
        {totalIn + totalOut > 0 && ` · added ${formatBytes(totalIn)} in / ${formatBytes(totalOut)} out`}
      </button>
      {open && (
        <div className="turn-breakdown-table">
          <div className="turn-breakdown-head mono dim caps">
            <span>#</span>
            <span className="right">Gap</span>
            <span className="right">In</span>
            <span className="right">Out</span>
            <span className="right">Cache read</span>
            <span className="right">Cache write</span>
            <span className="right">1h</span>
            <span className="right">5m</span>
            <span>Tools</span>
          </div>
          {details.map((d, i) => {
            const hasCw = d.cacheWrite > 0;
            const has1h = d.cacheWrite1h > 0;
            const isOpen = expandedIdx === i;
            return (
              <div key={i} className={`turn-breakdown-row-wrap ${isOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className={`turn-breakdown-row mono ${hasCw ? "has-cw" : ""} ${isOpen ? "open" : ""}`}
                  title={has1h ? "1h block rewritten — system/tools/memory changed or 1h TTL expired" : "Click to see what was added this turn"}
                  onClick={() => setExpandedIdx((p) => (p === i ? null : i))}
                >
                  <span className="dim tabular">#{i + 1}</span>
                  <span className="dim tabular right">{d.gapBeforeMs > 0 ? formatDuration(d.gapBeforeMs) : "—"}</span>
                  <span className="tabular right">{formatBytes(d.inBytes)}</span>
                  <span className="tabular right">{formatBytes(d.outBytes)}</span>
                  <span className="tabular right">{formatTokens(d.cacheRead)}</span>
                  <span className={`tabular right ${hasCw ? "turn-cw-hot" : "dim"}`}>{formatTokens(d.cacheWrite)}</span>
                  <span className={`tabular right ${has1h ? "turn-cw-hot" : "dim"}`}>{formatTokens(d.cacheWrite1h)}</span>
                  <span className="tabular right dim">{formatTokens(d.cacheWrite5m)}</span>
                  <span className="dim turn-breakdown-tools">{d.tools.join(", ") || "—"}</span>
                </button>
                {isOpen && (
                  <div className="turn-breakdown-expand mono">
                    {d.inPreview && (
                      <div className="turn-expand-block">
                        <div className="turn-expand-label caps dim">added to context · {formatBytes(d.inBytes)}</div>
                        <div className="turn-expand-body">{d.inPreview}{d.inBytes > 200 ? "…" : ""}</div>
                      </div>
                    )}
                    {d.outPreview && (
                      <div className="turn-expand-block">
                        <div className="turn-expand-label caps dim">assistant output · {formatBytes(d.outBytes)} · in: {formatTokens(d.input)} tokens / out: {formatTokens(d.output)} tokens</div>
                        <div className="turn-expand-body">{d.outPreview}{d.outBytes > 240 ? "…" : ""}</div>
                      </div>
                    )}
                    {!d.inPreview && !d.outPreview && (
                      <div className="dim">No preview captured.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

/** The message of a `git commit -m "…"` command, else the command. */
function commitMessage(command: string): string {
  const m = /\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? command).trim();
}

/** What changed: the files Claude edited, their versions and diffs, and the commits it made. */
function FilesTab({ session }: { session: Session }) {
  const history = session.fileHistory ?? [];
  const [openHash, setOpenHash] = useState<string | null>(null);
  // the commits the session counts (main thread), from its Bash calls
  const commits = flattenCalls(session.toolSequence ?? []).filter((c) => !c.sub && c.tool === "Bash" && GIT_COMMIT_RE.test(c.full ?? c.preview));
  const totalVersions = history.reduce((a, f) => a + f.versions.length, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const meta = [
    history.length > 0 ? `${plural(history.length, "file")} · ${plural(totalVersions, "version")}` : `${session.filesChanged} changed`,
    plural(session.commits, "commit"),
  ].join(" · ");

  return (
    <div>
      <div className="section-title">
        <span>Files</span>
        <span className="dim tabular">{meta}</span>
      </div>
      {history.length === 0 ? (
        <div className="placeholder">
          No file history recorded for this session.
          <div className="mono dim" style={{ marginTop: 6 }}>
            {session.agent === "codex" ? (
              "Codex keeps no file snapshots: the count above comes from its patches."
            ) : session.agent === "copilot" ? (
              "Marey doesn't read Copilot CLI's file snapshots yet: the count above comes from its edits."
            ) : (
              <>Claude Code writes versions to <code>~/.claude/file-history/{"{sessionId}"}/</code> only when it edits files.</>
            )}
          </div>
        </div>
      ) : (
        <div className="file-list">
          {history.map((f) => (
            <FileEntry
              key={f.hash}
              sessionId={session.id}
              hash={f.hash}
              versions={f.versions}
              path={f.path}
              open={openHash === f.hash}
              onToggle={() => setOpenHash(openHash === f.hash ? null : f.hash)}
            />
          ))}
        </div>
      )}
      {commits.length > 0 && (
        <div className="files-commits">
          <div className="section-title">
            <span>Commits</span>
            <span className="dim tabular">{plural(commits.length, "commit")}</span>
          </div>
          <div className="tool-sequence">
            {commits.map((c, i) => {
              const failed = !!c.result?.isError;
              return (
                <div key={i} className="tool-seq-row">
                  <div className="tool-seq-main files-commit-row" title={c.full ?? c.preview}>
                    <span className="tool-seq-time mono dim tabular">{formatClockAt(session.startedAt, c.t)}</span>
                    <span className={`tool-seq-status ${failed ? "err" : c.result ? "ok" : ""}`} title={failed ? "the commit command failed" : "committed"}>
                      {failed ? "✗" : c.result ? "✓" : "·"}
                    </span>
                    <span className="files-commit-msg mono">{commitMessage(c.full ?? c.preview)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FileEntry({
  sessionId,
  hash,
  versions,
  path,
  open,
  onToggle,
}: {
  sessionId: string;
  hash: string;
  versions: number[];
  path?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [contents, setContents] = useState<Record<number, string> | null>(null);
  const loading = open && contents === null;

  useEffect(() => {
    if (!open || contents) return;
    let cancel = false;
    (async () => {
      const out: Record<number, string> = {};
      for (const v of versions) {
        try {
          const r = await fetch(`/api/file-history/${sessionId}/${hash}@v${v}`);
          if (r.ok) out[v] = await r.text();
        } catch {
          /* skip */
        }
      }
      if (!cancel) {
        setContents(out);
      }
    })();
    return () => { cancel = true; };
  }, [open, sessionId, hash, versions, contents]);

  const firstPreview = contents?.[versions[0]]?.split("\n").find((l) => l.trim()) ?? "";

  const basename = path ? path.split("/").pop() ?? path : null;
  const dirPath = path && basename ? path.slice(0, -basename.length).replace(/\/$/, "") : null;

  return (
    <div className={`file-entry ${open ? "open" : ""}`}>
      <button className="file-head" onClick={onToggle} title={path ?? hash}>
        <span className="file-toggle mono dim">{open ? "▾" : "▸"}</span>
        {basename ? (
          <span className="file-name mono">{basename}</span>
        ) : (
          <span className="file-hash mono">{hash.slice(0, 12)}</span>
        )}
        <span className="file-versions mono dim">{versions.length} version{versions.length > 1 ? "s" : ""}</span>
        <span className="file-preview dim">
          {dirPath ? <span className="mono">{dirPath}</span> : firstPreview.slice(0, 80)}
        </span>
      </button>
      {open && (
        <div className="file-body">
          {loading && <div className="mono dim" style={{ padding: 10 }}>loading…</div>}
          {!loading && versions.length === 1 && (
            <div className="mono dim" style={{ padding: 10 }}>
              Single version. No diff to render.
              <pre className="file-raw">{(contents?.[versions[0]] ?? "").slice(0, 4000)}</pre>
            </div>
          )}
          {!loading && versions.length > 1 &&
            versions.slice(0, -1).map((v, i) => {
              const next = versions[i + 1];
              const a = contents?.[v] ?? "";
              const b = contents?.[next] ?? "";
              const patch = createPatch(`${hash}@v${next}`, a, b, `v${v}`, `v${next}`, { context: 2 });
              return <DiffBlock key={`${v}-${next}`} patch={patch} label={`v${v} → v${next}`} />;
            })}
        </div>
      )}
    </div>
  );
}

function DiffBlock({ patch, label }: { patch: string; label: string }) {
  const lines = patch.split("\n").slice(4);
  return (
    <div className="diff-block">
      <div className="diff-label mono dim">{label}</div>
      <pre className="diff-body">
        {lines.map((l, i) => {
          const cls = l.startsWith("+") && !l.startsWith("+++") ? "add"
            : l.startsWith("-") && !l.startsWith("---") ? "del"
            : l.startsWith("@@") ? "hunk"
            : "ctx";
          return <span key={i} className={`diff-line ${cls}`}>{l + "\n"}</span>;
        })}
      </pre>
    </div>
  );
}
