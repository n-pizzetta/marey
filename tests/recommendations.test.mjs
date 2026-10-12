import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHead, errorKey, stripNoise } from "../scripts/known-frictions.mjs";
import { buildRecommendations } from "../scripts/recommendations.mjs";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const DAY = 86_400_000;
const ZOXIDE = "zoxide: detected a possible configuration issue.\nPlease ensure that zoxide is initialized right at the end of your shell configuration file (usually ~/.zshrc).\n\nDisable this message by setting _ZO_DOCTOR=0.\n\n";

let seq = 0;
function session(incidents, { agent = "claude", daysAgo = 0, toolResults } = {}) {
  const at = NOW - daysAgo * DAY;
  return {
    id: `00000000-0000-4000-a000-${String(++seq).padStart(12, "0")}`,
    agent,
    goal: "A demo session",
    project: "demo",
    startedAt: new Date(at - 3_600_000).toISOString(),
    lastEventAt: new Date(at).toISOString(),
    toolCounts: { Bash: 10 },
    incidentStats: { toolResults: toolResults ?? 10 },
    incidents: incidents.map((i) => ({ t: at - 60_000, ...i })),
  };
}
const error = (text, extra = {}) => ({ kind: "error", tool: "Bash", command: "find . -name *.pyc -delete", text, ...extra });
const denial = (command, denialKind = "automode-blocked") => ({ kind: "denial", denial: denialKind, tool: "Bash", command, text: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier. If you have other tasks…" });
const ids = (r) => r.cards.map((c) => c.id);

test("noise is stripped and reported, so it never hides the real error", () => {
  const { text, noise } = stripNoise(`Exit code 1\n${ZOXIDE}(eval):1: no matches found: *.pyc`);
  assert.deepEqual(noise, ["zoxide-doctor"]);
  assert.equal(text, "Exit code 1\n(eval):1: no matches found: *.pyc");
});

test("error keys ignore paths, ids and numbers, and are null when only an exit code is left", () => {
  assert.equal(errorKey("Exit code 1"), null);
  assert.equal(errorKey("Error: command exited with code 1"), null);
  const long = "/private/tmp/claude-501/-Users-someone-a-very-long-project-name/1898fbe2-3c68-4a6b-92e3-e8cd6f8faf60/scratchpad";
  assert.equal(
    errorKey(`Error: File access denied: ${long}/a.png is outside allowed roots. Allowed roots: /Users/someone/project`),
    errorKey("Error: File access denied: /tmp/b.png is outside allowed roots. Allowed roots: /Users/other/x"),
  );
});

test("command heads skip cd, env assignments, flags and arguments", () => {
  assert.equal(commandHead("gh pr merge 78 --squash"), "gh pr merge");
  assert.equal(commandHead("cd /a/b && FOO=1 pnpm test --run"), "pnpm test");
  assert.equal(commandHead("T=$(gcloud auth print-access-token) && curl -H x"), "gcloud auth print-access-token");
  assert.equal(commandHead("export A=b; ls -la"), "ls");
});

test("a known cause shows from three sessions, with its fix", () => {
  const nomatch = error("Exit code 1\n(eval):1: no matches found: *.pyc");
  assert.ok(!ids(buildRecommendations([session([nomatch]), session([nomatch])], { now: NOW })).includes("cause:zsh-nomatch"));
  const r = buildRecommendations([session([nomatch]), session([nomatch]), session([nomatch, nomatch])], { now: NOW });
  const card = r.cards.find((c) => c.id === "cause:zsh-nomatch");
  assert.equal(card.sessionCount, 3);
  assert.equal(card.count, 4);
  assert.match(card.title, /^4 commands failed/);
  assert.match(card.action.snippet, /setopt nonomatch/);
  assert.match(card.action.prompt, /setopt nonomatch/);
});

test("noise gets its own card while the errors it was attached to keep their cause", () => {
  const withNoise = error("Exit code 1\n(eval):1: no matches found: *.pyc", { noise: ["zoxide-doctor"] });
  const r = buildRecommendations([session([withNoise]), session([withNoise]), session([withNoise])], { now: NOW });
  assert.ok(ids(r).includes("noise:zoxide-doctor"));
  assert.ok(ids(r).includes("cause:zsh-nomatch"));
});

test("denials: protective commands are never suggested as allow rules, user rejections are left out", () => {
  const sessions = [
    session([denial("gh pr merge 42 --squash"), denial("pnpm dlx depcheck")]),
    session([denial("gh pr merge 43 --squash"), denial("pnpm dlx depcheck --json")]),
    session([denial("rm -rf build", "user-rejected")]),
  ];
  const card = buildRecommendations(sessions, { now: NOW }).cards.find((c) => c.id === "denials");
  assert.equal(card.count, 4);
  assert.deepEqual(card.rows.map((r) => [r.label, r.protective]), [["gh pr merge", true], ["pnpm dlx depcheck", false]]);
  assert.match(card.action.snippet, /"Bash\(pnpm dlx depcheck \*\)"/);
  assert.doesNotMatch(card.action.snippet, /merge/);
  assert.match(card.action.prompt, /Leave the others denied/);
});

test("long waits make a card only when they happened this week", () => {
  const wait = (daysAgo) => session([{ kind: "wait", tool: "AskUserQuestion", ms: 25 * 60_000, text: "Which one?" }], { daysAgo });
  assert.ok(!ids(buildRecommendations([wait(10), wait(11), wait(12), wait(1)], { now: NOW })).includes("waits"));
  const card = buildRecommendations([wait(1), wait(2), wait(3)], { now: NOW }).cards.find((c) => c.id === "waits");
  assert.match(card.title, /3 times this week/);
  assert.equal(card.sessions[0].waitMs, 25 * 60_000);
});

test("harness errors and one-off failures make no card; the same unknown error across sessions does", () => {
  const harness = error("<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", { tool: "Write" });
  assert.equal(buildRecommendations([session([harness]), session([harness]), session([harness])], { now: NOW }).cards.length, 0);
  const odd = (p) => error(`Error: invalid value '${p}' for '--out <dir>'`, { command: `mkdir -p ${p}` });
  const r = buildRecommendations([session([odd("/tmp/a")]), session([odd("/var/b/c")]), session([odd("/x")])], { now: NOW });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].kind, "recurring");
  assert.match(r.cards[0].title, /mkdir/);
});

