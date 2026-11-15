import { useCallback, useEffect, useState } from "react";

/** Where the person's choice to show or hide the Context column is kept, per browser. */
export const CONTEXT_COLUMN_STORAGE_KEY = "curb.preview.contextColumn";

/** Where the width the person dragged the Context column to is kept, per browser. Absent
 * means the default width, which follows the window. */
export const CONTEXT_WIDTH_STORAGE_KEY = "curb.preview.contextColumnWidth";

/**
 * Below this width the conversation needs the room (a preview inside a narrow editor pane), so
 * the column starts hidden until the person opens it.
 */
export const NARROW_VIEWPORT_PX = 1024;

/** Below this width the open column lies over the conversation instead of pushing it aside. */
export const OVERLAY_VIEWPORT_PX = 768;

/** The narrowest the column gets; dragging it to half of this hides it. */
export const MIN_CONTEXT_WIDTH = 280;

/** The widest the column gets, as a share of the window, so the conversation keeps room. */
export const MAX_CONTEXT_SHARE = 0.6;

/** What lying over the conversation leaves of it, so the page behind stays in sight. */
const OVERLAY_MARGIN_PX = 48;

/** One arrow key press on the column's edge; with Shift, four times as far. */
export const KEYBOARD_STEP_PX = 16;

/** Open or closed on first paint: the remembered choice, else open only on a wide viewport. */
export function initialContextOpen(stored: string | null, viewportWidth: number): boolean {
  if (stored === "open") return true;
  if (stored === "closed") return false;
  return viewportWidth >= NARROW_VIEWPORT_PX;
}

export function contextOverlays(viewportWidth: number): boolean {
  return viewportWidth < OVERLAY_VIEWPORT_PX;
}

/** The width the column has until the person drags it: a little over a third of the window. */
export function defaultContextWidth(viewportWidth: number): number {
  return Math.round(Math.min(616, Math.max(440, viewportWidth * 0.36667)));
}

export function maxContextWidth(viewportWidth: number): number {
  const max = contextOverlays(viewportWidth)
    ? viewportWidth - OVERLAY_MARGIN_PX
    : viewportWidth * MAX_CONTEXT_SHARE;
  return Math.max(MIN_CONTEXT_WIDTH, Math.floor(max));
}

export function clampContextWidth(width: number, viewportWidth: number): number {
  return Math.round(Math.min(maxContextWidth(viewportWidth), Math.max(MIN_CONTEXT_WIDTH, width)));
}

/** The width on screen: the one the person chose (or the default), fitted to the window. The
 * choice itself is kept, so a window that grows back gets it back. */
export function effectiveContextWidth(preferred: number | null, viewportWidth: number): number {
  return clampContextWidth(preferred ?? defaultContextWidth(viewportWidth), viewportWidth);
}

export function parseStoredWidth(stored: string | null): number | null {
  if (stored === null) return null;
  const width = Number(stored);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

export type ContextLayout = { open: boolean; width: number };

/**
 * Where a drag of the column's edge lands. `raw` is the width the pointer asks for: below half
 * the minimum the column snaps shut, between that and the minimum it holds at the minimum, so
 * it never shows squeezed. A shut column keeps the width it had, to open at it again.
 */
export function dragContextWidth(raw: number, current: ContextLayout, viewportWidth: number): ContextLayout {
  if (raw < MIN_CONTEXT_WIDTH / 2) return { open: false, width: current.width };
  return { open: true, width: clampContextWidth(raw, viewportWidth) };
}

/**
 * A key pressed on the column's edge, which is a vertical separator on the column's left:
 * ArrowLeft moves it left (wider), ArrowRight right (narrower, and past the minimum, shut),
 * Home and End go to the narrowest and widest, Enter shows or hides it. Null for any other key.
 */
export function contextEdgeKey(
  key: string,
  shift: boolean,
  current: ContextLayout,
  viewportWidth: number,
): ContextLayout | null {
  const step = shift ? KEYBOARD_STEP_PX * 4 : KEYBOARD_STEP_PX;
  const { open, width } = current;
  switch (key) {
    case "Enter":
      return { open: !open, width };
    case "ArrowLeft":
      return open ? { open, width: clampContextWidth(width + step, viewportWidth) } : { open: true, width };
    case "ArrowRight":
      if (!open) return null;
      return width <= MIN_CONTEXT_WIDTH ? { open: false, width } : { open, width: clampContextWidth(width - step, viewportWidth) };
    case "Home":
      return { open: true, width: MIN_CONTEXT_WIDTH };
    case "End":
      return { open: true, width: maxContextWidth(viewportWidth) };
    default:
      return null;
  }
}

/**
 * Cmd+\ on a Mac, Ctrl+\ elsewhere (either is taken on both): free in Chrome, Safari and
 * Firefox, and the composer gives it no meaning. The physical key counts too, so a layout
 * where that key types something else (German `#`) has the shortcut at the same place.
 */
export function isContextShortcut(event: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return false;
  return event.key === "\\" || event.code === "Backslash";
}

/** How the shortcut reads on this machine, for tooltips. */
export function contextShortcutLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Mac|iPhone|iPad/.test(agent) ? "⌘\\" : "Ctrl+\\";
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // KEEP-JUSTIFIED: storage can be off (a private window, a locked-down frame); the column
    // then follows the viewport, which is the right default anyway.
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // KEEP-JUSTIFIED: without storage the choice lasts for this page only; nothing to report.
  }
}

export type ContextColumnState = {
  open: boolean;
  /** The width on screen, fitted to the window. */
  width: number;
  viewportWidth: number;
  /** The open column lies over the conversation (a narrow window). */
  overlay: boolean;
  toggle: () => void;
  /** Applies where a drag or a key landed, and remembers it. */
  apply: (layout: ContextLayout) => void;
  /** Back to the default width, which follows the window, and open. */
  resetWidth: () => void;
};

/** The Context column's visibility and width, remembered across reloads. */
export function useContextColumn(): ContextColumnState {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [open, setOpen] = useState(() => initialContextOpen(readStored(CONTEXT_COLUMN_STORAGE_KEY), window.innerWidth));
  const [preferred, setPreferred] = useState(() => parseStoredWidth(readStored(CONTEXT_WIDTH_STORAGE_KEY)));

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const show = useCallback((next: boolean) => {
    setOpen(next);
    writeStored(CONTEXT_COLUMN_STORAGE_KEY, next ? "open" : "closed");
  }, []);

  const toggle = useCallback(() => {
    setOpen((current) => {
      writeStored(CONTEXT_COLUMN_STORAGE_KEY, current ? "closed" : "open");
      return !current;
    });
  }, []);

  const width = effectiveContextWidth(preferred, viewportWidth);

  const apply = useCallback(
    (layout: ContextLayout) => {
      show(layout.open);
      if (layout.open && layout.width !== width) {
        setPreferred(layout.width);
        writeStored(CONTEXT_WIDTH_STORAGE_KEY, String(layout.width));
      }
    },
    [show, width],
  );

  const resetWidth = useCallback(() => {
    show(true);
    setPreferred(null);
    writeStored(CONTEXT_WIDTH_STORAGE_KEY, null);
  }, [show]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isContextShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return { open, width, viewportWidth, overlay: contextOverlays(viewportWidth), toggle, apply, resetWidth };
}
