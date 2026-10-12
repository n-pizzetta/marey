/**
 * Marey API, shared by the production server (scripts/serve.mjs) and the
 * Vite dev middleware (vite.config.ts) so both expose the same routes with the
 * same checks.
 *
 * Holds the parsed sessions in memory, re-parses when ~/.claude changes
 * (throttled), and serves /api/* plus /usage-report.html.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { promises as fsp, watch, existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { mergeLimits, parseAllSessions, readLimits, readLiveContext, summarizeSession } from "./parse-sessions.mjs";
import { badgeStatePath, computeBadges, loadBadgeState, saveBadgeState } from "./badges.mjs";
import { dataDir } from "./data-dir.mjs";
import { availableUpdate, latestVersion } from "./update-check.mjs";
import { focusSession } from "./focus-terminal.mjs";
import { buildRecommendations } from "./recommendations.mjs";

// Honors CLAUDE_CONFIG_DIR, like Claude Code.
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const DATA = dataDir(CLAUDE);
/** This install's version, from package.json (the plugin ships it). */
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PROJECTS = join(CLAUDE, "projects");
const STALE = join(CLAUDE, "sessions", ".stale");
const FILE_HISTORY = join(CLAUDE, "file-history");
const META_DIR = join(CLAUDE, "usage-data", "session-meta");
const META_TRASH = join(META_DIR, ".trash");
const REPORT_HTML = join(CLAUDE, "usage-data", "report.html");
const BADGES_FILE = badgeStatePath(CLAUDE);

const SESSION_ID_RE = /^[a-f0-9-]{36}$/i;
const FILE_NAME_RE = /^[a-f0-9]+@v\d+$/;
const PARSE_ERROR_FILE_RE = /^[a-f0-9-]{36}\.json$/i;

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

let onParsed = () => {};

/** Resolves once the first parse is done: until then data routes wait (the dashboard shows its loading screen). */
let markReady;
const ready = new Promise((resolve) => (markReady = resolve));

let parsing = false;
let parsePending = false;
const cache = {
  generatedAt: null,
  sessions: [],
  byId: new Map(),
  errors: [],
  badges: null,
  recommendations: null,
  /** Freshest usage limits read so far (`mergeLimits`): limits.json flips between sessions. */
  limits: null,
};

let badgeState = null;

/** Recomputes badges after a parse; the first call creates badges.json (first launch). */
async function updateBadges(sessions) {
  try {
    badgeState ??= await loadBadgeState(BADGES_FILE);
    const { changed, ...badges } = computeBadges(sessions, badgeState);
    if (changed) await saveBadgeState(BADGES_FILE, badgeState);
    cache.badges = badges;
  } catch (err) {
    console.error("[marey] badges error:", err);
  }
}

async function runParser() {
  if (parsing) {
    parsePending = true;
    return;
  }
  parsing = true;
  try {
    const t0 = Date.now();
    const { sessions, errors, modelOverrides } = await parseAllSessions();
    cache.generatedAt = new Date().toISOString();
    cache.modelOverrides = modelOverrides;
    cache.sessions = sessions;
    cache.byId = new Map(sessions.map((s) => [s.id, s]));
    cache.errors = errors;
    await updateBadges(sessions);
    try { cache.recommendations = buildRecommendations(sessions); } catch (err) { console.error("[marey] recommendations error:", err); }
    // Serialize the list once per parse; the ETag lets polling clients get a 304.
    const list = JSON.stringify({ sessions: sessions.map(summarizeSession), errors, models: modelOverrides ?? {} });
    cache.listEtag = `"${createHash("sha1").update(list).digest("base64url")}"`;
    cache.listBody = `{"generatedAt":${JSON.stringify(cache.generatedAt)},${list.slice(1)}`;
    const dt = Date.now() - t0;
    const live = sessions.filter((s) => s.live).length;
    const ghost = sessions.filter((s) => s.ghost).length;
    console.log(`[marey] parsed ${sessions.length} sessions (${live} live, ${ghost} ghost) in ${dt}ms`);
    onParsed();
  } catch (err) {
    console.error("[marey] parse error:", err);
  } finally {
    parsing = false;
    lastParseAt = Date.now();
    if (parsePending) {
      parsePending = false;
      runParser();
    }
  }
}

