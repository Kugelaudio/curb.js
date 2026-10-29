import type { JournalRecord } from "./protocol.js";

/**
 * Everything this runner has to say, in one ordered stream.
 *
 * ONE JOURNAL PER RUNNER, fed by every call's reporter and by the runner itself, because a
 * host reads a runner over one connection and a connection needs one ordering.
 *
 * TWO SEQUENCE SPACES:
 *
 *   - `envelope` is assigned here, runner-wide, monotonic and gapless. It answers "where do
 *     I resume" and nothing else.
 *   - `seq` belongs to the producer (one call, or the runner) and arrives already stamped.
 *     It answers "did I miss anything from this producer": a replay is complete at the
 *     envelope level by construction, but a record dropped before it reached the journal
 *     shows only as a gap in its producer's counter.
 *
 * BOUNDED, AND SAYS SO. Records are retained up to `capacity`, and a cursor older than the
 * oldest retained record is refused rather than answered from wherever the buffer starts,
 * which would hand the reader a hole that looks seamless.
 *
 * NEVER THROWS INTO THE CALL. `publish` runs on the path serving a caller mid-sentence; a
 * subscriber whose delivery fails is dropped and reported.
 */

export type { JournalRecord };

/** What a producer hands the journal. `envelope` is the journal's to assign. */
export type JournalEntry = WithoutEnvelope<JournalRecord>;

/** Distributes over the record classes, so each keeps its own `class`/`body` pairing. */
type WithoutEnvelope<R> = R extends unknown ? Omit<R, "envelope"> : never;

export type Subscriber = (record: JournalRecord) => void;

/**
 * A reader asked to resume from a point the journal no longer holds. Carries
 * `oldestRetained` so the reader can say how much it lost. The management server maps this
 * to a 410.
 */
export class CursorTooOldError extends Error {
  readonly oldestRetained: number;
  readonly requested: number;

  constructor(requested: number, oldestRetained: number) {
    super(
      `cannot resume from envelope ${requested}: the oldest record still held is ` +
        `${oldestRetained}, so records between them are gone. Reconnect without a cursor to ` +
        `take the stream from here, and treat the difference as lost.`,
    );
    this.name = "CursorTooOldError";
    this.requested = requested;
    this.oldestRetained = oldestRetained;
  }
}

export interface EventJournalOptions {
  /** How many records to retain for replay. */
  capacity?: number;
  log?: (message: string) => void;
}

/**
 * Sized for a reader reconnecting within seconds, not for a whole conversation: generous
 * enough that a redial loses nothing in practice, bounded so a long call nobody reads
 * cannot grow the heap of a process serving live audio.
 */
const DEFAULT_CAPACITY = 4096;

export class EventJournal {
  readonly #capacity: number;
  readonly #log: (message: string) => void;
  /** A ring: `#size` records starting at `#start`, oldest first. */
  readonly #ring: JournalRecord[];
  #start = 0;
  #size = 0;
  readonly #subscribers = new Set<Subscriber>();
  #envelope = 0;

  constructor(options: EventJournalOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`journal capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
    this.#ring = new Array<JournalRecord>(capacity);
    this.#log = options.log ?? ((message: string) => console.error(message));
  }

  /** The newest envelope assigned, or 0 when nothing has been published. */
  get lastEnvelope(): number {
    return this.#envelope;
  }

  /**
   * The oldest envelope still replayable, or 0 when nothing is held. 0 is what makes
   * `from=0` mean "everything you have" on a journal that has not trimmed yet.
   */
  get oldestRetained(): number {
    return this.#size === 0 ? 0 : this.#ring[this.#start]!.envelope;
  }

  /**
   * Stamp an entry and deliver it. Retained BEFORE delivery, so a subscriber that throws
   * cannot keep the record out of the next reconnect's replay.
   */
  publish(entry: JournalEntry): JournalRecord {
    this.#envelope += 1;
    const record = { ...entry, envelope: this.#envelope } as JournalRecord;

    this.#ring[(this.#start + this.#size) % this.#capacity] = record;
    if (this.#size < this.#capacity) this.#size += 1;
    else this.#start = (this.#start + 1) % this.#capacity;

    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(record);
      } catch (error) {
        this.#subscribers.delete(subscriber);
        this.#log(
          `curb: dropped an events subscriber that failed on delivery: ${describe(error)}`,
        );
      }
    }
    return record;
  }

  /**
   * Replay everything after `after`, then follow live. Returns the unsubscribe.
   *
   * Replay happens synchronously inside this call, so no record published between the
   * replay and the subscription is missed.
   */
  subscribe(after: number, subscriber: Subscriber): () => void {
    const oldest = this.oldestRetained;
    if (after < 0) throw new CursorTooOldError(after, oldest);
    // `after` is EXCLUSIVE, so resuming from the newest record is always valid even when
    // the buffer has since been trimmed past it: there is nothing after it to have lost.
    if (after < oldest - 1 && after < this.#envelope) {
      throw new CursorTooOldError(after, oldest);
    }

    // Envelopes in the ring are consecutive, so the first one to replay is found by offset.
    const skip = this.#size === 0 ? 0 : Math.max(0, after - oldest + 1);
    for (let index = skip; index < this.#size; index += 1) {
      subscriber(this.#ring[(this.#start + index) % this.#capacity]!);
    }
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** How many readers are attached. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
