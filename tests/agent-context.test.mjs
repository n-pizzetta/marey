// The Context page's data (scripts/agent-context.mjs): what the logs say agents loaded, remembered
// and wrote, joined per project with the memory folder and git.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashMemoryOps,
  briefOf,
  buildAgentContext,
  classifyPath,
  createContextCollector,
  hashText,
  instructionBlocksOf,
  memoryFileOf,
} from "../scripts/agent-context.mjs";

const home = mkdtempSync(join(tmpdir(), "marey-context-"));
const claudeDir = join(home, ".claude");
const root = join(home, "dev", "shop");
const memDir = join(claudeDir, "projects", "-dev-shop", "memory");
const t0 = Date.parse("2026-10-01T09:00:00Z");
const DAY = 86_400_000;
const PROJECT_MD = "# Shop\n\nUse pnpm. Never commit .env files.\n";

before(() => {
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(root, "src", "app.ts"), "export {};\n");
  writeFileSync(join(root, "CLAUDE.md"), PROJECT_MD);
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  writeFileSync(join(root, "NOTES.md"), "left behind\n");
  writeFileSync(join(root, "scratch.md"), "written by a shell, no tool call\n");

  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "MEMORY.md"), "- [Deploy steps](project-deploy.md) — deploy with make ship, never on Fridays\n- [Style](feedback-style.md) — short commits\n");
  writeFileSync(join(memDir, "project-deploy.md"), "---\nname: project-deploy\ndescription: \"How to deploy: make ship, Fridays allowed\"\nmetadata:\n  type: project\n---\n\nmake ship\n");
  writeFileSync(join(memDir, "feedback-style.md"), "---\nname: feedback-style\ndescription: Commit style\n---\nshort\n");
});

after(() => rmSync(home, { recursive: true, force: true }));

test("recognizes memory files and what shell commands do to them", () => {
  assert.deepEqual(memoryFileOf("/u/.claude/projects/-a-b/memory/x.md"), { dir: "/u/.claude/projects/-a-b/memory", file: "x.md" });
  assert.equal(memoryFileOf("/u/dev/memory/x.md"), null);
  const p = "/u/.claude/projects/-a/memory";
  assert.deepEqual(bashMemoryOps(`rm ${p}/old.md`), [{ path: `${p}/old.md`, op: "delete" }]);
  assert.deepEqual(bashMemoryOps(`cat > ${p}/new.md <<'EOF'\nx\nEOF`), [{ path: `${p}/new.md`, op: "write" }]);
  assert.deepEqual(bashMemoryOps(`sed -n 1,20p ${p}/a.md`), [{ path: `${p}/a.md`, op: "read" }]);
  assert.deepEqual(bashMemoryOps("cat ~/.claude/projects/-a/memory/a.md", "/home/u"), [{ path: "/home/u/.claude/projects/-a/memory/a.md", op: "read" }]);
  assert.deepEqual(bashMemoryOps("git status"), []);
});

test("a collector keeps instruction loads, memory ops and file writes apart", () => {
  const c = createContextCollector();
  c.instructions(1, [{ path: "/u/.claude/CLAUDE.md", type: "User", content: "a\nb" }, { path: `${memDir}/MEMORY.md`, type: "AutoMem", content: "x" }]);
  c.file(2, "Read", `${memDir}/project-deploy.md`);
  c.file(3, "Read", "/u/dev/shop/src/app.ts");
  c.file(4, "Write", "/u/dev/shop/NOTES.md");
  c.file(5, "Edit", `${memDir}/feedback-style.md`);
  c.bash(6, `rm ${memDir}/gone.md`);
  const out = c.finish();
  assert.deepEqual(out.loads[0].files.map((f) => [f.type, f.lines]), [["User", 2], ["AutoMem", 1]]);
  assert.deepEqual(out.memoryOps.map((o) => [o.op, o.via]), [["read", "Read"], ["write", "Edit"], ["delete", "Bash"]]);
  // Reads of ordinary files are not kept; writes are.
  assert.deepEqual(out.writes, [{ tsMs: 4, path: "/u/dev/shop/NOTES.md", op: "write" }]);
  assert.equal(out.snapshot, false);
});

