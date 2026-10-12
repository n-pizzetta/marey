// Usage limits (and Codex's context used) in Codex's and Copilot CLI's own status lines (scripts/host-limits.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCodexItems, restoreCodexItems, withCodexItems } from "../scripts/host-limits.mjs";

const ITEMS = '"context-used", "five-hour-limit", "weekly-limit"';

test("the context and limit items go right after the model item", () => {
  assert.deepEqual(withCodexItems(["model-with-reasoning", "current-dir"]), ["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "current-dir"]);
  assert.deepEqual(withCodexItems(["git-branch", "model"]), ["git-branch", "model", "context-used", "five-hour-limit", "weekly-limit"]);
  assert.deepEqual(withCodexItems(["current-dir", "weekly-limit"]), ["context-used", "five-hour-limit", "current-dir", "weekly-limit"]);
  assert.deepEqual(withCodexItems(["model", "five-hour-limit", "weekly-limit"]), ["model", "context-used", "five-hour-limit", "weekly-limit"]);
});

test("Codex's defaults are written out when the user never picked items", () => {
  const toml = 'model = "gpt-6-astra"\n\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\ngpt-6-astra = 3\n';
  const out = addCodexItems(toml);
  assert.equal(out.previous, null);
  assert.equal(
    out.toml,
    `model = "gpt-6-astra"\n\n[tui]\nstatus_line = ["model-with-reasoning", ${ITEMS}, "current-dir", "thread-name"]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\ngpt-6-astra = 3\n`,
  );
  assert.equal(restoreCodexItems(out.toml, out), toml);
});

test("a [tui] table is added when there is none", () => {
  const out = addCodexItems('model = "o"\n\n[plugins."marey@marey"]\nenabled = true\n');
  assert.match(out.toml, /enabled = true\n\n\[tui\]\nstatus_line = \["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit", "current-dir", "thread-name"\]\n$/);
  assert.match(addCodexItems("").toml, /^\[tui\]\nstatus_line = \[/);
});

test("the user's own items are kept, even across lines, and restored on uninstall", () => {
  const toml = '[tui]\nstatus_line = [\n  "model", # short\n  "git-branch",\n]\ntheme = "dark"\n';
  const out = addCodexItems(toml);
  assert.deepEqual(out.previous, ["model", "git-branch"]);
  assert.equal(out.toml, `[tui]\nstatus_line = ["model", ${ITEMS}, "git-branch"]\ntheme = "dark"\n`);
  assert.equal(restoreCodexItems(out.toml, out), '[tui]\nstatus_line = ["model", "git-branch"]\ntheme = "dark"\n');
});

test("nothing to do when the items are already shown, or when `tui` is set in another form", () => {
  assert.deepEqual(addCodexItems(`[tui]\nstatus_line = ["model", ${ITEMS}]\n`), { unchanged: true });
  assert.ok(addCodexItems('tui.status_line = ["model"]\n').error);
  assert.ok(addCodexItems('[tui]\nstatus_line = "model"\n').error);
});

test("uninstall leaves a status line the user changed since", () => {
  const out = addCodexItems("[tui]\n");
  assert.equal(restoreCodexItems('[tui]\nstatus_line = ["model"]\n', out), null);
});

test("/marey:limits sets both CLIs up and --uninstall puts them back", () => {
  const root = mkdtempSync(join(tmpdir(), "marey-hosts-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const bin = join(root, "bin");
  for (const d of [claude, codex, bin]) mkdirSync(d);
  const codexToml = 'model = "o"\n\n[tui]\ntheme = "dark"\n';
  writeFileSync(join(codex, "config.toml"), codexToml);
  // A stand-in for `copilot config <key> [on|off]` / `--rm <key>`, keeping footer.showQuota in a file.
  const quota = join(root, "quota");
  writeFileSync(
    join(bin, "copilot"),
    `#!/bin/sh\nshift\nif [ "$1" = "--rm" ]; then rm -f "${quota}"; exit 0; fi\n` +
      `if [ -n "$2" ]; then [ "$2" = on ] && echo true > "${quota}" || echo false > "${quota}"; exit 0; fi\n` +
      `[ -f "${quota}" ] || exit 1\ncat "${quota}"\n`,
  );
  chmodSync(join(bin, "copilot"), 0o755);
  const run = (...args) =>
    execFileSync("node", ["scripts/install-statusline.mjs", ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });

  const installed = run();
  assert.match(installed, /Codex: the status line now shows the context used and the 5h and weekly limits/);
  assert.match(installed, /Copilot CLI: the footer now shows your plan usage/);
  assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /status_line = \["model-with-reasoning", "context-used", "five-hour-limit", "weekly-limit"/);
  assert.equal(readFileSync(join(codex, "config.toml.marey.bak"), "utf8"), codexToml);
  assert.equal(readFileSync(quota, "utf8").trim(), "true");

  assert.match(run(), /Codex: the status line already shows/);

  const removed = run("--uninstall");
  assert.match(removed, /Codex: status line restored/);
  assert.match(removed, /Copilot CLI: footer restored/);
  assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), codexToml);
  assert.throws(() => readFileSync(quota));
});

test("upgrading from limits-only keeps the user's own line for --uninstall", () => {
  const root = mkdtempSync(join(tmpdir(), "marey-hosts-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const bin = join(root, "bin");
  for (const d of [join(claude, "marey"), codex, bin]) mkdirSync(d, { recursive: true });
  // What an earlier /marey:limits left: the limits added to Codex's defaults, which the user never picked.
  const original = 'model = "o"\n\n[tui]\ntheme = "dark"\n';
  const limitsOnly = ["model-with-reasoning", "five-hour-limit", "weekly-limit", "current-dir", "thread-name"];
  writeFileSync(join(codex, "config.toml"), `model = "o"\n\n[tui]\nstatus_line = ${JSON.stringify(limitsOnly).replaceAll(",", ", ")}\ntheme = "dark"\n`);
  writeFileSync(join(claude, "marey", "host-limits.json"), JSON.stringify({ codex: { previous: null, applied: limitsOnly } }));
  const run = (...args) =>
    // No copilot on PATH: only Codex is set up.
    execFileSync(process.execPath, ["scripts/install-statusline.mjs", ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: bin },
      encoding: "utf8",
    });

  assert.match(run(), /Codex: the status line now shows the context used/);
  assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /status_line = \["model-with-reasoning", "context-used", "five-hour-limit"/);
  assert.match(run("--uninstall"), /Codex: status line restored/);
  assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), original);
});
