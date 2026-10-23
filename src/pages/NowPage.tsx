import { useMemo, useState } from "react";
import type { Agent, Session } from "../types";
import { SessionList } from "../components/SessionList";
import { SessionBoard } from "../components/SessionBoard";
import { PlanCard } from "../components/PlanCard";
import { PageSection } from "./PageSection";
import { PROVIDER_LABELS, sessionProvider, type Provider } from "../utils/providers";
import { planUsage, runningUsage, sessionColors } from "../utils/planUsage";
import type { RateLimits } from "../utils/rateLimits";
import { loadWindowStart } from "../utils/windowState";
import { useNow } from "../utils/useNow";

interface Props {
  /** Every provider's sessions: each plan card reads its own. */
  allSessions: Session[];
  provider: Provider;
  providers: Agent[];
  limits: RateLimits | null;
  onSelectSession: (id: string) => void;
  /** A sub-agent at work on the board: open its session on its calls. */
  onSelectSubagent: (sessionId: string, agentId: string) => void;
  onShowAllSessions: () => void;
  /** Opens the breakdown of a provider's current 5h window. */
  onOpenWindow: (provider: Agent) => void;
}

const LATEST = 6;

/**
 * Two questions: how much of each plan is used, and which running sessions use it. Each plan card
 * splits its bars by running session, in the colors the sessions board uses. Follows the provider;
 * ignores the time range and session filters.
 */
export function NowPage({ allSessions, provider, providers, limits, onSelectSession, onSelectSubagent, onShowAllSessions, onOpenWindow }: Props) {
  const now = useNow(10_000);
  const shown = provider === "all" ? providers : [provider];
  const sessions = useMemo(
    () => (provider === "all" ? allSessions : allSessions.filter((s) => sessionProvider(s) === provider)),
    [allSessions, provider],
  );
  const plans = useMemo(
    () => shown.map((p) => planUsage(p, allSessions.filter((s) => sessionProvider(s) === p), limits?.[p] ?? null, now, p === "claude" ? loadWindowStart() : null)),
    // `shown` is derived from provider and providers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider, providers, allSessions, limits, now],
  );
  const colors = useMemo(() => sessionColors(sessions), [sessions]);
  const usage = useMemo(() => runningUsage(plans), [plans]);
  const live = sessions.filter((s) => s.live);
  const several = shown.length > 1;
  // Pointing at a row or a slice lights up the other: the board has no colors of its own.
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="page">
      <PageSection
        title="Plan usage"
        note={`${several ? "" : `${PROVIDER_LABELS[shown[0]] ?? ""} · `}Each bar splits by running session: point at a slice or a session to see which`}
      >
        <div className="plan-grid">
          {plans.map((plan) => (
            <PlanCard
              key={plan.provider}
              usage={plan}
              colors={colors}
              hovered={hovered}
              onHover={setHovered}
              now={now}
              onSelectSession={onSelectSession}
              onDetails={plan.provider === "copilot" ? undefined : () => onOpenWindow(plan.provider)}
            />
          ))}
        </div>
      </PageSection>

      {live.length > 0 ? (
        <PageSection
          title="Running now"
          note={`${live.length} session${live.length > 1 ? "s" : ""}`}
          aside={<button className="link-btn" onClick={onShowAllSessions}>All sessions →</button>}
        >
          <SessionBoard sessions={sessions} onSelectSession={onSelectSession} onSelectSubagent={onSelectSubagent} usage={usage} showProvider={several} hovered={hovered} onHover={setHovered} />
        </PageSection>
      ) : (
        <PageSection
          title="Latest sessions"
          note="Nothing running"
          aside={<button className="link-btn" onClick={onShowAllSessions}>All sessions →</button>}
        >
          <SessionList sessions={sessions.slice(0, LATEST)} onSelect={onSelectSession} autoHeight />
        </PageSection>
      )}
    </div>
  );
}
