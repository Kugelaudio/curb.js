import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgentFromRegistry, setBundledAgentRegistry } from "./agent-registry.node.js";
import { AUTHORING_DIAGNOSTIC_CODES, formatAuthoringLocation } from "./authoring.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import { Agent, Skill, Skills } from "./components.js";
import { defineAgent, type AgentDefinition } from "./config.js";
import { isRemovedOptionTypeError } from "./home-skill-migration.js";
import { AgentSiteRuntime } from "./runtime.js";
import { agentAppElement, type AgentRoute } from "./routing.js";
import { discoverSkillRoutes, readHomeSkillFile } from "./routing.node.js";

/**
 * A project from before the agent level: a home skill at src/agent/skill.tsx (path "/"),
 * loaded first by `initialPath` and linked from the skills index. None of it runs any more,
 * and each leftover is one error that names its file and says what to move.
 */

const OLD_AGENT_SOURCE = [
  'import { Agent, Skill, Skills, defineAgent } from "curb";',
  "",
  "export function App() {",
  "  return (",
  "    <Agent>",
  "      <Skills>",
  '        <Skill path="/">Today</Skill>',
  "      </Skills>",
  "    </Agent>",
  "  );",
  "}",
  "",
  'export const agent = defineAgent({ app: App, initialPath: "/" });',
].join("\n");

const HOME_SOURCE = `export default function Today() {
  return (
    <>
      <Instruction>{\`Help the caller plan the day.\`}</Instruction>
      <Tool name="add_task" description="Add a task." onSubmit={add} />
      <Tool name="wrap_up_day" description="Wrap up the day." onSubmit={wrap} />
      <Skill path="/notes">Notes</Skill>
    </>
  );
}
`;

function OldApp() {
  return (
    <Agent>
      <Skills>
        <Skill path="/">Today</Skill>
      </Skills>
    </Agent>
  );
}

function Notes() {
  return <>No notes yet.</>;
}

/** Linked from the home skill only. */
const notes: AgentRoute = {
  path: "/notes",
  Component: Notes,
  meta: { title: "Notes", description: "Use for notes the caller wants kept." },
  moduleId: "./notes/skill.tsx",
  source: "export default function Notes() { return <>No notes yet.</>; }",
};

/** The definition an old agent.tsx exports: the option is gone from the type, not from the
 * object. */
function withStartOption(value: string): AgentDefinition {
  return { ...defineAgent({ app: OldApp }), initialPath: value } as AgentDefinition;
}

describe("a project from before the agent level", () => {
  it("gets one error per leftover, each naming its file and what to move, and nothing else", () => {
    const diagnostics = diagnoseAgentAuthoring({
      id: "agent",
      definition: withStartOption("/"),
      routes: [notes],
      source: OLD_AGENT_SOURCE,
      homeSkill: { moduleId: "./skill.tsx", source: HOME_SOURCE },
    });

    // Not "/" as an unknown route, not its link without a description, not /notes as
    // unreachable: its link is about to move into the <Skills> list with the rest.
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, formatAuthoringLocation(diagnostic.location)])).toEqual([
      [AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved, "error", "src/agent/agent.tsx:7:9"],
      [AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved, "error", "src/agent/agent.tsx:13:46"],
      [AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved, "error", "src/agent/skill.tsx"],
    ]);
    const [link, option, file] = diagnostics;
    expect(link!.fix).toMatch(/^Delete this <Skill path="\/"> link\./);
    expect(option!.message).toBe(
      'defineAgent({ initialPath: "/" }) does nothing any more: every conversation starts at the agent level, with no skill loaded.',
    );
    expect(option!.fix).toBe("Delete the initialPath line from defineAgent in src/agent/agent.tsx.");
    expect(file!.fix).toBe(
      "Move its instructions into the <SystemPrompt> of src/agent/agent.tsx, its tools into <GlobalTools> " +
        "(add_task, wrap_up_day), and its <Skill> links into the agent's <Skills> list (/notes), then delete src/agent/skill.tsx.",
    );
  });

  it("says that a skill initialPath named stays a skill and opens when needed", () => {
    const [option] = diagnoseAgentAuthoring({
      id: "agent",
      definition: withStartOption("/notes"),
      routes: [notes],
    }).filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved);

    expect(option!.message).toContain('initialPath: "/notes"');
    expect(option!.fix).toContain("/notes stays a skill and opens when needed");
  });

  it("keeps working at the agent level: read_skill never offers a <Skill path=\"/\"> link", async () => {
    function App() {
      return (
        <Agent>
          <Skills>
            <Skill path="/" description="Back to the start.">Today</Skill>
            <Skill path="/notes">Notes</Skill>
          </Skills>
        </Agent>
      );
    }
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(App, { path, loadedPaths, routes: [notes] }));

    const { context, stateSnapshot } = runtime.snapshot();
    expect(context.links.map((link) => link.to)).toEqual(["/notes"]);
    expect(stateSnapshot.filter((line) => line.startsWith("available_skill:"))).toEqual([
      "available_skill: Notes — Use for notes the caller wants kept.",
    ]);
    const refused = await runtime.callTool("read_skill", { skill: "/" });
    expect(refused.result).toMatchObject({ ok: false, message: expect.stringContaining('Pass one of: "/notes".') });
    expect(runtime.snapshot().context.loadedSkills).toEqual([]);
  });

  it("leaves the type check's error for the removed option to the diagnostic above", () => {
    const message = "Object literal may only specify known properties, and 'initialPath' does not exist in type 'AgentDefinition'.";
    expect(isRemovedOptionTypeError(2353, message)).toBe(true);
    expect(isRemovedOptionTypeError(2353, message.replace("initialPath", "initialPth"))).toBe(false);
    expect(isRemovedOptionTypeError(2304, "Cannot find name 'initialPath'.")).toBe(false);
  });
});

describe("discovery of the agent folder's own skill.tsx", () => {
  it("reads it as text, never imports it, and keeps it out of the skills", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "curb-home-skill-"));
    try {
      // Importing it would throw: discovery must only read it.
      writeFileSync(join(agentDir, "skill.tsx"), 'throw new Error("the home skill was imported");\n');
      mkdirSync(join(agentDir, "notes"));
      writeFileSync(join(agentDir, "notes", "skill.tsx"), "export default function Notes() {\n  return null;\n}\n");

      expect((await discoverSkillRoutes(agentDir)).map((route) => route.path)).toEqual(["/notes"]);
      expect(readHomeSkillFile(agentDir)).toEqual({
        moduleId: "./skill.tsx",
        source: 'throw new Error("the home skill was imported");\n',
      });
      rmSync(join(agentDir, "skill.tsx"));
      expect(readHomeSkillFile(agentDir)).toBeUndefined();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("is kept out of a built artifact's skills too, as text for its render check", () => {
    function Today() {
      return null;
    }
    setBundledAgentRegistry({
      agentModules: { "./agent/agent.tsx": { agent: defineAgent({ app: OldApp }) } },
      agentSources: { "./agent/agent.tsx": OLD_AGENT_SOURCE },
      skillModules: { "./agent/skill.tsx": { default: Today }, "./agent/notes/skill.tsx": { default: Notes, meta: notes.meta } },
      skillSources: { "./agent/skill.tsx": HOME_SOURCE, "./agent/notes/skill.tsx": notes.source! },
    });

    const discovered = discoverAgentFromRegistry();

    expect(discovered.routes.map((route) => route.path)).toEqual(["/notes"]);
    expect(discovered.homeSkill).toEqual({ moduleId: "./skill.tsx", source: HOME_SOURCE });
  });
});
