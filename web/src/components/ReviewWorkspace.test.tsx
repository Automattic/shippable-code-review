// @vitest-environment jsdom
import { Fragment } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Dispatch } from "react";
import { ReviewWorkspace } from "./ReviewWorkspace";
import type { Action } from "../state";
import type { ChangeSet, PrSource } from "../types";
import { initialState } from "../state";
import { CredentialsProvider } from "../auth/useCredentials";

const {
  fetchDefinitionCapabilitiesMock,
  fetchDefinitionMock,
} = vi.hoisted(() => ({
  fetchDefinitionCapabilitiesMock: vi.fn(),
  fetchDefinitionMock: vi.fn(),
}));

const { loadGithubPrMock } = vi.hoisted(() => ({
  loadGithubPrMock: vi.fn(),
}));

vi.mock("../githubPrClient", () => ({
  loadGithubPr: loadGithubPrMock,
  GithubFetchError: class GithubFetchError extends Error {
    discriminator: string;
    host?: string;
    hint?: string;
    constructor(discriminator: string, message: string, host?: string, hint?: string) {
      super(message);
      this.name = "GithubFetchError";
      this.discriminator = discriminator;
      this.host = host;
      this.hint = hint;
    }
  },
}));

vi.mock("../highlight", () => ({
  highlightLines: vi.fn(
    async (
      lines: string[],
      language?: string,
      _colorMode?: unknown,
      options?: { clickableSymbols?: Iterable<string>; allowAnyIdentifier?: boolean },
    ) => {
      const clickable = new Set(options?.clickableSymbols ?? []);
      return {
        language: language ?? "text",
        lines: lines.map((line, lineIdx) => {
          const candidates = options?.allowAnyIdentifier
            ? line.match(/[A-Za-z_$][\w$]*/g) ?? []
            : [...clickable];
          const symbol = candidates.find((candidate) => line.includes(`${candidate}(`))
            ?? candidates.find((candidate) => line.includes(candidate));
          if (!symbol) return line;
          const idx = line.indexOf(symbol);
          return (
            <Fragment key={lineIdx}>
              {line.slice(0, idx)}
              <span
                className="shiki-token shiki-token--symbol"
                data-symbol={symbol}
                data-token-col={7}
                role="button"
                tabIndex={0}
              >
                {symbol}
              </span>
              {line.slice(idx + symbol.length)}
            </Fragment>
          );
        }),
      };
    },
  ),
}));

vi.mock("../usePlan", () => ({
  usePlan: () => ({
    plan: { entryPoints: [] },
    status: "idle",
    error: undefined,
    generate: () => undefined,
  }),
}));

vi.mock("../definitionNav", () => ({
  fetchDefinitionCapabilities: fetchDefinitionCapabilitiesMock,
  fetchDefinition: fetchDefinitionMock,
  isProgrammingLanguage: (language: string) =>
    [
      "js", "jsx", "ts", "tsx", "javascript", "typescript",
      "php", "phtml",
    ].includes(language),
  findCapabilityForLanguage: (
    caps: { languages?: Array<{ languageIds: string[] }> } | null,
    language: string,
  ) =>
    caps?.languages?.find((c) => c.languageIds.includes(language)) ?? null,
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => null,
}));

vi.mock("./StatusBar", () => ({
  StatusBar: () => null,
}));

vi.mock("./GuidePrompt", () => ({
  GuidePrompt: () => null,
}));

vi.mock("./HelpOverlay", () => ({
  HelpOverlay: () => null,
}));

vi.mock("./Inspector", () => ({
  Inspector: () => null,
}));

vi.mock("./LoadModal", () => ({
  LoadModal: () => null,
}));

vi.mock("./ReviewPlanView", () => ({
  ReviewPlanView: () => null,
}));

vi.mock("./CodeRunner", () => ({
  CodeRunner: () => null,
}));

vi.mock("./ThemePicker", () => ({
  ThemePicker: () => null,
}));

vi.mock("./PromptPicker", () => ({
  PromptPicker: () => null,
}));

const { isTauriMock, keychainGetMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  keychainGetMock: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
}));

vi.mock("../keychain", () => ({
  isTauri: isTauriMock,
  keychainGet: keychainGetMock,
  keychainSet: vi.fn().mockResolvedValue(undefined),
  keychainRemove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../auth/client", () => ({
  authList: vi.fn().mockResolvedValue([]),
  authSet: vi.fn().mockResolvedValue(undefined),
  authClear: vi.fn().mockResolvedValue(undefined),
  AuthClientError: class AuthClientError extends Error {},
}));

