import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room } from "@livekit/rtc-node";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import type { AgentChatMessage } from "../llm/types.js";
import { attachConversationSink, type ConversationSink } from "../server/conversation-store.js";
import type { VoiceSessionHandle } from "../server/voice/orchestration.js";
import { createInsuranceDemoRuntime } from "../test-fixtures/insurance-runtime.js";
import type { VoiceAgentBundle } from "../voice-host.js";
import { anthropic, azure, kugelaudio, openai } from "../providers.js";
import { AppMessages, HostUnavailableError } from "../messages.js";
import { createCallReporter, type HostedCallReporter } from "../hosted/call-reporter.js";
import { EventJournal, type JournalRecord } from "../hosted/event-journal.js";
import {
  PLATFORM_CREDENTIAL_VARS,
  clientContextInfo,
  joinRoomAndServe,
  readDirectJoinConfig,
  scrubPlatformCredentials,
  warmVoiceRunner,
  type JoinSeams,
  type WarmVoiceRunner,
} from "./direct-join.js";

/**
 * The mode switch and the credential scrub, the two decisions a hosted runner makes
 * before it touches the network. Joining a real room is proven by running the artifact;
 * these are the parts that must hold with no server in reach.
 */

describe("readDirectJoinConfig", () => {
  it("reads both variables and the session id", () => {
    expect(
      readDirectJoinConfig({
        CURB_REALTIME_URL: "ws://127.0.0.1:7880",
        CURB_REALTIME_TOKEN: "jwt",
        CURB_SESSION_ID: "sess-1",
      }),
    ).toEqual({ url: "ws://127.0.0.1:7880", token: "jwt", sessionId: "sess-1" });
  });

  it("throws when only one is set rather than falling back to worker mode", () => {
    expect(() => readDirectJoinConfig({ CURB_REALTIME_URL: "ws://x" })).toThrow(
      /CURB_REALTIME_TOKEN is empty or missing/,
    );
    expect(() => readDirectJoinConfig({ CURB_REALTIME_TOKEN: "jwt" })).toThrow(
      /CURB_REALTIME_URL is empty or missing/,
    );
  });

  it("treats a blank value as missing", () => {
    expect(() =>
      readDirectJoinConfig({ CURB_REALTIME_URL: "ws://x", CURB_REALTIME_TOKEN: "   " }),
    ).toThrow(/CURB_REALTIME_TOKEN/);
  });
});

describe("scrubPlatformCredentials", () => {
  it("removes the platform's LiveKit credentials and reports what was there", () => {
    const env: NodeJS.ProcessEnv = {
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "secret",
      KUGELAUDIO_API_KEY: "keep-me",
    };
    expect(scrubPlatformCredentials(env)).toEqual(PLATFORM_CREDENTIAL_VARS);
    expect(env).toEqual({ KUGELAUDIO_API_KEY: "keep-me" });
  });

});

