/**
 * Single source of truth for keyboard shortcuts.
 *
 * ActionId drives dispatch/setState in App.tsx.
 * ContextPredicate names a runtime condition that App.tsx evaluates; an entry
 * only fires when its predicate (if any) is truthy.
 */

export type ActionId =
  | "MOVE_LINE_DOWN"
  | "MOVE_LINE_UP"
  | "MOVE_LINE_DOWN_EXTEND"
  | "MOVE_LINE_UP_EXTEND"
  | "MOVE_HUNK_DOWN"
  | "MOVE_HUNK_UP"
  | "MOVE_FILE_NEXT"
  | "MOVE_FILE_PREV"
  | "NEXT_COMMENT"
  | "PREV_COMMENT"
  | "COLLAPSE_SELECTION"
  | "TOGGLE_HELP"
  | "TOGGLE_INSPECTOR"
  | "TOGGLE_SIDEBAR"
  | "TOGGLE_PLAN"
  | "CLOSE_PLAN"
  | "TOGGLE_ACK"
  | "TOGGLE_FILE_REVIEWED"
  | "TOGGLE_CHANGESET_REVIEWED"
  | "RUN_SELECTION"
  | "START_REPLY"
  | "START_COMMENT"
  | "ACCEPT_GUIDE"
  | "DISMISS_GUIDE"
  | "CLOSE_HELP"
  | "PREV_CHANGESET"
  | "NEXT_CHANGESET"
  | "OPEN_LOAD"
  | "OPEN_RUNNER"
  | "OPEN_PROMPT_PICKER"
  | "CLOSE_PROMPT_PICKER"
  | "OPEN_COMMAND_PALETTE"
  | "CLOSE_COMMAND_PALETTE";

export type ContextPredicate =
  | "hasSuggestion"
  | "lineHasAiNote"
  | "hasSelection"
  | "hasPlan"
  | "hasPicker"
  | "hasCommandPalette";

export type KeyGroup = "navigation" | "review" | "guide" | "ui" | "testing";

export interface KeyEntry {
  /** The value of KeyboardEvent.key */
  key: string;
  /** If true, Shift must be held; default false */
  shift?: boolean;
  /** If true, Cmd (macOS) must be held; default false (must NOT be held) */
  meta?: boolean;
  /** If true, Ctrl must be held; default false (must NOT be held) */
  ctrl?: boolean;
  label: string;
  group: KeyGroup;
  action: ActionId;
  /** Entry only fires when this predicate is true at dispatch time */
  when?: ContextPredicate;
  /** Palette-visible commands should be app-level actions, not cursor motion */
  palette?: "global";
}

