// Model ids and API prices (scripts/models.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, isKnownModel, normalizeModel, priceFor } from "../scripts/models.mjs";

test("older ids normalize to their own row, not the default model", () => {
  assert.equal(normalizeModel("claude-opus-4-1-20250805"), "opus-4.1");
  assert.equal(normalizeModel("claude-sonnet-4-0"), "sonnet-4");
  assert.equal(normalizeModel("claude-sonnet-4-20250514"), "sonnet-4");
  assert.equal(normalizeModel("claude-3-7-sonnet-20250219"), "sonnet-3.7");
  assert.equal(normalizeModel("claude-3-haiku-20240307"), "haiku-3");
  assert.deepEqual(priceFor("opus-4.1"), { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 });
  assert.equal(priceFor("sonnet-4").in, 3);
  // Retired 3.x models have no published price: their family's latest, flagged as an estimate.
  assert.equal(isKnownModel("sonnet-3.7"), false);
  assert.equal(priceFor("sonnet-3.7").in, priceFor("sonnet-5.5").in);
});

test("Haiku 5.5 has its own row, and the bare alias points at it", () => {
  assert.equal(normalizeModel("claude-haiku-5-5"), "haiku-5.5");
  assert.equal(normalizeModel("haiku"), "haiku-5.5");
  assert.deepEqual(priceFor("haiku-5.5"), { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 });
});

test("a Haiku 5.5 request with a prompt over 100k tokens pays the long-prompt tier", () => {
  // The prompt counts input, cache reads and cache writes; exactly 100k stays on the base tier.
  const at = { input: 1_000, cacheRead: 95_000, cacheWrite: 4_000, output: 1_000 };
  const over = { ...at, cacheRead: 95_001 };
  assert.equal(costOf("haiku-5.5", at).toFixed(5), ((1_000 * 0.1 + 95_000 * 0.01 + 4_000 * 0.125 + 1_000 * 0.5) / 1e6).toFixed(5));
  assert.equal(costOf("haiku-5.5", over).toFixed(5), ((1_000 * 0.5 + 95_001 * 0.05 + 4_000 * 0.625 + 1_000 * 2.5) / 1e6).toFixed(5));
  // Other models have no tier.
  assert.equal(priceFor("opus-5.5", 900_000).in, 4);
});
