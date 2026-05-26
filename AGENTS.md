# AGENTS.md

Guidance for AI agents working in this repo. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of truth.

This is **Shippable**, now in **alpha** — a rebuild of the original prototype (the "one to throw away," preserved in `main`). Expect things to move and break. This file is about *how we work with agents here*, not what the tool does; product and architecture notes live in `docs/` as they get designed.

## How we work

We rely heavily on **git worktrees** so several agents — and humans — can work in parallel without stepping on each other.

- One worktree per task, branch named after it (e.g. `feat/diff-ingest`, `chore/test-audit`).
- Agent-owned worktrees live under `.claude/worktrees/<name>`; longer-lived ones sit beside the repo as siblings.
- `git worktree list` is the source of truth — don't guess what's active, list it. Don't `git worktree remove` a tree you didn't create; if one looks stale, ask.
- Coming back to the trunk? `git status` first — don't assume the working tree is the one you left.

## Quality checks

Before committing, run the project's checks in this order: **typecheck → lint → test → build**. Commit only when all pass. (Exact commands land here per package as the codebase grows.)

For UI work, open it in a browser and exercise it end to end. A green build proves the code compiles, not that the feature works — don't claim it works because the build passed.

## Code style

Prefer simple over clever. Boring solutions that work in production and can be understood beat complex ones that don't.

- **Succinct.** Short comments, short PR descriptions. If a comment explains *what* the code does, delete it; if it explains *why*, keep it.
- **No premature abstraction.** Three similar lines is fine. Two call sites does not justify a helper.
- **Naming over commenting.** Well-named identifiers carry the load. Don't reference issue numbers, callers, or "added for X" — that rots.
- **Ask if you don't know.** When writing code, prefer asking the human over assuming.

## Git etiquette

- Conventional-ish commit messages. Look at `git log` for the local style and match it.
- **Never** add co-authored-by attribution to an AI. The accountable party is the human, even when most of the work is AI-assisted.
- Be explicit when pushing: `git push origin <branch>`, never bare `git push`. Never push to the trunk directly.
- Don't force-push. Prefer rebase.
- Don't `git worktree remove` what you didn't create.

## Where ideas live

We document in the repo, not in chat. If you design something non-trivial, write it down where the next agent will find it — `docs/` holds design plans, concepts, and per-subsystem notes.

## Skills

Agent skills are vendored under `.agents/skills/` (pinned in `skills-lock.json`) and auto-discovered by the agent.

| Skill | What it does | How to invoke |
| --- | --- | --- |
| `grill-me` | Interviews you relentlessly about a plan or design, walking each branch of the decision tree until you reach shared understanding. Asks one question at a time and recommends an answer for each. | Say **"grill me"**, or ask to stress-test / get grilled on a plan or design. |

To add, update, or restore skills — including the experimental restore-from-lock command — see [docs/skills.md](docs/skills.md).
