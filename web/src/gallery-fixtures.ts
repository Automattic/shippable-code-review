import type { Interaction, ReviewPlan, ReviewState } from "./types";
import {
  blockCommentKey,
  noteKey,
  lineNoteReplyKey,
  teammateReplyKey,
} from "./types";
import { CS_42, INTERACTIONS_42 } from "./fixtures/cs-42-preferences";
import { CS_57, INTERACTIONS_57 } from "./fixtures/cs-57-session-race";
import {
  CS_91,
  CS_91_DETACHED,
  CS_91_INTERACTIONS,
} from "./fixtures/cs-91-agent-flow";
import {
  ackedNotesToInteractions,
  initialState,
  mergeInteractionMaps,
} from "./state";
import { planReview } from "./plan";

export interface DiffGalleryFixture {
  kind: "diff";
  name: string;
  description: string;
  state: ReviewState;
  /** The file id to focus DiffView on. */
  fileId: string;
  /** The hunk id to treat as "current". */
  hunkId: string;
  /** Cursor line within that hunk. */
  cursorLineIdx: number;
}

export interface PlanGalleryFixture {
  kind: "plan";
  name: string;
  description: string;
  plan: ReviewPlan;
}

export interface SyntaxGalleryFixture {
  kind: "syntax";
  name: string;
  description: string;
  snippets: {
    title: string;
    language: string;
    code: string;
  }[];
}

export type GalleryFixture =
  | DiffGalleryFixture
  | PlanGalleryFixture
  | SyntaxGalleryFixture;

// ── helpers ────────────────────────────────────────────────────────────────

function markLines(
  base: Record<string, Set<number>>,
  hunkId: string,
  indices: number[],
): Record<string, Set<number>> {
  const set = new Set(base[hunkId] ?? []);
  for (const i of indices) set.add(i);
  return { ...base, [hunkId]: set };
}

const INGEST_TS = "0001-01-01T00:00:00.000Z";

function aiInteraction(
  threadKey: string,
  intent: "comment" | "question" | "request",
  summary: string,
  detail?: string,
): Interaction {
  return {
    id: `ai:${threadKey}`,
    threadKey,
    target: "line",
    intent,
    author: "ai",
    authorRole: "ai",
    body: detail ? `${summary}\n\n${detail}` : summary,
    createdAt: INGEST_TS,
  };
}

// ── 1. empty ───────────────────────────────────────────────────────────────
// The raw initialState for cs-42, cursor at hunk 1 line 0.
// Shows a fresh review with no lines marked, no notes acked.

const cs42 = CS_42; // "Add user preferences panel"
const emptyState = initialState([cs42]);

export const fixtureEmpty: GalleryFixture = {
  kind: "diff",
  name: "empty",
  description: "Initial state — nothing read, no files signed off, no notes acked.",
  state: {
    ...emptyState,
    readLines: {},
    interactions: INTERACTIONS_42,
  },
  fileId: cs42.files[0].id,
  hunkId: cs42.files[0].hunks[0].id,
  cursorLineIdx: 0,
};

// ── 2. mid-review ──────────────────────────────────────────────────────────
// cs-42, several lines reviewed across two hunks; one AI note acked;
// cursor parked mid-way through the second hunk (storage.ts#h2).

const storageFile = cs42.files[1]; // src/utils/storage.ts
const storageH1 = storageFile.hunks[0];
const storageH2 = storageFile.hunks[1];

const midReadLines = markLines(
  markLines({}, storageH1.id, [0, 1, 2, 3, 4]),
  storageH2.id,
  [0, 1, 2, 3, 4, 5],
);

export const fixtureMidReview: GalleryFixture = {
  kind: "diff",
  name: "mid-review",
  description:
    "Several lines read across two hunks; one AI note acked; no files signed off yet.",
  state: {
    ...emptyState,
    cursor: {
      changesetId: cs42.id,
      fileId: storageFile.id,
      hunkId: storageH2.id,
      lineIdx: 6,
    },
    readLines: midReadLines,
    interactions: ackedNotesToInteractions(
      new Set([noteKey(storageH2.id, 6)]),
      INTERACTIONS_42,
    ),
  },
  fileId: storageFile.id,
  hunkId: storageH2.id,
  cursorLineIdx: 6,
};

