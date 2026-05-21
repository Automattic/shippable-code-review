// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Welcome } from "./Welcome";
import { CredentialsProvider } from "../auth/useCredentials";

beforeEach(() => {
  cleanup();
  isTauriMock.mockReturnValue(false);
  keychainGetMock.mockResolvedValue(null);
  window.localStorage.clear();
  // Default: consent fetch fails → no banner. Consent tests override this.
  fetchConsentMock.mockRejectedValue(new Error("no consent endpoint"));
  grantConsentMock.mockResolvedValue(undefined);
});

const { fetchConsentMock, grantConsentMock } = vi.hoisted(() => ({
  fetchConsentMock: vi.fn(),
  grantConsentMock: vi.fn(),
}));

vi.mock("../statsConsent", () => ({
  fetchConsent: fetchConsentMock,
  grantConsent: grantConsentMock,
}));

vi.mock("../auth/client", () => ({
  authList: vi.fn().mockResolvedValue([]),
  authSet: vi.fn().mockResolvedValue(undefined),
  authClear: vi.fn().mockResolvedValue(undefined),
  AuthClientError: class AuthClientError extends Error {},
}));

const { loadGithubPrMock } = vi.hoisted(() => ({
  loadGithubPrMock: vi.fn(),
}));

vi.mock("../githubPrClient", async () => {
  const actual = await vi.importActual<typeof import("../githubPrClient")>("../githubPrClient");
  return {
    ...actual,
    loadGithubPr: loadGithubPrMock,
  };
});

const { isTauriMock, keychainGetMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn().mockReturnValue(false),
  keychainGetMock: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
}));

