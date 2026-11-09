// A request made in fast mode costs twice its model's rates (scripts/models.mjs, scripts/parse-sessions.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseModel, costOf, isKnownModel, modelFamily, modelLabel, priceFor, withSpeed } from "../scripts/models.mjs";

const root = mkdtempSync(join(tmpdir(), "marey-fast-"));
const CLAUDE = join(root, ".claude");
const PROJECT = join(CLAUDE, "projects", "-tmp-x");
const ID = "11111111-1111-4111-8111-111111111111";

const USAGE = { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4_000, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 } };
const TOKENS = { input: 1_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000, cacheWrite1h: 3_000 };
const ts = (s) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
const user = (s, text) => JSON.stringify({ type: "user", cwd: "/tmp/x", timestamp: ts(s), message: { role: "user", content: text } });
const asst = (s, speed) =>
  JSON.stringify({ type: "assistant", timestamp: ts(s), message: { id: `m${s}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { ...USAGE, ...(speed ? { speed } : {}) } } });

let session;

before(async () => {
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, `${ID}.jsonl`), `${[user(0, "one"), asst(1, "standard"), user(2, "two"), asst(3, "fast"), user(4, "three"), asst(5)].join("\n")}\n`);
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  const { parseAllSessions } = await import("../scripts/parse-sessions.mjs");
  session = (await parseAllSessions()).sessions.find((s) => s.id === ID);
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a fast model is its model at twice every rate, under a name of its own", () => {
  assert.equal(withSpeed("opus-5.5", "fast"), "opus-5.5-fast");
  assert.equal(withSpeed("opus-5.5", "standard"), "opus-5.5");
  assert.equal(withSpeed("opus-5.5", undefined), "opus-5.5");
  assert.equal(withSpeed(null, "fast"), null);
  assert.equal(baseModel("opus-5.5-fast"), "opus-5.5");
  assert.equal(baseModel("opus-5.5"), "opus-5.5");
  // Anthropic's fast mode table: Opus 5.5 $8 / $40, Fable 5.2 $16 / $80, with the cache multipliers on top.
  assert.deepEqual(priceFor("opus-5.5-fast"), { in: 8, out: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 });
  assert.equal(priceFor("fable-5.2-fast").in, 16);
  assert.equal(priceFor("fable-5.2-fast").out, 80);
  assert.equal(costOf("opus-5.5-fast", TOKENS), 2 * costOf("opus-5.5", TOKENS));
  assert.equal(modelLabel("opus-5.5-fast"), "Opus 5.5 (fast)");
  assert.equal(modelFamily("opus-5.5-fast"), "opus");
  // Known when its model is: a fast turn is no estimate.
  assert.equal(isKnownModel("opus-5.5-fast"), true);
  assert.equal(isKnownModel("opus-9-fast"), false);
});

test("the parser prices a fast turn at the fast rate, and only that one", () => {
  assert.deepEqual(session.turns.map((t) => t.model), ["opus-5.5", "opus-5.5-fast", "opus-5.5"]);
  const one = costOf("opus-5.5", TOKENS);
  assert.ok(Math.abs(session.costUsd - 4 * one) < 1e-9, `${session.costUsd} vs ${4 * one}`);
  assert.equal(session.unpricedModels, undefined);
});
