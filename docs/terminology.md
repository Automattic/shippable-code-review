# Terminology

A shared glossary so a word means the same thing whether a human or Claude says
it. Most terms get a one-line definition; a *Does NOT mean* is added only where a
term is genuinely easy to misread in this repo.

## Git & workflow

- **`trunk`** — The active development branch: where day-to-day work happens,
  always kept in running condition. Work branches off `trunk`, not `main`.
- **`main`** — The old first-prototype branch, kept only for reference. Never
  merge into it, and never lift its code, rules, or features into current work —
  consult it only to check how things worked in the previous prototype.
- **`worktree`** — A linked checkout that shares this repo's single `.git`
  database, so multiple branches can be checked out at once.
- **`sibling worktree`** — A worktree placed next to the repo directory, e.g.
  `../pandamode-<name>`, instead of inside it.
- **`main worktree`** — The original clone directory; never removed by worktree
  cleanup.

## Skills & tooling

- **`vendored skill`** — A skill committed into the repo under
  `.agents/skills/<name>/SKILL.md` and auto-discovered from those files, so a
  plain `git clone` reproduces it with nothing fetched at runtime.
- **`skills-lock.json`** — The lockfile pinning each skill's source path and
  content hash. *Does NOT mean* a pin to a specific upstream git commit.
- **`computedHash`** — The integrity hash in the lockfile that proves vendored
  content matches its pinned source — a content hash, not a git commit SHA.
- **`AGENTS.md` / `CLAUDE.md`** — `AGENTS.md` is the single source of truth for
  agent guidance; `CLAUDE.md` pulls it in via `@AGENTS.md`. Edit `AGENTS.md`.
- **`grill-me`** — The vendored skill that interviews you about a plan or design,
  one question at a time, recommending an answer for each.

## Collaboration stance

- **`spec`** — A proportionally-sized written plan (data model, I/O, edge cases,
  open questions) produced *before* writing code. *Does NOT mean* a vague verbal
  intention; even small tasks get a brief spec.
- **`sign-off`** — Explicit user approval to move from spec to implementation.
  *Does NOT mean* silence, or a thumbs-up on something unrelated — approval in one
  context does not carry to the next.
- **`"done"`** — Verified by actually running it this session and observing the
  behavior. *Does NOT mean* the build compiled or tests are green; that proves the
  code runs, not that the feature works.
- **`verify (before claiming)`** — Confirmed this session by reading the file or
  running the code. *Does NOT mean* recalled from earlier in the conversation or
  from training.
- **`assume`** — The thing Claude must *not* do silently. The default is to
  surface the unknown and ask rather than guess. *Does NOT mean* picking a
  plausible answer and moving on quietly.
- **`ask vs. act`** — For hard-to-reverse or outward-facing actions, confirm
  first. *Does NOT mean* proceeding because approval was given for a different
  action earlier.
- **`scope`** — The agreed boundary of the current task. *Does NOT mean* whatever
  seems related; when the boundary is ambiguous, it gets clarified before work
  starts.
