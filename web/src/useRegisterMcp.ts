// Two-phase flow for the "Register MCP…" menu item:
//   1. discover available targets (Claude Code, Codex, …) and show a picker
//   2. invoke registration for the selected ids and show a notice with
//      per-target outcomes.

import { useCallback, useEffect, useState } from "react";
import { isTauri } from "./keychain";
import type { McpTarget } from "./components/RegisterMcpModal";

interface RegisterOutcome {
  id: string;
  display_name: string;
  config_path: string;
  status: "added" | "replaced" | "no-change" | "failed";
  previous_command?: string;
  error?: string;
}

interface DiscoverResult {
  targets: McpTarget[];
  binary_path: string | null;
}

export interface RegisterMcpNotice {
  ok: boolean;
  title: string;
  message: string;
  details?: string;
}

export interface RegisterMcpPicker {
  targets: McpTarget[];
}

function summarize(outcomes: RegisterOutcome[]): RegisterMcpNotice {
  const fails = outcomes.filter((o) => o.status === "failed");
  const ok = fails.length === 0;
  const lines = outcomes.map((o) => {
    switch (o.status) {
      case "added":
        return `✓ ${o.display_name} — added (${o.config_path})`;
      case "replaced":
        return `↻ ${o.display_name} — replaced previous entry pointing at ${
          o.previous_command ?? "?"
        }`;
      case "no-change":
        return `· ${o.display_name} — already pointing here`;
      case "failed":
        return `✗ ${o.display_name} — ${o.error ?? "failed"}`;
    }
  });
  return {
    ok,
    title: ok
      ? "Shippable MCP registered"
      : "Shippable MCP registered with errors",
    message: ok
      ? "Restart the affected clients to pick up the new MCP."
      : "Some clients couldn't be updated — see details.",
    details: lines.join("\n"),
  };
}

export function useRegisterMcp(): {
  picker: RegisterMcpPicker | null;
  notice: RegisterMcpNotice | null;
  binaryPath: string;
  confirm: (ids: string[]) => Promise<void>;
  cancel: () => void;
  dismissNotice: () => void;
} {
  const [picker, setPicker] = useState<RegisterMcpPicker | null>(null);
  const [notice, setNotice] = useState<RegisterMcpNotice | null>(null);
  const [binaryPath, setBinaryPath] = useState<string>("");

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { invoke } = await import("@tauri-apps/api/core");
      const off = await listen<string>("shippable:menu", async (e) => {
        if (e.payload !== "register-mcp") return;
        try {
          const result = await invoke<DiscoverResult>("discover_mcp_targets");
          setBinaryPath(result.binary_path ?? "");
          setPicker({ targets: result.targets });
        } catch (err) {
          setNotice({
            ok: false,
            title: "Could not look up MCP targets",
            message: String(err),
          });
        }
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const confirm = useCallback(async (ids: string[]) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcomes = await invoke<RegisterOutcome[]>("register_mcp_targets", {
        ids,
      });
      setPicker(null);
      setNotice(summarize(outcomes));
    } catch (err) {
      setPicker(null);
      setNotice({
        ok: false,
        title: "Could not register Shippable MCP",
        message: String(err),
      });
    }
  }, []);

  return {
    picker,
    notice,
    binaryPath,
    confirm,
    cancel: () => setPicker(null),
    dismissNotice: () => setNotice(null),
  };
}
