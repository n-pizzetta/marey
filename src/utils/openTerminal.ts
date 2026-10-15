import type { Session } from "../types";
import { PRODUCT_NAME } from "./brand";
import { toastError } from "./toast";

/** The server runs on this machine; it can only script terminals on macOS (scripts/focus-terminal.mjs). */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** A running Claude Code session whose terminal the dashboard can bring to the front. */
export const canOpenTerminal = (s: Session) => IS_MAC && !!s.live && (s.agent ?? "claude") === "claude";

/** Brings the session's terminal to the front; toasts why when it fails or can't pick the exact tab. */
export async function openTerminal(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/focus`, { method: "POST" });
    if (!res.ok) {
      toastError("Could not open the terminal: " + (await res.text()));
      return false;
    }
    const { app, exact } = (await res.json()) as { app: string; exact: boolean };
    if (!exact) {
      toastError(
        app === "Ghostty"
          ? `Ghostty is in front, but ${PRODUCT_NAME} couldn't tell which tab runs this session.`
          : `${app} is in front. Picking the exact tab only works in Ghostty for now.`,
      );
    }
    return true;
  } catch (e) {
    toastError("Could not open the terminal: " + (e as Error).message);
    return false;
  }
}