test("Codex sessions and sessions outside the window are not counted", () => {
  const nomatch = error("Exit code 1\n(eval):1: no matches found: *.pyc");
  const r = buildRecommendations([session([nomatch], { agent: "codex" }), session([nomatch], { daysAgo: 40 }), session([nomatch])], { now: NOW });
  assert.equal(r.coverage.sessions, 1);
  assert.equal(r.cards.length, 0);
});

test("coverage warns when tool calls were found but no result could be read", () => {
  const s = session([], { toolResults: 0 });
  s.toolCounts = { Bash: 80 };
  const r = buildRecommendations([s], { now: NOW });
  assert.match(r.coverage.warning, /none of their results could be read/);
  assert.equal(buildRecommendations([session([])], { now: NOW }).coverage.warning, undefined);
});

test("prompts carry the evidence they need", () => {
  const sandbox = error("Claude requested permissions to write to /Users/someone/.cache/tool/x, but you haven't granted it yet.");
  const card = buildRecommendations([session([sandbox]), session([sandbox]), session([sandbox])], { now: NOW }).cards[0];
  assert.equal(card.id, "cause:sandbox-write");
  assert.match(card.action.prompt, /\.cache\/tool/);
  const missing = error("Exit code 127\nzsh: command not found: timeout", { command: "timeout 20 claude agents" });
  const rec = buildRecommendations([session([missing]), session([missing]), session([missing])], { now: NOW }).cards[0];
  assert.match(rec.title, /`timeout` isn't installed/);
  assert.match(rec.action.prompt, /timeout/);
});

test("counts the sessions started since a cause last happened", () => {
  const nomatch = error("Exit code 1\n(eval):1: no matches found: *.pyc");
  const older = [session([nomatch], { daysAgo: 3 }), session([nomatch], { daysAgo: 3 }), session([nomatch], { daysAgo: 3 })];
  const card = buildRecommendations([...older, session([]), session([])], { now: NOW }).cards[0];
  assert.equal(card.sessionsSince, 2);
});
