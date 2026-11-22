import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRunResponse } from "curb";
import {
  checksOf,
  compare,
  converse,
  groupFindings,
  inParallel,
  judge,
  loadCalls,
  loadRun,
  passRate,
  report,
  saveRun,
  scriptedCaller,
  startCall,
  testModel,
  type Caller,
  type ConversationRecord,
  type ScenarioCheck,
} from "curb/testing";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticHost, lastCallerLine } from "../test-fixtures/hermetic-host.js";

/**
 * Three harnesses built from `curb/testing` alone, as a team would write its own tests. If one
 * of them needs anything else, the foundation has a gap. Each runs on a hermetic host (the
 * fixture project's agent, with a script in place of its provider); a real harness leaves the
 * host out and runs on the project's own agent and provider.
 */

const says = (text: string): AgentRunResponse => ({ text, toolCalls: [] });
const calls = (name: string, input: Record<string, unknown> = {}): AgentRunResponse => ({ text: "", toolCalls: [{ name, input }] });

/** The insurance agent of the fixture project, played from a script: it reads the claim
 * procedure, walks its three steps, and submits the claim once the procedure is complete. */
function claimsAgent(request: AgentRunRequest): AgentRunResponse {
  const last = request.messages.at(-1);
  if (last?.role === "tool") {
    if (last.toolName === "read_skill") return says("I'm sorry to hear that. Is everyone safe?");
    if (last.toolName === "submit_prepared_claim") return says("Your claim is in. You will get an email shortly.");
    const canSubmit = request.tools.some((tool) => tool.name === "submit_prepared_claim");
    return canSubmit ? calls("submit_prepared_claim", { name: "Alex Example", email: "alex@example.com", summary: "A burst pipe flooded the kitchen." }) : says("Thanks. What comes next?");
  }
  const line = lastCallerLine(request);
  if (/claim/i.test(line)) return calls("read_skill", { skill: "/claim-procedure" });
  if (/safe|photos|alex/i.test(line)) return calls("complete_claim_procedure_stage");
  return says("How can I help you today?");
}

describe("harness 1: a plain test that drives a call and asserts on the agent's state", () => {
  it("files a claim through the procedure, with the submission faked", async () => {
    const call = await startCall({
      host: hermeticHost({ agent: claimsAgent }),
      fakes: { submit_prepared_claim: { ok: true, message: "Claim 42 is open." } },
    });

    await call.say("I need to file a claim for water damage.");
    await call.say("Everyone is safe, the water is off.");
    await call.say("I have photos of the kitchen.");
    const last = await call.say("Alex Example, alex@example.com, a burst pipe in the kitchen.");

    expect(call.state<{ procedureComplete: boolean }>("insurance").procedureComplete).toBe(true);
    expect(last.toolCalls.map((tool) => [tool.name, tool.ok, tool.faked])).toEqual([
      ["complete_claim_procedure_stage", true, undefined],
      ["submit_prepared_claim", true, true],
    ]);
    expect(last.reply).toBe("Your claim is in. You will get an email shortly.");
    const { called, calledInOrder } = checksOf(call.record());
    expect(called("submit_prepared_claim", { email: "alex@example.com" }).pass).toBe(true);
    expect(calledInOrder("read_skill", "complete_claim_procedure_stage", "submit_prepared_claim").pass).toBe(true);
    call.close();
  });
});

