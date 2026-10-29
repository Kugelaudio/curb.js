import { describe, expect, it } from "vitest";
import { Agent, AgentSiteRuntime, Instruction, Skill, Skills } from "./index.js";
import { agentAppElement, type AgentRoute } from "./routing.js";

/**
 * A skill's routing description is written once, as `meta.description` in its module. A
 * `<Skill>` link reads it from the routes in context, which the host provides around the
 * whole app, so the skills index of the agent level gets it too.
 */

const routes: AgentRoute[] = [
  {
    path: "/billing",
    Component: () => <Instruction>Answer questions about invoices.</Instruction>,
    meta: { title: "Billing", description: "Use for invoices and payments. NOT for contract changes." },
  },
  {
    path: "/contracts",
    Component: () => <Instruction>Answer questions about contracts.</Instruction>,
    meta: { title: "Contracts", description: "Use for contract changes." },
  },
];

function App() {
  return (
    <Agent>
      <Skills>
        <Skill path="/billing">Billing</Skill>
        <Skill path="/contracts" description="Changing or ending a contract.">
          Contracts
        </Skill>
      </Skills>
    </Agent>
  );
}

describe("skill links on the agent level", () => {
  it("default their description to the target skill's meta.description; an explicit one wins", () => {
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(App, { path, loadedPaths, routes }));
    const links = runtime.snapshot().context.links;

    expect(links.find((link) => link.to === "/billing")?.description).toBe(
      "Use for invoices and payments. NOT for contract changes.",
    );
    expect(links.find((link) => link.to === "/contracts")?.description).toBe("Changing or ending a contract.");
  });
});
