import { useEffect } from "react";
import type { Outcome } from "../types";
import { outcomeColor } from "../utils/format";

interface Props {
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["1 – 4", "Now · Sessions · Usage · Health"],
  ["↑ / k", "Previous session (while one is open)"],
  ["↓ / j", "Next session (while one is open)"],
  ["Esc", "Close the session / overlay"],
  ["?", "Toggle this help"],
];

/** The session table's status column: one dot per outcome, filled as far as the goal was met. */
const OUTCOME_GLYPHS: Array<[Outcome, string, string]> = [
  ["fully_achieved", "Achieved", "Goal met, as rated by /insights"],
  ["mostly_achieved", "Mostly achieved", "Goal mostly met"],
  ["partially_achieved", "Partially achieved", "Part of the goal met"],
  ["not_achieved", "Not achieved", "Goal not met"],
  ["unknown", "Not rated yet", "Run /insights in Claude Code to rate it"],
];

const GLYPHS: Array<{ glyph: React.ReactNode; label: string; kind: string }> = [
  { glyph: <span className="glyph glyph-live" />, label: "Live", kind: "Claude Code and Copilot CLI: running process · Codex: task in progress" },
  { glyph: <span className="glyph glyph-ghost" />, label: "Ghost", kind: "Empty session, or its Claude Code process died (Claude Code only)" },
  { glyph: <span className="glyph glyph-cleared">⟲</span>, label: "Cleared", kind: "Context cleared: the work continues in the next session" },
  ...OUTCOME_GLYPHS.map(([outcome, label, kind]) => ({
    glyph: <span className={`glyph outcome-dot outcome-${outcome}`} style={{ "--oc": outcomeColor(outcome) } as React.CSSProperties} />,
    label,
    kind,
  })),
  { glyph: <span className="glyph friction-chip">△</span>, label: "Friction", kind: "Friction points flagged by /insights" },
  { glyph: <span className="agent-tag">codex</span>, label: "Codex", kind: "Session from Codex (~/.codex)" },
  { glyph: <span className="agent-tag">copilot</span>, label: "Copilot", kind: "Session from Copilot CLI (~/.copilot)" },
  { glyph: <span className="terminal-chip">›_</span>, label: "Open terminal", kind: "Brings a running session's terminal to the front (macOS; exact tab in Ghostty)" },
];

const GLOSSARY: Array<[string, string]> = [
  ["Tokens", "Text units the model reads and writes. Input = what you send, output = what it generates, cache read/write = reused context (much cheaper)."],
  ["Cost", "Estimated at public API prices from token counts. It is not what a subscription plan bills you."],
  ["5h window", "Claude Code and Codex limits reset on a rolling five-hour window, plus a weekly one. The bar shows how much of it you have used, split by running session."],
  ["AI credits", "What Copilot CLI's monthly quota counts: every request is priced per token type, whoever started it (you, the agent or a sub-agent)."],
  ["Share of the limit", "How much of a plan's limit a session used: its share of the window's API value (Claude Code, Codex; Claude's cache reads count a tenth) or of the month's AI credits (Copilot CLI). An estimate: the providers don't report it per session."],
  ["Burn rate", "Tokens or dollars consumed per minute over the last 60 seconds."],
  ["Spike", "Your 5h limit jumped by 4 percentage points (amber) or 10 (red) within 5 minutes."],
  ["Ghost", "A session that ended without a clean shutdown, so its data may be incomplete."],
  ["Friction", "Moments where the session stalled, got corrected or went in circles, as flagged by an LLM."],
];

const DATA_SOURCES: Array<{ tag: string; label: string; examples: string }> = [
  { tag: "real", label: "Hard data", examples: "sessions count, duration, tokens, cost, tool sequence, prompts" },
  { tag: "llm", label: "LLM-assessed", examples: "outcome, summary, frictions (from /insights: ~/.claude/usage-data/facets/)" },
  { tag: "measured", label: "Measured quality", examples: "grade, score, waste signals (measured from the transcript)" },
];

export function HelpOverlay({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose} role="presentation">
      <div className="help-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Help">
        <div className="help-head">
          <h2>Help &amp; shortcuts</h2>
          <button className="help-close" onClick={onClose} aria-label="Close help">✕</button>
        </div>

        <section className="help-section">
          <h3>Keyboard</h3>
          <dl className="help-kbd-list">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="help-kbd-row">
                <dt><kbd>{k}</kbd></dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="help-section">
          <h3>Glyphs</h3>
          <dl className="help-glyph-list">
            {GLYPHS.map((g) => (
              <div key={g.label} className="help-glyph-row">
                <dt>{g.glyph}</dt>
                <dd>
                  <strong>{g.label}</strong>
                  <span className="dim mono"> — {g.kind}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="help-section">
          <h3>Glossary</h3>
          <dl className="help-glossary">
            {GLOSSARY.map(([term, def]) => (
              <div key={term} className="help-glossary-row">
                <dt>{term}</dt>
                <dd>{def}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="help-section">
          <h3>Data sources</h3>
          <dl className="help-source-list">
            {DATA_SOURCES.map((d) => (
              <div key={d.tag} className="help-source-row">
                <dt><span className={`help-tag help-tag-${d.tag}`}>{d.tag}</span></dt>
                <dd>
                  <strong>{d.label}</strong>
                  <div className="mono dim help-source-examples">{d.examples}</div>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="help-section help-footer">
          <span className="mono dim">
            Marey · flight recorder for Claude Code &amp; Codex sessions
          </span>
        </section>
      </div>
    </div>
  );
}
