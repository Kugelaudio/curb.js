import { describe, expect, it } from "vitest";
import { replyInk, splitAtSpokenWords, spokenBelongsToReply } from "./spoken-split.js";

describe("splitAtSpokenWords", () => {
  it("aligns a punctuation-free prefix onto the written reply", () => {
    // What forced alignment actually reports: bare words, single-spaced. It is
    // not a character-prefix, so slicing by its length lands mid-word.
    expect(
      splitAtSpokenWords("Hey, I'm Juno, here to help. Is everyone safe?", "Hey I'm Juno here "),
    ).toEqual({ spoken: "Hey, I'm Juno, here", unspoken: "to help. Is everyone safe?" });
  });

  it("keeps punctuation attached to the last heard word", () => {
    // The character-prefix shortcut stranded a lone "." in the muted half here.
    expect(splitAtSpokenWords("All set.", "All set ")).toEqual({
      spoken: "All set.",
      unspoken: "",
    });
  });

  it("never runs past the end of the reply", () => {
    expect(splitAtSpokenWords("Two words", "Two words and then some more")).toEqual({
      spoken: "Two words",
      unspoken: "",
    });
  });
});

describe("spokenBelongsToReply", () => {
  it("accepts a cursor for the reply it came from, ignoring punctuation", () => {
    expect(spokenBelongsToReply("Hey, I'm here to help.", "Hey I'm here")).toBe(true);
  });

  it("rejects a cursor for a different reply", () => {
    // Audio outlives its text: the newest committed message can still be the
    // PREVIOUS reply when a new one starts playing. Inking there would grey out
    // words the caller already heard.
    expect(spokenBelongsToReply("Sure, let me check that.", "Hey I'm here")).toBe(false);
  });

  it("rejects an empty cursor", () => {
    expect(spokenBelongsToReply("Anything.", "   ")).toBe(false);
  });
});

describe("replyInk", () => {
  const reply = "I can hear you fine — can you hear me?";

  it("renders normally when no reply is in flight", () => {
    expect(replyInk(reply, { phase: "idle" })).toBeNull();
  });

  it("mutes the whole reply before a word of it is heard", () => {
    // The gap the flicker lived in: the transcript entry commits before playout
    // starts, so there is a real window with a reply on screen and nothing
    // heard. Rendering it inked there and re-muting a moment later read as the
    // reply being un-said.
    expect(replyInk(reply, { phase: "pending" })).toEqual({ spoken: "", unspoken: reply });
  });

  it("inks exactly the words heard so far", () => {
    expect(replyInk(reply, { phase: "speaking", heard: "I can hear you " })).toEqual({
      spoken: "I can hear you",
      unspoken: "fine — can you hear me?",
    });
  });

  it("renders normally once the reply has been heard to the end", () => {
    // Distinct from `idle` on purpose. The synchronizer closes its stream when
    // playout finishes and the last chunk does not always carry the closing
    // word, so trusting the cursor here left that word muted forever.
    expect(replyInk(reply, { phase: "spoken" })).toBeNull();
  });

});
