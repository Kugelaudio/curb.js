import { ParticipantKind, RpcError, type RpcInvocationData } from "@livekit/rtc-node";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppMessages } from "../../../messages.js";
import { kugelaudio } from "../../../providers.js";
import { SessionSettings } from "../../../session-settings.js";
import type { Adjustable } from "../../../settings-update.js";
import {
  CLIENT_MESSAGE_RPC_ERRORS,
  CURB_MESSAGE_RPC_METHOD,
  CURB_MESSAGE_TOPIC,
  CURB_UPDATE_RPC_METHOD,
  MAX_CLIENT_MESSAGE_BYTES,
  attachClientMessages,
  type MessagingRoom,
} from "./messages.js";

/**
 * App messages over LiveKit, against a fake agent participant: client -> agent is the
 * `curb.message` RPC (acknowledged, or refused with a coded RpcError), agent -> client is a
 * text stream on the `curb.message` topic.
 */

type Handler = (data: RpcInvocationData) => Promise<string>;

function fakeRoom(kinds: ParticipantKind[] = [ParticipantKind.STANDARD]) {
  const methods = new Map<string, Handler>();
  const texts: Array<{ text: string; topic: string | undefined }> = [];
  const remoteParticipants = new Map(kinds.map((kind, index) => [`p-${index}`, { kind }]));
  const room: MessagingRoom = {
    localParticipant: {
      registerRpcMethod: (method, handler) => void methods.set(method, handler),
      unregisterRpcMethod: (method) => void methods.delete(method),
      sendText: async (text, options) => {
        texts.push({ text, topic: options?.topic });
        return {};
      },
    },
    remoteParticipants,
  };
  const invoke = (payload: unknown, method = CURB_MESSAGE_RPC_METHOD) => {
    const handler = methods.get(method);
    if (handler === undefined) throw new Error("the RPC method is not registered");
    return handler({
      requestId: "rq-1",
      callerIdentity: "caller",
      method,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      responseTimeout: 10_000,
    });
  };
  return { room, methods, texts, remoteParticipants, invoke };
}

