import { useCallback, useState } from "react";

/** Where the person's choice to show or hide the Context column is kept, per browser. */
export const CONTEXT_COLUMN_STORAGE_KEY = "curb.preview.contextColumn";

/**
 * Below this width the conversation needs the room (a preview inside a narrow editor pane), so
 * the column starts hidden until the person opens it.
 */
export const NARROW_VIEWPORT_PX = 1024;

/** Open or closed on first paint: the remembered choice, else open only on a wide viewport. */
export function initialContextOpen(stored: string | null, viewportWidth: number): boolean {
  if (stored === "open") return true;
  if (stored === "closed") return false;
  return viewportWidth >= NARROW_VIEWPORT_PX;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(CONTEXT_COLUMN_STORAGE_KEY);
  } catch {
    // KEEP-JUSTIFIED: storage can be off (a private window, a locked-down frame); the column
    // then follows the viewport, which is the right default anyway.
    return null;
  }
}

function writeStored(open: boolean): void {
  try {
    window.localStorage.setItem(CONTEXT_COLUMN_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // KEEP-JUSTIFIED: without storage the choice lasts for this page only; nothing to report.
  }
}

/** The Context column's visibility, remembered across reloads. */
export function useContextColumn(): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => initialContextOpen(readStored(), window.innerWidth));
  const toggle = useCallback(() => {
    setOpen((current) => {
      writeStored(!current);
      return !current;
    });
  }, []);
  return { open, toggle };
}
