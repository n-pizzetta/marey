#!/usr/bin/env node
/**
 * Installs (or removes) the Marey status line wrapper.
 *
 *   node scripts/install-statusline.mjs              # install / refresh
 *   node scripts/install-statusline.mjs --uninstall  # restore previous status line
 *
 * Install copies statusline.mjs (and its helper context-advice.mjs) to a stable path (~/.claude/marey/, so
 * plugin updates don't break settings.json), saves the current `statusLine`
 * setting to ~/.claude/marey/statusline.json and points `statusLine` at
 * the wrapper, which keeps rendering the previous status line. It also sets
 * `statusLine.refreshInterval` (unless already set) so the line updates while idle.
 *
 * Codex and Copilot CLI, when installed, get their own native limit items instead
 * (host-limits.mjs); `--uninstall` reverts those too.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, legacyDataDir } from "./data-dir.mjs";
import { setHostLimits } from "./host-limits.mjs";

// Honors CLAUDE_CONFIG_DIR, like Claude Code.
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const DIR = dataDir(CLAUDE);
const SETTINGS = join(CLAUDE, "settings.json");
const STATE = join(DIR, "statusline.json");
const TARGET = join(DIR, "statusline.mjs");
// Installs made before the rename point settings.json at the old folder (now a symlink).
const LEGACY_TARGET = join(legacyDataDir(CLAUDE), "statusline.mjs");
const ADVICE_TARGET = join(DIR, "context-advice.mjs");
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(SCRIPTS, "statusline.mjs");
const ADVICE_SOURCE = join(SCRIPTS, "context-advice.mjs");

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch (err) {
    console.error(`[marey] cannot parse ${SETTINGS}: ${err.message}. Nothing changed.`);
    process.exit(1);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    console.error(`[marey] ${SETTINGS} is not a JSON object. Nothing changed.`);
    process.exit(1);
  }
  return settings;
}

/** Backup, then write through a temp file + rename so a concurrent reader never sees half a file. */
function writeSettings(settings) {
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.marey.bak`);
  const tmp = `${SETTINGS}.marey.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, SETTINGS);
}

function removeState() {
  rmSync(STATE, { force: true });
  rmSync(TARGET, { force: true });
  rmSync(ADVICE_TARGET, { force: true });
  rmSync(join(DIR, "copilot-statusline.mjs"), { force: true });
  rmSync(join(DIR, "limits.json"), { force: true });
  rmSync(join(DIR, "limits-history.jsonl"), { force: true });
  rmSync(join(DIR, "live"), { recursive: true, force: true });
}

/**
 * Claude Code only re-runs the status line on events (a message, a turn), so an idle session
 * would show a frozen cache countdown. Re-run it on a timer too; a value the user set is kept.
 */
const REFRESH_INTERVAL = 30;

const isOurs = (statusLine) =>
  typeof statusLine?.command === "string" && (statusLine.command.includes(TARGET) || statusLine.command.includes(LEGACY_TARGET));

function install() {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(SOURCE, TARGET);
  copyFileSync(ADVICE_SOURCE, ADVICE_TARGET);

  const settings = readSettings();
  if (isOurs(settings.statusLine)) {
    const command = `node "${TARGET}"`;
    const addRefresh = settings.statusLine.refreshInterval === undefined;
    if (settings.statusLine.command !== command || addRefresh) {
      settings.statusLine.command = command;
      if (addRefresh) settings.statusLine.refreshInterval = REFRESH_INTERVAL;
      writeSettings(settings);
      if (addRefresh) console.log(`[marey] status line now refreshes every ${REFRESH_INTERVAL}s, so the cache countdown keeps moving while idle.`);
    }
    console.log(`[marey] status line already installed; wrapper refreshed at ${TARGET}`);
    return;
  }
  const previous = settings.statusLine ?? null;
  writeFileSync(STATE, JSON.stringify({ previous }, null, 2) + "\n");
  settings.statusLine = {
    refreshInterval: REFRESH_INTERVAL,
    ...(previous ?? {}),
    type: "command",
    command: `node "${TARGET}"`,
  };
  writeSettings(settings);
  console.log(
    `[marey] status line installed. ` +
      (previous?.command ? `Your previous status line keeps rendering: ${previous.command}` : "No previous status line; a minimal one is shown."),
  );
  console.log("[marey] Usage limits appear in the dashboard after the next Claude Code turn.");
}

function uninstall() {
  const settings = readSettings();
  if (!isOurs(settings.statusLine)) {
    // The user may have replaced the status line since: leave it, clean up ours.
    removeState();
    console.log("[marey] status line not active; removed leftover Marey files.");
    return;
  }
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(STATE, "utf8")).previous ?? null;
  } catch {
    /* no saved state: just remove ours */
  }
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  writeSettings(settings);
  removeState();
  console.log("[marey] status line removed" + (previous?.command ? `; restored: ${previous.command}` : "."));
}

// Other CLIs first, so a settings.json Marey can't parse (exit 1 below) doesn't block them.
const uninstalling = process.argv.includes("--uninstall");
mkdirSync(DIR, { recursive: true });
for (const line of setHostLimits(DIR, { uninstall: uninstalling })) console.log(`[marey] ${line}`);
if (uninstalling) uninstall();
else install();
