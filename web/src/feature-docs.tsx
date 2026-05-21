// Entry-point file — bootstraps the docs page via createRoot below. Fast
// refresh isn't meaningful here, so colocate the inline frame components.
/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client";
import "./index.css";
import "./App.css";
import "./feature-docs.css";
import { CS_42, INTERACTIONS_42 } from "./fixtures/cs-42-preferences";
import {
  changesetCoverage,
  initialState,
  reviewedFilesCount,
  selectAckedNotes,
} from "./state";
import { planReview } from "./plan";
import { maybeSuggest } from "./guide";
import { applyThemeToRoot, getStoredThemeId } from "./tokens";
import { buildSymbolIndex } from "./symbols";
import {
  buildAutoFillContext,
  type PromptDraft,
} from "./promptStore";
import {
  buildDiffViewModel,
  buildGuidePromptViewModel,
  buildInspectorViewModel,
  buildSidebarViewModel,
  buildStatusBarViewModel,
} from "./view";
import { selectIngestSignals } from "./interactions";
import {
  fixtureAiSaturated,
  fixtureFileReviewed,
  fixtureMidReview,
  fixtureBlockSelection,
  type GalleryFixture,
} from "./gallery-fixtures";
import type { ReviewState } from "./types";
import { Sidebar } from "./components/Sidebar";
import { DiffView } from "./components/DiffView";
import { Inspector } from "./components/Inspector";
import { StatusBar } from "./components/StatusBar";
import { GuidePrompt } from "./components/GuidePrompt";
import { HelpOverlay } from "./components/HelpOverlay";
import { LoadModal } from "./components/LoadModal";
import { ThemePicker } from "./components/ThemePicker";
import { SyntaxShowcase } from "./components/SyntaxShowcase";
import { CodeRunner } from "./components/CodeRunner";
import { CredentialsPanel } from "./components/CredentialsPanel";
import { CredentialsProvider } from "./auth/useCredentials";
import { PromptPicker } from "./components/PromptPicker";
import { PromptEditor } from "./components/PromptEditor";
import {
  PromptRunsPanel,
  type PromptRunView,
} from "./components/PromptRunsPanel";
import { ReviewPlanView } from "./components/ReviewPlanView";

type View =
  | "key-setup"
  | "key-setup-saved"
  | "prompt-picker"
  | "prompt-editor"
  | "prompt-results"
  | "plan-idle"
  | "plan-fallback"
  | "workspace-mid-review"
  | "workspace-file-reviewed"
  | "workspace-context-expand"
  | "workspace-full-file"
  | "workspace-ai-saturated"
  | "workspace-block-comment"
  | "workspace-guide"
  | "workspace-help"
  | "workspace-load"
  | "runner-inline"
  | "runner-free"
  | "themes";

const CS = CS_42;
const USER_FILE = CS.files[0];
const STORAGE_FILE = CS.files[1];
const PREF_FILE = CS.files[2];
const USER_HUNK = USER_FILE.hunks[0];
const PREF_HUNK = PREF_FILE.hunks[0];

const PROMPTS = [
  {
    id: "security-review",
    name: "Security review",
    description: "Look for auth, input validation, and data handling risks.",
    args: [
      { name: "selection", required: true, auto: "selection" },
      { name: "file", required: false, auto: "file" },
    ],
    body:
      "Review this code for security issues.\n\n{{selection}}\n{{#file}}File: {{file}}{{/file}}",
  },
  {
    id: "summarise-pr",
    name: "Summarise for PR",
    description: "Turn the current change into a reviewer-facing summary.",
    args: [{ name: "changeset", required: true, auto: "changeset.diff" }],
    body: "Summarise this diff for a PR description:\n\n{{changeset}}",
  },
];

const USER_PROMPT: PromptDraft = {
  id: "business-risk-pass",
  name: "Business risk pass",
  description: "Call out rollout risk, support risk, and migration risk.",
  args: [
    { name: "selection", required: true, auto: "selection" },
    { name: "title", required: false, auto: "changeset.title" },
  ],
  body:
    "Change: {{title}}\n\nAssess business risk in this selection:\n{{selection}}",
};

const RUNS: PromptRunView[] = [
  {
    id: "run-1",
    promptName: "Security review",
    status: "done",
    text:
      "The new persistence layer trusts parsed JSON without schema validation. If malformed local state is realistic, sanitize before applying it.",
  },
  {
    id: "run-2",
    promptName: "Summarise for PR",
    status: "streaming",
    text:
      "Adds a preferences panel, persists theme and compact-mode choices, and wires the UI into the existing review workspace.",
  },
];

