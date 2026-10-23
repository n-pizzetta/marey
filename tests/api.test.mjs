// API routes that read or remove files under ~/.claude (scripts/api.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