// Extra AI Interactions layered onto PreferencesPanel.tsx for the ai-saturated
// fixture. Existing notes in the source fixture live at lineIdx 14, 21, 26 —
// we don't override those.
const prefFile = cs42.files[2]; // src/components/PreferencesPanel.tsx
const prefH1 = prefFile.hunks[0];

const SATURATED_EXTRA_NOTES: Record<number, Interaction> = {
  4: aiInteraction(
    lineNoteReplyKey(prefH1.id, 4),
    "comment",
    "Defaults declared inline",
    "If SSR ever needs these values, consider lifting DEFAULTS to a config module shared between client and server.",
  ),
  11: aiInteraction(
    lineNoteReplyKey(prefH1.id, 11),
    "request",
    "First paint uses DEFAULTS before stored prefs arrive",
    "The useEffect runs after mount, so there is a brief flash of the default theme before loadPrefs() resolves. For theme specifically this is visible as a light/dark flicker.",
  ),
  19: aiInteraction(
    lineNoteReplyKey(prefH1.id, 19),
    "question",
    "update recreated every render",
    "Fine if nothing downstream depends on referential identity. If a memoised child starts passing update through, you'll want useCallback.",
  ),
  24: aiInteraction(
    lineNoteReplyKey(prefH1.id, 24),
    "request",
    "Form has no onSubmit handler",
    "Hitting Enter inside the select triggers a full-page form submission. Either wire onSubmit={e => e.preventDefault()} or drop the <form> element entirely.",
  ),
  27: aiInteraction(
    lineNoteReplyKey(prefH1.id, 27),
    "comment",
    "Controlled <select> trusts stored theme",
    "If loadPrefs returns an unexpected theme string (e.g. schema drift), the select renders with value that doesn't match any option. Worth validating against the known enum before calling setPrefs.",
  ),
};

// ── 3. ai-saturated ────────────────────────────────────────────────────────
// Synthetic variant of cs-42's PreferencesPanel hunk with extra AI Interactions
// layered on, to stress-test how DiffView + Inspector handle a densely-annotated
// hunk. Gallery-local: does not mutate the shared CS_42 fixture.

const saturatedExtrasMap: Record<string, Interaction[]> = {};
for (const ix of Object.values(SATURATED_EXTRA_NOTES)) {
  saturatedExtrasMap[ix.threadKey] = [ix];
}

const saturatedBase = initialState([cs42]);

export const fixtureAiSaturated: GalleryFixture = {
  kind: "diff",
  name: "ai-saturated",
  description:
    "Eight AI notes on one hunk across info/question/warning; three acked, five outstanding.",
  state: {
    ...saturatedBase,
    cursor: {
      changesetId: cs42.id,
      fileId: prefFile.id,
      hunkId: prefH1.id,
      lineIdx: 26,
    },
    readLines: markLines({}, prefH1.id, [0, 1, 2, 3, 10, 11, 12, 13, 14]),
    interactions: ackedNotesToInteractions(
      new Set([
        noteKey(prefH1.id, 4), // info — acked
        noteKey(prefH1.id, 14), // info — acked
        noteKey(prefH1.id, 21), // question — acked
      ]),
      mergeInteractionMaps(
        mergeInteractionMaps(INTERACTIONS_42, saturatedExtrasMap),
        {
          [lineNoteReplyKey(prefH1.id, 26)]: [
            {
              id: "g-r1",
              threadKey: lineNoteReplyKey(prefH1.id, 26),
              target: "reply",
              intent: "comment",
              author: "romina",
              authorRole: "user",
              body:
                "Fix will probably look like this once I validate the payload:\n\n```ts\nconst next = sanitizePrefs(loadPrefs());\nsetPrefs(next);\n```",
              createdAt: "2026-04-22T12:00:00Z",
            },
          ],
        },
      ),
    ),
  },
  fileId: prefFile.id,
  hunkId: prefH1.id,
  cursorLineIdx: 26,
};

