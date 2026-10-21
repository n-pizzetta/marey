/**
 * Brings the terminal running a live Claude Code session to the front (macOS).
 * Ghostty 1.3+ is scripted over AppleScript to focus the exact window, tab and
 * split; any other terminal app is only activated. See ARCHITECTURE.md §6.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { jsonlLines } from "./transcript-utils.mjs";

const run = promisify(execFile);

export class FocusError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The process `pid` and its ancestors, from `ps -A -o pid=,ppid=,tty=,comm=` output. */
export function processChain(psOut, pid) {
  const byPid = new Map();
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m) byPid.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm: m[4].trim() });
  }
  const chain = [];
  for (let p = byPid.get(pid); p && chain.length < 64; p = byPid.get(p.ppid)) {
    chain.push(p);
    if (p.ppid <= 1) break;
  }
  return chain;
}

const MULTIPLEXERS = new Set(["tmux", "zellij", "screen"]);

/** The app hosting a process chain: the first ancestor inside an `.app` bundle. */
export function hostOf(chain) {
  for (const p of chain.slice(1)) {
    const name = p.comm.split("/").pop();
    if (MULTIPLEXERS.has(name)) return { kind: "multiplexer", name };
    const app = p.comm.match(/^(\/.*?\.app)\//)?.[1];
    if (app) return { kind: /\/Ghostty\.app$/i.test(app) ? "ghostty" : "app", app, name: app.split("/").pop().replace(/\.app$/, "") };
  }
  return { kind: "unknown" };
}

/**
 * Titles Claude Code can show in the terminal title: the latest /rename
 * (`custom-title`), then the latest generated one (`ai-title`).
 */
export async function sessionTitles(transcriptPath) {
  let custom = null;
  let ai = null;
  if (!transcriptPath) return [];
  for await (const line of jsonlLines(transcriptPath)) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === "custom-title" && typeof j.customTitle === "string") custom = j.customTitle;
      if (j.type === "ai-title" && typeof j.aiTitle === "string") ai = j.aiTitle;
    } catch { /* not a title line */ }
  }
  return [custom, ai].filter(Boolean);
}

/** A title without Claude Code's status glyph (`✳ `, `◐ `…). */
const bare = (s) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();

/** The one terminal showing one of `titles`, with `cwd` breaking ties; null if none or still ambiguous. */
export function pickByTitle(terminals, titles, cwd) {
  const wanted = new Set(titles.map(bare).filter(Boolean));
  const hits = terminals.filter((t) => wanted.has(bare(t.name)));
  if (hits.length === 1) return hits[0];
  const here = hits.filter((t) => t.cwd === cwd);
  return here.length === 1 ? here[0] : null;
}

// One Apple event per property for all terminals (per-terminal reads take ~50 ms each).
const LIST_SCRIPT = `tell application "Ghostty"
  set ids to id of every terminal
  set wds to working directory of every terminal
  set names to name of every terminal
end tell
set out to ""
repeat with i from 1 to count of ids
  set wd to item i of wds
  if wd is missing value then set wd to ""
  set out to out & (item i of ids) & (character id 9) & wd & (character id 9) & (item i of names) & linefeed
end repeat
return out`;

// Raises the terminal's window, tab and split; the app itself is activated with `open -a`
// (AppleScript's `activate` can block for seconds).
const FOCUS_SCRIPT = `on run argv
  tell application "Ghostty" to focus terminal id (item 1 of argv)
end run`;

async function osascript(script, args = []) {
  try {
    const { stdout } = await run("osascript", ["-e", script, ...args], { timeout: 60_000 });
    return stdout;
  } catch (e) {
    // -1743: the user denied (or hasn't granted) Automation access.
    if (/-1743/.test(e.stderr ?? "")) {
      throw new FocusError(403, "macOS blocked Marey from controlling Ghostty. Allow it in System Settings → Privacy & Security → Automation.");
    }
    throw e;
  }
}

async function ghosttyTerminals() {
  const out = await osascript(LIST_SCRIPT);
  return out.split("\n").filter(Boolean).map((line) => {
    const [id, cwd, ...name] = line.split("\t");
    return { id, cwd, name: name.join("\t") };
  });
}

const titleSequence = (title) => `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, "")}\x07`;

/**
 * Last resort when titles don't tell terminals apart: write a unique title to
 * the session's tty, find the terminal showing it, then put its title back.
 */
async function findByMarker(tty, before) {
  if (!/^ttys?\d+$/.test(tty)) return null;
  const marker = `marey-${randomBytes(6).toString("hex")}`;
  const fh = await open(`/dev/${tty}`, constants.O_WRONLY | constants.O_NOCTTY);
  try {
    await fh.write(titleSequence(marker));
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const hit = (await ghosttyTerminals()).find((t) => t.name === marker);
      if (!hit) continue;
      const previous = before.find((t) => t.id === hit.id)?.name;
      if (previous) await fh.write(titleSequence(previous));
      return hit;
    }
    return null;
  } finally {
    await fh.close();
  }
}

async function findGhosttyTerminal({ tty, cwd, titles }) {
  const terminals = await ghosttyTerminals();
  const hit = pickByTitle(terminals, titles, cwd) ?? (await findByMarker(tty, terminals));
  if (hit) return hit;
  // Titles locked by the Ghostty config: a working directory only this terminal has.
  const here = terminals.filter((t) => t.cwd === cwd);
  return here.length === 1 ? here[0] : null;
}

/**
 * Focuses the terminal of the Claude Code process `pid`. Returns `{ app, exact }`:
 * `exact` is false when only the app could be brought to the front.
 */
export async function focusSession({ pid, cwd, transcriptPath }) {
  if (platform() !== "darwin") throw new FocusError(501, "Opening the terminal is only supported on macOS.");
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,tty=,comm="]);
  const chain = processChain(stdout, pid);
  if (!chain.length || !/claude/i.test(chain[0].comm)) throw new FocusError(409, "The session's process has ended.");
  const host = hostOf(chain);
  if (host.kind === "multiplexer") throw new FocusError(422, `The session runs inside ${host.name}, which Marey can't navigate yet.`);
  if (host.kind === "unknown") throw new FocusError(422, "No terminal app found for this session.");

  let exact = false;
  if (host.kind === "ghostty") {
    let terminal = null;
    try {
      terminal = await findGhosttyTerminal({ tty: chain[0].tty, cwd, titles: await sessionTitles(transcriptPath) });
    } catch (e) {
      // Ghostty before 1.3 has no AppleScript: activating the app is all we can do.
      if (e instanceof FocusError) throw e;
    }
    if (terminal) {
      await osascript(FOCUS_SCRIPT, [terminal.id]);
      exact = true;
    }
  }
  await run("open", ["-a", host.app]);
  return { app: host.name, exact };
}
