import { useEffect, useRef, useState } from "react";
import type { Agent } from "../types";
import { LimitsSection } from "./LimitsSection";
import { UnitSetting } from "./UnitSetting";

const BUG_URL = "https://github.com/n-pizzetta/marey/issues/new/choose";

interface Props {
  source: "real" | "mock";
  /** "20s ago", or empty before the first parse. */
  parsedAgo: string;
  reportStatus: { exists: boolean };
  showClaude: boolean;
  /** Providers with sessions: each gets a row on where its limits come from. */
  providers: Agent[];
  onHelp: () => void;
}

/** Top-bar settings button (with the data status dot) and its menu: display settings, data and limits status, help. */
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

  const statusTitle = source === "real" ? `Live data${parsedAgo ? ` · parsed ${parsedAgo}` : ""}` : "Mock data: the local API is unreachable";

  return (
    <div className="profile">
      <button
        ref={btnRef}
        className={`profile-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Settings · ${statusTitle}`}
        title={statusTitle}
      >
        <span className={`profile-status ${source}`} aria-hidden="true" />
        <svg className="profile-gear" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </svg>
      </button>

      {open && (
        <div ref={popRef} className="settings-popover profile-popover" role="dialog" aria-label="Settings">
          {showClaude && <div className="profile-links">
            {reportStatus.exists ? (
              <a className="profile-link" href="/usage-report.html" target="_blank" rel="noreferrer">
                <span>Claude Code insights</span><span aria-hidden="true">↗</span>
              </a>
            ) : (
              <span className="profile-link disabled" title="Run /insights in Claude Code to generate it">
                <span>Claude Code insights</span><span className="mono dim">/insights</span>
              </span>
            )}
          </div>}

          <div className="profile-section">
            <UnitSetting />
            <div className="profile-row">
              <span className="profile-row-label">Data</span>
              <span className="profile-row-value mono">
                <span className={`profile-dot ${source === "real" ? "ok" : "warn"}`} aria-hidden="true" />
                {source === "real" ? (parsedAgo ? `live · ${parsedAgo}` : "live") : "mock"}
              </span>
            </div>
            <LimitsSection providers={providers} />
          </div>

          <div className="profile-foot">
            <button
              className="profile-link"
              onClick={() => {
                setOpen(false);
                onHelp();
              }}
            >
              <span>Keyboard shortcuts</span><kbd className="mono">?</kbd>
            </button>
            <a className="profile-link" href={BUG_URL} target="_blank" rel="noreferrer">
              <span>Report a bug</span><span aria-hidden="true">↗</span>
            </a>
            <div className="mono dim profile-local">100% local · nothing leaves your machine</div>
          </div>
        </div>
      )}
    </div>
  );
}
