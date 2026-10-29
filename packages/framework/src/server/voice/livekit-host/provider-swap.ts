/**
 * Mid-call speech provider swap.
 *
 * The conversation's effective `stt`/`tts` come from the rendered tree (`<Agent tts>`, the
 * active `<Skill tts>`). When one changes, the call keeps going on new providers.
 * `@livekit/agents` 1.5 has no in-place TTS/STT swap; its native path is
 * `AgentSession.updateAgent(agent)` with a new `voice.Agent` carrying `stt`/`tts`. LiveKit
 * drains the old agent (the reply being spoken finishes in the old voice), then starts the
 * new one, so a swap takes effect from the next reply. The old agent's chat context is
 * copied into the new one.
 *
 * Descriptors are compared structurally: a re-render with an unchanged prop builds nothing
 * and hands over nothing. Providers the new agent replaced are closed once LiveKit reports
 * the handoff, which it does only after the old agent's activity has closed.
 */

import type { llm, stt, tts, voice } from "@livekit/agents";
import { sameDescriptor } from "../../../session-settings.js";
import type { SttDescriptor, TtsDescriptor } from "../../../providers.js";
import type { VoiceProviders, VoiceProviderSettings } from "../providers.js";

/** Builds the next agent of this call: same turn runner, clips and callbacks, new providers. */
export type SwapAgentFactory = (options: {
  id: string;
  stt: stt.STT;
  tts: tts.TTS;
  chatCtx: llm.ChatContext;
}) => voice.Agent;

/** The part of `voice.AgentSession` a swap drives. */
export type SwapSession = { updateAgent(agent: voice.Agent): void };

export type ProviderSwitch = {
  /** Bring the call onto `settings`. Resolves once any swap is handed to LiveKit; never
   * rejects (a provider that cannot be built is reported and the call keeps its current
   * one). */
  apply(settings: VoiceProviderSettings): Promise<void>;
  /** LiveKit finished handing over to `agentId`: close what that agent replaced. */
  handedOver(agentId: string): void;
  /** The providers the call is on right now (or about to be, mid-handoff). */
  current(): VoiceProviders;
  /** Close every provider this switch still holds. Failures go to onError. */
  close(): Promise<void>;
};

type Closable = { close?(): Promise<void> | void };

export function createProviderSwitch(options: {
  session: SwapSession;
  initial: VoiceProviders;
  initialAgent: voice.Agent;
  createAgent: SwapAgentFactory;
  build: {
    stt: (descriptor: SttDescriptor) => Promise<stt.STT>;
    tts: (descriptor: TtsDescriptor) => Promise<tts.TTS>;
  };
  log: (message: string) => void;
  onError: (error: unknown) => void;
}): ProviderSwitch {
  let applied = options.initial;
  let agent = options.initialAgent;
  let wanted: VoiceProviderSettings = options.initial.descriptors;
  let queue: Promise<void> = Promise.resolve();
  let swaps = 0;
  let closed = false;
  /** Providers waiting for the handoff to the agent that replaced them. */
  const retiring = new Map<string, Closable[]>();

  const closeAll = (providers: Closable[]) =>
    Promise.allSettled(providers.map(async (provider) => provider.close?.()));
  const reportFailures = (results: PromiseSettledResult<unknown>[], what: string) => {
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (reasons.length > 0) options.onError(new AggregateError(reasons, what));
  };

  /** One swap toward the LATEST wanted settings; queued so swaps never interleave. */
  const step = async () => {
    const target = wanted;
    const sttChanged = !sameDescriptor(applied.descriptors.stt, target.stt);
    const ttsChanged = !sameDescriptor(applied.descriptors.tts, target.tts);
    if (closed || (!sttChanged && !ttsChanged)) return;

    const built: Closable[] = [];
    let nextStt = applied.stt;
    let nextTts = applied.tts;
    try {
      if (sttChanged) built.push((nextStt = await options.build.stt(target.stt)));
      if (ttsChanged) built.push((nextTts = await options.build.tts(target.tts)));
    } catch (error) {
      await closeAll(built);
      throw error;
    }
    if (closed) {
      await closeAll(built);
      return;
    }

    swaps += 1;
    const next = options.createAgent({
      id: `curb_agent_${swaps}`,
      stt: nextStt,
      tts: nextTts,
      chatCtx: agent.chatCtx.copy(),
    });
    retiring.set(next.id, [
      ...(sttChanged ? [applied.stt as Closable] : []),
      ...(ttsChanged ? [applied.tts as Closable] : []),
    ]);
    const changed = [sttChanged ? `stt → ${target.stt.provider}` : "", ttsChanged ? `tts → ${target.tts.provider}` : ""]
      .filter(Boolean)
      .join(", ");
    applied = { stt: nextStt, tts: nextTts, descriptors: { stt: target.stt, tts: target.tts } };
    agent = next;
    options.session.updateAgent(next);
    options.log(`provider swap ${swaps}: ${changed} (from the next reply)`);
  };

  return {
    apply(settings) {
      wanted = { stt: settings.stt, tts: settings.tts };
      queue = queue.then(step).catch((error: unknown) => {
        // KEEP-JUSTIFIED: a provider that cannot be built (a missing key, a plugin that is
        // not installed) must not end a person's call. The call keeps its current voice;
        // the cause goes to onError, which logs it and reports it on the call record.
        options.onError(error);
      });
      return queue;
    },
    handedOver(agentId) {
      const providers = retiring.get(agentId);
      if (!providers) return;
      retiring.delete(agentId);
      void closeAll(providers).then((results) =>
        reportFailures(results, `closing the providers agent ${agentId} replaced failed`),
      );
    },
    current: () => applied,
    async close() {
      closed = true;
      await queue;
      const held = new Set<Closable>([applied.stt, applied.tts, ...[...retiring.values()].flat()]);
      retiring.clear();
      reportFailures(await closeAll([...held]), "closing the call's speech providers failed");
    },
  };
}
