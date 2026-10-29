import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient, type AgentLlmStreamStep } from "../agent-session.js";
import { openingLineOf, type AgentFirstTurn } from "../config.js";
import type { AgentRunRequest, AgentRunResponse, AgentToolCall } from "../llm/types.js";
import { anthropic, openai, openaiCompatible } from "../providers.js";
import { createAgentRuntime, createAgentSession } from "../server/bootstrap.js";
import { AGENT_FIRST_TURN_PROMPT } from "../server/voice/livekit-host/call-opening.js";
import { LISA, bookingRuntime, booked, callsBook, readBackOf, says as booking, scripted, type Booking } from "../test-fixtures/booking.js";
import { END_CALL_TOOL_NAME } from "../types.js";
import { END_CALL_VOICE_STYLE } from "../voice-style.js";
import { createTestProject } from "./test-project.js";
import { parseTestArgs, simulationLlm, testCommand, type ScenarioReport, type TestHost } from "./test.js";
import { typeCheckProject } from "./typecheck.js";

const SPOKEN_RULES = "## Spoken-reply rules (test)";

/** A scripted LLM: each request takes the next response, and every request is kept. */
function scriptedLlm(responses: AgentRunResponse[]) {
  const requests: AgentRunRequest[] = [];
  const llm: AgentLlmClient = async (request) => {
    requests.push(request);
    return responses.shift() ?? { text: "(script ended)", toolCalls: [] };
  };
  return { llm, requests };
}

/** A scripted streaming LLM: each step streams its text word by word, then names its tool calls. */
function scriptedStream(steps: Array<{ text?: string; toolCalls?: AgentToolCall[] }>): AgentLlmStreamStep {
  return async function* () {
    const { text = "", toolCalls = [] } = steps.shift() ?? {};
    let sofar = "";
    for (const word of text.split(/(?<= )/).filter(Boolean)) {
      sofar += word;
      yield { delta: word, text: sofar };
    }
    for (const call of toolCalls) yield { type: "tool-input-start", toolName: call.name };
    return { text: text.trim(), toolCalls };
  };
}

/** An LLM a test never reaches: a scripted scenario never asks the simulator, a streamed one never the plain transport. */
const unused: AgentLlmClient = async () => {
  throw new Error("this LLM is not called in this test");
};

/** The fixture project's agent (AGENT_PROJECT_DIR in vitest.config.ts), as a call builds it. */
function fixtureHost(params: {
  llm: AgentLlmClient;
  streamLlm?: AgentLlmStreamStep;
  simulator?: AgentLlmClient;
  firstTurn?: AgentFirstTurn;
}): TestHost {
  return {
    async createBundle() {
      const { runtime, session } = await createAgentSession(params.llm, params.streamLlm, undefined, {
        spokenStyleSuffix: SPOKEN_RULES,
      });
      return { runtime, session, ...(params.firstTurn ? { firstTurn: params.firstTurn } : {}) };
    },
    simulator: () => params.simulator ?? unused,
  };
}

const say = (text: string, toolCalls: AgentToolCall[] = []): AgentRunResponse => ({ text, toolCalls });
const hangUp = (goodbye: string) => say("", [{ name: END_CALL_TOOL_NAME, input: { goodbye } }]);

const CALLBACK_SCENARIO = `import { scenario } from "curb/testing";

export default scenario({
  name: "requests a callback",
  turns: ["Hi, can an advisor call me back?", "Max Mustermann, 0151 2345678, about my policy", "No, that's all. Bye"],
  expect: ({ called, said, endedCall }) => [called("request_callback", { name: "max mustermann" }), said("advisor"), endedCall()],
});
`;

const CALLBACK_REPLIES = () => [
  say("Sure. What's your name, your number, and what is it about?"),
  say("", [{ name: "request_callback", input: { name: "Max Mustermann", phone: "0151 2345678", topic: "policy" } }]),
  say("Done, an advisor will call you back."),
  hangUp("Glad I could help. Take care."),
];

