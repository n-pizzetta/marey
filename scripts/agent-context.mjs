/**
 * What agents had in mind and what they left on disk, per project: the Context page.
 *
 * The parsers feed one collector per transcript (instruction files loaded at start, memory
 * reads and writes, files written, sub-agent briefs). `buildAgentContext` then joins the
 * sessions of one project with its memory folder and git.
 *
 * Only what the logs hold: Claude Code logs its instruction files and memory; Codex logs the
 * files it changes and encrypts its sub-agents' briefs; Copilot CLI puts the instruction files
 * in its system prompt without their paths.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

const MEMORY_RE = /\/projects\/[^/]+\/memory\/([^/]+\.md)$/;
/** A memory path in a shell command, absolute or from ~. */
const BASH_MEMORY_RE = /((?:~|\/)[^\s'"`;|&<>]*\/projects\/[^/\s'"`;|&<>]+\/memory\/([\w.-]+\.md))/g;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_WRITES = 2000;
const MAX_MEMORY_OPS = 1000;
const MAX_BRIEF = 1500;
const INSTRUCTION_RE = /<custom_instruction>([\s\S]*?)<\/custom_instruction>/g;

/** `{ dir, file }` when `path` is a Claude Code memory file (`projects/<slug>/memory/<file>.md`). */
export function memoryFileOf(path) {
  const m = typeof path === "string" ? MEMORY_RE.exec(path) : null;
  return m ? { dir: path.slice(0, -m[1].length - 1), file: m[1] } : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Memory files a shell command reads, writes or deletes, from its text: `rm` deletes, a
 * redirection, `tee`, `sed -i` or `perl -pi` writes, `cat`, `head`, `sed -n` or a grep reads.
 * Scripts that write through an interpreter are missed.
 */
export function bashMemoryOps(command, home = homedir()) {
  if (typeof command !== "string" || !command.includes("/memory/")) return [];
  const out = new Map();
  for (const m of command.matchAll(BASH_MEMORY_RE)) {
    const file = escapeRe(m[2]);
    const op = new RegExp(`\\brm\\b[^\\n;&|]*${file}`).test(command) ? "delete"
      : new RegExp(`(>|\\btee\\b|\\bsed\\s+-i|\\bperl\\s+-pi)[^\\n;&|]*${file}`).test(command) ? "write"
      : new RegExp(`\\b(cat|head|tail|bat|less|sed\\s+-n|rg|grep)\\b[^\\n;&|>]*${file}`).test(command) ? "read"
      : null;
    const path = m[1].startsWith("~") ? join(home, m[1].slice(1)) : m[1];
    if (op && !out.has(path)) out.set(path, op);
  }
  return [...out].map(([path, op]) => ({ path, op }));
}

/** One per transcript: what it loaded at start, its memory reads and writes, the files it wrote. */
export function createContextCollector() {
  const loads = [];
  const memoryOps = [];
  const writes = [];
  let snapshot = false;
  const memoryOp = (tsMs, op, path, via) => {
    if (memoryOps.length < MAX_MEMORY_OPS) memoryOps.push({ tsMs, op, path, via });
  };
  return {
    /** A Claude Code `instructions` attachment: the files read in full at start (and after each compaction). */
    instructions(tsMs, files) {
      loads.push({
        tsMs,
        files: (Array.isArray(files) ? files : [])
          .filter((f) => typeof f?.path === "string")
          .map((f) => ({ path: f.path, type: typeof f.type === "string" ? f.type : null, lines: typeof f.content === "string" ? f.content.split("\n").length : null })),
      });
    },
    /** Copilot CLI: the instruction files inlined in a system prompt, as content blocks. */
    instructionBlocks(tsMs, blocks) {
      loads.push({ tsMs, blocks });
    },
    /** The transcript logs its prompt: if it logged no instruction files, it got none. */
    snapshot() {
      snapshot = true;
    },
    /** A Claude Code tool call on a file. */
    file(tsMs, tool, path) {
      if (typeof path !== "string") return;
      const op = tool === "Read" ? "read" : WRITE_TOOLS.has(tool) ? (tool === "Write" ? "write" : "edit") : null;
      if (!op) return;
      if (memoryFileOf(path)) return memoryOp(tsMs, op === "read" ? "read" : "write", path, tool);
      if (op !== "read" && writes.length < MAX_WRITES) writes.push({ tsMs, path, op });
    },
    /** A file Codex or Copilot CLI created, edited or deleted. */
    write(tsMs, path, op, by = null) {
      if (typeof path !== "string") return;
      if (memoryFileOf(path)) return memoryOp(tsMs, op === "delete" ? "delete" : "write", path, "patch");
      if (writes.length < MAX_WRITES) writes.push({ tsMs, path, op, ...(by ? { by } : {}) });
    },
    bash(tsMs, command) {
      for (const { path, op } of bashMemoryOps(command)) memoryOp(tsMs, op, path, "Bash");
    },
    finish() {
      return { loads, memoryOps, writes, snapshot };
    },
  };
}

/** Copilot CLI's `<custom_instruction>` blocks: no path, so a hash to match files on disk, and the first heading. */
export function instructionBlocksOf(systemText) {
  const out = [];
  if (typeof systemText !== "string") return out;
  for (const m of systemText.matchAll(INSTRUCTION_RE)) {
    const text = m[1].trim();
    if (!text) continue;
    const heading = text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim().slice(0, 80) ?? "";
    out.push({ hash: hashText(text), heading, lines: text.split("\n").length });
  }
  return out;
}

export const hashText = (s) => createHash("sha1").update(s.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);

/** A sub-agent's brief, as stored: the first characters and the full length. */
export function briefOf(text) {
  if (typeof text !== "string" || !text) return { brief: null, briefChars: 0 };
  const clean = text.replace(/^<teammate-message[^>]*>\s*/, "").replace(/\s*<\/teammate-message>[\s\S]*$/, "").trim();
  return { brief: clean.slice(0, MAX_BRIEF), briefChars: clean.length };
}

/* ---------- per project ---------- */

const git = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  } catch {
    return null;
  }
};

/** The repository the project's sessions ran in: the git root of the shortest working folder. */
function projectRoot(sessions) {
  const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].sort((a, b) => a.length - b.length);
  for (const cwd of cwds) {
    if (!existsSync(cwd)) continue;
    const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
    // A worktree reports itself: its main checkout owns the project.
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
    const root = common && basename(common) === ".git" ? dirname(common) : top;
    if (!root) return { root: cwd, git: false };
    // git resolves symlinks, the logs don't: keep the sessions' spelling of the same folder.
    const real = (p) => { try { return realpathSync(p); } catch { return p; } };
    return { root: cwds.find((c) => real(c) === root) ?? root, git: true };
  }
  return { root: cwds[0] ?? null, git: false };
}

