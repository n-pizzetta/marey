import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../types";
import { cacheHit, inputTokens, sumTokens } from "../../utils/fleetStats";
import { formatDuration, formatTokens } from "../../utils/format";

interface Props {
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

type Anomaly = {
  kind: "heavy" | "lowcache" | "stuck";
  session: Session;
  detail: string;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function AnomalyFlags({ sessions, onSelectSession }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const anomalies = useMemo<Anomaly[]>(() => {
    const out: Anomaly[] = [];
    const totals = sessions.map((s) => sumTokens(s.tokens)).filter((v) => v > 0);
    const med = median(totals);
    const threshold = med * 3;

    for (const s of sessions) {
      const total = sumTokens(s.tokens);
      if (threshold > 0 && total > threshold) {
        out.push({
          kind: "heavy",
          session: s,
          detail: `${formatTokens(total)} tokens — ${(total / med).toFixed(1)}× median (${formatTokens(med)})`,
        });
      }
      const inputPool = inputTokens(s.tokens);
      if (inputPool >= 100_000) {
        const hit = cacheHit(s.tokens);
        if (hit < 0.5) {
          out.push({
            kind: "lowcache",
            session: s,
            detail: `cache hit ${(hit * 100).toFixed(0)}% on ${formatTokens(inputPool)} input — wasting fresh spend`,
          });
        }
      }
      if (s.live && s.lastEventAt) {
        const idle = now - new Date(s.lastEventAt).getTime();
        if (idle > 30 * 60_000) {
          out.push({
            kind: "stuck",
            session: s,
            detail: `no event in ${formatDuration(idle)} — stuck?`,
          });
        }
      }
    }
    return out.slice(0, 20);
  }, [sessions, now]);

  if (anomalies.length === 0) {
    return (
      <div className="fleet-block">
        <div className="section-title"><span>Anomalies</span></div>
        <div className="clean-row">
          <span style={{ color: "var(--c-green)" }}>✓</span> No anomalies detected in range
        </div>
      </div>
    );
  }

  return (
    <div className="fleet-block">
      <div className="section-title">
        <span>Anomalies</span>
        <span className="dim mono tabular">{anomalies.length}</span>
      </div>
      <div className="anomalies">
        {anomalies.map((a, i) => (
          <button key={`${a.session.id}-${a.kind}-${i}`} className={`anomaly-row kind-${a.kind}`} onClick={() => onSelectSession(a.session.id)}>
            <span className="anomaly-dot" />
            <span className="mono anomaly-kind caps">{a.kind === "heavy" ? "heavy" : a.kind === "lowcache" ? "low cache" : "stuck"}</span>
            <span className="mono anomaly-project">{a.session.project}</span>
            <span className="anomaly-goal">{a.session.goal || "—"}</span>
            <span className="mono dim anomaly-detail">{a.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
