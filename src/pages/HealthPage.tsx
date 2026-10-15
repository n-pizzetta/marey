import type { ReactNode } from "react";
import type { Session } from "../types";
import { HealthCheck } from "../components/fleet/HealthCheck";
import { AnomalyFlags } from "../components/fleet/AnomalyFlags";
import { Recommendations } from "../components/Recommendations";
import type { RecommendationsPayload } from "../utils/recommendations";
import { PageSection } from "./PageSection";

interface Props {
  sessions: Session[];
  allSessions: Session[];
  /** Null in Codex views and without the API. */
  recommendations: RecommendationsPayload | null;
  /** The range and filters, heading the checks they drive (the recommendations ignore them). */
  scopeBar: ReactNode;
  onSelectSession: (id: string) => void;
}

/** What to fix in how sessions are run: recommendations with their fix, rule checks, then outlier sessions. */
export function HealthPage({ sessions, allSessions, recommendations, scopeBar, onSelectSession }: Props) {
  return (
    <div className="page">
      {recommendations && (
        <PageSection title="Recommendations" note={`From your last ${recommendations.windowDays} days of sessions`}>
          <Recommendations data={recommendations} onSelectSession={onSelectSession} />
        </PageSection>
      )}
      <PageSection title="Checks" note="Over the range and filters below">
        {scopeBar}
        <HealthCheck sessions={sessions} allSessions={allSessions} onSelectSession={onSelectSession} />
        <AnomalyFlags sessions={sessions} onSelectSession={onSelectSession} />
      </PageSection>
    </div>
  );
}
