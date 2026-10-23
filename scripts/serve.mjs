#!/usr/bin/env node
/**
 * Marey local server.
 *
 * Serves the prebuilt dashboard (dist/) and the API from scripts/api.mjs
 * (also used by the Vite dev server), on 127.0.0.1 only.
 *
 * Used in three modes:
 *   1. `npx marey` (or `pnpm serve`)
 *   2. The `/replay` slash command from the Claude Code plugin
 *   3. The Codex `replay` skill, via scripts/launch.mjs
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { dirname, join, resolve, extname, normalize, sep } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import { VERSION, handleRequest, startApi } from "./api.mjs";
import { dataDir } from "./data-dir.mjs";
import { isOlder, refreshStatusline, runningServer, stopServer } from "./takeover.mjs";
import { recordInstalled } from "./update-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const args = { port: 3333, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      args.port = Number(argv[++i]);
      if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
        console.error(`[marey] invalid --port: ${argv[i]}`);
        process.exit(1);
      }
    }
    else if (a === "--no-open") args.open = false;
    else if (a === "--open") args.open = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "marey — local dashboard for Claude Code and Codex sessions\n" +
        "\n" +
        "Usage: marey [options]\n" +
        "  --port <n>       listen on port (default: 3333)\n" +
        "  --no-open        do not open the browser on start\n",
      );
      process.exit(0);
    }
  }
  return args;
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

/** A read error (removed by a rebuild, unreadable) would crash the server unheard: answer 500 instead. */
function pipeFile(path, res) {
  createReadStream(path)
    .on("error", () => (res.headersSent ? res.destroy() : send(res, 500, "could not read file")))
    .pipe(res);
}

async function serveStatic(req, res) {
  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  const safe = normalize(urlPath).replace(/^([./\\])+/, "");
  const filePath = join(DIST, safe);
  if (!filePath.startsWith(DIST + sep) && filePath !== DIST) {
    return send(res, 403, "forbidden");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: any unknown path → index.html
    const index = join(DIST, "index.html");
    if (existsSync(index)) {
      res.setHeader("content-type", MIME[".html"]);
      return pipeFile(index, res);
    }
    return send(res, 404, "not found");
  }
  const ext = extname(filePath).toLowerCase();
  res.setHeader("content-type", MIME[ext] || "application/octet-stream");
  pipeFile(filePath, res);
}

async function openBrowser(url) {
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    execFile(opener, [url], { shell: platform() === "win32" });
  } catch { /* best-effort */ }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(DIST)) {
    console.warn("[marey] dist/ not found — run `pnpm build` to produce the UI bundle.");
  }

  if (refreshStatusline(dataDir(), __dirname)) console.log(`[marey] status line wrapper updated to ${VERSION}`);
  recordInstalled(dataDir(), VERSION);

  const server = createServer(async (req, res) => {
    try {
      if (await handleRequest(req, res)) return;
      // Awaited, so a throw (a file removed between its checks) lands in the catch below.
      return await serveStatic(req, res);
    } catch (e) {
      console.error("[marey] handler error:", e);
      send(res, 500, "internal error");
    }
  });

  // Loopback only: the API serves prompts, file snapshots and account info.
  const listen = () => server.listen(args.port, "127.0.0.1");
  let replaced = false;

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      const url = `http://localhost:${args.port}`;
      // After a plugin update, the server still running is the old version: replace it.
      const running = replaced ? null : await runningServer(args.port);
      if (running && isOlder(running.version, VERSION) && (await stopServer(running.pid, args.port))) {
        replaced = true;
        console.log(`[marey] replaced Marey ${running.version ?? "(older)"} on port ${args.port} with ${VERSION}`);
        return listen();
      }
      console.log(
        running
          ? `[marey] Marey ${running.version ?? "(older)"} is already running at ${url}`
          : `[marey] port ${args.port} is already in use. If Marey is running, it is at ${url}; otherwise pass --port <n>.`,
      );
      if (args.open) openBrowser(url);
      process.exit(0);
    }
    console.error("[marey] server error:", err.message);
    process.exit(1);
  });

  // Take the port first, then parse: the browser opens at once and shows the dashboard's
  // loading screen while data routes wait for the first parse (a cold start can take a while).
  server.on("listening", () => {
    const url = `http://localhost:${args.port}`;
    console.log(`[marey] ${VERSION} listening on ${url}`);
    if (args.open) openBrowser(url);
    startApi().catch((err) => {
      console.error("[marey] fatal:", err);
      process.exit(1);
    });
  });
  listen();
}

main().catch((err) => {
  console.error("[marey] fatal:", err);
  process.exit(1);
});
