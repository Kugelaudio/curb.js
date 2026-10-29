import { describe, expect, it } from "vitest";
import {
  applyCallerSegment,
  callerTextSince,
  followCommits,
  TRANSCRIPTION_FINAL,
  TRANSCRIPTION_SEGMENT_ID,
  type CallerSpeech,
} from "./caller-transcript.js";
import { LivekitVoiceClient } from "./livekit-voice-client.js";

/** The attributes @livekit/agents puts on each caller transcript stream. */
function attrs(segment: string, final: boolean): Record<string, string> {
  return { [TRANSCRIPTION_SEGMENT_ID]: segment, [TRANSCRIPTION_FINAL]: String(final) };
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield part;
}

/** A stream whose one chunk arrives only when `release` is called: a slow interim. */
function heldStream(text: string): { reader: AsyncIterable<string>; release: () => void } {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return {
    reader: (async function* () {
      await ready;
      yield text;
    })(),
    release,
  };
}

/** Feed one caller stream, the way the room's text stream handler does. */
function say(client: LivekitVoiceClient, segment: string, text: string, final = false) {
  return client.receiveTranscript(chunks(text), { fromCaller: true, attributes: attrs(segment, final) });
}

const live = (client: LivekitVoiceClient) => callerTextSince(client.getState().callerSpeech, -1);

describe("the caller's live transcript in a call", () => {
  it("revises in place across the interim streams and never blanks mid-utterance", async () => {
    const client = new LivekitVoiceClient();
    const seen: Array<string | null> = [];
    client.subscribe(() => seen.push(live(client)));

    // @livekit/agents publishes every interim as its own short stream holding the whole
    // text so far, then one final stream for the segment.
    await say(client, "s1", "I'd");
    await say(client, "s1", "I'd like to");
    await say(client, "s1", "I'd like to file a");
    expect(live(client)).toBe("I'd like to file a");
    expect(client.getState().processing).toBe(false);

    await say(client, "s1", "I'd like to file a claim.", true);
    await say(client, "s2", "for my");
    await say(client, "s2", "for my car", true);

    expect(live(client)).toBe("I'd like to file a claim. for my car");
    // Every state the page saw had words in it: no frame where the row vanished.
    expect(seen.every((text) => text !== null && text.length > 0)).toBe(true);
    expect(seen).not.toContain("I'd like to file a claim.\n");
    client.dispose();
  });

  it("ignores an interim that lands after its segment's final, and a repeated final", async () => {
    const client = new LivekitVoiceClient();
    const slow = heldStream("I'd like");
    const late = client.receiveTranscript(slow.reader, { fromCaller: true, attributes: attrs("s1", false) });
    await say(client, "s1", "I'd like to file a claim.", true);
    const settled = client.getState().callerSpeech;

    slow.release();
    await late;
    await say(client, "s1", "I'd like to file a claim.", true);

    expect(live(client)).toBe("I'd like to file a claim.");
    // Nothing changed, so nothing re-renders.
    expect(client.getState().callerSpeech).toBe(settled);
    client.dispose();
  });

  it("keeps an older interim from overwriting a newer one that finished first", async () => {
    const client = new LivekitVoiceClient();
    const slow = heldStream("I'd");
    const late = client.receiveTranscript(slow.reader, { fromCaller: true, attributes: attrs("s1", false) });
    await say(client, "s1", "I'd like to");
    slow.release();
    await late;
    expect(live(client)).toBe("I'd like to");
    client.dispose();
  });

  it("marks the reply pending once, on the final, and an interim never resets a reply being heard", async () => {
    const client = new LivekitVoiceClient();
    const agent = heldStream("");
    const reply = client.receiveTranscript(
      (async function* () {
        yield "Sure, your policy";
        for await (const rest of agent.reader) yield rest;
      })(),
      { fromCaller: false, attributes: {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const speaking = { phase: "speaking", heard: "Sure, your policy" };
    expect(client.getState().replyPlayback).toEqual(speaking);

    // The caller talks over the agent (barge-in): interims arrive while it still speaks.
    await say(client, "s1", "wait");
    expect(client.getState().replyPlayback).toEqual(speaking);
    expect(client.getState().processing).toBe(false);

    await say(client, "s1", "wait, one thing", true);
    expect(client.getState().replyPlayback).toEqual({ phase: "pending" });
    expect(client.getState().processing).toBe(true);
    agent.release();
    await reply;
    client.dispose();
  });
});

describe("applyCallerSegment", () => {
  it("returns the same list for a duplicate, so the page does not re-render", () => {
    const one = applyCallerSegment([], { id: "s1", text: "hello", final: false, opened: 1 });
    expect(applyCallerSegment(one, { id: "s1", text: "hello", final: false, opened: 2 })).toBe(one);
  });

  it("keeps segments in the order they were first heard", () => {
    let speech: CallerSpeech = [];
    speech = applyCallerSegment(speech, { id: "a", text: "one", final: false, opened: 1 });
    speech = applyCallerSegment(speech, { id: "b", text: "two", final: false, opened: 2 });
    speech = applyCallerSegment(speech, { id: "a", text: "one more", final: true, opened: 3 });
    expect(speech.map((segment) => segment.id)).toEqual(["a", "b"]);
    expect(callerTextSince(speech, -1)).toBe("one more two");
  });

  it("ignores empty text", () => {
    expect(applyCallerSegment([], { id: "s1", text: "  ", final: false, opened: 1 })).toEqual([]);
  });
});

describe("followCommits", () => {
  it("hides what was said once the caller's message lands, in the same render", () => {
    let speech: CallerSpeech = [];
    speech = applyCallerSegment(speech, { id: "s1", text: "I'd like to file a claim.", final: true, opened: 1 });
    let window = followCommits(null, 1, speech);
    expect(callerTextSince(speech, window.since)).toBe("I'd like to file a claim.");

    // The server committed the caller's turn: the messages now hold it.
    window = followCommits(window, 2, speech);
    expect(callerTextSince(speech, window.since)).toBeNull();

    // A late final of the committed segment stays hidden; the next utterance shows.
    speech = applyCallerSegment(speech, { id: "s1", text: "I'd like to file a claim", final: true, opened: 2 });
    speech = applyCallerSegment(speech, { id: "s2", text: "And", final: false, opened: 3 });
    window = followCommits(window, 2, speech);
    expect(callerTextSince(speech, window.since)).toBe("And");
  });

  it("keeps the window when a rewind removes messages", () => {
    const speech = applyCallerSegment([], { id: "s1", text: "hi", final: true, opened: 1 });
    const committed = followCommits(followCommits(null, 1, speech), 2, speech);
    expect(followCommits(committed, 1, speech).since).toBe(committed.since);
  });
});
