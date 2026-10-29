import { ParticipantKind } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../../../agent-session.js";
import { openingLineOf, type AgentFirstTurn } from "../../../config.js";
import { createInsuranceDemoRuntime } from "../../../test-fixtures/insurance-runtime.js";
import {
  AGENT_FIRST_TURN_PROMPT,
  callerInfo,
  createCallOpening,
  type CallParticipant,
  type GreetingReply,
} from "./call-opening.js";

/**
 * How every call opens, on every route: the caller's info lands on the conversation before
 * any turn, and an agent-first greeting is spoken whole.
 */

const SIP_CALLER: CallParticipant = {
  identity: "sip_+498955500000",
  kind: ParticipantKind.SIP,
  attributes: { "sip.phoneNumber": "+49 89 555 0000", "sip.trunkPhoneNumber": "+49 30 123" },
};

/** A greeting whose playout ends when `finish` is called. */
function greetingReply(): GreetingReply & { finish: () => void } {
  let finish!: () => void;
  const playedOut = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let done = false;
  return {
    done: () => done,
    waitForPlayout: () => playedOut,
    finish: () => {
      done = true;
      finish();
    },
  };
}

function opening(firstTurn: "agent" | "user" | undefined, participants: CallParticipant[]) {
  const events: string[] = [];
  const replies: Array<{ userInput: string; allowInterruptions: boolean }> = [];
  const reply = greetingReply();
  const call = createCallOpening({
    firstTurn,
    participants: () => participants,
    recordCaller: (info) => events.push(`caller ${JSON.stringify(info)}`),
    generateReply: (options) => {
      events.push("greet");
      replies.push(options);
      return reply;
    },
    // These agents have no fixed line: the session has nothing to open with.
    openConversation: () => null,
    say: () => {
      throw new Error("an agent without a fixed line says nothing as written");
    },
  });
  return { call, events, replies, reply, participants };
}

/** A call whose conversation is a real session, for `firstTurn: { say }`. */
function sayingCall(firstTurn: AgentFirstTurn, participants: CallParticipant[]) {
  const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Gern.", toolCalls: [] }));
  const session = new AgentSession(createInsuranceDemoRuntime(), llm, { opening: openingLineOf(firstTurn) });
  const spoken: Array<{ text: string; allowInterruptions: boolean }> = [];
  const generateReply = vi.fn((_options: { userInput: string; allowInterruptions: boolean }): GreetingReply => {
    throw new Error("the fixed line needs no model call");
  });
  const reply = greetingReply();
  const call = createCallOpening({
    firstTurn,
    participants: () => participants,
    recordCaller: (info) => session.updateInfo(info),
    generateReply,
    openConversation: () => session.open(),
    say: (text, options) => {
      spoken.push({ text, ...options });
      return reply;
    },
  });
  return { call, session, llm, spoken, generateReply, reply };
}

describe("callerInfo", () => {
  it("names the caller, and the number a SIP caller dialed in from", () => {
    expect(callerInfo(SIP_CALLER)).toEqual({
      "caller.identity": "sip_+498955500000",
      "caller.phoneNumber": "+49 89 555 0000",
    });
    expect(callerInfo({ identity: "user" })).toEqual({ "caller.identity": "user" });
    expect(callerInfo({ identity: "user", attributes: { "sip.phoneNumber": "  " } })).toEqual({
      "caller.identity": "user",
    });
  });
});