/** Every call's scratch directory lands here, so a call a test never ends leaves nothing behind. */
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "curb-direct-join-test-"));
afterAll(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

// --- warm runner -------------------------------------------------------------------------

const FAKE_VAD = { label: "fake-vad" } as never;

/** What the fake agent renders with: German speech in and out. */
const SETTINGS = {
  llm: anthropic("claude-haiku-4-5"),
  stt: azure.stt({ language: "de" }),
  tts: kugelaudio.tts({ language: "de" }),
};
const VOICE_SETTINGS = { stt: SETTINGS.stt, tts: SETTINGS.tts };

function fakeBundle(name = "bundle", s2s?: ReturnType<typeof openai.live>): VoiceAgentBundle {
  return {
    name,
    agentId: "insurance",
    definition: { firstTurn: "agent", pipeline: {} },
    runtime: { messages: new AppMessages(), settings: { current: () => SETTINGS, s2s: () => s2s }, bindCall: () => {} },
    session: { updateInfo: () => {} },
  } as unknown as VoiceAgentBundle;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("warmVoiceRunner", () => {
  it("builds the agent, loads VAD and imports plugins once, before any call", async () => {
    let built = 0;
    const createBundle = vi.fn(async () => fakeBundle(`bundle-${++built}`));
    const loadVad = vi.fn(async () => FAKE_VAD);
    const preloadPlugins = vi.fn(async () => {});

    const readyForCall = async (bundle: VoiceAgentBundle) => bundle;
    const warm = await warmVoiceRunner({ env: {}, createBundle, loadVad, preloadPlugins, readyForCall });

    expect(createBundle).toHaveBeenCalledTimes(1);
    expect(loadVad).toHaveBeenCalledTimes(1);
    expect(preloadPlugins).toHaveBeenCalledTimes(1);
    // The plugins imported are the ones the agent renders with.
    expect(preloadPlugins).toHaveBeenCalledWith(SETTINGS, {});
    expect(warm.vad).toBe(FAKE_VAD);
    expect(warm.settings).toEqual(VOICE_SETTINGS);

    // The first call is handed the bundle built during warmup, not a rebuild.
    const first = await warm.takeBundle();
    expect(createBundle).toHaveBeenCalledTimes(1);

    // A bundle is one conversation's transcript and runtime. A second call on the same
    // runner gets its own, never the first caller's.
    const second = await warm.takeBundle();
    expect(second).not.toBe(first);
    expect(createBundle).toHaveBeenCalledTimes(2);
  });

  // The platform saves a runner's snapshot from a boot without secrets and hands the keys
  // over with the call, so warmup must not need the LLM key; the call that takes the bundle does.
  it("warms without the LLM key, and checks it when a call takes the warm bundle", async () => {
    const steps = {
      env: {},
      createWarmBundle: async () => fakeBundle("warm"),
      createBundle: async () => fakeBundle("cold"),
      loadVad: async () => FAKE_VAD,
      preloadPlugins: async () => {},
    };
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const keyless = await warmVoiceRunner(steps);
    await expect(keyless.takeBundle()).rejects.toThrow(/needs ANTHROPIC_API_KEY/);

    const warm = await warmVoiceRunner(steps);
    vi.stubEnv("ANTHROPIC_API_KEY", "key-from-the-call");
    expect((await warm.takeBundle()) as unknown as { name: string }).toMatchObject({ name: "warm" });
    vi.unstubAllEnvs();
  });

  // The model hears and speaks, so the default stt (and its key) never has to exist on the runner.
  it("imports no speech plugin and keeps no speech settings for an <Agent s2s>", async () => {
    const preloadPlugins = vi.fn(async () => {});
    const warm = await warmVoiceRunner({
      env: {},
      createBundle: async () => fakeBundle("s2s", openai.live()),
      loadVad: async () => FAKE_VAD,
      preloadPlugins,
      readyForCall: async (bundle) => bundle,
    });
    expect(preloadPlugins).not.toHaveBeenCalled();
    expect(warm.settings).toBeNull();
    expect(warm.vad).toBe(FAKE_VAD);
  });

  it("rejects when any warmup step fails, so the runner never says ready", async () => {
    await expect(
      warmVoiceRunner({
        env: {},
        createBundle: async () => fakeBundle(),
        loadVad: async () => {
          throw new Error("silero onnx model could not be loaded");
        },
        preloadPlugins: async () => {},
      }),
    ).rejects.toThrow(/silero onnx model/);
  });
});

function fakeRoom(connect: () => Promise<void>) {
  return {
    name: "room-1",
    remoteParticipants: new Map(),
    connect: vi.fn(connect),
    disconnect: vi.fn(async () => {}),
  };
}

const fakeHandle = { close: vi.fn(async () => {}) } as unknown as VoiceSessionHandle;

describe("joinRoomAndServe on a warm runner", () => {
  it("starts the provider connections alongside the room connect, not after it", async () => {
    const order: string[] = [];
    const connected = deferred<void>();
    const room = fakeRoom(async () => {
      order.push("room.connect:start");
      await connected.promise;
      order.push("room.connect:done");
    });
    const providers = { stt: { close: vi.fn() }, tts: { close: vi.fn(async () => {}) } };
    const buildProviders = vi.fn(async () => {
      order.push("providers:start");
      return providers as never;
    });
    const startVoiceAgent = vi.fn(async () => {
      order.push("agent:start");
      return fakeHandle;
    });
    const bundle = fakeBundle();
    const takeBundle = vi.fn(async () => bundle);
    const warm: WarmVoiceRunner = {
      definition: bundle.definition,
      settings: VOICE_SETTINGS,
      vad: FAKE_VAD,
      takeBundle,
    };

    const joining = joinRoomAndServe(
      { url: "ws://127.0.0.1:1", token: "jwt", sessionId: "sess-from-spec", warm },
      { createRoom: () => room as unknown as Room, buildProviders, startVoiceAgent, scratchRoot: SCRATCH_ROOT },
    );
    joining.catch(() => {});
    await tick();

    // Both are under way while the room is still connecting.
    expect(order).toContain("room.connect:start");
    expect(order).toContain("providers:start");
    expect(order).not.toContain("room.connect:done");

    connected.resolve();
    const session = await joining;
    expect(session.roomName).toBe("room-1");
    expect(order.at(-1)).toBe("agent:start");

    // Providers are built from the settings the agent rendered with at warmup.
    expect(buildProviders).toHaveBeenCalledWith({ settings: VOICE_SETTINGS });
    // Warm resources are handed in, not rebuilt: the VAD loaded at warmup, the bundle
    // built at warmup, and the providers that were connecting in parallel.
    expect(takeBundle).toHaveBeenCalledTimes(1);
    expect(startVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ bundle, vad: FAKE_VAD, providers, pipeline: bundle.definition.pipeline }),
    );
  });

  it("builds no speech provider for an <Agent s2s> and still hands over the warm VAD", async () => {
    const room = fakeRoom(async () => {});
    const buildProviders = vi.fn();
    const startVoiceAgent = vi.fn(async (_options: Record<string, unknown>) => fakeHandle);
    const bundle = fakeBundle("s2s", openai.live());
    const warm: WarmVoiceRunner = { definition: bundle.definition, settings: null, vad: FAKE_VAD, takeBundle: async () => bundle };

    await joinRoomAndServe(
      { url: "ws://127.0.0.1:1", token: "jwt", sessionId: "sess-s2s", warm },
      { createRoom: () => room as unknown as Room, buildProviders, startVoiceAgent, scratchRoot: SCRATCH_ROOT },
    );

    expect(buildProviders).not.toHaveBeenCalled();
    expect(startVoiceAgent).toHaveBeenCalledWith(expect.objectContaining({ bundle, vad: FAKE_VAD }));
    expect(startVoiceAgent.mock.calls[0]?.[0]).not.toHaveProperty("providers");
  });

  it("takes a relay URL through the relay and never touches a room", async () => {
    const createRoom = vi.fn();
    const openRelay = vi.fn(async () => {
      throw new Error("token refused");
    });
    await expect(
      joinRoomAndServe(
        { url: "curb-relay+ws://relay/calls/s", token: "per-call", sessionId: "s" },
        { createRoom, openRelayCall: openRelay as never, scratchRoot: SCRATCH_ROOT },
      ),
    ).rejects.toThrow(/could not start the call through the media relay .*token refused/);
    expect(openRelay).toHaveBeenCalledWith("curb-relay+ws://relay/calls/s", "per-call");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("closes the providers it opened when the room refuses the token", async () => {
    const tts = { close: vi.fn(async () => {}) };
    const stt = { close: vi.fn(async () => {}) };
    const room = fakeRoom(async () => {
      throw new Error("401 invalid token");
    });
    const bundle = fakeBundle();
    const warm: WarmVoiceRunner = {
      definition: bundle.definition,
      settings: VOICE_SETTINGS,
      vad: FAKE_VAD,
      takeBundle: async () => bundle,
    };

    await expect(
      joinRoomAndServe(
        { url: "ws://127.0.0.1:1", token: "jwt", sessionId: "s", warm },
        {
          createRoom: () => room as unknown as Room,
          buildProviders: async () => ({ stt, tts }) as never,
          startVoiceAgent: async () => fakeHandle,
        },
      ),
    ).rejects.toThrow(/could not join the realtime room/);
    await tick();

    // A TTS socket opened for a call that never happened would stay open for the life of
    // the runner.
    expect(tts.close).toHaveBeenCalledTimes(1);
    expect(stt.close).toHaveBeenCalledTimes(1);
  });
});

// The hosted call end is the session end: a direct-join runner exits right after it, and a
// managed one frees the call's slot. So the sink's last retry, and the report of what it
// still refused, have to happen before `ended` resolves (managed mode hands the same
// `ended` to its registry). The room and the voice pipeline are stand-ins; the session,
// its recorder and the join path are real.
describe("a hosted call's conversation recording", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const loggedErrors = () => errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

  function recordedCall(options: { startFails?: boolean; hangingWrites?: boolean } = {}) {
    const state = { writeDown: false };
    const written: Array<[string, number, string]> = [];
    const sink: ConversationSink = {
      startConversation: async () => "conversation-1",
      recordMessage: async (conversationId, seq, message: AgentChatMessage) => {
        if (options.hangingWrites) return new Promise<void>(() => undefined);
        if (state.writeDown) throw new Error("sink unreachable");
        written.push([conversationId, seq, message.content]);
      },
    };
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "sure", toolCalls: [] }));
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, llm);
    attachConversationSink(sink, session, "insurance");

    let voice: Parameters<NonNullable<JoinSeams["startVoiceAgent"]>>[0] | undefined;
    const seams: JoinSeams = {
      createRoom: () =>
        ({
          name: "room-1",
          connect: async () => undefined,
          disconnect: async () => undefined,
        }) as unknown as Room,
      createBundle: async () => ({ session, runtime, definition: {} }) as unknown as VoiceAgentBundle,
      startVoiceAgent: async (start) => {
        if (options.startFails) throw new Error("no STT key");
        voice = start;
        // Closing the handle is what a stop signal or the management port does.
        return { close: async () => start.onClosed?.() } as unknown as VoiceSessionHandle;
      },
      recordingFinishTimeoutMs: 50,
      scratchRoot: SCRATCH_ROOT,
    };
    const join = (reporter?: HostedCallReporter) =>
      joinRoomAndServe({ url: "ws://realtime", token: "jwt", ...(reporter ? { reporter } : {}) }, seams);
    return { state, written, session, runtime, join, roomEmptied: () => voice?.onClosed?.() };
  }

  it("retries a write the sink refused during the call before the call ends", async () => {
    const { state, written, session, join, roomEmptied } = recordedCall();
    const call = await join();
    state.writeDown = true;
    await session.runTurn("hello");
    expect(written).toEqual([]);

    state.writeDown = false;
    roomEmptied();
    await call.ended;
    expect(written).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "sure"],
    ]);
  });

  it("reports what the sink still refuses when the call is closed", async () => {
    const { state, written, session, join } = recordedCall();
    const call = await join();
    state.writeDown = true;
    await session.runTurn("hello");

    await call.handle.close();
    await call.ended;
    expect(written).toEqual([]);
    expect(loggedErrors()).toMatch(/lost 2 messages of conversation conversation-1/);
  });

  it("ends the recording when the voice session fails to start", async () => {
    const { state, session, join } = recordedCall({ startFails: true });
    state.writeDown = true;
    await session.runTurn("hello");

    await expect(join()).rejects.toThrow(/voice session failed to start/);
    expect(loggedErrors()).toMatch(/lost 2 messages of conversation conversation-1/);
  });

  it("does not let a hung sink hold the call open", async () => {
    const { session, join, roomEmptied } = recordedCall({ hangingWrites: true });
    const call = await join();
    await session.runTurn("hello");

    roomEmptied();
    await call.ended;
    expect(loggedErrors()).toMatch(/had not finished the transcript of room-1 50 ms after the call ended/);
  });
});

