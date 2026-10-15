// Adds running sessions next to livesim.mjs's, so the Now board shows each state: a Claude Code session
// waiting for your next prompt, one asking a question, and a Copilot CLI session at work.
// Run by restart-live.sh after livesim.mjs; replaces the sessions it added last time (.readme-rec/fleet.out).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, ".readme-rec");
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(ROOT, ".demo-claude");
const COPILOT = process.env.COPILOT_HOME || join(ROOT, ".demo-copilot");
const STATE = join(OUT, "fleet.out");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Undo the previous run.
if (existsSync(STATE)) {
  const prev = JSON.parse(readFileSync(STATE, "utf8"));
  for (const f of prev.files ?? []) rmSync(f, { force: true });
  for (const [f, text] of Object.entries(prev.restore ?? {})) writeFileSync(f, text);
}
const state = { files: [], restore: {} };

/** A process with the given name that only sleeps, so the live checks (`ps -o comm=`) see it running. */
function fakeProcess(name) {
  const bin = join(OUT, "bin", name);
  if (!existsSync(bin)) throw new Error(`${bin} is missing: run restart-live.sh`);
  const proc = spawn(bin, [], { stdio: "ignore", detached: true });
  proc.unref();
  return proc.pid;
}

/** A Claude Code session that is open but idle: `turns` tool calls cycling through `tools`, then `end` (text, or a pending AskUserQuestion). */
function claudeSession({ project, prompt, tools, turns, end, startMin, endMin }) {
  const id = randomUUID(), cwd = `/Users/demo/dev/${project}`;
  const dir = join(CLAUDE, "projects", `-Users-demo-dev-${project}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const start = now - startMin * 60_000, last = now - endMin * 60_000;
  const line = (o) => appendFileSync(file, JSON.stringify({ sessionId: id, cwd, ...o }) + "\n");
  let ctx = 20_000;
  const usage = (out) => {
    // Under livesim.mjs's 200k window, which these sessions are read against too.
    ctx += 3500;
    return { input_tokens: 6, output_tokens: out, cache_read_input_tokens: ctx - 4000, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } };
  };
  line({ type: "user", timestamp: iso(start), message: { role: "user", content: prompt } });
  const step = (last - start) / (turns + 1);
  for (let i = 0; i < turns; i++) {
    const [name, input] = tools[i % tools.length];
    const ts = start + step * (i + 1), tid = `toolu_${id.slice(0, 8)}${i}`;
    line({ type: "assistant", timestamp: iso(ts), requestId: `req_${id.slice(0, 8)}${i}`, message: { id: `msg_${id.slice(0, 8)}${i}`, role: "assistant", model: "claude-opus-5-5", usage: usage(700 + (i % 7) * 90), content: [{ type: "tool_use", id: tid, name, input }] } });
    line({ type: "user", timestamp: iso(ts + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } });
  }
  const content = end.ask
    ? [{ type: "tool_use", id: `toolu_${id.slice(0, 8)}q`, name: "AskUserQuestion", input: { questions: [{ question: end.ask, header: "Choice", multiSelect: false, options: end.options.map((label) => ({ label, description: label })) }] } }]
    : [{ type: "text", text: end.text }];
  line({ type: "assistant", timestamp: iso(last), requestId: `req_${id.slice(0, 8)}e`, message: { id: `msg_${id.slice(0, 8)}e`, role: "assistant", model: "claude-opus-5-5", usage: usage(900), content } });
  const pid = fakeProcess("claude");
  const info = join(CLAUDE, "sessions", `${pid}.json`);
  writeFileSync(info, JSON.stringify({ pid, sessionId: id, cwd, startedAt: start, status: "idle", statusUpdatedAt: last }));
  state.files.push(file, info);
}

claudeSession({
  project: "acme-api",
  prompt: "Add rate limiting to the public REST endpoints",
  tools: [["Read", { file_path: "/Users/demo/dev/acme-api/src/server.ts" }], ["Edit", { file_path: "/Users/demo/dev/acme-api/src/middleware/rateLimit.ts", old_string: "a", new_string: "b" }], ["Bash", { command: "pnpm test rate-limit" }]],
  turns: 34,
  end: { text: "Rate limiting is on for /v1/*: 100 requests a minute per API key, 429 with Retry-After past that. Tests pass." },
  startMin: 34, endMin: 3,
});
claudeSession({
  project: "docs-site",
  prompt: "Add a search box to the docs site",
  tools: [["Read", { file_path: "/Users/demo/dev/docs-site/astro.config.mjs" }], ["Grep", { pattern: "search" }]],
  turns: 12,
  end: { ask: "Which search should the docs use?", options: ["Pagefind (static, no server)", "Algolia DocSearch"] },
  startMin: 12, endMin: 6,
});

// Copilot CLI: the most recent demo session, held by a running `copilot` and busy on a test run.
const sdir = join(COPILOT, "session-state");
const lastTs = (text) => JSON.parse(text.trim().split("\n").at(-1)).timestamp;
const cop = readdirSync(sdir)
  .filter((d) => existsSync(join(sdir, d, "events.jsonl")))
  .map((d) => ({ d, text: readFileSync(join(sdir, d, "events.jsonl"), "utf8") }))
  .sort((a, b) => (lastTs(a.text) < lastTs(b.text) ? 1 : -1))[0];
const events = join(sdir, cop.d, "events.jsonl");
state.restore[events] = cop.text;
const lines = cop.text.trim().split("\n").map((l) => JSON.parse(l));
const lastOf = (type, field) => lines.filter((e) => e.type === type && e.data?.[field]).at(-1);
// The parser keys on `{"type":` at the start of each line.
const add = (o) => appendFileSync(events, JSON.stringify({ type: o.type, ...o, id: randomUUID() }) + "\n");
// The quota rides on each successful model call: a fresh one, so the plan card reads "last request" just now.
const quota = lastOf("model.model_call_success", "quotaSnapshots");
if (quota) add({ ...quota, timestamp: iso(now - 4500) });
add({ ...lastOf("session.usage_record", "usage"), timestamp: iso(now - 4000) });
add({ type: "tool.execution_start", timestamp: iso(now - 3000), data: { toolCallId: "call_fleet1", toolName: "bash", arguments: { command: "pnpm test -- offline-cache" } } });
const cpid = fakeProcess("copilot");
const lock = join(sdir, cop.d, `inuse.${cpid}.lock`);
writeFileSync(lock, String(cpid));
const openFile = join(COPILOT, "open-sessions-state.json");
if (existsSync(openFile)) state.restore[openFile] = readFileSync(openFile, "utf8");
else state.files.push(openFile);
writeFileSync(openFile, JSON.stringify({ [cop.d]: { schemaVersion: 1, openedAt: iso(now - 25 * 60_000), refreshedAt: iso(now), working: true } }));
state.files.push(lock);

writeFileSync(STATE, JSON.stringify(state));
console.log(`fleetsim: 2 Claude Code sessions, Copilot CLI ${cop.d}`);
