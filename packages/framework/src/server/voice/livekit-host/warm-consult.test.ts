import { ParticipantKind } from "@livekit/rtc-node";
import { llm, voice, type VAD } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import type { ConsultTargetEvent } from "../../../blocks/transfer-call/warm.js";
import type { CallSessionStart, VoiceCallRoom } from "../call-room.js";
import type { VoiceProviders } from "../providers.js";
import type { CallParticipant } from "./call-opening.js";
import { createWarmTransferHost, joinConsultRoom, startConsultLeg } from "./warm-consult.js";

const TICKET = { url: "wss://realtime.example", token: "secret-token" };

function fakeRoom() {
  const log: string[] = [];
  const joined = new Set<(participant: CallParticipant | undefined) => void>();
  const left = new Set<(participant: CallParticipant | undefined) => void>();
  const lost = new Set<(reason: string) => void>();
  const present = new Map<string, CallParticipant>();
  let started: CallSessionStart | null = null;
  const room: VoiceCallRoom = {
    name: "consult-t-1",
    participants: () => present.values(),
    onParticipantConnected: (listener) => void joined.add(listener),
    onParticipantDisconnected: (listener) => void left.add(listener),
    onDisconnected: (listener) => void lost.add(listener),
    startSession: async (start) => {
      started = start;
      log.push("start");
    },
    publishTransferTrack: async () => {
      throw new Error("no transfer track in a consultation");
    },
    disconnect: async () => {
      log.push("disconnect");
      for (const listener of lost) listener("CLIENT_INITIATED");
    },
  };
  return {
    room,
    log,
    agent: () => started!.agent,
    join: (identity: string, kind = ParticipantKind.SIP) => {
      const participant = { identity, kind } as CallParticipant;
      present.set(identity, participant);
      for (const listener of joined) listener(participant);
    },
    leave: (identity: string) => {
      const participant = present.get(identity);
      present.delete(identity);
      for (const listener of left) listener(participant);
    },
    lose: (reason: string) => lost.forEach((listener) => listener(reason)),
  };
}

function fakeSession(log: string[]) {
  let finishPlayout: () => void = () => {};
  const session = {
    say: vi.fn((text: string) => {
      log.push(`say ${text}`);
      const playout = new Promise<void>((resolve) => (finishPlayout = resolve));
      return {
        interrupt: () => {
          log.push("interrupt");
          finishPlayout();
        },
        waitForPlayout: () => playout,
      };
    }),
    close: async () => void log.push("session closed"),
  };
  return { session: session as unknown as voice.AgentSession, played: () => finishPlayout() };
}

const providers = (log: string[]) =>
  ({
    stt: { close: async () => void log.push("stt closed") },
    tts: { close: async () => void log.push("tts closed") },
  }) as unknown as VoiceProviders;

async function leg() {
  const fake = fakeRoom();
  const voiceSession = fakeSession(fake.log);
  const consult = await startConsultLeg({
    room: fake.room,
    providers: providers(fake.log),
    vad: {} as VAD,
    env: {},
    log: (line) => fake.log.push(line),
    createSession: () => voiceSession.session,
  });
  const events: ConsultTargetEvent[] = [];
  return { fake, voiceSession, consult, events, listen: () => consult.onTarget((event) => events.push(event)) };
}

const userTurn = (text: string) => llm.ChatMessage.create({ role: "user", content: text });

