/**
 * Recommendations: what keeps going wrong across sessions, with the evidence
 * and a fix. Built from the incidents scripts/parse-sessions.mjs keeps per
 * session (failed calls, denied actions, waits on the user).
 *
 * Claude Code sessions only for now: Codex rollouts don't expose incidents yet.
 */
import { CAUSES, IGNORED, NOISE, PROTECTIVE, commandHead, errorKey, toolLabel } from "./known-frictions.mjs";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
/** A cause shows from this many sessions; one bad afternoon is not a pattern. */
const MIN_SESSIONS = 3;
const MIN_DENIALS = 3;
const LONG_WAIT_MS = 10 * 60_000;
const MIN_LONG_WAITS = 3;
const MAX_RECURRING = 3;
const MAX_SESSIONS_PER_CARD = 8;

/** Collects incidents per card id, then turns each group into a card. */
class Groups {
  constructor() { this.map = new Map(); }
  add(id, session, incident) {
    let g = this.map.get(id);
    if (!g) this.map.set(id, (g = { incidents: [], sessions: new Map() }));
    g.incidents.push(incident);
    const s = g.sessions.get(session.id) ?? { id: session.id, goal: session.goal, project: session.project, count: 0, lastAt: 0 };
    s.count++;
    s.lastAt = Math.max(s.lastAt, incident.t ?? 0);
    if (!s.detail && incident.text) s.detail = incident.text.slice(0, 160);
    if (incident.ms) s.waitMs = Math.max(s.waitMs ?? 0, incident.ms);
    g.sessions.set(session.id, s);
  }
}

function evidence(group, now) {
  const ts = group.incidents.map((i) => i.t ?? 0);
  const sessions = [...group.sessions.values()].sort((a, b) => b.lastAt - a.lastAt);
  return {
    count: group.incidents.length,
    sessionCount: sessions.length,
    lastAt: Math.max(...ts),
    trend: {
      last7: ts.filter((t) => t >= now - 7 * DAY).length,
      prev7: ts.filter((t) => t < now - 7 * DAY && t >= now - 14 * DAY).length,
    },
    sessions: sessions.slice(0, MAX_SESSIONS_PER_CARD).map((s) => ({ ...s, lastAt: new Date(s.lastAt).toISOString() })),
  };
}

const iso = (ev) => ({ ...ev, lastAt: new Date(ev.lastAt).toISOString() });

