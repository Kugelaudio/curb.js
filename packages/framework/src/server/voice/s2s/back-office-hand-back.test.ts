import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../agent-session.js";
import { createBackOffice, type VoiceBackChannel } from "./back-office.js";

/** A back office whose turns reply with `replies` in order, then "re: <words>". */
function office(replies: string[], { verbatim = false } = {}) {
  const ran: string[] = [];
  const session = {
    pendingConfirmation: null,
    isRunning: false,
    recordHeard: () => undefined,
    runTurn: async (words: string) => {
      ran.push(words);
      return replies.shift() ?? `re: ${words}`;
    },
  };
  const told: Array<{ text: string; delegationId: string | null }> = [];
  const voice = {
    appendCommentary: (text: string, options: { delegationId: string | null }) => void told.push({ text, delegationId: options.delegationId }),
  } as unknown as VoiceBackChannel;
  const backOffice = createBackOffice({ session: () => session as unknown as AgentSession, voice: () => voice, verbatim });
  /** The caller says `text`: speech starts, then its transcript comes in. */
  const says = (text: string) => {
    backOffice.callerStarted();
    backOffice.heard("user", text);
  };
  return { backOffice, ran, told, says };
}

describe("the back office takes the answer to its question", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the caller's answer itself when the model hands nothing over", async () => {
    const { backOffice, ran, told, says } = office(["Shall I block the card ending 4821?"]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card.", "Yes."]);
    expect(told.at(-1)).toEqual({ text: "re: Yes.", delegationId: null });
  });

  it("leaves an answer the model handed over to that delegation", async () => {
    const { backOffice, ran, told, says } = office(["Shall I block the card ending 4821?"]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    await backOffice.delegated("del_2", "Yes.");
    says("Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card.", "Yes."]);
    expect(told.at(-1)).toEqual({ text: "re: Yes.", delegationId: "del_2" });
  });

  it("waits for a delegation that comes just after the transcript", async () => {
    const { backOffice, ran, told, says } = office(["Shall I block the card ending 4821?"]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Yes.");
    await vi.advanceTimersByTimeAsync(500);
    await backOffice.delegated("del_2", "Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card.", "Yes."]);
    expect(told.filter((line) => line.delegationId === null)).toEqual([]);
  });

  it("answers a late delegation of the same answer with nothing to add", async () => {
    const { backOffice, ran, told, says } = office(["Shall I block the card ending 4821?"]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    await backOffice.delegated("del_2", "Yes.");
    expect(ran).toEqual(["Block my card.", "Yes."]);
    expect(told.at(-1)).toMatchObject({ text: expect.stringContaining("Nothing to add"), delegationId: "del_2" });
  });

  it("takes only the first line after the question", async () => {
    const { backOffice, ran, says } = office(["Shall I block the card ending 4821?", "Done, the card is blocked."]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    says("Thanks.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card.", "Yes."]);
  });

  it("leaves the caller to the model after a reply that asks nothing", async () => {
    const { backOffice, ran, says } = office(["The card is blocked."]);
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Thanks.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card."]);
  });

  it("leaves the answer to the endpoint on verbatim", async () => {
    const { backOffice, ran, says } = office(["Shall I block the card ending 4821?"], { verbatim: true });
    await backOffice.delegated("del_1", "Block my card.");
    vi.advanceTimersByTime(2000);
    says("Yes.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card."]);
  });

  it("does not take a line the caller began before the question", async () => {
    const { backOffice, ran } = office(["Shall I block the card ending 4821?"]);
    backOffice.callerStarted();
    await backOffice.delegated("del_1", "Block my card.");
    backOffice.heard("user", "And quickly, please.");
    await vi.advanceTimersByTimeAsync(1500);
    await backOffice.settled();
    expect(ran).toEqual(["Block my card."]);
  });
});
