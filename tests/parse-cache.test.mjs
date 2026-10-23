// The parser's in-memory caches, against the synthetic data from scripts/seed-demo.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marey-cache-test-"));
const CLAUDE = join(root, ".claude");
const PROJECTS = join(CLAUDE, "projects");

let parser;

before(async () => {
  execFileSync(process.execPath, ["scripts/seed-demo.mjs", CLAUDE, join(root, ".codex"), join(root, ".copilot")], { stdio: "ignore" });
  // The parser resolves CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME at import time.
  process.env.CLAUDE_CONFIG_DIR = CLAUDE;
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.COPILOT_HOME = join(root, ".copilot");
  parser = await import("../scripts/parse-sessions.mjs");
});

after(() => rmSync(root, { recursive: true, force: true }));

/** A seeded Claude transcript and how many sub-agent transcripts it has. */
function someTranscript() {
  for (const dir of readdirSync(PROJECTS)) {
    const file = readdirSync(join(PROJECTS, dir)).find((f) => f.endsWith(".jsonl"));
    if (!file) continue;
    const subDir = join(PROJECTS, dir, file.replace(/\.jsonl$/, ""), "subagents");
    const subagents = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).length : 0;
    return { path: join(PROJECTS, dir, file), subagents };
  }
  throw new Error("no seeded transcript");
}

test("light sessions match the full parse in the list, and in the detail once opened", async () => {
  const full = await parser.parseAllSessions();
  const light = await parser.parseAllSessions({ light: true });
  assert.equal(light.sessions.length, full.sessions.length);
  const byId = new Map(full.sessions.map((s) => [s.id, s]));
  for (const s of light.sessions) {
    const want = byId.get(s.id);
    assert.deepEqual(parser.summarizeSession(s), parser.summarizeSession(want), `list of ${s.id}`);
    assert.deepEqual(await parser.sessionDetail(s), want, `detail of ${s.id}`);
  }
});

test("light sessions keep no calls, timeline, file paths or prompt texts", async () => {
  const { sessions } = await parser.parseAllSessions({ light: true });
  assert.deepEqual(sessions.filter((s) => s.toolSequence.length || s.timeline.length || s.fileHistory.length).map((s) => s.id), []);
  assert.ok(sessions.some((s) => s.prompts.length > 0));
  assert.ok(sessions.every((s) => s.prompts.every((p) => p.text === undefined && "preview" in p)));
});

