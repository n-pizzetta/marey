import { useEffect } from "react";
import type { Session } from "../types";
import type { RateLimits } from "../utils/rateLimits";
import { FiveHourSession } from "./fleet/FiveHourSession";
import { LiveTicker } from "./fleet/LiveTicker";
import "../board.css";

interface Props {
  /** Sessions that count against the Claude usage limits. */
  limitSessions: Session[];
  /** The provider's sessions, for the live burn. */
  sessions: Session[];
  limits: RateLimits | null;
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

/** The current 5h window and the live burn, opened from the limits pill. */
export function WindowOverlay({ limitSessions, sessions, limits, onClose, onSelectSession }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="window-overlay" onClick={onClose}>
      <div className="window-overlay-panel page scrollbar" role="dialog" aria-label="Current 5h window" onClick={(e) => e.stopPropagation()}>
        <div className="window-overlay-head">
          <LiveTicker sessions={sessions} />
          <button className="window-overlay-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <FiveHourSession sessions={limitSessions} limits={limits} onSelectSession={(id) => { onClose(); onSelectSession(id); }} />
      </div>
    </div>
  );
}
