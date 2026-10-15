/**
 * Codex's limits as its server holds them now, asked through `codex app-server` (the JSON-RPC
 * interface its editor extensions use), the way Codex's own TUI asks every minute. The rollouts
 * only log them with a request, so they miss what changes in between: an early reset, use from
 * another machine. Resolves to null when Codex is missing, signed in with an API key, or offline.
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;
/**
 * A window at 0% whose reset is a full window away has not started: Codex reports the reset a
 * window opened now would have, and it moves with every reading.
 */
const NOT_STARTED_SLACK_MS = 5 * 60_000;

/** The `account/rateLimits/read` result in the shape of `codexRateLimits` (codex.mjs), marked live. */
export function codexLiveRateLimits(result, tsMs) {
  const byId = result?.rateLimitsByLimitId?.codex;
  const rl = byId ?? (result?.rateLimits && (!result.rateLimits.limitId || result.rateLimits.limitId === "codex") ? result.rateLimits : null);
  if (!rl) return null;
  const win = (w) => {
    if (!w || typeof w.usedPercent !== "number") return null;
    const windowMinutes = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
    let resetsAt = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
    if (w.usedPercent === 0 && resetsAt !== null && windowMinutes !== null && resetsAt >= tsMs + windowMinutes * 60_000 - NOT_STARTED_SLACK_MS) {
      resetsAt = null;
    }
    return { usedPct: w.usedPercent, resetsAt, windowMinutes };
  };
  const primary = win(rl.primary);
  const secondary = win(rl.secondary);
  if (!primary && !secondary) return null;
  return { tsMs, plan: typeof rl.planType === "string" ? rl.planType : null, primary, secondary, live: true };
}

/** Starts `codex app-server`, asks for the account's limits, and stops it (about half a second). */
export function readCodexLiveLimits({ version = "0", command = "codex", timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32", windowsHide: true });
    } catch {
      return resolve(null);
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => {}); // EPIPE when it exits first
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === 2) finish(msg.result ? codexLiveRateLimits(msg.result, Date.now()) : null);
      }
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "marey", title: "Marey", version } } });
    send({ method: "initialized" });
    send({ id: 2, method: "account/rateLimits/read" });
  });
}