// What the caller's page said about the call reaches the agent as `client.*` before the voice
// session starts, so the greeting can already use it. The room and the voice pipeline are
// stand-ins; the session, its runtime and the join path are real.
describe("a hosted call's client context", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Joins a call and returns the agent's info as it stood when the voice session started. */
  async function infoAtVoiceStart(
    clientContext?: Record<string, string>,
    direction?: "inbound" | "outbound",
    experiments?: Record<string, string>,
  ) {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, vi.fn<AgentLlmClient>());
    let atStart: Record<string, unknown> | undefined;
    const seams: JoinSeams = {
      createRoom: () =>
        ({ name: "room-1", connect: async () => undefined, disconnect: async () => undefined }) as unknown as Room,
      createBundle: async () => ({ session, runtime, definition: {} }) as unknown as VoiceAgentBundle,
      startVoiceAgent: async (start) => {
        // The greeting is spoken from inside the voice session, so this is the latest point
        // the info must already be in place.
        atStart = { ...runtime.info.snapshot() };
        return { close: async () => start.onClosed?.() } as unknown as VoiceSessionHandle;
      },
      scratchRoot: SCRATCH_ROOT,
    };
    await joinRoomAndServe(
      {
        url: "ws://realtime",
        token: "jwt",
        sessionId: "sess-1",
        ...(clientContext ? { clientContext } : {}),
        ...(direction ? { direction } : {}),
        ...(experiments ? { experiments } : {}),
      },
      seams,
    );
    return atStart!;
  }

  it("puts the host's experiment variants on experiment.<name>, with the client context, before the session starts", async () => {
    const info = await infoAtVoiceStart({ greeting: "formal" }, undefined, { greeting: "casual", pacing: "slow" });
    // Trusted: the host's assignment stands, whatever the page sent.
    expect(info).toMatchObject({
      "client.greeting": "formal",
      "experiment.greeting": "casual",
      "experiment.pacing": "slow",
    });
    const none = await infoAtVoiceStart();
    expect(Object.keys(none).filter((key) => key.startsWith("experiment."))).toEqual([]);
  });

  it("puts each entry on the agent's info as client.<key> before the session starts", async () => {
    const info = await infoAtVoiceStart({ event: "webinar-11-04", ref: "newsletter" });
    expect(info).toMatchObject({ "client.event": "webinar-11-04", "client.ref": "newsletter" });
  });

  it("sets no client.* key for a call without one", async () => {
    for (const context of [undefined, {}]) {
      const info = await infoAtVoiceStart(context);
      expect(Object.keys(info).filter((key) => key.startsWith("client."))).toEqual([]);
    }
  });

  it("puts the start request's direction on call.direction, inbound when it states none", async () => {
    expect(await infoAtVoiceStart(undefined, "outbound")).toMatchObject({ "call.direction": "outbound" });
    expect(await infoAtVoiceStart()).toMatchObject({ "call.direction": "inbound" });
  });

  it("namespaces every key under client.", () => {
    expect(clientContextInfo({ event: "a", plan: "b" })).toEqual({ "client.event": "a", "client.plan": "b" });
    expect(clientContextInfo(undefined)).toEqual({});
  });
});

