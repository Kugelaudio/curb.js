import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { SAY_SESSION_PATH, sayCommand, type SayHost } from "./cli/say.js";
import { Agent, AgentSiteRuntime, Skill, Skills, Tool, defineTool, z } from "./index.js";
import { isConfirmationRequest } from "./llm/confirmation.js";
import type { AgentChatMessage, AgentRunRequest, AgentRunResponse } from "./llm/types.js";
import { attachConversationSink } from "./server/conversation-store.js";
import { rebuildSessionAt } from "./server/session-rewind.js";
import {
  APPOINTMENTS,
  LENA,
  LISA,
  bookCall,
  booked,
  bookingRuntime,
  callsBook,
  contextEvents,
  drainTurn,
  readBackOf,
  says,
  scripted,
  scriptedStream,
  type Booking,
} from "./test-fixtures/booking.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "./types.js";

/**
 * Paths around `<Tool confirm>` where `onSubmit` must still never run without the caller's
 * yes: the conversation store and reopening from it, rewind, `curb say` across processes, a
 * caller who cuts the read-back off or talks over the turn. Each was found in review.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** A conversation sink that keeps what a store would: a JSON copy of each seq's latest write,
 * and every write in order. */
function storeOf(session: AgentSession) {
  const stored = new Map<number, AgentChatMessage>();
  const writes: Array<{ seq: number; message: AgentChatMessage }> = [];
  const recorder = attachConversationSink(
    {
      startConversation: async () => "conversation-1",
      recordMessage: async (_conversationId, seq, message) => {
        const copy = JSON.parse(JSON.stringify(message)) as AgentChatMessage;
        stored.set(seq, copy);
        writes.push({ seq, message: copy });
      },
    },
    session,
    "appointments",
  );
  const messages = () => [...stored.keys()].sort((a, b) => a - b).map((seq) => stored.get(seq)!);
  return { recorder, messages, writes };
}

/** A turn on a voice host: its reply plays out, and the host reports how each reply ended. */
const VOICE = { spoken: true, readBackHeardOnPlayout: true } as const;

/** What the model reads when the caller spoke before the read-back of `input` played to its end. */
const cutNote = (input: Booking = LISA) =>
  `The caller cut off the question "${readBackOf(input)}" before its end, so it was not asked and nothing was done. Call book_meeting again so the whole question is read back.`;

/** Rebuild `messages` onto a fresh booking agent, as reopening a stored conversation or a
 * rewind does. */
async function reopen(messages: readonly AgentChatMessage[], llm: AgentLlmClient, index = messages.length) {
  const fresh = bookingRuntime();
  const session = new AgentSession(fresh.runtime, llm);
  const rebuilt = await rebuildSessionAt({
    create: async () => ({ runtime: fresh.runtime, session }),
    agentId: "appointments",
    sourceMessages: messages,
    index,
    liveInfo: {},
  });
  return { session, onSubmit: fresh.onSubmit, skipped: rebuilt.skipped };
}

/** A `confirm` that answers only when released, as one that looks a slot up would. */
function gatedConfirm() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const confirm = async (input: Booking) => {
    await gate;
    return readBackOf(input);
  };
  return { confirm, release };
}

/** Each curb say is a new process: a fresh runtime and session on the saved conversation. */
function sayHost(llm: AgentLlmClient, onSubmit: (input: Booking) => Promise<ToolResult>): SayHost {
  return {
    async createBundle() {
      const { runtime } = bookingRuntime(onSubmit);
      return { runtime, session: new AgentSession(runtime, llm), agentId: "appointments" };
    },
    skillPaths: async () => [APPOINTMENTS],
  };
}