// ReviewWorkspace's detach plumbing reaches into multiWindow, which in turn
// pulls in @tauri-apps/api/webviewWindow when isTauri() returns true. The
// jsdom tests force isTauri true for some PR-refresh paths; without this
// mock, those tests leak an unhandled rejection from getCurrentWindow().
vi.mock("../multiWindow", () => ({
  currentWindowLabel: vi.fn().mockResolvedValue(null),
  openDetachedWindow: vi.fn().mockResolvedValue(undefined),
  listDetachedChildren: vi.fn().mockResolvedValue([]),
  closeDetachedChildrenOf: vi.fn().mockResolvedValue(undefined),
  focusIfDuplicate: vi.fn().mockResolvedValue(false),
  openChangesetInWindow: vi.fn().mockResolvedValue("not-tauri"),
  setWindowChangeset: vi.fn().mockResolvedValue(undefined),
  setWindowTitle: vi.fn().mockResolvedValue(undefined),
  onToastEvent: vi.fn().mockReturnValue(() => {}),
}));

afterEach(cleanup);
afterEach(() => {
  fetchDefinitionCapabilitiesMock.mockReset();
  fetchDefinitionMock.mockReset();
  isTauriMock.mockReturnValue(false);
  keychainGetMock.mockResolvedValue(null);
  window.localStorage.clear();
});

window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("ReviewWorkspace symbol navigation", () => {
  it("falls through to the server definition endpoint for worktree-backed TS diffs", async () => {
    fetchDefinitionCapabilitiesMock.mockResolvedValue({
      languages: [
        {
          id: "ts",
          languageIds: ["ts", "tsx", "js", "jsx"],
          available: true,
          resolver: "typescript-language-server",
          source: "path",
          recommendedSetup: [],
        },
      ],
      requiresWorktree: true,
      anyAvailable: true,
    });
    fetchDefinitionMock.mockResolvedValue({
      status: "ok",
      definitions: [
        {
          uri: "file:///repo/src/prefs.ts",
          file: "src/prefs.ts",
          workspaceRelativePath: "src/prefs.ts",
          line: 0,
          col: 16,
          endLine: 0,
          endCol: 25,
          preview: "1: export function loadPrefs() {}",
          resolver: "typescript-language-server",
        },
      ],
    });
    const changeset = fixtureServerDefinitionChangeset();
    const state = initialState([changeset]);
    const dispatch = vi.fn();

    render(
      <CredentialsProvider>
        <ReviewWorkspace
          state={state}
          dispatch={dispatch}
          rawDispatch={dispatch}
          drafts={{}}
          setDrafts={() => ({})}
          themeId="light"
          setThemeId={() => undefined}
          onLoadChangeset={() => undefined}
          currentSource={{ kind: "worktree", path: "/repo", branch: "feat/nav" }}
        />
      </CredentialsProvider>,
    );

    await waitFor(() =>
      expect(fetchDefinitionCapabilitiesMock).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(await screen.findByRole("button", { name: "loadPrefs" }));

    await waitFor(() =>
      expect(fetchDefinitionMock).toHaveBeenCalledWith({
        file: "src/caller.ts",
        language: "ts",
        line: 0,
        col: 7,
        workspaceRoot: "/repo",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_CURSOR",
      cursor: {
        changesetId: "cs-server-nav",
        fileId: "defs",
        hunkId: "defs-hunk",
        lineIdx: 0,
      },
    });
  });
});

function fixturePrSource(): PrSource {
  return {
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 1,
    htmlUrl: "https://github.com/owner/repo/pull/1",
    headSha: "abc123",
    baseSha: "def456",
    state: "open",
    title: "My PR Title",
    body: "PR body",
    baseRef: "main",
    headRef: "feat/branch",
    lastFetchedAt: "2026-05-07T12:00:00.000Z",
  };
}

function fixturePrChangeset(): ChangeSet {
  return {
    id: "pr:github.com:owner:repo:1",
    title: "My PR Title",
    author: "octocat",
    branch: "feat/branch",
    base: "main",
    createdAt: "2026-05-01T00:00:00.000Z",
    description: "",
    prSource: fixturePrSource(),
    files: [
      {
        id: "file1",
        path: "src/foo.ts",
        language: "ts",
        status: "modified",
        hunks: [
          {
            id: "hunk1",
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [{ kind: "context", text: "const x = 1;", newNo: 1, oldNo: 1 }],
          },
        ],
      },
    ],
  };
}

function renderPrWorkspace(over: Partial<{ dispatch: Dispatch<Action> }> = {}) {
  const cs = fixturePrChangeset();
  const state = initialState([cs]);
  const dispatch: Dispatch<Action> = over.dispatch ?? vi.fn();

  render(
    <CredentialsProvider>
      <ReviewWorkspace
        state={state}
        dispatch={dispatch}
        rawDispatch={dispatch}
        drafts={{}}
        setDrafts={() => ({})}
        themeId="light"
        setThemeId={() => undefined}
        onLoadChangeset={() => undefined}
        currentSource={{ kind: "pr", prUrl: "https://github.com/owner/repo/pull/1" }}
      />
    </CredentialsProvider>,
  );

  return { state, dispatch };
}

describe("ReviewWorkspace — PR topbar", () => {
  beforeEach(() => {
    fetchDefinitionCapabilitiesMock.mockResolvedValue({ languages: [] });
  });

  it("renders the PR title in the topbar", () => {
    renderPrWorkspace();
    expect(screen.getByText("My PR Title")).toBeTruthy();
  });

  it("renders the PR state badge", () => {
    renderPrWorkspace();
    // The topbar should show the PR state as a chip
    expect(screen.getByText("open")).toBeTruthy();
  });

  it("renders the branch refs", () => {
    renderPrWorkspace();
    expect(screen.getByText(/feat\/branch.*main|main.*feat\/branch/)).toBeTruthy();
  });

  it("renders a refresh button", () => {
    renderPrWorkspace();
    expect(
      screen.getByRole("button", { name: /refresh/i }),
    ).toBeTruthy();
  });

  it("dispatches LOAD_CHANGESET when refresh is clicked", async () => {
    const newCs = { ...fixturePrChangeset(), title: "Updated PR" };
    loadGithubPrMock.mockResolvedValue({
      changeSet: newCs,
      prInteractions: {},
      prDetached: [],
    });
    const dispatch = vi.fn();

    renderPrWorkspace({ dispatch });

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_CHANGESET" }),
      ),
    );
  });
});

