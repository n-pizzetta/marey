import type { Agent } from "../../types";
import type { ContextSession, MemoryRow } from "../../utils/agentContext";

export const fmtDay = (ms: number | string | null | undefined) =>
  ms == null ? "" : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const fmtTime = (ms: number | string | null | undefined) =>
  ms == null ? "" : new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const kChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

export const AGENT_LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot CLI" };

/** A memory file's state on the right of the grid and in its view. */
export function memoryStatus(m: MemoryRow): string {
  if (m.status === "lost") return "Folder gone";
  if (m.status === "gone") {
    const del = m.events.find((e) => e.mark === "x");
    return `Deleted${del?.tsMs ? ` ${fmtDay(del.tsMs)}` : ""}`;
  }
  if (m.status === "live") return `Re-read ${fmtDay(m.lastRead)}`;
  return m.lastRead ? `Not re-read since ${fmtDay(m.lastRead)}` : "Never re-read";
}

export const sessionName = (s: ContextSession | undefined) => s?.title || "Untitled session";
