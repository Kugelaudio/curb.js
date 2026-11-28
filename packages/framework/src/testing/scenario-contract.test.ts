import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../components.js";
import type { SkillMeta } from "../routing.js";
import {
  fake,
  localReplyStore,
  remoteReplyStore,
  scenario,
  startCall,
  withReplyStore,
  type ReplyStore,
  type Scenario,
  type ScenarioDefinition,
  type ScenarioExpectContext,
  type StoredReply,
  type TestHost,
} from "./index.js";

/**
 * The types of the scenario fields and the reply store, before their behaviour: these are only
 * compiled (`npm run build`): each body is a function the test never calls, since `fake()` and
 * the stores throw until they are implemented.
 */

const findOrder = defineTool({
  name: "find_order",
  description: "Look an order up.",
  schema: z.object({ order: z.string() }),
  onSubmit: ({ order }) => ({ ok: true, data: { id: order, paid: 49 } }),
});
const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an order.",
  schema: z.object({ order: z.string() }),
  onSubmit: () => ({ ok: true }),
});

const Billing = {
  meta: {
    title: "Billing",
    info: z.object({ "order.id": z.string(), "order.note": z.string().optional() }),
  } satisfies SkillMeta,
  default: () => null,
};
const Refund = { meta: { title: "Refund" } satisfies SkillMeta, default: () => null };

describe("the scenario contract", () => {
  it("takes every new field", () => {
    const compiles = () => {
    const definition = {
      start: { skills: [Billing, Refund, "/billing"], info: { "order.id": "A-1042", "client.page": "orders" } },
      spoken: false,
      hermetic: true,
      now: "2026-10-30T15:00:00Z",
      turns: ["Please refund order A-1042."],
      fakes: [fake(findOrder, { ok: true, data: { id: "A-1042", paid: 49 } }), fake("issue_refund", { ok: true })],
      expect: ({ called, notCalled, calledInOrder, opened, notOpened }: ScenarioExpectContext) => [
        called(issueRefund, { order: "A-1042" }),
        called("find_order"),
        notCalled(issueRefund),
        calledInOrder(findOrder, [issueRefund, { order: "A-1042" }], "issue_refund", ["find_order", {}]),
        opened(Refund),
        opened("/billing/refund"),
        notOpened(),
        notOpened(Billing),
      ],
    } as const;
    expectTypeOf(scenario).toBeCallableWith(definition);
    expectTypeOf(scenario<readonly [typeof Billing, typeof Refund]>).returns.toEqualTypeOf<Scenario>();
    expectTypeOf(startCall).toBeCallableWith({
      start: { skills: [Billing], info: { "order.id": "A-1042" } },
      spoken: false,
      hermetic: true,
      now: "2026-10-30T15:00:00Z",
      fakes: [fake(issueRefund, { ok: true })],
    });
    // The object form of fakes keeps working.
    expectTypeOf(scenario).toBeCallableWith({ turns: ["Hi"], fakes: { issue_refund: { ok: true } } });
    };
    expectTypeOf(compiles).toBeFunction();
  });

  it("types start.info from the started skills' meta.info", () => {
    type Started = ScenarioDefinition<readonly [typeof Billing, typeof Refund]>;
    // @ts-expect-error Billing requires order.id.
    const missingKey: Started = { turns: ["Hi"], start: { skills: [Billing, Refund], info: {} } };
    // @ts-expect-error Billing requires info.
    const missingInfo: Started = { turns: ["Hi"], start: { skills: [Billing, Refund] } };
    // @ts-expect-error order.id is a string.
    const wrongType: Started = { turns: ["Hi"], start: { skills: [Billing, Refund], info: { "order.id": 1042 } } };
    // A skill that declares no info needs none.
    const none: ScenarioDefinition<readonly [typeof Refund]> = { turns: ["Hi"], start: { skills: [Refund] } };
    // scenario() infers the started skills, so it checks the same.
    const inferred = () =>
      // @ts-expect-error Billing requires order.id.
      scenario({ turns: ["Hi"], start: { skills: [Billing, Refund], info: { "order.note": "late" } } });
    void [missingKey, missingInfo, wrongType, none, inferred];
  });

  it("declares the reply store", () => {
    const compiles = () => {
    expectTypeOf(withReplyStore).toBeCallableWith({} as TestHost, {} as ReplyStore);
    expectTypeOf(withReplyStore).toBeCallableWith({} as TestHost, [localReplyStore(), remoteReplyStore()]);
    expectTypeOf(withReplyStore).returns.toEqualTypeOf<TestHost>();
    expectTypeOf(localReplyStore).toBeCallableWith({ dir: "/tmp/replies" });
    expectTypeOf(remoteReplyStore).toBeCallableWith({ url: "https://replies.example.com", token: "token" });
    expectTypeOf<ReplyStore["get"]>().returns.toEqualTypeOf<Promise<StoredReply | null>>();
    expectTypeOf<StoredReply>().toHaveProperty("v").toEqualTypeOf<1>();
    expectTypeOf<StoredReply>().toHaveProperty("response").toBeUnknown();
    };
    expectTypeOf(compiles).toBeFunction();
  });
});
