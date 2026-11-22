import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { judgeAnswer, ran, record, refused, turn } from "../test-fixtures/conversations.js";
import { addTask, calls, hangUp, says, tasksBundle } from "../test-fixtures/tasks.js";
import type { SavedConversation, SavedTestRun } from "../testing/record.js";
import { reviewCommand } from "./review.js";
import { createTestProject } from "./test-project.js";
import { testCommand, type TestHost } from "./test.js";

/**
 * The verdicts `curb test` and `curb review` reach on fixed conversations, pinned from the code
 * as it was before they were rebuilt on `curb/testing`: a saved run re-judged, the same run
 * reviewed, and a hermetic live run. Every model here answers from what its request holds, never
 * from the order requests come in, so the pins hold however the work is scheduled. Each request
 * the caller, the judge and the grouping were sent is pinned too, by a hash of everything a
 * provider receives, so a prompt that changes by one byte fails here.
 */

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

const viewOf = (request: AgentRunRequest) => request.stateSnapshot.join("\n");
const hashOf = (request: AgentRunRequest) =>
  createHash("sha256")
    .update(JSON.stringify({ systemPrompt: request.systemPrompt, skillTitle: request.skillTitle, stateSnapshot: request.stateSnapshot, tools: request.tools, messages: request.messages }))
    .digest("hex")
    .slice(0, 16);

/** The judge: answers from the words of the transcript it is shown. */
function judgeText(request: AgentRunRequest): string {
  const view = viewOf(request);
  if (view.includes("[unreadable]")) return "I cannot say.";
  const answers: Answers = {
    goal: view.includes("[nogoal]") ? "no" : "yes",
    expectation_1: view.includes("booking is") ? "yes" : view.includes("[unknown]") ? "unknown" : "no",
    expectation_2: { answer: "yes", turn: 1, quote: "Hello", reason: "It greets." },
    caller_closed: view.includes("[early]") ? { answer: "no", turn: 2, quote: "One more thing", reason: "The caller was not done." } : "yes",
    unresolved: view.includes("[open]") ? { answer: "yes", turn: 1, quote: "I will check", reason: "Moving the booking: it was only promised." } : "no",
  };
  if (view.includes("Bye! Bye!")) answers.incoherent = { answer: "yes", turn: 2, quote: "Bye! Bye!", reason: "It says bye twice." };
  if (view.includes("What was your name again?")) {
    answers.asked_again = { answer: "yes", turn: 2, quote: "What was your name again?", earlier_turn: 1, reason: "The caller gave the name in turn 1." };
  }
  if (view.includes("[ignored]")) answers.ignored_caller = { answer: "yes", turn: 1, quote: "[ignored]", reason: "It quotes the caller." };
  if (view.includes("I've noted that")) answers.claimed_without_tool = { answer: "yes", turn: 1, quote: "I've noted that", reason: "No tool ran." };
  return judgeAnswer(request, answers);
}

