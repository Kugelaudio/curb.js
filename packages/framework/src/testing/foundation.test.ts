import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../llm/types.js";
import { ConversationStore } from "../server/conversation-store.js";
import { judgeAnswer, ran, record, turn } from "../test-fixtures/conversations.js";
import { addTask, calls, hangUp, says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import { Throttle } from "./resilience.js";
import {
  FINDINGS,
  ask,
  builtInChecks,
  converse,
  inParallel,
  judge,
  loadCalls,
  loadRun,
  passRate,
  report,
  saveRun,
  scriptedCaller,
  simulatedCaller,
  startCall,
  testModel,
  type TestHost,
} from "./index.js";

/** A host on the task agent (`test-fixtures/tasks.tsx`) whose agent plays `agent()` afresh on
 * every bundle, and whose models answer `model(request)`. */
function tasksHost(agent: () => Parameters<typeof steps>[0], model: (request: AgentRunRequest) => string = () => "") {
  const stats = { bundles: 0, simulators: [] as string[], requests: [] as AgentRunRequest[] };
  const host: TestHost = {
    async createBundle() {
      stats.bundles += 1;
      const { runtime, session } = tasksBundle(steps(agent()));
      return { runtime, session, experiments: [{ name: "tone", variants: [{ name: "plain", weight: 1 }, { name: "warm", weight: 1 }] }], tokens: () => ({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
    },
    simulator(_llm, role, onUsage, spec) {
      stats.simulators.push(`${role}:${spec ?? ""}`);
      return async (request) => {
        stats.requests.push(request);
        onUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined });
        return says(model(request));
      };
    },
    models: (_llm, chosen = {}) => ({ agent: "openai:gpt-5.2", caller: chosen.caller ?? "openai:gpt-5.4-mini", judge: chosen.judge ?? "openai:gpt-5.4-mini" }),
    throttle: new Throttle(),
  };
  return { host, stats };
}

describe("startCall", () => {
  it("plays turns as a call does and records them, with the tools, the end state and who ended it", async () => {
    const { host } = tasksHost(() => [calls(addTask("milk")), says("Milk is on your list."), hangUp("Bye!")]);
    const call = await startCall({ host, experiments: { tone: "warm" } });

    expect(call.opening).toBeNull();
    const first = await call.say("Put milk on my list.");
    expect(first).toMatchObject({ turn: 1, caller: "Put milk on my list.", reply: "Milk is on your list.", endedCall: false });
    expect(first.toolCalls).toMatchObject([{ name: "add_task", input: { title: "milk" }, ok: true }]);
    expect(call.state("tasks")).toEqual({ tasks: [{ title: "milk", done: false }] });
    expect(() => call.state("nope")).toThrow('state("nope"): the agent had no store "nope" when the call ended. Its stores are "tasks".');
    expect(call.context.join("\n")).toContain("Open tasks: milk.");
    expect(call.experiments).toEqual({ tone: "warm" });
    expect(call.model).toBe("openai:gpt-5.2");

    expect((await call.say("Thanks, bye.")).endedCall).toBe(true);
    expect(call.ended).toBe(true);
    await expect(call.say("Hello?")).rejects.toThrow("call.say: the call has ended: the agent hung up (end_call).");
    const recorded = call.record();
    expect(recorded).toMatchObject({ format: "curb.conversation", version: 1, source: "call", caller: null, experiments: { tone: "warm" } });
    expect(recorded.ending).toEqual({ by: "agent", unsaid: [], maxTurns: 2, caller: null });
    expect(recorded.tools?.map((tool) => tool.name)).toEqual(["add_task", "send_summary"]);
    expect(recorded.endState?.stores).toEqual({ tasks: { tasks: [{ title: "milk", done: false }] } });
    expect(recorded.usage).toMatchObject({ agent: { inputTokens: 5 }, caller: null, judge: null, totalTokens: 6 });
  });

  it("refuses a fake, page info or a variant the agent cannot take, naming each", async () => {
    const { host } = tasksHost(() => []);
    await expect(startCall({ host, fakes: { end_call: { ok: true } } })).rejects.toThrow("startCall: fakes.end_call: end_call is the framework's own tool");
    await expect(startCall({ host, client: { "bad key": "x" } })).rejects.toThrow("startCall: ");
    await expect(startCall({ host, experiments: { tone: "loud", size: "big" } })).rejects.toThrow(
      'startCall: experiments.tone: "loud" is not one of its variants ("plain", "warm"). experiments.size: the agent declares no such experiment (it declares "tone").',
    );
    // A function of the agent's experiments picks from what it declares.
    const call = await startCall({ host, experiments: (declared) => ({ [declared[0]!.name]: declared[0]!.variants[0]!.name }) });
    expect(call.experiments).toEqual({ tone: "plain" });
  });
});

describe("converse", () => {
  it("ends a scripted caller's conversation when every line was said, or at the agent's hang-up with what was left", async () => {
    const { host } = tasksHost(() => [says("Hello."), says("Sure."), hangUp("Bye.")]);
    const done = await converse(await startCall({ host }), scriptedCaller(["Hi", "Thanks"]));
    expect(done.ending).toEqual({ by: "script", unsaid: [], maxTurns: 2, caller: null });

    const cut = await converse(await startCall({ host }), scriptedCaller(["Hi", "Thanks", "One more", "And another"]));
    expect(cut.ending).toEqual({ by: "agent", unsaid: ["And another"], maxTurns: 4, caller: null });
    expect(builtInChecks(cut).find((check) => check.name === "the conversation ends cleanly")).toMatchObject({ pass: false });
  });

  it("takes any function as a caller: null hangs up, a throw breaks the call off, maxTurns cuts it", async () => {
    const { host } = tasksHost(() => [says("Hello."), says("Sure."), says("Okay.")]);
    const heard: number[] = [];
    const hungUp = await converse(await startCall({ host }), (turns) => (turns.length < 2 ? "Hi" : null), { onTurn: (entry) => void heard.push(entry.turn) });
    expect([hungUp.ending.by, hungUp.turns.length, heard]).toEqual(["caller", 2, [1, 2]]);

    const broke = await converse(await startCall({ host }), () => {
      throw Object.assign(new Error("overloaded"), { statusCode: 529 });
    });
    expect(broke.ending).toMatchObject({ by: "simulator", reason: "HTTP 529: overloaded" });

    const capped = await converse(await startCall({ host }), () => "Again", { maxTurns: 2 });
    expect(capped.ending).toMatchObject({ by: "max_turns", maxTurns: 2 });
  });

  it("plays a simulated caller on its model, records it, and asks it whether it was done when the agent hung up", async () => {
    const { host, stats } = tasksHost(
      () => [calls(addTask("milk")), says("Milk is on your list."), hangUp("Bye!")],
      (request) => (request.stateSnapshot.join("\n").includes("The agent has just ended the call") ? "[still wanted: eggs too]" : request.stateSnapshot.join("\n").includes("Milk is on") ? "And eggs?" : "Put milk on my list."),
    );
    const model = await testModel({ host, role: "caller", model: "openai:gpt-5.4-nano" });
    const definition = { goal: "Put milk and eggs on the list" };

    const played = await converse(await startCall({ host }), simulatedCaller(definition, { model }));

    expect(played.caller).toBe(definition);
    expect(played.ending).toEqual({ by: "agent", unsaid: [], maxTurns: 12, caller: { done: false, goalMet: null, reason: "eggs too" } });
    expect(builtInChecks(played).at(-1)).toMatchObject({ name: "the agent does not hang up on a caller who still wants something", pass: false });
    expect(stats.simulators).toEqual(["caller:openai:gpt-5.4-nano"]);
    expect(model.model).toBe("openai:gpt-5.4-nano");
    expect(model.usage()).toEqual({ inputTokens: 9, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(() => simulatedCaller({ goal: "" })).toThrow("simulatedCaller(): caller.goal must say what the caller wants");
    expect(simulatedCaller.promptVersion).toBe("2");
  });
});

describe("testModel", () => {
  it("learns the agent's LLM from one agent, which the next call takes, and asks the host only once asked itself", async () => {
    const { host, stats } = tasksHost(() => [says("Hello.")], () => "fine");
    const model = await testModel({ host });
    expect([stats.bundles, stats.simulators]).toEqual([1, []]);
    expect(await model("Say fine.", "Now.")).toBe("fine");
    expect(stats.requests[0]).toMatchObject({ systemPrompt: "Say fine.", skillTitle: "", stateSnapshot: ["Now."] });
    await startCall({ host });
    expect([stats.bundles, stats.simulators]).toEqual([1, ["judge:"]]);
  });
});

describe("judge and ask", () => {
  const conversation = record([
    turn({ turn: 1, caller: "Book a haircut, I'm Alex.", reply: "Sure. Is there anything else I can help you with?" }),
    turn({ turn: 2, caller: "No.", reply: "Booked. Is there anything else I can help you with?", toolCalls: [ran("book")] }),
  ]);
  const answering = (answers: Parameters<typeof judgeAnswer>[1]) => {
    const requests: AgentRunRequest[] = [];
    const model = async (system: string, input: string) => {
      requests.push({ systemPrompt: system, skillTitle: "", stateSnapshot: [input], tools: [], messages: [] });
      return judgeAnswer(requests.at(-1)!, answers);
    };
    return { model, requests };
  };

  it("asks the goal, the findings it is given (built-in ones in their own words), the expectations, then its own findings", async () => {
    const { model, requests } = answering({ canned_closing: { answer: "yes", turn: 2, quote: "Is there anything else I can help you with?", reason: "A stock line." } });
    const { asked_again, incoherent } = FINDINGS;

    const judged = await judge(conversation, {
      findings: { asked_again, canned_closing: "The agent ends a reply with a stock line.", incoherent },
      expectations: { reads_back: "The agent reads the booking back." },
      model,
    });

    expect(judged.answers.map((answer) => [answer.id, answer.kind])).toEqual([
      ["goal", "goal"],
      ["asked_again", "finding"],
      ["incoherent", "finding"],
      ["reads_back", "expectation"],
      ["canned_closing", "finding"],
    ]);
    expect(requests[0]!.systemPrompt).toContain("- asked_again: Is this true of the call? The agent asked the caller for a specific piece of information");
    expect(judged.findings).toEqual([{ call: "books run 1", kind: "canned_closing", turn: 2, quote: "Is there anything else I can help you with?", reason: "A stock line." }]);
    expect(judge.promptVersion).toBe("3");
  });

  it("answers one question as a check, and a judge that cannot be asked as one not judged", async () => {
    const { model, requests } = answering({ question: { answer: "no", turn: 2, quote: "Booked.", reason: "It never says the time." } });
    expect(await ask(conversation, "The agent says the time of the booking.", { model })).toEqual({
      name: "The agent says the time of the booking.",
      pass: false,
      detail: "It never says the time.",
      evidence: { answer: "no", turn: 2, quote: "Booked." },
    });
    expect(requests[0]!.systemPrompt).not.toContain("- goal:");
    const down = async () => Promise.reject(Object.assign(new Error("down"), { statusCode: 503 }));
    expect(await ask(conversation, "Anything?", { model: down })).toEqual({ name: "Anything?", pass: false, detail: "not judged: HTTP 503: down", notJudged: true });
  });
});

describe("inParallel", () => {
  it("keeps the items' order, holds to the concurrency, and halves it when the provider rate limits", async () => {
    const throttle = new Throttle(() => 0);
    const host: TestHost = { createBundle: () => Promise.reject(new Error("unused")), simulator: () => async () => says(""), throttle };
    let now = 0;
    let most = 0;
    const lowered: number[] = [];
    const results = await inParallel(
      [5, 1, 3, 2],
      async (item, index) => {
        most = Math.max(most, (now += 1));
        if (index === 3) throttle.limited(10, throttle.send());
        await new Promise((resolve) => setTimeout(resolve, item));
        now -= 1;
        return item * 10;
      },
      { concurrency: 4, host, onSlowDown: (concurrency) => void lowered.push(concurrency) },
    );
    expect(results).toEqual([50, 10, 30, 20]);
    expect(most).toBe(4);
    expect(lowered).toEqual([2]);
    await expect(inParallel([1], async () => 1, { concurrency: 0, host })).rejects.toThrow("inParallel: concurrency must be a whole number");
  });
});

describe("passRate and report", () => {
  const passing = [{ name: "says hello", pass: true }];
  const failing = [{ name: "books", pass: false, detail: "never booked" }, { name: "tone", pass: false, reportOnly: true as const }];

  it("counts runs given as outcomes or checks; a report-only or unjudged check fails nothing", () => {
    expect(passRate(["pass", "fail", "error", passing, [{ name: "x", pass: false, notJudged: true as const }]])).toEqual({
      runs: 5,
      passed: 3,
      failed: 1,
      errors: 1,
      passRate: 0.75,
      reliability: 0.237,
      errorRate: 0.2,
    });
    expect(passRate([])).toMatchObject({ passRate: null, reliability: null, errorRate: 0 });
  });

  it("prints, writes Markdown and the job summary, prints JSON, and returns 0, 1 or 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "curb-report-"));
    try {
      const out: string[] = [];
      const summary = join(dir, "summary.md");
      const finding = { call: "call-1", kind: "incoherent", turn: 2, quote: "Bye! Bye!", reason: "It says bye twice." };
      const code = report([{ name: "a", checks: passing }, { name: "b", checks: failing, findings: [finding], notes: ["one run"] }], { out: (text) => void out.push(text), markdown: join(dir, "r/report.md"), env: { GITHUB_STEP_SUMMARY: summary }, title: "claims" });
      expect(code).toBe(1);
      expect(out.join("")).toBe(
        [
          "--- a",
          "  pass  says hello",
          "PASS a",
          "",
          "--- b",
          "  FAIL  books: never booked",
          "  info  tone",
          '  find  incoherent: call call-1 turn 2 "Bye! Bye!" (It says bye twice.)',
          "  note  one run",
          "FAIL b",
          "1 of 2 passed.\n",
        ].join("\n"),
      );
      const markdown = readFileSync(join(dir, "r/report.md"), "utf8");
      expect(markdown).toContain("## claims: failed\n\n1 of 2 passed.\n\n| Name | Outcome | Checks passed | Findings |\n|---|---|---|---|\n| a | pass | 1/1 | 0 |\n| b | fail | 0/2 | 1 |");
      expect(readFileSync(summary, "utf8")).toBe(`${markdown}\n`);

      const json: string[] = [];
      expect(report([{ name: "c", checks: passing, error: "the judge is down" }], { json: true, out: (text) => void json.push(text), env: {} })).toBe(2);
      expect(JSON.parse(json.join(""))).toMatchObject({ passed: false, outcome: "error", exitCode: 2, groups: [{ name: "c", outcome: "error" }] });
      expect(report([], { out: () => {}, env: {} })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("saveRun, loadRun and loadCalls", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => {
    const root = mkdtempSync(join(tmpdir(), "curb-runs-"));
    roots.push(root);
    return root;
  };

  it("saves records of any source as a run a re-judge and a review read, with the agent's version", async () => {
    const root = temp();
    const { host } = tasksHost(() => [says("Hello.")]);
    const call = await startCall({ host });
    await call.say("Hi");

    const { run, path } = saveRun([call.record()], { name: "greets", checks: [[{ name: "said hello", pass: true }]], root });

    expect(path).toBe(`.curb/test-runs/${run.id}.json`);
    expect(run).toMatchObject({ format: "curb.test-run", version: 1, complete: true, agentVersion: null, maxErrorRate: null, scenarios: [{ name: "greets", file: "", mode: "scripted", runs: 1 }] });
    expect(run.conversations[0]).toMatchObject({ source: "call", scenario: { name: "greets", file: "", run: 1 }, assessment: { outcome: "pass", checks: [{ name: "said hello", pass: true }] } });
    expect(Object.keys(run.conversations[0]!).slice(0, 5)).toEqual(["format", "version", "source", "scenario", "caller"]);
    expect(loadRun("latest", { root })).toEqual(JSON.parse(readFileSync(join(root, path), "utf8")));
    expect(loadCalls(path, { root }).calls.map((entry) => [entry.id, entry.source, entry.turns.length])).toEqual([["greets run 1", "call", 1]]);

    // Saved again under its id, it replaces the file.
    saveRun([call.record()], { id: run.id, createdAt: run.createdAt, root });
    expect(loadRun(run.id, { root }).scenarios[0]!.name).toBe("conversations");
  });

  it("records the git commit of the project and whether its files differ from it", () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(root, "agent.txt"), "v1");
    writeFileSync(join(root, ".gitignore"), ".curb/\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "v1");
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    expect(saveRun([], { root }).run.agentVersion).toEqual({ commit, dirty: false });
    writeFileSync(join(root, "agent.txt"), "v2");
    expect(saveRun([], { root }).run.agentVersion).toEqual({ commit, dirty: true });
  });

  it("reads the curb dev store as records, the newest `last` of them", async () => {
    const root = temp();
    const file = join(root, ".data/conversations.jsonl");
    mkdirSync(join(root, ".data"));
    const store = new ConversationStore(file);
    for (const text of ["first", "second"]) {
      const id = await store.startConversation("agent", {});
      await store.recordMessage(id, 0, { role: "user", content: `I am the ${text}.` });
      await store.recordMessage(id, 1, { role: "assistant", content: "Hello." });
    }
    store.close();

    const { calls: read } = loadCalls(".data/conversations.jsonl", { root, last: 1 });

    expect(read.map((entry) => [entry.id, entry.source, entry.turns[0]?.caller, entry.ending.by])).toEqual([["conversation 2", "dev", "I am the second.", null]]);
    expect(loadCalls.shapes).toContain("a saved test run");
  });

  it("reads a written transcript as a record that says it holds no tool calls", () => {
    const root = temp();
    writeFileSync(join(root, "call.md"), "Caller: Hi\nAgent: Hello.\n");
    expect(loadCalls("call.md", { root }).calls[0]).toMatchObject({ source: "transcript", id: "call.md", recordsToolCalls: false, startedAt: null, ending: { by: null } });
  });
});

describe("builtInChecks", () => {
  it("passes the end of a call whose source does not say who ended it", () => {
    const checks = builtInChecks({ ...record([turn({ turn: 1 })]), caller: null, ending: { by: null, unsaid: [], maxTurns: 1, caller: null } });
    expect(checks.map((check) => [check.name, check.pass])).toEqual([
      ["no turn errors", true],
      ["no empty agent reply", true],
      ["no fallback line instead of a reply", true],
      ["no sentence repeated within a turn", true],
      ["the conversation ends cleanly", true],
    ]);
  });
});

