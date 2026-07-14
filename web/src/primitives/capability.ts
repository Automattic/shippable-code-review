export type CapabilityKey =
  | "lsp.typescript" | "lsp.php" | "lsp.python"
  | "runner.js" | "runner.php"
  | "ai.mcp"            // any watcher present
  | "picker.directory"; // tauri-plugin-dialog or AppleScript

export type Capability =
  | { available: true }
  | { available: false; reason: string };

export type Capabilities = Record<CapabilityKey, Capability>;
