import { describe, expect, it } from "vitest";
import { AgentRouter, diagnoseAgentRouterLeftovers } from "./agent-router-migration.js";
import { AUTHORING_DIAGNOSTIC_CODES, formatAuthoringLocation } from "./authoring.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import { Agent, Skill, Skills, Tool } from "./components.js";
import { defineAgent, type AgentAppProps } from "./config.js";
import { agentAppElement, type AgentRoute } from "./routing.js";
import { AgentSiteRuntime } from "./runtime.js";

/**
 * A project from before `<Agent>` rendered the skills: its app takes the host's props and hands
 * them to `<AgentRouter>`. It keeps working, each skill rendered once, and gets one warning that
 * says what to delete.
 */

const OLD_AGENT_SOURCE = [
  'import { Agent, AgentRouter, Skill, Skills, defineAgent, type AgentAppProps } from "curb";',
  "",
  "export function App({ path, loadedPaths, routes }: AgentAppProps) {",
  "  return (",
  "    <Agent>",
  "      <Skills>",
  '        <Skill path="/notes">Notes</Skill>',
  "      </Skills>",
  "      <AgentRouter path={path} loadedPaths={loadedPaths} routes={routes} />",
  "    </Agent>",
  "  );",
  "}",
  "",
  "export const agent = defineAgent({ app: App });",
].join("\n");

function OldApp({ path, loadedPaths, routes }: AgentAppProps) {
  return (
    <Agent>
      <Skills>
        <Skill path="/notes">Notes</Skill>
      </Skills>
      <AgentRouter path={path} loadedPaths={loadedPaths} routes={routes} />
    </Agent>
  );
}

const notes: AgentRoute = {
  path: "/notes",
  Component: () => <Tool name="save_note" description="Save a note." onCall={() => ({ ok: true })} />,
  meta: { title: "Notes", description: "Use for notes the caller wants kept." },
  moduleId: "./notes/skill.tsx",
  source: 'export default function Notes() { return <Tool name="save_note" description="Save a note." onCall={save} />; }',
};

describe("a project that still renders <AgentRouter>", () => {
  it("opens its skills from <Agent>, each rendered once", () => {
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) =>
      agentAppElement(OldApp, { path, loadedPaths, routes: [notes] }),
    );

    runtime.loadSkill("/notes");

    const { context } = runtime.snapshot();
    expect(context.loadedSkills.map((skill) => skill.path)).toEqual(["/notes"]);
    expect(context.tools.filter((tool) => tool.name === "save_note")).toHaveLength(1);
  });

  it("gets one warning, at the <AgentRouter>, saying what to delete, and nothing else", () => {
    const diagnostics = diagnoseAgentAuthoring({
      id: "agent",
      definition: defineAgent({ app: OldApp }),
      routes: [notes],
      source: OLD_AGENT_SOURCE,
    });

    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, formatAuthoringLocation(diagnostic.location)])).toEqual([
      [AUTHORING_DIAGNOSTIC_CODES.agentRouterRemoved, "warning", "src/agent/agent.tsx:9:7"],
    ]);
    expect(diagnostics[0]!.message).toBe(
      "<AgentRouter> renders nothing any more: <Agent> renders every skill the conversation opens.",
    );
    expect(diagnostics[0]!.fix).toBe(
      "Delete this <AgentRouter ... /> and its import, and the path, loadedPaths and routes props " +
        "of the app component: export function App() { ... }.",
    );
  });

  it("is found in any source that renders it, and not once it is deleted", () => {
    const migrated = OLD_AGENT_SOURCE.split("\n")
      .filter((line) => !line.includes("<AgentRouter"))
      .join("\n");
    const diagnostics = diagnoseAgentRouterLeftovers("agent", [
      { file: "src/agent/agent.tsx", source: migrated },
      { file: "src/agent/notes/skill.tsx", source: "export default () => <curb.AgentRouter path={p} routes={r} />;" },
      // Not a file of the project: nothing to point at.
      { source: OLD_AGENT_SOURCE },
      // Does not parse: the authoring analysis reports that.
      { file: "src/agent/broken/skill.tsx", source: "export default () => <AgentRouter" },
    ]);

    expect(diagnostics.map((diagnostic) => formatAuthoringLocation(diagnostic.location))).toEqual([
      "src/agent/notes/skill.tsx:1:22",
    ]);
  });
});
