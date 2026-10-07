import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "../types";
import type { RateLimits } from "../utils/rateLimits";
import { LimitsPill } from "./LimitsGauge";
import { FiveHourSession } from "./fleet/FiveHourSession";
import { LiveTicker } from "./fleet/LiveTicker";
import "../board.css";

/** The limits pill, opening the current 5h window in a panel under it, like a menu bar item. */
export function WindowMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let App's Escape handler close the session view as well.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`window-menu ${open ? "open" : ""}`} ref={ref}>
      <LimitsPill onOpen={() => setOpen((v) => !v)} />
      {open && (
        <div className="window-pop page scrollbar" role="dialog" aria-label="Current 5h window">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  /** Sessions that count against the Claude usage limits. */
  limitSessions: Session[];
  /** The provider's sessions, for the live burn. */
  sessions: Session[];
  limits: RateLimits | null;
  onSelectSession: (id: string) => void;
}

/** What goes in the panel: the live burn, then the current 5h window and what is using it. */
export function WindowPanel({ limitSessions, sessions, limits, onSelectSession }: PanelProps) {
  return (
    <>
      <FiveHourSession sessions={limitSessions} limits={limits} onSelectSession={onSelectSession} />
      <div className="window-pop-foot">
        <LiveTicker sessions={sessions} />
      </div>
    </>
  );
}