// ── 4. teammate-endorsed ───────────────────────────────────────────────────
// cs-57 auth middleware hunk — has a teammate "approve" badge from @mina plus
// an AI call-site note. Shows teammate badge + AI badge together.
//
// Note: the fixture data has two hunks with teammateReview on cs-57. We pick
// auth.ts#h2 (verdict: "approve") for the most visually interesting state.

const cs57 = CS_57; // "Fix race condition in session hydration"
const authFile = cs57.files[2]; // server/middleware/auth.ts
const authH2 = authFile.hunks[1];

const teammateState = initialState([cs57]);

export const fixtureTeammateEndorsed: GalleryFixture = {
  kind: "diff",
  name: "teammate-endorsed",
  description:
    "auth middleware hunk with @mina approve badge and an AI call-site note; cursor on the ensureSessionReady() line.",
  state: {
    ...teammateState,
    cursor: {
      changesetId: cs57.id,
      fileId: authFile.id,
      hunkId: authH2.id,
      lineIdx: 1,
    },
    readLines: markLines({}, authH2.id, [0, 1, 2, 3]),
    interactions: mergeInteractionMaps(INTERACTIONS_57, {
      [teammateReplyKey(authH2.id)]: [
        {
          id: "te-r1",
          threadKey: teammateReplyKey(authH2.id),
          target: "reply",
          intent: "comment",
          author: "dan",
          authorRole: "user",
          body: "Agreed — SLO gives us headroom here.",
          createdAt: "2026-04-22T10:00:00Z",
        },
      ],
    }),
  },
  fileId: authFile.id,
  hunkId: authH2.id,
  cursorLineIdx: 1,
};

// ── 5. block-selection ─────────────────────────────────────────────────────
// cs-42 storage.ts#h2 — cursor on the try/catch region with shift-extended
// selection covering the full `try { … } catch` block (lines 6..11). Includes
// one block thread on that range to show the Inspector header label.

const blockHunkId = storageH2.id; // "cs-42/src/utils/storage.ts#h2"
const BLOCK_LO = 6;
const BLOCK_HI = 11;
const blockKey = blockCommentKey(blockHunkId, BLOCK_LO, BLOCK_HI, "c1");
const blockSelectionBase = initialState([cs42]);

export const fixtureBlockSelection: ReviewState = {
  ...blockSelectionBase,
  cursor: {
    changesetId: cs42.id,
    fileId: storageFile.id,
    hunkId: blockHunkId,
    lineIdx: BLOCK_HI,
  },
  selection: { hunkId: blockHunkId, anchor: BLOCK_LO, head: BLOCK_HI },
  interactions: mergeInteractionMaps(INTERACTIONS_42, {
    [blockKey]: [
      {
        id: "b-r1",
        threadKey: blockKey,
        target: "block",
        intent: "comment",
        author: "dan",
        authorRole: "user",
        body: "The whole try/catch would be cleaner as a single parse-and-validate helper.",
        createdAt: "2026-04-23T10:00:00Z",
      },
    ],
  }),
};

export const fixtureBlockSelectionGallery: GalleryFixture = {
  kind: "diff",
  name: "block-selection",
  description:
    "Cursor inside storage.ts#h2 with a shift-extended selection across the try/catch; one block comment thread attached.",
  state: fixtureBlockSelection,
  fileId: storageFile.id,
  hunkId: blockHunkId,
  cursorLineIdx: BLOCK_HI,
};

// ── 6. file-reviewed ───────────────────────────────────────────────────────
// All hunks of storage.ts read end-to-end and the file signed off via
// Shift+M. Shows the green path-header badge, the row tint, and the
// soft green wash across the diff body.

const reviewedAllReadLines = (() => {
  let acc: Record<string, Set<number>> = {};
  for (const h of storageFile.hunks) {
    acc = markLines(
      acc,
      h.id,
      Array.from({ length: h.lines.length }, (_, i) => i),
    );
  }
  return acc;
})();

