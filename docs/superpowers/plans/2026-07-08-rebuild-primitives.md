# Phase 1 — Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four v1 primitives (`Anchor`, `Interaction`, `ChangeSet`, `Capability`) plus `Checks`, the pure write-time validator, and reply-chain resolution, as React-free core modules with tests — the foundation every later phase imports.

**Architecture:** New pure-TS modules under `web/src/primitives/` (avoids collision with the existing `web/src/anchor.ts` re-anchoring *algorithm*). `DiffFile`/`Hunk`/`DiffLine` are carried across unchanged from `web/src/types.ts` — imported, not redefined. This phase is **purely additive**: it adds new files and tests, imports nothing new into the old code, and does not delete the prototype's `types.ts`. So the build stays green at the end of Phase 1. (The red period the one-shot branch is warned about, `v1-architecture.md:1006`, starts in Phase 3/6 when the old `Interaction` is removed and consumers are rewritten — not here.)

**Tech Stack:** TypeScript, vitest 4.1.5. Tests are runtime `describe/expect/it` (house style — see `web/src/types.test.ts`), with `// @ts-expect-error` for the handful of "invalid state must not compile" assertions (caught by `npm run build` / `tsc`).

**Spec:** `product-analysis/v1-architecture.md` §1.1–§1.4, §1.2 write-time rules. Master sequence: `product-analysis/rebuild-sequence.md` Phase 1.

## Global Constraints

Full list in `rebuild-sequence.md`. The ones that bite this phase:

