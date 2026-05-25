# Managing skills

Agent skills for this repo are vendored under `.agents/skills/` and pinned in `skills-lock.json`, managed by the [`skills`](https://github.com/vercel-labs/skills) CLI (`vercel-labs/skills`). The `.agents/skills/` path is the cross-tool convention, so the same vendored skills work across agents (Claude Code, Cursor, Codex, etc.).

## Adding a skill

```sh
npx skills@latest add <github-owner>/<repo>
```

e.g. `grill-me` was added with `npx skills@latest add mattpocock/skills`. This vendors the skill into `.agents/skills/<name>/SKILL.md` and records its source, path, and content hash in `skills-lock.json`.

## Restoring pinned skills from the lockfile

A stable `npm ci` equivalent does **not** exist yet — it's tracked in open feature requests [vercel-labs/skills#549](https://github.com/vercel-labs/skills/issues/549) and [#283](https://github.com/vercel-labs/skills/issues/283). There is, however, an **experimental** restore command:

```sh
npx skills@latest experimental_install   # or: bunx skills experimental_install
```

It reads `skills-lock.json` and installs every pinned skill to its agent path. Treat it as experimental — the `experimental_` prefix is deliberate and the behavior may change.

You usually don't need it: because both `.agents/` and `skills-lock.json` are committed, a plain `git clone` already gives the byte-identical skill. `experimental_install` matters mainly if you choose *not* to vendor `.agents/` and want to re-fetch from source. The `computedHash` in the lock is the integrity check that proves vendored content matches its pinned source.

Note: the lock pins a **content hash** (`computedHash`), not a git commit SHA. Restoring resolves the skill at its source path and verifies that hash, rather than checking out a specific upstream commit (see the discussion in [#549](https://github.com/vercel-labs/skills/issues/549)).

## Other commands

The CLI's documented subcommands are `add`, `list`/`ls`, `find`, `remove`/`rm`, `update`, and `init`. To bump a skill to its latest upstream version:

```sh
npx skills@latest update
```
