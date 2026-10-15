import type { ReactNode } from "react";
import type { Agent } from "../types";
import { useRateLimits, type RateLimits } from "./rateLimits";
import { useLiveContext } from "./liveContext";

/** Something wrong with where the dashboard's figures come from, and how to fix it when there is a fix. */
export type SourceIssue = { key: string; text: ReactNode; fix?: ReactNode; level: "warn" | "info" };

/** What to tell about the data sources: nothing while everything works. */
export function sourceIssues(source: "real" | "mock", providers: Agent[], limits: RateLimits | null, contextLive: boolean): SourceIssue[] {
  const issues: SourceIssue[] = [];
  if (source === "mock") issues.push({ key: "mock", text: "Showing demo data: the local server is unreachable.", fix: <>Run <code>/marey:replay</code> again.</>, level: "warn" });
  const claudeOn = !!limits?.claude?.fiveHour || !!limits?.claude?.sevenDay;
  if (providers.includes("claude") && !claudeOn) {
    issues.push({ key: "claude", text: "Claude Code limits not connected.", fix: <>Run <code>/marey:limits</code> in Claude Code.</>, level: "warn" });
  } else if (claudeOn && !contextLive) {
    issues.push({ key: "context", text: "Context advice is waiting.", fix: <>Re-run <code>/marey:limits</code>, then send a message.</>, level: "warn" });
  }
  // Nothing to fix: Codex and Copilot CLI log their limits with their next request.
  if (providers.includes("codex") && !limits?.codex) issues.push({ key: "codex", text: "No Codex limits in its sessions yet.", level: "info" });
  if (providers.includes("copilot") && !limits?.copilot) issues.push({ key: "copilot", text: "No Copilot CLI quota in its sessions yet.", level: "info" });
  return issues;
}

/** The data sources' issues, for the settings button's dot and its menu. */
export function useSourceIssues(source: "real" | "mock", providers: Agent[]): SourceIssue[] {
  const limits = useRateLimits();
  const contextLive = useLiveContext().length > 0;
  return sourceIssues(source, providers, limits, contextLive);
}
