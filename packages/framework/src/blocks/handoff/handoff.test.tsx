import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../../agent-session.js";
import { attachCallTrace, type CallbackRequestRecord, type CallTrace, type HandoffRecord } from "../../call-trace.js";
import { isWithinHours, parseOpeningHours, type HandoffHours, type OpeningHours } from "./hours.js";
import {
  Agent,
  AgentAuthoringError,
  AgentSiteRuntime,
  GlobalTools,
  Handoff,
  Tool,
  ToolInputError,
  ToolUnavailableError,
  type CallbackRequest,
  type HandoffProps,
} from "../../index.js";
import { fallbackReplies } from "../../llm/localized.js";
import { handoffAnnouncement, handoffUnreachedLine } from "./lines.js";
import { isConfirmationRequest } from "../../llm/confirmation.js";
import { z } from "../../index.js";
import type { AgentRunResponse, AgentTurnStreamEvent } from "../../llm/types.js";
import type { OutgoingHostMessage } from "../../messages.js";
import { kugelaudio } from "../../providers.js";
import { CALL_TRANSFER_RESULT_MESSAGE } from "../transfer-call/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OPEN: HandoffHours = () => true;
const CLOSED: HandoffHours = () => false;
const ANNOUNCE = "Einen Moment, ich verbinde Sie mit einem Kollegen.";

/**
 * A runtime with `<Handoff>`, a `lookup` tool whose service is down, a `crash` tool with a bug, a
 * `book` tool that answers no and a `find` tool that refuses its input, on a phone call (unless `phone` is
 * false) whose host answers `call.transfer` and then reports `outcome` for it. Its trace records
 * every handoff and callback request.
 */
function call(
  options: {
    props?: Partial<HandoffProps>;
    phone?: boolean;
    outcome?: "answered" | "no_answer" | "busy";
    german?: boolean;
  } = {},
) {
  const callbacks: CallbackRequest[] = [];
  const runtime = new AgentSiteRuntime(
    <Agent {...(options.german ? { tts: kugelaudio.tts({ language: "de" }) } : {})}>
      <GlobalTools>
        <Handoff
          to="+493012345678"
          hours={OPEN}
          onCallbackRequest={(request) => void callbacks.push(request)}
          {...options.props}
        />
        <Tool
          name="lookup"
          description="Look the order up."
          onCall={() => {
            throw new ToolUnavailableError("The order service is down.");
          }}
        />
        <Tool
          name="crash"
          description="Look the invoice up."
          onCall={() => {
            throw new TypeError("invoice is undefined");
          }}
        />
        <Tool name="book" description="Book a slot." onCall={() => ({ ok: false, message: "That slot is taken." })} />
        <Tool
          name="find"
          description="Find a customer."
          onCall={() => {
            throw new ToolInputError("No customer has that number.");
          }}
        />
        <Tool name="greet" description="Say hello." onCall={() => ({ ok: true })} />
      </GlobalTools>
    </Agent>,
  );
  if (options.phone !== false) runtime.updateInfo({ "caller.identity": "sip_caller-1", "caller.phoneNumber": "+491701234567" });
  const { sent, handoffs, requests } = attachFakes(runtime, options.outcome);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const tools = () => runtime.snapshot().context.tools.map((tool) => tool.name);
  return { runtime, sent, handoffs, requests, callbacks, errors, tools };
}

/** A host that accepts `call.transfer` and reports `outcome` for it, and a trace recording every
 * handoff and callback request, attached to `runtime`. */