describe("curb test", () => {
  const projects: string[] = [];
  const project = (files: Record<string, string>) => {
    const root = createTestProject(files);
    projects.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function run(args: string[], root: string, host: TestHost) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host, out: (text) => void out.push(text) });
    return { code, printed: out.join("") };
  }

  it("passes a scripted scenario run as a call: spoken turns, end_call attached, tools for real", async () => {
    const root = project({ "src/agent/callback.scenario.ts": CALLBACK_SCENARIO });
    const agent = scriptedLlm(CALLBACK_REPLIES());

    const { code, printed } = await run(["--json"], root, fixtureHost({ llm: agent.llm }));

    expect(code).toBe(0);
    const report = JSON.parse(printed) as { passed: boolean; scenarios: Array<Extract<ScenarioReport, { mode: string }>> };
    expect(report.passed).toBe(true);
    const [result] = report.scenarios;
    expect(result).toMatchObject({
      name: "requests a callback",
      file: "src/agent/callback.scenario.ts",
      mode: "scripted",
      passed: true,
      endedBy: "agent",
    });
    expect(result.checks.map((check) => [check.name, check.pass])).toEqual([
      ["no turn errors", true],
      ["no empty agent reply", true],
      ["no fallback line instead of a reply", true],
      ["no sentence repeated within a turn", true],
      ["the conversation ends cleanly", true],
      ['called request_callback with {"name":"max mustermann"}', true],
      ['said "advisor"', true],
      ["the agent ended the call", true],
    ]);
    expect(result.turns.map((turn) => [turn.caller, turn.reply, turn.toolCalls.map((call) => `${call.name}:${call.ok}`)])).toEqual([
      ["Hi, can an advisor call me back?", "Sure. What's your name, your number, and what is it about?", []],
      ["Max Mustermann, 0151 2345678, about my policy", "Done, an advisor will call you back.", ["request_callback:true"]],
      ["No, that's all. Bye", "Glad I could help. Take care.", [END_CALL_TOOL_NAME + ":true"]],
    ]);
    // A call's semantics: the spoken rules, and the hang-up tool with its rules.
    const first = agent.requests[0];
    expect(first.tools.map((tool) => tool.name)).toContain(END_CALL_TOOL_NAME);
    expect(first.systemPrompt).toContain(SPOKEN_RULES);
    expect(first.systemPrompt).toContain(END_CALL_VOICE_STYLE[0]);
  });

  it("prints the transcript live and fails a turn that says a sentence twice", async () => {
    const root = project({
      "src/agent/storm.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Does my policy cover storm damage?"] });
`,
    });
    // The first step's "Sure." is out before its tool call shows; the answer starts with it again.
    const streamLlm = scriptedStream([
      { text: "Sure. Let me check that for you.", toolCalls: [{ name: "read_skill", input: { skill: "/policy-questions" } }] },
      { text: "Sure. Your policy covers storm damage." },
    ]);

    const { code, printed } = await run([], root, fixtureHost({ llm: unused, streamLlm }));

    expect(code).toBe(1);
    expect(printed).toContain(
      [
        "--- storm (src/agent/storm.scenario.ts)",
        "caller: Does my policy cover storm damage?",
        '  [tool read_skill ok] {"skill":"/policy-questions"}',
        "agent:  Sure. Sure. Your policy covers storm damage.",
        "  pass  no turn errors",
        "  pass  no empty agent reply",
        "  pass  no fallback line instead of a reply",
        '  FAIL  no sentence repeated within a turn: turn 1 says "Sure." more than once',
        "  pass  the conversation ends cleanly: every scripted caller line was said (1)",
        "  note  this scenario has no checks of its own (expect), so only the built-in checks ran",
        "FAIL storm (1 caller turn(s), ",
      ].join("\n"),
    );
    expect(printed).toMatch(/\n0 of 1 scenario\(s\) passed in \d+\.\ds\. Failed: storm \(src\/agent\/storm\.scenario\.ts\)\n$/);
  });

  it("plays a simulated caller toward its goal, and the judge decides with its reason", async () => {
    const root = project({
      "src/agent/goal.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({
  caller: { goal: "Get an advisor to call back about the policy", knows: "Name Max Mustermann, phone 0151 2345678" },
  expect: ({ called }) => [called("request_callback")],
});
`,
    });
    const agent = scriptedLlm(CALLBACK_REPLIES());
    const callerLines = ["Hi, can an advisor call me back?", "Max Mustermann, 0151 2345678, it's about my policy.", "No, that's all. Bye"];
    const simulatorRequests: AgentRunRequest[] = [];
    const simulator: AgentLlmClient = async (request) => {
      simulatorRequests.push(request);
      if (request.systemPrompt.startsWith("You review")) {
        return say("PASS: The agent recorded the callback request and confirmed it.");
      }
      return say(callerLines.shift() ?? "[hang up]");
    };

    const { code, printed } = await run(["--json"], root, fixtureHost({ llm: agent.llm, simulator }));

    expect(code).toBe(0);
    const [result] = (JSON.parse(printed) as { scenarios: Array<Extract<ScenarioReport, { mode: string }>> }).scenarios;
    expect(result).toMatchObject({ name: "goal", mode: "simulated", passed: true, endedBy: "agent" });
    expect(result.checks.find((check) => check.name === "the caller reaches its goal")).toEqual({
      name: "the caller reaches its goal",
      pass: true,
      detail: "The agent recorded the callback request and confirmed it.",
    });
    // Three caller lines, then the judge: the agent hung up, so the caller was not asked again.
    expect(simulatorRequests).toHaveLength(4);
    const [opening, second] = simulatorRequests;
    expect(opening.systemPrompt).toContain("Your goal for this call: Get an advisor to call back about the policy");
    expect(opening.systemPrompt).toContain("You speak English.");
    expect(opening.stateSnapshot).toContain("Your first line:");
    expect(second.stateSnapshot).toEqual(
      expect.arrayContaining(["You: Hi, can an advisor call me back?", "Agent: Sure. What's your name, your number, and what is it about?"]),
    );
    const judge = simulatorRequests[3];
    expect(judge.stateSnapshot).toEqual(
      expect.arrayContaining([
        '(The agent called the tool request_callback: ok. Input: {"name":"Max Mustermann","phone":"0151 2345678","topic":"policy"})',
        "(The agent ended the call.)",
      ]),
    );
  });

  it("opens with the agent's greeting when the agent speaks first", async () => {
    const root = project({
      "src/agent/hello.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"] });
`,
    });
    const agent = scriptedLlm([say("Hello, this is your insurance line. How can I help?"), hangUp("Thanks for calling. Goodbye.")]);

    const { code, printed } = await run([], root, fixtureHost({ llm: agent.llm, firstTurn: "agent" }));

    expect(code).toBe(0);
    // The hang-up shows as a marker, not as its tool call.
    expect(printed).toContain(
      [
        "--- hello (src/agent/hello.scenario.ts)",
        "agent:  Hello, this is your insurance line. How can I help?",
        "caller: Hi",
        "agent:  Thanks for calling. Goodbye.",
        "  [the agent ended the call]",
      ].join("\n"),
    );
    expect(printed).not.toContain("[tool end_call");
    const greeting = agent.requests[0].messages.at(-1);
    expect(greeting).toMatchObject({ role: "user", content: AGENT_FIRST_TURN_PROMPT, kind: "synthetic" });
  });

  it("opens with the agent's fixed line at turn 0, written from the scenario's page info, with no model call", async () => {
    const root = project({
      "src/agent/webinar.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({
  turns: ["Hallo"],
  client: { event: "Webinar am 11.04." },
  expect: ({ said }) => [said("Webinar am 11.04.")],
});
`,
    });
    const agent = scriptedLlm([say("Gern, worum geht es?")]);
    const firstTurn: AgentFirstTurn = {
      say: (info) => `Ich bin Clara. Schön, dass Sie vom ${String(info["client.event"] ?? "Web")} kommen.`,
    };
    const host: TestHost = {
      async createBundle() {
        const { runtime } = await createAgentRuntime();
        const session = new AgentSession(runtime, agent.llm, { spokenStyleSuffix: SPOKEN_RULES, opening: openingLineOf(firstTurn) });
        return { runtime, session, firstTurn };
      },
      simulator: () => unused,
    };

    const { code, printed } = await run([], root, host);

    expect(code).toBe(0);
    expect(printed).toContain(
      [
        "--- webinar (src/agent/webinar.scenario.ts)",
        "agent:  Ich bin Clara. Schön, dass Sie vom Webinar am 11.04. kommen.",
        "caller: Hallo",
        "agent:  Gern, worum geht es?",
      ].join("\n"),
    );
    // Only the caller's turn called the model, and it saw the opening as its own words.
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0].messages.slice(0, 2).map((message) => [message.role, message.content])).toEqual([
      ["user", "(The conversation has just started.)"],
      ["assistant", "Ich bin Clara. Schön, dass Sie vom Webinar am 11.04. kommen."],
    ]);
  });

  it("fakes the tools a scenario names, prints how the caller's words answered a held action, and notes what fails nothing", async () => {
    const root = project({
      "src/agent/booking.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({
  turns: ["Book Tuesday 15:00 for lisa@example.com", "Ja, passt so. Wie lautet meine Buchungsnummer?", "Ja."],
  fakes: { book_meeting: { ok: true, message: "Booked (fake)." }, send_email: { ok: true } },
});
`,
    });
    const onSubmit = vi.fn(async (input: Booking) => booked(input));
    // The caller's second line is taken as a no; the agent asks again, and the third is a yes.
    const host = (): TestHost => {
      const { llm } = scripted([callsBook(LISA, "c1"), callsBook(LISA, "c2"), booking("Booked, see you on Tuesday.")], ["no", "yes"]);
      return {
        async createBundle() {
          const { runtime } = bookingRuntime(onSubmit);
          return { runtime, session: new AgentSession(runtime, llm) };
        },
        simulator: () => unused,
      };
    };

    const { code, printed } = await run([], root, host());

    expect(code).toBe(0);
    const held = `  [tool book_meeting held] ${JSON.stringify(LISA)} -> runs on the caller's yes to "${readBackOf(LISA)}"`;
    expect(printed).toContain(
      [
        "--- booking (src/agent/booking.scenario.ts)",
        "caller: Book Tuesday 15:00 for lisa@example.com",
        held,
        `agent:  ${readBackOf(LISA)}`,
        "caller: Ja, passt so. Wie lautet meine Buchungsnummer?",
        '  [confirmation no] "Ja, passt so. Wie lautet meine Buchungsnummer?": book_meeting did not run',
        held,
        `agent:  ${readBackOf(LISA)}`,
        "caller: Ja.",
        '  [confirmation yes] "Ja.": book_meeting ran',
        `  [tool book_meeting faked] ${JSON.stringify(LISA)}`,
        "agent:  Booked, see you on Tuesday.",
      ].join("\n"),
    );
    expect(printed).toContain(
      [
        "  pass  the conversation ends cleanly: every scripted caller line was said (3)",
        "  note  the fake for send_email was never used: no call of send_email ran",
        "  note  this scenario has no checks of its own (expect), so only the built-in checks ran",
        "PASS booking (3 caller turn(s), ",
      ].join("\n"),
    );
    expect(onSubmit).not.toHaveBeenCalled();

    const json = await run(["--json"], root, host());
    const [result] = (JSON.parse(json.printed) as { scenarios: Array<Extract<ScenarioReport, { mode: string }>> }).scenarios;
    expect(result.turns.map((turn) => turn.confirmation)).toEqual([
      null,
      {
        tool: "book_meeting",
        readBack: readBackOf(LISA),
        answer: "Ja, passt so. Wie lautet meine Buchungsnummer?",
        verdict: "no",
        ran: false,
      },
      { tool: "book_meeting", readBack: readBackOf(LISA), answer: "Ja.", verdict: "yes", ran: true },
    ]);
    expect(result.turns[2].toolCalls).toEqual([
      { name: "book_meeting", input: LISA, ok: true, result: { ok: true, message: "Booked (fake)." }, faked: true },
    ]);
    expect(result.notes).toHaveLength(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("runs only what the filter matches, reports a broken file as failed, and exits 1 on a failure", async () => {
    const root = project({
      "src/agent/books.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ name: "greets back", turns: ["Hello"], expect: ({ said }) => [said("happy to help")] });
`,
      "src/agent/nested/cancels.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Cancel my meeting"], expect: ({ called }) => [called("cancel_meeting")] });
`,
      "src/agent/broken.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: [] });
`,
    });
    const host = () => fixtureHost({ llm: async () => say("Happy to help.") });

    const byName = await run(["--json", "GREETS"], root, host());
    expect(byName.code).toBe(0);
    expect((JSON.parse(byName.printed) as { scenarios: ScenarioReport[] }).scenarios.map((report) => report.name)).toEqual([
      "greets back",
    ]);

    const byFile = await run(["nested/"], root, host());
    expect(byFile.code).toBe(1);
    expect(byFile.printed).toContain(
      "  FAIL  called cancel_meeting: cancel_meeting was never called; tools that ran: none\nFAIL cancels",
    );

    const all = await run(["--json"], root, host());
    expect(all.code).toBe(1);
    const report = JSON.parse(all.printed) as { passed: boolean; scenarios: ScenarioReport[] };
    expect(report.passed).toBe(false);
    expect(report.scenarios.map((entry) => [entry.name, entry.passed])).toEqual([
      ["greets back", true],
      ["broken", false],
      ["cancels", false],
    ]);
    expect(report.scenarios[1]).toEqual({
      name: "broken",
      file: "src/agent/broken.scenario.ts",
      passed: false,
      error:
        'src/agent/broken.scenario.ts could not be loaded: scenario(): turns must be a non-empty list of caller lines, e.g. ["Hi, I would like to book a call", "Next Tuesday"].',
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run(["refunds"], root, host())).code).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('No scenario matches "refunds". The scenarios are: greets back'));
  });

  it("runs every scenario a file exports, default and named, and fails a file that exports none", async () => {
    const root = project({
      "src/agent/weather.scenario.ts": `import { scenario } from "curb/testing";
export const city = "Hamburg";
export default scenario({ name: "today", turns: ["Weather in " + city + "?"], expect: ({ said }) => [said("happy to help")] });
export const forecast = scenario({ turns: ["And tomorrow?"] });
export const unknownCity = scenario({ name: "an unknown city", turns: ["Weather in Atlantis?"] });
`,
      "src/agent/only-named.scenario.ts": `import { scenario } from "curb/testing";
export const opening = scenario({ turns: ["Hello"] });
`,
      "src/agent/empty.scenario.ts": `export const notAScenario = { turns: ["Hello"] };
`,
    });
    const result = await run(["--json"], root, fixtureHost({ llm: async () => say("Happy to help.") }));
    const report = JSON.parse(result.printed) as { scenarios: ScenarioReport[] };
    expect(report.scenarios.map((entry) => [entry.name, entry.file, entry.passed])).toEqual([
      ["empty", "src/agent/empty.scenario.ts", false],
      ["opening", "src/agent/only-named.scenario.ts", true],
      ["today", "src/agent/weather.scenario.ts", true],
      ["forecast", "src/agent/weather.scenario.ts", true],
      ["an unknown city", "src/agent/weather.scenario.ts", true],
    ]);
    expect(report.scenarios[0]).toMatchObject({
      error: 'src/agent/empty.scenario.ts exports no scenario. Fix: export default scenario({ ... }), with scenario from "curb/testing".',
    });
  });

  it("exits 1 with a starting point when the project has no scenario", async () => {
    const root = project({});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await run([], root, fixtureHost({ llm: unused }))).code).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('import { scenario } from "curb/testing";'));
  });

  it("parses the filter and --json, and refuses an unknown option", () => {
    expect(parseTestArgs(["books", "a", "--json", "call"])).toEqual({ filter: "books a call", json: true });
    expect(() => parseTestArgs(["--watch"])).toThrow("curb test: unknown option --watch.");
  });

  it("simulates the caller on a small model of the agent's own provider", () => {
    expect(simulationLlm(anthropic("claude-sonnet-4-5"))).toEqual(anthropic("claude-haiku-5-5"));
    expect(simulationLlm(openai("gpt-5.2"))).toEqual(openai("gpt-5.4-mini"));
    const local = openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" });
    expect(simulationLlm(local)).toBe(local);
  });
});

describe("scenario files in the type check", () => {
  it("type-check against curb/testing like any project file", async () => {
    const root = createTestProject({
      "src/agent/booking.scenario.ts": `import { scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Book a follow-up call for next week", knows: "Name Max Mustermann", language: "de" },
  maxTurns: 12,
  expect: ({ called, transcript, check }) => [
    called("book_meeting", { email: "max@example.com" }),
    check("asks for the email", transcript.some((turn) => turn.reply.includes("E-Mail"))),
  ],
});
`,
      "src/agent/typo.scenario.ts": `import { scenario } from "curb/testing";

export default scenario({ turns: ["Hi"], expect: ({ calld }) => [calld("book_meeting")] });
`,
    });
    try {
      const result = await typeCheckProject(root, "agent");
      expect(result.checkedFiles).toBe(2);
      expect(result.diagnostics.map((diagnostic) => [diagnostic.message, diagnostic.location.source])).toEqual([
        [expect.stringContaining("Property 'calld' does not exist"), "src/agent/typo.scenario.ts"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
