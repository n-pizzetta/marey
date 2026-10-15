# README demos

These scripts record `docs/readme/hero.png` and the feature GIFs in `docs/readme/` from the demo data. Rerun them when the UI changes.

Needs Google Chrome, ffmpeg and a C compiler (`cc`), on macOS or Linux (the live sessions rely on `ps`). Intermediate files go to `.readme-rec/` (gitignored).

## Set up the demo

```sh
pnpm install
pnpm seed:demo                    # synthetic sessions in .demo-claude/, .demo-codex/ and .demo-copilot/
node scripts/readme/ghosts.mjs    # an empty and a crashed session, for the ghost demo
export CLAUDE_CONFIG_DIR="$PWD/.demo-claude" CODEX_HOME="$PWD/.demo-codex" COPILOT_HOME="$PWD/.demo-copilot"
scripts/readme/restart-live.sh    # running sessions: one that adds a turn every 2.5 s, plus fleetsim.mjs's
pnpm exec vite --host 127.0.0.1 --port 3344 --strictPort &
```

Set all three homes, or your real Codex and Copilot CLI sessions show up in the recordings. `restart-live.sh` starts four running sessions, one per state on the Now board: livesim.mjs's Claude Code session at work, then fleetsim.mjs's Claude Code session waiting for your next prompt, one asking a question, and a Copilot CLI session at work. The live session's context grows with every turn, so run `restart-live.sh` again before each recording.

## Record

```sh
# one GIF
scripts/readme/restart-live.sh && node scripts/readme/rec.mjs timeline && scripts/readme/togif.sh timeline

# all GIFs, then the hero
for n in replay timeline live fleet compare ghost; do
  scripts/readme/restart-live.sh && node scripts/readme/rec.mjs $n && scripts/readme/togif.sh $n
done
scripts/readme/restart-live.sh && node scripts/readme/hero.mjs
```

The scenarios (clicks, scrolls, pauses) are in `scn.mjs`, and the hero layout is in `hero.html`.

## Clean up

```sh
pkill -f livesim.mjs; pkill -f .readme-rec/bin/; pkill -f "vite --host 127.0.0.1 --port 3344"
```
