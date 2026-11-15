import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextColumn, ContextColumnLayout } from "./context-column.js";
import {
  clampContextWidth,
  contextEdgeKey,
  contextOverlays,
  defaultContextWidth,
  dragContextWidth,
  effectiveContextWidth,
  initialContextOpen,
  isContextShortcut,
  KEYBOARD_STEP_PX,
  maxContextWidth,
  MIN_CONTEXT_WIDTH,
  NARROW_VIEWPORT_PX,
  parseStoredWidth,
  type ContextColumnState,
} from "./context-column-state.js";
import { TopBar } from "./top-bar.js";

describe("the Context column", () => {
  it("starts hidden in a narrow window, such as the hosted editor's preview pane", () => {
    expect(initialContextOpen(null, 640)).toBe(false);
    expect(initialContextOpen(null, NARROW_VIEWPORT_PX - 1)).toBe(false);
    expect(initialContextOpen(null, NARROW_VIEWPORT_PX)).toBe(true);
  });

  it("follows the person's remembered choice over the window's width", () => {
    expect(initialContextOpen("open", 640)).toBe(true);
    expect(initialContextOpen("closed", 1600)).toBe(false);
    expect(initialContextOpen("something else", 1600)).toBe(true);
  });

  it("has a toggle in the top bar that says what it does", () => {
    const bar = (contextOpen: boolean) =>
      renderToStaticMarkup(
        <TopBar
          agents={["support"]}
          activeAgentId="support"
          onSelectAgent={() => undefined}
          problems={0}
          onOpenDiagnostics={() => undefined}
          contextOpen={contextOpen}
          onToggleContext={() => undefined}
        />,
      );
    expect(bar(true)).toContain('aria-label="Hide context"');
    expect(bar(true)).toContain('aria-pressed="true"');
    expect(bar(false)).toContain('aria-label="Show context"');
    expect(bar(false)).toContain('aria-pressed="false"');
  });

  it("keeps its width between the minimum and 60% of the window", () => {
    expect(clampContextWidth(100, 1600)).toBe(MIN_CONTEXT_WIDTH);
    expect(clampContextWidth(500, 1600)).toBe(500);
    expect(clampContextWidth(1400, 1600)).toBe(960);
    expect(maxContextWidth(1600)).toBe(960);
    // A window too small for 60% to reach the minimum still gets the minimum.
    expect(maxContextWidth(800)).toBe(480);
    expect(clampContextWidth(900, 800)).toBe(480);
  });

  it("starts at the width it always had, a little over a third of the window", () => {
    expect(defaultContextWidth(1440)).toBe(528);
    expect(defaultContextWidth(1024)).toBe(440);
    expect(defaultContextWidth(2400)).toBe(616);
    expect(effectiveContextWidth(null, 1440)).toBe(528);
  });

  it("remembers a dragged width and fits it to a window that got smaller", () => {
    expect(parseStoredWidth(null)).toBeNull();
    expect(parseStoredWidth("not a width")).toBeNull();
    expect(parseStoredWidth("-4")).toBeNull();
    expect(parseStoredWidth("612.4")).toBe(612);
    expect(effectiveContextWidth(parseStoredWidth("900"), 1600)).toBe(900);
    expect(effectiveContextWidth(parseStoredWidth("900"), 1200)).toBe(720);
  });

  it("lies over the conversation in a narrow window, leaving some of it in sight", () => {
    expect(contextOverlays(767)).toBe(true);
    expect(contextOverlays(768)).toBe(false);
    expect(maxContextWidth(400)).toBe(352);
  });

  it("snaps shut when dragged below half its minimum, and keeps the width to open at", () => {
    const open = { open: true, width: 500 };
    expect(dragContextWidth(620, open, 1600)).toEqual({ open: true, width: 620 });
    expect(dragContextWidth(MIN_CONTEXT_WIDTH - 40, open, 1600)).toEqual({ open: true, width: MIN_CONTEXT_WIDTH });
    expect(dragContextWidth(MIN_CONTEXT_WIDTH / 2 - 1, open, 1600)).toEqual({ open: false, width: 500 });
    expect(dragContextWidth(3000, open, 1600)).toEqual({ open: true, width: 960 });
    // Dragged out from the window's edge, it comes back at its minimum at least.
    expect(dragContextWidth(MIN_CONTEXT_WIDTH / 2, { open: false, width: 500 }, 1600)).toEqual({
      open: true,
      width: MIN_CONTEXT_WIDTH,
    });
  });

  it("resizes from the keyboard on its edge, and Enter shows or hides it", () => {
    const at = (width: number, open = true) => ({ open, width });
    expect(contextEdgeKey("ArrowLeft", false, at(500), 1600)).toEqual(at(500 + KEYBOARD_STEP_PX));
    expect(contextEdgeKey("ArrowLeft", true, at(500), 1600)).toEqual(at(500 + 4 * KEYBOARD_STEP_PX));
    expect(contextEdgeKey("ArrowRight", false, at(500), 1600)).toEqual(at(500 - KEYBOARD_STEP_PX));
    expect(contextEdgeKey("ArrowRight", false, at(MIN_CONTEXT_WIDTH + 4), 1600)).toEqual(at(MIN_CONTEXT_WIDTH));
    expect(contextEdgeKey("ArrowRight", false, at(MIN_CONTEXT_WIDTH), 1600)).toEqual(at(MIN_CONTEXT_WIDTH, false));
    expect(contextEdgeKey("ArrowRight", false, at(500, false), 1600)).toBeNull();
    expect(contextEdgeKey("ArrowLeft", false, at(500, false), 1600)).toEqual(at(500));
    expect(contextEdgeKey("Home", false, at(500), 1600)).toEqual(at(MIN_CONTEXT_WIDTH));
    expect(contextEdgeKey("End", false, at(500), 1600)).toEqual(at(960));
    expect(contextEdgeKey("Enter", false, at(500), 1600)).toEqual(at(500, false));
    expect(contextEdgeKey("Enter", false, at(500, false), 1600)).toEqual(at(500));
    expect(contextEdgeKey("a", false, at(500), 1600)).toBeNull();
  });

  it("shows and hides on Cmd+\\ or Ctrl+\\", () => {
    const key = (init: Partial<Parameters<typeof isContextShortcut>[0]>) =>
      isContextShortcut({ key: "\\", code: "Backslash", metaKey: false, ctrlKey: false, shiftKey: false, ...init });
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ metaKey: true, shiftKey: true })).toBe(false);
    // The same physical key where it types something else.
    expect(key({ ctrlKey: true, key: "#" })).toBe(true);
    expect(key({ ctrlKey: true, key: "b", code: "KeyB" })).toBe(false);
  });

  it("makes its border a focusable separator that says its width", () => {
    const column = (open: boolean): ContextColumnState => ({
      open,
      width: 520,
      viewportWidth: 1600,
      overlay: false,
      toggle: () => undefined,
      apply: () => undefined,
      resetWidth: () => undefined,
    });
    const page = (open: boolean) =>
      renderToStaticMarkup(
        <ContextColumnLayout column={column(open)} aside={<ContextColumn connected>tree</ContextColumn>}>
          <section>conversation</section>
        </ContextColumnLayout>,
      );
    const open = page(true);
    expect(open).toContain('role="separator"');
    expect(open).toContain('aria-orientation="vertical"');
    expect(open).toContain('aria-valuenow="520"');
    expect(open).toContain(`aria-valuemin="${MIN_CONTEXT_WIDTH}"`);
    expect(open).toContain('aria-valuemax="960"');
    expect(open).toContain('aria-controls="context-column"');
    expect(open).toContain('tabindex="0"');
    const hidden = page(false);
    expect(hidden).toContain('aria-valuetext="Hidden"');
    expect(hidden).toContain("inert");
  });
});