// Watched dirs change on every tool call of every active session: coalesce
// events and re-parse at most every MIN_PARSE_INTERVAL_MS (unchanged
// transcripts are cached by the parser, so a re-parse is cheap).
const MIN_PARSE_INTERVAL_MS = 5_000;
let lastParseAt = 0;
let debounce = null;
function scheduleParse() {
  if (debounce) return;
  const wait = Math.max(600, lastParseAt + MIN_PARSE_INTERVAL_MS - Date.now());
  debounce = setTimeout(() => {
    debounce = null;
    runParser();
  }, wait);
}

function watchClaude() {
  const dirs = [
    join(CLAUDE, "sessions"),
    join(CLAUDE, "usage-data", "session-meta"),
    join(CLAUDE, "usage-data", "facets"),
    join(DATA, "cache"),
  ];
  for (const dir of dirs) {
    try {
      watch(dir, { recursive: false }, scheduleParse);
      console.log(`[marey] watching ${dir}`);
    } catch (err) {
      console.warn(`[marey] could not watch ${dir}: ${err.message}`);
    }
  }
}

async function findTranscriptPath(sessionId) {
  try {
    const slugs = await readdir(PROJECTS);
    for (const slug of slugs) {
      const p = join(PROJECTS, slug, `${sessionId}.jsonl`);
      try {
        await fsp.access(p);
        return p;
      } catch { /* next */ }
    }
  } catch { /* no projects dir */ }
  return null;
}

/**
 * The dashboard only listens on loopback, but a browser page from any site can
 * still send requests to it. Reject DNS-rebinding (foreign Host) on every
 * request, and cross-site callers (Origin / Sec-Fetch-Site) on anything that
 * changes state. Non-browser local clients (curl) send neither header.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(hostHeader) {
  return !!hostHeader && LOOPBACK_HOSTS.has(hostHeader.replace(/:\d+$/, "").toLowerCase());
}

function isForeignRequest(req) {
  if (!isLoopbackHost(req.headers.host)) return true;
  if (req.method === "GET" || req.method === "HEAD") return false;
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

async function deleteGhost(sessionId) {
  const removed = [];
  const errors = [];
  const transcript = await findTranscriptPath(sessionId);
  if (transcript) {
    try { await fsp.unlink(transcript); removed.push(transcript); }
    catch (e) { errors.push(`transcript: ${e.message}`); }
  }
  if (transcript) {
    // <project>/<sessionId>/ holds the session's sub-agent transcripts.
    const dir = join(dirname(transcript), sessionId);
    if (existsSync(dir)) {
      try { await fsp.rm(dir, { recursive: true }); removed.push(dir); }
      catch (e) { errors.push(`subagents: ${e.message}`); }
    }
  }
  for (const p of [join(STALE, `${sessionId}.json`), join(DATA, "cache", `${sessionId}.jsonl`)]) {
    try { await fsp.unlink(p); removed.push(p); } catch { /* may not exist */ }
  }
  return { removed, errors };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, code, body, contentType = "text/plain; charset=utf-8") {
  res.statusCode = code;
  res.setHeader("content-type", contentType);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), JSON_TYPE);
}


function serveUsageReport(_req, res) {
  res.setHeader("cache-control", "no-store");
  // Generated HTML with session content, served from the API's origin: no scripts.
  res.setHeader("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  if (!existsSync(REPORT_HTML)) {
    const html = `<!doctype html><meta charset="utf-8"><title>No insights report yet</title>` +
      `<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;` +
      `color:#334155;background:#f8fafc;max-width:560px;margin:80px auto;padding:0 24px}` +
      `h1{font-size:20px;color:#0f172a;margin:0 0 12px}code{background:#e2e8f0;padding:2px 6px;` +
      `border-radius:4px;font-size:13px}</style>` +
      `<h1>No insights report yet</h1>` +
      `<p>Run <code>/insights</code> in Claude Code to generate one. ` +
      `It will be written to <code>~/.claude/usage-data/report.html</code>.</p>`;
    return send(res, 404, html, HTML_TYPE);
  }
  res.setHeader("content-type", HTML_TYPE);
  createReadStream(REPORT_HTML).pipe(res);
}

