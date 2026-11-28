import type { AgentRunRequest, AgentRunResponse } from "curb";
import { checksOf, scenario, startCall, type TestHost } from "curb/testing";
import { describe, expect, it } from "vitest";
import * as ClaimProcedure from "../test-fixtures/project/src/agent/claim-procedure/skill.js";
import * as Coverage from "../test-fixtures/project/src/agent/policy-questions/coverage/skill.js";
import * as PolicyQuestions from "../test-fixtures/project/src/agent/policy-questions/skill.js";
import { hermeticHost } from "../test-fixtures/hermetic-host.js";
import { turn } from "../test-fixtures/conversations.js";

/**
 * Starting a call inside a skill (`start`), and typed turns (`spoken: false`), on the fixture
 * project's agent as discovery loads it: the skill modules imported here are the ones its routes
 * hold.
 */

const STAGE_TOOL = "complete_claim_procedure_stage";
const says = (text: string): AgentRunResponse => ({ text, toolCalls: [] });

/** A host on the fixture agent that keeps every request the agent's model got, and answers each
 * with one line; `onBundle` sees each runtime as it is built. */
function recordingHost(onBundle?: (bundle: Awaited<ReturnType<TestHost["createBundle"]>>) => void) {
  const requests: AgentRunRequest[] = [];
  const inner = hermeticHost({
    agent: (request) => {
      requests.push(request);
      return says("Sure.");
    },
  });
  const host: TestHost = {
    ...inner,
    async createBundle() {
      const bundle = await inner.createBundle();
      onBundle?.(bundle);
      return bundle;
    },
  };
  return { host, requests };
}

const toolNames = (request: AgentRunRequest) => request.tools.map((tool) => tool.name);

describe("start.skills", () => {
  it("opens the skill before turn 1: its tools are offered on the first request, with no read_skill call", async () => {
    const { host, requests } = recordingHost();
    const call = await startCall({ host, start: { skills: [ClaimProcedure] } });

    const first = await call.say("A pipe burst in my kitchen.");

    expect(toolNames(requests[0]!)).toContain(STAGE_TOOL);
    expect(first.toolCalls.map((tool) => tool.name)).not.toContain("read_skill");
    expect(first.skillPath).toBe("/claim-procedure");
    expect(requests[0]!.messages.some((message) => message.role === "assistant")).toBe(false);
    const record = call.record();
    expect(record.skills).toEqual({ started: ["/claim-procedure"], opened: ["/claim-procedure"] });
    const checks = checksOf(record);
    expect(checks.opened(ClaimProcedure)).toMatchObject({ name: "opened /claim-procedure", pass: true, detail: "started there" });
    expect(checks.notOpened()).toMatchObject({ name: "opened no skill beyond /claim-procedure", pass: true });
    expect(checks.notOpened(ClaimProcedure)).toMatchObject({ pass: false, detail: "/claim-procedure was opened by start.skills" });
  });

  it("without start, the call begins at the agent level as before", async () => {
    const { host, requests } = recordingHost();
    const call = await startCall({ host });

    const first = await call.say("A pipe burst in my kitchen.");

    expect(toolNames(requests[0]!)).not.toContain(STAGE_TOOL);
    expect(toolNames(requests[0]!)).toContain("read_skill");
    expect(first.skillPath).toBe("");
    expect(call.record()).not.toHaveProperty("skills");
    expect(checksOf(call.record()).notOpened()).toMatchObject({ name: "opened no skill", pass: true });
  });

  it("opens skills in order, by module or route path, the last one active", async () => {
    const { host, requests } = recordingHost();
    const call = await startCall({ host, start: { skills: [PolicyQuestions, "/policy-questions/coverage"] } });

    await call.say("Am I covered for hail?");

    expect(requests[0]!.stateSnapshot.join("\n")).toContain("Coverage");
    expect(call.record().skills).toEqual({ started: ["/policy-questions", "/policy-questions/coverage"], opened: ["/policy-questions", "/policy-questions/coverage"] });
    expect(checksOf(call.record()).opened(Coverage)).toMatchObject({ pass: true });
    expect(checksOf(call.record()).opened(ClaimProcedure)).toMatchObject({
      pass: false,
      detail: "/claim-procedure was never opened; skills opened: /policy-questions, /policy-questions/coverage",
    });
  });

  it("refuses a skill the agent does not have before turn 1, naming the ones it has", async () => {
    const { host, requests } = recordingHost();
    await expect(startCall({ host, start: { skills: ["/billing"] } })).rejects.toThrow(
      'startCall: start.skills[0]: "/billing" is not one of the agent\'s skills (it has "/property-damage", "/policy-questions", "/claim-procedure", ' +
        '"/member-portal", "/member-portal/priority-claim", "/policy-questions/coverage", "/policy-questions/deductibles", "/policy-questions/exclusions").',
    );
    const stranger = { default: function Stranger() { return null; }, meta: { title: "Stranger" } };
    await expect(startCall({ host, start: { skills: [stranger] } })).rejects.toThrow(
      'startCall: start.skills[0]: the skill module "Stranger" is no skill of the agent',
    );
    await expect(startCall({ host, start: { skills: ["billing"] } })).rejects.toThrow('start.skills[0]: a route path starts with "/"');
    expect(requests).toHaveLength(0);
  });

  it("sets start.info before the skills open, beside the page info", async () => {
    let info: Record<string, unknown> = {};
    const { host } = recordingHost((bundle) => {
      const original = bundle.runtime.loadSkill.bind(bundle.runtime);
      bundle.runtime.loadSkill = (path) => {
        info = bundle.runtime.info.snapshot();
        return original(path);
      };
    });
    await startCall({ host, client: { page: "claims" }, start: { info: { "order.id": "A-1042" }, skills: ["/claim-procedure"] } });
    expect(info).toMatchObject({ "client.page": "claims", "order.id": "A-1042" });
  });
});