test("reads Copilot CLI's instruction blocks and a sub-agent's brief", () => {
  const blocks = instructionBlocksOf(`intro <custom_instruction>\n${PROJECT_MD}</custom_instruction> mid <custom_instruction># Team\nrules</custom_instruction>`);
  assert.deepEqual(blocks.map((b) => b.heading), ["Shop", "Team"]);
  assert.equal(blocks[0].hash, hashText(PROJECT_MD));
  assert.deepEqual(briefOf('<teammate-message teammate_id="lead">\nDo the thing\n</teammate-message>\n'), { brief: "Do the thing", briefChars: 12 });
  assert.deepEqual(briefOf(null), { brief: null, briefChars: 0 });
});

test("sorts written files into repo, worktree, scratch, plans, agent config and outside", () => {
  const opts = { home: "/u", claudeDir: "/u/.claude", tmp: "/var/folders/x" };
  assert.deepEqual(classifyPath("/u/dev/shop/src/a.ts", "/u/dev/shop", opts), { kind: "repo", rel: "src/a.ts" });
  assert.deepEqual(classifyPath("/u/dev/shop/.claude/worktrees/fix/src/a.ts", "/u/dev/shop", opts), { kind: "worktree", worktree: "fix", rel: "src/a.ts" });
  assert.deepEqual(classifyPath("/u/dev/shop-readme/README.md", "/u/dev/shop", opts), { kind: "worktree", worktree: "readme", rel: "README.md" });
  assert.equal(classifyPath("/private/tmp/x.json", "/u/dev/shop", opts).kind, "scratch");
  assert.equal(classifyPath("/var/folders/x/y.txt", "/u/dev/shop", opts).kind, "scratch");
  assert.equal(classifyPath("/u/.claude/plans/p.md", "/u/dev/shop", opts).kind, "plan");
  assert.equal(classifyPath("/u/.claude/CLAUDE.md", "/u/dev/shop", opts).kind, "agent-config");
  assert.equal(classifyPath("/u/.zshrc", "/u/dev/shop", opts).kind, "outside");
  // A sibling folder that only shares a prefix is not the repo.
  assert.equal(classifyPath("/u/dev/shopping/a.ts", "/u/dev/shop", opts).kind, "outside");
});

const session = (id, agent, startMs, agentContext, extra = {}) => ({
  id,
  agent,
  project: "shop",
  cwd: root,
  goal: `Session ${id}`,
  startedAt: new Date(startMs).toISOString(),
  lastEventAt: new Date(startMs + 3_600_000).toISOString(),
  prompts: [{ t: 0 }],
  agentContext: { loads: [], snapshot: false, memoryOps: [], writes: [], subagents: [], ...agentContext },
  ...extra,
});

