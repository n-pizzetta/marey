import type { Session } from "../types";
import { LiveTicker } from "../components/fleet/LiveTicker";
import { SessionList } from "../components/SessionList";
import { SessionBoard } from "../components/SessionBoard";
import { PageSection } from "./PageSection";
import { PROVIDER_LABELS, type Provider } from "../utils/providers";
import { useNow } from "../utils/useNow";
import { tokensInWindow } from "../utils/fleetStats";
import { freshTokens } from "../utils/units";
import { formatCost, formatTokens } from "../utils/format";
import { KpiRow } from "../components/Kpi";
import { Recommendations } from "../components/Recommendations";
import type { RecommendationsPayload } from "../utils/recommendations";

interface Props {
  allSessions: Session[];
  provider: Provider;
  showClaude: boolean;
  recommendations: RecommendationsPayload | null;
  onOpenHealth: () => void;
  onSelectSession: (id: string) => void;
  onShowAllSessions: () => void;
}

const LATEST = 6;

/**
 * What needs you: recommendations, then every running session by what it waits for. The 5h window
 * opens from the limits pill. Follows the provider; ignores the time range and session filters.
 */
export function NowPage({ allSessions, provider, showClaude, recommendations, onOpenHealth, onSelectSession, onShowAllSessions }: Props) {
  const live = allSessions.filter((s) => s.live);

  return (
    <div className="page">
      <Recommendations
        data={recommendations}
        onSelectSession={onSelectSession}
        limit={3}
        variant="list"
        onSeeAll={onOpenHealth}
        hideWhenEmpty
        wrap={(list) => (
          <PageSection
            title="To fix"
            note={`From your last ${recommendations?.windowDays ?? 30} days of sessions`}
            aside={<button className="link-btn" onClick={onOpenHealth}>All recommendations →</button>}
          >
            {list}
          </PageSection>
        )}
      />

      {live.length > 0 ? (
        <PageSection
          title="Your sessions"
          note={`${live.length} running · ${PROVIDER_LABELS[provider]}`}
          aside={<button className="link-btn" onClick={onShowAllSessions}>All sessions →</button>}
        >
          <SessionBoard sessions={allSessions} onSelectSession={onSelectSession} />
        </PageSection>
      ) : (
        <PageSection
          title="Latest sessions"
          note="No session running"
          aside={<button className="link-btn" onClick={onShowAllSessions}>All sessions →</button>}
        >
          <SessionList sessions={allSessions.slice(0, LATEST)} onSelect={onSelectSession} autoHeight />
        </PageSection>
      )}

      {/* Codex has no limits pill to open the 5h window from: its day stays here. */}
      {!showClaude && (
        <PageSection title="Today" note={PROVIDER_LABELS[provider]} aside={<LiveTicker sessions={allSessions} />}>
          <TodayActivity sessions={allSessions} provider={provider} />
        </PageSection>
      )}
    </div>
  );
}

/** Codex activity is available even though Marey does not read its quota limits. */
function TodayActivity({ sessions, provider }: { sessions: Session[]; provider: Provider }) {
  const now = useNow(5000);
  const usage = tokensInWindow(sessions, new Date(now).setHours(0, 0, 0, 0), now);
  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>{PROVIDER_LABELS[provider]} · Today</span>
        <span className="dim">Since midnight</span>
      </div>
      <KpiRow items={[
        { label: "Live sessions", value: sessions.filter((s) => s.live).length, sub: "running now" },
        { label: "Fresh tokens", value: formatTokens(freshTokens(usage.tokens)), sub: "today" },
        { label: "API value", value: formatCost(usage.cost), sub: "today", title: "Equivalent API value, not a bill" },
      ]} />
      {provider === "codex" && <p className="dim provider-note">Codex usage limits are not available in Marey. Activity is calculated from your sessions.</p>}
    </div>
  );
}
