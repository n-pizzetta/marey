import { useMemo, useState } from "react";
import type { Session } from "../../types";
import { healthReport, type RuleStatus } from "../../utils/healthRules";
import "../../health.css";

interface Props {
  sessions: Session[];
  allSessions: Session[];
  onSelectSession: (id: string) => void;
}

const MARK: Record<RuleStatus, string> = { pass: "✓", warn: "!", fail: "✗", na: "–" };

/**
 * The checks of utils/healthRules that miss in the scope, one line each, worst first: a line opens
 * onto why it matters, what to do and the sessions behind it. The checks that pass are only counted.
 */
export function HealthCheck({ sessions, allSessions, onSelectSession }: Props) {
  const report = useMemo(() => healthReport(sessions, allSessions), [sessions, allSessions]);
  const byId = useMemo(() => new Map(allSessions.map((s) => [s.id, s])), [allSessions]);
  const [openId, setOpenId] = useState<string | null>(null);
  const misses = report.rules
    .filter((r) => r.status === "warn" || r.status === "fail")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1));
  if (report.total === 0) return null;
  return (
    <div className="health-checks">
      {misses.length > 0 && (
        <ul className="rec-list health-list">
          {misses.map((r) => {
            const open = openId === r.id;
            return (
              <li key={r.id} className={`health-rule status-${r.status} ${open ? "open" : ""}`}>
                <button onClick={() => setOpenId(open ? null : r.id)} aria-expanded={open}>
                  <span className="rec-kind health-kind"><span className="health-mark mono" aria-label={r.status}>{MARK[r.status]}</span> Check</span>
                  <span className="rec-list-title">{r.name}</span>
                  <span className="rec-evidence tabular"><span className="health-value">{r.value}</span> <span className="dim">· {r.target}</span></span>
                  <span className="rec-list-go" aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div className="health-open">
                    <p className="health-why dim">{r.why}</p>
                    <p className="health-hint">{r.hint}</p>
                    {r.sessionIds.length > 0 && (
                      <div className="health-sessions">
                        {r.sessionIds.map((id) => {
                          const s = byId.get(id);
                          return (
                            <button key={id} className="health-session mono" onClick={() => onSelectSession(id)} title={s?.goal}>
                              {s ? `${s.project} · ${new Date(s.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : id.slice(0, 8)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="health-passing dim">
        {misses.length === 0 ? `All ${report.passed} checks pass in this range.` : `${report.passed} of ${report.total} checks pass in this range.`}
      </p>
    </div>
  );
}
