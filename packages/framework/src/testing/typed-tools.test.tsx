import { describe, expect, expectTypeOf, it } from "vitest";
import { AgentSession } from "../agent-session.js";
import { Agent, AgentSiteRuntime, Skill, Skills, Text, defineTool, z, type SkillMeta } from "../index.js";
import { addTask, calls, says, sendSummary, steps, tasksBundle } from "../test-fixtures/tasks.js";
import type { AgentRunResponse } from "../llm/types.js";
import { Throttle } from "./resilience.js";
import { fakesByName } from "./scenario.js";
import { fake, scenario, startCall, type ScenarioFakeEntry, type TestHost } from "./index.js";

/** Tools as values, the way a project's `tools.ts` exports them. */
const findOrder = defineTool({
  name: "find_order",
  description: "Look an order up.",
  schema: z.object({ order: z.string() }),
  onSubmit: async ({ order }) => ({ ok: true, data: { id: order, paid: 49 } }),
});
const sendSummaryTool = defineTool({
  name: "send_summary",
  description: "Send the list to someone.",
  schema: z.object({ to: z.string() }),
  onSubmit: ({ to }) => ({ ok: true, message: `Sent to ${to}.` }),
});
const ping = defineTool({ name: "ping", description: "Ping.", onCall: () => ({ ok: true }) });

/** A host on `bundle`, whose agent plays `responses`. */
function hostOn(bundle: () => { runtime: AgentSiteRuntime; session: AgentSession }): TestHost {
  return {
    createBundle: async () => bundle(),
    simulator: () => async () => says(""),
    throttle: new Throttle(),
  };
}

describe("defineTool", () => {
  it("still returns what it gets, now typed by its schema and its onSubmit's result", async () => {
    const config = {
      name: "find_order",
      description: "Look an order up.",
      schema: z.object({ order: z.string() }),
      onSubmit: async ({ order }: { order: string }) => ({ ok: true, data: { id: order } }),
    };
    expect(defineTool(config)).toBe(config);
    expectTypeOf(findOrder.onSubmit).returns.resolves.toEqualTypeOf<{ ok: true; data: { id: string; paid: number } }>();
    expectTypeOf(findOrder.onSubmit).parameter(0).toEqualTypeOf<{ order: string }>();
  });
});

describe("fake", () => {
  it("names the tool by its value or its name", () => {
    expect(fake(findOrder, { ok: true, data: { id: "A-1042", paid: 49 } })).toEqual({
      tool: "find_order",
      result: { ok: true, data: { id: "A-1042", paid: 49 } },
    });
    expect(fake("issue_refund", { ok: true })).toEqual({ tool: "issue_refund", result: { ok: true } });
    expect(() => fake({ name: "" }, { ok: true })).toThrow("fake(): the tool is a tool's name or a value with its name");
  });

  it("checks the result against what the tool's onSubmit returns", () => {
    const types = () => {
      fake(findOrder, { ok: true, data: { id: "A-1042", paid: 49 } });
      // Any failure fits every tool.
      fake(findOrder, { ok: false, message: "No such order." });
      // A function gets the input as the schema types it.
      fake(findOrder, ({ order }) => ({ ok: true, data: { id: order, paid: 0 } }));
      fake(findOrder, async ({ order }) => ({ ok: true, data: { id: order, paid: 0 } }));
      // @ts-expect-error paid is a number.
      fake(findOrder, { ok: true, data: { id: "A-1042", paid: "49" } });
      // @ts-expect-error the result has data.
      fake(findOrder, { ok: true });
      // @ts-expect-error the input has no `id`.
      fake(findOrder, ({ id }) => ({ ok: true, data: { id, paid: 0 } }));
      // A name, or a tool whose result is not typed, takes any tool result.
      fake("find_order", { ok: true, data: "anything" });
      fake(ping, { ok: true, data: 1 });
      // @ts-expect-error a result is a tool result.
      fake("find_order", { done: true });
    };
    expectTypeOf(types).toBeFunction();
    expectTypeOf(fake(findOrder, { ok: false })).toEqualTypeOf<ScenarioFakeEntry>();
  });

  it("takes one function for a tool whose onSubmit returns one of several shapes", () => {
    type Refund = { ok: true; data: { refunded: number } } | { ok: true; data: { queued: string } };
    const issueRefund = defineTool({
      name: "issue_refund",
      description: "Refund an order.",
      schema: z.object({ order: z.string(), amount: z.number() }),
      onSubmit: async ({ order, amount }): Promise<Refund> =>
        amount > 100 ? { ok: true, data: { queued: order } } : { ok: true, data: { refunded: amount } },
    });
    const byAmount = fake(issueRefund, ({ order, amount }) =>
      amount > 100 ? { ok: true, data: { queued: order } } : { ok: true, data: { refunded: amount } },
    );
    expect(byAmount.tool).toBe("issue_refund");
    const types = () => {
      fake(issueRefund, { ok: true, data: { queued: "A-1042" } });
      fake(issueRefund, async ({ amount }) => (amount > 0 ? { ok: true, data: { refunded: amount } } : { ok: false, message: "Nothing to refund." }));
      // @ts-expect-error neither shape has `sent`.
      fake(issueRefund, ({ amount }) => (amount > 100 ? { ok: true, data: { sent: amount } } : { ok: true, data: { refunded: amount } }));
    };
    expectTypeOf(types).toBeFunction();
  });
});