describe("ReviewWorkspace — PR auth-rejected banner", () => {
  beforeEach(() => {
    fetchDefinitionCapabilitiesMock.mockResolvedValue({ languages: [] });
  });

  it("shows the auth-rejected banner after a refresh fails with github_auth_failed", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_auth_failed", "github_auth_failed", "github.com"),
    );

    renderPrWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(screen.getByText(/was rejected/i)).toBeTruthy(),
    );

    expect(
      screen.getByRole("button", { name: /re-enter to retry/i }),
    ).toBeTruthy();
  });

  it("shows hint in the auth-rejected banner when hint is present", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_auth_failed", "github_auth_failed", "github.com", "rate-limit"),
    );

    renderPrWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(screen.getByText(/rate limit hit/i)).toBeTruthy(),
    );
  });

  it("dismiss button clears the auth-rejected banner", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_auth_failed", "github_auth_failed", "github.com"),
    );

    renderPrWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    // Wait for banner to appear
    await waitFor(() =>
      expect(screen.getByText(/was rejected/i)).toBeTruthy(),
    );

    // Click the dismiss button
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    // Banner should be gone
    await waitFor(() =>
      expect(screen.queryByText(/was rejected/i)).toBeNull(),
    );
  });

  it("opens token modal on github_token_required when Keychain returns null", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_token_required", "github_token_required", "github.com"),
    );
    isTauriMock.mockReturnValue(true);
    keychainGetMock.mockResolvedValue(null);

    renderPrWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(screen.getByText(/GitHub token required/i)).toBeTruthy(),
    );
  });

  it("silently retries refresh when Keychain has a cached token (rehydrate path)", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    const newCs = { ...fixturePrChangeset(), title: "Reloaded PR" };
    // First call: no token in server → github_token_required
    // Second call: success after setGithubToken
    loadGithubPrMock
      .mockRejectedValueOnce(
        new GithubFetchError("github_token_required", "github_token_required", "github.com"),
      )
      .mockResolvedValueOnce({
        changeSet: newCs,
        prInteractions: {},
        prDetached: [],
      });
    isTauriMock.mockReturnValue(true);
    keychainGetMock.mockResolvedValue("ghp_cached_token");
    const dispatch = vi.fn();

    renderPrWorkspace({ dispatch });

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_CHANGESET" }),
      ),
    );
    // Token modal must NOT appear
    expect(screen.queryByText(/GitHub token required/i)).toBeNull();
    const authClient = await import("../auth/client");
    expect(authClient.authSet).toHaveBeenCalledWith(
      { kind: "github", host: "github.com" },
      "ghp_cached_token",
    );
  });

  it("renders the truncation banner when prSource.truncation is set", () => {
    const cs: ChangeSet = {
      ...fixturePrChangeset(),
      prSource: {
        ...fixturePrSource(),
        truncation: { kind: "files", reason: "too many files" },
      },
    };
    const state = initialState([cs]);

    render(
      <CredentialsProvider>
        <ReviewWorkspace
          state={state}
          dispatch={vi.fn() as Dispatch<Action>}
          rawDispatch={vi.fn() as Dispatch<Action>}
          drafts={{}}
          setDrafts={() => ({})}
          themeId="light"
          setThemeId={() => undefined}
          onLoadChangeset={() => undefined}
          currentSource={null}
        />
      </CredentialsProvider>,
    );

    expect(screen.getByText(/truncated by GitHub: too many files/i)).toBeTruthy();
  });
});

