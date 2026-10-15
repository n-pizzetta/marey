import type { Agent, Session } from "../types";

export type Provider = "all" | Agent;

export const AGENTS: Agent[] = ["claude", "codex", "copilot"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  all: "All providers",
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot CLI",
};

export function isProvider(value: unknown): value is Provider {
  return value === "all" || AGENTS.includes(value as Agent);
}

/** Older exports without an agent field contain Claude Code sessions. */
export function sessionProvider(session: Session): Agent {
  return session.agent ?? "claude";
}

/** Detection uses the full history, so a provider stays selectable in an empty time range. */
export function detectedProviders(sessions: Session[]): Agent[] {
  const present = new Set(sessions.map(sessionProvider));
  return AGENTS.filter((agent) => present.has(agent));
}

export function resolveProvider(preferred: Provider, detected: Agent[]): Provider {
  if (detected.length === 1) return detected[0];
  return preferred === "all" || detected.includes(preferred) ? preferred : "all";
}
