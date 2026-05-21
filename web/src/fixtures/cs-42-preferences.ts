import type { ChangeSet, Interaction } from "../types";
import {
  hunkSummaryReplyKey,
  lineNoteReplyKey,
  teammateReplyKey,
  userCommentKey,
} from "../types";

export const CS_42: ChangeSet = {
  id: "cs-42",
  title: "Add user preferences panel",
  author: "romina",
  branch: "feat/user-preferences",
  base: "main",
  createdAt: "2026-04-21T14:22:00Z",
  description:
    "Adds a preferences panel backed by localStorage. New loadPrefs/savePrefs helpers live in utils/storage.",
  files: [
    {
      id: "cs-42/src/types/user.ts",
      path: "src/types/user.ts",
      language: "ts",
      status: "modified",
      hunks: [
        {
          id: "cs-42/src/types/user.ts#h1",
          header: "@@ -4,6 +4,14 @@ export interface User",
          oldStart: 4,
          oldCount: 6,
          newStart: 4,
          newCount: 14,
          definesSymbols: ["Preferences"],
          expandAbove: [
            // nearest: blank separator above User interface
            [{ kind: "context", text: "", oldNo: 3, newNo: 3 }],
            // next: imports at the top of the file
            [
              { kind: "context", text: "// shared user-facing types", oldNo: 1, newNo: 1 },
              { kind: "context", text: "import type { Locale } from \"../i18n\";", oldNo: 2, newNo: 2 },
            ],
          ],
          expandBelow: [
            // nearest: blank + first declaration below Preferences
            [
              { kind: "context", text: "", oldNo: 11, newNo: 16 },
              { kind: "context", text: "export type UserId = User[\"id\"];", oldNo: 12, newNo: 17 },
            ],
            // further: second declaration
            [{ kind: "context", text: "export type LocaleCode = Locale[\"code\"];", oldNo: 13, newNo: 18 }],
          ],
          lines: [
            { kind: "context", text: "export interface User {", oldNo: 4, newNo: 4 },
            { kind: "context", text: "  id: string;", oldNo: 5, newNo: 5 },
            { kind: "context", text: "  email: string;", oldNo: 6, newNo: 6 },
            { kind: "context", text: "  name: string;", oldNo: 7, newNo: 7 },
            { kind: "add", text: "  preferences?: Preferences;", newNo: 8 },
            { kind: "context", text: "}", oldNo: 8, newNo: 9 },
            { kind: "context", text: "", oldNo: 9, newNo: 10 },
            { kind: "add", text: "export interface Preferences {" , newNo: 11 },
            { kind: "add", text: "  theme: \"light\" | \"dark\" | \"system\";", newNo: 12 },
            { kind: "add", text: "  compactMode: boolean;", newNo: 13 },
            { kind: "add", text: "  notifyOnMention: boolean;", newNo: 14 },
            { kind: "add", text: "}", newNo: 15 },
          ],
        },
      ],
      fullContent: [
        { kind: "context", text: "// shared user-facing types", newNo: 1 },
        { kind: "context", text: "import type { Locale } from \"../i18n\";", newNo: 2 },
        { kind: "context", text: "", newNo: 3 },
        { kind: "context", text: "export interface User {", newNo: 4 },
        { kind: "context", text: "  id: string;", newNo: 5 },
        { kind: "context", text: "  email: string;", newNo: 6 },
        { kind: "context", text: "  name: string;", newNo: 7 },
        { kind: "add", text: "  preferences?: Preferences;", newNo: 8 },
        { kind: "context", text: "}", newNo: 9 },
        { kind: "context", text: "", newNo: 10 },
        { kind: "add", text: "export interface Preferences {", newNo: 11 },
        { kind: "add", text: "  theme: \"light\" | \"dark\" | \"system\";", newNo: 12 },
        { kind: "add", text: "  compactMode: boolean;", newNo: 13 },
        { kind: "add", text: "  notifyOnMention: boolean;", newNo: 14 },
        { kind: "add", text: "}", newNo: 15 },
        { kind: "context", text: "", newNo: 16 },
        { kind: "context", text: "export type UserId = User[\"id\"];", newNo: 17 },
        { kind: "context", text: "export type LocaleCode = Locale[\"code\"];", newNo: 18 },
      ],
    },
    {
      id: "cs-42/src/utils/storage.ts",
      path: "src/utils/storage.ts",
      language: "ts",
      status: "modified",
      hunks: [
        {
          id: "cs-42/src/utils/storage.ts#h1",
          header: "@@ -1,3 +1,5 @@",
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 5,
          lines: [
            { kind: "context", text: "import type { User } from \"../types/user\";", oldNo: 1, newNo: 1 },
            { kind: "add", text: "import type { Preferences } from \"../types/user\";", newNo: 2 },
            { kind: "context", text: "", oldNo: 2, newNo: 3 },
            { kind: "context", text: "const USER_KEY = \"shippable:user\";", oldNo: 3, newNo: 4 },
            { kind: "add", text: "const PREFS_KEY = \"shippable:prefs\";", newNo: 5 },
          ],
        },
        {
          id: "cs-42/src/utils/storage.ts#h2",
          header: "@@ -20,4 +22,24 @@ export function saveUser",
          oldStart: 20,
          oldCount: 4,
          newStart: 22,
          newCount: 24,
          definesSymbols: ["loadPrefs", "savePrefs"],
          aiReviewed: true,
          expandAbove: [
            // block 1 (nearest): remaining body of saveUser above the hunk
            [{ kind: "context", text: "  u = normalize(u);", oldNo: 19, newNo: 21 }],
            // block 2: saveUser's signature + its leading comment
            [
              { kind: "context", text: "// called on every auth transition", oldNo: 17, newNo: 19 },
              { kind: "context", text: "export function saveUser(u: User): void {", oldNo: 18, newNo: 20 },
            ],
            // block 3: file-top constants and imports
            [
              { kind: "context", text: "import type { User } from \"../types/user\";", oldNo: 1, newNo: 1 },
              { kind: "context", text: "", oldNo: 2, newNo: 3 },
              { kind: "context", text: "const USER_KEY = \"shippable:user\";", oldNo: 3, newNo: 4 },
              { kind: "context", text: "", oldNo: 4, newNo: 6 },
            ],
          ],
          expandBelow: [
            [{ kind: "context", text: "", oldNo: 24, newNo: 39 }],
            [{ kind: "context", text: "// EOF", oldNo: 25, newNo: 40 }],
          ],
          lines: [
            { kind: "context", text: "  localStorage.setItem(USER_KEY, JSON.stringify(u));", oldNo: 20, newNo: 22 },
            { kind: "context", text: "}", oldNo: 21, newNo: 23 },
            { kind: "context", text: "", oldNo: 22, newNo: 24 },
            { kind: "add", text: "export function loadPrefs(): Preferences | null {", newNo: 25 },
            { kind: "add", text: "  const raw = localStorage.getItem(PREFS_KEY);", newNo: 26 },
            { kind: "add", text: "  if (!raw) return null;", newNo: 27 },
            { kind: "add", text: "  try {", newNo: 28 },
            { kind: "add", text: "    return JSON.parse(raw) as Preferences;", newNo: 29 },
            { kind: "add", text: "  } catch {", newNo: 30 },
            { kind: "add", text: "    return null;", newNo: 31 },
            { kind: "add", text: "  }", newNo: 32 },
            { kind: "add", text: "}", newNo: 33 },
            { kind: "add", text: "", newNo: 34 },
            { kind: "add", text: "export function savePrefs(p: Preferences): void {", newNo: 35 },
            { kind: "add", text: "  localStorage.setItem(PREFS_KEY, JSON.stringify(p));", newNo: 36 },
            { kind: "add", text: "}", newNo: 37 },
            { kind: "context", text: "", oldNo: 23, newNo: 38 },
          ],
        },
      ],
    },
    {
      id: "cs-42/src/components/PreferencesPanel.tsx",
      path: "src/components/PreferencesPanel.tsx",
      language: "tsx",
      status: "added",
      hunks: [
        {
          id: "cs-42/src/components/PreferencesPanel.tsx#h1",
          header: "@@ -0,0 +1,36 @@",
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 36,
          referencesSymbols: ["loadPrefs", "savePrefs"],
          lines: [
            { kind: "add", text: "import { useEffect, useState } from \"react\";", newNo: 1 },
            { kind: "add", text: "import { loadPrefs, savePrefs } from \"../utils/storage\";", newNo: 2 },
            { kind: "add", text: "import type { Preferences } from \"../types/user\";", newNo: 3 },
            { kind: "add", text: "", newNo: 4 },
            { kind: "add", text: "const DEFAULTS: Preferences = {", newNo: 5 },
            { kind: "add", text: "  theme: \"system\",", newNo: 6 },
            { kind: "add", text: "  compactMode: false,", newNo: 7 },
            { kind: "add", text: "  notifyOnMention: true,", newNo: 8 },
            { kind: "add", text: "};", newNo: 9 },
            { kind: "add", text: "", newNo: 10 },
            { kind: "add", text: "export function PreferencesPanel() {", newNo: 11 },
            { kind: "add", text: "  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);", newNo: 12 },
            { kind: "add", text: "", newNo: 13 },
            { kind: "add", text: "  useEffect(() => {", newNo: 14 },
            { kind: "add", text: "    const stored = loadPrefs();", newNo: 15 },
            { kind: "add", text: "    if (stored) setPrefs(stored);", newNo: 16 },
            { kind: "add", text: "  }, []);", newNo: 17 },
            { kind: "add", text: "", newNo: 18 },
            { kind: "add", text: "  function update<K extends keyof Preferences>(k: K, v: Preferences[K]) {", newNo: 19 },
            { kind: "add", text: "    const next = { ...prefs, [k]: v };", newNo: 20 },
            { kind: "add", text: "    setPrefs(next);", newNo: 21 },
            { kind: "add", text: "    savePrefs(next);", newNo: 22 },
            { kind: "add", text: "  }", newNo: 23 },
            { kind: "add", text: "", newNo: 24 },
            { kind: "add", text: "  return (", newNo: 25 },
            { kind: "add", text: "    <form aria-label=\"Preferences\">", newNo: 26 },
            { kind: "add", text: "      <label>Theme", newNo: 27 },
            { kind: "add", text: "        <select value={prefs.theme} onChange={e => update(\"theme\", e.target.value as Preferences[\"theme\"])}>", newNo: 28 },
            { kind: "add", text: "          <option value=\"system\">System</option>", newNo: 29 },
            { kind: "add", text: "          <option value=\"light\">Light</option>", newNo: 30 },
            { kind: "add", text: "          <option value=\"dark\">Dark</option>", newNo: 31 },
            { kind: "add", text: "        </select>", newNo: 32 },
            { kind: "add", text: "      </label>", newNo: 33 },
            { kind: "add", text: "    </form>", newNo: 34 },
            { kind: "add", text: "  );", newNo: 35 },
            { kind: "add", text: "}", newNo: 36 },
          ],
        },
      ],
    },
    {
      id: "cs-42/src/components/__tests__/PreferencesPanel.test.tsx",
      path: "src/components/__tests__/PreferencesPanel.test.tsx",
      language: "tsx",
      status: "added",
      hunks: [
        {
          id: "cs-42/src/components/__tests__/PreferencesPanel.test.tsx#h1",
          header: "@@ -0,0 +1,18 @@",
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 18,
          aiReviewed: true,
          lines: [
            { kind: "add", text: "import { render, screen } from \"@testing-library/react\";", newNo: 1 },
            { kind: "add", text: "import { PreferencesPanel } from \"../PreferencesPanel\";", newNo: 2 },
            { kind: "add", text: "", newNo: 3 },
            { kind: "add", text: "describe(\"PreferencesPanel\", () => {", newNo: 4 },
            { kind: "add", text: "  beforeEach(() => localStorage.clear());", newNo: 5 },
            { kind: "add", text: "", newNo: 6 },
            { kind: "add", text: "  it(\"renders with defaults when nothing stored\", () => {", newNo: 7 },
            { kind: "add", text: "    render(<PreferencesPanel />);", newNo: 8 },
            { kind: "add", text: "    expect(screen.getByLabelText(\"Theme\")).toHaveValue(\"system\");", newNo: 9 },
            { kind: "add", text: "  });", newNo: 10 },
            { kind: "add", text: "", newNo: 11 },
            { kind: "add", text: "  it(\"persists changes via savePrefs\", async () => {", newNo: 12 },
            { kind: "add", text: "    render(<PreferencesPanel />);", newNo: 13 },
            { kind: "add", text: "    // …", newNo: 14 },
            { kind: "add", text: "  });", newNo: 15 },
            { kind: "add", text: "});", newNo: 16 },
            { kind: "add", text: "", newNo: 17 },
            { kind: "add", text: "// TODO: add a test for dark-mode toggle", newNo: 18 },
          ],
        },
      ],
    },
  ],
};

