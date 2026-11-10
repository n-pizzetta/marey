// What a session shipped, read from its shell commands: commit subjects and pull requests
// (scripts/transcript-utils.mjs), and the title Claude Code gives a session (scripts/parse-sessions.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitsOf, createShipLog } from "../scripts/transcript-utils.mjs";

const root = mkdtempSync(join(tmpdir(), "marey-ship-"));
const CLAUDE = join(root, ".claude");
const PROJECT = join(CLAUDE, "projects", "-tmp-x");
const ID = "11111111-1111-4111-8111-111111111111";
const PLAIN = "22222222-2222-4222-8222-222222222222";

const ts = (s) => new Date(Date.UTC(2026, 10, 9, 10, 0, s)).toISOString();
const user = (s, text) => JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), message: { role: "user", content: text } });
const bash = (s, command) =>
  JSON.stringify({ type: "assistant", timestamp: ts(s), message: { id: `m${s}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: `t${s}`, name: "Bash", input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (s, of, text, isError = false) =>
  JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${of}`, content: text, is_error: isError }] } });

let session;
let plain;

before(async () => {
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(
    join(PROJECT, `${ID}.jsonl`),
    `${[
      user(0, "<bash-input>pwd</bash-input>"),
      JSON.stringify({ type: "ai-title", aiTitle: "Switch GitHub off", sessionId: ID }),
      bash(1, 'git add -A && git commit -q -m "feat: switch GitHub off" -m "Trailer: x"'),
      result(2, 1, "[main 1a2b3c4] feat: switch GitHub off"),
      bash(3, 'git commit -m "fix: rejected by the hook"'),
      result(4, 3, "pre-commit hook failed", true),
      bash(5, "git commit -q -F - <<'EOF'\ntest: cover the switch\n\nBody.\nEOF"),
      result(6, 5, "[main 5d6e7f8] test: cover the switch"),
      bash(7, 'rg -n "commits|git commit|prs" scripts'),
      result(8, 7, "scripts/x.mjs:1: git commit"),
      bash(9, 'gh pr create --title "feat: switch GitHub off" --body "Why."'),
      result(10, 9, "Creating pull request for feat/off into main\nhttps://github.com/acme/api/pull/365\n"),
      bash(11, "gh pr create --fill"),
      result(12, 11, "a pull request for branch already exists", true),
      JSON.stringify({ type: "ai-title", aiTitle: "Switch GitHub off and cover it", sessionId: ID }),
    ].join("\n")}\n`,
  );
  // Its own message ids: a message two transcripts both hold is a copy, counted in one of them only.
  writeFileSync(join(PROJECT, `${PLAIN}.jsonl`), `${[user(20, "Rename the helper"), bash(21, "ls"), result(22, 21, "a b")].join("\n")}\n`);
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  const { sessions } = await parseAllSessions({ light: true });
  session = sessions.find((s) => s.id === ID);
  plain = sessions.find((s) => s.id === PLAIN);
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a commit's subject is read from -m, a heredoc, or not at all", () => {
  assert.deepEqual(commitsOf('git commit -q -m "chore: add config" -m "Trailer: x"'), ["chore: add config"]);
  assert.deepEqual(commitsOf("rtk proxy git add -A && rtk proxy git commit -q -F - <<'EOF'\nfeat(models): add fable 5.2\n\nBody\nEOF"), ["feat(models): add fable 5.2"]);
  assert.deepEqual(commitsOf("git commit -m \"$(cat <<'EOF'\nfix(parser): count once\n\nBody\nEOF\n)\""), ["fix(parser): count once"]);
  assert.deepEqual(commitsOf("cd x && FOO=1 git -C ../repo commit -am 'wip: half way'"), ["wip: half way"]);
  assert.deepEqual(commitsOf('git commit --message="feat: with equals"'), ["feat: with equals"]);
  // A commit, with nothing to read: no new message, or one the shell still has to expand.
  assert.deepEqual(commitsOf("git commit --amend --no-edit"), [null]);
  assert.deepEqual(commitsOf('git commit -m "$MSG"'), [null]);
  // Not a commit: the words in a search or a string.
  assert.deepEqual(commitsOf('rg -n "commits|git commit|prs" scripts'), []);
  assert.deepEqual(commitsOf('echo "git commit"'), []);
  assert.deepEqual(commitsOf("git status"), []);
});

