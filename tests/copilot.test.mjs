// Copilot CLI sessions (scripts/copilot.mjs) and the plan limits read from Codex and Copilot
// session files (scripts/provider-limits.mjs), on the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-copilot-"));
const CLAUDE = join(root, ".claude");
const CODEX = join(root, ".codex");
const COPILOT = join(root, ".copilot");
const STATE = join(COPILOT, "session-state");

let parsed;
let copilot;
let lib;
let limits;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, CODEX, COPILOT], { stdio: "ignore" });
  // The parsers resolve their homes at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = CODEX;
  process.env.COPILOT_HOME = COPILOT;
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  lib = await import("../scripts/copilot.mjs");
  limits = await import("../scripts/provider-limits.mjs");
  parsed = await parseAllSessions();
  copilot = parsed.sessions.filter((s) => s.agent === "copilot");
});

after(() => rmSync(root, { recursive: true, force: true }));

const events = (id) => readFileSync(join(STATE, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const usages = (id) => events(id).filter((e) => e.type === "session.usage_record").map((e) => e.data.usage);

test("reads every Copilot session, named after its workspace", () => {
  assert.equal(copilot.length, readdirSync(STATE).length);
  for (const s of copilot) {
    const yaml = readFileSync(join(STATE, s.id, "workspace.yaml"), "utf8");
    assert.equal(s.goal, lib.parseWorkspaceYaml(yaml).name);
    assert.equal(s.project, s.cwd.split("/").pop());
    assert.ok(s.costUsd > 0, `session ${s.id}`);
    assert.equal(s.unpricedModels, undefined);
  }
});

test("input tokens exclude the cache Copilot counts inside them", () => {
  for (const s of copilot) {
    const u = usages(s.id);
    const sum = (k) => u.reduce((n, x) => n + x[k], 0);
    assert.equal(s.tokens.cacheRead, sum("cacheReadTokens"));
    assert.equal(s.tokens.cacheWrite, sum("cacheWriteTokens"));
    assert.equal(s.tokens.input, sum("inputTokens") - sum("cacheReadTokens") - sum("cacheWriteTokens"));
    assert.equal(s.tokens.output, sum("outputTokens"));
  }
});

test("every call counts in AI credits, whoever started it", () => {
  for (const s of copilot) {
    const expected = usages(s.id).reduce((n, u) => n + u.copilotUsage.totalNanoAiu, 0) / 1e9;
    assert.ok(Math.abs(s.aiCredits - expected) < 1e-6, `session ${s.id}`);
    assert.ok(Math.abs(s.turns.reduce((n, t) => n + (t.credits ?? 0), 0) - expected) < 1e-6);
    assert.ok(usages(s.id).some((u) => u.initiator !== "user"));
  }
});

test("counts prompts, tool calls, failures and sub-agents", () => {
  for (const s of copilot) {
    const ev = events(s.id);
    // Prompts sent to sub-agents and autopilot continuations are not the user's.
    const own = ev.filter((e) => e.type === "user.message" && !e.agentId && !e.data.source && !e.data.isAutopilotContinuation);
    assert.equal(s.prompts.length, own.length);
    assert.equal(Object.values(s.toolCounts).reduce((a, b) => a + b, 0), ev.filter((e) => e.type === "tool.execution_start").length);
    assert.equal(s.subAgents, ev.filter((e) => e.type === "subagent.started").length);
    const failed = ev.filter((e) => e.type === "tool.execution_complete" && e.data.success === false).length;
    assert.equal(s.toolSequence.filter((c) => c.result?.isError).length, failed);
    // Sub-agent calls are turns of their own, flagged like Claude Code's sidechains.
    assert.equal(s.turns.filter((t) => t.sidechain).length, usages(s.id).filter((u) => u.initiator === "sub-agent").length);
  }
});

test("an open question or permission prompt needs the user", async () => {
  const asking = copilot.find((s) => events(s.id).some((e) => e.data?.toolName === "ask_user"));
  const t = await lib.parseCopilotEvents(join(STATE, asking.id, "events.jsonl"));
  const now = Date.now();
  assert.deepEqual(
    { state: lib.copilotLiveState(t, { working: true }, now).state, reason: lib.copilotLiveState(t, { working: true }, now).reason },
    { state: "needs-you", reason: "question" },
  );
  assert.equal(lib.copilotLiveState(t, null, now).text, "Redis or SQLite for the cache?");

  const done = copilot.find((s) => s.id !== asking.id);
  const d = await lib.parseCopilotEvents(join(STATE, done.id, "events.jsonl"));
  assert.equal(lib.copilotLiveState(d, { working: true }, now).state, "working");
  assert.equal(lib.copilotLiveState(d, { working: false }, now).state, "your-turn");
  assert.equal(lib.copilotLiveState(d, { working: false }, now).text, "Done: the change is in and the tests pass.");
  assert.equal(lib.copilotLiveState({ ...d, pendingCall: { tool: "permission", preview: "git push", tsMs: now } }, null, now).reason, "permission");
});

test("the session files give the Copilot quota and the Codex limits", () => {
  const q = limits.copilotLimits(parsed.readings.copilot);
  assert.equal(q.month.entitlement, 1500);
  // The last call of the newest session that logged a quota.
  assert.ok(q.month.used > 640);
  assert.ok(q.month.resetsAt > Date.now());
  const c = limits.codexLimits(parsed.readings.codex);
  assert.equal(c.plan, "plus");
  assert.ok(c.fiveHour && c.sevenDay);
  assert.ok(c.fiveHour.resetsAt > Date.now() && c.sevenDay.resetsAt > c.fiveHour.resetsAt);
});

test("codex limits: windows placed by length, reset windows start over", () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const reading = (primary, secondary) => ({ tsMs: now - 60_000, plan: "pro", primary, secondary });
  const w = (usedPct, resetsAt, windowMinutes) => ({ usedPct, resetsAt, windowMinutes });
  assert.deepEqual(limits.codexLimits(reading(w(12, now + 3_600_000, 300), w(40, now + 86_400_000, 10080)), now), {
    capturedAt: now - 60_000,
    plan: "pro",
    fiveHour: { usedPct: 12, resetsAt: now + 3_600_000 },
    sevenDay: { usedPct: 40, resetsAt: now + 86_400_000 },
  });
  // A plan with only a weekly limit, logged as the primary window.
  const weekly = limits.codexLimits(reading(w(30, now + 86_400_000, 10080), null), now);
  assert.equal(weekly.fiveHour, null);
  assert.equal(weekly.sevenDay.usedPct, 30);
  // The 5h window reset since the reading.
  assert.deepEqual(limits.codexLimits(reading(w(90, now - 1, 300), null), now).fiveHour, { usedPct: 0, resetsAt: null });
  assert.equal(limits.codexLimits(null, now), null);
});

test("codex limits: older rollouts give the time left, other limit ids are skipped", async () => {
  const { codexRateLimits } = await import("../scripts/codex.mjs");
  const ts = Date.UTC(2026, 9, 15, 12);
  const r = codexRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 600 } }, ts);
  assert.equal(r.primary.resetsAt, ts + 600_000);
  assert.equal(codexRateLimits({ limit_id: "gpt-6-astra", primary: { used_percent: 5 } }, ts), null);
  assert.equal(codexRateLimits({ limit_id: "codex" }, ts), null);
});