const STORAGE_H2 = "cs-42/src/utils/storage.ts#h2";
const PANEL_H1 = "cs-42/src/components/PreferencesPanel.tsx#h1";
const TEST_H1 = "cs-42/src/components/__tests__/PreferencesPanel.test.tsx#h1";
const INGEST_TS = "0001-01-01T00:00:00.000Z";

export const INTERACTIONS_42: Record<string, Interaction[]> = {
  [hunkSummaryReplyKey(STORAGE_H2)]: [
    {
      id: `ai:${hunkSummaryReplyKey(STORAGE_H2)}`,
      threadKey: hunkSummaryReplyKey(STORAGE_H2),
      target: "block",
      intent: "comment",
      author: "ai",
      authorRole: "ai",
      body:
        "Straightforward localStorage wrapper. Two worth-a-look items: the try/catch in loadPrefs swallows parse errors silently, and savePrefs has no quota-exceeded handling.",
      createdAt: INGEST_TS,
    },
  ],
  [lineNoteReplyKey(STORAGE_H2, 6)]: [
    {
      id: `ai:${lineNoteReplyKey(STORAGE_H2, 6)}`,
      threadKey: lineNoteReplyKey(STORAGE_H2, 6),
      target: "line",
      intent: "request",
      author: "ai",
      authorRole: "ai",
      body:
        "Silent swallow on parse failure\n\nIf the stored JSON is corrupt, loadPrefs returns null and the app silently resets to defaults — the user loses their settings with no warning. Consider logging, or clearing the corrupted key so a subsequent load doesn't retry parsing the same garbage.",
      createdAt: INGEST_TS,
    },
    {
      id: "r1",
      threadKey: lineNoteReplyKey(STORAGE_H2, 6),
      target: "reply",
      intent: "comment",
      author: "dan",
      authorRole: "user",
      body:
        "Agree. Clearing the key on parse failure is probably safer — a stale v1 blob would otherwise keep re-crashing every mount.",
      createdAt: "2026-04-22T10:14:00Z",
    },
  ],
  [lineNoteReplyKey(STORAGE_H2, 8)]: [
    {
      id: `ai:${lineNoteReplyKey(STORAGE_H2, 8)}`,
      threadKey: lineNoteReplyKey(STORAGE_H2, 8),
      target: "line",
      intent: "question",
      author: "ai",
      authorRole: "ai",
      body:
        "Cast is unchecked\n\n`as Preferences` trusts whatever was in storage. A stale older-schema value will type-check at parse but blow up when a new field is read. If schema changes, consider a validator (zod / manual shape check).",
      createdAt: INGEST_TS,
    },
  ],
  [lineNoteReplyKey(STORAGE_H2, 14)]: [
    {
      id: `ai:${lineNoteReplyKey(STORAGE_H2, 14)}`,
      threadKey: lineNoteReplyKey(STORAGE_H2, 14),
      target: "line",
      intent: "request",
      author: "ai",
      authorRole: "ai",
      body:
        "No quota-exceeded handling\n\nlocalStorage.setItem throws DOMException('QuotaExceededError') on some browsers/private modes. This will bubble up through the React handler and likely crash the form. Wrap in try/catch or feature-detect.",
      createdAt: INGEST_TS,
    },
  ],
  [hunkSummaryReplyKey(PANEL_H1)]: [
    {
      id: `ai:${hunkSummaryReplyKey(PANEL_H1)}`,
      threadKey: hunkSummaryReplyKey(PANEL_H1),
      target: "block",
      intent: "comment",
      author: "ai",
      authorRole: "ai",
      body:
        "Small component, reasonable shape. Two gaps worth flagging: only `theme` is actually rendered (compactMode / notifyOnMention are declared but never surfaced), and `update` writes synchronously on every keystroke.",
      createdAt: INGEST_TS,
    },
  ],
  [teammateReplyKey(PANEL_H1)]: [
    {
      id: `teammate:${teammateReplyKey(PANEL_H1)}`,
      threadKey: teammateReplyKey(PANEL_H1),
      target: "block",
      intent: "comment",
      author: "dan",
      authorRole: "user",
      body: "a11y labels on the toggles look good to me",
      createdAt: INGEST_TS,
    },
    {
      id: "r2",
      threadKey: teammateReplyKey(PANEL_H1),
      target: "reply",
      intent: "comment",
      author: "romina",
      authorRole: "user",
      body: "Thanks for checking! Still need to wire the other two fields, noted.",
      createdAt: "2026-04-22T10:30:00Z",
    },
  ],
  // Two reviewer-started threads on the same line (compactMode: false). Each is
  // its own thread — distinct ids keep them as separate cards, and c1's reply
  // nests under c1, not after c2.
  [userCommentKey(PANEL_H1, 7, "c1")]: [
    {
      id: "u1",
      threadKey: userCommentKey(PANEL_H1, 7, "c1"),
      target: "line",
      intent: "comment",
      author: "dan",
      authorRole: "user",
      body: "Is `false` really the right default here? Some teams expect compact mode on by default.",
      createdAt: "2026-04-22T11:05:00Z",
    },
    {
      id: "u2",
      threadKey: userCommentKey(PANEL_H1, 7, "c1"),
      target: "reply",
      intent: "comment",
      author: "romina",
      authorRole: "user",
      body: "Fair — happy to flip it. @product said either way is fine.",
      createdAt: "2026-04-22T11:20:00Z",
    },
  ],
  [userCommentKey(PANEL_H1, 7, "c2")]: [
    {
      id: "u3",
      threadKey: userCommentKey(PANEL_H1, 7, "c2"),
      target: "line",
      intent: "comment",
      author: "dan",
      authorRole: "user",
      body: "Worth a code comment on why compact mode is opt-in.",
      createdAt: "2026-04-22T11:25:00Z",
    },
  ],
  [lineNoteReplyKey(PANEL_H1, 14)]: [
    {
      id: `ai:${lineNoteReplyKey(PANEL_H1, 14)}`,
      threadKey: lineNoteReplyKey(PANEL_H1, 14),
      target: "line",
      intent: "comment",
      author: "ai",
      authorRole: "ai",
      body:
        "Reads from storage on mount\n\nCall site for loadPrefs. If you haven't already, review the definition in src/utils/storage.ts — its parse error handling is the main thing that governs what you get back here.",
      createdAt: INGEST_TS,
    },
  ],
  [lineNoteReplyKey(PANEL_H1, 21)]: [
    {
      id: `ai:${lineNoteReplyKey(PANEL_H1, 21)}`,
      threadKey: lineNoteReplyKey(PANEL_H1, 21),
      target: "line",
      intent: "question",
      author: "ai",
      authorRole: "ai",
      body:
        "Synchronous write on every keystroke\n\nFor the current fields (select + booleans) this is fine — one write per user action. If text inputs are added later, you'll want to debounce. Not blocking for this PR.",
      createdAt: INGEST_TS,
    },
  ],
  [lineNoteReplyKey(PANEL_H1, 26)]: [
    {
      id: `ai:${lineNoteReplyKey(PANEL_H1, 26)}`,
      threadKey: lineNoteReplyKey(PANEL_H1, 26),
      target: "line",
      intent: "request",
      author: "ai",
      authorRole: "ai",
      body:
        "Only `theme` is rendered\n\nDEFAULTS declares `compactMode` and `notifyOnMention`, but the returned JSX only exposes the theme selector. Either add controls for the other two or trim DEFAULTS to match what's shipped.",
      createdAt: INGEST_TS,
    },
  ],
  [lineNoteReplyKey(TEST_H1, 17)]: [
    {
      id: `ai:${lineNoteReplyKey(TEST_H1, 17)}`,
      threadKey: lineNoteReplyKey(TEST_H1, 17),
      target: "line",
      intent: "question",
      author: "ai",
      authorRole: "ai",
      body:
        "Unaddressed TODO in a test file\n\nTracking TODOs in tests tends to rot. If this is acceptable to merge, consider filing an issue with the TODO number instead.",
      createdAt: INGEST_TS,
    },
  ],
};

