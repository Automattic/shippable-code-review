# AGENTS.md

Guidance for AI agents working in this repo. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of truth.

## Skills

Agent skills are vendored under `.agents/skills/` and pinned in `skills-lock.json`. The `.agents/skills/` location is the cross-tool convention the `skills` CLI uses, so the same vendored skills work across agents (Claude Code, Cursor, etc.).

### Available skills

| Skill | What it does | How to invoke |
| --- | --- | --- |
| `grill-me` | Interviews you relentlessly about a plan or design, walking each branch of the decision tree until you reach shared understanding. Asks one question at a time and recommends an answer for each. | Say **"grill me"**, or ask to stress-test / get grilled on a plan or design. |

### Managing skills

- **Add a skill** (managed by the [`skills`](https://www.npmjs.com/package/skills) CLI):

  ```sh
  npx skills@latest add <github-owner>/<repo>
  ```

  e.g. the `grill-me` skill was added with `npx skills@latest add mattpocock/skills`. This vendors the skill file into `.agents/skills/<name>/SKILL.md` and records its source, path, and content hash in `skills-lock.json`.

- **Reproducing the same versions.** Both the vendored skill content (`.agents/`) and the lockfile (`skills-lock.json`) are committed, so a plain `git clone` already gives every collaborator the byte-identical skill. The `computedHash` in the lock is the integrity check that proves the vendored content matches its pinned source.

  > TODO: confirm the `skills` CLI's restore-from-lock command (e.g. an `install`/`sync` subcommand) and document it here.
