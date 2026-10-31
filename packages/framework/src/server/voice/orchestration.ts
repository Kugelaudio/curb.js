import type { Room } from "@livekit/rtc-node";
import type { AgentFirstTurn } from "../../config.js";
import type { AgentSessionBundle } from "../connection.js";
import type { ConversationClips } from "./livekit-host/clip-store.js";
import type { CallReporter } from "../../hosted/call-reporter.js";
import type { ClientMessageBridge } from "./livekit-host/messages.js";
import type { VoicePipeline } from "./livekit-host/pipeline.js";

/**
 * Inputs to the framework's voice session (`startLivekitVoiceAgent`) for one LiveKit room.
 * Every route builds these: `curb dev`, `curb start` and the built artifact's modes.
 */
export type VoiceSessionStartOptions = {
  /** A connected LiveKit room. Browser voice and dispatched workers both use this seam. */
  room: Room;
  roomName: string;
  /** The curb runtime/session whose turns the voice agent drives. Its
   * `runtime.settings` names the call's speech providers. */
  bundle: AgentSessionBundle;
  /**
   * The caller's app (`curb.message` / `curb.update` RPCs, the `curb.message` text stream),
   * attached with `attachClientMessages(room)` by whatever connected the room, right after
   * it connected. The session binds it to its runtime as soon as it starts, again after a
   * rewind (`setBundle`), and detaches it when the call closes.
   */
  client: ClientMessageBridge;
  /** Who opens the call: the agent's `defineAgent({ firstTurn })`. Defaults to the user. */
  firstTurn?: AgentFirstTurn;
  /** The project's changes to the session: the agent's `defineAgent({ pipeline })`. */
  pipeline?: VoicePipeline;
  env?: NodeJS.ProcessEnv;
  /** Called exactly once after the room/session has closed. */
  onClosed?: () => void;
  /**
   * THIS CALL'S reporter: its own log, its own report URL, its own sequence.
   *
   * Per call rather than per process because one process may serve several calls at once.
   * Absent means the call keeps no record, which is how `curb dev` runs.
   */
  reporter?: CallReporter;
};

/** Controls returned by a running voice session. */
export type VoiceSessionHandle = {
  /**
   * End the call and leave the room. With `graceMs` > 0 the agent first finishes the
   * reply it is speaking, waiting at most that long; without it the call ends at once.
   */
  close: (options?: { graceMs?: number }) => Promise<void>;
  clips: ConversationClips;
  sendText: (text: string) => Promise<void>;
  setBundle: (bundle: AgentSessionBundle) => void;
  interrupt: () => void;
};

/**
 * The shape of a module exporting a voice session. Kept as a `curb/orchestration` type for
 * scripts written against it; the framework itself loads no such module from a
 * project.
 */
export type VoiceOrchestrationModule = {
  startVoiceSession: (options: VoiceSessionStartOptions) => Promise<VoiceSessionHandle>;
};
