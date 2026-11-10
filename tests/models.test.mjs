// Model ids and API prices (scripts/models.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextWindowOf, costOf, isKnownModel, normalizeModel, priceFor, setModelOverrides } from "../scripts/models.mjs";

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

test("Fable 5.2 and Mythos 5.2 have their own rows, and the bare aliases point at them", () => {
  assert.equal(normalizeModel("claude-fable-5-2"), "fable-5.2");
  assert.equal(normalizeModel("fable"), "fable-5.2");
  assert.equal(normalizeModel("mythos[1m]"), "mythos-5.2");
  assert.equal(isKnownModel("fable-5.2"), true);
  // Cheaper than 5.1: priced like it, a 5.2 session read 25% too high.
  assert.deepEqual(priceFor("fable-5.2"), { in: 8, out: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 });
  assert.deepEqual(priceFor("mythos-5.2"), priceFor("fable-5.2"));
  assert.equal(priceFor("fable-5.1").in, 10);
});

test("GPT-6.1 has its own rows instead of the GPT fallback", () => {
  assert.equal(normalizeModel("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.deepEqual(priceFor("gpt-6.1-sol"), { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 });
  assert.deepEqual(priceFor("gpt-6.1-terra"), { in: 1, out: 5, cacheRead: 0.05, cacheWrite: 1.25, cacheWrite1h: 2 });
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

test("a row says the context window of the models that only run at 1M", () => {
  for (const m of ["fable-5.2", "fable-5.1", "mythos-5.2", "opus-5.5", "opus-5", "sonnet-5.5", "opus-5.5-fast"]) assert.equal(contextWindowOf(m), 1_000_000, m);
  // 200k unless asked for more (`[1m]`), or not seen past 200k yet: left to the status line or the peak.
  for (const m of ["opus-4.8", "sonnet-4.6", "sonnet-5", "haiku-5.5", "haiku-4.5", "gpt-6-astra", "opus-9", null]) assert.equal(contextWindowOf(m), null, String(m));
});

test("models.json can give a model its window, and a price override keeps the built-in one", () => {
  try {
    const accepted = setModelOverrides({
      "claude-opus-6": { in: 6, out: 30, cacheRead: 0.6, window: 2_000_000 },
      "claude-opus-5-5": { in: 3, out: 15, cacheRead: 0.15 },
      "claude-sonnet-6": { in: 2, out: 10, cacheRead: 0.1, window: "big" },
    });
    assert.equal(accepted["opus-6"].window, 2_000_000);
    assert.equal(contextWindowOf("opus-6"), 2_000_000);
    assert.equal(priceFor("opus-5.5").in, 3);
    assert.equal(contextWindowOf("opus-5.5"), 1_000_000);
    assert.equal("window" in accepted["sonnet-6"], false);
    assert.equal(contextWindowOf("sonnet-6"), null);
  } finally {
    setModelOverrides(null);
  }
  assert.equal(priceFor("opus-5.5").in, 4);
});
