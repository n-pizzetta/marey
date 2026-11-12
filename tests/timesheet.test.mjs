// Time by client: the journal's active time by the folder sessions ran under (src/utils/timesheet.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimesheet, formatHours, groupOf, groupRoot, OTHER, periodOf, timesheetCsv, timesheetFileName } from "../src/utils/timesheet.ts";

const MIN = 60_000;
// Local times, so the days fall the same in any time zone. Wednesday 11 November 2026.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(11, 15);
const day = (ts) => new Date(ts).toDateString();

let n = 0;
/** A session in `cwd` with a turn every 4 minutes from `start`, `minutes` long. */
function session(cwd, start, minutes) {
  const times = Array.from({ length: minutes / 4 + 1 }, (_, i) => start + i * 4 * MIN);
  return {
    id: `s${++n}`,
    project: cwd.split("/").at(-1),
    cwd,
    startedAt: new Date(start).toISOString(),
    lastEventAt: new Date(times.at(-1)).toISOString(),
    durationMs: minutes * MIN,
    model: "opus-5.5",
    goal: "Work",
    summary: "",
    costUsd: 0,
    turns: times.map((t) => ({ t: t - start, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, tools: [] })),
    prompts: [],
  };
}

test("a period is a week from Monday or a calendar month", () => {
  const names = (id) => Object.values(periodOf(id, NOW)).map(day);
  assert.deepEqual(names("week"), ["Mon Nov 09 2026", "Mon Nov 16 2026"]);
  assert.deepEqual(names("last-week"), ["Mon Nov 02 2026", "Mon Nov 09 2026"]);
  assert.deepEqual(names("month"), ["Sun Nov 01 2026", "Tue Dec 01 2026"]);
  assert.deepEqual(names("last-month"), ["Thu Oct 01 2026", "Sun Nov 01 2026"]);
  // A Sunday belongs to the week that started six days before.
  assert.equal(day(periodOf("week", at(15, 23)).from), "Mon Nov 09 2026");
});

test("the groups' folder is the one whose sub-folders each hold several projects", () => {
  const work = ["/home/me/work/acme/api", "/home/me/work/acme/web", "/home/me/work/globex/brain", "/home/me/work/globex/portal/app"];
  assert.equal(groupRoot(work), "/home/me/work");
  // Other folders beside it, and a tool's own, change nothing.
  assert.equal(groupRoot([...work, "/home/me/sandbox/toy", "/home/me", "/home/me/.copilot/chats/a/x", "/home/me/.copilot/chats/a/y", "/home/me/.copilot/chats/b/x", "/home/me/.copilot/chats/b/y", "/home/me/.copilot/chats/c/x", "/home/me/.copilot/chats/c/y"]), "/home/me/work");
  // Projects side by side in one folder: no such layout.
  assert.equal(groupRoot(["/home/me/code/api", "/home/me/code/web", "/home/me/code/brain"]), null);
  assert.equal(groupRoot([undefined, "", "relative/path"]), null);
  assert.equal(groupOf("/home/me/work/globex/portal/app", "/home/me/work"), "globex");
  assert.equal(groupOf("/home/me/work/globex", "/home/me/work"), "globex");
  assert.equal(groupOf("/home/me/work", "/home/me/work"), OTHER);
  assert.equal(groupOf("/home/me/workshop/x", "/home/me/work"), OTHER);
});

const SESSIONS = [
  // Monday: two acme projects over the same 40 minutes, and globex for 20 of them.
  session("/home/me/work/acme/api", at(9, 10), 40),
  session("/home/me/work/acme/web", at(9, 10), 40),
  session("/home/me/work/globex/brain", at(9, 10, 20), 20),
  // Tuesday: acme again, a namesake of globex's project under acme, and something outside.
  session("/home/me/work/acme/api", at(10, 14), 60),
  session("/home/me/work/acme/brain", at(10, 16), 20),
  session("/home/me/sandbox/toy", at(10, 9), 12),
  // Last week, and a session opened and closed.
  session("/home/me/work/globex/portal", at(5, 9), 80),
  { ...session("/home/me/work/globex/brain", at(11, 9), 4), durationMs: 20_000 },
];

test("a group's time counts its projects side by side once, by day", () => {
  const sheet = buildTimesheet(SESSIONS, periodOf("week", NOW));
  assert.equal(sheet.root, "/home/me/work");
  assert.deepEqual(
    sheet.rows.map((r) => [new Date(r.dayMs).getDate(), r.group, Math.round(r.activeMs / MIN), r.projects.map((p) => `${p.name} ${Math.round(p.activeMs / MIN)}`).join(", ")]),
    [
      [9, "acme", 40, "api 40, web 40"],
      [9, "globex", 20, "brain 20"],
      [10, OTHER, 12, "toy 12"],
      [10, "acme", 80, "api 60, brain 20"],
    ],
  );
  // Most active first, what is outside the folder last; the total counts acme and globex's shared 20 minutes once.
  assert.deepEqual(sheet.groups.map((g) => [g.name, Math.round(g.activeMs / MIN), g.days]), [["acme", 120, 2], ["globex", 20, 1], [OTHER, 12, 1]]);
  assert.deepEqual(sheet.groups[0].projects.map((p) => [p.name, Math.round(p.activeMs / MIN)]), [["api", 100], ["web", 40], ["brain", 20]]);
  assert.equal(Math.round(sheet.activeMs / MIN), 40 + 12 + 80);
  assert.deepEqual(buildTimesheet(SESSIONS, periodOf("last-week", NOW)).groups.map((g) => [g.name, Math.round(g.activeMs / MIN)]), [["globex", 80]]);
});

test("without a folder of groups, each project is its own", () => {
  const flat = [session("/home/me/code/api", at(9, 10), 40), session("/home/me/code/web", at(9, 10), 20)];
  const sheet = buildTimesheet(flat, periodOf("week", NOW));
  assert.equal(sheet.root, null);
  assert.deepEqual(sheet.groups.map((g) => [g.name, Math.round(g.activeMs / MIN)]), [["api", 40], ["web", 20]]);
});

test("the sheet exports as CSV, a line per day and group, hours in decimal", () => {
  const sheet = buildTimesheet([...SESSIONS, session('/home/me/work/acme/say "hi", twice', at(11, 9), 20)], periodOf("week", NOW));
  assert.equal(timesheetFileName(sheet), "timesheet-2026-11-09_2026-11-15.csv");
  assert.equal(
    timesheetCsv(sheet),
    [
      "date,group,hours,projects",
      "2026-11-09,acme,0.67,api (0.67 h); web (0.67 h)",
      "2026-11-09,globex,0.33,brain (0.33 h)",
      "2026-11-10,Other,0.20,toy (0.20 h)",
      "2026-11-10,acme,1.33,api (1.00 h); brain (0.33 h)",
      '2026-11-11,acme,0.33,"say ""hi"", twice (0.33 h)"',
      "",
    ].join("\n"),
  );
  assert.equal(formatHours(103 * 60 * MIN + 5 * MIN), "103h 05m");
  assert.equal(formatHours(42 * MIN), "42m");
});