test("counts the plugin hook's captures like a full parse, and again after the hook appends", async () => {
  const { sessions } = await parser.parseAllSessions();
  const s = sessions.find((x) => x.agent === "claude" && !x.ghost);
  const dir = join(CLAUDE, "marey", "cache");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.id}.jsonl`);
  const t0 = Date.parse(s.startedAt);
  const call = (i) => JSON.stringify({ kind: "tool", t: t0 + i * 1000, tool: "Bash", inPreview: `{"command":"echo ${i}"}`, outPreview: `${i}\u2028` }) + "\n";
  const capture = async (opts) => (await parser.parseAllSessions(opts)).sessions.find((x) => x.id === s.id).pluginCapture;
  writeFileSync(file, call(1) + call(2));
  const full = await capture();
  assert.equal(full.entries, 2);
  // Light parses in a row: the second one reuses the counts, the one after the append reads again.
  assert.deepEqual(await capture({ light: true }), full);
  assert.deepEqual(await capture({ light: true }), full);
  appendFileSync(file, call(3) + JSON.stringify({ kind: "stop", t: t0 + 9000 }) + "\n");
  const appended = await capture({ light: true });
  assert.equal(appended.entries, 3);
  assert.deepEqual(appended, await capture());
});

test("tells running Claude Code processes from other and finished ones with one ps", { skip: process.platform === "win32" }, async () => {
  // A process whose command is named claude: node behind a symlink.
  const claude = join(root, "claude");
  symlinkSync(process.execPath, claude);
  const child = spawn(claude, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const finished = 2 ** 22 + 1; // above any pid macOS or Linux hands out by default
    assert.deepEqual([...parser.claudePids([child.pid, process.pid, finished, null])], [child.pid]);
  } finally {
    child.kill();
  }
});

/** The longest seeded main transcript: its path, session id and lines. */
function longestTranscript() {
  let best = null;
  for (const dir of readdirSync(PROJECTS)) {
    for (const f of readdirSync(join(PROJECTS, dir)).filter((f) => f.endsWith(".jsonl"))) {
      const lines = readFileSync(join(PROJECTS, dir, f), "utf8").split("\n").filter(Boolean);
      if (!best || lines.length > best.lines.length) best = { path: join(PROJECTS, dir, f), id: f.replace(/\.jsonl$/, ""), lines };
    }
  }
  return best;
}

/** Session `id` as the list and its detail show it, after a light or a full parse. */
async function viewOf(id, { light }) {
  const s = (await parser.parseAllSessions({ light })).sessions.find((x) => x.id === id);
  return { list: parser.summarizeSession(s), detail: light ? await parser.sessionDetail(s) : s };
}

test("reads only what was appended to a transcript being written, as a full parse would", async () => {
  const { path, id, lines } = longestTranscript();
  const half = Math.floor(lines.length / 2);
  const cut = Math.floor(lines[half].length / 2);
  // Written up to the middle of a line: that line is read once its end is there.
  writeFileSync(path, lines.slice(0, half).join("\n") + "\n" + lines[half].slice(0, cut));
  const fullBefore = await viewOf(id, { light: false });
  assert.deepEqual(await viewOf(id, { light: true }), fullBefore);
  // Light parses in a row, as the server runs them: the second one reads only the appended lines.
  const appended = parser.claudeReads.appended;
  appendFileSync(path, lines[half].slice(cut) + "\n" + lines.slice(half + 1).join("\n") + "\n");
  const lightAfter = await viewOf(id, { light: true });
  assert.equal(parser.claudeReads.appended, appended + 1);
  assert.deepEqual(lightAfter, await viewOf(id, { light: false }));
  assert.notDeepEqual(lightAfter, fullBefore);
});

test("reads a rewritten transcript again from the start", async () => {
  const { path, id, lines } = longestTranscript();
  await parser.parseAllSessions({ light: true });
  const whole = parser.claudeReads.whole;
  // Longer than before, but not an append: the first line changed.
  const first = JSON.parse(lines[0]);
  writeFileSync(path, [JSON.stringify({ ...first, version: "9.9.9" }), ...lines.slice(1), lines.at(-1)].join("\n") + "\n");
  const lightView = await viewOf(id, { light: true });
  assert.equal(parser.claudeReads.whole, whole + 1);
  assert.deepEqual(lightView, await viewOf(id, { light: false }));
});

test("reads transcript lines that hold U+2028 or U+2029, as JSON strings may", async () => {
  // Not the transcript the tests above rewrite.
  const { path, id } = longestTranscript();
  const other = readdirSync(PROJECTS).flatMap((d) => readdirSync(join(PROJECTS, d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(PROJECTS, d, f))).find((f) => f !== path);
  const otherId = other.split("/").pop().replace(/\.jsonl$/, "");
  assert.notEqual(otherId, id);
  const template = readFileSync(other, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((j) => j.message?.role === "assistant" && j.message.usage);
  const count = async (light) => (await parser.parseAllSessions({ light })).sessions.find((s) => s.id === otherId);
  const before = await count(false);
  const reply = { ...template, uuid: "u2028", message: { ...template.message, id: "msg_u2028", content: [{ type: "text", text: "one\u2028two\u2029three" }], usage: { input_tokens: 1, output_tokens: 7 } } };
  appendFileSync(other, JSON.stringify(reply) + "\n");
  for (const light of [false, true]) {
    const after = await count(light);
    assert.equal(after.messages, before.messages + 1, light ? "light" : "full");
    assert.equal(after.tokens.output, before.tokens.output + 7, light ? "light" : "full");
  }
});

test("drops a deleted transcript and its sub-agents from the cache at the next parse", async () => {
  await parser.parseAllSessions();
  const before = parser.cachedTranscriptCount();
  const { path, subagents } = someTranscript();
  rmSync(path);
  await parser.parseAllSessions();
  assert.equal(parser.cachedTranscriptCount(), before - 1 - subagents);
});
