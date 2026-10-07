import type { Session } from "../types";

/** Running sessions with a live state; the board and the header count read the same list. */
export const runningSessions = (sessions: Session[]) => sessions.filter((s) => s.live && s.liveState);

export const needsYouCount = (sessions: Session[]) => runningSessions(sessions).filter((s) => s.liveState!.state === "needs-you").length;
