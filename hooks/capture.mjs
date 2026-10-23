#!/usr/bin/env node
/**
 * Marey PostToolUse / Stop hook.
 *
 * Appends a single JSONL line per tool call (and per session stop) to
 * ~/.claude/marey/cache/{sessionId}.jsonl. The dashboard reads these
 * sharded files to surface live, fine-grained tool sequences that the native
 * Claude Code session-meta files only have aggregate counts for.
 *
 * Hook contract: Claude Code writes a JSON envelope to stdin.
 * Output: must exit 0 quickly. We write best-effort and stay silent on stdout.
 */

import { join } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { dataDir } from "../scripts/data-dir.mjs";

// Honors CLAUDE_CONFIG_DIR, like Claude Code.
const CACHE_DIR = join(dataDir(), "cache");
const STOP_FLAG = process.argv.includes("--stop");
const TIMEOUT_MS = 1500;
const SESSION_ID_RE = /^[a-f0-9-]{36}$/i;
// Previews can contain secrets from tool inputs/outputs: owner-only files, in a
// folder others can't list (file names are session ids).
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

async function readStdin() {
  return new Promise((res) => {
    let data = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    // Safety net if stdin never closes. Cleared and unref'd so it never keeps
    // the process alive: the hook runs on every tool call of every session.
    // Its `data` listener would, so stdin is destroyed too.
    const timer = setTimeout(() => {
      process.stdin.destroy();
      res(data);
    }, TIMEOUT_MS);
    timer.unref();
    process.stdin.on("end", () => {
      clearTimeout(timer);
      res(data);
    });
  });
}

function summarize(tool, input, output) {
  // Trim large payloads so the cache stays light.
  const cap = (s, n = 200) => (typeof s === "string" ? s.slice(0, n) : "");
  const inPreview = input ? cap(JSON.stringify(input), 400) : "";
  // Bash returns { stdout, stderr }; most other tools return MCP-style content blocks.
  const outText = typeof output === "string" ? output : output?.content?.[0]?.text ?? output?.stdout ?? output?.stderr ?? "";
  return { inPreview, outPreview: cap(outText, 400) };
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      // Nothing on stdin (e.g. ran from CLI) — exit cleanly.
      return;
    }
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }

    const sessionId = evt.session_id || evt.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return;

    await mkdir(CACHE_DIR, { recursive: true, mode: DIR_MODE });
    const file = join(CACHE_DIR, `${sessionId}.jsonl`);

    if (STOP_FLAG) {
      const line = JSON.stringify({ kind: "stop", t: Date.now() }) + "\n";
      await appendFile(file, line, { mode: FILE_MODE });
      return;
    }

    const tool = evt.tool_name || evt.tool || evt.name;
    const input = evt.tool_input ?? evt.input;
    const output = evt.tool_response ?? evt.tool_result ?? evt.output;
    const { inPreview, outPreview } = summarize(tool, input, output);

    const entry = {
      kind: "tool",
      t: Date.now(),
      tool,
      inPreview,
      outPreview,
    };
    await appendFile(file, JSON.stringify(entry) + "\n", { mode: FILE_MODE });
  } catch {
    // Hooks must never break the host. Silent on failure.
  }
})();
