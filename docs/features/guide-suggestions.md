# Guide Suggestions

## What it is
A lightweight nudge when the reviewer is reading code that depends on another unread part of the diff.

## What it does
- Detects when the current hunk references a symbol defined elsewhere in the same changeset.
- Checks whether that definition is still mostly unread.
- Prompts the reviewer to jump to the definition before they lose the thread.
- Supports quick accept or dismiss without opening a separate screen.

## Keyboard
- `Enter` or `y` — jump to the definition.
- `Esc` or `n` — dismiss. Dismissals persist across reloads for that changeset.

## See also
- [Guide Suggestions Model](../concepts/guide-suggestions.md) — exact trigger conditions and persistence.

## Screenshot
![Guide suggestion](./assets/guide-suggestion.png)
