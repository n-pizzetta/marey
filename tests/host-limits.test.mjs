// Usage limits in Codex's and Copilot CLI's own status lines (scripts/host-limits.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCodexLimits, restoreCodexItems, withLimitItems } from "../scripts/host-limits.mjs";

const LIMITS = '"five-hour-limit", "weekly-limit"';

test("the limit items go right after the model item", () => {
  assert.deepEqual(withLimitItems(["model-with-reasoning", "current-dir"]), ["model-with-reasoning", "five-hour-limit", "weekly-limit", "current-dir"]);
  assert.deepEqual(withLimitItems(["git-branch", "model"]), ["git-branch", "model", "five-hour-limit", "weekly-limit"]);
  assert.deepEqual(withLimitItems(["current-dir", "weekly-limit"]), ["five-hour-limit", "current-dir", "weekly-limit"]);
});

test("Codex's defaults are written out when the user never picked items", () => {
  const toml = 'model = "gpt-6-astra"\n\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\ngpt-6-astra = 3\n';
  const out = addCodexLimits(toml);
  assert.equal(out.previous, null);
  assert.equal(
    out.toml,
    `model = "gpt-6-astra"\n\n[tui]\nstatus_line = ["model-with-reasoning", ${LIMITS}, "current-dir", "thread-name"]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\ngpt-6-astra = 3\n`,
  );
  assert.equal(restoreCodexItems(out.toml, out), toml);
});

test("a [tui] table is added when there is none", () => {
  const out = addCodexLimits('model = "o"\n\n[plugins."marey@marey"]\nenabled = true\n');
  assert.match(out.toml, /enabled = true\n\n\[tui\]\nstatus_line = \["model-with-reasoning", "five-hour-limit", "weekly-limit", "current-dir", "thread-name"\]\n$/);
  assert.match(addCodexLimits("").toml, /^\[tui\]\nstatus_line = \[/);
});

test("the user's own items are kept, even across lines, and restored on uninstall", () => {
  const toml = '[tui]\nstatus_line = [\n  "model", # short\n  "git-branch",\n]\ntheme = "dark"\n';
  const out = addCodexLimits(toml);
  assert.deepEqual(out.previous, ["model", "git-branch"]);
  assert.equal(out.toml, `[tui]\nstatus_line = ["model", ${LIMITS}, "git-branch"]\ntheme = "dark"\n`);
  assert.equal(restoreCodexItems(out.toml, out), '[tui]\nstatus_line = ["model", "git-branch"]\ntheme = "dark"\n');
});

test("nothing to do when the limits are already shown, or when `tui` is set in another form", () => {
  assert.deepEqual(addCodexLimits(`[tui]\nstatus_line = ["model", ${LIMITS}]\n`), { unchanged: true });
  assert.ok(addCodexLimits('tui.status_line = ["model"]\n').error);
  assert.ok(addCodexLimits('[tui]\nstatus_line = "model"\n').error);
});

test("uninstall leaves a status line the user changed since", () => {
  const out = addCodexLimits("[tui]\n");
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
  assert.match(installed, /Codex: the status line now shows the 5h and weekly limits/);
  assert.match(installed, /Copilot CLI: the footer now shows your plan usage/);
  assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /status_line = \["model-with-reasoning", "five-hour-limit", "weekly-limit"/);
  assert.equal(readFileSync(join(codex, "config.toml.marey.bak"), "utf8"), codexToml);
  assert.equal(readFileSync(quota, "utf8").trim(), "true");

  assert.match(run(), /Codex: the status line already shows/);

  const removed = run("--uninstall");
  assert.match(removed, /Codex: status line restored/);
  assert.match(removed, /Copilot CLI: footer restored/);
  assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), codexToml);
  assert.throws(() => readFileSync(quota));
});
