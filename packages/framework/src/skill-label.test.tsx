import { describe, expect, it } from "vitest";
import { Agent, AgentSiteRuntime, Skill, Skills } from "./index.js";
import { flattenContext } from "./index.js";
import { RoutesMetaProvider } from "./route-context.js";

import type React from "react";

const skills = (links: React.ReactNode) => () => <Agent><Skills>{links}</Skills></Agent>;

function linesOf(app: () => React.ReactElement): string[] {
  const { context } = new AgentSiteRuntime(app).snapshot();
  return flattenContext(context).filter((line) => line.startsWith("available_skill:"));
}

describe("the name of a <Skill> link", () => {
  it("is its children when it has them", () => {
    expect(linesOf(skills(<Skill path="/claims" description="Claims work.">Report a claim</Skill>))).toEqual([
      "available_skill: Report a claim — Claims work.",
    ]);
  });

  it("comes from the path without children, never blank", () => {
    expect(linesOf(skills(<Skill path="/report-claim" description="Claims work." />))).toEqual([
      "available_skill: Report claim — Claims work.",
    ]);
  });

  it("comes from the path when the children render no text", () => {
    expect(linesOf(skills(<Skill path="/report-claim" description="Claims work.">{""}</Skill>))).toEqual([
      "available_skill: Report claim — Claims work.",
    ]);
  });

  it("prefers the skill's meta title to the path", () => {
    const meta = new Map([["/report-claim", { title: "Damage reports", description: "From the skill." }]]);
    const app = () => (
      <RoutesMetaProvider metaByPath={meta}>
        <Agent><Skills><Skill path="/report-claim" /></Skills></Agent>
      </RoutesMetaProvider>
    );
    expect(linesOf(app)).toEqual(["available_skill: Damage reports — From the skill."]);
  });
});