describe("joinConsultRoom", () => {
  it("joins a LiveKit room or a relay call as the ticket's URL says", async () => {
    const { room } = fakeRoom();
    const connectLivekit = vi.fn(async () => ({ room, disconnect: async () => {} }));
    const openRelay = vi.fn(async () => ({ room, disconnect: async () => {} }));
    await expect(joinConsultRoom(TICKET, "t-1", { connectLivekit, openRelay })).resolves.toBe(room);
    expect(connectLivekit).toHaveBeenCalledWith(TICKET);
    await joinConsultRoom({ url: "curb-relay+wss://relay.example", token: "x" }, "t-1", { connectLivekit, openRelay });
    expect(openRelay).toHaveBeenCalledTimes(1);
  });

  it("gives up after the join time and leaves a room that is joined too late, never naming the token", async () => {
    vi.useFakeTimers();
    try {
      let joined: (value: { room: VoiceCallRoom; disconnect(): Promise<void> }) => void = () => {};
      const disconnect = vi.fn(async () => {});
      const joining = joinConsultRoom(TICKET, "t-1", {
        timeoutMs: 1000,
        connectLivekit: () => new Promise((resolve) => (joined = resolve)),
      });
      const failed = expect(joining).rejects.toThrow(/consultation room .* took longer than 1 s/);
      await vi.advanceTimersByTimeAsync(1000);
      await failed;
      await joining.catch((error: Error) => expect(error.message).not.toContain("secret-token"));
      joined({ room: fakeRoom().room, disconnect });
      await vi.advanceTimersByTimeAsync(0);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startConsultLeg", () => {
  it("tells of the person's arrival, each turn and their leaving, kept until someone listens", async () => {
    const { fake, events, listen } = await leg();
    fake.join("sip_consult-1");
    await expect(fake.agent().onUserTurnCompleted(new llm.ChatContext(), userTurn(" Yes, put them through. "))).rejects.toBeInstanceOf(
      voice.StopResponse,
    );
    listen();
    fake.leave("sip_consult-1");
    expect(events).toEqual([{ type: "joined" }, { type: "turn", text: "Yes, put them through." }, { type: "left" }]);
  });

  it("takes a person already in the room, and never an agent, as the person", async () => {
    const fake = fakeRoom();
    fake.join("agent-observer", ParticipantKind.AGENT);
    fake.join("sip_consult-1");
    const voiceSession = fakeSession(fake.log);
    const consult = await startConsultLeg({
      room: fake.room,
      providers: providers(fake.log),
      vad: {} as VAD,
      env: {},
      log: () => {},
      createSession: () => voiceSession.session,
    });
    const events: ConsultTargetEvent[] = [];
    consult.onTarget((event) => events.push(event));
    fake.leave("agent-observer");
    expect(events).toEqual([{ type: "joined" }]);
  });

  it("speaks interruptibly, stops a line on abort, and closes everything once", async () => {
    const { fake, voiceSession, consult, events, listen } = await leg();
    listen();
    const said = consult.say("Can you take a call about a parcel?");
    expect(voiceSession.session.say).toHaveBeenCalledWith("Can you take a call about a parcel?", { allowInterruptions: true });
    voiceSession.played();
    await said;
    const controller = new AbortController();
    const second = consult.say("Shall I put them through?", controller.signal);
    controller.abort();
    await second;
    expect(fake.log).toContain("interrupt");
    await Promise.all([consult.close(), consult.close()]);
    expect(fake.log.filter((line) => line === "disconnect")).toHaveLength(1);
    expect(fake.log).toEqual(expect.arrayContaining(["session closed", "stt closed", "tts closed"]));
    // Its own leaving is not the room being lost.
    expect(events).toEqual([]);
  });

  it("reports a room lost under it", async () => {
    const { fake, events, listen } = await leg();
    listen();
    fake.lose("SERVER_SHUTDOWN");
    expect(events).toEqual([{ type: "lost", message: "the agent lost the consultation room (SERVER_SHUTDOWN)" }]);
  });
});

describe("createWarmTransferHost", () => {
  it("passes the call's facts to whoever listens", () => {
    const host = createWarmTransferHost({
      hold: () => () => {},
      pause: () => () => {},
      ask: async () => ({ text: "", toolCalls: [] }),
      openConsult: async () => {
        throw new Error("unused");
      },
    });
    const heard: string[] = [];
    const stop = host.onCallerLeft(() => heard.push("caller left"));
    host.onHandedOff(() => heard.push("handed off"));
    host.callerLeft();
    host.handedOff();
    stop();
    host.callerLeft();
    expect(heard).toEqual(["caller left", "handed off"]);
  });
});