describe("fakes as a list", () => {
  it("is a scenario's fakes, and a list that is not fakes says what is wrong", () => {
    expect(() => scenario({ turns: ["Hi"], fakes: [fake(findOrder, { ok: true, data: { id: "A", paid: 1 } })] })).not.toThrow();
    expect(() => scenario({ turns: ["Hi"], fakes: [{ ok: true }] as never })).toThrow(
      "fakes: entry 1 is not a fake; make each one with fake(tool, result).",
    );
    expect(() => scenario({ turns: ["Hi"], fakes: [fake(findOrder, { ok: false }), fake("find_order", { ok: true })] })).toThrow(
      "fakes: find_order has two fakes; give each tool one.",
    );
    expect(() => scenario({ turns: ["Hi"], fakes: [fake("find_order", { nope: 1 } as never)] })).toThrow("fakes.find_order:");
  });

  it("keeps a tool named __proto__ like any other name", () => {
    const byName = fakesByName([fake("__proto__", { ok: true, message: "Faked." }), fake(findOrder, { ok: false })]);
    expect(Object.entries(byName)).toEqual([
      ["__proto__", { ok: true, message: "Faked." }],
      ["find_order", { ok: false }],
    ]);
    expect(Object.getPrototypeOf(byName)).toBeNull();
    expect(() => fakesByName([fake("__proto__", { ok: true }), fake("__proto__", { ok: false })])).toThrow(
      "fakes: __proto__ has two fakes; give each tool one.",
    );
    expect(() => scenario({ turns: ["Hi"], fakes: [fake("__proto__", { ok: true }), fake("__proto__", { ok: false })] })).toThrow(
      "fakes: __proto__ has two fakes",
    );
  });

  it("replaces the tools in a call, as the object form does", async () => {
    let bundle!: ReturnType<typeof tasksBundle>;
    const host = hostOn(() => (bundle = tasksBundle(steps([calls(addTask("milk"), sendSummary("sam@example.com")), says("Done.")]))));
    const call = await startCall({ host, fakes: [fake(sendSummaryTool, ({ to }) => ({ ok: true, message: `Faked for ${to}.` }))] });

    const turn = await call.say("Add milk and send it to Sam.");

    expect(turn.toolCalls).toMatchObject([
      { name: "add_task", ok: true },
      { name: "send_summary", ok: true, faked: true, result: { ok: true, message: "Faked for sam@example.com." } },
    ]);
    expect(turn.toolCalls[0]).not.toHaveProperty("faked", true);
    expect(bundle.send).not.toHaveBeenCalled();
    await expect(startCall({ host, fakes: [fake("send_summary", { ok: true }), fake(sendSummaryTool, { ok: false })] })).rejects.toThrow(
      "startCall: fakes: send_summary has two fakes; give each tool one.",
    );
  });
});

describe("a skill that opens without its declared info in a test", () => {
  const meta = { title: "Billing", info: z.object({ "order.id": z.string() }) } satisfies SkillMeta;
  const readBilling: AgentRunResponse = calls({ name: "read_skill", input: { skill: "/billing" } });
  const billingBundle = () => {
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Skills>
          <Skill path="/billing" description="Questions about an order's bill." />
        </Skills>
        <agent-page path="/billing" title="Billing">
          <Text>Billing.</Text>
        </agent-page>
      </Agent>,
      { skills: [{ path: "/billing", info: meta.info }] },
    );
    return { runtime, session: new AgentSession(runtime, steps([readBilling, says("Let me look at that bill.")])) };
  };

  it("fails the turn it opened in, naming the key", async () => {
    const call = await startCall({ host: hostOn(billingBundle) });

    const turn = await call.say("Why was I charged twice?");

    expect(turn.skillPath).toBe("/billing");
    expect(turn.errors).toEqual([
      {
        kind: "failed",
        message: 'SKILL_INFO_MISSING: The skill /billing opened without the call info its meta.info requires: "order.id" is missing.',
      },
    ]);
  });
});
