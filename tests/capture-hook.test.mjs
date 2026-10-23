// The plugin's PostToolUse / Stop hook (hooks/capture.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "11111111-2222-3333-4444-555555555555";
const mode = (p) => statSync(p).mode & 0o777;

test("exits after its stdin timeout even if stdin stays open, and keeps its files private", { skip: process.platform === "win32" }, async () => {
  const claude = mkdtempSync(join(tmpdir(), "marey-hook-"));
  const t0 = Date.now();
  const child = spawn(process.execPath, ["hooks/capture.mjs"], { env: { ...process.env, CLAUDE_CONFIG_DIR: claude }, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.write(JSON.stringify({ session_id: ID, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a" } }));
  const held = setTimeout(() => child.stdin.end(), 10_000);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(held);

  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  const cache = join(claude, "marey", "cache");
  assert.equal(JSON.parse(readFileSync(join(cache, `${ID}.jsonl`), "utf8")).tool, "Bash");
  assert.equal(mode(join(claude, "marey")), 0o700);
  assert.equal(mode(cache), 0o700);
  assert.equal(mode(join(cache, `${ID}.jsonl`)), 0o600);
});
