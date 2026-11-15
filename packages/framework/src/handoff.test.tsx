import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { attachCallTrace, type CallbackRequestRecord, type CallTrace, type HandoffRecord } from "./call-trace.js";
import { isWithinHours, parseOpeningHours, type HandoffHours, type OpeningHours } from "./handoff-hours.js";
import { Agent, AgentAuthoringError, AgentSiteRuntime, GlobalTools, Handoff, Tool, type CallbackRequest, type HandoffProps } from "./index.js";
import { fallbackReplies, handoffAnnouncement } from "./llm/localized.js";
import type { AgentRunResponse, AgentTurnStreamEvent } from "./llm/types.js";
import type { OutgoingHostMessage } from "./messages.js";
import { kugelaudio } from "./providers.js";
import { CALL_TRANSFER_RESULT_MESSAGE } from "./transfer.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OPEN: HandoffHours = () => true;
const CLOSED: HandoffHours = () => false;
const ANNOUNCE = "Einen Moment, ich verbinde Sie mit einem Kollegen.";

/**
 * A runtime with `<Handoff>` and a failing `lookup` tool, on a phone call (unless `phone` is
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
        <Tool name="lookup" description="Look the order up." onCall={() => ({ ok: false, message: "The order service is down." })} />
        <Tool name="greet" description="Say hello." onCall={() => ({ ok: true })} />
      </GlobalTools>
    </Agent>,
  );
  if (options.phone !== false) runtime.updateInfo({ "caller.identity": "sip_caller-1", "caller.phoneNumber": "+491701234567" });
  const sent: OutgoingHostMessage[] = [];
  runtime.messages.connectHost((message) => {
    sent.push(message);
    queueMicrotask(() => {
      void runtime.messages.deliver("host", { id: "r-1", key: "reply", payload: { transferId: "t-1" }, inReplyTo: message.id });
      queueMicrotask(() =>
        void runtime.messages.deliver("host", {
          id: "res-1",
          key: CALL_TRANSFER_RESULT_MESSAGE,
          payload: { transferId: "t-1", outcome: options.outcome ?? "answered" },
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
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const tools = () => runtime.snapshot().context.tools.map((tool) => tool.name);
  return { runtime, sent, handoffs, requests, callbacks, errors, tools };
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
  const lookup = (id: string) => ({ text: "", toolCalls: [{ id, name: "lookup", input: {} }] });

  async function turn(target: AgentSession, input: string) {
    const events: AgentTurnStreamEvent[] = [];
    for await (const event of target.runTurnStream(input, { spoken: true })) events.push(event);
    return events;
  }

  it("after three failed tool calls in a row, with the reason agent_failure and its line in the agent's language", async () => {
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

  it("counts failures across turns", async () => {
    const { runtime, handoffs } = call();
    const sorry = { text: "Sorry, let me try again.", toolCalls: [] };
    const target = session(runtime, [lookup("c1"), sorry, lookup("c2"), sorry, lookup("c3")]);
    await turn(target, "one");
    await turn(target, "two");
    expect(handoffs).toHaveLength(0);
    await turn(target, "three");
    expect(handoffs).toHaveLength(1);
  });

  it("starts the count again after a tool that works, and leaves framework tools out", async () => {
    const { runtime, handoffs } = call();
    const greet = { text: "", toolCalls: [{ id: "g", name: "greet", input: {} }] };
    const skip = { text: "", toolCalls: [{ id: "s", name: "skip_turn", input: {} }] };
    const target = session(runtime, [lookup("c1"), lookup("c2"), greet, lookup("c3"), lookup("c4"), { text: "Sorry.", toolCalls: [] }]);
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

  it("never with afterFailures false", async () => {
    const { runtime, handoffs } = call({ props: { afterFailures: false } });
    const target = session(runtime, [lookup("c1"), lookup("c2"), lookup("c3"), lookup("c4")]);
    await turn(target, "Where is my order?");
    expect(handoffs).toHaveLength(0);
  });

  it("after three turns in a row got no reply, in place of the apology", async () => {
    const { runtime, handoffs } = call({ props: { hours: CLOSED } });
    const down = new Error("provider unavailable");
    const target = session(runtime, [down, down, down]);
    const heard = async (input: string) =>
      (await turn(target, input)).flatMap((event) => (event.type === "delta" ? [event.delta] : [])).join("");
    expect(await heard("one")).toContain(fallbackReplies("en").turnFailed);
    expect(await heard("two")).toContain(fallbackReplies("en").turnFailed);
    expect(await heard("three")).not.toContain(fallbackReplies("en").turnFailed);
    expect(handoffs).toEqual([
      expect.objectContaining({ reason: "agent_failure", outcome: "closed", summary: expect.stringContaining("provider unavailable") }),
    ]);
  });
});
