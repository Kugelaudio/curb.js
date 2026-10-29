import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of the DOM for the badge and the frame: inline styles, attributes and text. */
class FakeNode {
  style: Record<string, string> & { cssText: string } = { cssText: "" };
  attributes: Record<string, string> = {};
  textContent = "";
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

let appended: FakeNode[];

beforeEach(() => {
  appended = [];
  vi.resetModules();
  vi.stubGlobal("document", {
    createElement: () => new FakeNode(),
    body: { appendChild: (node: FakeNode) => (appended.push(node), node) },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function show(...args: Parameters<typeof import("./page-ui.js").showRelayState>) {
  const { showRelayState } = await import("./page-ui.js");
  showRelayState(...args);
  const [frame, badge] = appended;
  return { frame: frame!, badge: badge!, showRelayState };
}

describe("showRelayState", () => {
  it("frames the whole page and puts the badge at the top centre while Claude is connected", async () => {
    const { frame, badge } = await show({ kind: "connected" });
    expect(frame.style.cssText).toContain("inset:0");
    expect(frame.style.cssText).toContain("pointer-events:none");
    expect(frame.style.opacity).toBe("1");
    expect(frame.attributes["aria-hidden"]).toBe("true");
    expect(badge.style.cssText).toContain("top:10px;left:50%;transform:translateX(-50%)");
    expect(badge.style.cssText).toContain("pointer-events:none");
    expect(badge.attributes.role).toBe("status");
    expect(badge.textContent).toBe("● Claude is connected");
  });

  it("drops the frame but keeps the badge, in text, when the connection goes", async () => {
    const { frame, badge, showRelayState } = await show({ kind: "connected" });
    showRelayState({ kind: "retrying", inMs: 1000 });
    expect(appended).toHaveLength(2);
    expect(frame.style.opacity).toBe("0");
    expect(badge.textContent).toBe("○ Reconnecting to Claude…");
  });

  it("shows no frame on a session page that has no link", async () => {
    const { frame, badge } = await show({ kind: "refused" }, "noLink");
    expect(frame.style.opacity).toBe("0");
    expect(badge.textContent).toBe("○ Open this page from the link Claude gave you");
  });
});