function denialRows(incidents) {
  const byHead = new Map();
  for (const i of incidents) {
    const head = i.tool === "Bash" ? commandHead(i.command) ?? "Bash" : toolLabel(i.tool) ?? "unknown";
    const row = byHead.get(head) ?? { label: head, count: 0, tool: i.tool, protective: false, reason: null };
    row.count++;
    if (i.tool === "Bash" && PROTECTIVE.test(i.command ?? "")) row.protective = true;
    row.reason ??= /Reason: ([^\n]+?)(?:\.\s|\. If|$)/.exec(i.text ?? "")?.[1]?.trim() ?? null;
    byHead.set(head, row);
  }
  return [...byHead.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

/** Allow rules only for repeated, non-protective commands: narrow by construction. */
function allowRules(rows) {
  return rows
    .filter((r) => r.count >= 2 && !r.protective && r.tool === "Bash" && r.label.includes(" "))
    .map((r) => `"Bash(${r.label} *)"`);
}

/** Resolves the prompt, which can depend on the evidence (the latest error, the counts). */
function actionOf(action, ev) {
  if (!action) return undefined;
  const { prompt, ...rest } = action;
  return { ...rest, ...(prompt ? { prompt: typeof prompt === "function" ? prompt(ev) : prompt } : {}) };
}

/**
 * @param sessions full sessions from parseAllSessions (with `incidents`)
 * @returns {{ generatedAt: string, windowDays: number, cards: object[], coverage: object }}
 */
export function buildRecommendations(sessions, { now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const from = now - windowDays * DAY;
  const groups = new Groups();
  const coverage = { windowDays, sessions: 0, toolCalls: 0, toolResults: 0, failed: 0, denied: 0, waits: 0 };
  const recurring = new Map();
  const starts = [];

  for (const s of sessions) {
    if (s.agent !== "claude") continue;
    const last = new Date(s.lastEventAt ?? s.startedAt).getTime();
    if (!(last >= from)) continue;
    coverage.sessions++;
    starts.push(new Date(s.startedAt).getTime());
    coverage.toolCalls += Object.values(s.toolCounts ?? {}).reduce((a, b) => a + b, 0);
    coverage.toolResults += s.incidentStats?.toolResults ?? 0;

    for (const inc of s.incidents ?? []) {
      if (!(inc.t >= from)) continue;
      if (inc.kind === "wait") {
        coverage.waits++;
        if (inc.ms >= LONG_WAIT_MS) groups.add("waits", s, inc);
        continue;
      }
      if (inc.kind === "denial") {
        coverage.denied++;
        // The user said no: nothing to fix.
        if (inc.denial !== "user-rejected") groups.add("denials", s, inc);
        continue;
      }
      coverage.failed++;
      for (const n of inc.noise ?? []) groups.add(`noise:${n}`, s, inc);
      const text = inc.text ?? "";
      if (IGNORED.some((re) => re.test(text))) continue;
      const cause = CAUSES.find((c) => c.match.test(text));
      if (cause) { groups.add(`cause:${cause.id}`, s, inc); continue; }
      const key = errorKey(text);
      if (!key) continue;
      const r = recurring.get(key) ?? new Groups();
      r.add("x", s, inc);
      recurring.set(key, r);
    }
  }

  const cards = [];
  for (const [id, group] of groups.map) {
    const ev = evidence(group, now);
    if (id.startsWith("cause:") || id.startsWith("noise:")) {
      if (ev.sessionCount < MIN_SESSIONS) continue;
      const c = id.startsWith("cause:") ? CAUSES.find((x) => `cause:${x.id}` === id) : NOISE.find((x) => `noise:${x.id}` === id);
      const sample = group.incidents.at(-1).text?.slice(0, 240);
      cards.push({
        id, kind: c.kind ?? "setup",
        title: c.title(ev.count),
        what: c.what,
        action: actionOf(c.action, { ...ev, sample }),
        details: c.details,
        ...(id.startsWith("cause:") ? { sample } : {}),
        ...iso(ev),
      });
    } else if (id === "denials") {
      if (ev.count < MIN_DENIALS) continue;
      const rows = denialRows(group.incidents);
      const rules = allowRules(rows);
      cards.push({
        id, kind: "permissions",
        title: `${ev.count} actions stopped by Claude Code before they ran`,
        what: "Some stops protect you (merges, pushes, credentials): those are marked \"keep\". Others may be commands you actually want Claude to run.",
        rows,
        action: rules.length
          ? {
              text: "Allow the ones you want, in `/permissions` or your settings.",
              snippet: `"permissions": { "allow": [${rules.join(", ")}] }`,
              prompt: `Claude Code keeps stopping these commands in my sessions: ${rows.map((r) => `${r.label} (${r.count}×)`).join(", ")}. Add narrow allow rules for ${rules.join(", ")} to my ~/.claude/settings.json, explain what each one allows, and show me the diff before saving. Leave the others denied.`,
              docs: "https://code.claude.com/docs/en/permissions",
            }
          : { text: "None of these look safe to allow automatically. Open a session in the details to see what Claude was trying to do.", docs: "https://code.claude.com/docs/en/permissions" },
        details: "The stops come from auto mode's safety check or your permission rules; the reason Claude Code gave is next to each command. An allow rule is applied before auto mode's check.",
        ...iso(ev),
      });
    } else if (id === "waits") {
      if (ev.trend.last7 < MIN_LONG_WAITS) continue;
      cards.push({
        id, kind: "feature",
        title: `Sessions waited over 10 min for you ${ev.trend.last7} times this week`,
        what: "A session asked you a question or a plan to approve, and sat there while you were busy elsewhere.",
        action: {
          text: "Try Claude Code's agent view: put sessions in the background with `/bg` and keep `claude agents` open. A session that needs you turns yellow and shows its question.",
          docs: "https://code.claude.com/docs/en/agent-view",
        },
        details: "Counted from the time between a question (or a plan to approve) and your answer. The sessions below show the question each one asked.",
        ...iso(ev),
      });
    }
  }

  const unknown = [...recurring.entries()]
    .map(([key, r]) => ({ key, group: r.map.get("x") }))
    .filter(({ group }) => group.sessions.size >= MIN_SESSIONS)
    .sort((a, b) => b.group.sessions.size - a.group.sessions.size || b.group.incidents.length - a.group.incidents.length)
    .slice(0, MAX_RECURRING);
  for (const { key, group } of unknown) {
    const ev = evidence(group, now);
    const sample = group.incidents.at(-1).text?.slice(0, 240) ?? "";
    // Name the command only when it is the one failing, not one of many.
    const heads = group.incidents.map((i) => (i.tool === "Bash" ? commandHead(i.command) : toolLabel(i.tool)));
    const top = Object.entries(heads.reduce((m, h) => ((m[h] = (m[h] ?? 0) + 1), m), {})).sort((x, y) => y[1] - x[1])[0];
    const head = top && top[0] !== "null" && top[1] >= 0.8 * heads.length ? top[0] : null;
    const missing = /command not found: (\S+)/.exec(sample)?.[1];
    cards.push({
      id: `recurring:${key.slice(0, 60)}`,
      kind: "recurring",
      title: missing
        ? `${ev.count} commands failed: \`${missing}\` isn't installed`
        : `The same ${head ? `\`${head}\` ` : ""}error came back in ${ev.sessionCount} sessions`,
      what: missing
        ? `Claude uses \`${missing}\` as if it were there (it ships with Linux, not with macOS).`
        : "An error that keeps coming back across sessions usually comes from your setup, not from the task. Here it is:",
      sample,
      action: missing
        ? {
            text: "Install it, or tell Claude once that it isn't available.",
            prompt: `\`${missing}\` isn't installed on my machine and my Claude Code sessions keep calling it ("command not found"). Tell me the simplest way to get it, or add a line to my ~/.claude/CLAUDE.md saying it isn't available. Ask me which one before changing anything.`,
          }
        : {
            text: "Ask Claude what in your setup causes it.",
            prompt: `This error keeps coming back across my Claude Code sessions (${ev.count} times in ${ev.sessionCount} sessions): "${sample}". Tell me the likely cause in my setup and the simplest fix. Don't change anything before I confirm.`,
          },
      ...iso(ev),
    });
  }

  // Sessions started since it last happened: a fix shows within a day, not after a quiet week.
  for (const c of cards) c.sessionsSince = starts.filter((t) => t > Date.parse(c.lastAt)).length;

  // Something to paste or try first, then the widest spread.
  const actionable = (c) => (c.action?.snippet || c.action?.prompt || c.kind === "feature" ? 1 : 0);
  const order = { setup: 0, permissions: 1, feature: 2, habit: 3, recurring: 4 };
  cards.sort((a, b) => actionable(b) - actionable(a) || b.sessionCount - a.sessionCount || order[a.kind] - order[b.kind]);

  // Transcripts are an internal format: an empty list must not hide that Marey read nothing.
  if (coverage.toolCalls >= 50 && coverage.toolResults === 0) {
    coverage.warning = "Tool calls were found but none of their results could be read: this Claude Code version may write them differently, so recommendations can be missing.";
  }
  return { generatedAt: new Date(now).toISOString(), windowDays, cards, coverage };
}
