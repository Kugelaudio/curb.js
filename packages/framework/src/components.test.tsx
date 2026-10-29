import { describe, expect, it, vi } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { Agent, Instruction, Skill, Skills, Text, Tool } from "./components.js";
import { createSemanticRoot } from "./reconciler.js";
import { agentAppElement, type AgentRoute } from "./routing.js";
import { AgentSiteRuntime } from "./runtime.js";
import type { SemanticNode } from "./types.js";

/**
 * `<Agent>` renders the agent level (its children), then every skill the conversation has
 * opened, from the loaded paths the host renders the app with (`agentAppElement`). An app takes
 * no props and renders no router.
 */

const routes: AgentRoute[] = [
  {
    path: "/billing",
    Component: () => (
      <>
        <Instruction>Answer questions about invoices.</Instruction>
        <Tool name="send_invoice" description="Send an invoice again." onCall={() => ({ ok: true })} />
      </>
    ),
    meta: { title: "Invoices", description: "Use for invoices." },
  },
  {
    path: "/contracts",
    Component: () => <Instruction>Answer questions about contracts.</Instruction>,
    meta: { description: "Use for contracts." },
  },
];

function App() {
  return (
    <Agent>
      <Text>Welcome.</Text>
      <Skills>
        <Skill path="/billing">Billing</Skill>
        <Skill path="/contracts">Contracts</Skill>
      </Skills>
    </Agent>
  );
}

function hostedRuntime(app = App, appRoutes = routes) {
  return new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(app, { path, loadedPaths, routes: appRoutes }));
}

/** The paths of the skill pages in `node`'s tree, in tree order. */
function pagePaths(node: SemanticNode | null): string[] {
  if (!node) return [];
  const own = node.type === "agent-page" ? [String(node.props.path)] : [];
  return [...own, ...node.children.flatMap(pagePaths)];
}

describe("<Agent>", () => {
  it("renders the agent level, then every opened skill once, least recently used first", () => {
    const runtime = hostedRuntime();
    expect(pagePaths(runtime.tree())).toEqual([]);

    runtime.loadSkill("/billing");
    runtime.loadSkill("/contracts");

    const { context } = runtime.snapshot();
    expect(pagePaths(runtime.tree())).toEqual(["/billing", "/contracts"]);
    // The title is the module's meta.title, else derived from the path.
    expect(context.loadedSkills.map((skill) => [skill.path, skill.title])).toEqual([
      ["/billing", "Invoices"],
      ["/contracts", "Contracts"],
    ]);
    expect(context.content).toEqual(["Welcome."]);
    expect(context.tools.filter((tool) => tool.name === "send_invoice")).toHaveLength(1);
  });

  it("renders no skill outside a host's render", () => {
    const root = createSemanticRoot();
    root.render(<App />);

    expect(pagePaths(root.container.root)).toEqual([]);
  });

  it("refuses a loaded path no skill module defines, naming the paths there are", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let thrown: unknown;
    try {
      new AgentSiteRuntime(() => agentAppElement(App, { path: "/refunds", loadedPaths: ["/refunds"], routes }));
    } catch (error) {
      thrown = error;
    } finally {
      vi.restoreAllMocks();
    }

    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    expect((thrown as AgentAuthoringError).diagnostic).toMatchObject({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
      message: '<Agent> cannot open "/refunds" because no skill module defines that route.',
      location: { skillPath: "/refunds", component: "Agent" },
      fix: 'Create the matching skill module or navigate to one of: "/billing", "/contracts".',
    });
  });

  it("renders a skill once even when an <Agent> is nested in the agent level or in the skill", () => {
    function Nested() {
      return (
        <Agent>
          <Instruction>A skill that wraps itself in an agent.</Instruction>
        </Agent>
      );
    }
    function NestingApp() {
      return (
        <Agent>
          <Agent>
            <Skills>
              <Skill path="/nested" description="Use for the nested skill.">Nested</Skill>
            </Skills>
          </Agent>
        </Agent>
      );
    }
    const runtime = hostedRuntime(NestingApp, [{ path: "/nested", Component: Nested }]);

    runtime.loadSkill("/nested");

    expect(pagePaths(runtime.tree())).toEqual(["/nested"]);
  });
});
