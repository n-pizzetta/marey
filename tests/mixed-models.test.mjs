// Sessions that switch models are priced turn by turn everywhere (src/utils/costPerKind.ts, fleetStats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf } from "../scripts/models.mjs";
import { sessionCostPerKind } from "../src/utils/costPerKind.ts";
import { bucketizeByProject } from "../src/utils/fleetStats.ts";

const tok = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
// An Opus 5.5 session whose sub-agents ran on Haiku 5.5.
const turns = [
  { t: 0, model: "opus-5.5", tokens: tok(10, 2_000, 40_000, 5_000), tools: [] },
  { t: 60_000, model: "haiku-5.5", tokens: tok(20, 1_500, 30_000, 8_000), tools: [] },
  { t: 120_000, model: "haiku-5.5", tokens: tok(5, 900, 120_000, 1_000), tools: [] },
];
const session = { id: "s", project: "p", model: "opus-5.5", startedAt: "2026-10-20T10:00:00.000Z", tokens: tok(35, 4_400, 190_000, 14_000), turns };
const perTurn = turns.reduce((a, t) => a + costOf(t.model, t.tokens), 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("the per-kind costs add up to the per-turn cost, not the session model's", () => {
  const k = sessionCostPerKind(session);
  near(k.input + k.output + k.cacheRead + k.cacheWrite, perTurn);
  assert.ok(costOf("opus-5.5", session.tokens) > perTurn * 2);
});

test("the usage chart's buckets carry the per-turn cost", () => {
  const from = Date.parse(session.startedAt);
  const [bucket] = bucketizeByProject([session], "all", from, from + 86_400_000);
  near(bucket.byProject.get("p").cost, perTurn);
});
