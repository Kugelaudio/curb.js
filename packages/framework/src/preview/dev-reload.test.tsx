import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewLoading } from "./dev-reload.js";

describe("the preview before the agent is on the page", () => {
  it("shows Curb's mark, waiting, and says it is connecting", () => {
    const html = renderToStaticMarkup(<PreviewLoading connected={false} />);
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<svg[^>]*data-waiting=""[^>]*aria-label="Curb"/);
    expect(html).toContain("Connecting to the agent server…");
  });

  it("says it is loading the agent once the server answers", () => {
    const html = renderToStaticMarkup(<PreviewLoading connected />);
    expect(html).toContain("Loading the agent…");
    expect(html).not.toContain("Connecting");
  });
});