/** The grouping: two patterns, by the numbers of the findings it is shown. */
function groupingText(request: AgentRunRequest): string {
  const numbers = [...viewOf(request).matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
  return JSON.stringify({
    patterns: [
      { title: "Says goodbye twice at the end of the call", findings: numbers.slice(0, 2), scenario: { goal: "Book a haircut", knows: "Name Alex Example", expectation: "The agent says goodbye once." } },
      { title: "Leaves the caller's request open", findings: numbers.slice(2, 3), scenario: { goal: "Move a booking" } },
    ],
  });
}

/** The caller: answers the agent's last line. */
function callerText(request: AgentRunRequest): string {
  const view = viewOf(request);
  if (view.includes("The agent has just ended the call")) return view.includes("Sent to Sam") ? "[still wanted: a copy for me]" : "[hang up: met - done]";
  const last = [...view.matchAll(/^Agent: (.*)$/gm)].at(-1)?.[1] ?? "";
  if (request.systemPrompt.includes("Send my list to Sam")) return last ? "Also send a copy to me." : "Send my list to Sam.";
  if (!last) return "Put milk on my list.";
  return last.includes("list") ? "Thanks, bye! [hang up: met - milk is on the list]" : "Milk, please.";
}

/** The agent: answers the conversation it is shown. */
const agentLlm: AgentLlmClient = async (request): Promise<AgentRunResponse> => {
  const last = request.messages.at(-1);
  if (last?.role === "tool") return says(last.toolName === "add_task" ? "Milk is on your list." : "Sent to Sam.");
  const said = last?.role === "user" ? last.content : "";
  if (/send my list/i.test(said)) return calls({ name: "send_summary", input: { to: "Sam" } });
  if (/copy/i.test(said)) return hangUp("Goodbye.");
  if (/milk/i.test(said)) return calls(addTask("milk"));
  if (/bye/i.test(said)) return hangUp("Bye!");
  return says(/^hi/i.test(said) ? "Hello there." : "Sure.");
};

function pinnedHost() {
  const requests = { caller: [] as string[], judge: [] as string[], grouping: [] as string[] };
  const host: TestHost = {
    async createBundle() {
      const { runtime, session } = tasksBundle(agentLlm);
      return { runtime, session, tokens: () => ({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
    },
    simulator: (_llm, role, onUsage) => async (request) => {
      onUsage({ inputTokens: 7, outputTokens: 3, cacheReadTokens: undefined, cacheWriteTokens: undefined });
      if (role === "caller") {
        requests.caller.push(hashOf(request));
        return says(callerText(request));
      }
      const grouping = !request.systemPrompt.startsWith("You review");
      (grouping ? requests.grouping : requests.judge).push(hashOf(request));
      return says(grouping ? groupingText(request) : judgeText(request));
    },
    models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
  };
  return { host, requests: () => Object.fromEntries(Object.entries(requests).map(([role, hashes]) => [role, [...hashes].sort()])) };
}

/** A report with what differs between two runs of the same code taken out: times, ids, paths. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      ["durationMs", "startedAt", "createdAt", "id", "rejudgedFrom", "savedTo", "curb", "waitedMs"].includes(key) && field !== null ? `<${key}>` : stable(field),
    ]),
  );
}

const BOOKS = `import { scenario } from "curb/testing";
export default scenario({
  name: "books",
  caller: { goal: "Book a haircut", knows: "Name Alex Example, phone 0151 2345678" },
  runs: 5,
  minPassRate: 0.5,
  expectations: ["The agent reads the booking back."],
  failOn: ["incoherent"],
  expect: ({ called, calledInOrder, notCalled, said, endedCall, stateMatches, state, context, check }) => [
    called("book", { service: "haircut" }),
    calledInOrder("list_slots", "book"),
    notCalled("cancel"),
    said(/booking is/i),
    endedCall(),
    stateMatches("calendar", { appointments: [{ service: "Haircut" }] }),
    check("one appointment", (state("calendar") as { appointments: unknown[] }).appointments.length === 1),
    check("context says booked", context.some((line) => line.includes("booked"))),
  ],
});
`;

const HELLO = `import { scenario } from "curb/testing";
export default scenario({ name: "hello", turns: ["Hi", "Thanks", "Bye"], expect: ({ said }) => [said("hello")] });
`;

const booked = { stores: { calendar: { appointments: [{ service: "haircut" }] } }, context: ["content: booked for Tuesday"], skillPath: "" };
const bookingTurns = (closing: string) => [
  turn({ turn: 1, caller: "Hi, I'd like a haircut. I'm Alex Example.", reply: "Sure. Tuesday at 10 is free.", toolCalls: [ran("list_slots", { day: "tuesday" }, "Free: 10:00.")] }),
  turn({ turn: 2, caller: "Tuesday at 10, please.", reply: "Your booking is Tuesday at 10 for a haircut.", toolCalls: [ran("book", { service: "Haircut", time: "10:00" }, "Booked.")] }),
  turn({ turn: 3, caller: "Great, that's all. Bye.", reply: closing, endedCall: true, toolCalls: [ran("end_call", { goodbye: closing })] }),
];
const scenarioOf = (name: string, run: number, mode: "simulated" | "scripted" = "simulated") => ({ name, file: `src/agent/${name}.scenario.ts`, mode, run });
const assessed: SavedConversation["assessment"] = { outcome: "pass", checks: [], notes: [], judge: null };
const saved = (conversation: ReturnType<typeof record>): SavedConversation => ({ ...conversation, assessment: assessed });

/** A run whose conversations hold every case the checks and the judge tell apart. */
function savedRun(): SavedTestRun {
  const caller = { goal: "Book a haircut", knows: "Name Alex Example, phone 0151 2345678" };
  const books = (run: number, overrides: Parameters<typeof record>[1], turns = bookingTurns("Thanks for calling, goodbye.")) =>
    saved(record(turns, { scenario: scenarioOf("books", run), caller, endState: booked, tools: [{ name: "book", description: "Book a slot." }], ...overrides }));
  const conversations: SavedConversation[] = [
    // Passes: booked, read back, the caller was done.
    books(1, { ending: { by: "agent", caller: { done: true, goalMet: true, reason: "booked" } } }),
    // The agent says goodbye twice: a repeated sentence, and incoherent, which the scenario fails on.
    books(2, { ending: { by: "agent", caller: { done: true, goalMet: true, reason: "booked" } } }, bookingTurns("Bye! Bye!")),
    // The caller says the same line three times while the agent moves on: the simulator is stuck.
    books(3, {}, [
      turn({ turn: 1, caller: "Book me in.", reply: "Which day?" }),
      turn({ turn: 2, caller: "Book me in.", reply: "Tuesday or Wednesday?" }),
      turn({ turn: 3, caller: "Book me in.", reply: "I can do Tuesday." }),
    ]),
    // The agent hangs up on a caller who still wanted something, and asks for the name again.
    books(4, { ending: { by: "agent", caller: { done: false, goalMet: null, reason: "a reminder text" } } }, [
      turn({ turn: 1, caller: "Alex Example here, a haircut please. [early]", reply: "Sure." }),
      turn({ turn: 2, caller: "One more thing, can you text me?", reply: "What was your name again? Your booking is Tuesday.", endedCall: true }),
    ]),
    // Invents a phone number, and the judge's answer cannot be read.
    books(5, {}, [turn({ turn: 1, caller: "Call me on 0170 9999999. [unreadable]", reply: "I've noted that." })]),
    // Scripted: the agent hung up before the last line; a fallback line and a refused tool.
    saved(
      record(
        [
          turn({ turn: 1, caller: "Hi", reply: "Hello there." }),
          turn({ turn: 2, caller: "Thanks", reply: "Sorry, something went wrong on my side.", fallback: "Sorry, something went wrong on my side.", toolCalls: [refused("cancel", "Not allowed.")], endedCall: true }),
        ],
        { scenario: scenarioOf("hello", 1, "scripted"), caller: null, ending: { by: "agent", unsaid: ["Bye"], maxTurns: 3, caller: null } },
      ),
    ),
    // A scenario that is gone from the project: its saved settings apply, a finding it fails on.
    saved(
      record(
        [
          turn({ turn: 1, caller: "Hello, I'm Alex. [unknown] [ignored]", reply: "Hello! How can I help you today with your account?" }),
          turn({ turn: 2, caller: "My booking.", reply: "What was your name again?" }),
        ],
        { scenario: scenarioOf("gone", 1), caller: { goal: "Ask about a booking [nogoal]" }, ending: { by: "max_turns", maxTurns: 2, caller: null } },
      ),
    ),
    // The provider failed for good.
    saved(
      record([turn({ turn: 1, caller: "Hi", reply: "Sorry, something went wrong.", errors: [{ kind: "failed", message: "HTTP 529: overloaded" }] })], {
        scenario: scenarioOf("gone", 2),
        caller: { goal: "Ask about a booking" },
        ending: { by: "error", reason: "failed: HTTP 529: overloaded", providerError: true, caller: null },
      }),
    ),
    // Left open: what a review asks.
    saved(record([turn({ turn: 1, caller: "Can you move my booking? [open]", reply: "I will check and call you back." })], { scenario: scenarioOf("gone", 3), caller: { goal: "Move a booking" } })),
  ];
  const settings = (name: string, mode: "simulated" | "scripted", runs: number) => ({ name, file: `src/agent/${name}.scenario.ts`, mode, runs, minPassRate: 1, expectations: [], failOn: [], style: {} });
  return {
    format: "curb.test-run",
    version: 1,
    id: "20300101T000000000Z-pins",
    createdAt: "2030-01-01T00:00:00.000Z",
    curb: "0.0.0",
    complete: true,
    models: { agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" },
    callerPromptVersion: "2",
    judgePromptVersion: "3",
    maxErrorRate: 0.34,
    scenarios: [
      settings("books", "simulated", 5),
      settings("hello", "scripted", 1),
      { ...settings("gone", "simulated", 3), expectations: ["The agent knows the booking is open.", "The agent greets the caller."], failOn: ["asked_again"], style: { wordsP90: 6, questionShare: 0.4 } },
    ],
    conversations,
  };
}

describe("the verdicts on fixed conversations", () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const project = (files: Record<string, string>) => {
    const root = createTestProject(files);
    projects.push(root);
    return root;
  };
  const write = (root: string, path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  it("curb test --rejudge gives the verdicts it gave before, from the same judge requests", async () => {
    const root = project({ "src/agent/books.scenario.ts": BOOKS, "src/agent/hello.scenario.ts": HELLO });
    write(root, "runs/pinned.json", `${JSON.stringify(savedRun())}\n`);
    const { host, requests } = pinnedHost();
    const out: string[] = [];

    const code = await testCommand(["--rejudge", "runs/pinned.json", "--json", "--concurrency", "3"], root, { host, out: (text) => void out.push(text), env: {} });

    const report = JSON.parse(out.join(""));
    const [file] = readdirSync(join(root, ".curb/test-runs"));
    const rejudged = JSON.parse(readFileSync(join(root, ".curb/test-runs", file!), "utf8"));
    await expect(`${JSON.stringify(stable({ code, report, rejudged, requests: requests() }), null, 2)}\n`).toMatchFileSnapshot("./__pins__/rejudge.json");
  });

  it("curb review gives the findings and patterns it gave before, from the same requests", async () => {
    const root = project({});
    write(root, "runs/pinned.json", `${JSON.stringify(savedRun())}\n`);
    write(root, "calls/notes.md", "Caller: Can you move my booking? [open]\nAgent: I will check.\nCaller: Thanks. [early]\nAgent: Bye! Bye!\n");
    const { host, requests } = pinnedHost();
    const out: string[] = [];

    const code = await reviewCommand(["runs/pinned.json", "calls", "--json"], root, { host, out: (text) => void out.push(text), progress: () => {} });

    await expect(`${JSON.stringify(stable({ code, report: JSON.parse(out.join("")), requests: requests() }), null, 2)}\n`).toMatchFileSnapshot("./__pins__/review.json");
  });

  it("curb test plays and judges the same conversations it did before, from the same requests", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({
  name: "adds milk",
  caller: { goal: "Put milk on the list" },
  runs: 2,
  expectations: ["The agent says that milk is on the list."],
  expect: ({ stateMatches }) => [stateMatches("tasks", { tasks: [{ title: "milk" }] })],
});
`,
      "src/agent/send.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ name: "sends", caller: { goal: "Send my list to Sam" }, fakes: { send_summary: { ok: true, message: "Sent." } } });
`,
      "src/agent/hello.scenario.ts": HELLO,
    });
    const { host, requests } = pinnedHost();
    const out: string[] = [];

    const code = await testCommand(["--json", "--concurrency", "2"], root, { host, out: (text) => void out.push(text), env: {} });

    const [file] = readdirSync(join(root, ".curb/test-runs"));
    const saved = JSON.parse(readFileSync(join(root, ".curb/test-runs", file!), "utf8"));
    await expect(`${JSON.stringify(stable({ code, report: JSON.parse(out.join("")), saved, requests: requests() }), null, 2)}\n`).toMatchFileSnapshot("./__pins__/run.json");
  });
});