export const fixtureFileReviewed: GalleryFixture = {
  kind: "diff",
  name: "file-reviewed",
  description:
    "storage.ts read in full and signed off via Shift+M — green badge in the path, green check + tint on the sidebar row, soft green wash across the diff.",
  state: {
    ...emptyState,
    cursor: {
      changesetId: cs42.id,
      fileId: storageFile.id,
      hunkId: storageH1.id,
      lineIdx: 0,
    },
    readLines: reviewedAllReadLines,
    reviewedFiles: new Set([storageFile.id]),
    interactions: INTERACTIONS_42,
  },
  fileId: storageFile.id,
  hunkId: storageH1.id,
  cursorLineIdx: 0,
};

// ── 7. agent-flow seeded ──────────────────────────────────────────────────
// Exercises every shape of agent-authored Interaction in one fixture:
//   - a user-authored line comment with an agent reply threaded under it
//   - an agent-started top-level block comment
//   - an out-of-hunk agent comment in state.detachedInteractions
// Cursor lands on the user-comment line so the Inspector opens that
// thread by default.

const CS_91_QUEUE_FILE = CS_91.files[0];
const CS_91_QUEUE_HUNK = CS_91_QUEUE_FILE.hunks[0];

export const fixtureAgentFlowSeeded: GalleryFixture = {
  kind: "diff",
  name: "agent-flow-seeded",
  description:
    "cs-91 with three agent-authored shapes: a reply threaded under a delivered user comment, a top-level agent block comment, and an out-of-hunk agent comment surfaced in the Detached group.",
  state: {
    ...initialState([CS_91]),
    cursor: {
      changesetId: CS_91.id,
      fileId: CS_91_QUEUE_FILE.id,
      hunkId: CS_91_QUEUE_HUNK.id,
      lineIdx: 6,
    },
    interactions: CS_91_INTERACTIONS,
    detachedInteractions: CS_91_DETACHED,
  },
  fileId: CS_91_QUEUE_FILE.id,
  hunkId: CS_91_QUEUE_HUNK.id,
  cursorLineIdx: 6,
};

// ── 8. plan (rule-based) ───────────────────────────────────────────────────
// The "where to begin" screen for cs-42, computed deterministically from the
// parsed ChangeSet (no AI). Shows the intent/map/entry-points layout with
// every claim citing a source.

export const fixturePlanRule: PlanGalleryFixture = {
  kind: "plan",
  name: "plan-rule",
  description:
    "Review plan for cs-42 using rule-based intent (no AI); claims cite description, symbols, or files.",
  plan: planReview(cs42),
};

// ── export all ─────────────────────────────────────────────────────────────

export const ALL_FIXTURES: GalleryFixture[] = [
  {
    kind: "syntax",
    name: "syntax-highlighting",
    description:
      "Shiki-based code rendering previewed in explicit light and dark surfaces.",
    snippets: [
      {
        title: "TypeScript",
        language: "ts",
        code:
          "export function clamp(value: number, min: number, max: number) {\n  return Math.min(max, Math.max(min, value));\n}",
      },
      {
        title: "JavaScript",
        language: "js",
        code:
          "const submit = async (payload) => {\n  const res = await fetch('/api/review', {\n    method: 'POST',\n    body: JSON.stringify(payload),\n  });\n  return res.json();\n};",
      },
      {
        title: "PHP",
        language: "php",
        code:
          "<?php\nfunction load_prefs(array $defaults, array $input): array {\n    return [\n        'theme' => $input['theme'] ?? $defaults['theme'],\n        'density' => $input['density'] ?? $defaults['density'],\n    ];\n}\n",
      },
      {
        title: "Diff",
        language: "diff",
        code:
          "@@ -12,7 +12,8 @@\n-const prefs = loadPrefs();\n+const raw = loadPrefs();\n+const prefs = sanitizePrefs(raw);\n renderPanel(prefs);\n",
      },
    ],
  },
  fixturePlanRule,
  fixtureEmpty,
  fixtureMidReview,
  fixtureFileReviewed,
  fixtureBlockSelectionGallery,
  fixtureAiSaturated,
  fixtureTeammateEndorsed,
  fixtureAgentFlowSeeded,
];
