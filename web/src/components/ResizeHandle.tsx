import "./ResizeHandle.css";
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Which edge of its neighbouring panel the handle sits on. "right" means
   *  the handle widens the panel to its left when dragged right (the file
   *  list); "left" widens the panel to its right when dragged left (the
   *  inspector). */
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  /** Live width while dragging or on an arrow-key step. */
  onResize: (px: number) => void;
  /** Final width once the drag ends — the caller persists this. */
  onCommit: (px: number) => void;
  onReset: () => void;
  ariaLabel: string;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;

export function ResizeHandle({
  edge,
  width,
  min,
  max,
  onResize,
  onCommit,
  onReset,
  ariaLabel,
}: Props) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [active, setActive] = useState(false);

  // If the handle unmounts mid-drag (e.g. the `f` keybinding hides the
  // sidebar), pointerup never fires — clear the global drag class so the
  // resize cursor and user-select lock don't stick app-wide.
  useEffect(() => () => document.body.classList.remove("resizing-col"), []);

  const widthFor = (dx: number) =>
    drag.current!.startWidth + (edge === "right" ? dx : -dx);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-col");
    setActive(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(widthFor(e.clientX - drag.current.startX));
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onCommit(widthFor(e.clientX - drag.current.startX));
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-col");
    setActive(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const towardWider = e.key === "ArrowRight" ? edge === "right" : edge === "left";
    const next = width + (towardWider ? step : -step);
    onResize(next);
    onCommit(next);
  };

  return (
    <div
      className={`resize-handle resize-handle--${edge}${active ? " resize-handle--active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
