/**
 * Keeps the dashboard and the status line on the installed version after a plugin update.
 * A server from an older Marey (or ccblackbox) still holding the port is replaced, and an
 * installed status line wrapper is refreshed. Only Marey's own processes and files are touched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

/** True when version `a` is older than `b` (x.y.z). A missing `a` (a server from before /api/version) counts as older. */
export function isOlder(a, b) {
  if (!a) return true;
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };

async function get(url, as) {
  const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
  return as === "json" ? res.json() : res.text();
}

/**
 * The Marey server listening on `port`, as { version, pid }, or null when the port is free or
 * held by something else. Servers from before /api/version (it never answers there) are
 * recognized by their command line and the page they serve; their version is null.
 */
export async function runningServer(port) {
  try {
    const body = await get(`http://127.0.0.1:${port}/api/version`, "json");
    if (body?.name === "marey" && Number.isInteger(body.pid)) return { version: body.version, pid: body.pid };
  } catch { /* older server, or not ours */ }
  try {
    const pid = Number(execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], quiet).trim().split("\n")[0]);
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], quiet).trim();
    if (!pid || !/\bnode\b.*scripts\/serve\.mjs/.test(command)) return null;
    const page = await get(`http://127.0.0.1:${port}/`, "text");
    if (/<title>(Marey|ccblackbox)<\/title>/.test(page)) return { version: null, pid };
  } catch { /* no lsof (Windows), nothing listening, or not ours */ }
  return null;
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** Stops the server `pid` and waits up to `timeoutMs` for `port` to be free. */
export async function stopServer(pid, port, timeoutMs = 4000) {
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await isListening(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * /marey:limits installs a copy of the status line wrapper (and its helper) in the data folder,
 * so a plugin update alone leaves it behind. When it is installed, replace any file that
 * differs from this version's. Written through a temp file: the status line may run meanwhile.
 * Returns true when something changed.
 */
export function refreshStatusline(dir, scriptsDir) {
  if (!existsSync(join(dir, "statusline.mjs"))) return false;
  let changed = false;
  for (const name of ["statusline.mjs", "context-advice.mjs", "copilot-statusline.mjs"]) {
    const target = join(dir, name);
    // Copilot CLI's status line is only there when /marey:limits could set it.
    if (name === "copilot-statusline.mjs" && !existsSync(target)) continue;
    try {
      const source = readFileSync(join(scriptsDir, name), "utf8");
      if (existsSync(target) && readFileSync(target, "utf8") === source) continue;
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, source);
      renameSync(tmp, target);
      changed = true;
    } catch {
      /* leave it as it is: the status line must never break because of this */
    }
  }
  return changed;
}
