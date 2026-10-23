import type { Session, TimelineEvent, ToolName } from "../types";
import { costOf } from "../../scripts/models.mjs";

const TOOLS: ToolName[] = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Agent", "WebFetch", "TodoWrite"];

function emptyCounts(): Record<ToolName, number> {
  return TOOLS.reduce((a, t) => ({ ...a, [t]: 0 }), {} as Record<ToolName, number>);
}

function buildTimeline(seed: number, durationMs: number, frictionAt: number[]): TimelineEvent[] {
  const rand = mulberry32(seed);
  const events: TimelineEvent[] = [];
  const count = 24 + Math.floor(rand() * 40);
  for (let i = 0; i < count; i++) {
    const t = (i / count) * durationMs + rand() * 8000;
    const r = rand();
    if (r < 0.12) {
      events.push({ t, kind: "prompt", label: "User prompt" });
    } else if (r < 0.18) {
      events.push({ t, kind: "agent", label: "Spawned sub-agent" });
    } else if (r < 0.22 && i > 3) {
      events.push({ t, kind: "commit", label: "git commit" });
    } else {
      const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
      events.push({
        t,
        kind: "tool",
        tool,
        label: tool,
        tokensIn: Math.floor(800 + rand() * 3200),
        tokensOut: Math.floor(200 + rand() * 1800),
      });
    }
  }
  frictionAt.forEach((pct, i) => {
    events.push({
      t: durationMs * pct,
      kind: "friction",
      label: ["Wrong approach", "Buggy code", "Tool error", "Missing context"][i % 4],
    });
  });
  return events.sort((a, b) => a.t - b.t);
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAW_SESSIONS: Session[] = [
  {
    id: "s_a1f3",
    project: "marey",
    cwd: "~/dev/personal/marey",
    startedAt: "2026-04-20T14:02:00Z",
    durationMs: 1000 * 60 * 47,
    model: "opus-5.5",
    outcome: "fully_achieved",
    satisfaction: 0.92,
    goal: "Build dashboard scaffold with design tokens",
    summary: "Scaffolded Vite project, established design system, built SessionList and SessionDetail with mock data. Clean run, no friction.",
    messages: 18,
    toolCounts: { ...emptyCounts(), Read: 12, Write: 22, Edit: 8, Bash: 9, Grep: 4, Agent: 2, TodoWrite: 3, Glob: 2, WebFetch: 1 },
    tokens: { input: 248_000, output: 42_000, cacheRead: 612_000, cacheWrite: 84_000 },
    costUsd: 12.8,
    frictions: [],
    timeline: buildTimeline(1, 1000 * 60 * 47, []),
    subAgents: 2,
    filesChanged: 18,
    commits: 3,
    live: true,
  },
  {
    id: "s_b7c9",
    project: "auth-service",
    cwd: "~/dev/work/auth-service",
    startedAt: "2026-04-20T09:14:00Z",
    durationMs: 1000 * 60 * 112,
    model: "opus-5.5",
    outcome: "partially_achieved",
    satisfaction: 0.44,
    goal: "Refactor OAuth token refresh flow",
    summary: "Two wrong approaches before landing on working solution. User interrupted twice; tests still failing at session end.",
    messages: 41,
    toolCounts: { ...emptyCounts(), Read: 38, Edit: 24, Bash: 19, Grep: 12, Agent: 1, TodoWrite: 2, Write: 6, Glob: 5, WebFetch: 0 },
    tokens: { input: 612_000, output: 138_000, cacheRead: 1_240_000, cacheWrite: 204_000 },
    costUsd: 34.2,
    frictions: [
      { kind: "wrong_approach", at: 0.18, detail: "Tried middleware approach, reverted" },
      { kind: "buggy_code", at: 0.41, detail: "Race condition in token refresh" },
      { kind: "user_interruption", at: 0.55, detail: "Ctrl+C during bash install" },
      { kind: "wrong_approach", at: 0.72, detail: "Misread spec, re-implemented" },
    ],
    timeline: buildTimeline(2, 1000 * 60 * 112, [0.18, 0.41, 0.55, 0.72]),
    subAgents: 1,
    filesChanged: 11,
    commits: 1,
  },
  {
    id: "s_c3d2",
    project: "data-pipeline",
    cwd: "~/dev/work/data-pipeline",
    startedAt: "2026-04-19T21:48:00Z",
    durationMs: 1000 * 60 * 28,
    model: "sonnet-5.5",
    outcome: "fully_achieved",
    satisfaction: 0.88,
    goal: "Add retry logic to Kafka consumer",
    summary: "Quick session. Added exponential backoff, tests pass, committed.",
    messages: 9,
    toolCounts: { ...emptyCounts(), Read: 6, Edit: 4, Bash: 5, Grep: 2, Write: 1, Glob: 1, Agent: 0, TodoWrite: 0, WebFetch: 0 },
    tokens: { input: 89_000, output: 14_000, cacheRead: 142_000, cacheWrite: 22_000 },
    costUsd: 2.1,
    frictions: [],
    timeline: buildTimeline(3, 1000 * 60 * 28, []),
    subAgents: 0,
    filesChanged: 3,
    commits: 1,
  },
  {
    id: "s_d9e1",
    project: "marketing-site",
    cwd: "~/dev/work/marketing-site",
    startedAt: "2026-04-19T16:30:00Z",
    durationMs: 1000 * 60 * 83,
    model: "opus-5.5",
    outcome: "mostly_achieved",
    satisfaction: 0.71,
    goal: "Redesign pricing page with new tiers",
    summary: "Landed new design. One friction around dark mode tokens. Sub-agent used for copywriting variants.",
    messages: 27,
    toolCounts: { ...emptyCounts(), Read: 19, Edit: 21, Bash: 7, Grep: 6, Agent: 4, Write: 8, TodoWrite: 2, Glob: 3, WebFetch: 2 },
    tokens: { input: 384_000, output: 92_000, cacheRead: 812_000, cacheWrite: 142_000 },
    costUsd: 21.4,
    frictions: [{ kind: "missing_context", at: 0.34, detail: "Design tokens not in CLAUDE.md" }],
    timeline: buildTimeline(4, 1000 * 60 * 83, [0.34]),
    subAgents: 4,
    filesChanged: 14,
    commits: 2,
  },
  {
    id: "s_e4f7",
    project: "auth-service",
    cwd: "~/dev/work/auth-service",
    startedAt: "2026-04-19T11:02:00Z",
    durationMs: 1000 * 60 * 64,
    model: "opus-5.5",
    outcome: "not_achieved",
    satisfaction: 0.21,
    goal: "Migrate session store from Redis to Postgres",
    summary: "Repeated wrong approach. Schema mismatch discovered late. User abandoned session.",
    messages: 33,
    toolCounts: { ...emptyCounts(), Read: 28, Edit: 12, Bash: 14, Grep: 18, Agent: 0, Write: 3, TodoWrite: 4, Glob: 8, WebFetch: 1 },
    tokens: { input: 498_000, output: 74_000, cacheRead: 912_000, cacheWrite: 128_000 },
    costUsd: 19.8,
    frictions: [
      { kind: "wrong_approach", at: 0.12, detail: "Used JSONB instead of relational" },
      { kind: "wrong_approach", at: 0.38, detail: "Missed unique constraint" },
      { kind: "buggy_code", at: 0.51, detail: "Migration deadlock" },
      { kind: "tool_error", at: 0.68, detail: "psql connection refused" },
      { kind: "user_interruption", at: 0.88, detail: "Abandoned session" },
    ],
    timeline: buildTimeline(5, 1000 * 60 * 64, [0.12, 0.38, 0.51, 0.68, 0.88]),
    subAgents: 0,
    filesChanged: 6,
    commits: 0,
  },
  {
    id: "s_f8a2",
    project: "marey",
    cwd: "~/dev/personal",
    startedAt: "2026-04-18T22:14:00Z",
    durationMs: 1000 * 60 * 19,
    model: "haiku-4.5",
    outcome: "fully_achieved",
    satisfaction: 0.94,
    goal: "Write PLAN.md for new project",
    summary: "Single-shot planning session. Structured plan, risk analysis, day-by-day schedule.",
    messages: 6,
    toolCounts: { ...emptyCounts(), Read: 4, Write: 2, Edit: 3, Bash: 1, Grep: 1, Agent: 0, TodoWrite: 1, Glob: 0, WebFetch: 3 },
    tokens: { input: 64_000, output: 28_000, cacheRead: 88_000, cacheWrite: 14_000 },
    costUsd: 0.42,
    frictions: [],
    timeline: buildTimeline(6, 1000 * 60 * 19, []),
    subAgents: 0,
    filesChanged: 1,
    commits: 1,
  },
  {
    id: "s_g1b5",
    project: "data-pipeline",
    cwd: "~/dev/work/data-pipeline",
    startedAt: "2026-04-18T14:48:00Z",
    durationMs: 1000 * 60 * 38,
    model: "opus-5.5",
    outcome: "mostly_achieved",
    satisfaction: 0.68,
    goal: "Debug Airflow DAG scheduling bug",
    summary: "Identified race condition in scheduler. Fix deployed but monitoring needed.",
    messages: 14,
    toolCounts: { ...emptyCounts(), Read: 16, Edit: 6, Bash: 12, Grep: 9, Agent: 2, Write: 2, TodoWrite: 1, Glob: 4, WebFetch: 0 },
    tokens: { input: 212_000, output: 38_000, cacheRead: 384_000, cacheWrite: 62_000 },
    costUsd: 9.4,
    frictions: [{ kind: "tool_error", at: 0.28, detail: "airflow CLI timeout" }],
    timeline: buildTimeline(7, 1000 * 60 * 38, [0.28]),
    subAgents: 2,
    filesChanged: 5,
    commits: 1,
  },
  {
    id: "s_h2c6",
    project: "marketing-site",
    cwd: "~/dev/work/marketing-site",
    startedAt: "2026-04-18T10:12:00Z",
    durationMs: 1000 * 60 * 52,
    model: "sonnet-5.5",
    outcome: "fully_achieved",
    satisfaction: 0.83,
    goal: "Convert blog posts to MDX with frontmatter",
    summary: "Bulk conversion of 23 markdown posts. Automated via sub-agent fan-out.",
    messages: 11,
    toolCounts: { ...emptyCounts(), Read: 48, Edit: 23, Write: 23, Bash: 4, Grep: 6, Agent: 6, TodoWrite: 1, Glob: 12, WebFetch: 0 },
    tokens: { input: 156_000, output: 184_000, cacheRead: 342_000, cacheWrite: 48_000 },
    costUsd: 4.8,
    frictions: [],
    timeline: buildTimeline(8, 1000 * 60 * 52, []),
    subAgents: 6,
    filesChanged: 23,
    commits: 2,
  },
];

// Demo data is authored around one afternoon: shift it so the newest session
// started about an hour ago (the default 7d range shows it), and price it with
// the current table instead of hand-written costs.
const AUTHORED_NOW = Date.parse("2026-04-20T15:00:00Z");

export const sessions: Session[] = RAW_SESSIONS.map((s) => ({
  ...s,
  startedAt: new Date(Date.parse(s.startedAt) + (Date.now() - AUTHORED_NOW)).toISOString(),
  // Totals, not one request: the base tier (`costOf`).
  costUsd: costOf(s.model, s.tokens, 0),
}));