test("joins a project's sessions with its memory folder and git", () => {
  const index = { path: join(memDir, "MEMORY.md"), type: "AutoMem", lines: 2 };
  const sessions = [
    session("a", "claude", t0, {
      loads: [{ tsMs: t0, files: [{ path: join(claudeDir, "CLAUDE.md"), type: "User", lines: 3 }, index] }],
      memoryOps: [{ tsMs: t0 + 1000, op: "write", path: join(memDir, "project-deploy.md"), via: "Write" }],
      writes: [
        { tsMs: t0 + 2000, path: join(root, "NOTES.md"), op: "write" },
        { tsMs: t0 + 3000, path: join(root, ".claude", "worktrees", "fix", "src", "a.ts"), op: "edit" },
        { tsMs: t0 + 4000, path: "/private/tmp/out.json", op: "write" },
        ...["a", "b", "c"].map((f, i) => ({ tsMs: t0 + 5000 + i, path: `/opt/other/${f}`, op: "write" })),
      ],
      subagents: [{ id: "s1", type: "Explore", name: null, description: "Map the code", model: null, tsMs: t0 + 9000, brief: "Map it", briefChars: 6, received: "none", toolCalls: 4, writes: [join(root, "src", "b.ts"), "/tmp/x"] }],
    }),
    session("b", "claude", t0 + DAY, {
      loads: [{ tsMs: t0 + DAY, files: [index] }],
      memoryOps: [{ tsMs: t0 + DAY + 1000, op: "read", path: join(memDir, "project-deploy.md"), via: "Read" }],
    }),
    session("c", "codex", t0 + 2 * DAY, { writes: [{ tsMs: t0 + 2 * DAY, path: join(root, "src", "app.ts"), op: "create" }] }),
    session("d", "copilot", t0 + 3 * DAY, {
      loads: [{ tsMs: t0 + 3 * DAY, blocks: [{ hash: hashText(PROJECT_MD), heading: "Shop", lines: 4 }, { hash: "nope", heading: "Unknown", lines: 2 }] }],
    }),
    // Did nothing: left out.
    session("e", "codex", t0 + 4 * DAY, {}, { prompts: [] }),
    // Another project.
    { ...session("f", "claude", t0, {}), project: "else" },
  ];
  const ctx = buildAgentContext(sessions, { project: "shop", home, claudeDir, now: t0 + 5 * DAY });

  assert.deepEqual(ctx.sessions.map((s) => s.id), ["a", "b", "c", "d"]);
  assert.equal(ctx.root, "~/dev/shop");

  // Memory: the index line next to what the file says it is, plus its type.
  assert.equal(ctx.memory.dir, "~/.claude/projects/-dev-shop/memory");
  const deploy = ctx.memory.files.find((f) => f.file === "project-deploy.md");
  assert.equal(deploy.title, "Deploy steps");
  assert.equal(deploy.hook, "deploy with make ship, never on Fridays");
  assert.equal(deploy.description, "How to deploy: make ship, Fridays allowed");
  assert.equal(ctx.sessions[1].memoryOps[0].file, "project-deploy.md");

  // Files: repo writes counted per session, worktrees and scratch apart, a folder of 3 outside files in one row.
  const a = ctx.sessions[0];
  assert.deepEqual(a.files, { repo: 1, worktrees: ["fix"], scratch: 1, outside: 3 });
  assert.deepEqual(ctx.open.outside.map((o) => [o.path, o.kind, o.files]), [["/opt/other/", "folder", 3]]);
  assert.equal(ctx.open.worktrees[0].name, "fix");
  // Untracked files, with the session that wrote them, or none when only a shell did.
  assert.deepEqual(ctx.open.untracked.map((u) => [u.path, u.firstSession]), [["NOTES.md", "a"], ["scratch.md", null]]);
  // A file Codex created, with its git state.
  assert.deepEqual(ctx.sessions[2].created, [{ path: "src/app.ts", state: "committed" }]);

  // Sub-agents: what they received, and where what they wrote lives.
  assert.equal(a.subagents[0].received, "none");
  assert.deepEqual(a.subagents[0].wrote, { repo: 1, scratch: 1 });

  // Instruction files read at every start, sizes from disk.
  assert.deepEqual(ctx.instructions.map((i) => i.path), ["~/.claude/projects/-dev-shop/memory/MEMORY.md"]);

  // Copilot CLI: blocks matched to files on disk by content, else named by their heading.
  assert.deepEqual(ctx.sessions[3].loads[0].files.map((f) => [f.path, f.label]), [["~/dev/shop/CLAUDE.md", "Shop"], [null, "Unknown"]]);
  assert.equal(ctx.agentsMd, false);
});

test("an unknown project or one without sessions comes back empty", () => {
  const ctx = buildAgentContext([], { project: "nothing", home, claudeDir });
  assert.deepEqual(ctx.sessions, []);
  assert.equal(ctx.memory.dir, null);
  assert.deepEqual(ctx.open.untracked, []);
});
