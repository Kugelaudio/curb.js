import { EventEmitter } from "node:events";
import { ParticipantKind as NodeParticipantKind, type RpcInvocationData } from "@livekit/rtc-node";
import { ParticipantKind, RoomEvent, type Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppMessages } from "../messages.js";
import { kugelaudio } from "../providers.js";
import { attachClientMessages, type MessagingRoom } from "../server/voice/livekit-host/messages.js";
import { SessionSettings } from "../session-settings.js";
import { MAX_CLIENT_MESSAGE_BYTES } from "../wire.js";
import { AgentRefusedError, AgentUnavailableError, connectAgent } from "./index.js";

/**
 * `curb/client` against the REAL agent-side bridge, joined by an in-memory LiveKit: the
 * client's RPCs reach the bridge's registered methods, and the agent's text streams reach the
 * client's topic handler. Only the transport is fake.
 */

const AGENT = "agent-1";

function fakeLivekit(options: { agentPresent?: boolean } = {}) {
  const methods = new Map<string, (data: RpcInvocationData) => Promise<string>>();
  const textHandlers = new Map<string, (reader: { readAll(): Promise<string> }, from: { identity: string }) => void>();
  const events = new EventEmitter();
  const remote = new Map<string, { identity: string; kind: ParticipantKind }>();
  const performRpc = vi.fn(async (params: { destinationIdentity: string; method: string; payload: string }) => {
    if (!remote.has(params.destinationIdentity)) throw new Error(`no participant ${params.destinationIdentity}`);
    const handler = methods.get(params.method);
    if (handler === undefined) throw new Error(`unsupported method ${params.method}`);
    return handler({ requestId: "r", callerIdentity: "user", method: params.method, payload: params.payload, responseTimeout: 10_000 });
  });
  const client = {
    remoteParticipants: remote,
    localParticipant: { performRpc },
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => events.off(event, listener),
    registerTextStreamHandler: (topic: string, handler: never) => {
      if (textHandlers.has(topic)) throw new Error(`a handler for ${topic} is already registered`);
      textHandlers.set(topic, handler);
    },
    unregisterTextStreamHandler: (topic: string) => void textHandlers.delete(topic),
  } as unknown as Room;

  const sendText = (text: string, from = AGENT, topic = "curb.message") =>
    textHandlers.get(topic)?.({ readAll: async () => text }, { identity: from });
  const agentRoom: MessagingRoom = {
    localParticipant: {
      registerRpcMethod: (method, handler) => void methods.set(method, handler),
      unregisterRpcMethod: (method) => void methods.delete(method),
      sendText: async (text, sendOptions) => sendText(text, AGENT, sendOptions?.topic),
    },
    remoteParticipants: new Map([["user", { kind: NodeParticipantKind.STANDARD }]]),
  };

  const join = (identity = AGENT, kind = ParticipantKind.AGENT) => {
    remote.set(identity, { identity, kind });
    events.emit(RoomEvent.ParticipantConnected, remote.get(identity));
  };
  if (options.agentPresent ?? true) join();

  // The agent side: one runtime's hub and settings behind the real bridge.
  const messages = new AppMessages({ warn: () => {}, error: () => {} });
  const settings = new SessionSettings();
  settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
  attachClientMessages(agentRoom, { log: () => {} }).bind({ messages, settings });

  return { client, messages, settings, performRpc, textHandlers, sendText, join };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("curb/client", () => {
  it("send resolves once the agent's handler took the message", async () => {
    const lk = fakeLivekit();
    const seen: unknown[] = [];
    lk.messages.subscribe("client", "claim-submitted", {
      schema: z.object({ claimId: z.string() }),
      onMessage: (payload) => void seen.push(payload),
    });
    await connectAgent(lk.client).send("claim-submitted", { claimId: "C-17" });
    expect(seen).toEqual([{ claimId: "C-17" }]);
    expect(lk.performRpc.mock.calls[0]?.[0]).toMatchObject({ destinationIdentity: AGENT, method: "curb.message" });
  });

  it("ask resolves with the handler's return value", async () => {
    const lk = fakeLivekit();
    lk.messages.subscribe("client", "quote", { onMessage: (payload) => ({ price: 12, plan: (payload as { plan: string }).plan }) });
    await expect(connectAgent(lk.client).ask<{ price: number }>("quote", { plan: "basic" })).resolves.toEqual({ price: 12, plan: "basic" });
  });

  it("rejects with AgentRefusedError carrying the code and issues", async () => {
    const lk = fakeLivekit();
    lk.messages.subscribe("client", "claim", { schema: z.object({ claimId: z.string() }), onMessage: () => {} });
    const agent = connectAgent(lk.client);

    const missing = await agent.send("nobody").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AgentRefusedError);
    expect((missing as AgentRefusedError).code).toBe("no_handler");

    const invalid = (await agent.send("claim", { claimId: 1 }).catch((error: unknown) => error)) as AgentRefusedError;
    expect(invalid.code).toBe("invalid_payload");
    expect(invalid.issues?.[0]?.path).toEqual(["claimId"]);
  });

  it("refuses an oversized payload before sending it", async () => {
    const lk = fakeLivekit();
    const error = (await connectAgent(lk.client)
      .send("big", { blob: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) })
      .catch((reason: unknown) => reason)) as AgentRefusedError;
    expect(error).toBeInstanceOf(AgentRefusedError);
    expect(error.code).toBe("payload_too_large");
    expect(lk.performRpc).not.toHaveBeenCalled();
  });

  it("on() receives the agent's toClient messages, and only the agent's", async () => {
    const lk = fakeLivekit();
    const agent = connectAgent(lk.client);
    const forms: Array<[unknown, { id: string }]> = [];
    const off = agent.on("show-form", (payload, meta) => void forms.push([payload, meta]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    lk.messages.send.toClient("show-form", { form: "claim" });
    await flush();
    expect(forms).toHaveLength(1);
    expect(forms[0]?.[0]).toEqual({ form: "claim" });
    expect(typeof forms[0]?.[1].id).toBe("string");

    // A participant that is not the agent cannot inject agent messages.
    lk.join("intruder", ParticipantKind.STANDARD);
    lk.sendText(JSON.stringify({ key: "show-form", id: "x", payload: { form: "phish" } }), "intruder");
    await flush();
    expect(forms).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not the agent"));

    off();
    lk.messages.send.toClient("show-form", { form: "again" });
    await flush();
    expect(forms).toHaveLength(1);
    warn.mockRestore();
  });

  it("update() changes adjustable settings and is refused for the rest", async () => {
    const lk = fakeLivekit();
    lk.settings.setAdjustable({ client: ["tts.voice"] });
    const agent = connectAgent(lk.client);

    await expect(agent.update({ tts: { voice: "17" } })).resolves.toMatchObject({ tts: { provider: "kugelaudio", voice: 17 } });
    expect(lk.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 17 }));

    const refused = (await agent.update({ stt: { language: "de" } }).catch((error: unknown) => error)) as AgentRefusedError;
    expect(refused.code).toBe("not_adjustable");
    expect(refused.path).toBe("stt.language");
    const invalid = (await agent.update({ tts: { voice: "Rachel" } }).catch((error: unknown) => error)) as AgentRefusedError;
    expect(invalid.code).toBe("invalid_settings");
    expect(invalid.issues?.[0]?.path).toEqual(["tts", "voice"]);
  });

  it("waits for the agent to join, and gives up after the timeout", async () => {
    const lk = fakeLivekit({ agentPresent: false });
    lk.messages.subscribe("client", "ping", { onMessage: () => "pong" });
    const agent = connectAgent(lk.client);

    const answer = agent.ask("ping");
    await flush();
    expect(lk.performRpc).not.toHaveBeenCalled();
    lk.join("someone", ParticipantKind.STANDARD); // not an agent: keep waiting
    await flush();
    expect(lk.performRpc).not.toHaveBeenCalled();
    lk.join();
    await expect(answer).resolves.toBe("pong");

    const lonely = fakeLivekit({ agentPresent: false });
    await expect(connectAgent(lonely.client).ask("ping", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("addresses a named agent identity when given one", async () => {
    const lk = fakeLivekit({ agentPresent: false });
    lk.messages.subscribe("client", "ping", { onMessage: () => "pong" });
    // Its kind does not matter when it is named.
    lk.join("my-agent", ParticipantKind.STANDARD);
    await expect(connectAgent(lk.client, { agentIdentity: "my-agent" }).ask("ping")).resolves.toBe("pong");
    expect(lk.performRpc.mock.calls[0]?.[0]).toMatchObject({ destinationIdentity: "my-agent" });
  });

  it("close() unregisters the text stream handler and refuses later calls", async () => {
    const lk = fakeLivekit();
    const agent = connectAgent(lk.client);
    expect(lk.textHandlers.has("curb.message")).toBe(true);
    agent.close();
    expect(lk.textHandlers.has("curb.message")).toBe(false);
    await expect(agent.send("x")).rejects.toBeInstanceOf(AgentUnavailableError);
    // A new client can take the topic over.
    expect(() => connectAgent(lk.client)).not.toThrow();
  });
});