const THEME_SNIPPETS = [
  {
    title: "TypeScript",
    language: "ts",
    code:
      "export function savePrefs(prefs: Preferences): void {\n  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));\n}",
  },
  {
    title: "Diff",
    language: "diff",
    code:
      "@@ -20,4 +22,24 @@ export function saveUser\n+export function loadPrefs(): Preferences | null {\n+  const raw = localStorage.getItem(PREFS_KEY);\n+}\n",
  },
];

const INLINE_RUN_SOURCE =
  "function clamp(value, min, max) {\n" +
  "  return Math.min(max, Math.max(min, value));\n" +
  "}\n" +
  "clamp(42, 0, 10);\n";

function expectDiffFixture(fixture: GalleryFixture) {
  if (fixture.kind !== "diff") {
    throw new Error(`Expected diff fixture, got ${fixture.kind}`);
  }
  return fixture;
}

const MID_REVIEW = expectDiffFixture(fixtureMidReview);
const FILE_REVIEWED = expectDiffFixture(fixtureFileReviewed);
const AI_SATURATED = expectDiffFixture(fixtureAiSaturated);

function installPromptMocks() {
  const win = window as Window & {
    __featureDocsPromptMocks?: boolean;
  };
  if (win.__featureDocsPromptMocks) return;
  win.__featureDocsPromptMocks = true;
  localStorage.setItem("shippable.prompts.user", JSON.stringify([USER_PROMPT]));
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/library/prompts")) {
      return new Response(JSON.stringify({ prompts: PROMPTS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

function currentView(): View {
  const raw = new URLSearchParams(window.location.search).get("view");
  switch (raw) {
    case "key-setup":
    case "key-setup-saved":
    case "prompt-picker":
    case "prompt-editor":
    case "prompt-results":
    case "plan-idle":
    case "plan-fallback":
    case "workspace-mid-review":
    case "workspace-file-reviewed":
    case "workspace-context-expand":
    case "workspace-full-file":
    case "workspace-ai-saturated":
    case "workspace-block-comment":
    case "workspace-guide":
    case "workspace-help":
    case "workspace-load":
    case "runner-inline":
    case "runner-free":
    case "themes":
      return raw;
    default:
      return "workspace-mid-review";
  }
}

function topbarThemeId() {
  return getStoredThemeId();
}

function makeContextExpandedState(): ReviewState {
  return {
    ...initialState([CS], INTERACTIONS_42),
    cursor: {
      changesetId: CS.id,
      fileId: USER_FILE.id,
      hunkId: USER_HUNK.id,
      lineIdx: 7,
    },
    expandLevelAbove: { [USER_HUNK.id]: 2 },
    expandLevelBelow: { [USER_HUNK.id]: 2 },
  };
}

function makeFullFileState(): ReviewState {
  return {
    ...initialState([CS], INTERACTIONS_42),
    cursor: {
      changesetId: CS.id,
      fileId: USER_FILE.id,
      hunkId: USER_HUNK.id,
      lineIdx: 0,
    },
    fullExpandedFiles: new Set([USER_FILE.id]),
  };
}

function makeGuideState(): ReviewState {
  return {
    ...initialState([CS], INTERACTIONS_42),
    cursor: {
      changesetId: CS.id,
      fileId: PREF_FILE.id,
      hunkId: PREF_HUNK.id,
      lineIdx: 1,
    },
  };
}

function selectionForStatusBar(
  hunk: { id: string; lines: { oldNo?: number; newNo?: number }[] },
  selection: { hunkId: string; anchor: number; head: number } | null,
) {
  if (!selection || selection.hunkId !== hunk.id) return null;
  const lo = Math.min(selection.anchor, selection.head);
  const hi = Math.max(selection.anchor, selection.head);
  const lineNoAt = (idx: number) =>
    hunk.lines[idx].newNo ?? hunk.lines[idx].oldNo ?? idx + 1;
  return {
    lo,
    hi,
    loLineNo: lineNoAt(lo),
    hiLineNo: lineNoAt(hi),
  };
}

function WorkspaceFrame({
  state,
  showInspector = true,
  showGuide = false,
  showHelp = false,
  showLoad = false,
}: {
  state: ReviewState;
  showInspector?: boolean;
  showGuide?: boolean;
  showHelp?: boolean;
  showLoad?: boolean;
}) {
  const cs = state.changesets.find((item) => item.id === state.cursor.changesetId)!;
  const file = cs.files.find((item) => item.id === state.cursor.fileId)!;
  const hunk = file.hunks.find((item) => item.id === state.cursor.hunkId)!;
  const line = hunk.lines[state.cursor.lineIdx];
  const ingestSignals = selectIngestSignals(state);
  const featureLineHasAiNote =
    !!ingestSignals.aiNoteByLine[
      `${state.cursor.hunkId}:${state.cursor.lineIdx}`
    ];
  const symbolIndex = buildSymbolIndex(cs);
  const suggestion = showGuide ? maybeSuggest(cs, state) : null;
  const guideViewModel = suggestion
    ? buildGuidePromptViewModel(suggestion, symbolIndex, cs.id)
    : null;
  const readCoverage = changesetCoverage(cs, state.readLines);
  const reviewedFiles = reviewedFilesCount(cs, state.reviewedFiles);
  const fileIdx = cs.files.findIndex((item) => item.id === file.id);
  const hunkIdx = file.hunks.findIndex((item) => item.id === hunk.id);

  return (
    <div className="feature-docs__workspace">
      <div className="app">
        <header className="topbar">
          <span className="topbar__brand">shippable</span>
          <span className="topbar__sep">|</span>
          <span className="topbar__id">{cs.id}</span>
          <span className="topbar__title">{cs.title}</span>
          <button className="topbar__btn topbar__btn--plan topbar__btn--on">
            plan
          </button>
          <span className="topbar__sep">|</span>
          <span className="topbar__branch">
            {cs.branch} -&gt; {cs.base}
          </span>
          <span className="topbar__spacer" />
          <span className="topbar__author">@{cs.author}</span>
          <ThemePicker value={topbarThemeId()} onChange={() => {}} />
          <button className="topbar__btn">run</button>
          <button className="topbar__btn">load</button>
        </header>
        <div className={`main ${showInspector ? "main--with-inspector" : ""}`}>
          <Sidebar
            viewModel={buildSidebarViewModel({
              files: cs.files,
              currentFileId: state.cursor.fileId,
              changesetId: cs.id,
              readLines: state.readLines,
              reviewedFiles: state.reviewedFiles,
              quiz: state.quiz,
              interactions: state.interactions,
            })}
            onPickFile={() => {}}
            onJumpToFirstComment={() => {}}
            runs={[]}
            onCloseRun={() => {}}
            wide={false}
            onToggleWide={() => {}}
          />
          <DiffView
            viewModel={buildDiffViewModel({
              file,
              currentHunkId: hunk.id,
              cursorLineIdx: state.cursor.lineIdx,
              read: state.readLines,
              isFileReviewed: state.reviewedFiles.has(file.id),
              acked: selectAckedNotes(state),
              replies: state.interactions,
              expandLevelAbove: state.expandLevelAbove,
              expandLevelBelow: state.expandLevelBelow,
              fileFullyExpanded: state.fullExpandedFiles.has(file.id),
              filePreviewing: state.previewedFiles.has(file.id),
              selection: state.selection,
              signals: ingestSignals,
            })}
            onSetExpandLevel={() => {}}
            onToggleExpandFile={() => {}}
            onTogglePreviewFile={() => {}}
          />
          {showInspector && (
            <Inspector
              viewModel={buildInspectorViewModel({
                file,
                hunk,
                line,
                cursor: state.cursor,
                symbols: symbolIndex,
                acked: selectAckedNotes(state),
                replies: state.interactions,
                draftingKey: null,
                signals: ingestSignals,
              })}
              commentCount={0}
              onPrevComment={() => {}}
              onNextComment={() => {}}
              lineHasAiNote={featureLineHasAiNote}
              symbols={symbolIndex}
              draftBodies={{}}
              onJump={() => {}}
              onJumpToBlock={() => {}}
              onToggleAck={() => {}}
              onStartDraft={() => {}}
              onStartNewComment={() => {}}
              onCloseDraft={() => {}}
              onChangeDraft={() => {}}
              onSubmitReply={() => {}}
              onDeleteReply={() => {}}
              onRetryReply={() => {}}
              onVerifyAiNote={() => {}}
              interactionsShownInline={false}
            />
          )}
        </div>
        {guideViewModel && (
          <GuidePrompt viewModel={guideViewModel} onJump={() => {}} />
        )}
        {showHelp && <HelpOverlay onClose={() => {}} />}
        {showLoad && <LoadModal onLoad={() => {}} onClose={() => {}} />}
        <StatusBar
          viewModel={buildStatusBarViewModel({
            totalFiles: cs.files.length,
            fileIdx,
            totalHunks: file.hunks.length,
            hunkIdx,
            totalLines: hunk.lines.length,
            lineIdx: state.cursor.lineIdx,
            readCoverage,
            reviewedFiles,
            selection: selectionForStatusBar(hunk, state.selection),
            // Docs surface stays on the default hint — context-aware variants
            // are exercised in the live app.
            lineHasAiNote: false,
            lineNoteAcked: false,
            currentFileReadFraction: 0,
            currentFileReviewed: false,
            currentChangesetSignedOff: null,
          })}
        />
      </div>
    </div>
  );
}

function RunnerFrame({ free }: { free: boolean }) {
  return (
    <div className="feature-docs feature-docs--runner">
      <div className="feature-docs__runner-stage">
        <CodeRunner
          currentFilePath={free ? "scratch.ts" : STORAGE_FILE.path}
          freeOpen={free}
          onFreeClose={() => {}}
          runRequest={
            free
              ? null
              : {
                  tick: 1,
                  source: INLINE_RUN_SOURCE,
                }
          }
        />
      </div>
    </div>
  );
}

function ThemeFrame() {
  return (
    <div className="feature-docs">
      <div className="feature-docs__stage">
        <div className="feature-docs__card feature-docs__card--theme">
          <div className="feature-docs__theme-head">
            <span className="topbar__brand">shippable</span>
            <span className="topbar__spacer" />
            <ThemePicker value={topbarThemeId()} onChange={() => {}} />
          </div>
          <SyntaxShowcase snippets={THEME_SNIPPETS} />
        </div>
      </div>
    </div>
  );
}

function App() {
  const view = currentView();
  const context = buildAutoFillContext(CS, PREF_FILE, PREF_HUNK, null);

  if (view === "workspace-mid-review") {
    return <WorkspaceFrame state={MID_REVIEW.state} />;
  }

  if (view === "workspace-file-reviewed") {
    return <WorkspaceFrame state={FILE_REVIEWED.state} />;
  }

  if (view === "workspace-context-expand") {
    return <WorkspaceFrame state={makeContextExpandedState()} showInspector={false} />;
  }

  if (view === "workspace-full-file") {
    return <WorkspaceFrame state={makeFullFileState()} showInspector={false} />;
  }

  if (view === "workspace-ai-saturated") {
    return <WorkspaceFrame state={AI_SATURATED.state} />;
  }

  if (view === "workspace-block-comment") {
    return <WorkspaceFrame state={fixtureBlockSelection} />;
  }

  if (view === "workspace-guide") {
    return <WorkspaceFrame state={makeGuideState()} showGuide />;
  }

  if (view === "workspace-help") {
    return <WorkspaceFrame state={MID_REVIEW.state} showHelp />;
  }

  if (view === "workspace-load") {
    return <WorkspaceFrame state={MID_REVIEW.state} showLoad />;
  }

  if (view === "runner-inline") {
    return <RunnerFrame free={false} />;
  }

  if (view === "runner-free") {
    return <RunnerFrame free />;
  }

  if (view === "themes") {
    return <ThemeFrame />;
  }

  if (view === "prompt-picker") {
    installPromptMocks();
    return (
      <div className="feature-docs">
        <div className="feature-docs__stage">
          <PromptPicker
            context={context}
            onClose={() => {}}
            onSubmit={() => {}}
          />
        </div>
      </div>
    );
  }

  if (view === "prompt-editor") {
    return (
      <div className="feature-docs">
        <div className="feature-docs__caption">
          User-prompt editing rendered against the current diff context.
        </div>
        <div className="feature-docs__stage">
          <div className="feature-docs__card">
            <PromptEditor
              initial={{ ...USER_PROMPT, source: "user" }}
              context={context}
              onSaved={() => {}}
              onCancel={() => {}}
              onDeleted={() => {}}
            />
          </div>
        </div>
      </div>
    );
  }

  if (view === "prompt-results") {
    return (
      <div className="feature-docs">
        <div className="feature-docs__stage feature-docs__results">
          <aside className="sidebar feature-docs__results-sidebar">
            <PromptRunsPanel
              runs={RUNS}
              onClose={() => {}}
              wide={false}
              onToggleWide={() => {}}
              initialExpandedIds={["run-2"]}
            />
          </aside>
        </div>
      </div>
    );
  }

  if (view === "key-setup" || view === "key-setup-saved") {
    return (
      <div className="feature-docs">
        <div className="feature-docs__stage">
          <CredentialsProvider>
            <CredentialsPanel mode="boot" />
          </CredentialsProvider>
        </div>
      </div>
    );
  }

  const plan = planReview(CS);
  return (
    <div className="feature-docs">
      <div className="feature-docs__stage">
        <div className="feature-docs__plan">
          <ReviewPlanView
            plan={plan}
            changeset={CS}
            status={view === "plan-idle" ? "idle" : "fallback"}
            error={
              view === "plan-fallback"
                ? "HTTP 502 - upstream plan generation failed"
                : undefined
            }
            onGenerateAi={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

applyThemeToRoot(document.documentElement, getStoredThemeId());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root");
}
createRoot(root).render(<App />);
