import { useState, type ReactNode } from "react";
import {
  isDismissed,
  readDismissed,
  writeDismissed,
  type Dismissed,
  type Recommendation,
  type RecKind,
  type RecommendationsPayload,
} from "../utils/recommendations";
import { formatDuration, formatRelative } from "../utils/format";
import "../recommendations.css";

interface Props {
  data: RecommendationsPayload | null;
  onSelectSession: (id: string) => void;
  /** Cards shown; the rest is one click away. */
  limit?: number;
  onSeeAll?: () => void;
  /** Home page: render nothing rather than an empty state. */
  hideWhenEmpty?: boolean;
  /** Wraps the list (a page section) only when there is something to show. */
  wrap?: (content: ReactNode) => ReactNode;
  /** "list": one line per card, for the home page; each line opens `onSeeAll`. */
  variant?: "cards" | "list";
}

const KIND_LABEL: Record<RecKind, string> = {
  setup: "Setup",
  permissions: "Permissions",
  feature: "Feature to try",
  habit: "Habit",
  recurring: "Recurring error",
};

/** `code` spans in the server's plain-text explanations. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}

const num = (n: number) => n.toLocaleString("en-US");
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Sessions in a row without it before a card fades: a fix shows within a day. */
const QUIET_SESSIONS = 10;

/** "30 sessions · last seen 2h ago": when it last happened tells whether a fix worked. */
function evidenceText(card: Recommendation): { text: string; fading: boolean } {
  const sessions = `${card.sessionCount} session${card.sessionCount > 1 ? "s" : ""}`;
  if (card.trend.last7 === 0) return { text: `${sessions} · not seen since ${shortDate(card.lastAt)}`, fading: true };
  if (card.sessionsSince >= QUIET_SESSIONS) return { text: `${sessions} · not seen in your last ${card.sessionsSince} sessions`, fading: true };
  return { text: `${sessions} · last seen ${formatRelative(card.lastAt)}`, fading: false };
}

function CopyButton({ text, label, done, primary }: { text: string; label: string; done: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard blocked: nothing to do */ }
  };
  return (
    <button className={`rec-btn ${primary ? "primary" : ""}`} onClick={copy} title={primary ? text : undefined}>
      {copied ? done : label}
    </button>
  );
}

function Card({ card, onSelectSession, onDismiss }: { card: Recommendation; onSelectSession: (id: string) => void; onDismiss: (reason: "done" | "irrelevant") => void }) {
  const [open, setOpen] = useState(false);
  const evidence = evidenceText(card);
  const action = card.action;
  // A recurring error is its own explanation: its text stays in view.
  const sampleInView = card.kind === "recurring";
  return (
    <article className={`rec-card rec-${card.kind} ${evidence.fading ? "fading" : ""}`}>
      <header className="rec-head">
        <span className="rec-kind">{KIND_LABEL[card.kind]}</span>
        <h3 className="rec-title">{inline(card.title)}</h3>
        <span className="rec-evidence tabular" title={`Last seen ${new Date(card.lastAt).toLocaleString()}`}>{evidence.text}</span>
      </header>
      <p className="rec-what">{inline(card.what)}</p>
      {sampleInView && card.sample && <pre className="rec-sample mono">{card.sample}</pre>}

      {card.rows && card.rows.length > 0 && (
        <ul className="rec-rows">
          {card.rows.map((r) => (
            <li key={r.label}>
              <span className="mono rec-row-label">{r.label}</span>
              <span className="mono tabular dim">{r.count}×</span>
              {r.protective && <span className="rec-keep" title="This stop protects you: keep it">keep</span>}
              {r.reason && <span className="dim rec-row-reason">{r.reason}</span>}
            </li>
          ))}
        </ul>
      )}

      {action && (
        <div className="rec-action">
          <p>{inline(action.text)}</p>
          {action.snippet && <pre className="rec-snippet mono">{action.snippet}</pre>}
          {(action.snippet || action.prompt || action.docs) && (
            <div className="rec-buttons">
              {action.prompt && <CopyButton text={action.prompt} label="Copy a prompt for Claude" done="Copied · paste it in Claude Code" primary />}
              {action.snippet && <CopyButton text={action.snippet} label={action.snippet.includes("\n") ? "Copy the lines" : "Copy the line"} done="Copied" />}
              {action.docs && <a className="rec-docs" href={action.docs} target="_blank" rel="noreferrer">Docs ↗</a>}
            </div>
          )}
        </div>
      )}

      <footer className="rec-foot">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide details" : "Details"}
        </button>
        <span className="rec-actions">
          <button onClick={() => onDismiss("done")} title="Hide it; it comes back if it happens again">Done</button>
          <button onClick={() => onDismiss("irrelevant")} title="Hide it; it comes back if it happens again">Not relevant</button>
        </span>
      </footer>
      {open && (
        <div className="rec-details">
          {card.details && <p className="rec-details-text">{inline(card.details)}</p>}
          {!sampleInView && card.sample && (
            <>
              <span className="rec-details-label">Latest error</span>
              <pre className="rec-sample mono">{card.sample}</pre>
            </>
          )}
          <span className="rec-details-label">{num(card.count)} times in {card.sessionCount} sessions over the last 30 days</span>
          <ul className="rec-sessions">
            {card.sessions.map((s) => (
              <li key={s.id}>
                <button onClick={() => onSelectSession(s.id)}>
                  <span className="mono rec-session-meta">{s.project} · {shortDate(s.lastAt)} · {s.waitMs ? `waited ${formatDuration(s.waitMs)}` : `${s.count}×`}</span>
                  <span className="rec-session-goal">{s.goal}</span>
                  {s.detail && card.kind !== "recurring" && <span className="rec-session-detail dim">{s.detail}</span>}
                </button>
              </li>
            ))}
            {card.sessionCount > card.sessions.length && (
              <li className="dim rec-more">and {card.sessionCount - card.sessions.length} more</li>
            )}
          </ul>
        </div>
      )}
    </article>
  );
}

