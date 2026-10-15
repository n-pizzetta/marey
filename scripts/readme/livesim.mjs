// Simulates a running Claude Code session inside the demo config dir.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(ROOT, ".demo-claude");
const proc = spawn(join(ROOT, ".readme-rec", "bin", "claude"), ["3600"], { stdio: "ignore", detached: true });
proc.unref();
const id = randomUUID(), cwd = "/Users/demo/dev/web-dashboard";
const dir = join(CLAUDE, "projects", "-Users-demo-dev-web-dashboard");
const file = join(dir, `${id}.jsonl`);
const start = Date.now() - 14 * 60_000;
mkdirSync(join(CLAUDE, "sessions"), { recursive: true });
mkdirSync(join(CLAUDE, "marey", "live"), { recursive: true });
writeFileSync(join(CLAUDE, "sessions", `${proc.pid}.json`), JSON.stringify({ pid: proc.pid, sessionId: id, cwd, startedAt: start }));
// The window every demo Opus 5.5 session is read against (the parser takes it from this snapshot):
// 200k, as the seeded sessions compact around 70% of it.
const WINDOW = 200_000;
let n = 0, ctx = 24_000, pending = null;
const base = () => ({ sessionId: id, cwd });
const line = (o) => appendFileSync(file, JSON.stringify({ ...base(), ...o }) + "\n");
const TOOLS = [["Read", { file_path: "/Users/demo/dev/web-dashboard/src/theme.ts" }], ["Grep", { pattern: "prefers-color-scheme" }], ["Edit", { file_path: "/Users/demo/dev/web-dashboard/src/theme.ts", old_string: "light", new_string: "system" }], ["Bash", { command: "pnpm test theme" }], ["Read", { file_path: "/Users/demo/dev/web-dashboard/src/Toggle.tsx" }], ["Edit", { file_path: "/Users/demo/dev/web-dashboard/src/Toggle.tsx", old_string: "x", new_string: "y" }], ["Bash", { command: "pnpm typecheck" }]];
function turn(ts, last = false) {
  n++; ctx += 2500 + Math.round(Math.random() * 2500);
  const [name, input] = TOOLS[n % TOOLS.length];
  const msg = { id: `msg_live${n}`, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 8, output_tokens: 600 + n * 37 % 900, cache_read_input_tokens: ctx - 3000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3000 } } };
  const tid = `toolu_live${n}`;
  if (pending) { line({ type: "user", timestamp: new Date(ts - 400).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: pending, content: "ok" }] } }); pending = null; }
  line({ type: "assistant", timestamp: new Date(ts).toISOString(), requestId: `req_live${n}`, message: { ...msg, content: [{ type: "tool_use", id: tid, name, input }] } });
  if (last) pending = tid;
  else line({ type: "user", timestamp: new Date(ts + 1500).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } });
  writeFileSync(join(CLAUDE, "marey", "live", `${id}.json`), JSON.stringify({ v: 1, sessionId: id, capturedAt: Date.now(), model: "claude-opus-5-5", costUsd: 2 + n * 0.11, context: { usedPct: Math.round((ctx / WINDOW) * 100), size: WINDOW, tokens: ctx }, cache: { observed: true, warm: true, ttl: "1h", expiresAt: Math.floor(Date.now() / 1000) + 3540, requests: n + 10, misses: 1, hitRatio: 0.94, lastMissCause: null, recacheTokensIfCold: ctx } }));
}
line({ type: "user", timestamp: new Date(start).toISOString(), message: { role: "user", content: "Build a dark-mode toggle that respects the system setting" } });
for (let i = 0; i < 14; i++) turn(start + 30_000 + i * 55_000);
console.log(JSON.stringify({ pid: proc.pid, id }));
setInterval(() => turn(Date.now(), true), Number(process.env.EVERY ?? 2500));
