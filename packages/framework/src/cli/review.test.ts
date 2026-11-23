import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "../llm/types.js";
import { ConversationStore } from "../server/conversation-store.js";
import { isJudgeRequest, judgeAnswer, record, turn } from "../test-fixtures/conversations.js";
import { says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import { loadRun } from "../testing/index.js";
import type { ReviewReport } from "./review-report.js";
import { REVIEW_OPTIONS, parseReviewArgs, reviewCommand } from "./review.js";
import { createTestProject } from "./test-project.js";
import { testCommand } from "./test.js";
import type { TestHost } from "./test.js";

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

/** The id of the call a judge request is about, read from its transcript's first caller line. */
const callOf = (request: AgentRunRequest) => /Caller: \[([\w-]+)\]/.exec(request.stateSnapshot.join("\n"))?.[1] ?? "";

/** The id of the call a request to write a caller from it is about. */
const draftedFrom = (request: AgentRunRequest) => /Caller: \[([\w-]+)\]/.exec(request.stateSnapshot.join("\n"))?.[1] ?? "";
const isDraftRequest = (request: AgentRunRequest) => request.systemPrompt.startsWith("You read one recorded phone call");
const isTopicRequest = (request: AgentRunRequest) => request.systemPrompt.startsWith("You sort the reasons");

/** What a caller written from a call says: what the caller of the call wanted, with an invented name. */
const draftAnswer = (request: AgentRunRequest) =>
  JSON.stringify({ goal: `Move appointment ${draftedFrom(request).toUpperCase()} to Friday`, knows: "Name Sam Example, appointment number 7731", persona: "" });

/**
 * A host whose judge answers `judge(call)` for the call a request is about (an Error fails the
 * request), whose grouping request gets `grouping`, whose requests to write a caller from a call
 * get {@link draftAnswer}, and whose request to sort what callers called about gets `topics`.
 */
function reviewHost(judge: (call: string) => Answers | Error = () => ({}), grouping: (request: AgentRunRequest) => string = () => "", topics: (request: AgentRunRequest) => string = () => "") {
  const stats = { bundles: 0, judged: [] as AgentRunRequest[], grouped: [] as AgentRunRequest[], drafted: [] as AgentRunRequest[], topics: [] as AgentRunRequest[], inFlight: 0, mostInFlight: 0 };
  const host: TestHost = {
    async createBundle() {
      stats.bundles += 1;
      const { runtime, session } = tasksBundle(steps([]));
      return { runtime, session };
    },
    simulator: (_llm, _role, onUsage) => async (request) => {
      onUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined });
      if (isDraftRequest(request)) {
        stats.drafted.push(request);
        return { text: draftAnswer(request), toolCalls: [] };
      }
      if (isTopicRequest(request)) {
        stats.topics.push(request);
        return { text: topics(request), toolCalls: [] };
      }
      if (!isJudgeRequest(request)) {
        stats.grouped.push(request);
        return { text: grouping(request), toolCalls: [] };
      }
      stats.judged.push(request);
      stats.mostInFlight = Math.max(stats.mostInFlight, (stats.inFlight += 1));
      await new Promise((resolve) => setTimeout(resolve, 1));
      stats.inFlight -= 1;
      const answers = judge(callOf(request));
      if (answers instanceof Error) throw answers;
      return { text: judgeAnswer(request, answers), toolCalls: [] };
    },
    models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
  };
  return { host, stats };
}

/** A call of a dashboard export whose first caller line names it. */
const exported = (callId: string, endReason = "caller_ended", reply = "Someone will call you back. Goodbye.") =>
  JSON.stringify({
    callId,
    startedAt: "2030-03-04T09:00:00.000Z",
    endReason,
    transcript: { turns: [{ speaker: "caller", text: `[${callId}] Please move my appointment to Friday.` }, { speaker: "agent", text: reply }] },
  });

const early = (reason = "The caller had not said goodbye."): Answers => ({ caller_closed: { answer: "no", turn: 1, quote: "Please move my appointment", reason } });
const open: Answers = { unresolved: { answer: "yes", turn: 1, quote: "Someone will call you back", reason: "Moving an appointment: only a callback was promised." } };
const asked = (request: AgentRunRequest) => [...request.systemPrompt.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]);