vi.mock("../keychain", () => ({
  isTauri: isTauriMock,
  keychainGet: keychainGetMock,
  keychainSet: vi.fn().mockResolvedValue(undefined),
  keychainRemove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../useWorktreeLoader", () => ({
  useWorktreeLoader: () => ({
    serverAvailable: false,
    wtDir: "",
    setWtDir: () => {},
    showManualPath: false,
    setShowManualPath: () => {},
    pickDirectory: () => {},
    wtPickerBusy: false,
    scanWorktrees: () => {},
    wtBusy: false,
    wtList: null,
    wtLoadingPath: null,
    loadFromWorktree: () => {},
    err: null,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderWelcome(onLoad: any = vi.fn()) {
  return render(
    <CredentialsProvider>
      <Welcome recents={[]} onLoad={onLoad} onRecentsChange={() => {}} />
    </CredentialsProvider>,
  );
}

describe("Welcome — unified URL field (PR + diff URL)", () => {
  it("renders the 'From a URL' section with a single URL field", () => {
    renderWelcome();
    expect(screen.getByText(/from a url/i)).toBeTruthy();
    expect(
      screen.getByPlaceholderText(/github\.com\/owner\/repo\/pull\/123$/i),
    ).toBeTruthy();
  });

  it("calls loadGithubPr with the entered URL on submit", async () => {
    const fakeCs = {
      id: "pr:github.com:owner:repo:1",
      title: "Fix bug",
      files: [],
    };
    loadGithubPrMock.mockResolvedValue({
      changeSet: fakeCs,
      prInteractions: {},
      prDetached: [],
    });
    const onLoad = vi.fn();

    renderWelcome(onLoad);

    const input = screen.getByPlaceholderText(
      /github\.com\/owner\/repo\/pull\/123$/i,
    );
    fireEvent.change(input, {
      target: { value: "https://github.com/owner/repo/pull/1" },
    });

    const button = screen.getByRole("button", { name: /^load$/i });
    fireEvent.click(button);

    await waitFor(() =>
      expect(loadGithubPrMock).toHaveBeenCalledWith(
        "https://github.com/owner/repo/pull/1",
      ),
    );
    await waitFor(() =>
      expect(onLoad).toHaveBeenCalledWith(
        fakeCs,
        {},
        expect.objectContaining({ kind: "pr", prUrl: "https://github.com/owner/repo/pull/1" }),
        { prInteractions: {}, prDetached: [] },
      ),
    );
  });

  it("opens the token modal when loadGithubPr throws github_token_required", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_token_required", "github_token_required", "github.com"),
    );

    renderWelcome();

    const input = screen.getByPlaceholderText(
      /github\.com\/owner\/repo\/pull\/123$/i,
    );
    fireEvent.change(input, {
      target: { value: "https://github.com/owner/repo/pull/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() =>
      expect(screen.getByText(/needs a GitHub Personal Access Token/i)).toBeTruthy(),
    );
  });

  it("calls onLoad with pr source on successful load", async () => {
    const fakeCs = {
      id: "pr:github.com:owner:repo:42",
      title: "My PR",
      files: [{ path: "foo.ts", hunks: [] }],
    };
    loadGithubPrMock.mockResolvedValue({
      changeSet: fakeCs,
      prInteractions: {},
      prDetached: [],
    });
    const onLoad = vi.fn();

    renderWelcome(onLoad);

    fireEvent.change(
      screen.getByPlaceholderText(/github\.com\/owner\/repo\/pull\/123$/i),
      { target: { value: "https://github.com/owner/repo/pull/42" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() =>
      expect(onLoad).toHaveBeenCalledWith(
        fakeCs,
        {},
        { kind: "pr", prUrl: "https://github.com/owner/repo/pull/42" },
        { prInteractions: {}, prDetached: [] },
      ),
    );
  });

  it("does not open the token modal when Tauri Keychain has a cached token (rehydrate path)", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    const fakeCs = { id: "pr:github.com:owner:repo:1", title: "Test", files: [] };
    loadGithubPrMock
      .mockRejectedValueOnce(
        new GithubFetchError("github_token_required", "github_token_required", "github.com"),
      )
      .mockResolvedValueOnce({
        changeSet: fakeCs,
        prInteractions: {},
        prDetached: [],
      });
    isTauriMock.mockReturnValue(true);
    keychainGetMock.mockResolvedValue("ghp_cached_token");

    const onLoad = vi.fn();
    renderWelcome(onLoad);

    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo\/pull\/123$/i);
    fireEvent.change(input, { target: { value: "https://github.com/owner/repo/pull/1" } });
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() =>
      expect(onLoad).toHaveBeenCalledWith(
        fakeCs,
        {},
        expect.objectContaining({ kind: "pr" }),
        { prInteractions: {}, prDetached: [] },
      ),
    );
    expect(screen.queryByText(/needs a GitHub Personal Access Token/i)).toBeNull();
    const authClient = await import("../auth/client");
    expect(authClient.authSet).toHaveBeenCalledWith(
      { kind: "github", host: "github.com" },
      "ghp_cached_token",
    );
  });

  it("renders an inline error for github_pr_not_found", async () => {
    const { GithubFetchError } = await import("../githubPrClient");
    loadGithubPrMock.mockRejectedValue(
      new GithubFetchError("github_pr_not_found", "github_pr_not_found"),
    );

    renderWelcome();

    fireEvent.change(
      screen.getByPlaceholderText(/github\.com\/owner\/repo\/pull\/123$/i),
      { target: { value: "https://github.com/owner/repo/pull/9999" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() =>
      expect(screen.getByText("PR not found.")).toBeTruthy(),
    );
  });
});

describe("Welcome — stats consent banner", () => {
  const allowBtn = () => screen.queryByRole("button", { name: /^allow$/i });

  it("shows a non-dismissible Allow banner when consent is undecided", async () => {
    fetchConsentMock.mockResolvedValue("undecided");
    renderWelcome();
    await waitFor(() => expect(allowBtn()).not.toBeNull());
    expect(
      screen.getByText(/share anonymous usage counts/i),
    ).toBeTruthy();
    // No dismiss / close affordance — declining is simply not clicking Allow.
    expect(screen.queryByRole("button", { name: /dismiss|close|×/i })).toBeNull();
  });

  it("shows no banner when consent is already granted", async () => {
    fetchConsentMock.mockResolvedValue("granted");
    renderWelcome();
    await waitFor(() =>
      expect(screen.getByText(/from a url/i)).toBeTruthy(),
    );
    expect(allowBtn()).toBeNull();
  });

  it("shows no banner when the consent fetch fails (fail closed)", async () => {
    fetchConsentMock.mockRejectedValue(new Error("network"));
    renderWelcome();
    await waitFor(() =>
      expect(screen.getByText(/from a url/i)).toBeTruthy(),
    );
    expect(allowBtn()).toBeNull();
  });

  it("grants consent and hides the banner when Allow is clicked", async () => {
    fetchConsentMock.mockResolvedValue("undecided");
    renderWelcome();
    const btn = await waitFor(() => {
      const b = allowBtn();
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(btn);
    await waitFor(() => expect(grantConsentMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(allowBtn()).toBeNull());
  });
});

describe("Welcome — settings affordance", () => {
  it("renders a settings link that opens the SettingsModal", async () => {
    renderWelcome();
    const link = screen.getByRole("button", { name: /^settings$/i });
    fireEvent.click(link);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add github host/i }),
      ).toBeTruthy(),
    );
  });
});

describe("Welcome — AI off chip", () => {
  it("is hidden when anthropic is configured", async () => {
    const { authList } = await import("../auth/client");
    vi.mocked(authList).mockResolvedValueOnce([{ kind: "anthropic" }]);
    renderWelcome();
    // Wait for credentials to settle before asserting absence.
    await waitFor(() =>
      expect(screen.getByText(/from a url/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /ai off/i })).toBeNull();
  });

  it("is hidden when anthropic is missing but not skipped (gate's territory)", async () => {
    renderWelcome();
    await waitFor(() =>
      expect(screen.getByText(/from a url/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /ai off/i })).toBeNull();
  });

  it("renders when anthropic is missing AND skipped, and opens Settings", async () => {
    window.localStorage.setItem("shippable:anthropic:skip", "true");
    renderWelcome();
    const chip = await waitFor(() =>
      screen.getByRole("button", { name: /ai off/i }),
    );
    fireEvent.click(chip);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add github host/i }),
      ).toBeTruthy(),
    );
  });
});