describe("the conversation store", () => {
  it("keeps the held mark, so reopening a declined conversation runs nothing", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted([callsBook(LISA), says("Okay, nothing is booked.")], ["no"]);
    const session = new AgentSession(runtime, llm);
    const store = storeOf(session);

    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("No, do not book it.");
    await store.recorder.flush();

    expect(store.messages()[1]).toMatchObject({
      toolCalls: [{ id: "c1", heldFor: readBackOf(LISA), invalid: expect.stringContaining("held") }],
    });
    const reopened = await reopen(store.messages(), llm);
    expect(reopened.onSubmit).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reopening a confirmed conversation runs the action again never, and says so", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted([callsBook(LISA, "toolu_A"), says("Booked.")], ["yes"]);
    const session = new AgentSession(runtime, llm);
    const store = storeOf(session);

    await session.runTurn("Book Lisa Tuesday 15:00.");
    await session.runTurn("Yes.");
    await store.recorder.flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const reopened = await reopen(store.messages(), llm);
    expect(reopened.onSubmit).not.toHaveBeenCalled();
    expect(reopened.skipped).toEqual(["book_meeting"]);
  });

  it("the first write of a step that asks the caller already marks the call as held", async () => {
    const { confirm, release } = gatedConfirm();
    const { runtime } = bookingRuntime(undefined, confirm);
    const { llm } = scripted([callsBook(LISA)]);
    const session = new AgentSession(runtime, llm);
    const store = storeOf(session);

    const asked = session.runTurn("Book Tuesday at three for lisa@example.com.");
    // The step is stored while confirm still looks the slot up.
    await vi.waitFor(() => expect(store.writes.some((write) => write.seq === 1)).toBe(true));
    release();
    await asked;
    await store.recorder.flush();

    const marks = store.writes
      .filter((write) => write.seq === 1)
      .map(({ message }) => message.role === "assistant" && message.toolCalls?.[0]);
    expect(marks[0]).toMatchObject({ id: "c1", invalid: "Not run: held for the caller's yes." });
    expect(marks.at(-1)).toMatchObject({
      id: "c1",
      invalid: `Not run: held for the caller's yes to "${readBackOf(LISA)}".`,
      heldFor: readBackOf(LISA),
    });
  });
});