/** Recommendations from scripts/recommendations.mjs, each with its evidence, its fix and the sessions behind it. */
export function Recommendations({ data, onSelectSession, limit, onSeeAll, hideWhenEmpty, wrap = (c) => c, variant = "cards" }: Props) {
  const [dismissed, setDismissed] = useState<Dismissed>(readDismissed);
  const [showHidden, setShowHidden] = useState(false);
  if (!data) return null;

  const visible = data.cards.filter((c) => !isDismissed(c, dismissed));
  const hidden = data.cards.filter((c) => isDismissed(c, dismissed));
  const cov = data.coverage;
  const warning = cov?.warning ? <p className="rec-warning">{cov.warning}</p> : null;
  if (visible.length === 0 && hideWhenEmpty) return warning;

  const dismiss = (card: Recommendation, reason: "done" | "irrelevant") => {
    const next = { ...dismissed, [card.id]: { count: card.count, at: new Date().toISOString(), reason } };
    writeDismissed(next);
    setDismissed(next);
  };
  const restore = (card: Recommendation) => {
    const next = { ...dismissed };
    delete next[card.id];
    writeDismissed(next);
    setDismissed(next);
  };
  const shown = limit ? visible.slice(0, limit) : visible;

  if (variant === "list") {
    return wrap(
      <div className="recs">
        {warning}
        <ul className="rec-list">
          {shown.map((c) => {
            const evidence = evidenceText(c);
            return (
              <li key={c.id} className={`rec-${c.kind} ${evidence.fading ? "fading" : ""}`}>
                <button onClick={onSeeAll}>
                  <span className="rec-kind">{KIND_LABEL[c.kind]}</span>
                  <span className="rec-list-title">{inline(c.title)}</span>
                  <span className="rec-evidence tabular">{evidence.text}</span>
                  <span className="rec-list-go" aria-hidden="true">→</span>
                </button>
              </li>
            );
          })}
        </ul>
        {limit && visible.length > limit && onSeeAll && (
          <button className="link-btn rec-see-all" onClick={onSeeAll}>{visible.length - limit} more →</button>
        )}
      </div>,
    );
  }

  return wrap(
    <div className="recs">
      {warning}
      {visible.length === 0 && cov && (
        <p className="rec-empty dim">
          Nothing to fix. Read {num(cov.toolCalls)} tool calls in {cov.sessions} sessions over {cov.windowDays} days:
          {" "}{num(cov.failed)} failed, {num(cov.denied)} denied, none recurring enough to point at the setup.
        </p>
      )}
      {shown.map((c) => (
        <Card key={c.id} card={c} onSelectSession={onSelectSession} onDismiss={(r) => dismiss(c, r)} />
      ))}
      {limit && visible.length > limit && onSeeAll && (
        <button className="link-btn rec-see-all" onClick={onSeeAll}>{visible.length - limit} more recommendations →</button>
      )}
      {!limit && hidden.length > 0 && (
        <div className="rec-hidden">
          <button className="link-btn" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide dismissed" : `${hidden.length} dismissed`}
          </button>
          {showHidden && (
            <ul>
              {hidden.map((c) => (
                <li key={c.id}>
                  <span>{c.title}</span>
                  <span className="dim mono">{dismissed[c.id]?.reason === "done" ? "done" : "not relevant"} · {shortDate(dismissed[c.id]?.at ?? c.lastAt)}</span>
                  <button className="link-btn" onClick={() => restore(c)}>Restore</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