async function rpcError(pending: Promise<string>): Promise<RpcError> {
  const error = await pending.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

/** What a bridge serves, around one hub: a runtime has both. */
function runtimeOf(messages: AppMessages, settings = new SessionSettings()) {
  return { messages, settings };
}

function quietHub() {
  const warnings: string[] = [];
  const messages = new AppMessages({ warn: (line) => warnings.push(line), error: () => {} });
  return { messages, warnings };
}

describe("client messages over LiveKit", () => {
  it("answers an RPC with { reply } from the client handler", async () => {
    const { room, invoke } = fakeRoom();
    const { messages } = quietHub();
    messages.subscribe("client", "claim-submitted", {
      schema: z.object({ claimId: z.string() }),
      onMessage: (payload) => ({ received: (payload as { claimId: string }).claimId }),
    });
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));

    const answer = await invoke({ key: "claim-submitted", id: "c-1", payload: { claimId: "C-1" } });
    expect(JSON.parse(answer)).toEqual({ reply: { received: "C-1" } });
  });

  it("answers {} when the handler returns nothing", async () => {
    const { room, invoke } = fakeRoom();
    const { messages } = quietHub();
    messages.subscribe("client", "ping", { onMessage: () => {} });
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));
    expect(JSON.parse(await invoke({ key: "ping", id: "c-1", payload: {} }))).toEqual({});
  });

  it("refuses with a coded RpcError for each refusal", async () => {
    const { room, invoke } = fakeRoom();
    const { messages } = quietHub();
    messages.subscribe("client", "typed", { schema: z.object({ n: z.number() }), onMessage: () => {} });
    messages.subscribe("client", "broken", {
      onMessage: () => {
        throw new Error("secret internals");
      },
    });
    // A host handler does not answer a client message.
    messages.subscribe("host", "host-only", { onMessage: () => {} });
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));

    const noHandler = await rpcError(invoke({ key: "host-only", id: "1", payload: {} }));
    expect(noHandler).toMatchObject({ code: CLIENT_MESSAGE_RPC_ERRORS.no_handler, message: "no_handler" });

    const invalid = await rpcError(invoke({ key: "typed", id: "2", payload: { n: "x" } }));
    expect(invalid).toMatchObject({ code: CLIENT_MESSAGE_RPC_ERRORS.invalid_payload, message: "invalid_payload" });
    expect(JSON.parse(invalid.data!)).toEqual({ issues: [{ path: ["n"], message: expect.any(String) }] });

    const failed = await rpcError(invoke({ key: "broken", id: "3", payload: {} }));
    expect(failed).toMatchObject({ code: CLIENT_MESSAGE_RPC_ERRORS.handler_failed, message: "handler_failed" });
    // The handler's error stays on the server.
    expect(failed.data).toBeUndefined();

    const tooLarge = await rpcError(invoke({ key: "typed", id: "4", payload: { s: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) } }));
    expect(tooLarge).toMatchObject({ code: CLIENT_MESSAGE_RPC_ERRORS.payload_too_large, message: "payload_too_large" });

    const notJson = await rpcError(invoke("{nope"));
    expect(notJson).toMatchObject({ message: "invalid_payload", data: "the request is not JSON" });
    const noId = await rpcError(invoke({ key: "typed", payload: {} }));
    expect(noId.data).toContain("id");
  });

  it("sends toClient as a text stream on the curb.message topic", async () => {
    const { room, texts } = fakeRoom();
    const messages = new AppMessages({ newId: () => "a-1" });
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));
    messages.send.toClient("show-form", { form: "claim" });
    expect(texts).toEqual([
      { text: JSON.stringify({ key: "show-form", id: "a-1", payload: { form: "claim" } }), topic: CURB_MESSAGE_TOPIC },
    ]);
  });

  it("drops toClient with one warning per key when only a phone caller is in the room", () => {
    const { room, texts } = fakeRoom([ParticipantKind.SIP]);
    const { messages, warnings } = quietHub();
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));
    messages.send.toClient("show-form");
    messages.send.toClient("show-form");
    expect(texts).toEqual([]);
    expect(messages.undeliveredCounts().toClient).toEqual({ "show-form": 2 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no client data channel (a phone call)");
  });

  it("follows a rebind to the new runtime and stops serving on detach", async () => {
    const { room, methods, texts, invoke } = fakeRoom();
    const first = quietHub().messages;
    const second = quietHub().messages;
    second.subscribe("client", "ping", { onMessage: () => "from-second" });
    const bridge = attachClientMessages(room, { log: () => {} });
    bridge.bind(runtimeOf(first));
    bridge.bind(runtimeOf(second));

    expect(JSON.parse(await invoke({ key: "ping", id: "1", payload: {} }))).toEqual({ reply: "from-second" });
    first.send.toClient("stale");
    expect(texts).toEqual([]);

    bridge.detach();
    expect(methods.has(CURB_MESSAGE_RPC_METHOD)).toBe(false);
    second.send.toClient("after-close");
    expect(texts).toEqual([]);
  });
});

