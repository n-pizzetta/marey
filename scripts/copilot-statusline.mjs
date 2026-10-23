#!/usr/bin/env node
/**
 * Marey's status line for Copilot CLI: the context used and the prompt cache's state, e.g.
 * "ctx ━━━───── 33% │ cache warm 3m", plus a "wrap up?" / "clear?" hint when it matters, the
 * same segment Claude Code gets from statusline.mjs.
 *
 * Copilot CLI's cache lives 5 minutes, so a short pause re-writes the whole context at a price
 * (cache writes cost 1.25× input in AI credits). Its status line payload has no cache state
 * (`session_id`, `transcript_path`, `context_window`, `cost`…), so this reads the session's last
 * main-thread `session.usage_record` in events.jsonl: `cacheExpiresAt`, `cacheTtlSeconds`, and the
 * cached tokens a cold start would re-write. It also writes the same per-session snapshot as the
 * Claude Code wrapper (~/.claude/marey/live/<session_id>.json), so the dashboard shows it too.
 *
 * Installed next to context-advice.mjs in ~/.claude/marey/ by `/marey:limits` (host-limits.mjs),
 * set as Copilot CLI's `statusLine.command` only when it had none.
 * Must stay fast and never fail: the status line renders on every refresh.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = join(HERE, "live");
const UUID_RE = /^[a-f0-9-]{36}$/i;
/** How much of the end of events.jsonl to scan for the last usage record (lines can be long). */
const TAIL_BYTES = 512 * 1024;

let advice = null;
try {
  advice = await import("./context-advice.mjs");
} catch {
  /* no helper next to this file: print nothing */
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The session's events file: the transcript path Copilot gives (a file or its folder), else by id. */
function eventsPath(payload) {
  const t = payload?.transcript_path;
  if (typeof t === "string" && t) {
    try {
      return statSync(t).isDirectory() ? join(t, "events.jsonl") : t;
    } catch {
      /* fall back to the id */
    }
  }
  const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  return UUID_RE.test(payload?.session_id ?? "") ? join(home, "session-state", payload.session_id, "events.jsonl") : null;
}

/** The last usage record of the main thread (sub-agents have their own context), from the file's tail. */
export function lastUsage(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith('{"type":"session.usage_record"')) continue;
      try {
        const e = JSON.parse(line);
        if (!e.agentId && e.data?.usage?.initiator !== "sub-agent") return e.data.usage;
      } catch {
        /* a line cut by the tail's start */
      }
    }
  } catch {
    /* no file yet */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/** The snapshot context-advice.mjs reads (and the dashboard shows), from the payload and the last usage record. */
export function copilotSnapshot(payload, usage, now = Date.now()) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return null;
  const cw = payload.context_window ?? {};
  const size = num(cw.context_window_size) ?? num(usage?.maxPromptTokens);
  const tokens = num(cw.current_context_tokens) ?? num(usage?.inputTokens) ?? 0;
  const usedPct = num(cw.used_percentage) ?? (size ? (tokens / size) * 100 : null);
  const expiresAt = Date.parse(usage?.cacheExpiresAt ?? "");
  const ttl = num(usage?.cacheTtlSeconds);
  const cached = (num(usage?.cacheReadTokens) ?? 0) + (num(usage?.cacheWriteTokens) ?? 0);
  return {
    v: 1,
    sessionId,
    capturedAt: now,
    model: typeof payload.model?.id === "string" ? payload.model.id : typeof usage?.model === "string" ? usage.model : null,
    costUsd: null,
    context: { usedPct: usedPct === null ? null : Math.round(usedPct), size, tokens },
    cache: Number.isNaN(expiresAt)
      ? null
      : {
          observed: true,
          warm: expiresAt > now,
          ttl: ttl ? `${ttl % 60 === 0 ? `${ttl / 60}m` : `${ttl}s`}` : null,
          expiresAt: expiresAt / 1000,
          requests: 0,
          misses: 0,
          hitRatio: null,
          lastMissCause: null,
          recacheTokensIfCold: cached || null,
        },
  };
}

function writeSnapshot(snap) {
  try {
    // Owner-only, like statusline.mjs's: snapshots are named by session id.
    mkdirSync(LIVE, { recursive: true, mode: 0o700 });
    const tmp = join(LIVE, `${snap.sessionId}.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, join(LIVE, `${snap.sessionId}.json`));
  } catch {
    /* never break the status line */
  }
}

/** Run as the status line command (not imported by a test). */
function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    /* nothing to show */
  }
  const path = payload ? eventsPath(payload) : null;
  const snap = payload ? copilotSnapshot(payload, path ? lastUsage(path) : null) : null;
  if (snap) {
    writeSnapshot(snap);
    if (advice) process.stdout.write(advice.statusSegment(snap));
  }
}
