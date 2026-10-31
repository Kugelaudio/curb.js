import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoSubscribe } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Text, useSession } from "../../../index.js";
import { AgentSession, type AgentLlmClient } from "../../../agent-session.js";
import { attachConversationSink, type ConversationSink } from "../../conversation-store.js";
import type { VoiceAgentBundle } from "../../../voice-host.js";
import type { VoiceSessionHandle } from "../orchestration.js";
import type { ClientMessageBridge } from "./messages.js";
import type { LivekitVoiceStartOptions } from "./host.js";
import { runVoiceWorkerJob, type WorkerJobSeams } from "./worker.js";

/**
 * The LiveKit worker job, which `curb start` and a built artifact's worker mode both run:
 * the call is served by the framework's voice host with the agent's own first turn, the
 * room is the call's identity, and the job's end is the call's end.
 *
 * The job context, room and voice pipeline are stand-ins; the runtime, session, recorder and
 * scratch directory are real.
 */

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "curb-worker-job-test-"));
afterAll(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

const pipeline = {};

function CallProbe() {
  const { call } = useSession();
  return <Text>{call ? `call ${call.sessionId} scratch ${call.scratchDir ?? "none"}` : "no call"}</Text>;
}

function probeRuntime(): AgentSiteRuntime {
  return new AgentSiteRuntime(() => (
    <Agent>
      <CallProbe />
    </Agent>
  ));
}

function renderedCall(runtime: AgentSiteRuntime): { sessionId: string; scratchDir: string } | null {
  const match = /call (\S+) scratch (\S+)/.exec(runtime.snapshot().stateSnapshot.join("\n"));
  return match ? { sessionId: match[1]!, scratchDir: match[2]! } : null;
}

/** A conversation whose recording can be made to fail and recover. Writes land on `order`. */
function recordedBundle(order: string[] = []) {
  const state = { writeDown: false };
  const written: Array<[string, number, string]> = [];
  const sink: ConversationSink = {
    startConversation: async () => "conversation-1",
    recordMessage: async (conversationId, seq, message) => {
      if (state.writeDown) throw new Error("sink unreachable");
      order.push("recorded");
      written.push([conversationId, seq, message.content]);
    },
  };
  const runtime = probeRuntime();
  const llm = vi.fn<AgentLlmClient>(async () => ({ text: "sure", toolCalls: [] }));
  const session = new AgentSession(runtime, llm);
  attachConversationSink(sink, session, "probe");
  const bundle = {
    runtime,
    session,
    agentId: "probe",
    definition: { firstTurn: "agent", pipeline },
  } as unknown as VoiceAgentBundle;
  return { state, written, runtime, session, bundle };
}

function job(
  bundle: VoiceAgentBundle,
  options: {
    roomName?: string;
    startFails?: boolean;
    order?: string[];
    metadata?: string;
    /** Called as the voice session starts, to read what the agent has by then. */
    onStart?: () => void;
  } = {},
) {
  const order = options.order ?? [];
  const client = { bind: vi.fn(), detach: vi.fn() } as unknown as ClientMessageBridge;
  const room = { name: options.roomName ?? "room-1" } as unknown as Room;
  const connect = vi.fn(async () => {
    order.push("connect");
  });
  const shutdownCallbacks: Array<() => Promise<void>> = [];
  let started: LivekitVoiceStartOptions | undefined;
  const handle = {
    close: vi.fn(async () => {
      order.push("close");
    }),
  } as unknown as VoiceSessionHandle;
  const seams: WorkerJobSeams = {
    createBundle: async () => bundle,
    attachClient: () => {
      order.push("attach");
      return client;
    },
    startVoiceAgent: async (start) => {
      if (options.startFails) throw new Error("no STT key");
      options.onStart?.();
      started = start;
      return handle;
    },
    scratchRoot: SCRATCH_ROOT,
  };
  const ctx = {
    connect,
    room,
    job: { id: "AJ_test", metadata: options.metadata ?? "" },
    addShutdownCallback: (callback: () => Promise<void>) => shutdownCallbacks.push(callback),
  };
  return {
    run: () => runVoiceWorkerJob(ctx, seams),
    // What agents-js does once the room is gone: every shutdown callback, concurrently.
    shutdown: () => Promise.all(shutdownCallbacks.map((callback) => callback())),
    connect,
    client,
    room,
    handle,
    order,
    started: () => started,
  };
}

describe("the LiveKit worker job", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const loggedErrors = () => errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

  it("serves the call through the voice host with the agent's own first turn", async () => {
    const { bundle } = recordedBundle();
    const call = job(bundle);
    await call.run();

    // Connected (audio only) before anything reads the room.
    expect(call.connect).toHaveBeenCalledWith(undefined, AutoSubscribe.AUDIO_ONLY);
    expect(call.order.slice(0, 2)).toEqual(["connect", "attach"]);
    expect(call.started()).toMatchObject({
      room: call.room,
      roomName: "room-1",
      bundle,
      client: call.client,
      firstTurn: "agent",
      pipeline,
    });
    // serveCall's end-of-call hook reaches the session.
    expect(typeof call.started()?.onClosed).toBe("function");
  });

  it("binds the room as the call's identity, with a scratch directory the job's end removes", async () => {
    const { bundle, runtime } = recordedBundle();
    const call = job(bundle);
    await call.run();

    const bound = renderedCall(runtime);
    expect(bound?.sessionId).toBe("room-1");
    expect(bound?.scratchDir.startsWith(SCRATCH_ROOT)).toBe(true);
    expect(existsSync(bound!.scratchDir)).toBe(true);

    await call.shutdown();
    expect(existsSync(bound!.scratchDir)).toBe(false);
  });

  it("hands the agent LiveKit's job and its dispatch metadata before the session starts", async () => {
    const { bundle, runtime } = recordedBundle();
    let infoAtStart: Record<string, unknown> = {};
    await job(bundle, {
      metadata: '{"customerId":"c-42"}',
      onStart: () => {
        infoAtStart = runtime.info.snapshot();
      },
    }).run();
    expect(infoAtStart).toMatchObject({
      "call.roomName": "room-1",
      "call.jobId": "AJ_test",
      "call.metadata": '{"customerId":"c-42"}',
      // A dispatch carries no typed direction, so a dispatched call reads inbound.
      "call.direction": "inbound",
    });

    // A dispatch without metadata sets no empty key.
    const plain = recordedBundle();
    await job(plain.bundle).run();
    expect(plain.runtime.info.snapshot()).toMatchObject({ "call.roomName": "room-1", "call.jobId": "AJ_test" });
    expect(plain.runtime.info.snapshot()).not.toHaveProperty("call.metadata");
  });

  it("closes the call before it finishes the recording", async () => {
    const order: string[] = [];
    const { bundle, state, session, written } = recordedBundle(order);
    const call = job(bundle, { order });
    await call.run();
    state.writeDown = true;
    await session.runTurn("hello");
    expect(written).toEqual([]);
    state.writeDown = false;

    await call.shutdown();
    // The sink's last retry of what it refused during the call, after the session closed.
    expect(written).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "sure"],
    ]);
    expect(order).toEqual(["connect", "attach", "close", "recorded", "recorded"]);
  });

  it("reports what the sink still refuses when the voice session failed to start", async () => {
    const { bundle, state, session } = recordedBundle();
    state.writeDown = true;
    await session.runTurn("hello");
    const call = job(bundle, { startFails: true });

    await expect(call.run()).rejects.toThrow(/no STT key/);
    // The caller's app is no longer served by a call that never started.
    expect(call.client.detach).toHaveBeenCalledTimes(1);
    await call.shutdown();
    expect(call.handle.close).not.toHaveBeenCalled();
    expect(loggedErrors()).toMatch(/lost 2 messages of conversation conversation-1/);
  });

  it("refuses a job whose room has no name, since the call could not be identified", async () => {
    const { bundle } = recordedBundle();
    await expect(job(bundle, { roomName: "" }).run()).rejects.toThrow(/without a room name/);
  });
});
