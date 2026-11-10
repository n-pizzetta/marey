// The journal: what was done each day, by project (src/utils/journal.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJournal, dayLabel, dayStart, headlineOf, journalMarkdown } from "../src/utils/journal.ts";
import { costOf } from "../scripts/models.mjs";

const MIN = 60_000;
// Local times, so the days fall the same in any time zone.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(10, 9, 0);
const TOKENS = { input: 1_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000 };
const TURN_COST = costOf("opus-5.5", TOKENS);

let n = 0;
/** A session with a turn at each of `times`. */
function session(project, goal, times, extra = {}) {
  const start = times[0];
  return {
    id: `s${++n}`,
    project,
    startedAt: new Date(start).toISOString(),
    lastEventAt: new Date(times.at(-1)).toISOString(),
    durationMs: 30 * MIN,
    model: "opus-5.5",
    goal,
    summary: "",
    costUsd: times.length * TURN_COST,
    turns: times.map((t) => ({ t: t - start, tokens: TOKENS, tools: [] })),
    prompts: [{ t: 0, preview: "first prompt" }],
    ...extra,
  };
}

test("a headline is the session's title, else its first prompt that reads as a request", () => {
  const s = (goal, prompts = [], extra = {}) => ({ goal, summary: "", prompts: prompts.map((preview, i) => ({ t: i, preview })), ...extra });
  assert.equal(headlineOf(s("Add the export button")), "Add the export button");
  // A shell input or a continuation notice is not what the session was about.
  assert.equal(headlineOf(s("<bash-input> echo $X</bash-input>", ["<bash-input> echo $X</bash-input>", "Fix the flaky test"])), "Fix the flaky test");
  assert.equal(headlineOf(s("This session is being continued from a previous conversation", ["This session is being continued…", "Now add the tests"])), "Now add the tests");
  // A pasted block keeps its text: only the tags go.
  assert.equal(headlineOf(s(' <pasted_content id="4c9e"> Your job is to review this</pasted_content>')), "Your job is to review this");
  // A running session's own name says less than what it was asked.
  assert.equal(headlineOf(s("api-0b", ["Audit this project"], { liveName: "api-0b" })), "Audit this project");
  assert.equal(headlineOf(s("api-0b", [], { liveName: "api-0b" })), "api-0b");
  assert.equal(headlineOf(s("", [])), "Untitled session");
  const long = headlineOf(s("x".repeat(300)));
  assert.equal(long.length, 110);
  assert.ok(long.endsWith("…"));
});

test("days come newest first, projects by time spent, sessions in the order they started", () => {
  const journal = buildJournal(
    [
      session("api", "Second of the day", [at(9, 15), at(9, 15, 20)], { durationMs: 20 * MIN }),
      session("api", "First of the day", [at(9, 10), at(9, 10, 5)], { durationMs: 5 * MIN }),
      session("web", "The long one", [at(9, 11), at(9, 12)], { durationMs: 60 * MIN }),
      session("web", "Today's", [at(10, 8)], { durationMs: 3 * MIN }),
      session("old", "Out of the window", [at(1, 8)]),
      session("api", "A ghost", [at(9, 9)], { ghost: true }),
    ],
    { now: NOW, days: 7 },
  );
  assert.deepEqual(journal.map((d) => d.startMs), [dayStart(at(10, 0)), dayStart(at(9, 0))]);
  const [today, yesterday] = journal;
  assert.equal(today.sessions, 1);
  assert.deepEqual(yesterday.projects.map((p) => p.project), ["web", "api"]);
  assert.deepEqual(yesterday.projects[1].sessions.map((e) => e.headline), ["First of the day", "Second of the day"]);
  assert.equal(yesterday.projects[1].activeMs, 25 * MIN);
  assert.equal(yesterday.activeMs, 85 * MIN);
  assert.equal(yesterday.sessions, 3);
  assert.ok(Math.abs(yesterday.cost - 6 * TURN_COST) < 1e-9);
});