test("copilot limits: a month's use, overage past the entitlement, none when unlimited", () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const q = (extra) => ({ tsMs: now, unlimited: false, entitlement: 300, used: 120, remainingPct: 60, overage: 0, resetsAt: Date.UTC(2026, 10, 1), ...extra });
  assert.equal(limits.copilotLimits(q(), now).month.usedPct, 40);
  assert.equal(Math.round(limits.copilotLimits(q({ used: 330, remainingPct: 0 }), now).month.usedPct), 110);
  assert.equal(limits.copilotLimits(q({ used: null }), now).month.used, 120);
  assert.equal(limits.copilotLimits(q({ resetsAt: now - 1 }), now).month.usedPct, 0);
  assert.equal(limits.copilotLimits(q({ unlimited: true }), now), null);
  assert.equal(limits.copilotLimits(null, now), null);
});

test("credits stay unknown for sessions an older CLI logged without usage records", async () => {
  const path = join(root, "old-events.jsonl");
  const at = (s) => new Date(Date.UTC(2026, 9, 8, 9, 0, s)).toISOString();
  writeFileSync(path, [
    { type: "session.start", data: { copilotVersion: "1.0.40", selectedModel: "claude-opus-5.5", context: { cwd: "/tmp/x" } }, timestamp: at(0) },
    { type: "user.message", data: { content: "Hello" }, timestamp: at(1) },
    { type: "assistant.message", data: { content: "Hi." }, timestamp: at(2) },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = await lib.parseCopilotEvents(path);
  assert.equal(t.aiCredits, null);
  assert.equal(t.userMessages, 1);
});

test("the Copilot status line reads the cache state from the last main-thread call", async () => {
  const { copilotSnapshot, lastUsage } = await import("../scripts/copilot-statusline.mjs");
  const { adviseContext, expiringSoon } = await import("../scripts/context-advice.mjs");
  const done = copilot.find((s) => events(s.id).some((e) => e.agentId));
  const usage = lastUsage(join(STATE, done.id, "events.jsonl"));
  const main = usages(done.id).filter((u) => u.initiator !== "sub-agent").at(-1);
  assert.deepEqual(usage, main);

  const at = Date.parse(usage.cacheExpiresAt);
  const payload = { session_id: done.id, context_window: { context_window_size: 200_000, used_percentage: 21.4 } };
  const warm = copilotSnapshot(payload, usage, at - 90_000);
  assert.deepEqual(warm.context, { usedPct: 21, size: 200_000, tokens: usage.inputTokens });
  assert.equal(warm.cache.ttl, "5m");
  assert.equal(warm.cache.recacheTokensIfCold, usage.cacheReadTokens + usage.cacheWriteTokens);
  assert.equal(adviseContext(warm, at - 90_000).cache.state, "warm");
  assert.equal(adviseContext(copilotSnapshot(payload, usage, at + 1), at + 1).cache.state, "cold");
  assert.equal(copilotSnapshot({ session_id: "not-a-uuid" }, usage), null);

  // A 5-minute cache is "expiring" in its last 100 s, not for its whole life.
  assert.equal(expiringSoon("5m"), 100);
  assert.equal(expiringSoon("1h"), 600);
  assert.equal(expiringSoon(null), 600);
});
