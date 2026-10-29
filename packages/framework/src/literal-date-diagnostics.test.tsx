import { fileURLToPath } from "node:url";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { discoverAgent } from "./agent.node.js";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import type { AgentDefinition } from "./config.js";
import {
  Agent,
  Field,
  GlobalTools,
  Instruction,
  Skill,
  Skills,
  SystemPrompt,
  Text,
  Tool,
  defineAgent,
  z,
} from "./index.js";
import { setBundledPublicMarkdown } from "./public-context.js";
import type { AgentRoute } from "./routing.js";

/**
 * AGENT_LITERAL_DATE through the whole analyzer (`curb check`), so the agent is rendered with
 * every skill loaded and read as the model reads it. A date is reported only when it is written
 * in the project's text, so each test passes the files' text (`source`) as discovery reads it.
 * Messages are written out by hand: they are what a coding agent acts on.
 */

const FIX =
  "Curb tells the model today's date on every message: leave the date out, compute it in code or get it " +
  "from a tool, and keep it only when it never changes, such as a public holiday.";
const AGENT_FILE = "src/agent/agent.tsx";
const SKILL_FILE = "src/agent/kundenkonto/skill.tsx";

const kundenkonto: AgentRoute = {
  path: "/kundenkonto",
  Component: () => <>Fragen zum Kundenkonto.</>,
  meta: { title: "Kundenkonto", description: "Fragen zum Kundenkonto." },
  moduleId: "./kundenkonto/skill.tsx",
};

/** An agent with this system prompt and `children` at its level, linking /kundenkonto. */
function agentApp(prompt: string, children?: ReactNode, linkDescription?: string): AgentDefinition["app"] {
  return function App() {
    return (
      <Agent>
        <SystemPrompt>{prompt}</SystemPrompt>
        <Skills>
          <Skill path="/kundenkonto" description={linkDescription}>
            Kundenkonto
          </Skill>
        </Skills>
        {children}
      </Agent>
    );
  };
}

/** The AGENT_LITERAL_DATE findings, by message, with `agentSource` as the text of the agent's file
 * and `skill.source` as the skill's. The agent must render, so no finding is missing because the
 * scan never ran. */
function findings(options: {
  app: AgentDefinition["app"];
  agentSource?: string;
  skill?: Partial<AgentRoute>;
  config?: Partial<AgentDefinition>;
}): AuthoringDiagnostic[] {
  const diagnostics = diagnoseAgentAuthoring({
    id: "agent",
    definition: defineAgent({ ...options.config, app: options.app }),
    routes: [{ ...kundenkonto, ...options.skill }],
    source: options.agentSource,
  });
  expect(diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.renderFailed)).toEqual([]);
  return diagnostics
    .filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.literalDate)
    .sort((left, right) => (left.message < right.message ? -1 : 1));
}

function warning(message: string, location: AuthoringDiagnostic["location"]): AuthoringDiagnostic {
  return { code: "AGENT_LITERAL_DATE", severity: "warning", message, location: { agentId: "agent", ...location }, fix: FIX };
}

