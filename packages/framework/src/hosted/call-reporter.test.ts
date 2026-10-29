import { describe, expect, it } from "vitest";
import {
  createCallReporter,
  MAX_RECORDED_MESSAGE_BYTES,
  recordClientTraffic,
  type ConversationBody,
} from "./call-reporter.js";
import { EventJournal, type JournalRecord } from "./event-journal.js";
import { JournalRecord as JournalRecordSchema } from "./protocol.js";

/**
 * One call's record of itself.
 *
 * Several calls share one runner journal, so what keeps their transcripts apart is the
 * producer name and the per-call sequence, which is also the reader's deduplication key.
 */

function drain(journal: EventJournal): JournalRecord[] {
  const seen: JournalRecord[] = [];
  journal.subscribe(0, (record) => seen.push(record));
  return seen;
}

const bodyOf = (record: JournalRecord): ConversationBody =>
  record.body as ConversationBody;

describe("createCallReporter", () => {
  it("namespaces event kinds so a framework cannot forget to", () => {
    const journal = new EventJournal();
    const reporter = createCallReporter({ journal, producer: "sess_a" });

    reporter.event("skill_rendered", { skill: "greeting" }, 12);

    const body = bodyOf(drain(journal)[0]!);
    expect(body).toMatchObject({
      type: "event",
      kind: "curb.skill_rendered",
      durationMs: 12,
      payload: { skill: "greeting" },
    });
  });

  it("nests the body rather than spreading it beside the envelope", () => {
    // A framework field one day called `class` or `envelope` would otherwise overwrite the
    // routing information a reader relies on.
    const journal = new EventJournal();
    createCallReporter({ journal, producer: "sess_a" }).turn({
      speaker: "caller",
      text: "hi",
      final: true,
    });

    const record = drain(journal)[0]!;
    expect(record.body).toMatchObject({ type: "turn", text: "hi" });
    expect(record.class).toBe("conversation");
  });

  it("publishes only records the protocol schema accepts", async () => {
    const journal = new EventJournal();
    const reporter = createCallReporter({ journal, producer: "sess_a" });
    reporter.turn({ speaker: "agent", text: "Hello.", final: true });
    reporter.event("tool_called", { name: "lookup" }, 41.5);
    await reporter.finish("completed");

    for (const record of drain(journal)) JournalRecordSchema.parse(record);
  });

  it("writes a terminal record carrying the call's next sequence number", async () => {
    const journal = new EventJournal();
    const reporter = createCallReporter({ journal, producer: "sess_a" });

    reporter.turn({ speaker: "caller", text: "bye", final: true });
    await reporter.finish("caller_hung_up");

    const records = drain(journal);
    const last = bodyOf(records[records.length - 1]!);
    // A reader tells a finished conversation from a truncated one by whether this arrived
    // before the stream ended, so it must be a real record in the call's own sequence.
    expect(last).toMatchObject({ type: "event", kind: "curb.ended" });
    expect(records[records.length - 1]!.seq).toBe(2);
  });

  it("counts records it had nowhere to put instead of pretending they were kept", () => {
    // `curb dev`, the unit suite and `curb build`'s verification all place real calls that
    // nothing is listening to. Failing them would be the wrong trade; claiming the call was
    // recorded would be worse.
    const reporter = createCallReporter();

    reporter.turn({ speaker: "caller", text: "into the void", final: true });
    reporter.event("tool_called", { name: "lookup" });

    expect(reporter.undelivered).toBe(2);
  });

  it("publishes a schema-valid host record on the conversation's sequence", () => {
    const journal = new EventJournal();
    const reporter = createCallReporter({ journal, producer: "sess_a", now: () => 1_790_000_000_000 });
    reporter.turn({ speaker: "caller", text: "I need a supervisor", final: true });

    expect(reporter.journaled).toBe(true);
    expect(
      reporter.host({ id: "a-1", name: "human.requested", payload: { topic: "refund" }, expectsReply: true }),
    ).toBe(true);
    reporter.turn({ speaker: "agent", text: "One moment.", final: true });

    const records = drain(journal);
    const host = records[1]!;
    expect(JournalRecordSchema.parse(host)).toEqual({
      envelope: 2,
      producer: "sess_a",
      seq: 2,
      class: "host",
      at: 1_790_000_000_000,
      body: {
        type: "host",
        seq: 2,
        at: 1_790_000_000_000,
        id: "a-1",
        name: "human.requested",
        payload: { topic: "refund" },
        expectsReply: true,
      },
    });
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it("says a host record did not leave when the call keeps no record", () => {
    const reporter = createCallReporter();
    expect(reporter.journaled).toBe(false);
    expect(reporter.host({ id: "a-1", name: "ops.note", payload: {}, expectsReply: false })).toBe(false);
    expect(reporter.undelivered).toBe(1);
  });

  it("never throws into the call when a reader fails", () => {
    const journal = new EventJournal({ log: () => {} });
    journal.subscribe(0, () => {
      throw new Error("socket is gone");
    });
    const reporter = createCallReporter({ journal, producer: "sess_a" });

    // A caller is a person mid-sentence. Losing the conversation to protect its record
    // would be the wrong trade in every case.
    expect(() => reporter.turn({ speaker: "caller", text: "still talking", final: true })).not.toThrow();
  });
});

describe("what a call sent to, and could not deliver to, the caller's app", () => {
  it("writes one curb.messages event before curb.ended, only when something is non-zero", async () => {
    const quiet = new EventJournal();
    const calm = createCallReporter({ journal: quiet, producer: "calm", now: () => 1 });
    calm.count({ undeliveredToClient: {}, refusedQueuedHostMessages: 0 });
    await calm.finish("completed");
    expect(drain(quiet).map((record) => (bodyOf(record) as { kind: string }).kind)).toEqual(["curb.ended"]);

    const journal = new EventJournal();
    const reporter = createCallReporter({ journal, producer: "sess-1", now: () => 1 });
    reporter.count({ undeliveredToClient: { "show-form": 2 } });
    reporter.count({ undeliveredToClient: { "show-form": 1, summary: 1 }, refusedQueuedHostMessages: 1 });
    await reporter.finish("completed");
    const records = drain(journal);
    expect(records.map((record) => JournalRecordSchema.parse(record))).toHaveLength(2);
    expect(bodyOf(records[0]!)).toMatchObject({
      type: "event",
      kind: "curb.messages",
      payload: { undeliveredToClient: { "show-form": 3, summary: 1 }, refusedQueuedHostMessages: 1 },
    });
    expect(bodyOf(records[1]!)).toMatchObject({ kind: "curb.ended" });
  });

  it("journals messages and replies to the client, cutting a large value to 4 KiB of JSON", () => {
    const journal = new EventJournal();
    const record = recordClientTraffic(createCallReporter({ journal, producer: "sess-1", now: () => 1 }));
    record({ kind: "message_to_client", key: "show-form", id: "m-1", payload: { form: "claim" } });
    record({ kind: "reply_to_client", key: "quote", id: "q-1", reply: 12 });
    record({ kind: "message_to_client", key: "big", id: "m-2", payload: { text: "é".repeat(5000) } });
    const bodies = drain(journal).map((entry) => bodyOf(entry) as { kind: string; payload: Record<string, unknown> });
    expect(bodies[0]).toMatchObject({ kind: "curb.message_to_client", payload: { key: "show-form", id: "m-1", payload: { form: "claim" } } });
    expect(bodies[0]?.payload.truncated).toBeUndefined();
    expect(bodies[1]).toMatchObject({ kind: "curb.reply_to_client", payload: { key: "quote", id: "q-1", reply: 12 } });
    const cut = bodies[2]!.payload;
    expect(cut.truncated).toBe(true);
    expect(typeof cut.payload).toBe("string");
    expect(new TextEncoder().encode(cut.payload as string).length).toBeLessThanOrEqual(MAX_RECORDED_MESSAGE_BYTES);
    expect(cut.payload as string).toMatch(/^\{"text":"éé/);
    expect(cut.payload as string).not.toContain("\uFFFD");
  });
});
