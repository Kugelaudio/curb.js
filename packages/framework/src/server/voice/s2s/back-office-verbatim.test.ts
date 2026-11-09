import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../agent-session.js";
import { createBackOffice, type VoiceBackChannel } from "./back-office.js";

/** A back office on `verbatim`, whose turns reply with `replies` in order. */
function verbatimOffice(replies: string[], held: { confirmation: unknown } = { confirmation: null }) {
  const recorded: string[] = [];
  const session = {
    get pendingConfirmation() {
      return held.confirmation;
    },
    isRunning: false,
    recordHeard: (role: string, text: string) => void recorded.push(`${role}: ${text}`),
    runTurn: async () => replies.shift() ?? "",
  };
  const told: Array<{ text: string; expectsReply: boolean }> = [];
  const voice = {
    appendCommentary: (text: string, options: { expectsReply?: boolean }) => void told.push({ text, expectsReply: options.expectsReply === true }),
  } as unknown as VoiceBackChannel;
  const office = createBackOffice({ session: () => session as unknown as AgentSession, voice: () => voice, verbatim: true });
  return { office, recorded, told };
}

describe("the back office on verbatim", () => {
  it("does not keep a reply's transcript that arrives after a later empty turn", async () => {
    const { office, recorded } = verbatimOffice(["Would Monday suit you?", ""]);
    await office.delegated("del_1", "My internet is down.");
    await office.delegated("del_2", "Mhm.");
    office.heard("assistant", "Would Monday suit you?");
    expect(recorded).toEqual([]);
  });

  it("keeps a reply's transcript out however it is split or punctuated", async () => {
    const { office, recorded } = verbatimOffice(["Would Monday at ten suit you, or is Tuesday better?"]);
    await office.delegated("del_1", "My internet is down.");
    office.heard("assistant", "would monday at ten");
    office.heard("assistant", "Suit you or is Tuesday better");
    expect(recorded).toEqual([]);
  });

  it("does not keep a reply's late transcript after another reply went out", async () => {
    const { office, recorded } = verbatimOffice(["Would Monday suit you?", "And which address is it for?"]);
    await office.delegated("del_1", "My internet is down.");
    await office.delegated("del_2", "Mhm.");
    office.heard("assistant", "Would Monday suit you?");
    office.heard("assistant", "And which address is it for?");
    expect(recorded).toEqual([]);
  });

  it("keeps a line of the model's that changes a word of the reply", async () => {
    const { office, recorded } = verbatimOffice(["Would Monday suit you?"]);
    await office.delegated("del_1", "My internet is down.");
    office.heard("assistant", "Would Tuesday suit you?");
    expect(recorded).toEqual(["assistant: Would Tuesday suit you?"]);
  });

  it("keeps the model's own question, right after a reply said as written", async () => {
    const { office, recorded } = verbatimOffice(["Would Monday suit you?"]);
    await office.delegated("del_1", "My internet is down.");
    office.heard("assistant", "Should I book Monday at ten for you?");
    expect(recorded).toEqual(["assistant: Should I book Monday at ten for you?"]);
  });

  it("does not ask the model to read out the note of a held answer's empty turn", async () => {
    const held = { confirmation: { id: "held" } as unknown };
    const { office, told } = verbatimOffice(["Book it?", ""], held);
    await office.delegated("del_1", "Book Tuesday.");
    office.heard("assistant", "Is that right, then?");
    office.callerStarted();
    office.heard("user", "Yes.");
    await office.settled();
    expect(told.at(-1)).toMatchObject({ text: expect.stringContaining("Nothing to add"), expectsReply: false });
  });
});
