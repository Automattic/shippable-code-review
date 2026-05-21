// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { CredentialsProvider } from "../auth/useCredentials";

vi.mock("../auth/client", () => ({
  authList: vi.fn().mockResolvedValue([]),
  authSet: vi.fn().mockResolvedValue(undefined),
  authClear: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../keychain", () => ({
  isTauri: vi.fn(() => false),
  keychainGet: vi.fn().mockResolvedValue(null),
  keychainSet: vi.fn().mockResolvedValue(undefined),
  keychainRemove: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => cleanup());

const defaultModeProps = {
  inlineComments: false,
  onChangeInlineComments: vi.fn(),
  hideNonActiveComments: false,
  onChangeHideNonActiveComments: vi.fn(),
};

describe("SettingsModal", () => {
  it("portals into document.body and contains the settings CredentialsPanel", async () => {
    render(
      <CredentialsProvider>
        <SettingsModal onClose={vi.fn()} {...defaultModeProps} />
      </CredentialsProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add github host/i }),
      ).toBeTruthy(),
    );
  });

  it("invokes onClose when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(
      <CredentialsProvider>
        <SettingsModal onClose={onClose} {...defaultModeProps} />
      </CredentialsProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add github host/i }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });

  it("exposes the dialog role with aria-modal and an aria-label", async () => {
    render(
      <CredentialsProvider>
        <SettingsModal onClose={vi.fn()} {...defaultModeProps} />
      </CredentialsProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("invokes onClose when Esc is pressed", async () => {
    const onClose = vi.fn();
    render(
      <CredentialsProvider>
        <SettingsModal onClose={onClose} {...defaultModeProps} />
      </CredentialsProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add github host/i }),
      ).toBeTruthy(),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SettingsModal — inline comments", () => {
  function renderWithInline(
    inline: boolean,
    onChange = vi.fn(),
    onClose = vi.fn(),
  ) {
    return render(
      <CredentialsProvider>
        <SettingsModal
          {...defaultModeProps}
          onClose={onClose}
          inlineComments={inline}
          onChangeInlineComments={onChange}
        />
      </CredentialsProvider>,
    );
  }

  it("reflects inlineComments=false as off", async () => {
    renderWithInline(false);
    const toggle = await screen.findByRole("button", {
      name: /^inline comments$/i,
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects inlineComments=true as on", async () => {
    renderWithInline(true);
    const toggle = await screen.findByRole("button", {
      name: /^inline comments$/i,
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onChangeInlineComments(true) when toggled while off", async () => {
    const onChange = vi.fn();
    renderWithInline(false, onChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /^inline comments$/i }),
    );
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChangeInlineComments(false) when toggled while on", async () => {
    const onChange = vi.fn();
    renderWithInline(true, onChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /^inline comments$/i }),
    );
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("SettingsModal — hide non-active comments", () => {
  function renderWithHide(hide: boolean, onChange = vi.fn()) {
    return render(
      <CredentialsProvider>
        <SettingsModal
          {...defaultModeProps}
          onClose={vi.fn()}
          hideNonActiveComments={hide}
          onChangeHideNonActiveComments={onChange}
        />
      </CredentialsProvider>,
    );
  }

  it("reflects hideNonActiveComments=false as off", async () => {
    renderWithHide(false);
    const toggle = await screen.findByRole("button", {
      name: /hide non-active comments/i,
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects hideNonActiveComments=true as on", async () => {
    renderWithHide(true);
    const toggle = await screen.findByRole("button", {
      name: /hide non-active comments/i,
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onChangeHideNonActiveComments with the flipped value", async () => {
    const onChange = vi.fn();
    renderWithHide(false, onChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /hide non-active comments/i }),
    );
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("flips back to false when toggled while on", async () => {
    const onChange = vi.fn();
    renderWithHide(true, onChange);
    fireEvent.click(
      await screen.findByRole("button", { name: /hide non-active comments/i }),
    );
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