function attachFakes(runtime: AgentSiteRuntime, outcome: "answered" | "no_answer" | "busy" = "answered") {
  const sent: OutgoingHostMessage[] = [];
  runtime.messages.connectHost((message) => {
    sent.push(message);
    queueMicrotask(() => {
      void runtime.messages.deliver("host", { id: "r-1", key: "reply", payload: { transferId: "t-1" }, inReplyTo: message.id });
      queueMicrotask(() =>
        void runtime.messages.deliver("host", {
          id: "res-1",
          key: CALL_TRANSFER_RESULT_MESSAGE,
          payload: { transferId: "t-1", outcome },
        }),
      );
    });
    return true;
  });
  const handoffs: HandoffRecord[] = [];
  const requests: CallbackRequestRecord[] = [];
  const trace = {
    transfer: () => ({ outcome: () => {} }),
    handoff: (record: HandoffRecord) => handoffs.push(record),
    callbackRequest: (record: CallbackRequestRecord) => requests.push(record),
    context: () => undefined,
    skill: () => {},
    procedure: () => {},
  } as unknown as CallTrace;
  attachCallTrace(runtime.info, trace);
  return { sent, handoffs, requests };
}

describe("<Handoff>", () => {
  it("puts the caller through within the hours and records the reason and summary", async () => {
    const { runtime, sent, handoffs, tools } = call();
    const { result } = await runtime.callTool("handoff", {
      reason: "caller_requested",
      summary: "Anna Schmidt wants to move her appointment.",
      announce: ANNOUNCE,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "call.transfer", payload: { to: "+493012345678" } });
    expect(result.message).toContain("put through");
    expect(handoffs).toEqual([
      { reason: "caller_requested", summary: "Anna Schmidt wants to move her appointment.", outcome: "answered" },
    ]);
    expect(tools()).not.toContain("request_callback");
  });

  it("outside the hours dials nobody and takes a callback request instead", async () => {
    const { runtime, sent, handoffs, requests, callbacks, tools } = call({ props: { hours: CLOSED } });
    expect(tools()).not.toContain("request_callback");
    const { result } = await runtime.callTool("handoff", {
      reason: "caller_requested",
      summary: "Wants a person.",
      announce: ANNOUNCE,
    });
    expect(sent).toHaveLength(0);
    expect(handoffs).toEqual([{ reason: "caller_requested", summary: "Wants a person.", outcome: "closed" }]);
    expect(result.message).toContain("outside the hours");
    expect(result.message).toContain("request_callback");
    expect(tools()).toContain("request_callback");

    // On a phone call the number they call from is the default.
    const { result: recorded } = await runtime.callTool("request_callback", { name: "Anna Schmidt" });
    expect(recorded).toMatchObject({ ok: true });
    const expected = { name: "Anna Schmidt", phone: "+491701234567", reason: "caller_requested", summary: "Wants a person." };
    expect(requests).toEqual([expected]);
    expect(callbacks).toEqual([expected]);
    expect(tools()).not.toContain("request_callback");
  });

  it("offers a callback when nobody answers", async () => {
    const { runtime, handoffs, tools } = call({ outcome: "no_answer" });
    const { result } = await runtime.callTool("handoff", { reason: "agent_stuck", summary: "Unclear request.", announce: ANNOUNCE });
    expect(result.message).toContain("Nobody answered");
    expect(handoffs[0]).toMatchObject({ reason: "agent_stuck", outcome: "no_answer" });
    expect(tools()).toContain("request_callback");
  });

  it("on a browser call asks for the number, since nothing can be put through", async () => {
    const { runtime, sent, handoffs } = call({ phone: false });
    const { result } = await runtime.callTool("handoff", { reason: "caller_requested", summary: "Wants a person.", announce: ANNOUNCE });
    expect(sent).toHaveLength(0);
    expect(handoffs[0]).toMatchObject({ outcome: "refused", code: "transfer_unsupported_session" });
    expect(result.message).toContain("the number to call them back on");
    const { result: missing } = await runtime.callTool("request_callback", { name: "Anna" });
    expect(missing).toMatchObject({ ok: false });
    const { result: recorded } = await runtime.callTool("request_callback", { name: "Anna", phone: "+49 170 7654321" });
    expect(recorded).toMatchObject({ ok: true });
  });

  it("refuses a call without reason, summary or announcement, and dials nobody", async () => {
    const { runtime, sent, handoffs } = call();
    const { result } = await runtime.callTool("handoff", { reason: "caller_requested", announce: ANNOUNCE });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("summary");
    expect(sent).toHaveLength(0);
    expect(handoffs).toHaveLength(0);
  });

  it("offers a callback when the hours check throws", async () => {
    const { runtime, sent, handoffs, errors } = call({
      props: {
        hours: () => {
          throw new Error("calendar down");
        },
      },
    });
    await runtime.callTool("handoff", { reason: "caller_requested", summary: "Wants a person.", announce: ANNOUNCE });
    expect(sent).toHaveLength(0);
    expect(handoffs[0]).toMatchObject({ outcome: "closed" });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("refuses bad props when it renders", () => {
    for (const props of [
      { to: "sales" },
      { hours: { timeZone: "Mars/Olympus", open: {} } },
      { hours: { timeZone: "Europe/Berlin", open: { "mon-fri": "17:00-08:00" } } },
      { afterFailures: 0 },
      { afterErrors: 0 },
      { afterErrors: 2.5 },
      { afterFailedAttempts: 11 },
    ] as Array<Partial<HandoffProps>>) {
      expect(() => call({ props })).toThrow(AgentAuthoringError);
    }
  });
});

describe("opening hours", () => {
  const hours: OpeningHours = { timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00", sat: ["09:00-12:00"] } };

  it("reads weekdays, runs of them and windows in the time zone", async () => {
    // Monday 2026-11-16, 07:30 UTC is 08:30 in Berlin.
    expect(await isWithinHours(hours, new Date("2026-11-16T07:30:00Z"))).toBe(true);
    expect(await isWithinHours(hours, new Date("2026-11-16T06:30:00Z"))).toBe(false);
    // 17:00 is closed: a window ends before its last minute.
    expect(await isWithinHours(hours, new Date("2026-11-16T16:00:00Z"))).toBe(false);
    expect(await isWithinHours(hours, new Date("2026-11-21T10:00:00Z"))).toBe(true);
    expect(await isWithinHours(hours, new Date("2026-11-22T10:00:00Z"))).toBe(false);
    expect(await isWithinHours(undefined, new Date())).toBe(true);
  });

  it("takes a run that wraps the week", () => {
    const days = parseOpeningHours({ timeZone: "UTC", open: { "fri-mon": "10:00-11:00" } });
    expect(days.map((windows) => windows.length)).toEqual([1, 1, 0, 0, 0, 1, 1]);
  });

  it("names what is wrong", () => {
    expect(() => parseOpeningHours({ timeZone: "UTC", open: { weekdays: "08:00-17:00" } as never })).toThrow(/key "weekdays"/);
    expect(() => parseOpeningHours({ timeZone: "UTC", open: { mon: "8-17" } })).toThrow(/HH:MM-HH:MM/);
  });
});

describe("the session hands off on its own", () => {
  /** A session whose model plays `steps`, then says "ok". */
  function session(runtime: AgentSiteRuntime, steps: Array<AgentRunResponse | Error>) {
    let step = 0;
    const llm = vi.fn<AgentLlmClient>(async () => {
      const next = steps[step++] ?? { text: "ok", toolCalls: [] };
      if (next instanceof Error) throw next;
      return next;
    });
    return new AgentSession(runtime, llm);
  }
  const toolCall = (name: string) => (id: string) => ({ text: "", toolCalls: [{ id, name, input: {} }] });
  const lookup = toolCall("lookup");
  const crash = toolCall("crash");
  const book = toolCall("book");
  const find = toolCall("find");
  const greet = toolCall("greet");

  async function turn(target: AgentSession, input: string) {
    const events: AgentTurnStreamEvent[] = [];
    for await (const event of target.runTurnStream(input, { spoken: true })) events.push(event);
    return events;
  }

  it("after three tool calls in a row reported an outage, with the reason agent_failure and its line in the agent's language", async () => {
    const { runtime, sent, handoffs } = call({ german: true });
    const target = session(runtime, [lookup("c1"), lookup("c2"), lookup("c3")]);
    const events = await turn(target, "Wo ist meine Bestellung?");
    expect(sent).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ reason: "agent_failure", outcome: "answered" });
    expect(handoffs[0]!.summary).toContain("3 tool calls failed in a row (lookup)");
    expect(handoffs[0]!.summary).toContain("The order service is down.");
    const handoffCall = target.messages.flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
      .find((toolCall) => toolCall.name === "handoff");
    expect(handoffCall?.input).toMatchObject({ reason: "agent_failure", announce: handoffAnnouncement("de") });
    expect(events.some((event) => event.type === "tool" && event.toolCall.name === "handoff")).toBe(true);
  });

  it("counts a handler that threw anything but a ToolInputError as an error", async () => {
    const { runtime, handoffs } = call();
    const target = session(runtime, [crash("c1"), lookup("c2"), crash("c3")]);
    await turn(target, "Where is my invoice?");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", summary: expect.stringContaining("(crash, lookup)") })]);
  });

  it("never because tools answered no, unless afterFailedAttempts is set", async () => {
    // "That slot is taken" and a refused input are answers, not faults: the model carries on.
    const { runtime, sent, handoffs } = call();
    const target = session(runtime, [book("b1"), book("b2"), find("f1"), book("b3"), find("f2"), book("b4")]);
    await turn(target, "Any slot on Tuesday?");
    expect(sent).toHaveLength(0);
    expect(handoffs).toHaveLength(0);
  });

  it("an answer of no neither counts as an error nor ends the errors in a row", async () => {
    const { runtime, handoffs } = call();
    const target = session(runtime, [lookup("c1"), book("b1"), lookup("c2"), find("f1"), lookup("c3")]);
    await turn(target, "Where is my order?");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", summary: expect.stringContaining("(lookup)") })]);
  });

  it("with afterFailedAttempts, after that many answers of no in a row, as agent_stuck and with a line that claims no fault", async () => {
    const { runtime, sent, handoffs } = call({ german: true, props: { afterFailedAttempts: 3 } });
    const target = session(runtime, [book("b1"), find("f1"), book("b2")]);
    await turn(target, "Dienstag um zehn?");
    expect(sent).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ reason: "agent_stuck", outcome: "answered" });
    expect(handoffs[0]!.summary).toContain("3 attempts in a row did not work (book, find)");
    expect(handoffs[0]!.summary).toContain("That slot is taken.");
    const handoffCall = target.messages.flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
      .find((made) => made.name === "handoff");
    expect(handoffCall?.input).toMatchObject({ reason: "agent_stuck", announce: handoffAnnouncement("de", "agent_stuck") });
    expect(handoffAnnouncement("de", "agent_stuck")).not.toBe(handoffAnnouncement("de"));
  });

  it("starts the failed attempts again after a tool that works, and counts them apart from errors", async () => {
    const { runtime, handoffs } = call({ props: { afterFailedAttempts: 3 } });
    const sorry = { text: "Sorry.", toolCalls: [] };
    const target = session(runtime, [book("b1"), book("b2"), greet("g"), book("b3"), lookup("c1"), lookup("c2"), book("b4"), sorry, book("b5")]);
    // Two attempts, a success, two more and two errors between them: neither limit is reached.
    await turn(target, "one");
    expect(handoffs).toHaveLength(0);
    await turn(target, "two");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_stuck" })]);
  });

  it("with afterErrors false and afterFailedAttempts set, only failed attempts hand off", async () => {
    const { runtime, handoffs } = call({ props: { afterErrors: false, afterFailedAttempts: 2 } });
    const target = session(runtime, [lookup("c1"), lookup("c2"), lookup("c3"), book("b1"), book("b2")]);
    await turn(target, "Where is my order?");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_stuck" })]);
  });

  it("counts errors across turns", async () => {
    const { runtime, handoffs } = call();
    const sorry = { text: "Sorry, let me try again.", toolCalls: [] };
    const target = session(runtime, [lookup("c1"), sorry, lookup("c2"), sorry, lookup("c3")]);
    await turn(target, "one");
    await turn(target, "two");
    expect(handoffs).toHaveLength(0);
    await turn(target, "three");
    expect(handoffs).toHaveLength(1);
  });

  it("starts every count again with a new conversation", async () => {
    const { runtime, handoffs } = call();
    const sorry = { text: "Sorry, let me try again.", toolCalls: [] };
    const target = session(runtime, [lookup("c1"), sorry, lookup("c2"), sorry, lookup("c3"), sorry, lookup("c4"), sorry, lookup("c5")]);
    await turn(target, "one");
    await turn(target, "two");
    target.reset();
    await turn(target, "one");
    await turn(target, "two");
    expect(handoffs).toHaveLength(0);
    await turn(target, "three");
    expect(handoffs).toHaveLength(1);
  });

  it("starts the count again after a tool that works, and leaves framework tools out", async () => {
    const { runtime, handoffs } = call();
    const skip = { text: "", toolCalls: [{ id: "s", name: "skip_turn", input: {} }] };
    const target = session(runtime, [lookup("c1"), lookup("c2"), greet("g"), lookup("c3"), lookup("c4"), { text: "Sorry.", toolCalls: [] }]);
    await turn(target, "one");
    expect(handoffs).toHaveLength(0);
    // skip_turn neither fails nor works: the third failure after it hands off.
    const other = call();
    const skipping = session(other.runtime, [lookup("c1"), lookup("c2"), skip, lookup("c3")]);
    await turn(skipping, "one");
    expect(other.handoffs).toHaveLength(0);
    await turn(skipping, "two");
    expect(other.handoffs).toHaveLength(1);
  });

  it("never with afterErrors false", async () => {
    const { runtime, handoffs } = call({ props: { afterErrors: false } });
    const target = session(runtime, [lookup("c1"), lookup("c2"), lookup("c3"), lookup("c4")]);
    await turn(target, "Where is my order?");
    expect(handoffs).toHaveLength(0);
  });

  it("still reads afterFailures, the old name of afterErrors, unless afterErrors is given", async () => {
    const old = call({ props: { afterFailures: false } });
    await turn(session(old.runtime, [lookup("c1"), lookup("c2"), lookup("c3"), lookup("c4")]), "Where is my order?");
    expect(old.handoffs).toHaveLength(0);

    const lower = call({ props: { afterFailures: 2 } });
    await turn(session(lower.runtime, [lookup("c1"), lookup("c2")]), "Where is my order?");
    expect(lower.handoffs).toHaveLength(1);

    const both = call({ props: { afterFailures: 1, afterErrors: 3 } });
    await turn(session(both.runtime, [lookup("c1"), lookup("c2")]), "Where is my order?");
    expect(both.handoffs).toHaveLength(0);
  });

  it("after three turns in a row got no reply, offering a callback in place of the apology when nobody is there", async () => {
    const { runtime, handoffs } = call({ props: { hours: CLOSED } });
    const down = new Error("provider unavailable");
    const target = session(runtime, [down, down, down]);
    const heard = async (input: string) =>
      (await turn(target, input)).flatMap((event) => (event.type === "delta" ? [event.delta] : [])).join("");
    expect(await heard("one")).toContain(fallbackReplies("en").turnFailed);
    expect(await heard("two")).toContain(fallbackReplies("en").turnFailed);
    const third = await heard("three");
    expect(third).not.toContain(fallbackReplies("en").turnFailed);
    // Never silence: nobody took the call and the model is down, so the callback offer is said.
    expect(third).toContain(handoffUnreachedLine("en"));
    expect(handoffs).toEqual([
      expect.objectContaining({ reason: "agent_failure", outcome: "closed", summary: expect.stringContaining("provider unavailable") }),
    ]);
  });

  it("says nothing more after failed turns when a person took the call", async () => {
    const { runtime, handoffs } = call();
    const down = new Error("provider unavailable");
    const target = session(runtime, [down, down, down]);
    await turn(target, "one");
    await turn(target, "two");
    const third = (await turn(target, "three")).flatMap((event) => (event.type === "delta" ? [event.delta] : [])).join("");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", outcome: "answered" })]);
    expect(third).toBe("");
  });

  it("counts an empty reply and the step limit as turns without a reply", async () => {
    const empty = { text: "", toolCalls: [] };
    const blank = call();
    const silent = session(blank.runtime, [empty, empty, empty, empty, empty, empty]);
    for (const input of ["one", "two", "three"]) await turn(silent, input);
    expect(blank.handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", summary: expect.stringContaining("empty_reply") })]);

    // One step a turn, spent on a tool that works: every turn ends at the step limit.
    const limited = call();
    let calls = 0;
    const busy = new AgentSession(limited.runtime, async () => greet(`g${++calls}`), { maxSteps: 1 });
    for (const input of ["one", "two", "three"]) await turn(busy, input);
    expect(limited.handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", summary: expect.stringContaining("step_limit") })]);
  });

  it("dials once in a turn where the tool and the turn thresholds are reached together", async () => {
    // One step a turn, spent on a failing tool: the tool streak and the step-limit turns mature in
    // the same turn, and nobody answers.
    for (const afterErrors of [3, 1]) {
      const { runtime, sent, handoffs } = call({ outcome: "no_answer", props: { afterErrors } });
      let calls = 0;
      const target = new AgentSession(runtime, async () => lookup(`c${++calls}`), { maxSteps: 1 });
      for (let turnNumber = 1; turnNumber <= afterErrors; turnNumber += 1) await turn(target, `turn ${turnNumber}`);
      expect(sent.filter((message) => message.name === "call.transfer")).toHaveLength(1);
      expect(handoffs).toHaveLength(1);
      // The turn that handed off is not counted again: the next one starts from nothing.
      await turn(target, "after");
      expect(handoffs).toHaveLength(afterErrors === 1 ? 2 : 1);
    }
  });

  it("hands off when the caller's yes runs the third failing call, before the model speaks again", async () => {
    const refunds = new AgentSiteRuntime(
      <Agent>
        <GlobalTools>
          <Handoff to="+493012345678" hours={OPEN} />
          <Tool
            name="lookup"
            description="Look the order up."
            onCall={() => {
              throw new ToolUnavailableError("The order service is down.");
            }}
          />
          <Tool
            name="refund"
            description="Refund the order."
            schema={z.object({ amount: z.number() })}
            confirm={(input) => `Refund ${input.amount} euros?`}
            onSubmit={() => {
              throw new ToolUnavailableError("The refund service is down.");
            }}
          />
        </GlobalTools>
      </Agent>,
    );
    const { handoffs } = attachFakes(refunds);
    const steps: AgentRunResponse[] = [lookup("c1"), lookup("c2"), { text: "", toolCalls: [{ id: "r", name: "refund", input: { amount: 20 } }] }, { text: "Sorry about that.", toolCalls: [] }];
    let step = 0;
    const llm: AgentLlmClient = async (request) => (isConfirmationRequest(request) ? { text: "yes", toolCalls: [] } : (steps[step++] ?? { text: "ok", toolCalls: [] }));
    const target = new AgentSession(refunds, llm);
    await turn(target, "Refund my order please.");
    expect(handoffs).toHaveLength(0);
    await turn(target, "Yes.");
    expect(handoffs).toEqual([expect.objectContaining({ reason: "agent_failure", summary: expect.stringContaining("refund") })]);
  });
});
