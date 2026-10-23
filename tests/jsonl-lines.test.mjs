// JSONL lines end at \n only: JSON strings may hold U+2028 and U+2029, where readline ends lines too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { jsonlLines } from "../scripts/transcript-utils.mjs";

const root = mkdtempSync(join(tmpdir(), "marey-jsonl-"));
const CLAUDE = join(root, ".claude");
const CODEX = join(root, ".codex");
const COPILOT = join(root, ".copilot");

before(() => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, CODEX, COPILOT], { stdio: "ignore" });
  process.env.CODEX_HOME = CODEX;
  process.env.COPILOT_HOME = COPILOT;
});

after(() => rmSync(root, { recursive: true, force: true }));

const collect = async (lines) => {
  const out = [];
  for await (const l of lines) out.push(l);
  return out;
};

test("ends lines at \\n only, across read chunks", async () => {
  const path = join(root, "lines.jsonl");
  // Longer than a read chunk, with two-byte characters split between chunks.
  const lines = ["one two", "é".repeat(100_000), "", "three four"];
  writeFileSync(path, lines.join("\n"));
  assert.deepEqual(await collect(jsonlLines(path)), lines);
  writeFileSync(path, lines.join("\n") + "\n");
  assert.deepEqual(await collect(jsonlLines(path)), lines);
  for await (const l of jsonlLines(path)) {
    assert.equal(l, lines[0]);
    break;
  }
});

/** The first seeded file under `dir` whose path matches `re` and that holds `has`. */
function seeded(dir, re, has = "") {
  const all = readdirSync(dir, { recursive: true }).map((f) => join(dir, f));
  const path = all.find((f) => re.test(f) && readFileSync(f, "utf8").includes(has));
  assert.ok(path, `a seeded ${re}`);
  return path;
}

/** A copy of `path`, same name, with a U+2028 and a U+2029 in every line. */
function withSeparators(path) {
  const dir = join(root, "copy", String(Math.random()).slice(2));
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, basename(path));
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  writeFileSync(copy, lines.map((l) => JSON.stringify({ ...JSON.parse(l), note: "a b c" })).join("\n") + "\n");
  return copy;
}

test("Codex rollouts, Copilot events and terminal titles read lines that hold U+2028 or U+2029", async () => {
  const { parseCodexRollout } = await import("../scripts/codex.mjs");
  const { parseCopilotEvents } = await import("../scripts/copilot.mjs");
  const { sessionTitles } = await import("../scripts/focus-terminal.mjs");
  const rollout = seeded(CODEX, /rollout-.*\.jsonl$/);
  assert.deepEqual(await parseCodexRollout(withSeparators(rollout)), await parseCodexRollout(rollout));
  const events = seeded(COPILOT, /events\.jsonl$/);
  assert.deepEqual(await parseCopilotEvents(withSeparators(events)), await parseCopilotEvents(events));
  const transcript = seeded(join(CLAUDE, "projects"), /\.jsonl$/, '"custom-title"');
  const titles = await sessionTitles(transcript);
  assert.ok(titles.length > 0);
  assert.deepEqual(await sessionTitles(withSeparators(transcript)), titles);
});