describe("ReviewWorkspace — settings affordance", () => {
  beforeEach(() => {
    fetchDefinitionCapabilitiesMock.mockResolvedValue({ languages: [] });
  });

  it("exposes a settings TopbarAction that opens the SettingsModal", async () => {
    renderPrWorkspace();
    const btn = await screen.findByRole("button", { name: /settings/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /add github host/i })).toBeTruthy(),
    );
  });
});

describe("ReviewWorkspace — AI off chip", () => {
  beforeEach(() => {
    fetchDefinitionCapabilitiesMock.mockResolvedValue({ languages: [] });
  });

  it("renders the AI off chip when anthropic is missing AND the skip flag is set", async () => {
    window.localStorage.setItem("shippable:anthropic:skip", "true");
    renderPrWorkspace();
    const chip = await screen.findByRole("button", { name: /ai off/i });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /add github host/i })).toBeTruthy(),
    );
  });

  it("omits the AI off chip when anthropic is configured", async () => {
    window.localStorage.setItem("shippable:anthropic:skip", "true");
    const authClient = await import("../auth/client");
    vi.mocked(authClient.authList).mockResolvedValue([{ kind: "anthropic" }]);
    renderPrWorkspace();
    // Wait for an unrelated topbar button to confirm the topbar has mounted,
    // then assert the AI off chip is absent.
    await screen.findByRole("button", { name: /settings/i });
    expect(screen.queryByRole("button", { name: /ai off/i })).toBeNull();
  });

  it("omits the AI off chip when anthropic is missing but the user hasn't dismissed the boot prompt", async () => {
    // No localStorage skip — the boot gate would prompt; the topbar must not.
    renderPrWorkspace();
    await screen.findByRole("button", { name: /settings/i });
    expect(screen.queryByRole("button", { name: /ai off/i })).toBeNull();
  });
});

function fixtureServerDefinitionChangeset(): ChangeSet {
  return {
    id: "cs-server-nav",
    title: "Server definition navigation test",
    author: "test",
    branch: "feature/server-nav",
    base: "main",
    createdAt: "2026-05-05T00:00:00.000Z",
    description: "Exercise server-backed go-to-definition.",
    files: [
      {
        id: "caller",
        path: "src/caller.ts",
        language: "ts",
        status: "modified",
        hunks: [
          {
            id: "caller-hunk",
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            oldCount: 0,
            newStart: 1,
            newCount: 1,
            lines: [{ kind: "add", text: "return loadPrefs();", newNo: 1 }],
          },
        ],
      },
      {
        id: "defs",
        path: "src/prefs.ts",
        language: "ts",
        status: "modified",
        hunks: [
          {
            id: "defs-hunk",
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            oldCount: 0,
            newStart: 1,
            newCount: 1,
            lines: [
              { kind: "add", text: "export function loadPrefs() {}", newNo: 1 },
            ],
          },
        ],
      },
    ],
  };
}