test("a heredoc's body is text, not commands, and a command can make several commits", () => {
  // A script or a fixture written to a file commits nothing, whatever it holds.
  assert.deepEqual(commitsOf("cat > notes.sh <<'EOF'\ngit add -A\ngit commit -m \"x\"\nEOF"), []);
  assert.deepEqual(commitsOf("python3 - <<'PY'\nlog.command('a && git commit -m \"fake\"')\nPY\ngit commit -m \"real\""), ["real"]);
  // The body of a commit's own message neither.
  assert.deepEqual(commitsOf("git commit -F - <<'EOF'\ndocs: how to commit\n\ngit commit -m \"example\"\nEOF"), ["docs: how to commit"]);
  // Two commits: each keeps its own message, the first its heredoc and not the second's -m.
  assert.deepEqual(
    commitsOf("git add src && git commit -q -F - <<'EOF'\nfix(journal): copy one project\n\nBody.\nEOF\ngit add -A dist && git commit -q -m \"build: rebuild dist\""),
    ["fix(journal): copy one project", "build: rebuild dist"],
  );
  assert.deepEqual(commitsOf('git commit -m "one" && git commit --amend --no-edit && git commit -m "two"'), ["one", null, "two"]);
  // Neither does a quoted string, however many lines it runs over; a quote in a comment opens none.
  assert.deepEqual(commitsOf("node -e '\ncheck(\"cd x && git commit -m \\\"x\\\"\");\ngit commit -m \"y\"\n'"), []);
  assert.deepEqual(commitsOf('echo "tests && git commit"; git commit -m "it\'s done"'), ["it's done"]);
  assert.deepEqual(commitsOf("# don't skip the hook\ngit commit -m \"real\""), ["real"]);
  // A here-string and a shift open no heredoc.
  assert.deepEqual(commitsOf('grep -c x <<< "$OUT" && git commit -m "after a here-string"'), ["after a here-string"]);
  const log = createShipLog();
  log.command("cat > t.sh <<'EOF'\ngh pr create --title \"fake\"\nEOF", 1);
  const both = log.command('git commit -m "one" && git commit -m "two"', 2);
  log.result(log.command('git commit -m "three" && git commit -m "four"', 3), "hook failed", true);
  assert.equal(both.commits.length, 2);
  assert.deepEqual(log.snapshot(), { commitLog: [{ tsMs: 2, subject: "one", msgId: null }, { tsMs: 2, subject: "two", msgId: null }], prLog: [] });
});

test("the log keeps commits that went through and the pull requests that were opened", () => {
  const log = createShipLog();
  const pr = log.command('gh pr create --title "feat: forecast" --body "x"', 1, "m1");
  log.result(pr, "https://github.com/acme/web/pull/113\n", false);
  log.result(pr, "https://github.com/acme/web/pull/113\n", false);
  const untitled = log.command('gh pr create --title "$T"', 2);
  log.result(untitled, "https://github.example.com/acme/web/pull/114", false);
  log.result(log.command('git commit -m "bad"', 3), "hook failed", true);
  log.failed(log.command('git commit -m "killed"', 4));
  log.command('git commit -m "good"', 5);
  log.command("git commit --amend --no-edit", 6);
  assert.equal(log.command("ls", 7), null);
  assert.deepEqual(log.snapshot(), {
    commitLog: [{ tsMs: 5, subject: "good", msgId: null }],
    prLog: [
      { tsMs: 1, msgId: "m1", title: "feat: forecast", url: "https://github.com/acme/web/pull/113" },
      { tsMs: 2, msgId: null, title: null, url: "https://github.example.com/acme/web/pull/114" },
    ],
  });
});

test("the parser logs what a Claude Code session shipped and counts only real commits", () => {
  assert.deepEqual(session.commitLog.map((c) => c.subject), ["feat: switch GitHub off", "test: cover the switch"]);
  assert.equal(session.commitLog[0].at, Date.parse(ts(1)));
  // The rejected commit is still an attempt; the search for "git commit" is not one.
  assert.equal(session.commits, 3);
  assert.deepEqual(session.prLog, [{ at: Date.parse(ts(9)), url: "https://github.com/acme/api/pull/365", title: "feat: switch GitHub off" }]);
  assert.deepEqual(plain.commitLog, []);
  assert.deepEqual(plain.prLog, []);
});

test("Claude Code's own title names the session, its latest one, before the first prompt", async () => {
  assert.equal(session.goal, "Switch GitHub off and cover it");
  assert.equal(plain.goal, "Rename the helper");
  const { summarizeSession } = await import("../scripts/parse-sessions.mjs");
  // The list carries the logs only when there is something in them.
  assert.equal(summarizeSession(session).commitLog.length, 2);
  assert.equal("commitLog" in summarizeSession(plain), false);
  assert.equal("prLog" in summarizeSession(plain), false);
});