// The call's app messages are its runtime's; the host side is connected to the call's
// reporter only when that reporter keeps a record a host can read.
describe("a hosted call's app messages", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function call() {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, vi.fn<AgentLlmClient>());
    let onClosed: (() => void) | undefined;
    const seams: JoinSeams = {
      createRoom: () =>
        ({ name: "room-1", connect: async () => undefined, disconnect: async () => undefined }) as unknown as Room,
      createBundle: async () => ({ session, runtime, definition: {} }) as unknown as VoiceAgentBundle,
      startVoiceAgent: async (start) => {
        onClosed = start.onClosed;
        return { close: async () => start.onClosed?.() } as unknown as VoiceSessionHandle;
      },
      scratchRoot: SCRATCH_ROOT,
    };
    return {
      runtime,
      join: (reporter?: HostedCallReporter) =>
        joinRoomAndServe({ url: "ws://realtime", token: "jwt", ...(reporter ? { reporter } : {}) }, seams),
      hangUp: () => onClosed?.(),
    };
  }

  it("publishes agent-to-host messages through the call's reporter", async () => {
    const journal = new EventJournal();
    const seen: JournalRecord[] = [];
    journal.subscribe(0, (record) => seen.push(record));
    const { runtime, join } = call();

    const joined = await join(createCallReporter({ journal, producer: "sess-1" }));
    expect(joined.messages).toBe(runtime.messages);
    runtime.messages.send.toHost("ops.progress", { step: 1 });
    expect(seen).toMatchObject([
      { producer: "sess-1", class: "host", body: { name: "ops.progress", expectsReply: false } },
    ]);
    expect(runtime.messages.undeliveredCounts().toHost).toEqual({});
  });

  it("connects no host when the call keeps no record", async () => {
    const { runtime, join } = call();
    await join(createCallReporter());
    runtime.messages.send.toHost("ops.progress");
    expect(runtime.messages.undeliveredCounts().toHost).toEqual({ "ops.progress": 1 });
    await expect(runtime.messages.send.askHost("human.requested")).rejects.toBeInstanceOf(HostUnavailableError);
  });

  it("rejects an ask still waiting when the call ends", async () => {
    const { runtime, join, hangUp } = call();
    const joined = await join(createCallReporter({ journal: new EventJournal(), producer: "sess-1" }));
    const waiting = runtime.messages.send.askHost("human.requested");
    hangUp();
    await expect(waiting).rejects.toBeInstanceOf(HostUnavailableError);
    await joined.ended;
    await expect(runtime.messages.send.askHost("human.requested")).rejects.toBeInstanceOf(HostUnavailableError);
  });
});
