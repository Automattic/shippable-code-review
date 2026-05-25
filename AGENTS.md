# AGENTS.md

Guidance for AI agents working in this repo. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of truth.

## Skills

Agent skills are vendored under `.agents/skills/` (pinned in `skills-lock.json`) and auto-discovered by the agent.

| Skill | What it does | How to invoke |
| --- | --- | --- |
| `grill-me` | Interviews you relentlessly about a plan or design, walking each branch of the decision tree until you reach shared understanding. Asks one question at a time and recommends an answer for each. | Say **"grill me"**, or ask to stress-test / get grilled on a plan or design. |

To add, update, or restore skills — including the experimental restore-from-lock command — see [docs/skills.md](docs/skills.md).
