// What a session shipped, read from its shell commands: commit subjects and pull requests
// (scripts/transcript-utils.mjs), and the title Claude Code gives a session (scripts/parse-sessions.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitOf, createShipLog } from "../scripts/transcript-utils.mjs";

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
  assert.equal(commitOf('git commit -q -m "chore: add config" -m "Trailer: x"'), "chore: add config");
  assert.equal(commitOf("rtk proxy git add -A && rtk proxy git commit -q -F - <<'EOF'\nfeat(models): add fable 5.2\n\nBody\nEOF"), "feat(models): add fable 5.2");
  assert.equal(commitOf("git commit -m \"$(cat <<'EOF'\nfix(parser): count once\n\nBody\nEOF\n)\""), "fix(parser): count once");
  assert.equal(commitOf("cd x && FOO=1 git -C ../repo commit -am 'wip: half way'"), "wip: half way");
  assert.equal(commitOf('git commit --message="feat: with equals"'), "feat: with equals");
  // A commit, with nothing to read: no new message, or one the shell still has to expand.
  assert.equal(commitOf("git commit --amend --no-edit"), null);
  assert.equal(commitOf('git commit -m "$MSG"'), null);
  // Not a commit: the words in a search or a string.
  assert.equal(commitOf('rg -n "commits|git commit|prs" scripts'), undefined);
  assert.equal(commitOf('echo "git commit"'), undefined);
  assert.equal(commitOf("git status"), undefined);
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