describe("AGENT_LITERAL_DATE", () => {
  it("warns on a date written into the system prompt", () => {
    const agentSource = "<SystemPrompt>Heute ist der 3. Oktober.</SystemPrompt>";
    expect(findings({ app: agentApp("Heute ist der 3. Oktober."), agentSource })).toEqual([
      warning('The system prompt writes the date "3. Oktober" into what the model reads.', {
        source: AGENT_FILE,
        component: "SystemPrompt",
      }),
    ]);
  });

  it("warns on a date written into a skill's instruction, naming the skill", () => {
    const Component: ComponentType = () => <Instruction>Our next opening is October 28.</Instruction>;
    const source = "<Instruction>Our next opening is October 28.</Instruction>";
    expect(findings({ app: agentApp("Du hilfst bei Fragen zum Kundenkonto."), skill: { Component, source } })).toEqual([
      warning(`Skill /kundenkonto's instruction writes the date "October 28" into what the model reads.`, {
        skillPath: "/kundenkonto",
        source: SKILL_FILE,
        component: "Instruction",
      }),
    ]);
  });

  it("warns on a date in a tool's description and its fields, nested ones and <Field>s too", () => {
    const verifyCustomer = z.object({
      customerId: z.string().describe("Customer number, e.g. K-1042."),
      birthYear: z.number().int().describe("Year of birth. Accounts opened before 2020-01-01 have none."),
      addresses: z.array(z.object({ city: z.string().describe("City since 2026-10-01.") })).describe("Known addresses."),
    });
    const Component: ComponentType = () => (
      <Tool
        name="verify_customer"
        description="Check the caller's identity. New rules from November 3rd."
        schema={verifyCustomer}
        onSubmit={() => ({ ok: true })}
      />
    );
    const source = `
      const verifyCustomer = z.object({
        birthYear: z.number().int().describe("Year of birth. Accounts opened before 2020-01-01 have none."),
        addresses: z.array(z.object({ city: z.string().describe("City since 2026-10-01.") })),
      });
      <Tool name="verify_customer" description="Check the caller's identity. New rules from November 3rd." schema={verifyCustomer} />;
    `;
    const app = agentApp(
      "Du hilfst bei Fragen zum Kundenkonto.",
      <GlobalTools>
        <Tool name="book_visit" description="Book a visit to the branch." onSubmit={() => ({ ok: true })}>
          <Field name="day" type="string" description="The day, not before 2026-11-02." />
        </Tool>
      </GlobalTools>,
    );
    const agentSource = '<Field name="day" type="string" description="The day, not before 2026-11-02." />';
    const tool = { skillPath: "/kundenkonto", source: SKILL_FILE, component: 'Tool name="verify_customer"' };
    expect(findings({ app, agentSource, skill: { Component, source } })).toEqual([
      warning(`Tool book_visit's field day writes the date "2026-11-02" into what the model reads.`, {
        source: AGENT_FILE,
        component: 'Tool name="book_visit"',
      }),
      warning(`Tool verify_customer's description writes the date "November 3rd" into what the model reads.`, tool),
      warning(`Tool verify_customer's field addresses[].city writes the date "2026-10-01" into what the model reads.`, tool),
      warning(`Tool verify_customer's field birthYear writes the date "2020-01-01" into what the model reads.`, tool),
    ]);
  });

  it("warns on a date in a <Text src> document, located at the document", () => {
    setBundledPublicMarkdown({ "kundenkonto/feiertage.md": "# Feiertage\n\nAm 3. Oktober 2026 bleibt das Büro zu.\n" });
    const Component: ComponentType = () => <Text src="kundenkonto/feiertage.md" />;
    // The document is its own text. "3. Oktober" and "Oktober 2026" overlap: one date.
    expect(findings({ app: agentApp("Du hilfst bei Fragen zum Kundenkonto."), skill: { Component } })).toEqual([
      warning(
        `Skill /kundenkonto's document context/kundenkonto/feiertage.md writes the date "3. Oktober 2026" into what the model reads.`,
        {
          skillPath: "/kundenkonto",
          source: "context/kundenkonto/feiertage.md",
          component: 'Text src="kundenkonto/feiertage.md"',
        },
      ),
    ]);
  });

  it("warns on a date in a skill link's description, where it is written", () => {
    const message = `Skill /kundenkonto's description writes the date "28. Oktober" into what the model reads.`;
    const agentSource = '<Skill path="/kundenkonto" description="Kontofragen bis zum 28. Oktober.">Kundenkonto</Skill>';
    expect(findings({ app: agentApp("Du hilfst.", undefined, "Kontofragen bis zum 28. Oktober."), agentSource })).toEqual([
      warning(message, { source: AGENT_FILE, component: 'Skill path="/kundenkonto"' }),
    ]);
    // A link without a description of its own shows the target's meta.description.
    const meta = { title: "Kundenkonto", description: "Kontofragen bis zum 28. Oktober." };
    const source = 'export const meta = { title: "Kundenkonto", description: "Kontofragen bis zum 28. Oktober." };';
    expect(findings({ app: agentApp("Du hilfst."), skill: { meta, source } })).toEqual([
      warning(message, { skillPath: "/kundenkonto", source: SKILL_FILE, component: "meta" }),
    ]);
  });

  it("warns on a date in a fixed opening line, never in one a function writes", () => {
    const fixed = 'defineAgent({ app: App, firstTurn: { say: "Guten Tag! Unser Sommerfest ist am 12. September." } });';
    const config = { firstTurn: { say: "Guten Tag! Unser Sommerfest ist am 12. September." } };
    expect(findings({ app: agentApp("Du hilfst."), agentSource: fixed, config })).toEqual([
      warning('The opening line writes the date "12. September" into what the model reads.', {
        source: AGENT_FILE,
        component: "defineAgent",
      }),
    ]);
    const computed = 'defineAgent({ app: App, firstTurn: { say: () => "Guten Tag! Heute ist der 12. September." } });';
    const say = () => "Guten Tag! Heute ist der 12. September.";
    expect(findings({ app: agentApp("Du hilfst."), agentSource: computed, config: { firstTurn: { say } } })).toEqual([]);
  });

  it("warns once per place and date, and skips an MCP server's tools", () => {
    const Component: ComponentType = () => (
      <>
        <Instruction>Am 3. Oktober ist zu.</Instruction>
        <Instruction>Am 3. Oktober ist zu, am 31. Oktober auch.</Instruction>
      </>
    );
    const source =
      "<><Instruction>Am 3. Oktober ist zu.</Instruction><Instruction>Am 3. Oktober ist zu, am 31. Oktober auch.</Instruction></>";
    const app = agentApp(
      "Heute ist der 3. Oktober. Morgen ist nicht der 3. Oktober.",
      <GlobalTools>
        <agent-tool
          id="mcp:linear:search_issues"
          name="linear__search_issues"
          description="Issues updated since 2026-01-01."
          onCall={() => ({ ok: true })}
        />
      </GlobalTools>,
    );
    // The MCP tool's date is written into the agent's file too: only the skip keeps it out.
    const agentSource = [
      "<>",
      "  <SystemPrompt>Heute ist der 3. Oktober. Morgen ist nicht der 3. Oktober.</SystemPrompt>",
      '  <agent-tool id="mcp:linear:search_issues" description="Issues updated since 2026-01-01." />',
      "</>",
    ].join("\n");
    expect(findings({ app, agentSource, skill: { Component, source } }).map((finding) => finding.message)).toEqual([
      `Skill /kundenkonto's instruction writes the date "3. Oktober" into what the model reads.`,
      `Skill /kundenkonto's instruction writes the date "31. Oktober" into what the model reads.`,
      'The system prompt writes the date "3. Oktober" into what the model reads.',
    ]);
  });

  it("stays quiet on a date the code computes, which no file writes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    try {
      const Component: ComponentType = () => (
        <Text>{`Heute ist ${new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long" }).format(new Date())}.`}</Text>
      );
      const source =
        '<Text>{`Heute ist ${new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long" }).format(new Date())}.`}</Text>';
      const app = agentApp("Du hilfst bei Fragen zum Kundenkonto.");
      expect(findings({ app, skill: { Component, source } })).toEqual([]);
      // The model does read "Heute ist 3. Oktober.": written into the file, the same text warns.
      expect(findings({ app, skill: { Component, source: "<Text>Heute ist 3. Oktober.</Text>" } })).toEqual([
        warning(`Skill /kundenkonto's text writes the date "3. Oktober" into what the model reads.`, {
          skillPath: "/kundenkonto",
          source: SKILL_FILE,
          component: "Text",
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet on format examples and versions", () => {
    const quiet = [
      "Ask for the birth date. Format: YYYY-MM-DD (1990-02-28).",
      "Write the birth date as digits, e.g. 1990-02-28.",
      "Frag nach dem Datum, z. B. 2026-12-25.",
      "You run on curb 1.3.10.",
    ];
    // Written into the agent's file, so the format check is what keeps them quiet.
    for (const prompt of quiet) {
      expect(findings({ app: agentApp(prompt), agentSource: `<SystemPrompt>${prompt}</SystemPrompt>` })).toEqual([]);
    }
  });

  it("stays quiet on a date only in the preview config, a tool's tryWith or a code comment", () => {
    function Kundenkonto() {
      // Opened on 2026-10-28.
      return (
        <>
          {/* Seit dem 3. Oktober 2026 neu. */}
          <Instruction>Hilf bei Fragen zum Kundenkonto.</Instruction>
          <Tool
            name="book_visit"
            description="Book a visit to the branch."
            schema={z.object({ day: z.iso.date().describe("The day of the visit.") })}
            tryWith={{ day: "2026-11-02" }}
            onSubmit={() => ({ ok: true })}
          />
        </>
      );
    }
    // Every date is written into the files: the scan never reads where they are.
    const source = `
      // Opened on 2026-10-28.
      export default function Kundenkonto() {
        return (
          <>
            {/* Seit dem 3. Oktober 2026 neu. */}
            <Instruction>Hilf bei Fragen zum Kundenkonto.</Instruction>
            <Tool name="book_visit" description="Book a visit to the branch." tryWith={{ day: "2026-11-02" }} />
          </>
        );
      }
    `;
    const agentSource =
      'defineAgent({ app: App, preview: { suggestedPrompts: ["Habt ihr am 3. Oktober offen?"], chatPlaceholder: "Termin am 2026-10-28" } });';
    const preview = { suggestedPrompts: ["Habt ihr am 3. Oktober offen?"], chatPlaceholder: "Termin am 2026-10-28" };
    expect(
      findings({
        app: agentApp("Du hilfst bei Fragen zum Kundenkonto."),
        agentSource,
        skill: { Component: Kundenkonto, source },
        config: { preview },
      }),
    ).toEqual([]);
  });

  it("finds no date in the hermetic fixture project", async () => {
    const agent = await discoverAgent(fileURLToPath(new URL("./test-fixtures/project/src/agent/", import.meta.url)));
    const diagnostics = diagnoseAgentAuthoring(agent);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.renderFailed)).toEqual([]);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.literalDate)).toEqual([]);
  });
});
