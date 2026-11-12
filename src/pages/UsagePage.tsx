import { useMemo, useState, type ReactNode } from "react";
import type { Agent, Session } from "../types";
import type { Range } from "../utils/range";
import type { RateLimits } from "../utils/rateLimits";
import { sessionProvider } from "../utils/providers";
import { distinctColors, modelColor, projectColor, seriesByTokens, type SeriesBy } from "../utils/fleetStats";
import { TokenTimeSeries } from "../components/fleet/TokenTimeSeries";
import { ProjectRollup } from "../components/fleet/ProjectRollup";
import { ModelMix } from "../components/fleet/ModelMix";
import { ToolsHeatmap } from "../components/fleet/ToolsHeatmap";
import { HeavyPrompts } from "../components/fleet/HeavyPrompts";
import { FiveHourSession } from "../components/fleet/FiveHourSession";
import { HealthCheck } from "../components/fleet/HealthCheck";
import { Recommendations } from "../components/Recommendations";
import type { RecommendationsPayload } from "../utils/recommendations";
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
  /** Null in Codex and Copilot views and without the API. */
  recommendations: RecommendationsPayload | null;
  onSelectSession: (id: string) => void;
}

/**
 * What uses the current 5h windows, then where tokens and API value went over the range: over time,
 * by project, model and tool; then what is worth fixing in how sessions run, one line each.
 */
export function UsagePage({ sessions, allSessions, everySession, windowProviders, limits, range, scopeBar, stats, recommendations, onSelectSession }: Props) {
  // One color per project and per model for the whole range: the chart, and the card it is stacked
  // like (Project league or Model mix), share them; the other card stays neutral.
  const [by, setBy] = useState<SeriesBy>("project");
  const colors = useMemo(
    () => ({ project: distinctColors(seriesByTokens(sessions, "project"), projectColor), model: distinctColors(seriesByTokens(sessions, "model"), modelColor) }),
    [sessions],
  );
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
        <TokenTimeSeries sessions={sessions} range={range} by={by} onBy={setBy} colors={colors[by]} />
        <div className="page-grid-3">
          <ProjectRollup sessions={sessions} allSessions={allSessions} range={range} colors={by === "project" ? colors.project : null} />
          <ModelMix sessions={sessions} colors={by === "model" ? colors.model : null} />
          <ToolsHeatmap sessions={sessions} />
        </div>
        <HeavyPrompts sessions={sessions} range={range} onSelectSession={onSelectSession} />
      </PageSection>
      <PageSection
        title="Worth fixing"
        note={`${recommendations ? `Recurring problems over your last ${recommendations.windowDays} days, then the` : "The"} checks that miss in the range above. Open a line for the fix.`}
      >
        <Recommendations data={recommendations} onSelectSession={onSelectSession} />
        <HealthCheck sessions={sessions} allSessions={allSessions} onSelectSession={onSelectSession} />
      </PageSection>
    </div>
  );
}
