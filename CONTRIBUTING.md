# Contributing to Marey

Thanks for helping. Marey is a small local tool: a parser for Claude Code's own files, a local API and a React dashboard. Issues and pull requests are welcome.

## Setup

Requirements: Node 20+ and pnpm.

```sh
git clone https://github.com/n-pizzetta/marey && cd marey
pnpm install
pnpm dev            # dashboard on http://localhost:5173, reading your ~/.claude
```

### Work on synthetic data

You don't need to expose your own sessions to develop, take screenshots or file a bug. Generate a fake Claude config dir and point the app at it:

```sh
pnpm seed:demo                                   # writes .demo-claude/ and .demo-codex/ (git-ignored)
CLAUDE_CONFIG_DIR="$PWD/.demo-claude" CODEX_HOME="$PWD/.demo-codex" pnpm dev   # or pnpm serve
```

`CLAUDE_CONFIG_DIR` is Claude Code's own variable for relocating `~/.claude`; the parser, API, hook and status line all honor it. `CODEX_HOME` does the same for `~/.codex`: set both, or your real Codex sessions show up next to the demo data. Extend [`scripts/seed-demo.mjs`](scripts/seed-demo.mjs) when you need a new shape of data (a tool, a model, an edge case).

## How changes ship

The plugin marketplace points at this repository (`"source": "./"`), with no staging branch, so `main` must always be releasable:

- **New installs** clone `main` as it is, whatever the version says.
- **Existing users** only update when the `version` in `.claude-plugin/plugin.json` changes ([Claude Code keeps the cached copy until then](https://code.claude.com/docs/en/plugins/loading.md#how-claude-code-computes-the-version)). A release then ships everything merged since the last one.

- Work on a short-lived branch created from an up-to-date `origin/main` (`git fetch && git switch -c fix/my-change origin/main`).
- Pull requests are **squash-merged**: one PR becomes one commit on `main`.
- Anything not ready for users stays out of `main`: keep it on your branch, or behind an option that is off by default.

## Before opening a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All four must pass; CI runs the same checks. `pnpm test` runs the parser against the `pnpm seed:demo` data (`tests/`). If you change the parser, add a case there, extending `scripts/seed-demo.mjs` if the shape you need is missing. Also say in the PR how you checked the change (demo data, a specific transcript shape, a screenshot for UI changes).

- **PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): message`, lowercase, imperative, no period (`fix(parser): skip synthetic messages`). The title becomes the commit on `main` and the source of the changelog, so it is the one that matters; commits inside the branch are squashed away.
- **`dist/` is committed.** The plugin ships the prebuilt UI straight from the repo. If you change anything under `src/`, run `pnpm build` and commit `dist/` in the same PR. CI fails if `dist/` doesn't match the sources.
- **Add a line to `CHANGELOG.md`** under `[Unreleased]` for anything a user would notice.
- **Keep PRs focused.** One fix or feature per PR; a refactor goes in its own PR.

### Conflicts on `dist/`

Every PR that touches `src/` regenerates `dist/`, so two such PRs open at the same time will conflict there. Never resolve `dist/` by hand: take `main`'s version, then rebuild.

```sh
git fetch && git rebase origin/main
# on a conflict in dist/:
git checkout origin/main -- dist/
pnpm build && git add dist/ && git rebase --continue
git push --force-with-lease
```

Resolve conflicts in `src/` normally first; `pnpm build` must run on the final sources.

## Releases

Maintainers cut releases from `main`; contributors don't need to bump anything. Existing users get nothing until `version` changes, so every release bumps it.

1. Open a `chore(release): vX.Y.Z` PR that sets the same version in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `package.json` ([SemVer](https://semver.org/)), and moves the `[Unreleased]` entries of `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`.
2. Once it is merged, tag that commit and publish the GitHub release with the changelog section as notes:

   ```sh
   git fetch && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   gh release create vX.Y.Z --title vX.Y.Z --notes-file notes.md   # notes.md: the CHANGELOG section
   ```

## Where things live

[`ARCHITECTURE.md`](ARCHITECTURE.md) covers the data flow, the parser, pricing, the API and its security checks, and the front-end map. The short version:

| Area | Files |
|---|---|
| Reading Claude Code's data | `scripts/parse-sessions.mjs` |
| Model names and prices | `scripts/models.mjs` |
| Recommendations and their known causes | `scripts/recommendations.mjs`, `scripts/known-frictions.mjs` (add a cause there, with its fix) |
| Local API (prod and dev) | `scripts/api.mjs`, mounted by `scripts/serve.mjs` and `vite.config.ts` |
| Plugins | `.claude-plugin/`, `commands/`, `hooks/capture.mjs`, `scripts/statusline.mjs`; `.codex-plugin/`, `codex-skills/`, `scripts/launch.mjs` for Codex |
| Dashboard | `src/` |

### Updating model prices

When Anthropic ships a model or changes a price, edit the table in `scripts/models.mjs` and link the source (the pricing page) in the PR. Unknown models still work: they are priced like the latest model of their family and marked `~` in the UI until they get a row.

### Claude Code format changes

Claude Code's files are not a public API and change between versions. If a parse breaks, open an issue with your Claude Code version (`claude --version`) and a **redacted** sample of the relevant lines: keep the structure (`type`, `message.usage`, `content[].type`…) and replace prompts, paths and outputs with placeholders.

## Privacy rules

This tool reads people's prompts, code and file snapshots. Contributions must keep it local and private:

- Never commit real data from `~/.claude`: no transcripts, session dumps, screenshots of real sessions, or absolute paths from your machine. Use `pnpm seed:demo`.
- No network calls, telemetry or remote assets (fonts and icons are bundled). The one exception is the daily update check in `scripts/update-check.mjs` (a GET of the repo's `plugin.json`, nothing sent, off with `updateCheck: false`); don't add others.
- The server listens on `127.0.0.1` only and rejects cross-site requests; keep new endpoints behind the same checks in `scripts/api.mjs`, and don't add endpoints that write outside `~/.claude/marey/` without a clear user action.

## Security issues

Please don't open a public issue for a vulnerability. Report it privately through GitHub's **Security → Report a vulnerability** on the repository.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
