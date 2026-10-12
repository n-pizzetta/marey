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
  onSelectSession: (id: string) => void;
}

/** What to fix in how sessions are run: recommendations with their fix, rule checks, then outlier sessions. */
export function HealthPage({ sessions, allSessions, recommendations, onSelectSession }: Props) {
  return (
    <div className="page">
      {recommendations && (
        <PageSection title="Recommendations" note={`Last ${recommendations.windowDays} days · not affected by the range or filters`}>
          <Recommendations data={recommendations} onSelectSession={onSelectSession} />
        </PageSection>
      )}
      <HealthCheck sessions={sessions} allSessions={allSessions} onSelectSession={onSelectSession} />
      <AnomalyFlags sessions={sessions} onSelectSession={onSelectSession} />
    </div>
  );
}
