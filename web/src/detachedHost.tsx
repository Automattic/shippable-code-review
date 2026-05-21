import { useEffect, useState } from "react";

/**
 * Slice (a) — foundation only. This host reads its kind+parent from the URL
 * the Rust side baked in, announces itself to the parent, and renders a
 * placeholder card with a re-attach button that closes the window.
 *
 * Slices (b)/(c) replace the placeholder body with the real <Sidebar> /
 * <Inspector> rendered against a snapshot received over the event bus
 * (`shippable:detach-state:<parent>` push, `shippable:detach-action:<parent>`
 * dispatch-back). The shell here — params parsing, ready emit, close-on-
 * re-attach — stays the same.
 */

type Kind = "sidebar" | "inspector";

interface DetachParams {
  kind: Kind;
  parent: string;
}

function readParams(): DetachParams | null {
  const search = new URLSearchParams(window.location.search);
  const kind = search.get("kind");
  const parent = search.get("parent");
  if ((kind !== "sidebar" && kind !== "inspector") || !parent) return null;
  return { kind, parent };
}

export function DetachedHost() {
  const [params] = useState<DetachParams | null>(() => readParams());

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    void (async () => {
      const { emit } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      await emit(`shippable:detach-ready:${params.parent}`, {
        kind: params.kind,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  async function handleReattach() {
    const { getCurrentWebviewWindow } = await import(
      "@tauri-apps/api/webviewWindow"
    );
    await getCurrentWebviewWindow().close();
  }

  if (!params) {
    return (
      <div className="detached-shell">
        <div className="detached-shell__error">
          Detached window opened without a kind/parent. Close this window and
          re-detach from the parent review.
        </div>
      </div>
    );
  }

  return (
    <div className="detached-shell" data-kind={params.kind}>
      <header className="detached-shell__chrome">
        <span className="detached-shell__title">
          {params.kind === "sidebar" ? "Files" : "Inspector"}
          <span className="detached-shell__parent">— {params.parent}</span>
        </span>
        <button
          type="button"
          className="detached-shell__reattach"
          onClick={handleReattach}
          title="Re-attach to the parent window"
        >
          ↙ re-attach
        </button>
      </header>
      <div className="detached-shell__body">
        <p className="detached-shell__placeholder">
          Foundation only — the {params.kind} bridge lands in the next slice.
          Closing this window or the parent re-docks the panel automatically.
        </p>
      </div>
    </div>
  );
}
