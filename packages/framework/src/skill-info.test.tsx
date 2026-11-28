import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Skill, Skills, Text, useAgentInfo, z, type SkillMeta } from "./index.js";
import { AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import type { SkillInfoMissing } from "./runtime.js";

/** A billing skill that declares the order it works on, and reads it with `useAgentInfo(meta)`. */
const meta = {
  title: "Billing",
  info: z.object({ "order.id": z.string(), "order.note": z.string().optional() }),
} satisfies SkillMeta;

function Billing() {
  const info = useAgentInfo(meta);
  expectTypeOf(info).toEqualTypeOf<{ readonly "order.id"?: string; readonly "order.note"?: string }>();
  return <Text>{`Order: ${info["order.id"] ?? "none"}. Note: ${info["order.note"] ?? "none"}. Keys: ${Object.keys(info).join(", ") || "none"}.`}</Text>;
}

function billingRuntime() {
  return new AgentSiteRuntime(
    <Agent>
      <Skills>
        <Skill path="/billing" description="Questions about an order's bill." />
      </Skills>
      <agent-page path="/billing" title="Billing">
        <Billing />
      </agent-page>
    </Agent>,
    { skills: [{ path: "/billing", title: "Billing", info: meta.info }] },
  );
}

const contextOf = (runtime: AgentSiteRuntime) => runtime.snapshot().context;
const text = (runtime: AgentSiteRuntime) => JSON.stringify(runtime.snapshot().context);

describe("a skill's declared info", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens on a real call without a required key, logging SKILL_INFO_MISSING", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = billingRuntime();

    runtime.loadSkill("/billing");

    expect(contextOf(runtime).path).toBe("/billing");
    expect(text(runtime)).toContain("Order: none. Note: none. Keys: none.");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `[curb] ${AUTHORING_DIAGNOSTIC_CODES.skillInfoMissing}: The skill /billing opened without the call info its meta.info requires: "order.id" is missing. ` +
        "The skill opened anyway; set the info before it opens (the host's set_info, or start.info in a test).",
    );
    // Opening it again while it is open is no new opening.
    runtime.loadSkill("/billing");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is quiet when the info is there, and never rejects keys it does not declare", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = billingRuntime();
    runtime.updateInfo({ "order.id": "A-1042", "client.page": "orders", "experiment.tone": "warm", "caller.phoneNumber": "+15550100" });

    runtime.loadSkill("/billing");

    expect(warn).not.toHaveBeenCalled();
    // Only the declared keys reach the skill; the optional one may be absent.
    expect(text(runtime)).toContain("Order: A-1042. Note: none. Keys: order.id.");
    runtime.updateInfo({ "order.note": "late" });
    expect(text(runtime)).toContain("Order: A-1042. Note: late. Keys: order.id, order.note.");
  });

  it("names a declared value that does not fit, and reads it as undefined", () => {
    const missing: SkillInfoMissing[] = [];
    const runtime = billingRuntime();
    runtime.onSkillInfoMissing((found) => missing.push(found));
    runtime.updateInfo({ "order.id": 1042 });

    runtime.loadSkill("/billing");

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ path: "/billing", problems: [{ key: "order.id" }] });
    expect(missing[0].message).toBe(
      'The skill /billing opened without the call info its meta.info requires: "order.id" is a number, which does not fit its schema (expected string).',
    );
    expect(text(runtime)).toContain("Order: none.");
  });

  it("never copies the value into the message, and opens with any value the info store holds", () => {
    const missing: string[] = [];
    const strict = {
      title: "Billing",
      info: z.object({
        "order.id": z.string(),
        "order.pin": z.string().regex(/^\d{4}$/, { message: "PIN 98765 is not four digits" }),
        "order.total": z.number(),
      }),
    } satisfies SkillMeta;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const runtime = new AgentSiteRuntime(
      <Agent>
        <agent-page path="/billing" title="Billing">
          <Text>Billing.</Text>
        </agent-page>
      </Agent>,
      { skills: [{ path: "/billing", info: strict.info }] },
    );
    runtime.onSkillInfoMissing(({ message }) => missing.push(message));
    runtime.updateInfo({ "order.id": circular, "order.pin": "98765", "order.total": 10n });

    expect(() => runtime.loadSkill("/billing")).not.toThrow();

    expect(contextOf(runtime).path).toBe("/billing");
    expect(missing).toEqual([
      'The skill /billing opened without the call info its meta.info requires: "order.id" is an object, which does not fit its schema (expected string); ' +
        '"order.pin" is a string, which does not fit its schema (invalid format); "order.total" is a bigint, which does not fit its schema (expected number).',
    ]);
    expect(missing[0]).not.toContain("98765");
  });

  it("goes to a test's handler instead of the log, until the handler is taken away", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing: string[] = [];
    const runtime = billingRuntime();
    runtime.onSkillInfoMissing(({ path }) => missing.push(path));

    runtime.loadSkill("/billing");
    expect(missing).toEqual(["/billing"]);
    expect(warn).not.toHaveBeenCalled();

    const again = billingRuntime();
    again.onSkillInfoMissing(() => missing.push("handler"));
    again.onSkillInfoMissing(null);
    again.navigate("/billing");
    expect(missing).toEqual(["/billing"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("parses the declared info once per change, so a value parsed to a new object each time renders once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const parses = vi.fn((tags: string) => new Set(tags.split(",")));
    const tagged = { title: "Orders", info: z.object({ "order.tags": z.string().transform(parses) }) } satisfies SkillMeta;
    let renders = 0;
    function Orders() {
      renders += 1;
      const tags = useAgentInfo(tagged)["order.tags"];
      return <Text>{`Tags: ${tags ? [...tags].join(" and ") : "none"}.`}</Text>;
    }
    const runtime = new AgentSiteRuntime(
      <Agent>
        <agent-page path="/orders" title="Orders">
          <Orders />
        </agent-page>
      </Agent>,
      { skills: [{ path: "/orders", info: tagged.info }] },
    );
    runtime.updateInfo({ "order.tags": "late,refund" });

    runtime.loadSkill("/orders");
    expect(text(runtime)).toContain("Tags: late and refund.");
    const settled = renders;
    const parsed = parses.mock.calls.length;
    runtime.updateInfo({ "client.page": "orders" });
    expect(renders - settled).toBeLessThanOrEqual(1);
    expect(parses.mock.calls.length - parsed).toBeLessThanOrEqual(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("checks nothing for a skill that declares no info", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new AgentSiteRuntime(
      <Agent>
        <agent-page path="/orders" title="Orders">
          <Text>Orders.</Text>
        </agent-page>
      </Agent>,
      { skills: [{ path: "/orders" }] },
    );
    runtime.loadSkill("/orders");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("useAgentInfo's types", () => {
  it("keeps useAgentInfo() and selectors as they were, and types only declared keys from meta", () => {
    const types = () => {
      expectTypeOf(useAgentInfo()).toEqualTypeOf<Readonly<Record<string, unknown>>>();
      expectTypeOf(useAgentInfo((info) => info["caller.phoneNumber"] as string | undefined)).toEqualTypeOf<string | undefined>();
      const info = useAgentInfo(meta);
      expectTypeOf(info["order.id"]).toEqualTypeOf<string | undefined>();
      // @ts-expect-error a key the skill does not declare is not there.
      void info["client.page"];
      expectTypeOf(useAgentInfo({ title: "Orders" } satisfies SkillMeta)).toEqualTypeOf<Readonly<Record<never, never>>>();
      // @ts-expect-error meta.info is a zod object.
      void ({ info: { "order.id": "string" } } satisfies SkillMeta);
    };
    expectTypeOf(types).toBeFunction();
  });
});