- **React-free core:** these files import React zero times (they're pure types + pure functions). Phase 10 adds the ESLint/test guard; don't violate it now.
- **Quality gate:** `npm run build` + `npm run lint` + `npm run test` (all in `web/`) green before each commit.
- **Guard G1 (security):** `Interaction` is defined **without** a trust `source` field here **only because** `source` is a storage/wire concern resolved server-side in Phase 2/4 (it is not part of the client value type). This is deliberate — Phase 4 re-checks that external bodies are wrapped. If a later reader thinks "the Interaction type forgot `source`," that's why; see Phase 4 acceptance criteria.
- **No `Co-Authored-By: Claude`** in commits. Conventional-ish messages, match `git log`.

## Two spec ambiguities resolved here (flagged for confirmation)

1. **`BlockOrigin` dirty `context: blob`** (`v1-architecture.md:28`) is not a real TS type. The earlier grill log (now in git history) specified a welded window of `DiffLine[]`. **Decision:** `context: DiffLine[]` (reuses the carried `DiffLine`). If you'd rather store a raw file snapshot string + offset, change it here before Task 1 — it's the one place it's defined.
2. **Role wording.** §1.2's write-time rules say *"author's role is `agent`"*, but the change table (`:972`) folds `agent` into `ai`, and `users.role` is `'human' | 'ai'` (§3.1). **Decision:** the role vocabulary is `"human" | "ai"`; "agent" in §1.2 prose is stale. The validator uses `"ai"`.

## File Structure

- Create: `web/src/primitives/anchor.ts` — `Anchor`, `BlockOrigin`, `isInteractionAnchor`, `resolveRootAnchor`
- Create: `web/src/primitives/anchor.test.ts`
- Create: `web/src/primitives/checks.ts` — `CheckKey`, `CheckResult`, `Checks`, `CHECK_KEYS`, `isCompleteChecks`
- Create: `web/src/primitives/checks.test.ts`
- Create: `web/src/primitives/interaction.ts` — `Intent`, `Interaction`, `AgentInteraction`, `Role`, `validateInteractionWrite`
- Create: `web/src/primitives/interaction.test.ts`
- Create: `web/src/primitives/changeset.ts` — `ChangeSet`, `ChangeSetSource`, `changeSetId`
- Create: `web/src/primitives/changeset.test.ts`
- Create: `web/src/primitives/capability.ts` — `CapabilityKey`, `Capability`, `Capabilities`
- Create: `web/src/primitives/capability.test.ts`
- Reuse (import, do not modify): `web/src/types.ts` (`DiffLine`, `Hunk`, `DiffFile`)

---

### Task 1: Anchor + BlockOrigin

**Files:** Create `web/src/primitives/anchor.ts`, `web/src/primitives/anchor.test.ts`.

**Interfaces:**
- Consumes: `DiffLine` from `../types`.
- Produces: `Anchor`, `BlockOrigin`, `isInteractionAnchor(a: Anchor): a is Extract<Anchor, {type:"interaction"}>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/primitives/anchor.test.ts
import { describe, expect, it } from "vitest";
import { isInteractionAnchor, type Anchor } from "./anchor";

describe("Anchor", () => {
  it("isInteractionAnchor narrows only the interaction variant", () => {
    const reply: Anchor = { type: "interaction", interactionId: "i1" };
    const block: Anchor = {
      type: "block", file: "a.ts", lo: 3, hi: 3,
      origin: { type: "committed", sha: "abc" },
    };
    expect(isInteractionAnchor(reply)).toBe(true);
    expect(isInteractionAnchor(block)).toBe(false);
  });

  it("a single line is a block with lo === hi", () => {
    const line: Anchor = {
      type: "block", file: "a.ts", lo: 7, hi: 7,
      origin: { type: "dirty", hash: "fnv", context: [] },
    };
    expect(line.type === "block" && line.lo === line.hi).toBe(true);
  });

  it("changeset anchor carries no payload", () => {
    // @ts-expect-error — changeset variant has no file field
    const bad: Anchor = { type: "changeset", file: "a.ts" };
    void bad;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/anchor.test.ts`
Expected: FAIL — cannot find module `./anchor`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/primitives/anchor.ts
import type { DiffLine } from "../types";

export type BlockOrigin =
  | { type: "committed"; sha: string }            // git re-derives the window from sha on demand
  | { type: "dirty"; hash: string; context: DiffLine[] }; // no sha → welded snapshot in our store

export type Anchor =
  | { type: "block"; file: string; lo: number; hi: number; origin: BlockOrigin }
  | { type: "symbol"; file: string; symbol: string }
  | { type: "file"; file: string }
  | { type: "changeset" }
  | { type: "interaction"; interactionId: string };

export function isInteractionAnchor(
  a: Anchor,
): a is Extract<Anchor, { type: "interaction" }> {
  return a.type === "interaction";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/anchor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/anchor.ts web/src/primitives/anchor.test.ts
git commit -m "feat(primitives): Anchor + BlockOrigin discriminated unions"
```

---

### Task 2: resolveRootAnchor (reply-chain resolution)

**Files:** Modify `web/src/primitives/anchor.ts`; add tests to `web/src/primitives/anchor.test.ts`.

**Interfaces:**
- Produces: `resolveRootAnchor(anchor: Anchor, lookup: (interactionId: string) => Anchor | undefined): Anchor` — walks `interaction` anchors to the first code/changeset anchor. Throws on a broken chain (missing parent).

- [ ] **Step 1: Write the failing test**

```ts
// append to web/src/primitives/anchor.test.ts
import { resolveRootAnchor } from "./anchor";

describe("resolveRootAnchor", () => {
  const root: Anchor = { type: "file", file: "a.ts" };
  // i1 roots on a file; i2 replies to i1; i3 replies to i2
  const anchors: Record<string, Anchor> = {
    i1: root,
    i2: { type: "interaction", interactionId: "i1" },
    i3: { type: "interaction", interactionId: "i2" },
  };
  const lookup = (id: string): Anchor | undefined => anchors[id];

  it("returns a code/changeset anchor unchanged", () => {
    expect(resolveRootAnchor(root, lookup)).toEqual(root);
  });

  it("walks a multi-level reply chain to the root", () => {
    expect(resolveRootAnchor(anchors.i3, lookup)).toEqual(root);
  });

  it("throws on a broken chain (missing parent)", () => {
    const orphan: Anchor = { type: "interaction", interactionId: "missing" };
    expect(() => resolveRootAnchor(orphan, lookup)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/anchor.test.ts`
Expected: FAIL — `resolveRootAnchor` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to web/src/primitives/anchor.ts
export function resolveRootAnchor(
  anchor: Anchor,
  lookup: (interactionId: string) => Anchor | undefined,
): Anchor {
  let current = anchor;
  while (current.type === "interaction") {
    const parent = lookup(current.interactionId);
    if (!parent) {
      throw new Error(`resolveRootAnchor: missing parent ${current.interactionId}`);
    }
    current = parent;
  }
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/anchor.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/anchor.ts web/src/primitives/anchor.test.ts
git commit -m "feat(primitives): resolveRootAnchor walks reply chains to their root"
```

---

### Task 3: Checks (flat 5-label closed set)

**Files:** Create `web/src/primitives/checks.ts`, `web/src/primitives/checks.test.ts`.

**Interfaces:**
- Produces: `CheckKey`, `CheckResult`, `Checks = Record<CheckKey, CheckResult>`, `CHECK_KEYS: readonly CheckKey[]`, `isCompleteChecks(value: unknown): value is Checks` (server-boundary guard: every key present, each with a `result` and a non-empty `note`).

- [ ] **Step 1: Write the failing test**

```ts
// web/src/primitives/checks.test.ts
import { describe, expect, it } from "vitest";
import { CHECK_KEYS, isCompleteChecks, type Checks } from "./checks";

const complete: Checks = {
  "reproduced": { result: "yes", note: "auth.test.ts:42 throws" },
  "tests-run": { result: "yes", note: "npm test -- auth" },
  "tests-pass": { result: "no", note: "3 failures after the change" },
  "traced-the-code": { result: "yes", note: "validateToken -> null deref" },
  "confirmed-by-second-agent": { result: "no", note: "no second agent consulted" },
};

describe("Checks", () => {
  it("CHECK_KEYS lists all five labels", () => {
    expect([...CHECK_KEYS].sort()).toEqual(
      ["confirmed-by-second-agent", "reproduced", "tests-pass", "tests-run", "traced-the-code"],
    );
  });

  it("accepts a complete rubric", () => {
    expect(isCompleteChecks(complete)).toBe(true);
  });

  it("rejects a missing label", () => {
    const { "tests-pass": _omit, ...partial } = complete;
    expect(isCompleteChecks(partial)).toBe(false);
  });

  it("rejects an empty note even when result is yes", () => {
    const bad = { ...complete, "reproduced": { result: "yes", note: "" } };
    expect(isCompleteChecks(bad)).toBe(false);
  });

  it("a Checks literal missing a key does not compile", () => {
    // @ts-expect-error — Record<CheckKey,…> requires every key
    const missing: Checks = { "reproduced": { result: "yes", note: "x" } };
    void missing;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/checks.test.ts`
Expected: FAIL — cannot find module `./checks`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/primitives/checks.ts
export type CheckKey =
  | "reproduced"
  | "tests-run"
  | "tests-pass"
  | "traced-the-code"
  | "confirmed-by-second-agent";

export type CheckResult = { result: "yes" | "no"; note: string };
export type Checks = Record<CheckKey, CheckResult>;

export const CHECK_KEYS: readonly CheckKey[] = [
  "reproduced",
  "tests-run",
  "tests-pass",
  "traced-the-code",
  "confirmed-by-second-agent",
];

export function isCompleteChecks(value: unknown): value is Checks {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return CHECK_KEYS.every((key) => {
    const entry = v[key] as CheckResult | undefined;
    return (
      !!entry &&
      (entry.result === "yes" || entry.result === "no") &&
      typeof entry.note === "string" &&
      entry.note.trim().length > 0
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/checks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/checks.ts web/src/primitives/checks.test.ts
git commit -m "feat(primitives): Checks rubric — flat 5-label closed set with note guard"
```

---

### Task 4: Interaction + AgentInteraction

**Files:** Create `web/src/primitives/interaction.ts`, `web/src/primitives/interaction.test.ts`.

**Interfaces:**
- Consumes: `Anchor` from `./anchor`; `Checks` from `./checks`.
- Produces: `Role = "human" | "ai"`, `AskIntent`, `ResponseIntent`, `Intent`, `Interaction`, `AgentInteraction`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/primitives/interaction.test.ts
import { describe, expect, it } from "vitest";
import type { AgentInteraction, Interaction } from "./interaction";

describe("Interaction", () => {
  it("a base human interaction has no AI-only fields", () => {
    const i: Interaction = {
      id: "i1", changesetId: "cs1",
      anchor: { type: "file", file: "a.ts" },
      authorId: "u1", intent: "comment", body: "looks off",
      createdAt: "t0", updatedAt: "t0",
    };
    // @ts-expect-error — checks is not on the base Interaction
    void i.checks;
    expect(i.intent).toBe("comment");
  });

  it("an AgentInteraction requires checks and rationale", () => {
    const a: AgentInteraction = {
      id: "i2", changesetId: "cs1",
      anchor: { type: "block", file: "a.ts", lo: 1, hi: 1, origin: { type: "committed", sha: "s" } },
      authorId: "ai1", intent: "blocker", body: "null deref",
      createdAt: "t0", updatedAt: "t0",
      checks: {
        "reproduced": { result: "yes", note: "x" },
        "tests-run": { result: "yes", note: "x" },
        "tests-pass": { result: "no", note: "x" },
        "traced-the-code": { result: "yes", note: "x" },
        "confirmed-by-second-agent": { result: "no", note: "x" },
      },
      rationale: "decode returns null on empty token",
    };
    expect(a.rationale).toContain("decode");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/interaction.test.ts`
Expected: FAIL — cannot find module `./interaction`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/primitives/interaction.ts
import type { Anchor } from "./anchor";
import type { Checks } from "./checks";

export type Role = "human" | "ai";

export type AskIntent = "comment" | "question" | "blocker";
export type ResponseIntent = "accept" | "reject";
export type Intent = AskIntent | ResponseIntent;

export type Interaction = {
  id: string;
  changesetId: string;
  anchor: Anchor;
  authorId: string; // → users.id
  intent: Intent;
  body: string; // markdown
  createdAt: string;
  updatedAt: string;
};

export type AgentInteraction = Interaction & {
  checks: Checks;
  rationale: string;
  suggestedFix?: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/interaction.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/interaction.ts web/src/primitives/interaction.test.ts
git commit -m "feat(primitives): Interaction + AgentInteraction unified signal"
```

---

### Task 5: validateInteractionWrite (pure write-time rules)

**Files:** Modify `web/src/primitives/interaction.ts`; add tests to `web/src/primitives/interaction.test.ts`.

**Interfaces:**
- Consumes: `isInteractionAnchor` from `./anchor`; `isCompleteChecks` from `./checks`.
- Produces:
  ```ts
  type WriteInput = {
    anchor: Anchor; intent: Intent; role: Role;
    checks?: unknown; rationale?: string; suggestedFix?: string;
    parentExists: boolean; // caller resolves anchor.type==="interaction" existence
  };
  function validateInteractionWrite(input: WriteInput): { ok: true } | { ok: false; error: string };
  ```
  Enforces §1.2's write-time rules. Consumed by the server in Phase 4; pure and core here.

- [ ] **Step 1: Write the failing test**

```ts
// append to web/src/primitives/interaction.test.ts
import { validateInteractionWrite } from "./interaction";
import type { Checks } from "./checks";

const fullChecks: Checks = {
  "reproduced": { result: "yes", note: "x" },
  "tests-run": { result: "yes", note: "x" },
  "tests-pass": { result: "no", note: "x" },
  "traced-the-code": { result: "yes", note: "x" },
  "confirmed-by-second-agent": { result: "no", note: "x" },
};

describe("validateInteractionWrite", () => {
  it("accepts a human ask rooted on code", () => {
    expect(validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "human", parentExists: false,
    })).toEqual({ ok: true });
  });

  it("rejects an ask anchored on an interaction", () => {
    const r = validateInteractionWrite({
      anchor: { type: "interaction", interactionId: "i1" }, intent: "blocker",
      role: "human", parentExists: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a response NOT anchored on an interaction", () => {
    const r = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "accept",
      role: "human", parentExists: false,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a reply whose parent does not exist", () => {
    const r = validateInteractionWrite({
      anchor: { type: "interaction", interactionId: "gone" }, intent: "accept",
      role: "human", parentExists: false,
    });
    expect(r.ok).toBe(false);
  });

  it("requires complete checks + rationale for ai authors", () => {
    const missing = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "ai", parentExists: false,
    });
    expect(missing.ok).toBe(false);
    const ok = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "ai", checks: fullChecks, rationale: "why", parentExists: false,
    });
    expect(ok).toEqual({ ok: true });
  });

  it("rejects AI-only fields on a human author", () => {
    const r = validateInteractionWrite({
      anchor: { type: "file", file: "a.ts" }, intent: "comment",
      role: "human", checks: fullChecks, parentExists: false,
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/interaction.test.ts`
Expected: FAIL — `validateInteractionWrite` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to web/src/primitives/interaction.ts
import { isInteractionAnchor, type Anchor } from "./anchor";
import { isCompleteChecks } from "./checks";

const ASK_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["comment", "question", "blocker"]);

export type WriteInput = {
  anchor: Anchor;
  intent: Intent;
  role: Role;
  checks?: unknown;
  rationale?: string;
  suggestedFix?: string;
  parentExists: boolean;
};

export function validateInteractionWrite(
  input: WriteInput,
): { ok: true } | { ok: false; error: string } {
  const isAsk = ASK_INTENTS.has(input.intent);
  const onInteraction = isInteractionAnchor(input.anchor);

  if (isAsk && onInteraction) return { ok: false, error: "asks must root on code/changeset" };
  if (!isAsk && !onInteraction) return { ok: false, error: "responses must reply to an interaction" };
  if (onInteraction && !input.parentExists) return { ok: false, error: "parent interaction does not exist" };

  if (input.role === "ai") {
    if (!isCompleteChecks(input.checks)) return { ok: false, error: "ai interactions require complete checks" };
    if (!input.rationale || input.rationale.trim() === "") return { ok: false, error: "ai interactions require a rationale" };
  } else {
    if (input.checks !== undefined || input.rationale !== undefined || input.suggestedFix !== undefined) {
      return { ok: false, error: "human interactions carry no ai-only fields" };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/interaction.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/interaction.ts web/src/primitives/interaction.test.ts
git commit -m "feat(primitives): validateInteractionWrite enforces §1.2 write-time rules"
```

---

### Task 6: ChangeSet + ChangeSetSource + changeSetId

**Files:** Create `web/src/primitives/changeset.ts`, `web/src/primitives/changeset.test.ts`.

**Interfaces:**
- Consumes: `DiffFile` from `../types`.
- Produces: `ChangeSetSource` (worktree-only union in v1), `ChangeSet`, `changeSetId(source: ChangeSetSource): string`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/primitives/changeset.test.ts
import { describe, expect, it } from "vitest";
import { changeSetId, type ChangeSet, type ChangeSetSource } from "./changeset";

describe("ChangeSet", () => {
  it("derives a worktree id as worktree:{workdir}@{identifier}", () => {
    const src: ChangeSetSource = {
      type: "worktree", workdir: "/w/feat", branch: "feat", identifier: "abc123", dirty: false,
    };
    expect(changeSetId(src)).toBe("worktree:/w/feat@abc123");
  });

  it("a ChangeSet links to its parent on refresh", () => {
    const cs: ChangeSet = {
      id: "worktree:/w@sha2", parentChangesetId: "worktree:/w@sha1",
      source: { type: "worktree", workdir: "/w", branch: "main", identifier: "sha2", dirty: true },
      files: [] as DiffFile[], ingestedAt: "t0",
    };
    expect(cs.parentChangesetId).toBe("worktree:/w@sha1");
  });
});

import type { DiffFile } from "../types";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/changeset.test.ts`
Expected: FAIL — cannot find module `./changeset`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/primitives/changeset.ts
import type { DiffFile } from "../types";

// v1 ships worktree only; other sources are type-level future (§1.3, §18).
export type ChangeSetSource = {
  type: "worktree";
  workdir: string;
  branch: string;
  identifier: string; // commit sha, or a computed id when there are uncommitted changes
  dirty: boolean;
};

export type ChangeSet = {
  id: string;
  parentChangesetId?: string;
  source: ChangeSetSource;
  files: DiffFile[]; // DiffFile/Hunk/DiffLine unchanged — carried from ../types
  ingestedAt: string;
};

export function changeSetId(source: ChangeSetSource): string {
  return `worktree:${source.workdir}@${source.identifier}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/changeset.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/changeset.ts web/src/primitives/changeset.test.ts
git commit -m "feat(primitives): ChangeSet + worktree-only source + changeSetId"
```

---

### Task 7: Capability

**Files:** Create `web/src/primitives/capability.ts`, `web/src/primitives/capability.test.ts`.

**Interfaces:**
- Produces: `CapabilityKey`, `Capability`, `Capabilities = Record<CapabilityKey, Capability>`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/primitives/capability.test.ts
import { describe, expect, it } from "vitest";
import type { Capabilities, Capability } from "./capability";

describe("Capability", () => {
  it("an unavailable capability carries a reason", () => {
    const cap: Capability = { available: false, reason: "Not in v1; PR ingest lands in v1.5" };
    expect(cap.available === false && cap.reason.length > 0).toBe(true);
  });

  it("an available capability has no reason field", () => {
    const cap: Capability = { available: true };
    // @ts-expect-error — reason exists only on the unavailable variant
    void cap.reason;
    expect(cap.available).toBe(true);
  });

  it("Capabilities maps every key", () => {
    const caps: Partial<Capabilities> = { "ai.mcp": { available: false, reason: "no watcher" } };
    expect(caps["ai.mcp"]?.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/primitives/capability.test.ts`
Expected: FAIL — cannot find module `./capability`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/primitives/capability.ts
export type CapabilityKey =
  | "lsp.typescript" | "lsp.php" | "lsp.python"
  | "runner.js" | "runner.php"
  | "ai.mcp"            // any watcher present
  | "picker.directory"; // tauri-plugin-dialog or AppleScript

export type Capability =
  | { available: true }
  | { available: false; reason: string };

export type Capabilities = Record<CapabilityKey, Capability>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/primitives/capability.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/primitives/capability.ts web/src/primitives/capability.test.ts
git commit -m "feat(primitives): Capability union + Capabilities record"
```

---

## Phase-1 exit criteria

- [ ] All five primitive modules + tests exist under `web/src/primitives/`.
- [ ] `cd web && npm run test` green (whole suite, not just the new files).
- [ ] `cd web && npm run build` green — proves the `@ts-expect-error` negatives still error and nothing else broke.
- [ ] `cd web && npm run lint` green.
- [ ] The new files import React zero times and import `DiffFile`/`Hunk`/`DiffLine` from `../types` (not redefined).
- [ ] The prototype's `web/src/types.ts` is **unmodified** — Phase 1 is additive; the old `Interaction` still stands until Phase 3/6 rewires consumers.

## Self-review (against v1-architecture.md §1)

- **§1.1 Anchor / BlockOrigin** → Task 1; **reply-chain resolveRootAnchor** → Task 2.
- **§1.2 Interaction / AgentInteraction / Checks** → Tasks 3–4; **write-time rules** → Task 5.
- **§1.3 ChangeSet / ChangeSetSource / id** → Task 6.
- **§1.4 Capability** → Task 7.
- **Deliberately deferred:** the trust `source` field (server/wire, Phase 4); `symbol` resolution against a code-graph (Phase 9); `context` fingerprinting / FNV-1a re-anchoring (the `anchor.ts` algorithm, Phase 6). This phase is types + pure invariants only.
