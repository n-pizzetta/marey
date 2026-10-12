/**
 * Known causes of failed tool calls, read by scripts/recommendations.mjs.
 *
 * Written for the person reading the dashboard, not for a shell expert:
 * - `title(n)`: the effect, counted ("41 commands failed because of a zsh setting");
 * - `what`: what happens, in one plain sentence;
 * - `action`: what to do, with an optional `snippet` to copy and a `prompt` to paste
 *   into Claude Code, which explains and applies the change (Marey itself never edits a config);
 * - `details`: the mechanism, shown folded.
 */

/** Text a tool appends to every failure, whatever its cause. Stripped first, so it never hides the real error. */
export const NOISE = [
  {
    id: "zoxide-doctor",
    re: /zoxide: detected a possible configuration issue\.[\s\S]*?_ZO_DOCTOR=0\.\s*/,
    title: (n) => `A shell warning cluttered ${n} error messages`,
    what: "zoxide (your smart `cd`) added a warning to failed commands. It caused none of them, but Claude reads it before the real error.",
    action: {
      text: "Silence the warning, and keep the plain `cd` in Claude's shells. Takes effect in new sessions.",
      snippet: 'export _ZO_DOCTOR=0\n[[ -z "$CLAUDECODE" ]] && alias cd="z"',
      prompt: () => "In Claude Code's shell, zoxide's doctor warning gets appended to every failed command. In my ~/.zshrc (follow the symlink if it is one): add `export _ZO_DOCTOR=0` before `zoxide init`, and alias cd to z only outside Claude Code with `[[ -z \"$CLAUDECODE\" ]] && alias cd=\"z\"`. Explain the change in two sentences and show me the diff before saving.",
    },
    details: "Claude Code runs commands in a snapshot of your shell that doesn't load zoxide's hooks, so zoxide's doctor thinks it is misconfigured and warns on each failure. With `cd` aliased to `z`, a `cd` to a missing path also jumps to a fuzzy match instead of failing.",
  },
];

/** Failures that say nothing about the setup: the agent's own retries, or a choice the user made. */
export const IGNORED = [
  /has not been read yet/i,
  /modified since read/i,
  /exceeds maximum allowed tokens/i,
  /tool use was rejected|doesn't want to proceed with this tool use/i,
];

export const CAUSES = [
  {
    id: "zsh-nomatch",
    kind: "setup",
    match: /no matches found:/i,
    title: (n) => `${n} commands failed because of a zsh setting`,
    what: "Claude often runs commands with a `*`, like \"delete every .pyc file\". When nothing matches, zsh stops the whole command where bash would carry on, so Claude has to try again another way.",
    action: {
      text: "Add one line to `~/.zshrc` so zsh behaves like bash in Claude's shells only. Takes effect in new sessions.",
      snippet: '[[ -n "$CLAUDECODE" ]] && setopt nonomatch',
      prompt: () => "Commands in my Claude Code sessions keep failing with zsh's \"no matches found\" error when a pattern like *.pyc matches nothing. Add `[[ -n \"$CLAUDECODE\" ]] && setopt nonomatch` to my ~/.zshrc (follow the symlink if it is one), explain in two sentences what it changes, and show me the diff before saving.",
    },
    details: "zsh's `nomatch` option, on by default, aborts a command when a glob matches no file; bash passes the pattern through unchanged. Claude Code sets `CLAUDECODE` in its shells, so the line leaves your own terminal as it is.",
  },
  {
    id: "rtk-unsupported",
    kind: "setup",
    match: /\brtk: |\brtk \w+ does not support/i,
    title: (n) => `${n} commands rejected by the rtk hook`,
    what: "A hook rewrites Claude's commands to go through rtk, and rtk refuses some of them (for example `find` with `-exec`). Each refusal is a failed command and a retry.",
    action: {
      text: "Have the hook leave those commands alone.",
      prompt: () => "My Claude Code setup has a hook that rewrites Bash commands for rtk, and rtk rejects some of them (for example \"rtk find does not support compound predicates\"). Find that hook in my Claude Code settings and make it skip the command forms rtk refuses. Explain the change and show me the diff before saving.",
    },
    details: "The rewrite happens in a `PreToolUse` hook. rtk's filtered versions of `find` and other commands don't support every flag; `rtk proxy <command>` runs the original.",
  },
  {
    id: "sandbox-write",
    kind: "setup",
    match: /requested permissions to write to/i,
    title: (n) => `${n} commands blocked by the sandbox`,
    what: "Some commands tried to write outside the folders the sandbox allows, often a cache or temp folder, failed, and were retried another way.",
    action: {
      text: "Allow that folder in the sandbox settings, or move the tool's cache into the project. Details show which folder.",
      prompt: (ev) => `Several commands in my Claude Code sessions failed because the sandbox blocked a write outside its allowed paths. Latest error: "${ev.sample ?? ""}". Tell me which tool writes there and propose the narrowest fix (allow that path in the sandbox settings, or move the tool's cache into the project). Don't change anything before I confirm.`,
      docs: "https://code.claude.com/docs/en/sandboxing",
    },
    details: "Claude Code's sandbox only lets commands write to its allowed paths. Tools that keep a cache in a temp or home folder hit that limit.",
  },
  {
    id: "playwright-profile",
    kind: "setup",
    match: /browser is already in use for/i,
    title: (n) => `${n} browser actions failed: your sessions share one browser`,
    what: "Playwright keeps a single browser profile. When two sessions drive a browser at the same time, the second one fails until the first lets go.",
    action: {
      text: "Start the Playwright MCP server with `--isolated`, so each session gets its own browser.",
      snippet: '"args": ["@playwright/mcp@latest", "--isolated"]',
      prompt: () => "When several Claude Code sessions use the Playwright MCP server at once, they fail with \"Browser is already in use\". Find where the Playwright MCP server is configured for me (plugin or MCP settings) and add the `--isolated` flag to its arguments. Show me the change before saving.",
      docs: "https://github.com/microsoft/playwright-mcp",
    },
    details: "A persistent Playwright profile can be used by one browser at a time. `--isolated` keeps each client's profile in memory instead.",
  },
  {
    id: "playwright-roots",
    kind: "habit",
    match: /file access denied: .* is outside allowed roots/i,
    title: (n) => `${n} screenshots failed: saved outside the project`,
    what: "Playwright can only save files inside the project folder. Screenshots sent to a temp or scratch folder fail, and Claude retries.",
    action: {
      text: "Tell Claude once, in your global CLAUDE.md, to save screenshots inside the project.",
      prompt: () => "Playwright MCP can only write inside the project folder, and screenshots saved to temp or scratch folders keep failing in my sessions. Add a short rule to my ~/.claude/CLAUDE.md: save Playwright screenshots under `.playwright-mcp/` in the project (and make sure it is git-ignored). Show me the change before saving.",
      docs: "https://github.com/microsoft/playwright-mcp",
    },
    details: "The Playwright MCP server restricts file access to the workspace roots (the session's folder). `--allow-unrestricted-file-access` lifts it, but the restriction is a guardrail worth keeping.",
  },
  {
    id: "wrong-directory",
    kind: "habit",
    match: /file does not exist\. note: your current working directory is/i,
    title: (n) => `${n} files looked up in the wrong folder`,
    what: "Claude tried to read or edit files that don't exist where the session runs: sessions started outside the project, or paths from another worktree.",
    action: { text: "Start sessions from the project's folder, and give worktree paths in full in your prompts." },
    details: "Claude Code answers \"File does not exist\" with the folder it is running in; the sessions below show which paths were wrong.",
  },
  {
    id: "worktree-isolation",
    kind: "habit",
    match: /isolated in the worktree/i,
    title: (n) => `${n} sub-agent actions blocked outside their worktree`,
    what: "Sub-agents working in their own copy of the repository (a worktree) were given paths from the main copy, and were blocked.",
    action: {
      text: "Tell Claude once, in your global CLAUDE.md, to give isolated sub-agents paths inside their worktree.",
      prompt: () => "Isolated sub-agents in my Claude Code sessions keep getting blocked because they are given absolute paths into the main checkout instead of their own worktree. Add a short rule to my ~/.claude/CLAUDE.md about it. Show me the change before saving.",
    },
    details: "A sub-agent started with worktree isolation can only touch files inside its own worktree.",
  },
  {
    id: "mcp-reconnect",
    kind: "setup",
    match: /mcp server .*(session expired|needs? (re-?)?auth|not connected)/i,
    title: (n) => `${n} calls failed: a connected tool needs reconnecting`,
    what: "A connected tool (MCP server) lost its session or login, so its calls failed.",
    action: { text: "Run `/mcp` in Claude Code and reconnect it.", docs: "https://code.claude.com/docs/en/mcp" },
    details: "MCP servers that sign in to a service expire like any login.",
  },
];

