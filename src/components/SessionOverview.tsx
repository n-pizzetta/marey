import { useMemo } from "react";
import type { Session } from "../types";
import { sessionCostPerKind } from "../utils/costPerKind";
import { formatClockAt, formatCost, formatDuration, formatTokens } from "../utils/format";
import { formatCredits } from "../utils/planFormat";
import { buildSessionTimeline } from "../utils/sessionTimeline";
import { countCalls, countFailed } from "../utils/toolCalls";
import { API_VALUE_HINT, freshTokens, useUnit } from "../utils/units";
import { KpiRow, type KpiItem } from "./Kpi";

/** Where an Overview summary leads: the tab (and section) that details it. */
export type OverviewLink = "timeline" | "tools" | "tokens" | "files";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Headline figures of a session, one per question the other tabs answer; each tile opens its tab.
 * Time and context → Timeline, weight → Tokens, calls → Tools.
 */
export function SessionKpis({ session, onOpen }: { session: Session; onOpen: (to: OverviewLink) => void }) {
  const unit = useUnit();
  const timeline = useMemo(() => buildSessionTimeline(session), [session]);
  const seq = session.toolSequence ?? [];
  // the parser nests sub-agent calls, so the list and the counts add up; without a list, the counts
  const toolCalls = seq.length ? countCalls(seq) : Object.values(session.toolCounts ?? {}).reduce((a, n) => a + n, 0);
  const failed = countFailed(seq);
  const fresh = freshTokens(session.tokens);
  // Copilot CLI bills AI credits against its monthly quota: the figure that matters there.
  const credits = session.agent === "copilot" && session.aiCredits != null ? ` · ${formatCredits(session.aiCredits)} AI credits` : "";
  const weight: KpiItem =
    unit === "tokens"
      ? { label: "Fresh tokens", value: formatTokens(fresh), sub: `${formatCost(session.costUsd)} API value${credits}`, title: "Input + output + cache writes; cached reads weigh far less. Open the Tokens tab for each kind and each prompt." }
      : { label: "API value", value: formatCost(session.costUsd), sub: `${formatTokens(fresh)} fresh tokens${credits}`, title: `${API_VALUE_HINT} Open the Tokens tab for each kind and each prompt.` };
  const callsSub = [failed > 0 && `${failed} failed`, session.subAgents > 0 && plural(session.subAgents, "sub-agent")].filter(Boolean).join(" · ");

  return (
    <KpiRow
      items={[
        {
          label: "Active time",
          value: formatDuration(session.durationMs),
          sub: session.wallMs && session.wallMs > session.durationMs * 1.2 ? `${formatDuration(session.wallMs)} wall-clock` : "idle gaps excluded",
          title: "Idle gaps over 5 minutes are excluded. Open the Timeline.",
          onClick: () => onOpen("timeline"),
        },
        { ...weight, onClick: () => onOpen("tokens") },
        {
          label: "Tool calls",
          value: toolCalls,
          sub: callsSub || "none failed",
          title: "Every tool call, sub-agents included. Open the Tools tab.",
          onClick: () => onOpen("tools"),
        },
        {
          label: "Peak context",
          value: timeline ? `${Math.round(timeline.peakPct)}%` : "—",
          sub: timeline
            ? `of ${formatTokens(timeline.window)}${timeline.compactions.length ? ` · ${plural(timeline.compactions.length, "compaction")}` : ""}`
            : "no turn data",
          tone: timeline && timeline.peakPct >= 85 ? "red" : timeline && timeline.peakPct >= 70 ? "amber" : undefined,
          title: "The fullest the main thread's context got. Open the Timeline.",
          onClick: () => onOpen("timeline"),
        },
      ]}
    />
  );
}

function PreviewHead({ title, meta, to, onOpen }: { title: string; meta?: string; to: OverviewLink; onOpen: (to: OverviewLink) => void }) {
  return (
    <div className="preview-head">
      <span className="preview-title">{title}</span>
      {meta ? <span className="preview-meta mono tabular">{meta}</span> : <span className="preview-meta" />}
      <button className="preview-more" onClick={() => onOpen(to)}>See all →</button>
    </div>
  );
}

const KINDS: Array<{ key: "output" | "cacheWrite" | "cacheRead" | "input"; cls: string; label: string }> = [
  { key: "output", cls: "output", label: "output" },
  { key: "cacheWrite", cls: "cache-write", label: "cache write" },
  { key: "cacheRead", cls: "cache-read", label: "cache read" },
  { key: "input", cls: "input", label: "input" },
];

