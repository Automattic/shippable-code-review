// Drives the "Set up MCP…" modal. The flow used to be two-phase (discover
// → checkbox picker → auto-write). We now just hand the user copy-paste
// snippets — Shippable never touches their dotfiles. Triggered either by
// the macOS menu item or by the inline "Set up Shippable MCP →" button in
// AgentContextSection.

import { useCallback, useEffect, useState } from "react";
import { isTauri } from "./keychain";
import type { McpSnippet } from "./components/RegisterMcpModal";

interface OpenError {
  title: string;
  message: string;
}

export function useRegisterMcp(): {
  snippets: McpSnippet[] | null;
  error: OpenError | null;
  open: () => Promise<void>;
  close: () => void;
  dismissError: () => void;
} {
  const [snippets, setSnippets] = useState<McpSnippet[] | null>(null);
  const [error, setError] = useState<OpenError | null>(null);

  const open = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<McpSnippet[]>("mcp_install_snippets");
      setSnippets(result);
    } catch (err) {
      setError({
        title: "Could not look up MCP targets",
        message: String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<string>("shippable:menu", (e) => {
        if (e.payload !== "register-mcp") return;
        void open();
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  return {
    snippets,
    error,
    open,
    close: () => setSnippets(null),
    dismissError: () => setError(null),
  };
}
