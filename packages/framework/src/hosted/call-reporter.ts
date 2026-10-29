import type { EventJournal } from "./event-journal.js";
import type { ClientTraffic } from "../messages.js";
import type { ConversationBody, HostRecordBody } from "./protocol.js";

/**
 * What one call reports about itself.
 *
 * ONE PER CALL, never per process. It holds that call's producer name and its own sequence
 * counter, so a runner serving several calls never interleaves two conversations into one
 * sequence space.
 *
 * ONE WAY OUT. Records are published to the runner's journal and leave over the events
 * stream the host reads. The runner never dials the host.
 *
 * NEVER THROWS INTO THE CALL. A caller is a person mid-sentence; losing the conversation to
 * protect its record is the wrong trade. A call with no journal keeps no record and counts
 * what it could not deliver.
 */

export type { ConversationBody, HostRecordBody };

/** An agent-to-host message before the reporter stamps it. */
export type HostRecordMessage = Omit<HostRecordBody, "type" | "seq" | "at">;

export interface CallReporter {
  turn(turn: { speaker: "caller" | "agent"; text: string; final: boolean }): void;
  /** `name` is the half after `curb.`; the namespace is added here so it cannot be forgotten. */
  event(name: string, payload: Record<string, unknown>, durationMs?: number): void;
  /** Writes the terminal record. Never rejects. */
  finish(reason: string): Promise<void>;
  /** Records this call produced with nowhere to put them. */
  readonly undelivered: number;
}

/**
 * What a call failed to deliver, written once as the event `curb.messages` just before
 * `curb.ended`, and only when something is non-zero.
 */
export interface MessageTallies {
  /** `useSend().toClient` messages no client app received (a phone call, or no app yet), per key. */
  undeliveredToClient?: Record<string, number>;
  /** Host messages accepted while the call was starting and refused by the agent once it connected. */
  refusedQueuedHostMessages?: number;
}

/**
 * The reporter a call's owner holds: the conversation, plus the host channel's outbound
 * records. The voice pipeline only needs {@link CallReporter}.
 */
export interface HostedCallReporter extends CallReporter {
  /** Adds to this call's {@link MessageTallies}. */
  count(tallies: MessageTallies): void;
  /**
   * One agent-to-host message, as a `host` record on the SAME sequence as the conversation.
   * Returns false when this call keeps no record, so nothing reaches a host.
   */
  host(message: HostRecordMessage): boolean;
  /** True when records leave this call, i.e. a host can read them. */
  readonly journaled: boolean;
}

export interface CallReporterOptions {
  /** The runner's journal. Absent means this call keeps no record. */
  journal?: EventJournal;
  /** This call's name on the stream. Defaults to `call`. */
  producer?: string;
  now?: () => number;
}

/**
 * Build a reporter for one call.
 *
 * A missing journal is allowed: `curb dev`, the unit suite and `curb build`'s verification
 * all run calls nothing listens to. What was not delivered is counted in `undelivered`.
 */
export function createCallReporter(options: CallReporterOptions = {}): HostedCallReporter {
  const journal = options.journal;
  const producer = options.producer?.trim() || "call";
  const now = options.now ?? (() => Date.now());

  let seq = 0;
  let undelivered = 0;
  const undeliveredToClient: Record<string, number> = {};
  let refusedQueuedHostMessages = 0;

  function write(body: ConversationBody): void {
    if (journal === undefined) {
      undelivered += 1;
      return;
    }
    // The body is NESTED rather than spread beside the envelope, so a body field can never
    // overwrite the routing fields a reader relies on.
    journal.publish({ producer, seq: body.seq, class: "conversation", at: body.at, body });
  }

  return {
    turn(turn) {
      write({ type: "turn", seq: ++seq, at: now(), ...turn });
    },
    event(name, payload, durationMs) {
      write({
        type: "event",
        seq: ++seq,
        at: now(),
        kind: `curb.${name}`,
        ...(durationMs === undefined ? {} : { durationMs }),
        payload,
      });
    },
    count(tallies) {
      for (const [key, n] of Object.entries(tallies.undeliveredToClient ?? {})) {
        undeliveredToClient[key] = (undeliveredToClient[key] ?? 0) + n;
      }
      refusedQueuedHostMessages += tallies.refusedQueuedHostMessages ?? 0;
    },
    async finish(reason) {
      // What the call could not deliver belongs in its record, not only in a log line.
      if (Object.keys(undeliveredToClient).length > 0 || refusedQueuedHostMessages > 0) {
        this.event("messages", { undeliveredToClient: { ...undeliveredToClient }, refusedQueuedHostMessages });
      }
      // The terminal record takes the same path, so it carries the call's next sequence
      // number. A reader tells a finished conversation from a truncated one by whether this
      // arrived before the stream ended.
      this.event("ended", { reason });
    },
    host(message) {
      const next = ++seq;
      if (journal === undefined) {
        undelivered += 1;
        return false;
      }
      const body: HostRecordBody = {
        type: "host",
        seq: next,
        at: now(),
        id: message.id,
        name: message.name,
        payload: message.payload,
        expectsReply: message.expectsReply,
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      };
      journal.publish({ producer, seq: next, class: "host", at: body.at, body });
      return true;
    },
    get journaled() {
      return journal !== undefined;
    },
    get undelivered() {
      return undelivered;
    },
  };
}

/** How much of a message's JSON the call record keeps. */
export const MAX_RECORDED_MESSAGE_BYTES = 4 * 1024;

/**
 * Journal what the agent sent to the client app: every `toClient` message as
 * `curb.message_to_client` `{ key, id, payload }`, every reply to a client's ask as
 * `curb.reply_to_client` `{ key, id, reply }`. A value whose JSON is over
 * {@link MAX_RECORDED_MESSAGE_BYTES} is kept as that much of its JSON text, with
 * `truncated: true`.
 */
export function recordClientTraffic(reporter: CallReporter): (traffic: ClientTraffic) => void {
  return (traffic) => {
    const field = traffic.kind === "message_to_client" ? "payload" : "reply";
    const kept = keepJson(traffic.kind === "message_to_client" ? traffic.payload : traffic.reply);
    reporter.event(traffic.kind, {
      key: traffic.key,
      id: traffic.id,
      [field]: kept.value,
      ...(kept.truncated ? { truncated: true } : {}),
    });
  };
}

function keepJson(value: unknown): { value: unknown; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return { value: "[not JSON]", truncated: true };
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_RECORDED_MESSAGE_BYTES) return { value, truncated: false };
  // A cut through a multi-byte character decodes as U+FFFD; drop it.
  const cut = new TextDecoder().decode(bytes.slice(0, MAX_RECORDED_MESSAGE_BYTES)).replace(/\uFFFD+$/, "");
  return { value: cut, truncated: true };
}
