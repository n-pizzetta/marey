/**
 * Usage limits (and, in Codex, the context used) in the status lines of the other CLIs Marey
 * reads, via their own native items.
 *
 * Neither CLI can run Claude Code's kind of wrapper for this: Codex's status line is a list of
 * built-in items (no custom command), and Copilot CLI's `statusLine.command` payload carries no
 * limits. Both can already show their own limits, just not by default:
 *   - Codex: `[tui] status_line` gets `context-used`, `five-hour-limit` and `weekly-limit` after
 *     the model item (`GPT-6-Astra high · 5h 42% left · weekly 76% left · ~/project`; Codex omits
 *     the context until the session's first reply),
 *   - Copilot CLI: `footer.showQuota` (`Plan: 370/5,000 (7% used)`), set through `copilot config`,
 *     which also reads the comments its settings.json may contain.
 *
 * Called by install-statusline.mjs (`/marey:limits`). What was there before is saved in
 * ~/.claude/marey/host-limits.json, and `--uninstall` puts it back unless the user changed it since.
 */
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LIMIT_ITEMS = ["five-hour-limit", "weekly-limit"];
/** What Marey adds to Codex's status line: the share of the context window used, then the limits. */
export const CODEX_ITEMS = ["context-used", ...LIMIT_ITEMS];
/** Codex's own default (0.161), written out when the user never picked items. */
export const CODEX_DEFAULT_ITEMS = ["model-with-reasoning", "current-dir", "thread-name"];
const MODEL_ITEMS = ["model-with-reasoning", "model"];

const TUI_HEADER = /^\s*\[\s*tui\s*\]\s*(#.*)?$/;
const TABLE_HEADER = /^\s*\[/;
const STATUS_LINE_KEY = /^\s*status_line\s*=/;

/** The string items of the TOML array that starts after `=` on line `i`, and its last line; null if not an array. */
function readArray(lines, i) {
  const items = [];
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    const line = j === i ? lines[j].slice(lines[j].indexOf("=") + 1) : lines[j];
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (depth === 0) return null;
        const close = line.indexOf(c, k + 1);
        if (close < 0) return null;
        items.push(line.slice(k + 1, close));
        k = close;
      } else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return { items, end: j };
      else if (depth === 0 && !/\s/.test(c)) return null;
    }
  }
  return null;
}

/** Where `[tui] status_line` lives in config.toml; null when the file sets `tui` in a way this editor doesn't handle. */
function locate(lines) {
  const firstTable = lines.findIndex((l) => TABLE_HEADER.test(l));
  const root = firstTable < 0 ? lines : lines.slice(0, firstTable);
  if (root.some((l) => /^\s*tui\s*[.=]/.test(l))) return null;
  const start = lines.findIndex((l) => TUI_HEADER.test(l));
  if (start < 0) return { table: null };
  let end = start + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end])) end++;
  for (let i = start + 1; i < end; i++) {
    if (!STATUS_LINE_KEY.test(lines[i])) continue;
    const value = readArray(lines, i);
    return value ? { table: start, key: i, ...value } : null;
  }
  return { table: start };
}

const statusLine = (items) => `status_line = [${items.map((s) => JSON.stringify(s)).join(", ")}]`;

/** Marey's items, inserted right after the model item (or first) of `items`. */
export function withCodexItems(items) {
  const missing = CODEX_ITEMS.filter((i) => !items.includes(i));
  const model = items.findIndex((i) => MODEL_ITEMS.includes(i));
  const out = [...items];
  out.splice(model + 1, 0, ...missing);
  return out;
}

/**
 * config.toml with Marey's items in `[tui] status_line`.
 * @returns {{ toml: string, previous: string[] | null, applied: string[] } | { unchanged: true } | { error: string }}
 */
export function addCodexItems(toml) {
  const lines = toml.split("\n");
  const at = locate(lines);
  if (!at) return { error: "`tui` is set in a form Marey doesn't edit" };
  const previous = at.items ?? null;
  if (previous && CODEX_ITEMS.every((i) => previous.includes(i))) return { unchanged: true };
  const applied = withCodexItems(previous ?? CODEX_DEFAULT_ITEMS);
  if (at.key !== undefined) lines.splice(at.key, at.end - at.key + 1, statusLine(applied));
  else if (at.table !== null) lines.splice(at.table + 1, 0, statusLine(applied));
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push("[tui]", statusLine(applied), "");
  }
  return { toml: lines.join("\n"), previous, applied };
}

