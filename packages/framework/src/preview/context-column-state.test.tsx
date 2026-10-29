import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialContextOpen, NARROW_VIEWPORT_PX } from "./context-column-state.js";
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
          diagnostics={[]}
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
});
