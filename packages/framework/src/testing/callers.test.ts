import { describe, expect, it } from "vitest";
import { hermeticHost } from "../test-fixtures/hermetic-host.js";
import { INSURANCE_AGENT_SYSTEM_PROMPT } from "../test-fixtures/project/src/agent/agent.js";
import { callerMix, callersPrompt } from "./callers.js";
import { callersFor, startCall } from "./index.js";

/** The fixture project's agent, answering every turn alike, and a model that answers `answers` in turn. */
function host(...answers: string[]) {
  const asked: Array<{ system: string; input: string }> = [];
  const left = [...answers];
  return {
    asked,
    host: hermeticHost({
      agent: () => ({ text: "Hello, this is the AI assistant of the insurance.", toolCalls: [] }),
      model: (system, input) => {
        asked.push({ system, input });
        return left.shift() ?? "";
      },
    }),
  };
}

const caller = (goal: string, more: Record<string, unknown> = {}) => ({ goal, knows: "Name Alex Example, policy 4711", persona: "", behaviours: [], ...more });

describe("callersFor", () => {
  it("shows the model what the agent offers on its first turn, and asks once for the mix of callers", async () => {
    const { host: on, asked } = host(JSON.stringify({ callers: [caller("Report water damage in the kitchen")] }));

    const callers = await callersFor({ host: on });

    expect(callers).toEqual([{ goal: "Report water damage in the kitchen", knows: "Name Alex Example, policy 4711" }]);
    expect(asked).toHaveLength(1);
    const [{ system, input }] = asked as [{ system: string; input: string }];
    expect(system).toBe(callersPrompt(20, "en"));
    expect(system).toContain("Write 20 caller(s), each wanting something different:");
    expect(system).toContain("- 13 who want what this agent is for, spread across its skills and tools");
    expect(system).toContain("- 4 who want what the agent is for but are hard to serve");
    expect(system).toContain("- 3 who want something this agent cannot do");
    expect(system).toContain("Every name, phone number, email address and street address is invented");
    expect(system).toContain("Write goal, knows and persona in English, the language the agent speaks.");
    // The system prompt as the agent's model receives it: its own, then the spoken-reply rules.
    const call = await startCall({ host: on });
    expect(call.systemPrompt.startsWith(INSURANCE_AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(call.systemPrompt.length).toBeGreaterThan(INSURANCE_AGENT_SYSTEM_PROMPT.length);
    call.close();
    const lines = input.split("\n");
    expect(lines[0]).toBe("<<<AGENT");
    expect(lines.at(-1)).toBe("AGENT>>>");
    expect(input).toContain(`System prompt:\n${call.systemPrompt}\n`);
    // The skill index, with what each skill is for, and each tool with what it does.
    expect(lines).toContain("available_skill: Policy questions — Use for coverage questions, deductibles, and policy details.");
    expect(lines).toContain("- request_callback: Request a human insurance advisor callback.");
    expect(lines.filter((line) => line.startsWith("tool: "))).toEqual([]);
    expect(input).toContain("Opening: ");
  });

  it("keeps the callers that can run, with known behaviours only, up to the count", async () => {
    const answer = JSON.stringify({
      callers: [
        caller("  Ask   what the deductible is ", { persona: "In a hurry", behaviours: ["impatient", "sings", "impatient"] }),
        { knows: "no goal" },
        "not a caller",
        caller("Cancel the policy", { knows: 42 }),
        caller("Ask for a pizza", { behaviours: "changes_mind" }),
        caller("Report a stolen bike"),
      ],
    });
    const { host: on, asked } = host(`Here you go:\n${answer}`);

    const callers = await callersFor({ host: on, count: 2 });

    expect(callers).toEqual([
      { goal: "Ask what the deductible is", knows: "Name Alex Example, policy 4711", persona: "In a hurry", behaviours: ["impatient"] },
      // A knows that is no text is left empty, and is still a caller.
      { goal: "Cancel the policy", knows: "" },
    ]);
    expect(asked[0]!.system).toBe(callersPrompt(2, "en"));
    expect(asked[0]!.system).not.toContain("hard to serve");
    expect(asked[0]!.system).not.toContain("cannot do");
  });

  it("asks once more when the answer holds no caller, then rejects", async () => {
    const again = host("I cannot do that.", JSON.stringify({ callers: [caller("Ask about glass cover")] }));
    expect(await callersFor({ host: again.host, count: 3 })).toEqual([{ goal: "Ask about glass cover", knows: "Name Alex Example, policy 4711" }]);
    expect(again.asked).toHaveLength(2);

    const never = host("no", JSON.stringify({ callers: [{ goal: "" }] }), "never asked");
    await expect(callersFor({ host: never.host })).rejects.toThrow(`callersFor(): the model's answer held no caller that can run: ${JSON.stringify(JSON.stringify({ callers: [{ goal: "" }] }))}`);
    expect(never.asked).toHaveLength(2);
  });

  it("takes a model of its own, and refuses a count it cannot write before anything runs", async () => {
    const { host: on, asked } = host();
    const sent: string[] = [];
    const model = async (system: string) => {
      sent.push(system);
      return JSON.stringify({ callers: [caller("Ask when the advisor calls back")] });
    };
    expect(await callersFor({ host: on, model, count: 1 })).toEqual([{ goal: "Ask when the advisor calls back", knows: "Name Alex Example, policy 4711" }]);
    expect(sent).toEqual([callersPrompt(1, "en")]);
    expect(asked).toEqual([]);

    for (const count of [0, 51, 2.5]) {
      await expect(callersFor({ host: on, count })).rejects.toThrow(`callersFor(): count must be a whole number from 1 to 50; got ${count}.`);
    }
  });

  it("mixes mostly callers the agent is for, about one in five hard ones and two or three it cannot serve", () => {
    expect(callerMix(20)).toEqual({ typical: 13, hard: 4, cannot: 3 });
    expect(callerMix(10)).toEqual({ typical: 7, hard: 2, cannot: 1 });
    expect(callerMix(12)).toEqual({ typical: 8, hard: 2, cannot: 2 });
    expect(callerMix(3)).toEqual({ typical: 2, hard: 0, cannot: 1 });
    expect(callerMix(1)).toEqual({ typical: 1, hard: 0, cannot: 0 });
    expect(callerMix(50)).toEqual({ typical: 37, hard: 10, cannot: 3 });
  });
});