describe("a read-back on a voice host counts as asked only once it played to its end", () => {
  it("played to its end, it is answered, whatever its words and punctuation", async () => {
    const { runtime, onSubmit } = bookingRuntime(
      undefined,
      (input) => `Je réserve ${input.start} pour ${input.email}, c'est bien ça ?`,
    );
    const { llm, checks } = scripted([callsBook(LISA), says("C'est réservé.")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Mardi à quinze heures, lisa@example.com.", VOICE);
    session.replyPlayed();

    expect(await session.runTurn("Oui, c'est ça.", VOICE)).toBe("C'est réservé.");
    expect(checks).toHaveLength(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("with no report at all (nothing of it played), the next words drop it", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, checks } = scripted([callsBook(LISA), says("Sorry, go ahead.")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.", VOICE);
    await session.runTurn("Yes.", VOICE);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(checks).toHaveLength(0);
    expect(contextEvents(session.messages)).toEqual([cutNote()]);
    expect(session.pendingConfirmation).toBeNull();
  });

  it("words the turn said before the read-back do not count as hearing it", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, checks } = scripted([], ["yes"]);
    const streamLlm = scriptedStream([
      { text: "Great, thanks for waiting. I have everything I need. Let me book that.", toolCalls: [bookCall(LISA)] },
      says("Sorry, go ahead."),
    ]);
    const session = new AgentSession(runtime, llm, { streamLlm });

    const asked = await drainTurn(session.runTurnStream("Tuesday at three, lisa@example.com.", VOICE));
    expect(asked.deltas.join("")).toBe(`Great, thanks for waiting. I have everything I need. ${readBackOf(LISA)}`);
    // LiveKit reports every word heard in the turn: the two sentences, none of the read-back.
    session.reconcileInterruptedReply("Great thanks for waiting I have everything I need");
    await drainTurn(session.runTurnStream("Okay, great.", VOICE));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(checks).toHaveLength(0);
    expect(contextEvents(session.messages)).toEqual([cutNote()]);
  });

  it("cut off, it is not answered, however many of its words the host counts as heard", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, checks } = scripted([callsBook(LISA), says("Sorry, go ahead.")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.", VOICE);
    // Kugel TTS aligns the normalized text: as many words as the read-back has, yet the
    // caller heard neither the time nor the question.
    session.reconcileInterruptedReply("lisa at example dot com Tuesday");
    await session.runTurn("Yes.", VOICE);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(checks).toHaveLength(0);
    expect(contextEvents(session.messages)).toEqual([cutNote()]);
  });

  it("cut off before its end, it does not count as asked: the model asks again", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm, checks } = scripted([callsBook(LISA, "c1"), callsBook(LISA, "c2")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Book Tuesday at three for lisa@example.com.", VOICE);
    // The caller said "Ja." after hearing only the email.
    session.reconcileInterruptedReply("lisa@example.com,");

    expect(await session.runTurn("Ja.", VOICE)).toBe(readBackOf(LISA));
    expect(contextEvents(session.messages)).toEqual([cutNote()]);
    expect(checks).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.toolCallId).toBe("c2");
  });

  it("a cut report that lands after the caller's next turn changes nothing", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const { llm } = scripted([callsBook(LISA), says("Sorry, which day was it?")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.", VOICE);
    // LiveKit's user-turn path: the next turn starts before the cut read-back's item is committed.
    await session.runTurn("Yes.", VOICE);
    const before = session.messages;
    session.reconcileInterruptedReply("lisa@example.com,");

    expect(session.messages).toBe(before);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a cut report that lands while the next turn runs changes nothing, and the model reads the cut note", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const requests: AgentRunRequest[] = [];
    let holding = false;
    let entered = () => {};
    const inCall = new Promise<void>((resolve) => (entered = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const llm: AgentLlmClient = async (request) => {
      if (holding) {
        holding = false;
        entered();
        await released;
      }
      if (isConfirmationRequest(request)) return { text: "yes", toolCalls: [] };
      requests.push(request);
      return requests.length === 1 ? callsBook(LISA) : says("Sorry, let me read it back once more.");
    };
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Tuesday at three, lisa@example.com.", VOICE);
    holding = true;
    const next = session.runTurn("Yes.", VOICE);
    await inCall;
    session.reconcileInterruptedReply("lisa@example.com,");
    release();
    await next;

    expect(onSubmit).not.toHaveBeenCalled();
    expect(contextEvents(requests.at(-1)!.messages)).toEqual([cutNote()]);
    expect(contextEvents(session.messages)).toEqual([cutNote()]);
    expect(session.messages.some((message) => message.role === "assistant" && message.interruption)).toBe(false);
  });
});

describe("a caller who interrupts", () => {
  it("talking over a turn while confirm runs holds nothing: the barge-in is not an answer", async () => {
    const { confirm, release } = gatedConfirm();
    const { runtime, onSubmit } = bookingRuntime(undefined, confirm);
    const { llm, checks } = scripted([], ["yes"]);
    const streamLlm = scriptedStream([callsBook(LISA), says("Sorry, what was that?")]);
    const session = new AgentSession(runtime, llm, { streamLlm });

    const first = session.runTurnStream("Book Tuesday at three for lisa@example.com.", { spoken: true });
    const firstDone = drainTurn(first);
    await vi.waitFor(() =>
      expect(session.messages.some((message) => message.role === "assistant" && message.toolCalls?.length)).toBe(true),
    );
    // The barge-in: spoken input cancels the turn, and the voice host returns its stream.
    const secondDone = drainTurn(session.runTurnStream("Ja genau, Dienstag um drei.", { spoken: true }));
    void first.return(undefined);
    release();
    const heard = await firstDone;
    await secondDone;

    expect(heard.deltas).toEqual([]);
    expect(checks).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation).toBeNull();
  });

  it("typed input that arrived while confirm ran does not answer the read-back", async () => {
    const { confirm, release } = gatedConfirm();
    const { runtime, onSubmit } = bookingRuntime(undefined, confirm);
    const { llm, checks } = scripted([callsBook(LISA), says("Was that a yes to lisa@example.com?")], ["yes"]);
    const session = new AgentSession(runtime, llm);

    const first = session.runTurn("Book Tuesday at three for lisa@example.com, yes go ahead.");
    await vi.waitFor(() =>
      expect(session.messages.some((message) => message.role === "assistant" && message.toolCalls?.length)).toBe(true),
    );
    // Typed before any read-back existed.
    const second = session.runTurn("Yes please, thanks!");
    release();
    expect(await first).toBe(readBackOf(LISA));
    await second;

    expect(checks).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.readBack).toBe(readBackOf(LISA));
  });

  it("talking over the check runs nothing, and the barge-in is the answer checked next", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const answers: string[] = [];
    let steps = 0;
    const llm: AgentLlmClient = async (request) => {
      if (isConfirmationRequest(request)) {
        answers.push(request.stateSnapshot[1]!);
        if (answers.length === 1) {
          // Answers only when aborted: the caller talks over it.
          return new Promise((_resolve, reject) =>
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason)),
          );
        }
        return { text: "no", toolCalls: [] };
      }
      steps += 1;
      return steps === 1 ? callsBook(LISA) : says("Okay, not booked.");
    };
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Book Tuesday at three for lisa@example.com.");
    const first = session.runTurn("Ja", { spoken: true });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const second = session.runTurn("Nein, Moment!", { spoken: true });
    await first;
    await second;

    expect(answers).toEqual(["answer: Ja", "answer: Nein, Moment!"]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation).toBeNull();
  });
});

