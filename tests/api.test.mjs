// API routes that read or remove files under ~/.claude (scripts/api.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-api-test-"));
const CLAUDE = join(root, ".claude");
const REPORT = join(CLAUDE, "usage-data", "report.html");

let api;

before(async () => {
  mkdirSync(join(CLAUDE, "usage-data"), { recursive: true });
  // The API and the parser resolve CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  api = await import("../scripts/api.mjs");
});

after(() => rmSync(root, { recursive: true, force: true }));

/** One request through handleRequest, on a server of its own. */
async function request(path) {
  const server = createServer((req, res) => api.handleRequest(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // A route that crashes never answers.
    const res = await fetch(`http://localhost:${server.address().port}${path}`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

test("the insights report: a placeholder when missing, a 500 when it can't be read", async () => {
  assert.equal((await request("/usage-report.html")).status, 404);
  mkdirSync(REPORT);
  assert.equal((await request("/usage-report.html")).status, 500);
  rmSync(REPORT, { recursive: true });
  writeFileSync(REPORT, "<h1>Insights</h1>");
  assert.deepEqual(await request("/usage-report.html"), { status: 200, body: "<h1>Insights</h1>" });
});

const DAY = 86_400_000;
const PROJECT_DIR = "-Users-me-app";
const SESSIONS = join(CLAUDE, "sessions");
const TRASH = join(CLAUDE, "marey", "trash");

/** A ghost's files: its transcript (written an hour ago unless `writtenAt`), a sub-agent transcript, its .stale marker. */
function ghost(id, { writtenAt = Date.now() - 3_600_000 } = {}) {
  const project = join(CLAUDE, "projects", PROJECT_DIR);
  const transcript = join(project, `${id}.jsonl`);
  mkdirSync(join(project, id, "subagents"), { recursive: true });
  writeFileSync(transcript, '{"type":"user"}\n');
  writeFileSync(join(project, id, "subagents", "agent-a.jsonl"), "{}\n");
  utimesSync(transcript, writtenAt / 1000, writtenAt / 1000);
  mkdirSync(join(SESSIONS, ".stale"), { recursive: true });
  const stale = join(SESSIONS, ".stale", `${id}.json`);
  writeFileSync(stale, "{}");
  return { transcript, subagents: join(project, id), stale };
}

test("a ghost delete moves the transcript and its sub-agents to the trash, and empties entries over 30 days old", async () => {
  const id = "aaaaaaaa-0000-0000-0000-000000000001";
  const files = ghost(id);
  // Its process has exited: the pid file doesn't keep it.
  writeFileSync(join(SESSIONS, "4194305.json"), JSON.stringify({ pid: 2 ** 22 + 1, sessionId: id }));
  const expired = join(TRASH, `${Date.now() - 31 * DAY}-aaaaaaaa-0000-0000-0000-000000000000`);
  const kept = join(TRASH, `${Date.now() - 29 * DAY}-aaaaaaaa-0000-0000-0000-00000000000f`);
  for (const d of [expired, kept]) mkdirSync(d, { recursive: true });

  const result = await api.deleteGhost(id);

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.errors, []);
  for (const p of Object.values(files)) assert.ok(!existsSync(p), p);
  const entry = readdirSync(TRASH).find((n) => n.endsWith(id));
  const moved = join(TRASH, entry, PROJECT_DIR);
  assert.equal(readFileSync(join(moved, `${id}.jsonl`), "utf8"), '{"type":"user"}\n');
  assert.ok(existsSync(join(moved, id, "subagents", "agent-a.jsonl")));
  assert.ok(!existsSync(expired));
  assert.ok(existsSync(kept));
});

test("a ghost written in the last 10 minutes is kept", async () => {
  const id = "aaaaaaaa-0000-0000-0000-000000000002";
  const files = ghost(id, { writtenAt: Date.now() - 60_000 });
  const result = await api.deleteGhost(id);
  assert.match(result.refused, /less than 10 minutes ago/);
  for (const p of Object.values(files)) assert.ok(existsSync(p), p);
});

test("a ghost whose Claude Code process runs again is kept", { skip: process.platform === "win32" }, async () => {
  const id = "aaaaaaaa-0000-0000-0000-000000000003";
  const files = ghost(id);
  // A process whose command is named claude: node behind a symlink.
  const claude = join(root, "claude");
  symlinkSync(process.execPath, claude);
  const child = spawn(claude, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    writeFileSync(join(SESSIONS, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id }));
    const result = await api.deleteGhost(id);
    assert.match(result.refused, /Claude Code process is running/);
    for (const p of Object.values(files)) assert.ok(existsSync(p), p);
  } finally {
    child.kill();
  }
});