/** Where the API value went, by token kind (priced turn by turn, like the Tokens tab). */
function kindShares(session: Session): Array<{ cls: string; label: string; pct: number }> {
  const cost = sessionCostPerKind(session);
  const total = Object.values(cost).reduce((a, n) => a + n, 0);
  if (total <= 0) return [];
  return KINDS.map((k) => ({ cls: k.cls, label: k.label, pct: (cost[k.key] / total) * 100 }));
}

/**
 * Small summaries of the Tools, Tokens and Files tabs, each opening its tab (Tokens on By kind). Their
 * totals are in the headline tiles already, so they show only the breakdown.
 */
export function TabPreviews({ session, onOpen }: { session: Session; onOpen: (to: OverviewLink) => void }) {
  const tools = Object.entries(session.toolCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const topTools = tools.slice(0, 5);
  const maxTool = topTools[0]?.[1] ?? 1;
  const shares = kindShares(session);
  const files = [...(session.fileHistory ?? [])].sort((a, b) => b.versions.length - a.versions.length);

  return (
    <>
      {topTools.length > 0 && (
        <div className="d-panel preview">
          <PreviewHead title="Top tools" to="tools" onOpen={onOpen} />
          <div className="preview-bars">
            {topTools.map(([name, n]) => (
              <div key={name} className="preview-bar-row">
                <span className="mono preview-bar-name">{name}</span>
                <span className="preview-bar-track"><span style={{ width: `${(n / maxTool) * 100}%` }} /></span>
                <span className="mono tabular preview-bar-n">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {shares.length > 0 && (
        <div className="d-panel preview">
          <PreviewHead title="API value by kind" to="tokens" onOpen={onOpen} />
          <div className="preview-stack" role="img" aria-label="Share of the API value by token kind">
            {shares.map((s) => (
              <span key={s.cls} className={`tokens-seg ${s.cls}`} style={{ width: `${s.pct}%` }} title={`${s.label} ${s.pct.toFixed(0)}%`} />
            ))}
          </div>
          <div className="preview-legend mono">
            {shares.filter((s) => s.pct >= 1).map((s) => (
              <span key={s.cls}><i className={`tokens-seg ${s.cls}`} />{s.label} {s.pct.toFixed(0)}%</span>
            ))}
          </div>
        </div>
      )}

      {(session.filesChanged > 0 || session.commits > 0) && (
        <div className="d-panel preview">
          <PreviewHead
            title="Files"
            meta={[
              session.filesChanged > 0 && `${session.filesChanged} changed`,
              session.commits > 0 && plural(session.commits, "commit"),
            ].filter(Boolean).join(" · ")}
            to="files"
            onOpen={onOpen}
          />
          {files.length > 0 && (
            <ul className="preview-files mono">
              {files.slice(0, 3).map((f) => (
                <li key={f.hash} title={f.path}>
                  <span className="preview-file-name">{f.path ? f.path.split("/").slice(-2).join("/") : f.hash.slice(0, 8)}</span>
                  <span className="dim tabular">{plural(f.versions.length, "version")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** Frictions flagged by /insights, at the same approximate time as on the Timeline. */
export function FrictionsCard({ session, onOpen }: { session: Session; onOpen: (to: OverviewLink) => void }) {
  const timeline = useMemo(() => buildSessionTimeline(session), [session]);
  const times = timeline?.frictions ?? [];
  return (
    <div className="d-panel friction-panel">
      <div className="section-title">
        <span>Frictions</span>
        <span className="dim mono" title="Flagged by /insights (an LLM): the count is real, the times are approximate.">
          {session.frictions.length} · ⓘ LLM
        </span>
        {timeline && (
          <button className="preview-more friction-go" onClick={() => onOpen("timeline")}>On the timeline →</button>
        )}
      </div>
      <div className="friction-list">
        {session.frictions.map((f, i) => (
          <div key={i} className="friction-item">
            <span className="dot" />
            <div>
              <div className="kind">{f.kind.replace(/_/g, " ")}</div>
              <div className="detail-text">{f.detail}</div>
            </div>
            <span className="at tabular" title="Approximate time, from /insights">
              {times[i] ? `≈ ${formatClockAt(session.startedAt, times[i].t, { seconds: false })}` : `${(f.at * 100).toFixed(0)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
