import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Agent, Skill, Skills, Text, Tool } from "./components.js";
import { defineAgent } from "./config.js";
import { AUTHORING_DIAGNOSTIC_CODES, formatAuthoringLocation } from "./authoring.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import type { AgentRoute } from "./routing.js";

function EmptySkill() {
  return <>Context.</>;
}

function DuplicateToolSkill() {
  return (
    <Tool
      name="shared_action"
      description="A deliberately duplicated tool."
      onCall={() => ({ ok: true })}
    />
  );
}

function ProblemAgent() {
  return (
    <Agent>
      <Skills>
        <Skill path="/start" description="Start here.">Start</Skill>
        <Skill path="/reachable">Reachable without a description</Skill>
        <Skill path="/missing" description="Broken target">Missing</Skill>
      </Skills>
    </Agent>
  );
}

const problemRoutes: AgentRoute[] = [
  {
    path: "/start",
    Component: EmptySkill,
    meta: { title: "Start", description: "Start here." },
    moduleId: "src/agents/problem/start/skill.tsx",
    source: `
      export default function Start() {
        return false ? <Skill path="/locked">Locked</Skill> : <>Start</>;
      }
    `,
  },
  {
    path: "/locked",
    Component: EmptySkill,
    meta: { title: "Locked", description: "Only available behind a condition." },
    moduleId: "src/agents/problem/locked/skill.tsx",
    source: `export default function Locked() { return <>Locked.</>; }`,
  },
  {
    path: "/orphan",
    Component: DuplicateToolSkill,
    meta: { title: "Orphan", description: "Never linked." },
    moduleId: "src/agents/problem/orphan/skill.tsx",
    source: `
      export default function Orphan() {
        return <Tool name="shared_action" description="Duplicate" onCall={run} />;
      }
    `,
  },
  {
    path: "/reachable",
    Component: DuplicateToolSkill,
    meta: { title: "Reachable" },
    moduleId: "src/agents/problem/reachable/skill.tsx",
    source: `
      export default function Reachable() {
        return <Tool name="shared_action" description="Duplicate" onCall={run} />;
      }
    `,
  },
];

describe("diagnoseAgentAuthoring", () => {
  it("reports actionable whole-agent authoring problems with stable codes", () => {
    const definition = defineAgent({ app: ProblemAgent });
    const diagnostics = diagnoseAgentAuthoring({
      id: "problem",
      definition,
      routes: problemRoutes,
      source: `
        export function ProblemAgent() {
          return <Skills>
            <Skill path="/start" description="Start here.">Start</Skill>
            <Skill path="/reachable">Reachable without a description</Skill>
            <Skill path="/missing" description="Broken target">Missing</Skill>
          </Skills>;
        }
      `,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute }),
        expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.unreachableSkill }),
        expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.duplicateTool }),
        expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.missingDescription }),
        expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.possiblyLockedBranch }),
      ]),
    );
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message.length).toBeGreaterThan(10);
      expect(diagnostic.fix.length).toBeGreaterThan(10);
      expect(diagnostic.location.agentId).toBe("problem");
    }
  });

  it("returns no findings for a small, fully linked agent", () => {
    function CleanAgent() {
      return (
        <Agent>
          <Skills>
            <Skill path="/start" description="Start here.">Start</Skill>
            <Skill path="/next" description="Continue here.">Next</Skill>
          </Skills>
        </Agent>
      );
    }
    const routes: AgentRoute[] = [
      {
        path: "/start",
        Component: EmptySkill,
        meta: { title: "Start", description: "Start here." },
        source: `export default function Start() { return <>Start.</>; }`,
      },
      {
        path: "/next",
        Component: EmptySkill,
        meta: { title: "Next", description: "Continue here." },
        source: `export default function Next() { return <>Next.</>; }`,
      },
    ];
    const definition = defineAgent({ app: CleanAgent });

    expect(
      diagnoseAgentAuthoring({
        id: "clean",
        definition,
        routes,
        source: `
          export function CleanAgent() {
            return <Skills>
              <Skill path="/start" description="Start here.">Start</Skill>
              <Skill path="/next" description="Continue here.">Next</Skill>
            </Skills>;
          }
        `,
      }),
    ).toEqual([]);
  });
});

function SingleSkillApp() {
  return (
    <Agent>
      <Skills>
        <Skill path="/start">Start</Skill>
      </Skills>
    </Agent>
  );
}

/** Diagnose an agent whose only skill, src/agent/start/skill.tsx, has this source and component. */
function diagnoseSkill(source: string, Component: AgentRoute["Component"] = EmptySkill, projectRoot?: string) {
  return diagnoseAgentAuthoring({
    id: "agent",
    definition: defineAgent({ app: SingleSkillApp }),
    routes: [
      {
        path: "/start",
        Component,
        meta: { title: "Start", description: "Start here." },
        moduleId: "./start/skill.tsx",
        source,
      },
    ],
    projectRoot,
  });
}

