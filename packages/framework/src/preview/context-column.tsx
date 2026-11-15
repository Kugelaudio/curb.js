import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { NetworkIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import {
  contextEdgeKey,
  contextShortcutLabel,
  dragContextWidth,
  maxContextWidth,
  MIN_CONTEXT_WIDTH,
  type ContextColumnState,
  type ContextLayout,
} from "./context-column-state.js";

export const CONTEXT_COLUMN_ID = "context-column";

/**
 * The right-hand column, "Agent context": the tree of what the agent has, the button that
 * opens the graph of its skills large (an agent without skills has no graph to show), and a
 * dot that says the view is live.
 */
export function ContextColumn({
  connected,
  onOpenGraph,
  children,
}: {
  /** Connected to the agent server, so what shows is the conversation's own state. */
  connected: boolean;
  /** Opens the graph; absent when the agent has no skills. */
  onOpenGraph?: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      id={CONTEXT_COLUMN_ID}
      className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border/70 bg-card"
      aria-label="Agent context"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-6">
        <h2 className="m-0 text-sm font-medium">Context</h2>
        <span className="flex-1" />
        {onOpenGraph ? (
          <Button variant="ghost" size="sm" onClick={onOpenGraph}>
            <NetworkIcon aria-hidden="true" />
            Graph
          </Button>
        ) : null}
        <span
          className="inline-flex items-center gap-1.5 text-[0.78rem] text-muted-foreground"
          title={connected ? "Shows what your agent has right now" : "Not connected to the agent server"}
        >
          <span className={cn("size-[7px] rounded-full", connected ? "bg-success" : "bg-border")} aria-hidden="true" />
          {connected ? "Live" : "Offline"}
        </span>
      </div>
      {children}
    </aside>
  );
}

/** Writes the column's layout as CSS variables, so a drag moves it without rendering React. */
function paintLayout(element: HTMLElement, layout: ContextLayout, overlay: boolean): void {
  element.style.setProperty("--context-track", layout.open && !overlay ? `${layout.width}px` : "0px");
  element.style.setProperty("--context-width", `${layout.width}px`);
  element.style.setProperty("--context-edge", layout.open ? `${layout.width}px` : "0px");
  element.dataset.open = String(layout.open);
}

/** A drag of the column's edge: where it started, and where it would land now. */
type Drag = { pointerId: number; startX: number; start: ContextLayout; moved: boolean; landing: ContextLayout };

/** Past this many pixels a press on the edge is a drag; short of it, a click. */
const DRAG_THRESHOLD_PX = 3;

/**
 * The conversation and the Context column beside it. The column's left border is its handle:
 * hovering it shows the resize cursor and, after a moment, highlights the line; dragging it
 * resizes the column, and dragging it to half its minimum hides it. A hidden column leaves the
 * same line at the window's edge to drag (or click) it back. Double-clicking the line resets
 * the width. Below the overlay breakpoint the open column lies over the conversation.
 */
export function ContextColumnLayout({
  column,
  aside,
  children,
}: {
  column: ContextColumnState;
  /** The column itself, a `ContextColumn`. */
  aside: ReactNode;
  /** The conversation. */
  children: ReactNode;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [dragging, setDragging] = useState(false);
  const { open, width, viewportWidth, overlay } = column;

  // Before paint, and again when a drag ends, so the page always shows React's state.
  useLayoutEffect(() => {
    if (layoutRef.current && !dragging) paintLayout(layoutRef.current, { open, width }, overlay);
  }, [open, width, overlay, dragging]);

  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.contextResizing = "";
    return () => {
      delete document.documentElement.dataset.contextResizing;
    };
  }, [dragging]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // The ease is for opening and closing; the first paint shows the column where it is.
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No text selection, no focus move: the press is for the line.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { open, width };
    drag.current = { pointerId: event.pointerId, startX: event.clientX, start, moved: false, landing: start };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = current.startX - event.clientX;
    if (!current.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    const raw = (current.start.open ? current.start.width : 0) + delta;
    current.landing = dragContextWidth(raw, current.start, viewportWidth);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (layoutRef.current && drag.current) paintLayout(layoutRef.current, drag.current.landing, overlay);
    });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.moved) column.apply(current.landing);
    // A click on the line of a hidden column brings it back.
    else if (!current.start.open && event.type === "pointerup") column.apply({ open: true, width: current.start.width });
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = contextEdgeKey(event.key, event.shiftKey, { open, width }, viewportWidth);
    if (!next) return;
    event.preventDefault();
    column.apply(next);
  };

  const max = maxContextWidth(viewportWidth);
  return (
    <div
      ref={layoutRef}
      className="context-layout relative grid min-h-0 overflow-hidden"
      data-resizing={dragging ? "" : undefined}
      data-animated={animated && !dragging ? "" : undefined}
      data-overlay={overlay ? "" : undefined}
    >
      {children}
      <div className="context-layout-panel" inert={!open}>
        {aside}
      </div>
      <div
        className="context-edge"
        role="separator"
        aria-orientation="vertical"
        aria-controls={CONTEXT_COLUMN_ID}
        aria-label="Resize context"
        aria-valuemin={MIN_CONTEXT_WIDTH}
        aria-valuemax={max}
        aria-valuenow={open ? width : MIN_CONTEXT_WIDTH}
        aria-valuetext={open ? `${width} pixels` : "Hidden"}
        title={open ? undefined : `Show context (${contextShortcutLabel()})`}
        tabIndex={0}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={column.resetWidth}
        onKeyDown={onKeyDown}
      />
      {/* While dragging, nothing under the pointer (an iframe, a canvas, text) takes it. */}
      {dragging ? <div className="fixed inset-0 z-[60] cursor-col-resize" aria-hidden="true" /> : null}
    </div>
  );
}
