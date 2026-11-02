import { EventEmitter } from "node:events";
import { initializeLogger, voice } from "@livekit/agents";
import { DisconnectReason, RoomEvent, type Room } from "@livekit/rtc-node";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentTurnStreamEvent } from "../../../llm/types.js";
import { CurbLLMStub, CurbVoiceAgent } from "./curb-agent.js";
import { livekitCallRoom } from "./livekit-call-room.js";
import { TRANSFER_TARGET_IDENTITY_PREFIX } from "./transfer-handoff.js";

type FakeCaller = {
  identity: string;
  info: object;
  attributes: object;
  trackPublications: Map<string, unknown>;
  disconnectReason?: DisconnectReason;
};

const caller = (identity: string): FakeCaller => ({ identity, info: {}, attributes: {}, trackPublications: new Map() });

/** The part of a connected LiveKit room that LiveKit's real RoomIO touches. */
function fakeRoom() {
  const remoteParticipants = new Map<string, FakeCaller>();
  const room = Object.assign(new EventEmitter(), {
    isConnected: true,
    name: "room-1",
    remoteParticipants,
    localParticipant: {
      identity: "agent",
      sid: "PA_agent",
      publishTrack: async () => ({ sid: "TR_agent", waitForSubscription: async () => {} }),
      streamText: async () => ({ write: async () => {}, close: async () => {} }),
      registerRpcMethod: () => {},
      setAttributes: async () => {},
      sendText: async () => ({}),
      publishData: async () => {},
      publishDtmf: async () => {},
      trackPublications: new Map(),
      attributes: {},
    },
    registerTextStreamHandler: () => {},
    unregisterTextStreamHandler: () => {},
    registerByteStreamHandler: () => {},
    unregisterByteStreamHandler: () => {},
  });
  return {
    room,
    join(participant: FakeCaller) {
      remoteParticipants.set(participant.identity, participant);
      room.emit(RoomEvent.ParticipantConnected, participant);
    },
    leave(participant: FakeCaller, reason: DisconnectReason) {
      remoteParticipants.delete(participant.identity);
      participant.disconnectReason = reason;
      room.emit(RoomEvent.ParticipantDisconnected, participant);
    },
  };
}

describe("a caller who drops and comes back within the platform's grace", () => {
  const sessions: voice.AgentSession[] = [];
  beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));
  afterEach(async () => {
    await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
  });

  async function onACall(first: FakeCaller) {
    const call = fakeRoom();
    call.join(first);
    const session = new voice.AgentSession({ llm: new CurbLLMStub() });
    sessions.push(session);
    const turns: string[] = [];
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      async *runTurn(input: string): AsyncGenerator<AgentTurnStreamEvent> {
        turns.push(input);
        yield { type: "delta", delta: "Still here.", text: "Still here." };
      },
    });
    await livekitCallRoom(call.room as unknown as Room, "room-1").startSession({
      session,
      agent,
      onTypedText: async () => {},
    });
    const closed: unknown[] = [];
    session.on(voice.AgentSessionEventTypes.Close, (event) => closed.push(event));
    return { ...call, session, turns, closed };
  }

  const aTurn = async (session: voice.AgentSession) =>
    session.generateReply({ userInput: "are you there?" }).waitForPlayout();

  it("gets a turn after hanging up the client", async () => {
    const first = caller("caller");
    const { join, leave, session, turns, closed } = await onACall(first);

    leave(first, DisconnectReason.CLIENT_INITIATED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toEqual([]);

    join(caller("caller"));
    await aTurn(session);
    expect(turns).toEqual(["are you there?"]);
  });

  it("listens to the caller when the rejoin carries a new identity", async () => {
    const first = caller("caller");
    const { join, leave, session } = await onACall(first);

    leave(first, DisconnectReason.CLIENT_INITIATED);
    join(caller("caller-2"));

    expect(session._roomIO?.linkedParticipant?.identity).toBe("caller-2");
  });

  it("does not take a transfer target for the caller coming back", async () => {
    const first = caller("caller");
    const { join, leave, session } = await onACall(first);

    leave(first, DisconnectReason.CLIENT_INITIATED);
    join(caller(`${TRANSFER_TARGET_IDENTITY_PREFIX}1`));

    expect(session._roomIO?.linkedParticipant).toBeUndefined();
  });
});
