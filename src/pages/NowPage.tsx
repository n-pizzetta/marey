import type { Session } from "../types";
import type { RateLimits } from "../utils/rateLimits";
import { nextUp, type BadgesPayload } from "../utils/gamify";
import { NextUp } from "../components/fleet/Badges";
import { LiveTicker } from "../components/fleet/LiveTicker";
import { FiveHourSession } from "../components/fleet/FiveHourSession";
import { SessionList } from "../components/SessionList";
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
  /** Sessions that count against the usage limits (the 5h window). */
  limitSessions: Session[];
  limits: RateLimits | null;
  badges: BadgesPayload | null;
  onSelectSession: (id: string) => void;
  onShowAllSessions: () => void;
  onOpenProgress: () => void;
}

const LATEST = 6;

/** Follows the provider, but deliberately ignores time range and session filters. */
export function NowPage({ allSessions, provider, showClaude, recommendations, onOpenHealth, limitSessions, limits, badges, onSelectSession, onShowAllSessions, onOpenProgress }: Props) {
  const live = allSessions.filter((s) => s.live);
  const rows = live.length > 0 ? live : allSessions.slice(0, LATEST);

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
      <PageSection
        title="Right now"
        note={`${PROVIDER_LABELS[provider]} · not affected by the range or filters`}
        aside={<LiveTicker sessions={allSessions} />}
      >
        {showClaude
          ? <FiveHourSession sessions={limitSessions} limits={limits} onSelectSession={onSelectSession} />
          : <TodayActivity sessions={allSessions} provider={provider} />}
      </PageSection>

      {badges && <ProgressStrip badges={badges} onOpen={onOpenProgress} />}

      <PageSection
        title={live.length > 0 ? "Live sessions" : "Latest sessions"}
        note={live.length > 0 ? `${live.length} running` : "No session running"}
        aside={<button className="link-btn" onClick={onShowAllSessions}>All sessions →</button>}
      >
        <SessionList sessions={rows} onSelect={onSelectSession} autoHeight />
      </PageSection>
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

/** Level, today's XP, the streak and the three closest good-practice badges: a goal on the landing page. */
function ProgressStrip({ badges, onOpen }: { badges: BadgesPayload; onOpen: () => void }) {
  const { level, streak } = badges;
  if (nextUp(badges.families, 1).length === 0) return null;
  const note = level ? `Claude Code · Lv ${level.level} ${level.title} · +${level.today} XP today` : "Claude Code";
  return (
    <PageSection
      title="Next up"
      note={note}
      aside={
        <>
          {streak && streak.current > 0 && (
            <span className={`streak-note mono tabular ${streak.atRisk ? "at-risk" : ""}`}>
              🔥 {streak.current} day{streak.current === 1 ? "" : "s"}{streak.atRisk ? " · not yet today" : ""}
            </span>
          )}
          <button className="link-btn" onClick={onOpen}>Progress →</button>
        </>
      }
    >
      <NextUp families={badges.families} limit={3} onOpen={onOpen} />
    </PageSection>
  );
}