describe("spoken", () => {
  it("false sends turns as typed text, as a host's user_text does: no spoken-reply rules", async () => {
    const spokenHost = recordingHost();
    const typedHost = recordingHost();
    const spoken = await startCall({ host: spokenHost.host });
    const typed = await startCall({ host: typedHost.host, spoken: false });

    await spoken.say("Hello.");
    await typed.say("Hello.");

    expect(typed.systemPrompt).not.toBe(spoken.systemPrompt);
    expect(spoken.systemPrompt.startsWith(typed.systemPrompt)).toBe(true);
    expect(typedHost.requests[0]!.systemPrompt).toBe(typed.systemPrompt);
    expect(spokenHost.requests[0]!.systemPrompt).toBe(spoken.systemPrompt);
  });
});

describe("opened and notOpened on a record without skills", () => {
  it("read the read_skill calls and each turn's skill", () => {
    const read = turn({
      turn: 1,
      toolCalls: [{ name: "read_skill", input: { skill: "/claim-procedure" }, ok: true, result: { ok: true } }],
      skillPath: "/claim-procedure",
    });
    const checks = checksOf({ turns: [read], endState: null });
    expect(checks.opened("/claim-procedure")).toMatchObject({ pass: true });
    expect(checks.opened(ClaimProcedure)).toMatchObject({ pass: true });
    expect(checks.notOpened()).toMatchObject({ name: "opened no skill", pass: false, detail: "opened /claim-procedure" });
    expect(checks.notOpened("/policy-questions")).toMatchObject({ name: "did not open /policy-questions", pass: true });
    expect(() => checks.opened({ default: () => null })).toThrow("opened(): the skill module is no skill of the agent");
  });
});

describe("scenario()", () => {
  it("takes start and spoken, and names what is wrong with them", () => {
    expect(() => scenario({ turns: ["Hi"], start: { skills: [ClaimProcedure, "/policy-questions"], info: { "order.id": "A-1042" } }, spoken: false })).not.toThrow();
    expect(() => scenario({ turns: ["Hi"], start: { skills: "/claim-procedure", tools: [] } as never, spoken: "no" as never })).toThrow(
      'scenario(): Unknown field "tools" in start; it takes skills, info. ' +
        'start.skills must be a list of skill modules or route paths, e.g. [Billing] or ["/billing"]. ' +
        'spoken must be true (turns are spoken, the default) or false (typed text); got "no".',
    );
    expect(() => scenario({ turns: ["Hi"], start: { skills: [42], info: "A-1042" } as never })).toThrow(
      "scenario(): start.skills[0]: give a skill module (import * as Billing from \"./billing/skill.js\") or its route path (\"/billing\"); got 42. " +
        'start.info must be an object of call info by key, e.g. { "order.id": "A-1042" }.',
    );
  });
});