describe("prose written as JSX text", () => {
  it("warns with file:line and the template-literal rewrite", () => {
    const diagnostics = diagnoseSkill(
      [
        "export default function Home() {",
        "  return (",
        "    <>",
        "      <Instruction>",
        "        Greet the caller.",
        "        Ask for the `policy` number.",
        "      </Instruction>",
        "      <Text>One line of text.</Text>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const prose = diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.proseJsxText);
    expect(prose).toHaveLength(1);
    expect(prose[0]).toMatchObject({
      severity: "warning",
      location: { agentId: "agent", skillPath: "/start", source: "src/agent/start/skill.tsx", line: 5, component: "Instruction" },
    });
    expect(formatAuthoringLocation(prose[0].location)).toBe("src/agent/start/skill.tsx:5");
    expect(prose[0].fix).toContain(
      "<Instruction>{`\n  Greet the caller.\n  Ask for the \\`policy\\` number.\n`}</Instruction>",
    );
  });

  it("keeps expressions as substitutions, and names JSX children it cannot rewrite", () => {
    const diagnostics = diagnoseSkill(
      [
        "export default function Home() {",
        "  return (",
        "    <>",
        "      <Text>",
        "        Name: {name}",
        "        Email: {email}",
        "      </Text>",
        "      <SystemPrompt>",
        "        You are an agent.",
        "        <b>Never</b> invent tools.",
        "      </SystemPrompt>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const prose = diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.proseJsxText);
    expect(prose.map((diagnostic) => diagnostic.location.component).sort()).toEqual(["SystemPrompt", "Text"]);
    const text = prose.find((diagnostic) => diagnostic.location.component === "Text")!;
    expect(text.fix).toContain("<Text>{`\n  Name: ${name}\n  Email: ${email}\n`}</Text>");
    const systemPrompt = prose.find((diagnostic) => diagnostic.location.component === "SystemPrompt")!;
    expect(systemPrompt.fix).toContain("Keep JSX elements outside the template literal.");
  });

  it("leaves one-line prose, text above an expression, and template literals alone", () => {
    const diagnostics = diagnoseSkill(
      [
        "export default function Home() {",
        "  return (",
        "    <>",
        "      <Instruction>",
        "        Greet the caller.",
        "      </Instruction>",
        "      <Text>",
        "        Open tasks:",
        "        {tasks.join(', ')}",
        "      </Text>",
        "      <SystemPrompt>{`",
        "        Already a template literal.",
        "        Second line.",
        "      `}</SystemPrompt>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    expect(diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.proseJsxText)).toEqual([]);
  });
});

describe("render failures", () => {
  /** The framework package, standing in for a project root: this test file is in its src/. */
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));

  function BrokenSkill() {
    const lookup: Record<string, { label: string }> = {};
    return <Text>{lookup.missing.label}</Text>;
  }

  function MisusedText() {
    return <Text src="policy/coverage-basics.md">Inline text as well.</Text>;
  }

  it("reports the component's own error at the project line that threw", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostics = diagnoseSkill("export default function Broken() { return null; }", BrokenSkill, packageRoot);
    logged.mockRestore();

    const failure = diagnostics.find((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.renderFailed);
    expect(failure?.message).toBe(
      "<BrokenSkill> threw while the agent rendered: Cannot read properties of undefined (reading 'label')",
    );
    expect(failure?.location.component).toBe("BrokenSkill");
    expect(formatAuthoringLocation(failure!.location)).toMatch(/^src\/authoring-diagnostics\.test\.tsx:\d+:\d+$/);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).not.toContain("empty semantic tree");
  });

  it("keeps a framework component's own authoring error, placed in the skill that uses it", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // MisusedText calls no hook, so React cannot place its frame: the skill module it is
    // routed from names the file.
    const diagnostics = diagnoseSkill("export default function Misused() { return null; }", MisusedText, packageRoot);
    logged.mockRestore();

    const failure = diagnostics.find((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.invalidProp);
    expect(failure?.message).toContain("Text received both inline children and src");
    expect(failure?.location).toEqual({ agentId: "agent", source: "src/agent/start/skill.tsx", component: "Text" });
  });
});

describe("tool goals", () => {
  function BookingAgent() {
    return (
      <Agent>
        <Skills>
          <Skill path="/start" description="Start here.">Start</Skill>
        </Skills>
        <Tool name="book_slot" description="Book a webinar slot." onCall={() => ({ ok: true })} />
      </Agent>
    );
  }
  const source = [
    "export const agent = defineAgent({",
    "  app: BookingAgent,",
    "  goals: {",
    '    booked: { tool: "book_slot" },',
    '    paid: { tool: "take_payment" },',
    '    felt_easy: { judge: "The caller says booking was easy." },',
    "  },",
    "});",
  ].join("\n");

  function diagnoseGoals(goals: NonNullable<Parameters<typeof defineAgent>[0]["goals"]>) {
    return diagnoseAgentAuthoring({
      id: "agent",
      definition: defineAgent({ app: BookingAgent, goals }),
      routes: [
        {
          path: "/start",
          Component: EmptySkill,
          meta: { title: "Start", description: "Start here." },
          source: "export default function Start() { return <>Start.</>; }",
        },
      ],
      source,
    }).filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.goalToolNotDeclared);
  }

  it("warns about a goal naming a tool no <Tool> declares, at its line, with the agent's tools", () => {
    const [warning, ...rest] = diagnoseGoals({
      booked: { tool: "book_slot" },
      paid: { tool: "take_payment" },
      felt_easy: { judge: "The caller says booking was easy." },
    });
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({
      severity: "warning",
      message:
        'Goal "paid" is reached when the agent runs tool "take_payment", but no <Tool> in the agent or its skills is named that, so no call can reach it.',
      location: { agentId: "agent", source: "src/agent/agent.tsx", line: 5, component: "defineAgent goals" },
    });
    expect(warning!.fix).toContain('Name one of the agent\'s tools ("book_slot") in goals.paid.tool');
  });

  it("says nothing when every tool goal names a declared tool", () => {
    expect(diagnoseGoals({ booked: { tool: "book_slot" }, felt_easy: { judge: "Easy." } })).toEqual([]);
  });
});
