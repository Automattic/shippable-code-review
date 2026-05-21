import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./detached.css";
import { DetachedHost } from "./detachedHost";
import { applyThemeToRoot, getStoredThemeId } from "./tokens";

// localStorage is shared per-origin with the parent review window, so the
// theme picked over there is the one the detached child paints with. We
// only read on boot — live theme switches in the parent are picked up via
// the snapshot bridge in slice (b)/(c) (or simply on re-attach + detach).
applyThemeToRoot(document.documentElement, getStoredThemeId());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DetachedHost />
  </StrictMode>,
);