/** Strips NOISE; returns the text left and the ids of the noise found. */
export function stripNoise(text) {
  let out = text;
  const noise = [];
  for (const n of NOISE) {
    if (n.re.test(out)) {
      out = out.replace(n.re, "");
      noise.push(n.id);
    }
  }
  return { text: out, noise };
}

/** A stable key for "the same error": paths, ids and numbers stripped. Null when nothing is left to compare. */
export function errorKey(text) {
  // Paths first: cutting before replacing them would split one error into several keys.
  const key = text
    // "Exit code 1" or "command exited with code 1" alone says nothing about the cause.
    .replace(/^(?:error: )?(?:command exited with )?(?:exit )?code \d+\s*/i, "")
    .toLowerCase()
    .replace(/\/[^\s:'"`),]+/g, "<path>")
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return key.length >= 8 ? key : null;
}

/** "gh pr merge 78 --squash" → "gh pr merge": the command itself, without leading cd / env, flags or arguments. */
export function commandHead(command) {
  if (!command) return null;
  const parts = command.split(/&&|;|\|\|/).map((p) => p.trim()).filter(Boolean);
  const main = parts.find((p) => !/^(cd|export|source|\.)\s/.test(p) && !/^\w+=[^\s$`]*$/.test(p)) ?? parts[0] ?? "";
  // `T=$(gcloud auth …)`: the command is the one inside the substitution.
  const words = main.replace(/\$\(|`|\)/g, " ").split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
  const head = [];
  for (const w of words) {
    if (head.length >= 3 || /^[-"'$<>|(]|[/=.]|^\d+$/.test(w)) break;
    head.push(w);
  }
  return head.join(" ") || words[0] || null;
}

/** Denials that protect the user rather than slow them down: never suggest allowing these. */
export const PROTECTIVE = /(\bmerge\b|--force|\breset --hard\b|\brm -rf?\b|\bdelete\b|\bdrop\b|\bdestroy\b|--no-verify|\bpush\b|token|secret|credential|password|\.env\b)/i;

/** "mcp__plugin_playwright_playwright__browser_take_screenshot" → "playwright · browser_take_screenshot". */
export function toolLabel(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool ?? "");
  if (!m) return tool ?? null;
  const server = m[1].replace(/^plugin_/, "").split("_").filter((w, i, a) => a.indexOf(w) === i).join("-");
  return `${server} · ${m[2]}`;
}
