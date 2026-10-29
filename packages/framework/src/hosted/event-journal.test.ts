import { describe, expect, it, vi } from "vitest";
import {
  CursorTooOldError,
  EventJournal,
  type JournalEntry,
  type JournalRecord,
} from "./event-journal.js";

/**
 * The rules a journal reader depends on.
 *
 * Each is a way the reader could be handed a stream that looks complete and is not: an
 * envelope that skips, a replay that silently starts late, or a record that reached one
 * subscriber and was then left out of the buffer the next reconnect reads.
 */

function entry(overrides: { producer?: string; seq?: number } = {}): JournalEntry {
  const seq = overrides.seq ?? 1;
  return {
    producer: overrides.producer ?? "sess_a",
    seq,
    class: "conversation",
    at: 1_700_000_000_000,
    body: { type: "turn", seq, at: 1_700_000_000_000, speaker: "caller", text: "hello", final: true },
  };
}

describe("envelope assignment", () => {
  it("is monotonic and gapless across producers", () => {
    const journal = new EventJournal();
    const envelopes = [
      journal.publish(entry({ producer: "sess_a", seq: 1 })),
      journal.publish({
        producer: "runner",
        seq: 1,
        class: "lifecycle",
        at: 1_700_000_000_000,
        body: { event: "ended", reason: "drained" },
      }),
      journal.publish(entry({ producer: "sess_b", seq: 1 })),
      journal.publish(entry({ producer: "sess_a", seq: 2 })),
    ].map((record) => record.envelope);

    expect(envelopes).toEqual([1, 2, 3, 4]);
    expect(journal.lastEnvelope).toBe(4);
  });
});

describe("subscribe", () => {
  it("replays what came after the cursor, then follows live", () => {
    const journal = new EventJournal();
    journal.publish(entry({ seq: 1 }));
    journal.publish(entry({ seq: 2 }));
    journal.publish(entry({ seq: 3 }));

    const seen: number[] = [];
    journal.subscribe(1, (record) => seen.push(record.envelope));
    expect(seen).toEqual([2, 3]);

    journal.publish(entry({ seq: 4 }));
    expect(seen).toEqual([2, 3, 4]);
  });

  it("stops delivering once unsubscribed", () => {
    const journal = new EventJournal();
    const seen: number[] = [];
    const stop = journal.subscribe(0, (record) => seen.push(record.envelope));

    journal.publish(entry({ seq: 1 }));
    stop();
    journal.publish(entry({ seq: 2 }));

    expect(seen).toEqual([1]);
    expect(journal.subscriberCount).toBe(0);
  });

  it("accepts a cursor at the newest record even after trimming", () => {
    // Resuming from the newest record asks for nothing, so it cannot have lost anything --
    // refusing it would make an idle reader's reconnect fail for no reason.
    const journal = new EventJournal({ capacity: 2 });
    journal.publish(entry({ seq: 1 }));
    journal.publish(entry({ seq: 2 }));
    journal.publish(entry({ seq: 3 }));

    const seen: number[] = [];
    expect(() => journal.subscribe(3, (record) => seen.push(record.envelope))).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe("the bound is honest", () => {
  it("retains only up to capacity", () => {
    const journal = new EventJournal({ capacity: 2 });
    journal.publish(entry({ seq: 1 }));
    journal.publish(entry({ seq: 2 }));
    journal.publish(entry({ seq: 3 }));

    expect(journal.oldestRetained).toBe(2);
  });

  it("refuses a cursor older than what it holds instead of answering from the middle", () => {
    // The failure this prevents: a stream that resumes at envelope 2 when the caller asked
    // for 1, delivers seamlessly, and leaves the conversation missing a record with nothing
    // anywhere saying so.
    const journal = new EventJournal({ capacity: 2 });
    journal.publish(entry({ seq: 1 }));
    journal.publish(entry({ seq: 2 }));
    journal.publish(entry({ seq: 3 }));

    expect(() => journal.subscribe(0, () => {})).toThrow(CursorTooOldError);
    try {
      journal.subscribe(0, () => {});
    } catch (error) {
      expect((error as CursorTooOldError).oldestRetained).toBe(2);
      expect((error as CursorTooOldError).requested).toBe(0);
    }
  });
});

describe("a failing subscriber", () => {
  it("is dropped and reported, and does not reach the caller", () => {
    const log = vi.fn();
    const journal = new EventJournal({ log });
    const good: number[] = [];

    journal.subscribe(0, () => {
      throw new Error("socket is gone");
    });
    journal.subscribe(0, (record) => good.push(record.envelope));

    expect(() => journal.publish(entry({ seq: 1 }))).not.toThrow();
    expect(good).toEqual([1]);
    expect(journal.subscriberCount).toBe(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it("still leaves the record replayable for the next reader", () => {
    // Retained before delivery on purpose: a subscriber that throws must not be able to take
    // the record out of the buffer the next reconnect reads.
    const journal = new EventJournal({ log: vi.fn() });
    journal.subscribe(0, () => {
      throw new Error("socket is gone");
    });
    journal.publish(entry({ seq: 1 }));

    const replayed: JournalRecord[] = [];
    journal.subscribe(0, (record) => replayed.push(record));

    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.envelope).toBe(1);
  });
});

describe("the ring", () => {
  it("replays in order after wrapping many times", () => {
    const journal = new EventJournal({ capacity: 3 });
    for (let seq = 1; seq <= 10; seq += 1) journal.publish(entry({ seq }));

    expect(journal.oldestRetained).toBe(8);
    const all: number[] = [];
    journal.subscribe(7, (record) => all.push(record.envelope));
    expect(all).toEqual([8, 9, 10]);

    const tail: number[] = [];
    journal.subscribe(9, (record) => tail.push(record.envelope));
    expect(tail).toEqual([10]);
  });

  it("refuses a capacity that could hold nothing", () => {
    expect(() => new EventJournal({ capacity: 0 })).toThrow(RangeError);
  });
});
