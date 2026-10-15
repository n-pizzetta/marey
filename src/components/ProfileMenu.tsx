import { useEffect, useRef, useState } from "react";
import type { Agent } from "../types";
import { SourcesStatus } from "./SourcesStatus";
import { useSourceIssues } from "../utils/sourceIssues";
import { UnitSetting } from "./UnitSetting";

const BUG_URL = "https://github.com/n-pizzetta/marey/issues/new/choose";

interface Props {
  source: "real" | "mock";
  /** "20s ago", or empty before the first parse. */
  parsedAgo: string;
  reportStatus: { exists: boolean };
  showClaude: boolean;
  /** Providers with sessions: their limits are checked. */
  providers: Agent[];
  onHelp: () => void;
}

/**
 * Top-bar settings button and its menu: the usage unit, one status line for the data sources
 * (listing only what needs a look, with its fix), then a few links. The button's dot turns amber
 * when a source needs a look.
 */
export function ProfileMenu({ source, parsedAgo, reportStatus, showClaude, providers, onHelp }: Props) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let App's Escape handler close the session view as well.
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const issues = useSourceIssues(source, providers);
  const warn = issues.some((i) => i.level === "warn");
  const statusTitle = warn
    ? `Settings · ${issues.filter((i) => i.level === "warn").map((i) => (typeof i.text === "string" ? i.text : "")).join(" ")}`
    : `Settings · all sources live${parsedAgo ? ` · parsed ${parsedAgo}` : ""}`;

  return (
    <div className="profile">
      <button
        ref={btnRef}
        className={`profile-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={statusTitle}
        title={statusTitle}
      >
        <span className={`profile-status ${warn ? "warn" : ""}`} aria-hidden="true" />
        <svg className="profile-gear" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </svg>
      </button>

      {open && (
        <div ref={popRef} className="settings-popover profile-popover" role="dialog" aria-label="Settings">
          <UnitSetting />
          <SourcesStatus issues={issues} parsedAgo={parsedAgo} />
          <div className="profile-foot">
            {showClaude && (reportStatus.exists ? (
              <a className="profile-link" href="/usage-report.html" target="_blank" rel="noreferrer">
                <span>Claude Code insights</span><span aria-hidden="true">↗</span>
              </a>
            ) : (
              <span className="profile-link disabled" title="Run /insights in Claude Code to generate it">
                <span>Claude Code insights</span><span className="dim">run /insights</span>
              </span>
            ))}
            <button
              className="profile-link"
              onClick={() => {
                setOpen(false);
                onHelp();
              }}
            >
              <span>Keyboard shortcuts</span><kbd>?</kbd>
            </button>
            <a className="profile-link" href={BUG_URL} target="_blank" rel="noreferrer">
              <span>Report a bug</span><span aria-hidden="true">↗</span>
            </a>
            <div className="dim profile-local">100% local · nothing leaves your machine</div>
          </div>
        </div>
      )}
    </div>
  );
}
