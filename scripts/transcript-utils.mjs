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
const COMMITS_RE = new RegExp(HEAD + String.raw`(?:\S*\/)?git\s+(?:-[cC]\s+\S+\s+)*commit\b`, "g");
const PR_CREATES_RE = new RegExp(HEAD + String.raw`gh\s+pr\s+create\b`, "g");
const QUOTED = String.raw`(["'])((?:\\.|(?!\1)[^\\])*)`;
const MESSAGE_RE = new RegExp(String.raw`\s(?:-[a-zA-Z]*m|--message)[\s=]*` + QUOTED);
const TITLE_RE = new RegExp(String.raw`\s(?:-t|--title)[\s=]*` + QUOTED);
const PR_URL_RE = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const HEREDOC_OPEN_RE = /(?<!<)<<(?!<)-?\s*(['"]?)(\w+)\1/;
// What `foldHeredocs` leaves in place of a heredoc: its number in the command.
const FOLDED_RE = /<<\0(\d+)\0/;

const firstLine = (s) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
/** A message the shell still has to expand (`$T`, `$(head -1 notes.md)`) is not what was written. */
const literal = (s) => (/\$[\w({]/.test(s) ? "" : s);

/**
 * `command` without its heredoc bodies, and the first line of each. A body is text, not commands:
 * a script written to a file, a commit message, a test fixture that holds `git commit -m "x"`.
 * A heredoc with no closing line is left as it is: more often a `<<` that opens none.
 */
function foldHeredocs(command) {
  if (!command.includes("<<")) return { text: command, bodies: [] };
  const lines = command.split("\n");
  const out = [];
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const open = HEREDOC_OPEN_RE.exec(lines[i]);
    const close = open ? lines.findIndex((l, k) => k > i && l.trim() === open[2]) : -1;
    if (close < 0) {
      out.push(lines[i]);
      continue;
    }
    out.push(lines[i].replace(open[0], `<<\0${bodies.length}\0`));
    bodies.push(firstLine(lines.slice(i + 1, close).join("\n")));
    i = close;
  }
  return { text: out.join("\n"), bodies };
}

/**
 * Which characters of `text` sit inside a quoted string or a comment: text, not commands, like
 * the script given to `node -e '…'` or the words of an `echo`.
 */
function quotedMask(text) {
  const inside = new Uint8Array(text.length);
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      inside[i] = 1;
      if (c === "\\" && quote === '"') inside[++i] = 1;
      else if (c === quote) quote = "";
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') {
      quote = c;
      inside[i] = 1;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== "\n") inside[i++] = 1;
    }
  }
  return inside;
}

/** Where `re` (global) finds a command in `text` that the shell would run: not inside quotes or a comment. */
function commandsIn(text, re) {
  const found = [...text.matchAll(re)];
  if (found.length === 0) return found;
  const inside = quotedMask(text);
  return found.filter((m) => !inside[m.index + m[0].length - 1]);
}

/**
 * The commits a shell command makes, in order: none for `echo "git commit"`, a grep for it, or the
 * words inside a heredoc or a quoted string. Each is its subject, the first line of the message (`-m "…"`, or a
 * heredoc given to `-F -` or to `-m "$(cat <<'EOF' …)"`), or null when the command writes none
 * (`--amend --no-edit`, an editor) or leaves it to the shell (`-m "$MSG"`). A commit's message is
 * looked for up to the next commit of the same command.
 */
export function commitsOf(command) {
  const { text, bodies } = foldHeredocs(command);
  const starts = commandsIn(text, COMMITS_RE);
  return starts.map((m, i) => {
    const rest = text.slice(m.index + m[0].length, starts[i + 1]?.index);
    const message = MESSAGE_RE.exec(rest);
    const folded = FOLDED_RE.exec(rest);
    // Whichever comes first is this commit's; `-m "$(cat <<'EOF' …)"` is the heredoc.
    const quoted = message && !message[2].startsWith("$(") && (!folded || message.index < folded.index);
    const subject = literal(quoted ? firstLine(message[2]) : folded ? bodies[Number(folded[1])] : "");
    return subject ? clip(subject, 140) : null;
  });
}

/**
 * What a session shipped, read from its shell commands: its commits (subject and time) and the
 * pull requests it opened (the URL `gh pr create` printed, and its `--title`). `command` returns
 * what to keep with the call, for `result` to drop commits that failed and to read the PR's URL.
 */
export function createShipLog() {
  const commits = [];
  const prs = [];
  return {
    command(command, tsMs, msgId = null) {
      const made = commitsOf(command).map((subject) => ({ tsMs, subject, msgId, failed: false }));
      commits.push(...made);
      const { text } = foldHeredocs(command);
      const [create] = commandsIn(text, PR_CREATES_RE);
      const pr = create ? { tsMs, msgId, title: clip(literal(firstLine(TITLE_RE.exec(text.slice(create.index))?.[2] ?? "")), 140) || null } : null;
      return made.length || pr ? { commits: made, pr } : null;
    },
    result(mark, body, isError) {
      if (!mark) return;
      // Which of several commits a failed command still made is not known: none is kept.
      if (isError) for (const c of mark.commits) c.failed = true;
      const url = mark.pr && !isError ? PR_URL_RE.exec(body ?? "")?.[0] : null;
      if (url && !prs.some((p) => p.url === url)) prs.push({ tsMs: mark.pr.tsMs, msgId: mark.pr.msgId, title: mark.pr.title, url: own(url) });
    },
    failed(mark) {
      for (const c of mark?.commits ?? []) c.failed = true;
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
