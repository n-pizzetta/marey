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

/**
 * The start of a command inside a shell line: its first words after `&&`, `||`, `;` or a newline,
 * past env assignments and wrappers. Not after a single `|`: nothing is piped into a commit, and a
 * search for `a|git commit` is not one.
 */
const HEAD = String.raw`(?:^|\n|&&|\|\||;)\s*(?:\(+\s*)?(?:\w+=\S*\s+)*(?:(?:rtk(?:\s+proxy)?|time|sudo|command|exec)\s+)*`;
const COMMIT_RE = new RegExp(HEAD + String.raw`(?:\S*\/)?git\s+(?:-[cC]\s+\S+\s+)*commit\b`);
const PR_CREATE_RE = new RegExp(HEAD + String.raw`gh\s+pr\s+create\b`);
const QUOTED = String.raw`(["'])((?:\\.|(?!\1)[^\\])*)`;
const MESSAGE_RE = new RegExp(String.raw`\s(?:-[a-zA-Z]*m|--message)[\s=]*` + QUOTED);
const TITLE_RE = new RegExp(String.raw`\s(?:-t|--title)[\s=]*` + QUOTED);
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n\s*([^\n]+)/;
const PR_URL_RE = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

const firstLine = (s) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
/** A message the shell still has to expand (`$T`, `$(head -1 notes.md)`) is not what was written. */
const literal = (s) => (/\$[\w({]/.test(s) ? "" : s);

/**
 * The commit a shell command makes: `undefined` when it makes none (`echo "git commit"`, a grep
 * for it), else its subject, the first line of the message (`-m "…"`, or a heredoc given to
 * `-F -` or to `-m "$(cat <<'EOF' …)"`), or null when the command writes none (`--amend
 * --no-edit`, an editor) or leaves it to the shell (`-m "$MSG"`).
 */
export function commitOf(command) {
  const m = COMMIT_RE.exec(command);
  if (!m) return undefined;
  const rest = command.slice(m.index + m[0].length);
  const message = MESSAGE_RE.exec(rest)?.[2];
  const subject = literal(message !== undefined && !message.startsWith("$(") ? firstLine(message) : (HEREDOC_RE.exec(rest)?.[3] ?? "").trim());
  return subject ? clip(subject, 140) : null;
}

/**
 * What a session shipped, read from its shell commands: its commits (subject and time) and the
 * pull requests it opened (the URL `gh pr create` printed, and its `--title`). `command` returns
 * what to keep with the call, for `result` to drop a commit that failed and to read the PR's URL.
 */
export function createShipLog() {
  const commits = [];
  const prs = [];
  return {
    command(command, tsMs, msgId = null) {
      const subject = commitOf(command);
      const commit = subject === undefined ? null : { tsMs, subject, msgId, failed: false };
      if (commit) commits.push(commit);
      const pr = PR_CREATE_RE.test(command) ? { tsMs, msgId, title: clip(literal(firstLine(TITLE_RE.exec(command)?.[2] ?? "")), 140) || null } : null;
      return commit || pr ? { commit, pr } : null;
    },
    result(mark, body, isError) {
      if (!mark) return;
      if (isError && mark.commit) mark.commit.failed = true;
      const url = mark.pr && !isError ? PR_URL_RE.exec(body ?? "")?.[0] : null;
      if (url && !prs.some((p) => p.url === url)) prs.push({ tsMs: mark.pr.tsMs, msgId: mark.pr.msgId, title: mark.pr.title, url: own(url) });
    },
    failed(mark) {
      if (mark?.commit) mark.commit.failed = true;
    },
    /** Copies, so lines read later change nothing already handed out. Commits with a subject that did not fail. */
    snapshot() {
      return {
        commitLog: commits.filter((c) => !c.failed && c.subject).map(({ tsMs, subject, msgId }) => ({ tsMs, subject, msgId })),
        prLog: prs.map((p) => ({ ...p })),
      };
    },
  };
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
