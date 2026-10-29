/**
 * The LiveKit worker job: one dispatched call, from the room LiveKit hands over to its end.
 *
 * `curb start` registers this module as its agent, and the built artifact's worker mode runs
 * the same {@link runVoiceWorkerJob} from its generated entry. So a dispatched call is served
 * exactly like a `curb dev` call and a hosted runner's: the framework's voice host
 * (`host.ts`) with the agent's own `firstTurn`, the call's identity on `useSession().call`,
 * and the caller on `caller.*`. On top, a dispatched call carries LiveKit's job on
 * `call.*`. A project's `src/orchestration/` is never loaded. The name the worker registers
 * under is `worker-name.ts`.
 */

import { AutoSubscribe, defineAgent, type JobContext } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import { openCallScratch } from "../../../hosted/call-scratch.js";
import { serveCall } from "../../../hosted/serve-call.js";
import { createVoiceAgentBundle, type VoiceAgentBundle } from "../../../voice-host.js";
import { detachConversationRecorder } from "../../conversation-store.js";
import type { VoiceSessionHandle } from "../orchestration.js";
import { startLivekitVoiceAgent, type LivekitVoiceStartOptions } from "./host.js";
import { attachClientMessages } from "./messages.js";

/** The parts of LiveKit's `JobContext` the job uses, so a test can stand in for it. */
export type WorkerJobContext = {
  connect: JobContext["connect"];
  room: Room;
  job: Pick<JobContext["job"], "id" | "metadata">;
  addShutdownCallback: JobContext["addShutdownCallback"];
};

/**
 * What a dispatched call adds to the agent's info (`useAgentInfo`), on top of the `caller.*`
 * keys every call gets: the room, LiveKit's job id, the dispatch's metadata when it carries
 * any (an explicit dispatch's per-call data, such as whom an outbound call is for), and
 * `call.direction`. A dispatch has no typed place for a direction, so it reads `inbound`.
 */
export function dispatchedCallInfo(
  roomName: string,
  job: Pick<JobContext["job"], "id" | "metadata">,
): Record<string, string> {
  return {
    "call.roomName": roomName,
    "call.jobId": job.id,
    "call.direction": "inbound",
    ...(job.metadata ? { "call.metadata": job.metadata } : {}),
  };
}

/** Seams for a hermetic test. A dispatched job uses none of them. */
export type WorkerJobSeams = {
  createBundle?: () => Promise<VoiceAgentBundle>;
  startVoiceAgent?: (options: LivekitVoiceStartOptions) => Promise<VoiceSessionHandle>;
  attachClient?: typeof attachClientMessages;
  /** Where the call's scratch directory is created. Default: the OS temp directory. */
  scratchRoot?: string;
};

/** Serve the call in the dispatched room. Returns once the voice session runs. */
export async function runVoiceWorkerJob(
  ctx: WorkerJobContext,
  seams: WorkerJobSeams = {},
): Promise<void> {
  // Connect first: the voice host subscribes to room events, and an unconnected room fails
  // with `reading 'on'`. Audio only: a voice agent has no use for anyone's video.
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  const roomName = ctx.room.name;
  if (!roomName) {
    throw new Error("curb: LiveKit dispatched a job without a room name, so its call cannot be identified.");
  }
  // The caller's app can reach the agent from here on; the session binds this to its runtime.
  const client = (seams.attachClient ?? attachClientMessages)(ctx.room, { roomName });

  let bundle: VoiceAgentBundle;
  try {
    bundle = await (seams.createBundle ?? (() => createVoiceAgentBundle()))();
  } catch (error) {
    client.detach();
    throw error;
  }
  const scratch = await openCallScratch(
    roomName,
    seams.scratchRoot === undefined ? {} : { root: seams.scratchRoot },
  );

  let handle: VoiceSessionHandle | null = null;
  // The job's end is the call's end. agents-js runs shutdown callbacks once the room is gone,
  // on a normal end AND when this entry threw, before the job process exits. They run
  // concurrently, so this ONE callback keeps the order: the session closes, the sink retries
  // the writes it refused and reports what it still refuses, the scratch directory goes.
  ctx.addShutdownCallback(async () => {
    try {
      await handle?.close();
    } finally {
      await detachConversationRecorder(bundle.session);
      await scratch?.remove();
    }
  });

  // The call's identity reaches its agent from the call, never from the environment: one
  // worker process forks a job per call, and they share its environment.
  bundle.runtime.bindCall({
    sessionId: roomName,
    ...(scratch === null ? {} : { scratchDir: scratch.dir }),
  });
  // Before the session starts, so the first turn (a greeting included) can read them.
  bundle.session.updateInfo(dispatchedCallInfo(roomName, ctx.job));
  try {
    // Registered on `curb start`'s management port under the room name when it serves one.
    handle = await serveCall({ sessionId: roomName, bundle }, (call) =>
      (seams.startVoiceAgent ?? startLivekitVoiceAgent)({
        room: ctx.room,
        roomName,
        bundle,
        client,
        firstTurn: bundle.definition.firstTurn,
        ...call,
      }),
    );
  } catch (error) {
    client.detach();
    throw error;
  }
}

/** `curb start`'s agent module: LiveKit forks a job process per call and runs this entry. */
export default defineAgent({ entry: (ctx) => runVoiceWorkerJob(ctx) });