describe("live settings over LiveKit (curb.update)", () => {
  function adjustable(adjustable: Adjustable = { client: ["tts.voice"] }) {
    const settings = new SessionSettings();
    settings.setAdjustable(adjustable);
    settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
    return settings;
  }
  const update = (invoke: (payload: unknown, method?: string) => Promise<string>, body: unknown) =>
    invoke(body, CURB_UPDATE_RPC_METHOD);

  it("applies an adjustable path with origin client and answers the effective settings", async () => {
    const { room, invoke } = fakeRoom();
    const settings = adjustable();
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(quietHub().messages, settings));

    const answer = JSON.parse(await update(invoke, { tts: { voice: "17" } }));
    expect(answer).toEqual({
      tts: { provider: "kugelaudio", voice: 17 },
      stt: { provider: "kugelaudio" },
      llm: { provider: "kugelaudio", model: "qwen3.8-27b" },
    });
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 17 }));
  });

  it("refuses a path adjustable only for the host with not_adjustable (2005) and its path", async () => {
    const { room, invoke } = fakeRoom();
    const settings = adjustable({ host: ["tts.voice"] });
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(quietHub().messages, settings));

    const error = await rpcError(update(invoke, { tts: { voice: 7 } }));
    expect(error.code).toBe(CLIENT_MESSAGE_RPC_ERRORS.not_adjustable);
    expect(error.message).toBe("not_adjustable");
    expect(JSON.parse(error.data!)).toEqual({ path: "tts.voice" });
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
  });

  it("refuses a bad value with invalid_settings (2006) and its issues", async () => {
    const { room, invoke } = fakeRoom();
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(quietHub().messages, adjustable()));

    const error = await rpcError(update(invoke, { tts: { voice: "Rachel" } }));
    expect(error.code).toBe(CLIENT_MESSAGE_RPC_ERRORS.invalid_settings);
    expect(JSON.parse(error.data!).issues[0].path).toEqual(["tts", "voice"]);
    expect((await rpcError(update(invoke, "{not json"))).code).toBe(CLIENT_MESSAGE_RPC_ERRORS.invalid_settings);
  });

  it("refuses an oversized update with payload_too_large before parsing it", async () => {
    const { room, invoke } = fakeRoom();
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(quietHub().messages, adjustable()));
    const error = await rpcError(update(invoke, { tts: { voice: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) } }));
    expect(error.code).toBe(CLIENT_MESSAGE_RPC_ERRORS.payload_too_large);
  });

  it("carries a client's change onto the runtime a rewind binds, and unregisters on detach", async () => {
    const { room, methods, invoke } = fakeRoom();
    const bridge = attachClientMessages(room, { log: () => {} });
    bridge.bind(runtimeOf(quietHub().messages, adjustable()));
    await update(invoke, { tts: { voice: 7 } });

    const rebuilt = adjustable();
    bridge.bind(runtimeOf(quietHub().messages, rebuilt));
    expect(rebuilt.current().tts).toStrictEqual(kugelaudio.tts({ voice: 7 }));

    bridge.detach();
    expect(methods.has(CURB_UPDATE_RPC_METHOD)).toBe(false);
  });
});

describe("a bridge attached when the room connected, before the session bound it", () => {
  it("answers an early message once the session binds, and records the reply", async () => {
    const { room, invoke } = fakeRoom();
    const bridge = attachClientMessages(room, { log: () => {} });
    const early = invoke({ key: "ping", id: "e-1", payload: {} });
    const { messages } = quietHub();
    const recorded: unknown[] = [];
    messages.connectRecorder((traffic) => void recorded.push(traffic));
    messages.subscribe("client", "ping", { onMessage: () => "pong" });
    bridge.bind(runtimeOf(messages));
    expect(JSON.parse(await early)).toEqual({ reply: "pong" });
    expect(recorded).toEqual([{ kind: "reply_to_client", key: "ping", id: "e-1", reply: "pong" }]);
  });

  it("refuses an early request that the session never bound in time: no_handler, and not_adjustable for an update", async () => {
    const { room, invoke } = fakeRoom();
    attachClientMessages(room, { log: () => {}, bindWaitMs: 10 });
    expect((await rpcError(invoke({ key: "ping", id: "e-1", payload: {} }))).code).toBe(CLIENT_MESSAGE_RPC_ERRORS.no_handler);
    expect((await rpcError(invoke({ tts: { voice: 1 } }, CURB_UPDATE_RPC_METHOD))).code).toBe(
      CLIENT_MESSAGE_RPC_ERRORS.not_adjustable,
    );
  });

  it("refuses a waiting request at once when the call closes before binding", async () => {
    const { room, invoke } = fakeRoom();
    const bridge = attachClientMessages(room, { log: () => {} });
    const early = rpcError(invoke({ key: "ping", id: "e-1", payload: {} }));
    bridge.detach();
    expect((await early).code).toBe(CLIENT_MESSAGE_RPC_ERRORS.no_handler);
  });

  it("tells 'no app has joined yet' from 'a phone call', and does not count another agent as a client", () => {
    const { room, remoteParticipants } = fakeRoom([ParticipantKind.AGENT]);
    const { messages, warnings } = quietHub();
    attachClientMessages(room, { log: () => {} }).bind(runtimeOf(messages));
    messages.send.toClient("show-form");
    remoteParticipants.set("phone", { kind: ParticipantKind.SIP });
    messages.send.toClient("show-form");
    expect(warnings).toEqual([
      expect.stringContaining("no client app has joined this call yet"),
      expect.stringContaining("a phone call"),
    ]);
    expect(messages.undeliveredCounts().toClient).toEqual({ "show-form": 2 });
  });
});