describe("harness 2: a script with its own caller and its own judge, in parallel, saved, then reviewed", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The provider of the team's models: a caller prompt and a rubric of their own. */
  const theirModels = (system: string, input: string) => {
    if (system.startsWith("Rate the call")) return /Is everyone safe/.test(input) ? "yes: it asked about safety first" : "no: it never asked whether everyone is safe";
    if (system.startsWith("You review")) {
      return JSON.stringify({ answers: [{ id: "incoherent", answer: "yes", turn: 2, quote: "What comes next?", reason: "It asks the caller what its own procedure is." }] });
    }
    if (system.startsWith("You sort")) return JSON.stringify({ patterns: [{ title: "Asks the caller for the next step of its own procedure", findings: [1, 2, 3], scenario: { goal: "Report a flooded kitchen" } }] });
    return input.includes("Is everyone safe") ? "Everyone is safe." : "I need to file a claim.";
  };

  it("plays every case, judges it with the team's rubric, saves the run, and a review reads it back", async () => {
    root = mkdtempSync(join(tmpdir(), "curb-harness-"));
    const host = hermeticHost({ agent: claimsAgent, model: theirModels });
    const model = await testModel({ host });
    const cases = [{ name: "flooded kitchen" }, { name: "broken window" }, { name: "stolen bike" }];

    // Their caller: one line from their own prompt per turn, and it hangs up after three.
    const theirCaller =
      (testCase: { name: string }): Caller =>
      async (turns) =>
        turns.length >= 3 ? null : model(`You are a caller reporting a ${testCase.name}.`, turns.at(-1)?.reply ?? "");
    const records = await inParallel(cases, async (testCase) => converse(await startCall({ host }), theirCaller(testCase)), { concurrency: 2, host });

    // Their judge: one rubric question per call, answered by the same model.
    const transcript = (record: ConversationRecord) => record.turns.map((turn) => `Caller: ${turn.caller}\nAgent: ${turn.reply}`).join("\n");
    const checks = await inParallel(
      records,
      async (record): Promise<ScenarioCheck[]> => {
        const verdict = await model("Rate the call: did the agent ask about safety first? Answer yes or no, then why.", transcript(record));
        return [{ name: "safety first", pass: verdict.startsWith("yes"), detail: verdict }];
      },
      { concurrency: 2, host },
    );

    const { path, run } = saveRun(records, { name: "claims harness", checks, root });
    const out: string[] = [];
    const code = report(cases.map((testCase, index) => ({ name: testCase.name, checks: checks[index] })), { out: (text) => void out.push(text), env: {} });

    expect(records.map((record) => record.ending.by)).toEqual(["caller", "caller", "caller"]);
    expect(passRate(checks)).toMatchObject({ runs: 3, passed: 3, failed: 0, passRate: 1 });
    expect(code).toBe(0);
    expect(out.join("")).toContain("--- flooded kitchen\n  pass  safety first: yes: it asked about safety first\nPASS flooded kitchen\n");
    expect(loadRun(run.id, { root }).conversations.map((conversation) => conversation.assessment?.outcome)).toEqual(["pass", "pass", "pass"]);

    // What curb review does with the file: read its calls, judge each, sort the findings.
    const { calls: reviewed } = loadCalls(path, { root });
    expect(reviewed.map((record) => record.id)).toEqual(["claims harness run 1", "claims harness run 2", "claims harness run 3"]);
    const judged = await inParallel(reviewed, (record) => judge(record, { model }), { concurrency: 2, host });
    const { patterns } = await groupFindings(judged.flatMap((result) => result.findings), { calls: reviewed.length, model });
    expect(patterns.map((pattern) => [pattern.title, pattern.calls, pattern.share, pattern.kinds])).toEqual([["Asks the caller for the next step of its own procedure", 3, 1, ["incoherent"]]]);
  });
});

describe("harness 3: a blind side-by-side comparison of two versions of an agent", () => {
  it("asks which of two calls sounds more like a person, without saying which version made it", async () => {
    const stiff = hermeticHost({ agent: () => says("Your request has been registered. Is there anything else I can help you with?") });
    const warm = hermeticHost({ agent: () => says("Oh no, I'm sorry. Let's get that sorted.") });
    const lines = ["My kitchen is flooded.", "What do I do now?"];
    // The judge: picks the call without the stock closing line, whichever side it is shown on.
    const judgeHost = hermeticHost({
      agent: () => says(""),
      model: (_system, input) => JSON.stringify({ better: input.split("<<<CALL 2")[0]!.includes("anything else") ? "2" : "1", reason: "It sounds like a person." }),
    });
    const model = await testModel({ host: judgeHost });

    const play = (host: ReturnType<typeof hermeticHost>) => inParallel(lines, async (line) => converse(await startCall({ host }), scriptedCaller([line])), { concurrency: 2, host });
    const [before, after] = [await play(stiff), await play(warm)];
    const result = await compare(before, after, "Which agent sounds more like a person on the phone?", { model });

    expect([result.a, result.b, result.ties]).toEqual([0, 2, 0]);
    expect(result.pairs.map((pair) => [pair.winner, pair.reason])).toEqual([
      ["b", "It sounds like a person."],
      ["b", "It sounds like a person."],
    ]);
  });
});

describe("the examples", () => {
  it("import nothing but curb, the hermetic host and the test runner", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((match) => match[1]);
    expect(imports.filter((from) => !/^(curb|curb\/testing|vitest|node:.*|\.\.\/test-fixtures\/hermetic-host\.js)$/.test(from!))).toEqual([]);
  });
});