describe("what the caller hears in a step that asks", () => {
  it("an end_call before the confirm tool says no goodbye: only the read-back", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const hangUp = vi.fn();
    runtime.setEndCallRequest(hangUp);
    const streamLlm = scriptedStream([
      {
        text: "Thanks for calling, goodbye.",
        toolCalls: [{ id: "c0", name: END_CALL_TOOL_NAME, input: { goodbye: "Glad I could help. Take care." } }, bookCall(LISA)],
      },
    ]);
    const session = new AgentSession(runtime, scripted([]).llm, { streamLlm });

    const { deltas } = await drainTurn(session.runTurnStream("Tuesday at three, bye.", { spoken: true }));

    expect(deltas).toEqual([readBackOf(LISA)]);
    expect(hangUp).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("documented limit: whole sentences before the call are said, and still nothing runs", async () => {
    const { runtime, onSubmit } = bookingRuntime();
    const streamLlm = scriptedStream([{ text: "Alright, it's booked. Anything else?", toolCalls: [bookCall(LISA)] }]);
    const session = new AgentSession(runtime, scripted([]).llm, { streamLlm });

    const { deltas } = await drainTurn(session.runTurnStream("Book Tuesday at three.", { spoken: true }));

    // Released before the call showed (no latency cost on every reply); see authoring.md.
    expect(deltas.join("")).toBe(`Alright, it's booked. ${readBackOf(LISA)}`);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(session.pendingConfirmation?.readBack).toBe(readBackOf(LISA));
  });
});

describe("rewind", () => {
  it("rewinding to a conversation that ends on the read-back keeps the question open", async () => {
    const { runtime } = bookingRuntime();
    const { llm, checks } = scripted([callsBook(LISA), says("Booked, see you Tuesday.")], ["yes"]);
    const session = new AgentSession(runtime, llm);
    await session.runTurn("Book Tuesday at three for lisa@example.com.");

    const reopened = await reopen(session.messages, llm);
    expect(reopened.session.pendingConfirmation).toMatchObject({ toolCallId: "c1", readBack: readBackOf(LISA) });
    expect(await reopened.session.runTurn("Yes.")).toBe("Booked, see you Tuesday.");
    expect(checks).toHaveLength(1);
    expect(reopened.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("rewinding to before the read-back, or past the answer, holds nothing", async () => {
    const { runtime } = bookingRuntime();
    const { llm } = scripted([says("Which slot?"), callsBook(LISA), says("Okay.")], ["no"]);
    const session = new AgentSession(runtime, llm);
    await session.runTurn("I need an appointment.");
    await session.runTurn("Tuesday at three, lisa@example.com.");
    await session.runTurn("No.");
    const userAt = session.messages.flatMap((message, index) => (message.role === "user" && !message.kind ? [index] : []));

    expect((await reopen(session.messages, llm, userAt[1])).session.pendingConfirmation).toBeNull();
    expect((await reopen(session.messages, llm)).session.pendingConfirmation).toBeNull();
  });
});

describe("curb say", () => {
  it("a turn that fails after the yes is saved, so running Yes again does not book twice", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const projectRoot = mkdtempSync(join(tmpdir(), "curb-say-confirm-"));
    try {
      const onSubmit = vi.fn(async (input: Booking) => booked(input));
      let steps = 0;
      const llm: AgentLlmClient = async (request) => {
        if (isConfirmationRequest(request)) return { text: "yes", toolCalls: [] };
        steps += 1;
        if (steps === 1) return callsBook(LISA);
        if (steps === 2) throw new Error("provider down");
        return says("You're booked for Tuesday.");
      };
      const host = sayHost(llm, onSubmit);
      const out: string[] = [];
      const write = (text: string) => void out.push(text);

      expect(await sayCommand(["Book Tuesday 15:00 for lisa@example.com"], projectRoot, { host, out: write })).toBe(0);
      expect(await sayCommand(["Yes"], projectRoot, { host, out: write })).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "note: This turn failed after running tools (book_meeting), so it was saved anyway: running it again would run them twice. Continue with the next caller line, or start over with curb say --new.",
      );
      expect(await sayCommand(["Yes"], projectRoot, { host, out: write })).toBe(0);

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(out.at(-1)).toContain("You're booked for Tuesday.");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("confirmed calls get ids of their own across processes", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "curb-say-ids-"));
    try {
      const onSubmit = vi.fn(async (input: Booking) => booked(input));
      const steps: AgentRunResponse[] = [
        callsBook(LISA, "toolu_A"),
        says("Booked."),
        callsBook({ ...LENA, start: "Wednesday 10:00" }, "toolu_B"),
        says("Booked Lena."),
      ];
      let step = 0;
      const llm: AgentLlmClient = async (request) =>
        isConfirmationRequest(request) ? { text: "yes", toolCalls: [] } : steps[step++]!;
      const host = sayHost(llm, onSubmit);
      for (const words of ["Book Lisa Tuesday 15:00", "Yes", "Also Lena Wednesday 10:00", "Yes"]) {
        expect(await sayCommand([words], projectRoot, { host, out: () => {} })).toBe(0);
      }

      const saved = JSON.parse(readFileSync(join(projectRoot, SAY_SESSION_PATH), "utf8")) as {
        messages: AgentChatMessage[];
      };
      const ids = saved.messages.flatMap((message) =>
        message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
      );
      expect(ids).toEqual(["toolu_A", "toolu_A_yes", "toolu_B", "toolu_B_yes"]);
      expect(onSubmit).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("which action a yes runs", () => {
  it("holding another confirm tool names the action it replaces, which will not run", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const book = vi.fn(async (input: Booking) => booked(input));
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          schema={z.object({ email: z.string() })}
          name="book_meeting"
          description="Book."
          confirm={(input) => `Book for ${input.email}?`}
          onSubmit={async (input) => book({ email: input.email, start: "Tuesday 15:00" })}
        />
        <Tool
          schema={z.object({ order: z.string() })}
          name="cancel_order"
          description="Cancel an order."
          confirm={(input) => `Cancel order ${input.order}?`}
          onSubmit={cancel}
        />
      </Agent>,
    );
    const { llm, requests } = scripted(
      [
        { text: "", toolCalls: [{ id: "c1", name: "book_meeting", input: { email: "lisa@example.com" } }] },
        { text: "", toolCalls: [{ id: "c2", name: "cancel_order", input: { order: "A-17" } }] },
        says("Cancelled."),
      ],
      ["unclear", "yes"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Book me in, lisa@example.com.");
    expect(await session.runTurn("Actually, cancel order A-17 instead.")).toBe("Cancel order A-17?");
    const replaced = 'This replaces the held book_meeting ("Book for lisa@example.com?"); it will not run.';
    const held = session.messages.filter((message) => message.role === "tool").at(-1);
    expect(held?.role === "tool" && held.result.message).toContain(replaced);

    await session.runTurn("Yes.");
    expect(requests[2]!.stateSnapshot.some((line) => line.includes(replaced))).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(book).not.toHaveBeenCalled();
  });

  it("the replaced action is named in the context while the new one waits", async () => {
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          schema={z.object({ order: z.string() })}
          name="cancel_order"
          description="Cancel an order."
          confirm={(input) => `Cancel order ${input.order}?`}
          onSubmit={async () => ({ ok: true })}
        />
        <Tool
          schema={z.object({ order: z.string() })}
          name="refund_order"
          description="Refund an order."
          confirm={(input) => `Refund order ${input.order}?`}
          onSubmit={async () => ({ ok: true })}
        />
      </Agent>,
    );
    const { llm, requests } = scripted(
      [
        { text: "", toolCalls: [{ id: "c1", name: "cancel_order", input: { order: "A-17" } }] },
        { text: "", toolCalls: [{ id: "c2", name: "refund_order", input: { order: "A-17" } }] },
        says("Shall I refund it, then?"),
      ],
      ["unclear", "unclear"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Cancel A-17.");
    await session.runTurn("Refund it instead.");
    await session.runTurn("Hm.");
    expect(requests[2]!.stateSnapshot[1]).toContain(
      'This replaces the held cancel_order ("Cancel order A-17?"); it will not run.',
    );
  });

  it("a yes runs the tool only from the skill that held it", async () => {
    const fromA = vi.fn(async () => ({ ok: true, message: "Booked in A." }));
    const fromB = vi.fn(async () => ({ ok: true, message: "Booked in B." }));
    const bookIn = (onSubmit: () => Promise<ToolResult>) =>
      defineTool({
        schema: z.object({ slot: z.string() }),
        name: "book_meeting",
        description: "Book.",
        confirm: (input) => `Book ${input.slot}?`,
        onSubmit,
      });
    const runtime = new AgentSiteRuntime(
      ({ loadedPaths }) => (
        <Agent>
          <Skills>
            <Skill path="/a" description="Skill A.">A</Skill>
            <Skill path="/b" description="Skill B.">B</Skill>
          </Skills>
          {loadedPaths.map((path) => (
            <Fragment key={path}>
              <agent-page path={path} title={path}>
                <Tool def={bookIn(path === "/a" ? fromA : fromB)} />
              </agent-page>
            </Fragment>
          ))}
        </Agent>
      ),
    );
    runtime.loadSkill("/a");
    const { llm, requests } = scripted(
      [{ text: "", toolCalls: [{ id: "c1", name: "book_meeting", input: { slot: "Tuesday" } }] }, says("Sorry.")],
      ["yes"],
    );
    const session = new AgentSession(runtime, llm);

    await session.runTurn("Book Tuesday.");
    runtime.loadSkill("/b");
    await session.runTurn("Yes.");

    expect(fromA).not.toHaveBeenCalled();
    expect(fromB).not.toHaveBeenCalled();
    const result = requests[1]!.messages.at(-1);
    expect(result).toMatchObject({ role: "tool", toolName: "book_meeting", result: { ok: false } });
    expect(result?.role === "tool" && result.result.message).toBe(
      'The book_meeting the caller said yes to belonged to skill "/a"; that name now belongs to skill "/b", so nothing was done. Call it again if the caller still wants it.',
    );
  });

  it("a held call belongs to the skill whose tool read it back, whatever the step loads after", async () => {
    const fromA = vi.fn(async () => ({ ok: true, message: "Booked in A." }));
    const fromB = vi.fn(async () => ({ ok: true, message: "Booked in B." }));
    const bookIn = (label: string, onSubmit: () => Promise<ToolResult>) =>
      defineTool({
        schema: z.object({ slot: z.string() }),
        name: "book_meeting",
        description: "Book.",
        confirm: (input) => `${label}: book ${input.slot}?`,
        onSubmit,
      });
    const runtime = new AgentSiteRuntime(
      ({ loadedPaths }) => (
        <Agent>
          <Skills>
            <Skill path="/a" description="Skill A.">A</Skill>
            <Skill path="/b" description="Skill B.">B</Skill>
          </Skills>
          {loadedPaths.map((path) => (
            <Fragment key={path}>
              <agent-page path={path} title={path}>
                <Tool def={path === "/a" ? bookIn("A", fromA) : bookIn("B", fromB)} />
              </agent-page>
            </Fragment>
          ))}
        </Agent>
      ),
    );
    runtime.loadSkill("/a");
    const { llm } = scripted(
      [
        {
          text: "",
          toolCalls: [
            { id: "c0", name: "read_skill", input: { skill: "/b" } },
            { id: "c1", name: "book_meeting", input: { slot: "Tuesday" } },
            { id: "c2", name: "read_skill", input: { skill: "/a" } },
          ],
        },
        says("Sorry."),
      ],
      ["yes"],
    );
    const session = new AgentSession(runtime, llm);

    expect(await session.runTurn("Book Tuesday.")).toBe("B: book Tuesday?");
    expect(session.pendingConfirmation?.skillPath).toBe("/b");
    await session.runTurn("Yes.");

    expect(fromA).not.toHaveBeenCalled();
    expect(fromB).not.toHaveBeenCalled();
  });
});