test("sessions running side by side count once in a project's and a day's time", () => {
  const minutes = (from, n) => Array.from({ length: n + 1 }, (_, i) => at(9, 14, from + i * 4));
  // Two sessions of one project over the same 20 minutes, a third in another project over the last 8 of them.
  const journal = buildJournal(
    [
      session("api", "One", minutes(0, 5), { durationMs: 20 * MIN }),
      session("api", "Two", minutes(0, 5), { durationMs: 20 * MIN }),
      session("web", "Three", minutes(12, 2), { durationMs: 8 * MIN }),
    ],
    { now: NOW, days: 7 },
  );
  const [day] = journal;
  assert.deepEqual(day.projects.map((p) => [p.project, Math.round(p.activeMs / MIN)]), [["api", 20], ["web", 8]]);
  // Each session keeps its own time; the day is the 20 minutes someone was at work.
  assert.deepEqual(day.projects[0].sessions.map((e) => e.activeMs), [20 * MIN, 20 * MIN]);
  assert.equal(Math.round(day.activeMs / MIN), 20);
});

test("a session over midnight is in both days, with each day's share of its time and its turns' value", () => {
  // Three turns 4 minutes apart before midnight (8 min of gaps), then two the next morning (4 min, after an idle night capped at 5).
  const s = session("api", "Late one", [at(8, 23, 40), at(8, 23, 44), at(8, 23, 48), at(9, 8, 0), at(9, 8, 4)], { durationMs: 34 * MIN });
  const journal = buildJournal([s], { now: NOW, days: 7 });
  const [second, first] = journal;
  assert.equal(first.startMs, dayStart(at(8, 0)));
  // Gaps: 8 min on the 8th, 5 (capped) + 4 on the 9th.
  assert.ok(Math.abs(first.activeMs - (34 * MIN * 8) / 17) < 1);
  assert.ok(Math.abs(second.activeMs - (34 * MIN * 9) / 17) < 1);
  assert.ok(Math.abs(first.cost - 3 * TURN_COST) < 1e-9);
  assert.ok(Math.abs(second.cost - 2 * TURN_COST) < 1e-9);
  assert.equal(second.projects[0].sessions[0].firstAt, at(9, 8, 0));
});

test("commits and pull requests go under the session that made them, on their day, once", () => {
  const pr = { at: at(9, 11, 30), url: "https://github.com/acme/api/pull/365", title: "feat: switch GitHub off" };
  const original = session("api", "Switch GitHub off", [at(9, 10), at(9, 11)], {
    commitLog: [{ at: at(9, 10, 30), subject: "feat: switch GitHub off" }, { at: at(9, 10, 50), subject: "test: cover it" }],
    prLog: [pr],
  });
  // A fork holds a copy of the same commit and pull request.
  const fork = session("api", "Aside", [at(9, 12)], { commitLog: [{ at: at(9, 10, 30) + 5_000, subject: "feat: switch GitHub off" }], prLog: [pr] });
  const [day] = buildJournal([fork, original], { now: NOW, days: 7 });
  assert.equal(day.commits, 2);
  assert.equal(day.prs, 1);
  const [first, second] = day.projects[0].sessions;
  assert.deepEqual(first.commits.map((c) => c.subject), ["feat: switch GitHub off", "test: cover it"]);
  assert.deepEqual(first.prs, [{ ...pr, number: "365" }]);
  assert.deepEqual(second.commits, []);
  assert.deepEqual(second.prs, []);
});

test("a day copies as Markdown: projects, sessions, and what each shipped", () => {
  const [day] = buildJournal(
    [
      session("api", "Switch GitHub off", [at(9, 10), at(9, 11)], {
        durationMs: 75 * MIN,
        commitLog: [{ at: at(9, 10, 30), subject: "feat: switch GitHub off" }],
        prLog: [{ at: at(9, 10, 40), url: "https://github.com/acme/api/pull/365", title: "feat: switch GitHub off" }, { at: at(9, 10, 50), url: "https://github.com/acme/api/pull/366", title: null }],
      }),
      session("web", "Review the toggle", [at(9, 14)], { durationMs: 12 * MIN }),
    ],
    { now: NOW, days: 7 },
  );
  assert.equal(
    journalMarkdown(day),
    [
      "## Monday 9 November",
      "",
      "**api** (1h 15m)",
      "- Switch GitHub off",
      "  - PR #365: feat: switch GitHub off (https://github.com/acme/api/pull/365)",
      "  - PR #366 (https://github.com/acme/api/pull/366)",
      "  - feat: switch GitHub off",
      "",
      "**web** (12m)",
      "- Review the toggle",
      "",
    ].join("\n"),
  );
});

test("days are named from today", () => {
  assert.equal(dayLabel(dayStart(NOW), NOW), "Today");
  assert.equal(dayLabel(dayStart(at(9, 12)), NOW), "Yesterday");
  assert.equal(dayLabel(dayStart(at(6, 12)), NOW), "Fri 6 Nov");
});
