import type { ComponentType, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { compileSite, CONTEXT_CHARACTER_BUDGET, flattenContext } from "./compiler.js";
import { createSemanticRoot } from "./reconciler.js";
import { Agent, Instruction, Skill, SystemPrompt, Text, Tool, defineTool } from "./components.js";
import { agentAppElement } from "./routing.js";
import { z } from "zod";
import { FixtureApp } from "./test-fixtures/fixture-agent.js";

function compile(loadedPaths: string[]) {
  const root = createSemanticRoot();
  root.render(<FixtureApp path={loadedPaths.at(-1) ?? ""} loadedPaths={loadedPaths} />);
  return compileSite(root.container.root, loadedPaths);
}

/** `Home` as the one loaded skill, "/claims", of an agent whose level is `agentLevel`, rendered
 * the way a host renders an agent app. */
function renderClaims(Home: ComponentType, agentLevel?: ReactNode) {
  const root = createSemanticRoot();
  root.render(
    agentAppElement(() => <Agent>{agentLevel}</Agent>, {
      path: "/claims",
      loadedPaths: ["/claims"],
      routes: [{ path: "/claims", Component: Home }],
    }),
  );
  return root.container.root;
}

describe("compileSite", () => {
  it("assigns scopes: global affordances vs page affordances", () => {
    const { context } = compile(["/alpha"]);

    const ping = context.tools.find((tool) => tool.name === "ping");
    expect(ping?.scope).toBe("global");

    // The Skills registry produces global links; the in-page <Skill> a page link.
    const globalBeta = context.links.find((link) => link.to === "/beta" && link.scope === "global");
    const pageBeta = context.links.find((link) => link.to === "/beta" && link.scope === "page");
    expect(globalBeta?.label).toBe("Beta");
    expect(pageBeta?.label).toBe("Beta (from alpha)");
  });

  it("compiles the agent level with no skill loaded: agent.tsx alone, no path, no title", () => {
    const { context } = compile([]);

    expect(context).toMatchObject({ path: "", title: "", loadedSkills: [], blocks: [] });
    expect(context.systemPrompt).toBe("Fixture system prompt.");
    expect(context.instructions).toEqual(["Route the user to alpha or beta."]);
    expect(context.content).toEqual(["Welcome to the fixture agent."]);
    expect(context.links.map((link) => [link.to, link.scope])).toEqual([
      ["/alpha", "global"],
      ["/beta", "global"],
    ]);
    // Only the agent's own tools: no skill is loaded to add its tools.
    expect(context.tools.map((tool) => tool.name)).toEqual(["ping"]);
    // No skill is active, so the snapshot names none.
    expect(flattenContext(context)).toEqual([
      "instruction: Route the user to alpha or beta.",
      "content: Welcome to the fixture agent.",
      "available_skill: Alpha — First fixture skill.",
      "available_skill: Beta — Second fixture skill.",
      "tool: ping() [global]",
    ]);
  });

  it("compiles an inline <Skill> inside <Text> into text segments + a page link", () => {
    function Home() {
      return (
        <Text>
          reach for{" "}
          <Skill path="/property-damage" description="Assess damage.">
            property damage
          </Skill>{" "}
          when needed.
        </Text>
      );
    }
    const { context } = compileSite(renderClaims(Home), ["/claims"]);

    // The prose renders as ordered segments; only a link ever breaks a run.
    const textBlock = context.blocks.find((block) => block.type === "text");
    expect(textBlock?.segments).toEqual([
      { kind: "text", text: "reach for " },
      { kind: "link", to: "/property-damage", label: "property damage", description: "Assess damage." },
      { kind: "text", text: " when needed." },
    ]);
    // The model sees the flattened prose…
    expect(textBlock?.text).toBe("reach for property damage when needed.");
    expect(context.content).toContain("reach for property damage when needed.");
    // …and the inline skill is a real page link, so it joins the routing index.
    const link = context.links.find((entry) => entry.to === "/property-damage" && entry.scope === "page");
    expect(link?.label).toBe("property damage");
    expect(flattenContext(context)).toContain("available_skill: property damage — Assess damage.");
  });

  it("registers a tool defined as an object and passed via <Tool def={...}>", () => {
    // A tool built with defineTool (typed object) must compile identically to
    // the same tool written inline — same name, description, and arguments.
    const bookMeeting = defineTool({
      name: "book_meeting",
      description: "Book a meeting with an advisor.",
      schema: z.object({ time: z.string().describe("Requested meeting time.") }),
      onSubmit: (input) => ({ ok: true, data: input }),
    });
    function Home() {
      return <Tool def={bookMeeting} />;
    }
    const { context } = compileSite(renderClaims(Home), ["/claims"]);

    const tool = context.tools.find((entry) => entry.name === "book_meeting");
    expect(tool?.description).toBe("Book a meeting with an advisor.");
    expect(tool?.inputSchema.properties.time).toMatchObject({ type: "string" });
  });

  it("compiles every loaded skill but renders blocks only for the active one", () => {
    const { context } = compile(["/alpha", "/beta"]);

    expect(context.path).toBe("/beta");
    expect(context.title).toBe("Beta");
    expect(context.loadedSkills.map((skill) => skill.path)).toEqual(["/alpha", "/beta"]);
    expect(context.loadedSkills.every((skill) => skill.characterCount > 0)).toBe(true);
    expect(context.loadedSkills.find((skill) => skill.path === "/alpha")?.characterCount).toBeGreaterThan(
      "Handle alpha requests.".length,
    );

    // The agent level leads, then BOTH loaded skills, the active one first (skills are
    // walked active-first).
    expect(context.instructions).toEqual([
      "Route the user to alpha or beta.",
      "Handle beta requests.",
      "Handle alpha requests.",
    ]);

    // Renderable blocks come from the active page only.
    const blockTexts = context.blocks
      .filter((block) => block.type === "instruction")
      .map((block) => block.text);
    expect(blockTexts).toEqual(["Handle beta requests."]);

    // Page tools of the inactive-but-loaded skill stay callable.
    const alphaNote = context.tools.find((tool) => tool.name === "alpha_note");
    expect(alphaNote).toMatchObject({ scope: "page", skillPath: "/alpha" });
    // Global tools deliberately have no owning skill.
    expect(context.tools.find((tool) => tool.name === "ping")?.skillPath).toBeUndefined();
  });

  it("resolves tool-name collisions to the most recently loaded skill", async () => {
    const { context, registry } = compile(["/alpha", "/beta"]);

    // One definition survives in the compiled context…
    const shared = context.tools.filter((tool) => tool.name === "shared_tool");
    expect(shared).toHaveLength(1);
    expect(shared[0].description).toBe("Defined by beta.");
    expect(shared[0].skillPath).toBe("/beta");

    // …and the registry executes the winner's handler (beta is active).
    const result = await registry.get("shared_tool")!.handler({});
    expect(result).toEqual({ ok: true, data: { from: "beta" } });
  });

  it("throws on an unknown path instead of degrading silently", () => {
    const root = createSemanticRoot();
    root.render(<FixtureApp path="" loadedPaths={[]} />);
    let thrown: unknown;
    try {
      compileSite(root.container.root, ["/nope"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    expect((thrown as AgentAuthoringError).diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidRoute);
    expect((thrown as AgentAuthoringError).diagnostic.fix.length).toBeGreaterThan(20);
  });

  it("includes context docs placed outside a page in the global content", () => {
    const root = createSemanticRoot();
    root.render(
      <agent-site>
        <agent-context-doc src="company.md" content="Company-wide facts." />
        <agent-page path="/claims" title="Claims">
          <agent-instruction>Help.</agent-instruction>
        </agent-page>
      </agent-site>,
    );

    const { context } = compileSite(root.container.root, ["/claims"]);
    expect(context.content).toContain("Company-wide facts.");
    // Blocks belong to the active page render; a global doc adds none.
    expect(context.blocks.find((block) => block.type === "doc")).toBeUndefined();
  });

  it("treats plain JSX text as factual content without requiring Text", () => {
    const root = createSemanticRoot();
    root.render(
      <agent-site>
        Company-wide support is available around the clock.
        <agent-page path="/claims" title="Claims">
          Ask for the policy number before discussing account details.
          <agent-text>Explicit Text content still works.</agent-text>
        </agent-page>
      </agent-site>,
    );

    const { context } = compileSite(root.container.root, ["/claims"]);
    expect(context.content).toEqual([
      "Company-wide support is available around the clock.",
      "Ask for the policy number before discussing account details.",
      "Explicit Text content still works.",
    ]);
    expect(context.blocks).toContainEqual({
      type: "text",
      text: "Ask for the policy number before discussing account details.",
    });
  });

  it("reports oversized compiled context without sending the diagnostic to the LLM", () => {
    const root = createSemanticRoot();
    const oversized = "x".repeat(CONTEXT_CHARACTER_BUDGET + 1);
    root.render(
      <agent-site>
        <agent-page path="/claims" title="Claims">{oversized}</agent-page>
      </agent-site>,
    );

    const { context } = compileSite(root.container.root, ["/claims"]);
    expect(context.diagnostics).toContainEqual(
      expect.objectContaining({ code: AUTHORING_DIAGNOSTIC_CODES.oversizedContext }),
    );
    expect(flattenContext(context).some((line) => line.includes("AGENT_CONTEXT_TOO_LARGE"))).toBe(
      false,
    );
  });
});

describe("flattenContext", () => {
  it("renders the snapshot lines the LLM sees", () => {
    const { context } = compile(["/alpha", "/beta"]);
    const lines = flattenContext(context);

    expect(lines[0]).toBe("active_skill: Beta");
    expect(lines[1]).toBe("loaded_skills: Alpha, Beta");
    expect(lines).toContain("tool: ping() [global]");
    expect(lines.some((line) => line.startsWith("available_skill: Beta"))).toBe(true);
  });
});

describe("SystemPrompt", () => {
  function Home() {
    return <Text>home</Text>;
  }

  it("compiles to exactly the authored children — nothing prepended or appended", () => {
    const root = renderClaims(Home, <SystemPrompt>You are a test agent.</SystemPrompt>);
    expect(compileSite(root, ["/claims"]).context.systemPrompt).toBe(
      "You are a test agent.",
    );
  });
});

// The JSX transform folds JSX text onto one line before Curb sees it, which turned
// a demo's two paragraphs, heading and list into "Modell X7 (modulares Sensor-
// system für den Außeneinsatz). Zweiter Absatz: ## Regeln - eins - zwei". A template literal
// keeps the lines, and the compiler dedents it.
describe("prose written as a template literal", () => {
  function compileHome(Home: ComponentType, systemPrompt?: string) {
    const agentLevel = systemPrompt === undefined ? null : <SystemPrompt>{systemPrompt}</SystemPrompt>;
    return compileSite(renderClaims(Home, agentLevel), ["/claims"]).context;
  }

  it("keeps paragraphs, headings and lists in the system prompt, instructions and text", () => {
    function Home() {
      return (
        <>
          <Instruction>{`
            Collect the caller's details.

            ## Order
            - name
            - phone number
          `}</Instruction>
          <Text>{`
            Modell X7 (modulares Sensorsystem für den Außeneinsatz).

            Zweiter Absatz.
          `}</Text>
        </>
      );
    }
    const context = compileHome(
      Home,
      `
        You are a support agent.

        ## Rules
        - Answer in one sentence.
        - Never invent prices.
      `,
    );

    expect(context.systemPrompt).toBe(
      "You are a support agent.\n\n## Rules\n- Answer in one sentence.\n- Never invent prices.",
    );
    expect(context.instructions).toEqual(["Collect the caller's details.\n\n## Order\n- name\n- phone number"]);
    expect(context.content).toEqual(["Modell X7 (modulares Sensorsystem für den Außeneinsatz).\n\nZweiter Absatz."]);
    // The preview renders the very text the model reads.
    expect(context.blocks).toContainEqual({ type: "instruction", text: context.instructions[0] });
  });

  it("indents each continuation line under its snapshot entry", () => {
    function Home() {
      return (
        <>
          <Instruction>{`
            Collect the caller's details.

            ## Order
            - name
          `}</Instruction>
          <Instruction>Be brief.</Instruction>
        </>
      );
    }
    const lines = flattenContext(compileHome(Home));

    expect(lines).toContain("instruction: Collect the caller's details.\n\n  ## Order\n  - name");
    expect(lines).toContain("instruction: Be brief.");
  });

  it("compiles one-line prose exactly as before", () => {
    function Home() {
      const name = "Max";
      return (
        <>
          <Instruction>
            Clarify what the user needs, then focus on the most specific topic before
            collecting details.
          </Instruction>
          <Text>Call {name} back.</Text>
        </>
      );
    }
    const context = compileHome(Home);

    expect(context.instructions).toEqual([
      "Clarify what the user needs, then focus on the most specific topic before collecting details.",
    ]);
    expect(context.content).toEqual(["Call Max back."]);
    expect(flattenContext(context)).toEqual([
      "active_skill: Claims",
      "instruction: Clarify what the user needs, then focus on the most specific topic before collecting details.",
      "content: Call Max back.",
    ]);
  });

  it("sets a multi-line block off from a one-line neighbour", () => {
    function Home() {
      return (
        <Instruction>
          {`
            ## Rules
            - one
          `}
          Be brief.
        </Instruction>
      );
    }

    expect(compileHome(Home).instructions).toEqual(["## Rules\n- one\n\nBe brief."]);
  });

  it("keeps an inline <Skill> in place inside multi-line prose", () => {
    function Home() {
      return (
        <Text>
          {`
            For damage to the house, use `}
          <Skill path="/property-damage" description="Assess damage.">
            property damage
          </Skill>
          {`.

            ## Rules
            - one
          `}
        </Text>
      );
    }
    const context = compileHome(Home);
    const block = context.blocks.find((entry) => entry.type === "text");

    expect(context.content).toEqual(["For damage to the house, use property damage.\n\n## Rules\n- one"]);
    expect(block?.segments).toEqual([
      { kind: "text", text: "For damage to the house, use " },
      { kind: "link", to: "/property-damage", label: "property damage", description: "Assess damage." },
      { kind: "text", text: ".\n\n## Rules\n- one" },
    ]);
  });
});
