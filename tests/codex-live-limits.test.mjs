// Codex's limits asked live from `codex app-server` (scripts/codex-live-limits.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLiveRateLimits, readCodexLiveLimits } from "../scripts/codex-live-limits.mjs";
import { codexLimits } from "../scripts/provider-limits.mjs";

const NOW = Date.UTC(2026, 9, 15, 12, 37);
const MIN = 60_000;
const sec = (ms) => Math.floor(ms / 1000);
const win = (usedPercent, resetsAtMs, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: sec(resetsAtMs) });
const limit = (primary, secondary, limitId = "codex") => ({ limitId, primary, secondary, planType: "plus" });

test("a live reading in the rollouts' shape, marked live", () => {
  const rl = limit(win(10, NOW + 2 * 60 * MIN, 300), win(20, NOW + 3 * 1440 * MIN, 10080));
  assert.deepEqual(codexLiveRateLimits({ rateLimits: rl, rateLimitsByLimitId: { codex: rl } }, NOW), {
    tsMs: NOW,
    plan: "plus",
    primary: { usedPct: 10, resetsAt: sec(NOW + 2 * 60 * MIN) * 1000, windowMinutes: 300 },
    secondary: { usedPct: 20, resetsAt: sec(NOW + 3 * 1440 * MIN) * 1000, windowMinutes: 10080 },
    live: true,
  });
  assert.equal(codexLimits(codexLiveRateLimits({ rateLimits: rl }, NOW), NOW).live, true);
});

test("a window at 0% with a full window left has not started: no reset time", () => {
  // What Codex answered on 2026-10-15 after an early weekly reset: both windows unopened.
  const rl = limit(win(0, NOW + 300 * MIN, 300), win(0, NOW + 10080 * MIN, 10080));
  const r = codexLiveRateLimits({ rateLimits: rl }, NOW);
  assert.equal(r.primary.resetsAt, null);
  assert.equal(r.secondary.resetsAt, null);
  assert.deepEqual(codexLimits(r, NOW).sevenDay, { usedPct: 0, resetsAt: null });
  // Opened a while ago, still at 0%: the reset stands.
  assert.notEqual(codexLiveRateLimits({ rateLimits: limit(win(0, NOW + 200 * MIN, 300), null) }, NOW).primary.resetsAt, null);
});

test("only the account's codex limit counts", () => {
  const premium = limit(null, null, "premium");
  assert.equal(codexLiveRateLimits({ rateLimits: premium, rateLimitsByLimitId: { premium } }, NOW), null);
  assert.equal(codexLiveRateLimits({ rateLimits: limit(null, null) }, NOW), null);
  assert.equal(codexLiveRateLimits(null, NOW), null);
});

const dir = mkdtempSync(join(tmpdir(), "marey-codex-live-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for `codex app-server` that answers each request with `reply(msg)`. */
function fakeCodex(name, reply) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const reply = ${reply};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const out = reply(msg);
    if (out) process.stdout.write(JSON.stringify({ id: msg.id, ...out }) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("asks codex app-server after initializing, then stops it", async () => {
  const command = fakeCodex(
    "codex-ok",
    `(msg) => msg.method === "initialize" ? { result: { userAgent: "fake" } }
      : msg.method === "account/rateLimits/read" ? { result: { rateLimits: { limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: ${sec(Date.now() + 60 * MIN)} }, secondary: null, planType: "pro" } } }
      : null`,
  );
  const r = await readCodexLiveLimits({ command, timeoutMs: 5000 });
  assert.equal(r.live, true);
  assert.equal(r.plan, "pro");
  assert.equal(r.primary.usedPct, 42);
});

test("an error, a missing command or no answer gives null", async () => {
  const err = fakeCodex("codex-err", `(msg) => msg.id === 2 ? { error: { code: -32600, message: "not signed in" } } : { result: {} }`);
  assert.equal(await readCodexLiveLimits({ command: err, timeoutMs: 5000 }), null);
  assert.equal(await readCodexLiveLimits({ command: join(dir, "missing"), timeoutMs: 5000 }), null);
  const mute = fakeCodex("codex-mute", `() => null`);
  assert.equal(await readCodexLiveLimits({ command: mute, timeoutMs: 300 }), null);
});
