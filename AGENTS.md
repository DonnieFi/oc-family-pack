# AGENTS.md

`oc-family-pack` is an OpenClaw feature plugin that brings family features
(shared calendar, weather, briefs, reminders, chat with any agent) to an
OpenClaw Gateway. The operator built it for his own household first and
shares it; build for any household (gog for calendars, Discord channels chosen
in setup), never for one install. The operator's older family bot at
`/opt/family-bot` is reference material only: read it, never edit it. Running
both side by side is the operator's concern, not the plugin's.

## What gets published

The repo is public at `DonnieFi/oc-family-pack`. `.gitignore` is an allowlist.

- Plugin code, the built `dist/` (git installs run no build), `README.md`,
  `FAQ.md`, `LICENSE`, package/manifest files,
  this file, agent config (`.agents/`, `.claude/`, `.codex/`) and the beads
  plan ship.
- `docs/` is local only (gitignored): planning, research, audits
  (`docs/fpack_audit.md`), design notes (`docs/research/`) and proof
  screenshots/logs (`docs/proof/`). Put new planning and research there, not
  in `/tmp` or the repo root.
- The plan ships as `.beads/issues.jsonl` (`bd export`) plus
  `.beads/interactions.jsonl`. Re-export after bead changes you commit:
  `bd export > .beads/issues.jsonl`. The Dolt database, backups, and hooks
  stay local.
- Everything that ships is public: scan bead text for family names, IDs,
  emails, calendar IDs, addresses and host details before committing.
- Never force-add an ignored file. If something new must ship, change the
  allowlist in its own commit and say why.
- Do not run `bd dolt push`, do not install beads git hooks, and leave
  `core.hooksPath` unset.

## Epics are branches

Each sub-epic of `oc-family-pack-s5k` maps to one branch (also stored as
`branch` metadata on the epic; `bd show <epic>` shows it).

| Epic | Branch | Merge order |
|---|---|---|
| `s5k.31` Foundation | `epic/foundation` | first |
| `s5k.32` Identity and setup | `epic/identity-setup` | after foundation |
| `s5k.33` Calendar read | `epic/calendar-read` | after foundation |
| `s5k.34` Calendar writes | `epic/calendar-writes` | after calendar-read |
| `s5k.35` Briefs, reminders, and delivery | `epic/briefs-delivery` | after calendar-read |
| `s5k.36` Control UI and agent surfaces | `epic/control-ui` | after calendar-read |
| `s5k.37` Later (deferred) | none | promote a child into an active epic first |

The root epic `s5k` is the v1 umbrella, not a branch.

- New work goes under the epic that owns it (`bd create --parent <epic>`);
  cross-epic ordering is expressed with `bd dep add`, not by nesting.
- The in-flight feature-plugin rework lands on `epic/foundation` even though
  it touches `s5k.5` (event fields) and `s5k.24` (page skeleton); `s5k.24`
  stays open in control-ui for the remaining page work.

## Workflow

This repo opts into committing and pushing through the loops below; that
authority covers these steps only. A current "don't commit/push" still wins.

**Bead loop** (on the epic's branch):

1. Claim: `bd ready`, pick a child of the active epic, `bd update <id> --claim`.
2. Implement to the bead's acceptance criteria.
3. Review: a fresh reviewer that did not write the code reads the bead diff
   against the acceptance criteria and this file, with typecheck, tests, and
   plugin build results in hand.
4. Patch every actionable finding; rerun the checks the patch affects.
5. Commit: one Conventional Commit per bead, bead id in the body
   (`Refs: oc-family-pack-s5k.34.1`). Then `bd close <id>` with the short sha
   in the reason.

**Epic loop:**

1. Branch: create the epic branch from current `main` when its first child is
   claimed.
2. Run the bead loop for every child (deferred children excepted).
3. Team review: several independent reviewers over `git diff main...<branch>`,
   one lens each: correctness and tests, privacy and security, the
   architecture rules below, and UX with before/after screenshots when the
   epic touches UI. Consolidate findings.
4. Patch, rerun the full check set plus isolated-Gateway proof, commit.
5. Push the branch and open a PR to `main` as the review record.
6. Merge by fast-forward: `git switch main && git pull --ff-only`, then
   `git merge --ff-only <branch>` and `git push origin main` (GitHub marks the
   PR merged). If `main` moved, rebase the branch onto it, rerun the checks,
   force-push the branch with `--force-with-lease`, and retry. Never create a
   merge commit.
7. Delete the merged branch locally and on the remote, then close the epic.

**Beads without code:** decisions and setup beads (`s5k.1`, `s5k.29`, and
`s5k.26`, which also needs approval because it changes the live Gateway)
close with a reason instead of a commit.

## Build and test

`package.json` owns the commands. Typical loop: `npm install`,
`npm run typecheck`, `npm test`, then `openclaw plugins build`,
`openclaw plugins validate`, and `openclaw plugins build --check` once the
feature-plugin build is in place. Tests assert literal values against
synthetic fixtures in `src/fixtures/`.

## Live proof

- The user's live Gateway listens on port 18789. Never modify, restart, or
  stop it, and never run `openclaw gateway stop` without isolation env set.
- Prove behavior on an isolated Gateway: `OPENCLAW_STATE_DIR` and
  `OPENCLAW_CONFIG_PATH` under a temp dir, loopback bind, a free port other
  than 18789, and `gateway.controlUi.experimental.customPlugins: true` for the
  native page. Stop what you start and delete its state and tokens.
- Use `demo: true` for screenshots. Never read or write real family calendars
  without explicit approval.
- UI changes need inspected before/after screenshots.

## Privacy

No real names, Discord IDs, emails, phone numbers, device MACs, calendar IDs,
or tokens in code, fixtures, commits, screenshots, or PR text. Use the
synthetic family from `src/demo.ts`. Never reuse the family bot's Discord
token; OpenClaw uses its own bot.

## Architecture rules

- Feature plugin on OpenClaw 2026.9.7 or newer, using only the public
  `openclaw/plugin-sdk/*` imports (`feature-contract`, `feature-plugin`,
  `control-ui`, and `tool-plugin` only for the config-schema bridge in
  `src/index.ts` until s5k.31.2 lands). These APIs are experimental: pin and test against the host
  version.
- One feature contract serves chat tools, the page, and commands. Calendar
  writes go through one `CalendarWrite` pipeline (permissions, write mode,
  idempotency key, write log); never add a second write path.
- Requester identity is resolved once at the boundary. Plugins cannot see the
  Gateway profile; Discord uses the roster's Discord ID stub, the page relies
  on the operator's scopes.
- Settings live in plugin config (`plugins.entries.oc-family-pack.config`).
  Persistent data lives in a plugin-owned SQLite file under the state dir,
  opened in a worker thread, never on the Gateway main thread. Never write to
  OpenClaw's own database; its plugin-scoped stores are limited to bundled and
  trusted official plugins, so a community plugin must not depend on them. No
  JSON state files.
- Google Calendar goes through the `gog` CLI; weather through Environment
  Canada's OGC API. No Google client code or API keys in the plugin.
- Config is parsed once at the boundary; MACs are normalized at parse time and
  never re-normalized downstream.
- Wording is family-neutral. Look: OpenClaw design tokens with the family
  dashboard's warmth (amber accent, per-person colors, serif date headings,
  calm motion).

## Shell

Use non-interactive flags (`cp -f`, `mv -f`, `rm -f`, `rm -rf`,
`ssh -o BatchMode=yes`, `apt-get -y`); aliased `-i` prompts hang agents.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
