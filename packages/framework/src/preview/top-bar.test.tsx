import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CURB_REPOSITORY } from "./curb-logo.js";
import { TopBar } from "./top-bar.js";

function topBar(agents: readonly string[], problems = 0) {
  return renderToStaticMarkup(
    <TopBar
      agents={agents}
      activeAgentId={agents[0]!}
      onSelectAgent={() => undefined}
      problems={problems}
      onOpenDiagnostics={() => undefined}
      contextOpen
      onToggleContext={() => undefined}
    />,
  );
}

describe("the top bar", () => {
  it("says Curb.js, with the link to its repository right beside the name", () => {
    const html = topBar(["agent"]);
    const name = html.indexOf(">Curb.js</h1>");
    const link = html.indexOf('aria-label="Curb.js on GitHub"');
    expect(name).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(name);
    expect(html.indexOf("Local preview")).toBeGreaterThan(link);
    expect(html).toContain("<h1");
    expect(html).toContain(">Curb.js</h1>");
    expect(CURB_REPOSITORY).toBe("https://github.com/Kugelaudio/curb.js");
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="${CURB_REPOSITORY}"[^>]*target="_blank"[^>]*rel="noreferrer"[^>]*aria-label="Curb.js on GitHub"`),
    );
  });

  it("names no agent when the project has one, and offers a picker when it has several", () => {
    expect(topBar(["agent"])).not.toContain('aria-label="Agent"');
    expect(topBar(["agent"])).not.toContain("Your agent");
    expect(topBar(["support", "sales"])).toContain('aria-label="Agent"');
  });

  it("says how many problems the agent has", () => {
    expect(topBar(["agent"])).toContain("No problems");
    expect(topBar(["agent"], 1)).toContain("1 problem<");
    expect(topBar(["agent"], 3)).toContain("3 problems");
  });
});