describe("createCallOpening", () => {
  it("records the caller, then greets once the session runs, with interruptions off", () => {
    const { call, events, replies } = opening("agent", [SIP_CALLER]);

    // A caller already in the room: on the conversation at once, but no greeting before the
    // session can speak.
    call.update();
    expect(events).toEqual([
      'caller {"caller.identity":"sip_+498955500000","caller.phoneNumber":"+49 89 555 0000"}',
    ]);

    call.sessionStarted();
    expect(events.slice(1)).toEqual(["greet"]);
    expect(replies).toEqual([{ userInput: AGENT_FIRST_TURN_PROMPT, allowInterruptions: false }]);

    // Later joins neither record a second caller nor greet again.
    call.update();
    call.update();
    expect(events).toHaveLength(2);
  });

  it("waits for a caller; another agent or a recorder in the room is not one", () => {
    const participants: CallParticipant[] = [
      { identity: "agent-2", kind: ParticipantKind.AGENT },
      { identity: "egress", kind: ParticipantKind.EGRESS },
    ];
    const { call, events } = opening("agent", participants);
    call.sessionStarted();
    call.update();
    expect(events).toEqual([]);

    participants.push({ identity: "user", kind: ParticipantKind.STANDARD });
    call.update();
    expect(events).toEqual(['caller {"caller.identity":"user"}', "greet"]);
  });

  it("records the caller but never greets when the caller speaks first", () => {
    for (const firstTurn of ["user", undefined] as const) {
      const { call, events } = opening(firstTurn, [SIP_CALLER]);
      call.sessionStarted();
      call.update();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatch(/^caller /);
    }
  });

  it("lets typed input wait until the greeting has played, and only then", async () => {
    const { call, reply } = opening("agent", [SIP_CALLER]);
    // Nothing to wait for before there is a greeting.
    await expect(call.greeted()).resolves.toBeUndefined();

    call.sessionStarted();
    let greeted = false;
    const waiting = call.greeted().then(() => {
      greeted = true;
    });
    await Promise.resolve();
    expect(greeted).toBe(false);

    reply.finish();
    await waiting;
    expect(greeted).toBe(true);
    // Once played, nothing waits.
    await expect(call.greeted()).resolves.toBeUndefined();
  });

  it("opens with the agent's fixed line as written, interruptions off, no model call", async () => {
    const line = "Ich bin Clara, die digitale Assistentin von Beispiel GmbH.";
    const { call, session, llm, spoken, generateReply, reply } = sayingCall({ say: line }, [SIP_CALLER]);

    call.update();
    expect(spoken).toEqual([]);
    call.sessionStarted();
    call.update();

    expect(spoken).toEqual([{ text: line, allowInterruptions: false }]);
    expect(generateReply).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    // The conversation holds the line as the agent's first message, so the model knows it greeted.
    expect(session.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "(The conversation has just started.)"],
      ["assistant", line],
    ]);

    // Typed input waits until the line has played, as for a greeting.
    let greeted = false;
    const waiting = call.greeted().then(() => {
      greeted = true;
    });
    await Promise.resolve();
    expect(greeted).toBe(false);
    reply.finish();
    await waiting;
    expect(greeted).toBe(true);
  });

  it("writes the fixed line with the caller's info, which is on the conversation first", () => {
    const { call, spoken } = sayingCall(
      { say: (info) => `Sie rufen von ${String(info["caller.phoneNumber"] ?? "unbekannt")} an.` },
      [SIP_CALLER],
    );
    call.sessionStarted();
    expect(spoken.map((entry) => entry.text)).toEqual(["Sie rufen von +49 89 555 0000 an."]);
  });

  it("does not open a conversation typed turns began before the call", async () => {
    const { call, session, spoken } = sayingCall({ say: "Hallo." }, [SIP_CALLER]);
    await session.runTurn("Ich habe schon getippt.");

    call.sessionStarted();
    call.update();

    expect(spoken).toEqual([]);
    expect(session.messages.filter((message) => message.content === "Hallo.")).toHaveLength(1);
  });

  it("reports an opening that cannot be written once, and the call goes on", () => {
    const { call, spoken } = sayingCall({ say: () => "" }, [SIP_CALLER]);

    expect(() => call.sessionStarted()).toThrow("instead of the opening line");
    expect(() => call.update()).not.toThrow();
    expect(spoken).toEqual([]);
  });
});