describe("curb review", () => {
  const roots: string[] = [];
  const project = (files: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "curb-review-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function review(args: string[], root: string, host: TestHost) {
    const out: string[] = [];
    const progress: string[] = [];
    const code = await reviewCommand(args, root, { host, out: (text) => void out.push(text), progress: (line) => void progress.push(line), env: {} });
    return { code, printed: out.join(""), progress };
  }

  it("judges every call of an export, sorts the findings into patterns and prints them with counts, quotes, a scenario from a call, and what callers called about", async () => {
    const calls = ["a1", "b2", "c3", "d4", "e5"];
    const root = project({ "calls.jsonl": [...calls.map((id) => exported(id, id === "e5" ? "transfer" : "agent_completed")), JSON.stringify({ callId: "f6", endReason: "caller_ended", transcript: null })].join("\n") });
    const wants = (reason: string): Answers => ({ called_for: { answer: "yes", turn: 1, quote: "Please move my appointment", reason } });
    const { host, stats } = reviewHost(
      (call) =>
        call === "a1" || call === "c3"
          ? { ...early(), ...open, ...wants("Move an appointment to Friday.") }
          : call === "b2"
            ? { ...early(), ...wants("Move an appointment.") }
            : call === "d4"
              ? new Error("HTTP 503: the judge is down")
              : wants("Ask for the address of the studio."),
      () =>
        JSON.stringify({
          patterns: [
            { title: "Promises a callback instead of moving the appointment", findings: [2, 5], scenario: { expectation: "The agent moves the appointment during the call." } },
            { title: "Says goodbye before the caller is done", findings: [1, 3, 4], scenario: { expectation: "The agent stays on the call." } },
          ],
        }),
      () => JSON.stringify({ topics: [{ topic: "Move an appointment", reasons: [1, 2, 3], scenarios: [] }, { topic: "Ask for the address", reasons: [4], scenarios: [] }] }),
    );

    const { code, printed, progress } = await review(["calls.jsonl", "--concurrency", "2"], root, host);

    expect(code).toBe(0);
    expect(printed).toBe(
      [
        "Reviewed 5 call(s): 1 with no finding, 3 with findings, 1 not judged.",
        "Left out 1 call(s) that have no transcript.",
        "",
        "1. Says goodbye before the caller is done",
        "   3 of 4 judged call(s), 75% · ended_early",
        '   call a1, turn 1: "Someone will call you back. Goodbye." (The caller had not said goodbye.)',
        '   call b2, turn 1: "Someone will call you back. Goodbye." (The caller had not said goodbye.)',
        '   call c3, turn 1: "Someone will call you back. Goodbye." (The caller had not said goodbye.)',
        "   Scenario to add (its caller from call a1):",
        '     caller: { goal: "Move appointment A1 to Friday", knows: "Name Sam Example, appointment number 7731" },',
        '     failOn: ["ended_early"],',
        "",
        "2. Promises a callback instead of moving the appointment",
        "   2 of 4 judged call(s), 50% · unresolved",
        '   call a1, turn 1: "Someone will call you back" (Moving an appointment: only a callback was promised.)',
        '   call c3, turn 1: "Someone will call you back" (Moving an appointment: only a callback was promised.)',
        "   Scenario to add (its caller from call a1):",
        '     caller: { goal: "Move appointment A1 to Friday", knows: "Name Sam Example, appointment number 7731" },',
        '     expectations: ["The agent moves the appointment during the call."],',
        "",
        "What callers called about:",
        "  Topic                Calls  Share  Covered by",
        "  Move an appointment      3    75%  no scenario",
        "  Ask for the address      1    25%  no scenario",
        "",
        "Not asked of 5 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.",
        "Not asked of 1 call(s) whose record does not say who ended the call: ended_early.",
        "Not judged: call d4: HTTP 503: the judge is down",
        "Tokens: 990 tokens (judge 900 in / 90 out)",
        "Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again.",
        "",
      ].join("\n"),
    );
    // The agent is not run: one bundle says which provider the judge is on.
    expect(stats.bundles).toBe(1);
    expect(stats.judged).toHaveLength(5);
    expect(stats.mostInFlight).toBe(2);
    expect(stats.grouped).toHaveLength(1);
    // The grouping model writes no caller: each draft's caller is written from the pattern's first call.
    expect(stats.grouped[0]!.systemPrompt).toContain('"scenario":{"expectation":"<one sentence>"}');
    expect(stats.grouped[0]!.systemPrompt).not.toContain("invented names");
    expect(stats.drafted.map(draftedFrom)).toEqual(["a1", "a1"]);
    expect(stats.drafted[0]!.stateSnapshot).toEqual(["<<<TRANSCRIPT", "[turn 1] Caller: [a1] Please move my appointment to Friday.", "[turn 1] Agent: Someone will call you back. Goodbye.", "TRANSCRIPT>>>"]);
    // What the callers called for, one per judged call, sorted in one request.
    expect(stats.topics).toHaveLength(1);
    expect(stats.topics[0]!.stateSnapshot[0]).toBe(
      [
        "<<<REASONS",
        "[1] Move an appointment to Friday.",
        "[2] Move an appointment.",
        "[3] Move an appointment to Friday.",
        "[4] Ask for the address of the studio.",
        "REASONS>>>",
        "<<<SCENARIOS",
        "(The agent has no scenarios.)",
        "SCENARIOS>>>",
      ].join("\n"),
    );
    // An export holds no tool calls, and "transfer" does not say who ended call e5.
    expect(asked(stats.judged.find((request) => callOf(request) === "a1")!)).toEqual(["asked_again", "ignored_caller", "incoherent", "caller_closed", "called_for", "unresolved"]);
    expect(asked(stats.judged.find((request) => callOf(request) === "e5")!)).toEqual(["asked_again", "ignored_caller", "incoherent", "called_for", "unresolved"]);
    expect(stats.judged[0]!.stateSnapshot).toContain("(The agent's tools were not recorded for this call.)");
    expect(progress).toEqual(["Judging 5 call(s) on openai:gpt-5.4-mini, 2 at a time.", "Judged 1 of 5 call(s).", "Judged 2 of 5 call(s).", "Judged 3 of 5 call(s).", "Judged 4 of 5 call(s).", "Sorting 5 finding(s) into patterns."]);
  });

  it("marks each topic callers called about as covered by the project's scenarios, by their goal or their lines", async () => {
    const root = createTestProject({
      "src/agent/move.scenario.ts": 'import { scenario } from "curb/testing";\nexport default scenario({ name: "moves an appointment", caller: { goal: "Move an appointment to another day" } });\n',
      "src/agent/hours.scenario.ts": 'import { scenario } from "curb/testing";\nexport default scenario({ name: "opening hours", turns: ["When are you open?"] });\n',
      "calls.jsonl": ["a1", "b2", "c3"].map((id) => exported(id)).join("\n"),
    });
    roots.push(root);
    const reasons: Record<string, string> = { a1: "Move an appointment.", b2: "Cancel an appointment.", c3: "Ask when the studio opens." };
    const { host, stats } = reviewHost(
      (call): Answers => ({ called_for: { answer: "yes", turn: 1, quote: "Please move", reason: reasons[call]! } }),
      () => "",
      // 3 is in two topics, so in both; 4 names no reason; 9 names no scenario.
      () => JSON.stringify({ topics: [{ topic: "Move an appointment", reasons: [1, 3, 4], scenarios: [2, 9] }, { topic: "Cancel an appointment", reasons: [], scenarios: [] }, { topic: "Opening hours", reasons: [3], scenarios: [1] }] }),
    );

    const { printed } = await review(["calls.jsonl", "--json"], root, host);

    expect(stats.topics[0]!.stateSnapshot[0]!.split("\n").slice(5)).toEqual([
      "<<<SCENARIOS",
      '[1] opening hours: says "When are you open?"',
      "[2] moves an appointment: Move an appointment to another day",
      "SCENARIOS>>>",
    ]);
    expect((JSON.parse(printed) as ReviewReport).coverage).toEqual({
      topics: [
        // A call that wanted two things counts under both; one in no topic is under "Other reasons".
        { topic: "Move an appointment", calls: 2, share: 2 / 3, scenarios: ["moves an appointment"] },
        { topic: "Opening hours", calls: 1, share: 1 / 3, scenarios: ["opening hours"] },
        { topic: "Other reasons", calls: 1, share: 1 / 3, scenarios: [] },
      ],
      unclear: 0,
    });
  });

  it("says so when what callers called about cannot be sorted, and asks nothing when no call showed it", async () => {
    const root = project({ "calls.jsonl": [exported("a1"), exported("b2")].join("\n") });
    const unreadable = reviewHost((call): Answers => (call === "a1" ? { called_for: { answer: "yes", turn: 1, quote: "Please move", reason: "Move an appointment." } } : {}), () => "", () => "no idea");
    const report = JSON.parse((await review(["calls.jsonl", "--json"], root, unreadable.host)).printed) as ReviewReport;
    expect(unreadable.stats.topics).toHaveLength(2);
    expect(report.coverage).toEqual({ topics: [], unclear: 1 });
    expect(report.notes).toEqual(["What callers called about could not be sorted into topics (its answer could not be read)."]);

    const none = reviewHost();
    expect((JSON.parse((await review(["calls.jsonl", "--json"], root, none.host)).printed) as ReviewReport).coverage).toEqual({ topics: [], unclear: 2 });
    expect(none.stats.topics).toEqual([]);
  });

  it("prints the same as one JSON object with --json", async () => {
    const root = project({ "calls.jsonl": [exported("a1", "agent_completed"), exported("b2")].join("\n") });
    const { host } = reviewHost((call) => (call === "a1" ? early() : {}), () => "not json");

    const { code, printed } = await review(["--json", "calls.jsonl"], root, host);

    expect(code).toBe(0);
    expect(JSON.parse(printed)).toEqual({
      calls: { reviewed: 2, withoutFindings: 1, withFindings: 1, notJudged: 0, skipped: 0 },
      patterns: [
        {
          title: "The agent ended the call although the caller had not said goodbye or that they needed nothing else.",
          calls: 1,
          share: 0.5,
          findings: 1,
          kinds: ["ended_early"],
          examples: [{ call: "a1", kind: "ended_early", turn: 1, quote: "Someone will call you back. Goodbye.", reason: "The caller had not said goodbye." }],
          scenario: null,
        },
      ],
      coverage: { topics: [], unclear: 2 },
      notAsked: [{ questions: ["claimed_without_tool", "wrong_tool_use"], calls: 2, why: "without recorded tool calls" }],
      notJudged: [],
      notes: ["The findings could not be sorted into patterns (its answer could not be read): they are listed by kind, without scenarios."],
      judgeModel: "openai:gpt-5.4-mini",
      judgePromptVersion: "3",
      usage: { agent: null, caller: null, judge: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 550 },
      exitCode: 0,
    } satisfies ReviewReport);
    expect(printed.endsWith("}\n")).toBe(true);
  });

  it("reads every call file of a folder, and asks each call what its source can answer", async () => {
    const saved = { ...record([turn({ turn: 1, caller: "[run] Book a haircut.", reply: "Done." })], { tools: [{ name: "book_appointment", description: "Book an appointment." }] }), assessment: null };
    const root = project({
      "calls/a-run.json": JSON.stringify({ format: "curb.test-run", version: 1, conversations: [saved] }),
      "calls/b-export.jsonl": exported("exp"),
      "calls/c-call.md": "**Caller:** [note] Are you open on Sunday?\n**Agent:** We are closed on Sundays.\n",
      "calls/d-dev.json": JSON.stringify({ conversations: [{ id: 3, messages: [{ role: "user", content: "[dev] Hello" }, { role: "assistant", content: "Hi." }] }] }),
      "calls/ignored.csv": "id,text\n1,hello\n",
    });
    const { host, stats } = reviewHost();

    const { code, printed } = await review(["calls"], root, host);

    expect(code).toBe(0);
    expect(printed).toBe(
      [
        "Reviewed 4 call(s): 4 with no finding, 0 with findings, 0 not judged.",
        "",
        "Not asked of 2 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.",
        "Not asked of 2 call(s) whose record does not say who ended the call: ended_early.",
        "Tokens: 440 tokens (judge 400 in / 40 out)",
        "",
      ].join("\n"),
    );
    // No finding: nothing to sort.
    expect(stats.grouped).toEqual([]);
    const questions = Object.fromEntries(stats.judged.map((request) => [callOf(request), asked(request)]));
    const tools = ["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use"];
    expect(questions).toEqual({
      // A saved run records tool calls and who ended the call: here the caller, so it was not ended early.
      run: [...tools, "called_for", "unresolved"],
      // An export records who ended the call (here the caller), but no tool calls.
      exp: ["asked_again", "ignored_caller", "incoherent", "called_for", "unresolved"],
      note: ["asked_again", "ignored_caller", "incoherent", "called_for", "unresolved"],
      // The dev store records tool calls; this conversation never called end_call.
      dev: [...tools, "called_for", "unresolved"],
    });
    expect(stats.judged.find((request) => callOf(request) === "run")!.stateSnapshot).toContain("- book_appointment: Book an appointment.");
  });

  it("asks the tool findings of an export line that carries its tool calls, and shows the judge each one in its turn", async () => {
    const withTools = JSON.stringify({
      ...JSON.parse(exported("tools", "caller_ended", "Done, you are booked for Friday.")),
      transcript: {
        turns: [
          { speaker: "caller", text: "[tools] Please move my appointment to Friday.", startOffsetMs: 1_000, endOffsetMs: 3_000 },
          { speaker: "agent", text: "Done, you are booked for Friday.", startOffsetMs: 5_000, endOffsetMs: 7_000 },
        ],
      },
      toolCalls: [{ name: "move_appointment", offsetMs: 4_000, outcome: "failed", arguments: { day: "friday" }, error: "no free slot" }],
    });
    const root = project({ "calls.jsonl": `${withTools}\n${exported("plain")}\n` });
    const { host, stats } = reviewHost();

    const { code, printed } = await review(["calls.jsonl"], root, host);

    expect(code).toBe(0);
    expect(printed).toContain("Not asked of 1 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.");
    const questions = Object.fromEntries(stats.judged.map((request) => [callOf(request), asked(request)]));
    expect(questions).toEqual({
      tools: ["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use", "called_for", "unresolved"],
      plain: ["asked_again", "ignored_caller", "incoherent", "called_for", "unresolved"],
    });
    const snapshot = stats.judged.find((request) => callOf(request) === "tools")!.stateSnapshot.join("\n");
    expect(snapshot).toContain(
      [
        "[turn 1] Caller: [tools] Please move my appointment to Friday.",
        '[turn 1] (The agent called the tool move_appointment: refused. Input: {"day":"friday"}. Result: no free slot)',
        "[turn 1] Agent: Done, you are booked for Friday.",
      ].join("\n"),
    );
  });

  it("reviews the last conversations of curb dev when no path is given", async () => {
    const root = project();
    mkdirSync(join(root, ".data"));
    const store = new ConversationStore(join(root, ".data", "conversations.jsonl"));
    for (const name of ["one", "two", "three"]) {
      const id = await store.startConversation("agent", {});
      await store.recordMessage(id, 0, { role: "user", content: `[${name}] Is the studio open on Saturday?`, at: 0 });
      await store.recordMessage(id, 1, { role: "assistant", content: "", at: 1, toolCalls: [{ id: "c1", name: "lookup_hours", input: { day: "saturday" } }] });
      await store.recordMessage(id, 2, { role: "tool", content: "", at: 2, toolCallId: "c1", toolName: "lookup_hours", result: { ok: true, message: "9 to 13" }, contextDiff: [] });
      await store.recordMessage(id, 3, { role: "assistant", content: "From nine to one.", at: 3 });
    }
    store.close();
    const { host, stats } = reviewHost((call): Answers => (call === "three" ? { incoherent: { answer: "yes", turn: 1, quote: "From nine to one", reason: "It says the hours twice." } } : {}));

    const all = await review(["--json"], root, host);
    const last = await review(["--last", "2", "--json"], root, host);

    expect((JSON.parse(all.printed) as ReviewReport).calls.reviewed).toBe(3);
    // Recorded conversations are reviewed as they are: nothing is simulated.
    expect((JSON.parse(all.printed) as ReviewReport).simulated).toBeUndefined();
    expect(all.progress[0]).toBe("Judging 3 call(s) on openai:gpt-5.4-mini, 4 at a time.");
    const report = JSON.parse(last.printed) as ReviewReport;
    expect(report.calls).toMatchObject({ reviewed: 2, withFindings: 1 });
    expect(report.patterns[0]?.examples).toEqual([{ call: "conversation 3", kind: "incoherent", turn: 1, quote: "From nine to one", reason: "It says the hours twice." }]);
    expect(stats.judged.at(-1)!.stateSnapshot).toContain('[turn 1] (The agent called the tool lookup_hours: ok. Input: {"day":"saturday"}. Result: 9 to 13)');
  });

  /**
   * A host for a project with no recorded conversation: the task agent says "Added." to every
   * line; the callers request gets 20 callers, c1 to c20; each caller says one line and hangs up,
   * but c5 never hangs up and c20 cannot answer; the judge finds c1 to c3 unresolved; the grouping
   * puts those three into one pattern. `events` is the order caller and judge requests came in.
   */
  function newAgentHost() {
    const stats = { bundles: 0, callers: [] as AgentRunRequest[], judged: [] as AgentRunRequest[], grouped: [] as AgentRunRequest[], drafted: [] as AgentRunRequest[], topics: [] as AgentRunRequest[], events: [] as string[] };
    const said = new Map<string, number>();
    const host: TestHost = {
      async createBundle() {
        stats.bundles += 1;
        const { runtime, session } = tasksBundle(async () => says("Added."));
        return { runtime, session };
      },
      simulator: () => async (request) => {
        const text = (() => {
          if (request.systemPrompt.startsWith("You write test callers")) {
            stats.callers.push(request);
            return JSON.stringify({ callers: Array.from({ length: 20 }, (_, index) => ({ goal: `[c${index + 1}] Add a task`, knows: "Name Alex Example", persona: index === 3 ? "In a hurry" : "", behaviours: index === 3 ? ["impatient"] : [] })) });
          }
          if (request.systemPrompt.startsWith("You are the caller")) {
            const tag = /\[(c\d+)\]/.exec(request.systemPrompt)![1]!;
            stats.events.push(`caller ${tag}`);
            const times = (said.get(tag) ?? 0) + 1;
            said.set(tag, times);
            if (tag === "c20") return "";
            return times === 1 || tag === "c5" ? `[${tag}] Please add a task.` : "Thanks, bye. [hang up: met - the task was added]";
          }
          if (isDraftRequest(request)) {
            stats.drafted.push(request);
            return draftAnswer(request);
          }
          if (isTopicRequest(request)) {
            stats.topics.push(request);
            return JSON.stringify({ topics: [{ topic: "Add a task", reasons: Array.from({ length: 19 }, (_, index) => index + 1), scenarios: [] }] });
          }
          if (isJudgeRequest(request)) {
            stats.judged.push(request);
            const call = callOf(request);
            stats.events.push(`judge ${call}`);
            const wants: Answers = { called_for: { answer: "yes", turn: 1, quote: "Please add a task", reason: "Add a task." } };
            return judgeAnswer(request, ["c1", "c2", "c3"].includes(call) ? { ...wants, unresolved: { answer: "yes", turn: 1, quote: "Added.", reason: "Adding a task: the agent said so, and no task was added." } } : wants);
          }
          stats.grouped.push(request);
          return JSON.stringify({ patterns: [{ title: "Promises a task instead of adding it", findings: [1, 2, 3], scenario: { expectation: "The agent adds the task during the call." } }] });
        })();
        return { text, toolCalls: [] };
      },
      models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
    };
    return { host, stats };
  }

  it("simulates calls when curb dev has recorded none: plays them, judges each as it ends, saves them as a run and reviews them as real calls", async () => {
    const root = project();
    const { host, stats } = newAgentHost();

    const { code, printed, progress } = await review([], root, host);

    expect(code).toBe(0);
    const savedTo = /Saved to (\.curb\/test-runs\/[\w-]+\.json)/.exec(printed)?.[1] ?? "";
    expect(savedTo).not.toBe("");
    expect(printed).toBe(
      [
        `These are 20 simulated call(s), because curb dev has recorded no conversation here yet. Saved to ${savedTo} (npx curb review ${savedTo} reads them again).`,
        "Reviewed 20 call(s): 16 with no finding, 3 with findings, 1 not judged.",
        "",
        "1. Promises a task instead of adding it",
        "   3 of 19 judged call(s), 16% · unresolved",
        '   call simulated run 1, turn 1: "Added." (Adding a task: the agent said so, and no task was added.)',
        '   call simulated run 2, turn 1: "Added." (Adding a task: the agent said so, and no task was added.)',
        '   call simulated run 3, turn 1: "Added." (Adding a task: the agent said so, and no task was added.)',
        "   Scenario to add (its caller from call simulated run 1):",
        '     caller: { goal: "[c1] Add a task", knows: "Name Alex Example" },',
        '     expectations: ["The agent adds the task during the call."],',
        "",
        "What callers called about:",
        "  Topic       Calls  Share  Covered by",
        "  Add a task     19   100%  no scenario",
        "",
        "Not asked of 1 call(s) simulated and cut off at the turn limit: unresolved.",
        "Not judged: call simulated run 20: the call broke off: the simulated caller answered with no line: \"\"",
        "Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again.",
        "",
      ].join("\n"),
    );
    // One request for the callers, one agent per call (the first also told the models which provider).
    expect(stats.callers).toHaveLength(1);
    expect(stats.callers[0]!.stateSnapshot.join("\n")).toContain("- add_task: Add a task to the list.");
    expect(stats.bundles).toBe(21);
    // After the calls: one judge request per call that did not break off, one grouping, one
    // coverage request, and no request to write a draft's caller: a simulated call has its caller.
    expect(stats.judged).toHaveLength(19);
    expect(stats.grouped).toHaveLength(1);
    expect(stats.topics).toHaveLength(1);
    expect(stats.drafted).toEqual([]);
    // A call cut off at the turn limit is not asked whether the caller got what they called for.
    const asked5 = asked(stats.judged.find((request) => callOf(request) === "c5")!);
    expect(asked5).not.toContain("unresolved");
    expect(asked(stats.judged.find((request) => callOf(request) === "c4")!)).toContain("unresolved");
    // The judge starts on the first calls while the others still play.
    expect(stats.events.findIndex((event) => event.startsWith("judge"))).toBeLessThan(stats.events.findLastIndex((event) => event.startsWith("caller")));
    expect(progress).toEqual([
      "curb dev has recorded no conversation here yet, so 20 calls are simulated instead.",
      "Writing 20 callers from what the agent offers on openai:gpt-5.4-mini.",
      "Playing 20 simulated call(s), 4 at a time, at most 8 caller turns each; each is judged as soon as it ends.",
      ...[2, 4, 6, 8, 10, 12, 14, 16, 18].map((done) => `Played ${done} of 20 call(s).`),
      `Saved the 20 simulated call(s) to ${savedTo}.`,
      "Sorting 3 finding(s) into patterns.",
    ]);

    // The saved run holds every call, as curb review and curb test --rejudge read it.
    const saved = loadRun(savedTo, { root });
    expect(saved.conversations).toHaveLength(20);
    expect(saved.models).toEqual({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" });
    expect(saved.conversations[3]).toMatchObject({ source: "call", scenario: { name: "simulated", run: 4, mode: "simulated" }, caller: { goal: "[c4] Add a task", knows: "Name Alex Example", persona: "In a hurry", behaviours: ["impatient"] } });
    const cut = saved.conversations[4]!;
    expect(cut.ending).toMatchObject({ by: "max_turns", maxTurns: 8 });
    expect(cut.turns.filter((turn) => turn.caller !== null)).toHaveLength(8);
    expect(saved.conversations[0]!.ending.by).toBe("caller");

    // Reviewed again from the run, the calls are the same and nothing is simulated.
    const again = newAgentHost();
    const rereview = JSON.parse((await review([savedTo, "--json"], root, again.host)).printed) as ReviewReport;
    expect(rereview.simulated).toBeUndefined();
    // The call whose caller never spoke has no transcript, so it is left out and counted.
    expect(rereview.calls).toMatchObject({ reviewed: 19, withFindings: 3, skipped: 1 });
    expect(rereview.patterns[0]!.scenario).toEqual({ caller: { goal: "[c1] Add a task", knows: "Name Alex Example" }, expectations: ["The agent adds the task during the call."], from: "simulated run 1" });
    expect(again.stats.callers).toEqual([]);
    expect(again.stats.drafted).toEqual([]);

    // curb test --rejudge reads the run too, and judges each call against its caller's goal.
    const rejudged: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await testCommand(["--rejudge", savedTo, "--json"], root, { host: newAgentHost().host, out: (text) => void rejudged.push(text), env: {} });
    const rejudge = JSON.parse(rejudged.join("")) as { scenarios: Array<{ name: string; runs: unknown[] }> };
    expect(rejudge.scenarios.map((scenario) => [scenario.name, scenario.runs.length])).toEqual([["simulated", 20]]);
  });

  it("says in --json that the calls were simulated, and where they were saved", async () => {
    const root = project();
    const { host } = newAgentHost();

    const report = JSON.parse((await review(["--json"], root, host)).printed) as ReviewReport;

    expect(report.simulated).toEqual({ calls: 20, maxTurns: 8, savedTo: expect.stringMatching(/^\.curb\/test-runs\/[\w-]+\.json$/) });
    expect(report.calls).toEqual({ reviewed: 20, withoutFindings: 16, withFindings: 3, notJudged: 1, skipped: 0 });
    // The agent's and the callers' tokens are this review's too: here no provider reported any.
    expect(report.usage).toBeNull();
  });

  it("refuses when no callers can be written, saying what to do instead", async () => {
    const root = project();
    const { host } = reviewHost();
    await expect(review([], root, host)).rejects.toThrow(
      "[CURB_REVIEW_NO_CALLERS] curb dev has recorded no conversation here yet, and no callers could be written to simulate calls: callersFor(): the model's answer held no caller that can run: \"\"\nFix: run npx curb review again; or talk to the agent in the preview (npm run dev), or pass a file of calls: npx curb review <file or folder>.",
    );
  });

  it("counts two calls of the same id as two calls", async () => {
    const root = project({ "march.jsonl": exported("a1", "agent_completed"), "april.jsonl": exported("a1", "agent_completed") });
    const { host } = reviewHost(() => early());

    const { printed } = await review(["march.jsonl", "april.jsonl", "--json"], root, host);

    const [pattern] = (JSON.parse(printed) as ReviewReport).patterns;
    expect(pattern).toMatchObject({ calls: 2, share: 1 });
    expect(pattern!.examples.map((example) => example.call)).toEqual(["a1", "a1 (2)"]);
  });

  it("exits 1 with the report when no call could be judged", async () => {
    const root = project({ "calls.jsonl": [exported("a1"), exported("b2")].join("\n") });
    const { host, stats } = reviewHost(() => new Error("HTTP 401: no such key"));

    const { code, printed } = await review(["calls.jsonl"], root, host);

    expect(code).toBe(1);
    expect(printed).toContain("Reviewed 2 call(s): 0 with no finding, 0 with findings, 2 not judged.\n");
    expect(printed).toContain("Not judged: call a1: HTTP 401: no such key\n");
    expect(stats.grouped).toEqual([]);
  });

  it("leaves out a file of a folder that holds no calls, and names it", async () => {
    const root = project({ "calls/a.jsonl": exported("a1"), "calls/readme.md": "# Calls of March\n" });
    const { host } = reviewHost();

    const { code, printed } = await review(["calls"], root, host);

    expect(code).toBe(0);
    expect(printed).toContain("Reviewed 1 call(s)");
    expect(printed).toContain("Note: Left out 1 file(s) that hold no calls in a shape curb review reads: calls/readme.md.\n");
  });

  it("refuses a file that holds no calls, naming it and the shapes there are", async () => {
    const root = project({ "calls/readme.md": "# Calls of March\n", "empty/notes.csv": "", "only-missing.jsonl": JSON.stringify({ callId: "x", transcript: null }) });
    const { host, stats } = reviewHost();
    const shapes =
      "a saved test run (.curb/test-runs/<id>.json); a Calls export from the KugelAudio dashboard (JSON Lines, one call per line); the output of `npx curb conversations --json`; " +
      'a text or Markdown file with one call, whose lines start with "Caller:" and "Agent:"';

    await expect(review(["calls/readme.md"], root, host)).rejects.toThrow(`[CURB_REVIEW_UNREADABLE] calls/readme.md holds no calls in a shape curb review reads.\nFix: pass ${shapes}.`);
    await expect(review(["calls"], root, host)).rejects.toThrow("[CURB_REVIEW_NO_CALLS] Nothing to review: calls holds no call with a transcript.");
    await expect(review(["march.jsonl"], root, host)).rejects.toThrow("[CURB_REVIEW_NOT_FOUND] No file or folder at march.jsonl.");
    // A folder without call files, an export without transcripts, and a project that never talked.
    await expect(review(["empty"], root, host)).rejects.toThrow("[CURB_REVIEW_NO_CALLS] Nothing to review: empty holds no call with a transcript.");
    await expect(review(["only-missing.jsonl"], root, host)).rejects.toThrow(
      `[CURB_REVIEW_NO_CALLS] Nothing to review: only-missing.jsonl holds no call with a transcript.\nFix: npx curb review <file or folder>, with ${shapes}. Without a path, curb review reviews the conversations of the preview (npm run dev), or simulates calls when there are none.`,
    );
    expect(stats.bundles).toBe(0);
  });

  it("runs on the project's own host: the judge on the agent's provider, and no turn of the agent", async () => {
    // An OpenAI-compatible endpoint in this process: it finds every call ended early, and
    // sorts whatever it is sent into one pattern.
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push(raw);
        const content = raw.includes("You review one recorded phone call")
          ? JSON.stringify({ answers: [{ id: "caller_closed", answer: "no", turn: 1, quote: "Please move my appointment", reason: "The caller had not said goodbye." }] })
          : raw.includes("You read one recorded phone call")
            ? JSON.stringify({ goal: "Move an appointment to Friday", knows: "Name Sam Example" })
            : JSON.stringify({ patterns: [{ title: "Says goodbye right after a promise", findings: [1, 2], scenario: { goal: "Move an appointment" } }] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c1", created: 0, model: "m", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("KUGELAUDIO_API_KEY", "ka_test_0123456789");
    vi.stubEnv("KUGELAUDIO_API_BASE", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = project({ "calls.jsonl": [exported("a1", "agent_completed"), exported("b2", "agent_completed")].join("\n") });
    try {
      const out: string[] = [];
      const code = await reviewCommand(["calls.jsonl", "--json"], root, { out: (text) => void out.push(text), progress: () => {}, env: {} });

      expect(code).toBe(0);
      const report = JSON.parse(out.join("")) as ReviewReport;
      expect(report).toMatchObject({
        calls: { reviewed: 2, withFindings: 2, notJudged: 0 },
        patterns: [{ title: "Says goodbye right after a promise", calls: 2, share: 1, kinds: ["ended_early"], scenario: { caller: { goal: "Move an appointment to Friday", knows: "Name Sam Example" }, failOn: ["ended_early"], from: "a1" } }],
        judgeModel: "kugelaudio:qwen3.8-27b",
        usage: { judge: { inputTokens: 400, outputTokens: 20 }, totalTokens: 420 },
      });
      // Two calls judged, one request to sort them and one to write the draft's caller: the agent itself was never asked.
      expect(bodies).toHaveLength(4);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("takes the options of curb test that apply, and --last", () => {
    expect(REVIEW_OPTIONS).toEqual(["--json", "--last", "--judge-model", "--concurrency"]);
    expect(parseReviewArgs(["calls", "more.jsonl", "--judge-model=openai:gpt-5.2", "--concurrency", "8", "--json"])).toEqual({
      paths: ["calls", "more.jsonl"],
      json: true,
      judgeModel: "openai:gpt-5.2",
      concurrency: 8,
    });
    expect(parseReviewArgs(["--last", "50"])).toEqual({ paths: [], json: false, last: 50 });
    expect(() => parseReviewArgs(["--concurrency", "0"])).toThrow('curb review: --concurrency must be a whole number from 1 to 16; got "0".');
    expect(() => parseReviewArgs(["--last", "0"])).toThrow('curb review: --last must be a whole number of 1 or more; got "0".');
    expect(() => parseReviewArgs(["--last", "5", "calls"])).toThrow("curb review: --last selects conversations of curb dev, and takes no file or folder beside it.");
    expect(() => parseReviewArgs(["--runs", "3"])).toThrow("curb review: unknown option --runs.");
    expect(() => parseReviewArgs(["--judge-model"])).toThrow("curb review: --judge-model needs a value: --judge-model <id>.");
  });
});