/** Routes that answer without the parsed sessions, so they work while the first parse runs. */
const NO_PARSE_NEEDED = new Set(["/api/version", "/api/update", "/api/limits"]);

async function handleApi(req, res) {
  if (!NO_PARSE_NEEDED.has((req.url || "").split("?")[0])) await ready;
  const url = req.url || "";

  if (url === "/api/sessions" || url.startsWith("/api/sessions?")) {
    res.setHeader("cache-control", "no-cache");
    if (!cache.listBody) return sendJson(res, 200, { generatedAt: null, sessions: [], errors: [], models: {} });
    res.setHeader("etag", cache.listEtag);
    if (req.headers["if-none-match"] === cache.listEtag) {
      res.statusCode = 304;
      return res.end();
    }
    return send(res, 200, cache.listBody, JSON_TYPE);
  }

  const focusMatch = url.match(/^\/api\/sessions\/([a-f0-9-]{36})\/focus(?:\?|$)/i);
  if (focusMatch) {
    if (req.method !== "POST") return send(res, 405, "method not allowed");
    const s = cache.byId.get(focusMatch[1]);
    if (!s) return send(res, 404, "session not found");
    if (!s.live || !s.pid || s.agent !== "claude") return send(res, 409, "not a running Claude Code session");
    try {
      const transcriptPath = await findTranscriptPath(s.id);
      return sendJson(res, 200, await focusSession({ pid: s.pid, cwd: s.cwd, transcriptPath }));
    } catch (e) {
      return send(res, e.status ?? 500, e.message);
    }
  }

  const sessionMatch = url.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\?|$)/i);
  if (sessionMatch) {
    const s = cache.byId.get(sessionMatch[1]);
    if (!s) return send(res, 404, "session not found");
    res.setHeader("cache-control", "no-store");
    return sendJson(res, 200, s);
  }

  if (url.startsWith("/api/parse-error/")) {
    const m = url.match(/^\/api\/parse-error\/([^/?]+)\/trash(?:\?|$)/);
    if (!m) return send(res, 404, "not found");
    const [, fileName] = m;
    if (!PARSE_ERROR_FILE_RE.test(fileName)) return send(res, 400, "invalid file name");
    if (req.method !== "POST") return send(res, 405, "method not allowed");
    const src = join(META_DIR, fileName);
    try {
      let trashedAt;
      if (platform() === "darwin") {
        const escaped = src.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Finder" to delete POSIX file "${escaped}"`;
        await promisify(execFile)("osascript", ["-e", script]);
        trashedAt = "~/.Trash (macOS)";
      } else {
        await fsp.mkdir(META_TRASH, { recursive: true });
        const dest = join(META_TRASH, `${Date.now()}-${fileName}`);
        await fsp.rename(src, dest);
        trashedAt = dest;
      }
      runParser();
      return sendJson(res, 200, { trashed: trashedAt });
    } catch (e) {
      return send(res, 500, e.message);
    }
  }

  if (url.startsWith("/api/file-history/")) {
    const m = url.match(/^\/api\/file-history\/([^/]+)\/([^?]+)(?:\?|$)/);
    if (!m) return send(res, 404, "not found");
    const [, sessionId, fileName] = m;
    if (!SESSION_ID_RE.test(sessionId) || !FILE_NAME_RE.test(fileName)) {
      return send(res, 400, "invalid id or file");
    }
    try {
      const body = await fsp.readFile(join(FILE_HISTORY, sessionId, fileName), "utf8");
      return send(res, 200, body);
    } catch {
      return send(res, 404, "file not found");
    }
  }

  if (url === "/api/recommendations") {
    res.setHeader("cache-control", "no-store");
    return sendJson(res, 200, cache.recommendations ?? { generatedAt: null, windowDays: 30, cards: [], coverage: null });
  }

  if (url === "/api/badges") {
    res.setHeader("cache-control", "no-store");
    return sendJson(res, 200, cache.badges ?? { startedAt: null, total: 0, families: [] });
  }

  // The daily update check (scripts/update-check.mjs), for the dashboard's update notice.
  if (url === "/api/update") {
    res.setHeader("cache-control", "no-store");
    return sendJson(res, 200, { current: VERSION, update: availableUpdate(VERSION, await latestVersion(DATA)) });
  }

  // Lets a newer /marey:replay recognize this server and replace it.
  if (url === "/api/version") {
    return sendJson(res, 200, { name: "marey", version: VERSION, pid: process.pid });
  }

  if (url === "/api/limits") {
    res.setHeader("cache-control", "no-store");
    cache.limits = mergeLimits(cache.limits, await readLimits());
    return sendJson(res, 200, cache.limits);
  }

  if (url === "/api/live-context") {
    res.setHeader("cache-control", "no-store");
    return sendJson(res, 200, await readLiveContext());
  }

  if (url === "/api/report-status") {
    res.setHeader("cache-control", "no-store");
    try {
      const st = statSync(REPORT_HTML);
      return sendJson(res, 200, { exists: true, mtime: st.mtime.toISOString() });
    } catch {
      return sendJson(res, 200, { exists: false, mtime: null });
    }
  }

  if (url === "/api/ghost/bulk-delete") {
    if (req.method !== "POST") return send(res, 405, "method not allowed");
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, "invalid json");
    }
    // Only sessions the parser classified as ghosts can be deleted.
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x) => typeof x === "string" && SESSION_ID_RE.test(x) && cache.byId.get(x)?.ghost)
      : [];
    if (ids.length === 0) return send(res, 400, "no deletable ghost sessions");
    const results = [];
    for (const id of ids) {
      const r = await deleteGhost(id);
      results.push({ id, ...r });
    }
    runParser();
    return sendJson(res, 200, { count: ids.length, results });
  }

  if (url.startsWith("/api/ghost/")) {
    const m = url.match(/^\/api\/ghost\/([^/]+)\/(reveal|delete)(?:\?|$)/);
    if (!m) return send(res, 404, "not found");
    const [, sessionId, action] = m;
    if (!SESSION_ID_RE.test(sessionId)) return send(res, 400, "invalid session id");
    if (req.method !== "POST") return send(res, 405, "method not allowed");

    if (action === "reveal") {
      const p = await findTranscriptPath(sessionId);
      if (!p) return send(res, 404, "transcript not found");
      // Select the file in the OS file manager (Linux has no portable "select": open its folder).
      const [opener, args] =
        platform() === "darwin" ? ["open", ["-R", p]]
        : platform() === "win32" ? ["explorer", [`/select,${p}`]]
        : ["xdg-open", [dirname(p)]];
      execFile(opener, args, (err) => {
        if (err) return send(res, 500, err.message);
        sendJson(res, 200, { revealed: p });
      });
      return;
    }

    if (action === "delete") {
      if (!cache.byId.get(sessionId)?.ghost) return send(res, 409, "not a ghost session");
      const result = await deleteGhost(sessionId);
      runParser();
      return sendJson(res, result.errors.length ? 500 : 200, result);
    }

    return send(res, 404, "unknown action");
  }

  return send(res, 404, "not found");
}

/**
 * Parse once, then keep the cache fresh: fs watchers on the small state dirs
 * plus a periodic refresh (transcripts aren't watched; watched dirs may not
 * exist yet on a fresh install). `onParsedCb` runs after every parse.
 */
export async function startApi({ onParsed: onParsedCb } = {}) {
  if (onParsedCb) onParsed = onParsedCb;
  try {
    await runParser();
  } finally {
    markReady();
  }
  watchClaude();
  setInterval(scheduleParse, 10_000).unref();
}

/** Handles /api/* and /usage-report.html. Returns false for anything else. */
export async function handleRequest(req, res) {
  const path = (req.url || "").split("?")[0];
  if (isForeignRequest(req)) {
    send(res, 403, "forbidden");
    return true;
  }
  if (path.startsWith("/api/")) {
    await handleApi(req, res);
    return true;
  }
  if (path === "/usage-report.html") {
    serveUsageReport(req, res);
    return true;
  }
  return false;
}

