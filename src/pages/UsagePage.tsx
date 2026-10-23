import type { ReactNode } from "react";
import type { Agent, Session } from "../types";
import type { Range } from "../utils/range";
import type { RateLimits } from "../utils/rateLimits";
import { sessionProvider } from "../utils/providers";
import { TokenTimeSeries } from "../components/fleet/TokenTimeSeries";
import { ProjectRollup } from "../components/fleet/ProjectRollup";
import { ModelMix } from "../components/fleet/ModelMix";
import { ToolsHeatmap } from "../components/fleet/ToolsHeatmap";
import { HeavyPrompts } from "../components/fleet/HeavyPrompts";
import { FiveHourSession } from "../components/fleet/FiveHourSession";
import { PageSection } from "./PageSection";

interface Props {
  sessions: Session[];
  allSessions: Session[];
  /** Every provider's sessions, for the current 5h windows. */
  everySession: Session[];
  /** Providers with a 5h window to break down (Claude Code, Codex). */
  windowProviders: Agent[];
  limits: RateLimits | null;
  range: Range;
  /** The range and filters, heading the section they drive (the current windows ignore them). */
  scopeBar: ReactNode;
  /** The scope's headline figures. */
  stats: ReactNode;
  onSelectSession: (id: string) => void;
}

/** What uses the current 5h windows, then where tokens and API value went over the range: over time, by project, model and tool. */
export function UsagePage({ sessions, allSessions, everySession, windowProviders, limits, range, scopeBar, stats, onSelectSession }: Props) {
  return (
    <div className="page">
      {windowProviders.length > 0 && (
        <PageSection title="Current 5h window" note="What is using it right now">
          {windowProviders.map((p) => (
            <FiveHourSession
              key={p}
              provider={p}
              sessions={everySession.filter((s) => sessionProvider(s) === p)}
              limit={limits?.[p]?.fiveHour ?? null}
              onSelectSession={onSelectSession}
            />
          ))}
        </PageSection>
      )}
      <PageSection title="History" note="Over the range and filters below">
        {scopeBar}
        {stats}
        <TokenTimeSeries sessions={sessions} range={range} />
        <div className="page-grid-3">
          <ProjectRollup sessions={sessions} allSessions={allSessions} range={range} />
          <ModelMix sessions={sessions} />
          <ToolsHeatmap sessions={sessions} />
        </div>
        <HeavyPrompts sessions={sessions} range={range} onSelectSession={onSelectSession} />
      </PageSection>
    </div>
  );
}
