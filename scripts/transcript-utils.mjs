/**
 * Helpers shared by the Claude Code transcript parser (parse-sessions.mjs)
 * and the Codex rollout parser (codex.mjs).
 */
import { createReadStream } from "node:fs";

/** Tool name used for counts: MCP tools are grouped per server (`mcp__github__x` → `mcp:github`). */
export const toolKey = (name) => (name.startsWith("mcp__") ? `mcp:${name.split("__")[1] || "unknown"}` : name);

/** Gaps longer than this between two transcript events count as idle, not active time. */
export const IDLE_CAP_MS = 5 * 60_000;
/** A pause up to this long doesn't end a continuous work stretch. */
export const RUN_GAP_MS = 15 * 60_000;

/**
 * Shell command kinds (PRs, tests, lint or build, infra). Matched on the head of each segment
 * (split on && ; | and newlines), so `echo "npm test"` is not a test run.
 */
const RUNNER = String.raw`((npx|bunx|pnpm(\s+(exec|dlx))?|yarn|uv\s+run|poetry\s+run)\s+)?`;
const SHELL_KINDS = {
  prs: /^gh\s+pr\s+create\b/,
  tests: new RegExp(
    String.raw`^${RUNNER}(vitest|jest|pytest|mocha|playwright\s+test|rspec|phpunit)\b` +
      String.raw`|^(pnpm|npm|yarn|bun)\s+(run\s+)?test\b|^(cargo|go|deno|bun|mix|dotnet|swift)\s+test\b` +
      String.raw`|^python3?\s+-m\s+(pytest|unittest)\b|^make\s+test\b`,
  ),
  lints: new RegExp(
    String.raw`^${RUNNER}(eslint|tsc|ruff|biome|oxlint|mypy|pyright|stylelint|prettier\s+--check)\b` +
      String.raw`|^(pnpm|npm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|build|check)\b` +
      String.raw`|^cargo\s+(clippy|check|build)\b|^go\s+(vet|build)\b`,
  ),
  infra: /^(docker|docker-compose|podman|kubectl|helm|terraform|tofu|pulumi|gcloud|aws|az|orb|orbctl|flyctl|vercel|wrangler)\b/,
};

export function countShellKinds(command, into) {
  const hit = new Set();
  for (const raw of command.split(/\n|&&|\|\||;|\|/)) {
    const head = raw
      .trim()
      .replace(/^\(+\s*/, "")
      .replace(/^(\w+=\S*\s+)+/, "")
      .replace(/^((rtk(\s+proxy)?|time|sudo|command|exec)\s+)+/, "");
    for (const [kind, re] of Object.entries(SHELL_KINDS)) if (re.test(head)) hit.add(kind);
  }
  for (const kind of hit) into[kind] += 1;
}

/** `s` as a string of its own: a slice of a string keeps the whole string in memory. */
export const own = (s) => (typeof s === "string" ? structuredClone(s) : s);

/** The first `n` characters of `s`, without keeping the rest of `s` in memory. */
export const clip = (s, n) => own(s.slice(0, n));

/**
 * The lines of a JSONL file, ended at `\n` only: readline also ends them at U+2028 and U+2029,
 * which JSON strings may hold.
 */
export async function* jsonlLines(path) {
  let rest = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    if (!chunk.includes("\n")) {
      rest += chunk;
      continue;
    }
    const lines = chunk.split("\n");
    lines[0] = rest + lines[0];
    rest = lines.pop();
    yield* lines;
  }
  if (rest) yield rest;
}

export function firstLineSummary(s) {
  if (!s) return "";
  const trimmed = s.trim();
  const firstLine = trimmed.split("\n").find((l) => l.trim()) ?? trimmed;
  return firstLine.slice(0, 120);
}

export const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export function addTokens(into, t) {
  for (const k of Object.keys(into)) into[k] += t[k] ?? 0;
  return into;
}

/** Longest stretch of activity where no pause exceeds RUN_GAP_MS. */
export function longestRun(timestamps) {
  const ts = timestamps.filter(Boolean).sort((a, b) => a - b);
  let best = 0;
  let from = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > RUN_GAP_MS) from = ts[i];
    else best = Math.max(best, ts[i] - from);
  }
  return best;
}