export const KEYMAP: KeyEntry[] = [
  // ── navigation ─────────────────────────────────────────────────────────────
  // Shift-extend variants listed first so they win the KEYMAP.find over the
  // shift-agnostic arrow entries below.
  { key: "ArrowDown", shift: true, label: "extend selection down", group: "navigation", action: "MOVE_LINE_DOWN_EXTEND" },
  { key: "ArrowUp",   shift: true, label: "extend selection up",   group: "navigation", action: "MOVE_LINE_UP_EXTEND" },
  { key: "j",         label: "next line",            group: "navigation", action: "MOVE_LINE_DOWN" },
  { key: "ArrowDown", label: "next line",            group: "navigation", action: "MOVE_LINE_DOWN" },
  { key: "k",         label: "previous line",        group: "navigation", action: "MOVE_LINE_UP" },
  { key: "ArrowUp",   label: "previous line",        group: "navigation", action: "MOVE_LINE_UP" },
  // Mark shift explicitly so the help table renders these as ⇧j / ⇧k
  // alongside ⇧m / ⇧l / ⇧r — without `shift: true` they showed as bare
  // capital letters next to the lowercase j/k bindings, mixing two
  // conventions in the same table.
  { key: "J", shift: true, label: "next hunk",     group: "navigation", action: "MOVE_HUNK_DOWN" },
  { key: "K", shift: true, label: "previous hunk", group: "navigation", action: "MOVE_HUNK_UP" },
  // ]/[ for files keeps Tab as the browser-native focus key. Sample-changeset
  // cycling moves to the shifted variants (}/{) — testing-only, less common.
  { key: "]",         label: "next file",            group: "navigation", action: "MOVE_FILE_NEXT" },
  { key: "[",         label: "previous file",        group: "navigation", action: "MOVE_FILE_PREV" },
  { key: "Escape", when: "hasSelection", label: "collapse selection", group: "navigation", action: "COLLAPSE_SELECTION" },
  // Defined here for help-table grouping; the n/N entries are placed below
  // the guide section so guide-dismiss-with-n still wins when a suggestion
  // is showing (KEYMAP.find returns the first match).

  // ── review ──────────────────────────────────────────────────────────────────
  { key: "a", label: "ack / un-ack AI note on current line", group: "review", action: "TOGGLE_ACK", when: "lineHasAiNote" },
  { key: "r", label: "reply to AI note on current line",     group: "review", action: "START_REPLY",   when: "lineHasAiNote" },
  { key: "c", label: "start a new comment on current line",  group: "review", action: "START_COMMENT" },
  { key: "e", label: "run current hunk (or block selection) in code runner", group: "review", action: "RUN_SELECTION" },
  { key: "M", shift: true, label: "sign off on current file (toggle)", group: "review", action: "TOGGLE_FILE_REVIEWED" },
  { key: "S", shift: true, label: "sign off on current changeset at this revision (toggle)", group: "review", action: "TOGGLE_CHANGESET_REVIEWED" },

  // ── guide ───────────────────────────────────────────────────────────────────
  { key: "Enter",  label: "accept guide", group: "guide", action: "ACCEPT_GUIDE",  when: "hasSuggestion" },
  { key: "y",      label: "accept guide", group: "guide", action: "ACCEPT_GUIDE",  when: "hasSuggestion" },
  { key: "Escape", label: "dismiss guide", group: "guide", action: "DISMISS_GUIDE", when: "hasSuggestion" },
  { key: "n",      label: "dismiss guide", group: "guide", action: "DISMISS_GUIDE", when: "hasSuggestion" },

  // ── comment navigation (placed after guide so n falls through cleanly) ─────
  { key: "n",         label: "next comment",     group: "navigation", action: "NEXT_COMMENT", palette: "global" },
  { key: "N", shift: true, label: "previous comment", group: "navigation", action: "PREV_COMMENT", palette: "global" },

  // ── ui ──────────────────────────────────────────────────────────────────────
  { key: "?",      label: "see keybindings",    group: "ui", action: "TOGGLE_HELP", palette: "global" },
  { key: "i",      label: "toggle AI inspector", group: "ui", action: "TOGGLE_INSPECTOR", palette: "global" },
  { key: "f",      label: "toggle file list",    group: "ui", action: "TOGGLE_SIDEBAR",   palette: "global" },
  { key: "p",      label: "where to start (plan)", group: "ui", action: "TOGGLE_PLAN", palette: "global" },
  // Escape closes plan before falling through to help / guide Escape handlers.
  { key: "Escape", when: "hasPlan", label: "close plan", group: "ui", action: "CLOSE_PLAN" },
  { key: "Escape", label: "close help",          group: "ui", action: "CLOSE_HELP" },
  { key: "L", shift: true, label: "load a changeset (URL / file / paste)", group: "ui", action: "OPEN_LOAD", palette: "global" },
  { key: "R", shift: true, label: "open the free code runner", group: "ui", action: "OPEN_RUNNER", palette: "global" },
  { key: "/", shift: false, label: "run a prompt on the current selection", group: "ui", action: "OPEN_PROMPT_PICKER" },
  { key: "Escape", when: "hasPicker", label: "close prompt picker", group: "ui", action: "CLOSE_PROMPT_PICKER" },
  { key: "k", meta: true, label: "open command palette", group: "ui", action: "OPEN_COMMAND_PALETTE" },
  { key: "k", ctrl: true, label: "open command palette", group: "ui", action: "OPEN_COMMAND_PALETTE" },
  { key: "Escape", when: "hasCommandPalette", label: "close command palette", group: "ui", action: "CLOSE_COMMAND_PALETTE" },

  // ── testing ─────────────────────────────────────────────────────────────────
  { key: "{", label: "previous sample changeset", group: "testing", action: "PREV_CHANGESET" },
  { key: "}", label: "next sample changeset",     group: "testing", action: "NEXT_CHANGESET" },
];
