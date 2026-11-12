import type { WindowBreakdown } from "../../utils/windowBreakdown";
import { OTHER_COLOR, distinctColors, projectColor } from "../../utils/fleetStats";
import { formatCost, formatTokens } from "../../utils/format";
import { useStickyRank } from "../../utils/stickyRank";

interface Props {
  data: WindowBreakdown;
  /** "window": the current 5h window; "today": since midnight, shown while the window is idle. */
  scope: "window" | "today";
  /** Used share of the 5h limit (0-1) when the status line reports it: how far the bar fills. */
  limitPct: number | null;
  onSelectSession: (id: string) => void;
}

const ROWS = 5;
/** Projects in the bar and its legend; the rest fold into "other". */
const PROJECTS = 4;

const pctText = (part: number) => {
  const p = part * 100;
  return `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`;
};

type Row = { id: string; name: string; project: string; part: number; value: string; title: string; onClick: () => void };

/**
 * What used the window (or today, while it is idle): the split by project as one bar, filled to
 * the used 5h % when the limit is known, then the heaviest sessions and prompts. Every share is
 * of the scope's API value (tokens when nothing is priced), in a sticky order: a row only
 * overtakes another by more than 1% of the scope.
 */
export function WindowConsumers({ data, scope, limitPct, onSelectSession }: Props) {
  const unit = data.weigh;
  const total = data.total[unit];
  const sessions = useStickyRank(data.sessions, (r) => r.s.id, (r) => r[unit], total / 100);
  const prompts = useStickyRank(data.prompts, (r) => `${r.session.id}:${r.stat.promptIdx}`, (r) => r.stat.cost, data.total.cost / 100);
  const projects = useStickyRank(data.projects, (p) => p.project, (p) => p[unit], total / 100);
  if (total <= 0 || sessions.length === 0) return null;

  const of = scope === "window" ? "this window" : "today";
  const value = (b: { tokens: number; cost: number }) => (unit === "cost" ? formatCost(b.cost) : formatTokens(b.tokens));
  const named = projects.slice(0, PROJECTS);
  const rest = projects.slice(PROJECTS);
  const segments = rest.length > 0
    ? [...named, { project: `other (${rest.length})`, tokens: rest.reduce((a, p) => a + p.tokens, 0), cost: rest.reduce((a, p) => a + p.cost, 0) }]
    : named;
  // Each project's session-list color, unless an earlier one in the card took it: then the next free one.
  const colors = distinctColors(named.map((p) => p.project), projectColor);
  const colorOf = (project: string) => colors.get(project) ?? OTHER_COLOR;
  const fill = Math.min(1, Math.max(0, limitPct ?? 1));

  const lead = sessions[0];
  const leadPart = lead[unit] / total;
  const concentrated = sessions.length >= 3 && leadPart >= 0.75;

  const sessionRows: Row[] = sessions.slice(0, ROWS).map((r) => ({
    id: r.s.id,
    name: r.s.goal || r.s.project,
    project: r.s.project,
    part: r[unit] / total,
    value: value(r),
    title: `${r.s.goal || r.s.project}\n${r.s.project} · ${formatTokens(r.tokens)} tokens · ${formatCost(r.cost)} API value`,
    onClick: () => onSelectSession(r.s.id),
  }));
  const promptRows: Row[] = unit === "cost"
    ? prompts.slice(0, ROWS).map((r) => {
        const preview = r.session.prompts?.[r.stat.promptIdx]?.preview || "—";
        return {
          id: `${r.session.id}:${r.stat.promptIdx}`,
          name: preview,
          project: r.session.project,
          part: r.stat.cost / data.total.cost,
          value: formatCost(r.stat.cost),
          title: `${preview}\n${r.session.project} · ${r.stat.turnCount} turn${r.stat.turnCount === 1 ? "" : "s"} · ${formatCost(r.stat.cost)} API value`,
          onClick: () => onSelectSession(r.session.id),
        };
      })
    : [];

  return (
    <div className="consumers">
      <div className="consumers-head">
        <span className="consumers-title">{scope === "window" ? "What's using it" : "Today's biggest consumers"}</span>
        {concentrated && <span className="consumers-alert">One session is using {pctText(leadPart)} of {of}</span>}
        <span className="consumers-unit">Share of {of}'s {unit === "cost" ? "API value" : "tokens"}</span>
      </div>

      <div className="consumers-split">
        <div
          className="consumers-bar"
          role="img"
          aria-label={`By project${limitPct !== null ? `, filled to the ${Math.round(fill * 100)}% of the 5h limit used` : ""}: ${segments.map((p) => `${p.project} ${pctText(p[unit] / total)}`).join(", ")}`}
        >
          <span className="consumers-bar-fill" style={{ width: `${fill * 100}%` }}>
            {segments.map((p) => (
              <span
                key={p.project}
                style={{ flexGrow: p[unit], background: colorOf(p.project) }}
                title={`${p.project}: ${pctText(p[unit] / total)} of ${of} · ${formatTokens(p.tokens)} tokens · ${formatCost(p.cost)}`}
              />
            ))}
          </span>
        </div>
        <div className="consumers-legend">
          {segments.map((p) => (
            <span key={p.project} className="consumers-legend-item">
              <span className="consumers-swatch" style={{ background: colorOf(p.project) }} />
              <span className="consumers-legend-name">{p.project}</span>
              <span className="tabular">{pctText(p[unit] / total)}</span>
            </span>
          ))}
          {limitPct !== null && <span className="consumers-legend-scale">Full bar = the 5h limit</span>}
        </div>
      </div>

      <div className="consumers-lists">
        <ConsumerList title="Sessions" rows={sessionRows} colorOf={colorOf} />
        <ConsumerList title="Prompts" rows={promptRows} colorOf={colorOf} />
      </div>
    </div>
  );
}

function ConsumerList({ title, rows, colorOf }: { title: string; rows: Row[]; colorOf: (project: string) => string }) {
  return (
    <div className="consumers-list">
      <div className="consumers-list-title">{title}</div>
      {rows.length === 0 ? (
        <div className="consumers-empty">—</div>
      ) : (
        rows.map((r) => (
          <button key={r.id} className="consumers-row" onClick={r.onClick} title={r.title}>
            <span className="consumers-swatch" style={{ background: colorOf(r.project) }} />
            <span className="consumers-row-name">{r.name}</span>
            <span className="consumers-row-project">{r.project}</span>
            <span className="consumers-row-bar" aria-hidden="true"><span style={{ width: `${r.part * 100}%` }} /></span>
            <span className="consumers-row-share tabular">{pctText(r.part)}</span>
            <span className="consumers-row-value tabular">{r.value}</span>
          </button>
        ))
      )}
    </div>
  );
}