/** config.toml with `status_line` back to `previous` (null: removed), or null if the user changed it since. */
export function restoreCodexItems(toml, { previous, applied }) {
  const lines = toml.split("\n");
  const at = locate(lines);
  if (!at || at.key === undefined || JSON.stringify(at.items) !== JSON.stringify(applied)) return null;
  lines.splice(at.key, at.end - at.key + 1, ...(previous ? [statusLine(previous)] : []));
  return lines.join("\n");
}

// --- files and CLIs ---

const codexConfig = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

/** Backup, then temp file + rename, on the symlink's target if config.toml is a dotfiles link. */
function writeConfig(path, text) {
  const target = existsSync(path) ? realpathSync(path) : path;
  if (existsSync(target)) copyFileSync(target, `${target}.marey.bak`);
  const tmp = `${target}.marey.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  if (Object.keys(state).length) writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  else rmSync(file, { force: true });
}

function installCodex(state) {
  const path = codexConfig();
  if (!existsSync(dirname(path))) return null;
  const result = addCodexItems(existsSync(path) ? readFileSync(path, "utf8") : "");
  const items = CODEX_ITEMS.map((i) => `"${i}"`).join(", ");
  if (result.error) return `Codex: ${result.error} in ${path}; add ${items} with /statusline in Codex.`;
  if (result.unchanged) return "Codex: the status line already shows the context used and the 5h and weekly limits.";
  writeConfig(path, result.toml);
  // Upgrading from an earlier /marey:limits that added only the limits: --uninstall still goes back to the user's own line.
  const earlier = state.codex && JSON.stringify(state.codex.applied) === JSON.stringify(result.previous);
  state.codex = { previous: earlier ? state.codex.previous : result.previous, applied: result.applied };
  return `Codex: the status line now shows the context used and the 5h and weekly limits (${path}, backed up to config.toml.marey.bak). Applies to new Codex sessions.`;
}

function uninstallCodex(state) {
  if (!state.codex) return null;
  const path = codexConfig();
  const restored = existsSync(path) ? restoreCodexItems(readFileSync(path, "utf8"), state.codex) : null;
  delete state.codex;
  if (restored === null) return "Codex: status line changed since /marey:limits; left as is.";
  writeConfig(path, restored);
  return "Codex: status line restored.";
}

/** `copilot config …`; undefined when Copilot CLI isn't installed. */
function copilotConfig(...args) {
  try {
    return { out: execFileSync("copilot", ["config", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, shell: process.platform === "win32" }).trim() };
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    // Reading a key that isn't set exits 1 with nothing on stdout.
    return { out: String(err.stdout ?? "").trim(), failed: true };
  }
}

function installCopilot(state) {
  const current = copilotConfig("footer.showQuota");
  if (!current) return null;
  if (current.out === "true") return "Copilot CLI: the footer already shows your plan usage.";
  if (copilotConfig("footer.showQuota", "on")?.failed) return "Copilot CLI: could not turn on footer.showQuota; run `copilot config footer.showQuota on`.";
  state.copilot = { previous: current.out === "false" ? false : null };
  return "Copilot CLI: the footer now shows your plan usage (footer.showQuota). Applies to new Copilot sessions.";
}

function uninstallCopilot(state) {
  if (!state.copilot) return null;
  const { previous } = state.copilot;
  delete state.copilot;
  if (copilotConfig("footer.showQuota")?.out !== "true") return "Copilot CLI: footer.showQuota changed since /marey:limits; left as is.";
  const undo = previous === null ? copilotConfig("--rm", "footer.showQuota") : copilotConfig("footer.showQuota", "off");
  return undo && !undo.failed ? "Copilot CLI: footer restored." : "Copilot CLI: could not restore footer.showQuota.";
}

/** Install (or with `uninstall`, undo) the limits in Codex and Copilot CLI; returns one line per host found. */
export function setHostLimits(dir, { uninstall = false } = {}) {
  const file = join(dir, "host-limits.json");
  const state = readState(file);
  const lines = uninstall ? [uninstallCodex(state), uninstallCopilot(state)] : [installCodex(state), installCopilot(state)];
  writeState(file, state);
  return lines.filter(Boolean);
}
