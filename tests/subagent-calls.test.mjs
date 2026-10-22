// Sub-agent calls nested under the call that ran them (scripts/subagent-calls.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { countNestedCalls, nestSubagentCalls } from "../scripts/subagent-calls.mjs";

const call = (t, tool, extra = {}) => ({ t, tool, preview: extra.preview ?? `${tool} at ${t}`, ...extra });
const run = (firstT, n, extra = {}) => ({ firstT, calls: Array.from({ length: n }, (_, i) => call(firstT + i, "Read")), ...extra });

test("a sub-agent goes under the call whose result names it, whatever the order", () => {
  const main = [call(0, "Read"), call(10, "Agent", { agentId: "a1" }), call(20, "Agent", { agentId: "a2" })];
  const out = nestSubagentCalls(main, [run(21, 2, { agentId: "a2" }), run(11, 3, { agentId: "a1" })]);
  assert.deepEqual(out.map((e) => [e.t, e.children?.length ?? 0]), [[0, 0], [10, 3], [20, 2]]);
  assert.ok(out.every((e) => !("agentId" in e)), "the matching ids are not part of the result");
  assert.deepEqual(out.map((e) => e.subagentId), [undefined, "a1", "a2"], "each starting call names its sub-agent");
});

test("without an id, the prompt picks the call, then the last call before the sub-agent started", () => {
  const main = [
    call(10, "Agent", { preview: "Find the callers" }),
    call(20, "Agent", { preview: "Write the tests" }),
    call(30, "Task", { preview: "Something else" }),
  ];
  const out = nestSubagentCalls(main, [
    run(35, 1, { prompt: "Find the callers of the old API" }), // starts after all three, but its prompt is the first one's
    run(36, 2), // no id, no prompt: the latest free call before it
  ]);
  assert.deepEqual(out.map((e) => e.children?.length ?? 0), [1, 0, 2]);
});

test("a sub-agent no call can be found for gets a row of its own that isn't counted as a call", () => {
  const out = nestSubagentCalls([call(5, "Read")], [run(2, 4, { label: "general-purpose · Survey" })]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { t: 2, tool: "Agent", preview: "general-purpose · Survey", orphan: true, children: out[0].children });
  assert.equal(countNestedCalls(out), 5);
});

test("a call named by a later sub-agent's id is not taken by an earlier sub-agent without one", () => {
  const main = [call(10, "Agent", { agentId: "b" })];
  const out = nestSubagentCalls(main, [run(11, 1), run(12, 2, { agentId: "b" })]);
  assert.equal(out.find((e) => e.subagentId === "b")?.t, 10);
  assert.deepEqual(out.map((e) => [e.t, e.children?.length ?? 0, !!e.orphan]), [[10, 2, false], [11, 1, true]]);
});

test("a captured call with no id goes to the sub-agent whose description it holds", () => {
  // the plugin hook's capture: the call's input as JSON, no result naming the sub-agent
  const captured = (t, description) => call(t, "Agent", { preview: JSON.stringify({ description, prompt: "## Safety" }), source: "plugin" });
  // the last call before each would pair them the wrong way round
  const main = [captured(10, "Demolisher for lot 9"), captured(11, "Prover for lot 9")];
  const out = nestSubagentCalls(main, [
    run(20, 1, { agentId: "d", description: "Demolisher for lot 9" }),
    run(21, 2, { agentId: "p", description: "Prover for lot 9" }),
  ]);
  assert.deepEqual(out.map((e) => [e.t, e.subagentId]), [[10, "d"], [11, "p"]]);
});

test("the count is every call, sub-agent calls included", () => {
  const main = [call(0, "Read"), call(10, "Agent", { agentId: "a" }), call(40, "Bash")];
  const out = nestSubagentCalls(main, [run(11, 13, { agentId: "a" })]);
  // 3 main-thread calls + 13 in the sub-agent, as the session's tool counts add up
  assert.equal(countNestedCalls(out), 16);
});
