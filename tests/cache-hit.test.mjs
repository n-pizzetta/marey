// The share of input read from the prompt cache (src/utils/fleetStats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheHit, inputTokens } from "../src/utils/fleetStats.ts";

test("a cache write is input read fresh, not a hit", () => {
  // Claude models: an uncached prompt is billed as cache write, all but its last few tokens.
  const claude = { input: 6, output: 400, cacheRead: 90_000, cacheWrite: 10_000 };
  assert.equal(inputTokens(claude), 100_006);
  assert.equal(cacheHit(claude).toFixed(3), "0.900");
  // Codex never writes: the fresh part is all in `input`.
  assert.equal(cacheHit({ input: 25_000, output: 300, cacheRead: 75_000, cacheWrite: 0 }), 0.75);
  assert.equal(cacheHit({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }), 0);
});
