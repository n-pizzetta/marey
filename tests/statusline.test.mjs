// The status line wrapper's previous command and its installer (scripts/statusline.mjs, scripts/install-statusline.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WRAPPER = resolve("scripts/statusline.mjs");
const PAYLOAD = JSON.stringify({ session_id: "s", model: { display_name: "Opus" } });

/** A config dir whose saved previous status line is `command`. */
function withPrevious(command) {
  const claude = mkdtempSync(join(tmpdir(), "marey-statusline-"));
  mkdirSync(join(claude, "marey"));
  writeFileSync(join(claude, "marey", "statusline.json"), JSON.stringify({ previous: { type: "command", command } }));
  return claude;
}

const refresh = (claude) => {
  const t0 = Date.now();
  const out = execFileSync(process.execPath, [WRAPPER], { input: PAYLOAD, env: { ...process.env, CLAUDE_CONFIG_DIR: claude }, encoding: "utf8", timeout: 20_000 });
  return { out, ms: Date.now() - t0 };
};

test("a previous command that leads back to the wrapper runs it once, not forever", { skip: process.platform === "win32" }, () => {
  const runs = join(mkdtempSync(join(tmpdir(), "marey-runs-")), "runs");
  // Stops at 3 levels by itself, should the guard ever break.
  const { out, ms } = refresh(withPrevious(`echo run >> "${runs}"; [ "$(wc -l < "${runs}")" -le 3 ] && node "${WRAPPER}"`));
  assert.equal(out, "\x1b[1mOpus\x1b[0m");
  assert.equal(readFileSync(runs, "utf8"), "run\n");
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test("a previous command that hangs is stopped after 3 s, with what it started", { skip: process.platform === "win32" }, () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "marey-runs-")), "sleep.pid");
  const { out, ms } = refresh(withPrevious(`sleep 30 & echo $! > "${pidFile}"; echo partial; wait`));
  assert.equal(out, "\x1b[1mOpus\x1b[0m");
  assert.ok(ms >= 3000 && ms < 10_000, `took ${ms}ms`);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("the limits and live snapshots are owner-only", { skip: process.platform === "win32" }, () => {
  const claude = mkdtempSync(join(tmpdir(), "marey-statusline-"));
  const id = "11111111-2222-3333-4444-555555555555";
  const reset = Math.floor(Date.now() / 1000) + 3600;
  execFileSync(process.execPath, [WRAPPER], {
    input: JSON.stringify({ session_id: id, context_window: { context_window_size: 200_000 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: reset } } }),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claude },
  });
  const mode = (...p) => statSync(join(claude, "marey", ...p)).mode & 0o777;
  assert.equal(mode(), 0o700);
  assert.equal(mode("live"), 0o700);
  assert.equal(mode("live", `${id}.json`), 0o600);
  assert.equal(mode("limits.json"), 0o600);
  assert.equal(mode("limits-history.jsonl"), 0o600);
});

/** Runs the installer on `claude` with no Codex or Copilot CLI around. */
function install(claude) {
  const empty = mkdtempSync(join(tmpdir(), "marey-bin-"));
  return execFileSync(process.execPath, ["scripts/install-statusline.mjs"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(empty, "codex"), PATH: empty },
    encoding: "utf8",
  });
}

test("the installer knows its wrapper under another spelling of its path", () => {
  const root = mkdtempSync(join(tmpdir(), "marey-install-"));
  const claude = join(root, "claude");
  mkdirSync(claude);
  symlinkSync(claude, join(root, "link"));
  for (const dir of ["marey", "ccblackbox"]) {
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${join(root, "link", dir, "statusline.mjs")}"` } }));
    assert.match(install(claude), /status line already installed/);
    assert.equal(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).statusLine.command, `node "${join(claude, "marey", "statusline.mjs")}"`);
    assert.ok(!existsSync(join(claude, "marey", "statusline.json")), "not saved as the previous status line");
  }
});

test("the installer writes through a symlinked settings.json and keeps its mode", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "marey-install-"));
  const claude = join(root, "claude");
  const dotfiles = join(root, "dotfiles");
  for (const d of [claude, dotfiles]) mkdirSync(d);
  const real = join(dotfiles, "settings.json");
  writeFileSync(real, JSON.stringify({ env: { SOME_KEY: "secret" } }));
  chmodSync(real, 0o600);
  symlinkSync(real, join(claude, "settings.json"));

  install(claude);

  assert.ok(lstatSync(join(claude, "settings.json")).isSymbolicLink());
  const settings = JSON.parse(readFileSync(real, "utf8"));
  assert.equal(settings.env.SOME_KEY, "secret");
  assert.equal(settings.statusLine.command, `node "${join(claude, "marey", "statusline.mjs")}"`);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(claude, "settings.json.marey.bak"), "utf8")).env.SOME_KEY, "secret");
});

test("an install caught in the loop forgets the wrapper saved as its previous status line", () => {
  const root = mkdtempSync(join(tmpdir(), "marey-install-"));
  const claude = join(root, "claude");
  mkdirSync(join(claude, "marey"), { recursive: true });
  symlinkSync(claude, join(root, "link"));
  const self = { type: "command", command: `node "${join(root, "link", "marey", "statusline.mjs")}"` };
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ statusLine: { ...self, command: `node "${join(claude, "marey", "statusline.mjs")}"` } }));
  writeFileSync(join(claude, "marey", "statusline.json"), JSON.stringify({ previous: self, verdict: false }));

  install(claude);
  assert.deepEqual(JSON.parse(readFileSync(join(claude, "marey", "statusline.json"), "utf8")), { previous: null, verdict: false });

  // An uninstall with the wrapper still saved restores nothing that points at it.
  writeFileSync(join(claude, "marey", "statusline.json"), JSON.stringify({ previous: self }));
  const empty = mkdtempSync(join(tmpdir(), "marey-bin-"));
  execFileSync(process.execPath, ["scripts/install-statusline.mjs", "--uninstall"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(empty, "codex"), PATH: empty },
  });
  assert.equal(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).statusLine, undefined);
});
