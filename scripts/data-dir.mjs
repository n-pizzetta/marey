/**
 * Marey's own files (limits, live context, tool cache, model overrides) live in
 * <claude config dir>/marey/. Before the rename they were in ccblackbox/: the first call
 * moves that folder and leaves a symlink at the old path, so a status line wrapper or an
 * older plugin version that still points there keeps writing to the same place.
 */
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = "marey";
const LEGACY_NAME = "ccblackbox";

/** <claudeDir>/marey, moved from <claudeDir>/ccblackbox on first use. Honors CLAUDE_CONFIG_DIR, like Claude Code. */
export function dataDir(claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {
  const dir = join(claudeDir, NAME);
  const legacy = join(claudeDir, LEGACY_NAME);
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir);
      symlinkSync(NAME, legacy, "dir");
    } catch {
      /* another process moved it first, or symlinks are unavailable: the new folder is used either way */
    }
  }
  return dir;
}

/** The pre-rename folder, for recognizing an older status line install. */
export function legacyDataDir(claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {
  return join(claudeDir, LEGACY_NAME);
}
