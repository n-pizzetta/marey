#!/usr/bin/env node
/**
 * Marey status line wrapper.
 *
 * Claude Code pipes a JSON payload to the status line command on every
 * refresh. It is the only place the real usage limits (`rate_limits`: 5-hour
 * and 7-day windows, as shown by `/usage`) are exposed, so this wrapper:
 *   1. records `rate_limits` to ~/.claude/marey/limits.json, keeping the freshest
 *      reading of each window across sessions (and, when it changes, appends it to
 *      limits-history.jsonl, used to calibrate "% of window"),
 *   2. writes a sanitized per-session snapshot (context size, prompt-cache state) to
 *      ~/.claude/marey/live/<session_id>.json for the dashboard,
 *   3. hands the untouched payload to the user's previous status line command
 *      (saved by install-statusline.mjs, given 3 s), or prints a minimal line if none, and appends
 *      a short context / cache segment with a "compact? clear?" hint. Turn that segment
 *      off with {"verdict": false} in ~/.claude/marey/statusline.json.
 *
 * Installed to ~/.claude/marey/statusline.mjs by install-statusline.mjs.
 * Must stay fast and never fail: the status line renders on every turn.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Honors CLAUDE_CONFIG_DIR, like Claude Code.
const DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "marey");
const LIMITS = join(DIR, "limits.json");
const HISTORY = join(DIR, "limits-history.jsonl");
const LIVE = join(DIR, "live");
const HISTORY_MAX_BYTES = 512 * 1024;
/** Set for the previous command, so a wrapper it leads back to doesn't run it again. */
const NESTED = "MAREY_STATUSLINE";
const PREVIOUS_TIMEOUT_MS = 3000;

// Shared with the dashboard. Installed next to this file; if it is missing (older install),
// the context features are skipped and the rest keeps working.
let advice = null;
try {
  advice = await import("./context-advice.mjs");
} catch {
  /* no context advice */
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const win = (w) => (w && typeof w.used_percentage === "number" ? { p: w.used_percentage, r: w.resets_at ?? null } : null);
const WINDOWS = ["five_hour", "seven_day"];

/**
 * The fresher of two readings of one window, as freshestWindow in parse-sessions.mjs does: every
 * running session refreshes its status line with its own last-known limits, so an idle one reports
 * a lower %, or a window that has reset since. A later reset wins; within a window, the higher %;
 * a reading without an open window never replaces one that is still open. `now` in seconds.
 */
function freshest(held, read, now) {
  const open = (w) => typeof w?.used_percentage === "number" && typeof w.resets_at === "number" && w.resets_at > now;
  if (!open(held)) return read ?? null;
  if (!open(read) || read.resets_at < held.resets_at) return held;
  if (read.resets_at > held.resets_at) return read;
  return read.used_percentage >= held.used_percentage ? read : held;
}

/** One line per change of either window: a new window or a higher %, never a stale session's flip back. */
function appendHistory(held, cur) {
  const pick = (rl) => JSON.stringify({ five: win(rl.five_hour), seven: win(rl.seven_day) });
  if (held && pick(held) === pick(cur)) return;
  appendFileSync(HISTORY, JSON.stringify({ t: Date.now(), five: win(cur.five_hour), seven: win(cur.seven_day) }) + "\n");
  if (statSync(HISTORY).size > HISTORY_MAX_BYTES) {
    const lines = readFileSync(HISTORY, "utf8").split("\n").filter(Boolean);
    writeFileSync(HISTORY, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n");
  }
}

/** Keeps the freshest limits in limits.json, whichever session refreshed last. */
function record(payload) {
  if (!payload?.rate_limits) return;
  try {
    mkdirSync(DIR, { recursive: true });
    let held = null;
    try {
      held = JSON.parse(readFileSync(LIMITS, "utf8")).rate_limits ?? null;
    } catch {
      /* no previous capture: first line */
    }
    const now = Date.now() / 1000;
    const cur = { ...payload.rate_limits };
    for (const key of WINDOWS) {
      const w = freshest(held?.[key], payload.rate_limits[key], now);
      if (w) cur[key] = w;
      else delete cur[key];
    }
    appendHistory(held, cur);
    const tmp = join(DIR, `limits.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ capturedAt: Date.now(), rate_limits: cur }));
    renameSync(tmp, LIMITS);
  } catch {
    /* never break the status line */
  }
}

function writeSnapshot(snap) {
  if (!snap) return;
  try {
    mkdirSync(LIVE, { recursive: true });
    const tmp = join(LIVE, `${snap.sessionId}.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, join(LIVE, `${snap.sessionId}.json`));
  } catch {
    /* never break the status line */
  }
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(DIR, "statusline.json"), "utf8"));
  } catch {
    return {};
  }
}

