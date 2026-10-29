import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import { sayCommand, type SayHost } from "./cli/say.js";
import { defineAgent } from "./config.js";
import { Agent, AgentAuthoringError, AgentSiteRuntime, Field, Skill, Skills, Tool, z, type AgentRoute } from "./index.js";
import { pendingLine } from "./llm/confirmation.js";
import type { AgentRunResponse } from "./llm/types.js";
import { rebuildSessionAt } from "./server/session-rewind.js";
import {
  APPOINTMENTS,
  LENA,
  LISA,
  bookCall,
  bookSchema,
  booked,
  bookingRuntime,
  callsBook,
  contextEvents,
  readBackOf,
  says,
  scripted,
  scriptedStream,
  streamTurn,
  waitingLines,
  type Booking,
} from "./test-fixtures/booking.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "./types.js";

/**
 * `<Tool confirm>`: the model's call is held, the caller hears the read-back, and only the
 * caller's yes on a later turn runs `onSubmit`. The agent's LLM and the confirmation check
 * are both fakes (`test-fixtures/booking.tsx`); the regressions across hosts and
 * interruptions are in `agent-session-confirm-hosts.test.tsx`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a tool that asks the caller first (<Tool confirm>)", () => {
  it("never runs on the model's call: the turn ends with the read-back, said once", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, requests } = scripted([{ text: "Perfect, booking it now.", toolCalls: [bookCall(LISA)] }]);
    const session = new AgentSession(runtime, llm);

    const reply = await session.runTurn("Tuesday at three, lisa@example.com.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(reply).toBe(readBackOf(LISA));
    expect(requests).toHaveLength(1);
    expect(session.pendingConfirmation).toEqual({
      toolName: "book_meeting",
      input: LISA,
      readBack: readBackOf(LISA),
      toolCallId: "c1",
      skillPath: APPOINTMENTS,
      heldAt: 1,
      // Typed: heard as it is said.
      heardAt: 1,
    });
    const [, step, held, readBack, ...rest] = session.messages;
    expect(rest).toEqual([]);
    // The model's own call is on record as not run, so rewind never replays it.
    expect(step).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "book_meeting",
          invalid: `Not run: held for the caller's yes to "${readBackOf(LISA)}".`,
          heldFor: readBackOf(LISA),
        },
      ],
    });
    expect(held).toMatchObject({ role: "tool", toolCallId: "c1", result: { ok: false } });
    expect(held?.role === "tool" && held.result.message).toMatch(/^Held, not run: nothing has happened yet\./);
    expect(readBack).toEqual({ role: "assistant", content: readBackOf(LISA), at: expect.any(Number) });
  });

  it("tells the model what the tool does, and keeps the held action in its context", async () => {
    const { runtime } = bookingRuntime();
    const { llm, requests } = scripted([callsBook(LISA), says("Sorry, is lisa@example.com right?")], ["unclear"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Book Tuesday at three.");
    const tool = requests[0]!.tools.find((definition) => definition.name === "book_meeting");
    expect(tool?.description).toMatch(/^Book the chosen slot\. Calling this tool does not run it yet/);
    expect(waitingLines(requests[0]!)).toEqual([]);

    await session.runTurn("Hm?");
    expect(waitingLines(requests[1]!)).toEqual([pendingLine(session.pendingConfirmation!)]);
    expect(requests[1]!.stateSnapshot[1]).toBe(
      `Waiting for the caller to confirm: "${readBackOf(LISA)}" (book_meeting). It runs only when the caller says yes; it has not run yet.`,
    );
  });

  it("a yes on the next turn runs onSubmit exactly once, and the model speaks from its result", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, requests, checks } = scripted(
      [callsBook(LISA), says("Done, see you on Tuesday at three."), says("You're welcome.")],
      ["yes"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    const reply = await session.runTurn("Ja, genau.");
    await session.runTurn("Thanks.");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(LISA);
    expect(reply).toBe("Done, see you on Tuesday at three.");
    expect(session.pendingConfirmation).toBeNull();
    // One check, on the read-back and the caller's words alone.
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      stateSnapshot: [`question: ${readBackOf(LISA)}`, "answer: Ja, genau."],
      tools: [],
      messages: [],
    });
    // The confirmed call is in the transcript, marked with the words that confirmed it.
    const [answer, confirmed, result, spoken] = session.messages.slice(4);
    expect(answer).toMatchObject({ role: "user", content: "Ja, genau." });
    expect(confirmed).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "book_meeting", input: LISA, confirmedBy: "Ja, genau." }],
    });
    expect(confirmed?.role === "assistant" && confirmed.toolCalls?.[0]?.invalid).toBeUndefined();
    expect(result).toMatchObject({ role: "tool", toolName: "book_meeting", result: booked(LISA) });
    expect(spoken).toMatchObject({ role: "assistant", content: "Done, see you on Tuesday at three." });
    // The model's step after the yes sees the result, and nothing waiting any more.
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", result: booked(LISA) });
    expect(waitingLines(requests[1]!)).toEqual([]);
  });

  it("streams the confirmed call as a tool event before the model's answer", async () => {
    const { runtime } = bookingRuntime();
    const { llm } = scripted([], ["yes"]);
    const streamLlm = scriptedStream([callsBook(LISA), says("Done, see you on Tuesday.")]);
    const session = new AgentSession(runtime, llm, { streamLlm });

    const asked = await streamTurn(session, "Tuesday at three, lisa@example.com.");
    expect(asked.deltas).toEqual([readBackOf(LISA)]);
    expect(asked.tools).toEqual([["book_meeting", false]]);

    const answered = await streamTurn(session, "Yes.");
    expect(answered.tools).toEqual([["book_meeting", true]]);
    expect(answered.deltas.join("")).toBe("Done, see you on Tuesday.");
  });

  it("a no drops the held action and tells the model nothing was done", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, requests } = scripted([callsBook(LISA), says("Which day suits you better?")], ["no"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("No, not Tuesday.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation).toBeNull();
    const note = 'The caller did not confirm: "No, not Tuesday.". Nothing was done; book_meeting did not run.';
    expect(contextEvents(session.messages)).toEqual([note]);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", kind: "context_event", content: note });
    expect(waitingLines(requests[1]!)).toEqual([]);
  });

  it("an unclear answer keeps the action held and asks the model to ask once more", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted(
      [callsBook(LISA), says("Is lisa@example.com right?"), says("Booked.")],
      ["unclear", "yes"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("What did you say?");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.input).toEqual(LISA);
    expect(contextEvents(session.messages)).toEqual([
      'The caller\'s answer was not a clear yes: "What did you say?". Nothing was done yet; book_meeting still waits for their yes. Ask once more, briefly.',
    ]);

    await session.runTurn("Yes, that's right.");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a correction replaces the held action, and the yes runs only the corrected one", async () => {
    const lenaWednesday: Booking = { ...LENA, start: "Wednesday 10:00" };
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted(
      [callsBook(LISA, "c1"), callsBook(LENA, "c2"), callsBook(lenaWednesday, "c3"), says("Booked for Lena.")],
      ["unclear", "no", "yes"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    // Calling it again while one is held replaces it.
    expect(await session.runTurn("It's lena, not lisa.")).toBe(readBackOf(LENA));
    expect(session.pendingConfirmation?.input).toEqual(LENA);
    // A no, and the model holds the corrected call in the same turn.
    expect(await session.runTurn("No, Wednesday at ten.")).toBe(readBackOf(lenaWednesday));
    expect(session.pendingConfirmation?.input).toEqual(lenaWednesday);

    await session.runTurn("Yes.");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(lenaWednesday);
  });

  it("a model that claims success without the caller's yes changes nothing", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted(
      [callsBook(LISA, "c1"), says("Your appointment is booked."), callsBook(LISA, "c2"), says("Okay.")],
      ["unclear", "unclear", "no"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    expect(await session.runTurn("Hmm.")).toBe("Your appointment is booked.");
    expect(session.pendingConfirmation?.input).toEqual(LISA);
    // Calling the tool again only asks again.
    expect(await session.runTurn("Is it done?")).toBe(readBackOf(LISA));
    await session.runTurn("Forget it.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation).toBeNull();
  });

  it("a check that fails counts as unclear: the action stays held, the cause is logged and traced", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted([callsBook(LISA), says("Sorry, was that a yes?")], [new Error("provider down")]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("Yes.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.input).toEqual(LISA);
    expect(contextEvents(session.messages)[0]).toMatch(/^The caller's answer was not a clear yes: "Yes\."/);
    expect(session.llmTrace.find((call) => call.error === "provider down")?.input.system).toContain(
      "Reply with exactly one word",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[curb] the confirmation check failed; the answer counts as unclear:",
      expect.any(Error),
    );
  });

  it("framework input never answers: the silence follow-up runs no check", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, requests, checks } = scripted([callsBook(LISA), says("Are you still there?")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("(the user has been quiet)", { kind: "synthetic" });

    expect(checks).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(waitingLines(requests[1]!)).toHaveLength(1);
  });

  it("input that was already waiting when the action was held does not answer it", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, checks } = scripted([callsBook(LISA), says("Was that a yes to lisa@example.com?")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    // "Yes." arrives while the first turn runs: it was said before the read-back.
    const first = session.runTurn("Tuesday at three, lisa@example.com.");
    const second = session.runTurn("Yes.");
    expect(await first).toBe(readBackOf(LISA));
    await second;

    expect(checks).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.input).toEqual(LISA);
  });

  it("a confirmed action that fails reaches the model through the tool result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const taken = bookingRuntime(async () => ({ ok: false, message: "That slot was just taken." }));
    const failing = bookingRuntime(async () => {
      throw new Error("calendar API 503");
    });
    for (const [{ runtime }, expected] of [
      [taken, "That slot was just taken."],
      [failing, "book_meeting failed because of an internal error, not because of the input."],
    ] as const) {
      const { llm, requests } = scripted([callsBook(LISA), says("Sorry, that did not work.")], ["yes"]);
      const session = new AgentSession(runtime, llm);
      await session.runTurn("Tuesday at three, lisa@example.com.");
      await session.runTurn("Yes.");

      const result = requests[1]!.messages.at(-1);
      expect(result).toMatchObject({ role: "tool", toolName: "book_meeting", result: { ok: false } });
      expect(result?.role === "tool" && result.result.message).toContain(expected);
      expect(session.pendingConfirmation).toBeNull();
    }
    expect(consoleError).toHaveBeenCalledWith('[curb] tool "book_meeting" threw:', expect.any(Error));
  });

  it("wrong input is refused like any tool call, and nothing is held", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, requests } = scripted([
      callsBook({ email: "not-an-email", start: "Tuesday 15:00" }, "c1"),
      callsBook({ ...LISA, start: "Sunday" }, "c2"),
      callsBook(LISA, "c3"),
    ]);
    const session = new AgentSession(runtime, llm);

    const reply = await session.runTurn("Book me in.");

    expect(reply).toBe(readBackOf(LISA));
    expect(requests).toHaveLength(3);
    const results = session.messages.flatMap((message) => (message.role === "tool" ? [message.result] : []));
    expect(results[0]).toEqual({ ok: false, message: "Email address is invalid. Ask the caller again." });
    expect(results[1]).toMatchObject({ ok: false, message: "We are closed on Sundays. Offer a weekday." });
    expect(session.pendingConfirmation?.input).toEqual(LISA);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a step that asks the caller keeps the call open and says nothing but the read-back", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const hangUp = vi.fn();
    runtime.setEndCallRequest(hangUp);
    const streamLlm = scriptedStream([
      {
        text: "Thanks for calling, goodbye.",
        toolCalls: [
          bookCall(LISA),
          { id: "c2", name: END_CALL_TOOL_NAME, input: { goodbye: "Glad I could help. Take care." } },
          bookCall(LENA, "c3"),
        ],
      },
    ]);
    const session = new AgentSession(runtime, scripted([]).llm, { streamLlm });

    const { deltas, tools } = await streamTurn(session, "Tuesday at three, lisa@example.com, bye.");

    // The read-back, not the goodbye: the call stays open for the caller's answer.
    expect(deltas).toEqual([readBackOf(LISA)]);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: readBackOf(LISA) });
    expect(hangUp).not.toHaveBeenCalled();
    expect(tools).toEqual([
      ["book_meeting", false],
      [END_CALL_TOOL_NAME, false],
      ["book_meeting", false],
    ]);
    // One question at a time: the first call is the one held.
    expect(session.pendingConfirmation?.input).toEqual(LISA);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rewind runs neither the held call nor the confirmed one again", async () => {
    const { runtime } = bookingRuntime();
    const { llm } = scripted([callsBook(LISA), says("Booked."), says("Bye.")], ["yes"]);
    const session = new AgentSession(runtime, llm);
    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("Yes.");
    await session.runTurn("Thanks.");
    const userAt = session.messages.flatMap((message, index) =>
      message.role === "user" && !message.kind ? [index] : [],
    );

    const rewindTo = async (index: number) => {
      const fresh = bookingRuntime();
      const { skipped } = await rebuildSessionAt({
        create: async () => ({ runtime: fresh.runtime, session: new AgentSession(fresh.runtime, llm) }),
        agentId: "appointments",
        sourceMessages: session.messages,
        index,
        liveInfo: {},
      });
      return { onSubmit: fresh.onSubmit, skipped };
    };
    // Before the yes: only the held call is kept, and it is not replayed.
    const before = await rewindTo(userAt[1]!);
    expect(before.onSubmit).not.toHaveBeenCalled();
    expect(before.skipped).toEqual([]);
    // After the yes: the confirmed call is not run again either, and the rewind says so.
    const after = await rewindTo(userAt[2]!);
    expect(after.onSubmit).not.toHaveBeenCalled();
    expect(after.skipped).toEqual(["book_meeting"]);
  });

  it("works on a tool whose fields are <Field> children, and reset() drops the held action", async () => {
    const onSubmit = vi.fn(async (input: Record<string, unknown>) => ({ ok: true, message: `Cancelled ${String(input.order)}.` }));
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          name="cancel_order"
          description="Cancel an order."
          confirm={(input) => `Cancel order ${String(input.order)}?`}
          onSubmit={onSubmit}
        >
          <Field name="order" type="string" required description="The order number." />
        </Tool>
      </Agent>,
    );
    expect(runtime.confirms("cancel_order")).toBe(true);
    const cancel: AgentRunResponse = { text: "", toolCalls: [{ id: "c1", name: "cancel_order", input: { order: "A-17" } }] };
    const { llm } = scripted([cancel, cancel, says("Cancelled.")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    expect(await session.runTurn("Cancel A-17.")).toBe("Cancel order A-17?");
    session.reset();
    expect(session.pendingConfirmation).toBeNull();

    expect(await session.runTurn("Cancel A-17.")).toBe("Cancel order A-17?");
    await session.runTurn("Yes, cancel it.");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ order: "A-17" });
  });

  it("refuses confirm on an onCall tool instead of running it without a yes", () => {
    // The render error is logged; the runtime then has no tree to compile.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const untyped = { name: "cancel_contract", description: "Cancel.", onCall: () => ({ ok: true }), confirm: () => "Sure?" };
    expect(
      () =>
        new AgentSiteRuntime(
          <Agent>
            <Tool {...(untyped as unknown as { name: string; description: string; onCall: () => ToolResult })} />
          </Agent>,
        ),
    ).toThrow(AgentAuthoringError);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("confirm works only on a tool with onSubmit") }),
    );
  });

  it("is an ordinary tool to curb check: no findings", () => {
    function Booking() {
      return (
        <Tool
          schema={bookSchema}
          name="book_meeting"
          description="Book the chosen slot."
          confirm={(input) => readBackOf(input)}
          onSubmit={async (input) => booked(input)}
        />
      );
    }
    function BookingAgent() {
      return (
        <Agent>
          <Skills>
            <Skill path={APPOINTMENTS}>Appointments</Skill>
          </Skills>
        </Agent>
      );
    }
    const routes: AgentRoute[] = [
      {
        path: APPOINTMENTS,
        Component: Booking,
        meta: { title: "Appointments", description: "Book an appointment." },
        moduleId: "./appointments/skill.tsx",
        source: `export default function Booking() { return <Tool name="book_meeting" description="Book." confirm={ask} onSubmit={book} />; }`,
      },
    ];
    const diagnostics = diagnoseAgentAuthoring({
      id: "appointments",
      definition: defineAgent({ app: BookingAgent }),
      routes,
    });
    expect(diagnostics).toEqual([]);
  });

  it("a tool without confirm runs on the model's call, as before", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool schema={z.object({ text: z.string() })} name="save_note" description="Save a note." onSubmit={onSubmit} />
      </Agent>,
    );
    const { llm, requests } = scripted([
      { text: "", toolCalls: [{ id: "c1", name: "save_note", input: { text: "hi" } }] },
      says("Saved."),
    ]);
    const session = new AgentSession(runtime, llm);

    expect(runtime.confirms("save_note")).toBe(false);
    expect(await session.runTurn("Note: hi")).toBe("Saved.");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(requests[0]!.tools.find((tool) => tool.name === "save_note")?.description).toBe("Save a note.");
    expect(session.pendingConfirmation).toBeNull();
  });
  it("continues across curb say invocations: the next process's yes runs the held action", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "curb-say-confirm-"));
    try {
      const onSubmit = vi.fn(async (input: Booking) => booked(input));
      const { llm } = scripted([callsBook(LISA), says("Booked, see you Tuesday.")], ["yes"]);
      // Each curb say is a new process: a fresh runtime and session on the saved conversation.
      const host: SayHost = {
        async createBundle() {
          const { runtime } = bookingRuntime(onSubmit);
          return { runtime, session: new AgentSession(runtime, llm), agentId: "appointments" };
        },
        skillPaths: async () => [APPOINTMENTS],
      };
      const out: string[] = [];
      const write = (text: string) => void out.push(text);

      expect(await sayCommand(["Book Tuesday 15:00 for lisa@example.com"], projectRoot, { host, out: write })).toBe(0);
      expect(out.join("")).toContain(readBackOf(LISA));
      expect(out.join("")).toContain("[tool book_meeting held]");
      expect(onSubmit).not.toHaveBeenCalled();

      out.length = 0;
      expect(await sayCommand(["Yes"], projectRoot, { host, out: write })).toBe(0);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toEqual(LISA);
      expect(out.join("")).toContain("Booked, see you Tuesday.");
      expect(out.join("")).toContain("[tool book_meeting ok]");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