/** Where a written file lives, relative to the project. */
export function classifyPath(path, root, { home = homedir(), claudeDir = join(home, ".claude"), tmp = tmpdir() } = {}) {
  const under = (dir) => dir && (path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
  if (root) {
    const wt = path.match(new RegExp(`^${escapeRe(root)}/\\.claude/worktrees/([^/]+)/(.+)$`));
    if (wt) return { kind: "worktree", worktree: wt[1], rel: wt[2] };
    const sibling = path.match(new RegExp(`^${escapeRe(root)}-([^/]+)/(.+)$`));
    if (sibling) return { kind: "worktree", worktree: sibling[1], rel: sibling[2] };
    if (under(root)) return { kind: "repo", rel: relative(root, path) };
  }
  if (under("/tmp") || under("/private/tmp") || under(tmp) || under(`/private${tmp}`)) return { kind: "scratch" };
  if (under(join(claudeDir, "plans"))) return { kind: "plan" };
  if (under(claudeDir)) return { kind: "agent-config" };
  return { kind: "outside" };
}

/** A path as the page shows it: from ~, and from ~/.claude when Claude Code's folder lives elsewhere (CLAUDE_CONFIG_DIR). */
let shownClaudeDir = null;
const tilde = (p, home) => {
  if (!p) return p;
  if (shownClaudeDir && (p === shownClaudeDir || p.startsWith(`${shownClaudeDir}/`))) return `~/.claude${p.slice(shownClaudeDir.length)}`;
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

function readFrontmatter(text) {
  const out = {};
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = /^\s*(name|description|type):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** The memory folder: the index (MEMORY.md) and each memory file, plus files logged then removed. */
function readMemory(dir, loggedFiles) {
  const out = { dir, exists: !!dir && existsSync(dir), files: [] };
  if (!dir) return out;
  const index = new Map();
  try {
    for (const m of readFileSync(join(dir, "MEMORY.md"), "utf8").matchAll(/^- \[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.*)$/gm)) index.set(m[2], { title: m[1], hook: m[3] });
  } catch { /* no index yet */ }
  let onDisk = [];
  try { onDisk = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md"); } catch { /* no folder */ }
  for (const file of new Set([...onDisk, ...index.keys(), ...loggedFiles])) {
    if (file === "MEMORY.md") continue;
    const p = join(dir, file);
    let text = null;
    let st = null;
    try { text = readFileSync(p, "utf8"); st = statSync(p); } catch { /* removed */ }
    const fm = text ? readFrontmatter(text) : {};
    out.files.push({
      file,
      exists: text !== null,
      inIndex: index.has(file),
      title: index.get(file)?.title ?? fm.name ?? file.replace(/\.md$/, ""),
      hook: index.get(file)?.hook ?? null,
      description: fm.description ?? null,
      type: fm.type ?? (file.includes("-") ? file.split("-")[0] : null),
      lines: text ? text.split("\n").length : 0,
      modifiedMs: st ? st.mtimeMs : null,
    });
  }
  return out;
}

/** Copilot CLI's instruction blocks matched to the files they came from. */
function instructionCandidates(root, home) {
  const out = [];
  const add = (p) => {
    try { out.push({ path: p, hash: hashText(readFileSync(p, "utf8")) }); } catch { /* absent */ }
  };
  if (root) {
    for (const f of ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"]) add(join(root, f));
    try { for (const f of readdirSync(join(root, ".github", "instructions"))) add(join(root, ".github", "instructions", f)); } catch { /* none */ }
  }
  add(join(home, ".copilot", "copilot-instructions.md"));
  add(join(home, ".claude", "CLAUDE.md"));
  return out;
}

const lineCount = (p) => {
  try { return readFileSync(p, "utf8").split("\n").length; } catch { return null; }
};

/** Files written outside the repo, one row each, except folders with 3 or more: one row for the folder. */
function groupOutside(files, home) {
  const folderOf = (p) => {
    const parts = p.split("/");
    return parts.slice(0, p.startsWith("~") ? 4 : 3).join("/");
  };
  const byFolder = new Map();
  for (const f of files) byFolder.set(folderOf(f.path), [...(byFolder.get(folderOf(f.path)) ?? []), f]);
  const rows = [];
  for (const [folder, group] of byFolder) {
    if (group.length < 3 || folder === "~" || folder === tilde(home, home)) rows.push(...group);
    else {
      const last = group.reduce((a, b) => ((b.lastMs ?? 0) > (a.lastMs ?? 0) ? b : a));
      rows.push({ path: `${folder}/`, kind: "folder", files: group.length, edits: group.reduce((n, f) => n + f.edits, 0), lastMs: last.lastMs, lastSession: last.lastSession, exists: existsSync(folder.startsWith("~") ? join(home, folder.slice(1)) : folder) });
    }
  }
  return rows.sort((a, b) => (b.lastMs ?? 0) - (a.lastMs ?? 0));
}

/**
 * Everything the Context page shows for one project: its sessions (newest last) with what each
 * loaded, remembered and wrote, the memory folder, the instruction files and what is left open.
 */
export function buildAgentContext(sessions, { project, home = homedir(), claudeDir = join(home, ".claude"), now = Date.now() } = {}) {
  // Sessions that did something: a prompt, a file written, a sub-agent or a memory read.
  const busy = (s) => (s.prompts?.length ?? 0) > 0 || s.live || s.agentContext.writes?.length || s.agentContext.subagents?.length || s.agentContext.memoryOps?.length;
  const list = sessions
    .filter((s) => s.project === project && s.agentContext && busy(s))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const { root, git: isGit } = projectRoot(list);
  const opts = { home, claudeDir };
  shownClaudeDir = claudeDir;

  // Memory folder: the one the instruction files point at, else the one memory ops touched.
  const dirs = new Map();
  for (const s of list) {
    for (const l of s.agentContext.loads ?? []) for (const f of l.files ?? []) if (f.type === "AutoMem") dirs.set(dirname(f.path), (dirs.get(dirname(f.path)) ?? 0) + 1);
    for (const o of s.agentContext.memoryOps ?? []) {
      const m = memoryFileOf(o.path);
      if (m) dirs.set(m.dir, (dirs.get(m.dir) ?? 0) + 1);
    }
  }
  const memoryDir = [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const inDir = (path) => memoryFileOf(path)?.dir === memoryDir;
  const loggedFiles = new Set(list.flatMap((s) => (s.agentContext.memoryOps ?? []).filter((o) => inDir(o.path)).map((o) => memoryFileOf(o.path).file)));
  const memory = readMemory(memoryDir, loggedFiles);

  // Git state of the files sessions wrote in the repo.
  let tracked = new Set();
  let untrackedNow = new Set();
  if (isGit && root) {
    tracked = new Set((git(root, ["ls-files", "-z"]) ?? "").split("\0").filter(Boolean));
    untrackedNow = new Set((git(root, ["ls-files", "-z", "--others", "--exclude-standard"]) ?? "").split("\0").filter(Boolean));
  }
  // A repo that is gone (renamed, moved) says nothing about its files.
  const rootExists = !!root && existsSync(root);
  const stateOf = (rel) => {
    if (!rootExists) return "unknown";
    if (!existsSync(join(root, rel))) return "deleted";
    if (tracked.has(rel)) return "committed";
    if (untrackedNow.has(rel)) return "untracked";
    return isGit ? "ignored" : "unknown";
  };

  const candidates = list.some((s) => s.agent === "copilot") ? instructionCandidates(root, home) : [];
  const fileOfBlock = (b) => candidates.find((c) => c.hash === b.hash)?.path ?? null;

  const written = new Map();
  const worktrees = new Map();
  const outside = new Map();
  let scratch = 0;
  const scratchSessions = new Set();
  const plans = new Set();

  const out = list.map((s) => {
    const c = s.agentContext;
    const title = s.customTitle || s.goal || "Session";
    const startMs = Date.parse(s.startedAt);
    const files = { repo: new Set(), worktree: new Set(), scratch: 0, outside: 0 };
    const created = [];
    for (const w of c.writes ?? []) {
      const where = classifyPath(w.path, root, opts);
      if (where.kind === "repo") {
        files.repo.add(where.rel);
        const prev = written.get(where.rel);
        written.set(where.rel, { path: where.rel, firstSession: prev?.firstSession ?? s.id, firstMs: prev?.firstMs ?? w.tsMs, lastSession: s.id, lastMs: w.tsMs, created: prev?.created || w.op === "create" || w.op === "write" });
        if (w.op === "create") created.push(where.rel);
      } else if (where.kind === "worktree") {
        files.worktree.add(where.worktree);
        const prev = worktrees.get(where.worktree) ?? { name: where.worktree, sessions: new Set(), files: new Set() };
        prev.sessions.add(s.id);
        prev.files.add(where.rel);
        worktrees.set(where.worktree, prev);
      } else if (where.kind === "scratch") {
        files.scratch++;
        scratch++;
        scratchSessions.add(s.id);
      } else if (where.kind === "plan") plans.add(w.path);
      else {
        files.outside++;
        const prev = outside.get(w.path) ?? { path: tilde(w.path, home), kind: where.kind, edits: 0 };
        outside.set(w.path, { ...prev, edits: prev.edits + 1, lastMs: w.tsMs, lastSession: s.id, exists: existsSync(w.path) });
      }
    }
    const loads = (c.loads ?? []).map((l) => ({
      tsMs: l.tsMs,
      files: l.files
        ? l.files.map((f) => ({ path: tilde(f.path, home), type: f.type, lines: f.lines }))
        : (l.blocks ?? []).map((b) => {
          const path = fileOfBlock(b);
          return { path: path ? tilde(path, home) : null, label: b.heading, type: "Copilot", lines: b.lines };
        }),
    }));
    return {
      id: s.id,
      agent: s.agent ?? "claude",
      title,
      startedAt: s.startedAt,
      endedAt: s.lastEventAt ?? s.startedAt,
      prompts: s.prompts?.length ?? 0,
      live: !!s.live,
      // Claude Code sessions before ~Sep 2026 and Codex log no instruction files.
      loadsRecorded: loads.length > 0 || !!c.snapshot,
      loads,
      memoryOps: (c.memoryOps ?? []).filter((o) => inDir(o.path)).map((o) => ({ tsMs: o.tsMs, op: o.op, file: memoryFileOf(o.path).file, via: o.via, ...(o.by ? { by: o.by } : {}) })),
      files: { repo: files.repo.size, worktrees: [...files.worktree], scratch: files.scratch, outside: files.outside },
      created: [...new Set(created)].map((rel) => ({ path: rel, state: root ? stateOf(rel) : "unknown" })),
      subagents: (c.subagents ?? []).map((a) => ({
        ...a,
        received: Array.isArray(a.received) ? a.received.map((f) => ({ ...f, path: tilde(f.path, home) })) : a.received,
        writes: undefined,
        wrote: (a.writes ?? []).reduce((acc, p) => {
          const k = classifyPath(p, root, opts).kind;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      })),
      startMs,
    };
  });

  // Files left open: untracked now, whether a session wrote them or not (shell writes leave no tool call).
  const untracked = [...untrackedNow].map((rel) => {
    const w = written.get(rel);
    return { path: rel, firstSession: w?.firstSession ?? null, firstMs: w?.firstMs ?? (() => { try { return statSync(join(root, rel)).mtimeMs; } catch { return null; } })() };
  }).filter((u) => !u.path.startsWith(".claude/")).sort((a, b) => (a.firstMs ?? 0) - (b.firstMs ?? 0));

  // Instruction files read at every start: what the latest Claude Code session loaded, sizes read from disk.
  const instructions = new Map();
  const latest = [...list].reverse().find((s) => s.agent === "claude" && s.agentContext.loads?.some((l) => l.files));
  for (const f of latest?.agentContext.loads.filter((l) => l.files).at(-1)?.files ?? []) {
    if (!f.path) continue;
    instructions.set(f.path, { path: tilde(f.path, home), type: f.type, lines: lineCount(f.path), exists: existsSync(f.path) });
  }

  return {
    project,
    root: tilde(root, home),
    generatedAt: new Date(now).toISOString(),
    agentsMd: !!root && existsSync(join(root, "AGENTS.md")),
    sessions: out,
    instructions: [...instructions.values()],
    memory: { dir: tilde(memory.dir, home), exists: memory.exists, files: memory.files },
    open: {
      untracked,
      outside: groupOutside([...outside.values()], home),
      plans: plans.size,
      scratch: { files: scratch, sessions: scratchSessions.size },
      worktrees: [...worktrees.values()].map((w) => ({ name: w.name, files: w.files.size, sessions: [...w.sessions], exists: !!root && existsSync(join(root, ".claude", "worktrees", w.name)) })),
    },
  };
}