/** x.y.z comparison (this file is installed alone, so it can't import takeover.mjs). */
function newer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** "↑ Marey 0.6.0 · /marey:update" while the daily check (update-check.json) knows a newer version than the one running. */
function updateSegment() {
  try {
    if (JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")).updateCheck === false) return null;
  } catch {
    /* no config: the check is on */
  }
  try {
    const { installed, latest } = JSON.parse(readFileSync(join(DIR, "update-check.json"), "utf8"));
    return installed && latest && newer(latest, installed) ? `\x1b[33m↑ Marey ${latest} · /marey:update\x1b[0m` : null;
  } catch {
    return null;
  }
}

/** Append the context / cache segment and the update notice to the last line of what the previous status line printed. */
function withVerdict(out, snap) {
  const segs = [];
  if (advice && snap && readConfig().verdict !== false) segs.push(advice.statusSegment(snap));
  segs.push(updateSegment());
  const seg = segs.filter(Boolean).join(advice?.SEP ?? " · ");
  if (!seg) return out;
  const body = out.replace(/\n+$/, "");
  return body ? `${body}${advice?.SEP ?? " "}${seg}${out.endsWith("\n") ? "\n" : ""}` : seg;
}

function previousCommand() {
  const cmd = readConfig().previous?.command;
  return typeof cmd === "string" ? cmd : null;
}

const paint = (color, s) => `\x1b[${color}m${s}\x1b[0m`;
/** Green under 50%, yellow under 80%, red above. */
const usageColor = (pct) => (pct >= 80 ? 31 : pct >= 50 ? 33 : 32);

function fmtLeft(secs) {
  const m = Math.max(1, Math.ceil(secs / 60));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(m / 1440)}d`;
}

/** Show the weekly window only when it is close enough to matter. */
const WEEKLY_FROM = 80;

/** e.g. "Opus 5.5 │ 5h 10% reset 1h20", plus "7d 85% reset 2d" once the weekly window is nearly used. */
function fallbackLine(payload) {
  const groups = [];
  if (payload?.model?.display_name) groups.push(`\x1b[1m${payload.model.display_name}\x1b[0m`);
  const rl = payload?.rate_limits;
  const now = Date.now() / 1000;
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
    const w = rl?.[key];
    if (typeof w?.used_percentage !== "number") continue;
    const pct = Math.round(w.used_percentage);
    if (key === "seven_day" && pct < WEEKLY_FROM) continue;
    const reset = typeof w.resets_at === "number" && w.resets_at > now ? ` reset ${fmtLeft(w.resets_at - now)}` : "";
    groups.push(`${label} ${paint(usageColor(pct), `${pct}%`)}${reset}`);
  }
  return groups.join(advice?.SEP ?? " · ");
}

const input = readStdin();
let payload = null;
try {
  payload = JSON.parse(input);
} catch {
  /* pass through untouched */
}

// Run by our own previous command: it was saved pointing back at this wrapper (its path spelled
// another way), which would spawn itself forever. The outer run records and adds the segments.
if (process.env[NESTED]) {
  process.stdout.write(fallbackLine(payload));
  process.exit(0);
}

record(payload);
const snap = advice ? advice.toSnapshot(payload) : null;
writeSnapshot(snap);

// The previous command can break (e.g. a plugin update moves its versioned
// path): if it fails, hangs or prints nothing, show our own line instead of a blank one.
const next = previousCommand();
if (next) {
  // Its own process group, so a timeout also stops what the shell started.
  const posix = process.platform !== "win32";
  const child = spawn(next, { shell: true, detached: posix, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, [NESTED]: "1" } });
  let out = "";
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    process.stdout.write(withVerdict(ok && out.trim() ? out : fallbackLine(payload), snap));
    process.exit(0);
  };
  setTimeout(() => {
    try {
      if (posix) process.kill(-child.pid, "SIGKILL");
      else child.kill();
    } catch {
      /* already gone */
    }
    finish(false);
  }, PREVIOUS_TIMEOUT_MS);
  child.stdout.on("data", (c) => { out += c; });
  child.on("error", () => finish(false));
  child.on("close", (code) => finish(code === 0));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
} else {
  process.stdout.write(withVerdict(fallbackLine(payload), snap));
}
