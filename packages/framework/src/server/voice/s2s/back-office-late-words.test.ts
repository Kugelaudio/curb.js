import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../agent-session.js";
import { createBackOffice, type VoiceBackChannel } from "./back-office.js";

/** A back office whose turns wait until the test lets them end, replying "re: <words>". */
function office() {
  const ran: string[] = [];
  const recorded: string[] = [];
  const open: Array<() => void> = [];
  let running = 0;
  const session = {
    pendingConfirmation: null,
    get isRunning() {
      return running > 0;
    },
    recordHeard: (role: string, text: string) => void recorded.push(`${role}: ${text}`),
    runTurn: (words: string) => {
      ran.push(words);
      running += 1;
      return new Promise<string>((resolve) =>
        open.push(() => {
          running -= 1;
          resolve(`re: ${words}`);
        }),
      );
    },
  };
  const told: Array<{ text: string; delegationId: string | null }> = [];
  const voice = {
    appendCommentary: (text: string, options: { delegationId: string | null }) => void told.push({ text, delegationId: options.delegationId }),
  } as unknown as VoiceBackChannel;
  const backOffice = createBackOffice({ session: () => session as unknown as AgentSession, voice: () => voice });
  /** Ends the oldest running turn and lets what follows from it run. */
  const finish = async () => {
    open.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { backOffice, ran, told, recorded, finish };
}

describe("the back office takes the whole caller turn", () => {
  it("answers the whole line when its end arrives while the fragment's turn runs", async () => {
    const { backOffice, ran, told, finish } = office();
    void backOffice.delegated("del_1", "order three nine nine five");
    backOffice.heard("user", "order three nine nine five zero");
    await finish();
    expect(ran).toEqual(["order three nine nine five", "order three nine nine five zero"]);
    expect(told).toEqual([]);
    await finish();
    await backOffice.settled();
    expect(told).toEqual([{ text: "re: order three nine nine five zero", delegationId: "del_1" }]);
  });

  it("still answers the whole line when its end arrives after the fragment was answered", async () => {
    const { backOffice, ran, told, finish } = office();
    void backOffice.delegated("del_1", "It says two three");
    await finish();
    backOffice.heard("user", "It says two three five one eight");
    await finish();
    await backOffice.settled();
    expect(ran).toEqual(["It says two three", "It says two three five one eight"]);
    expect(told.map((line) => line.text)).toEqual(["re: It says two three", "re: It says two three five one eight"]);
  });

  it("runs the line once when the model hands its whole over again", async () => {
    const { backOffice, ran, told, finish } = office();
    void backOffice.delegated("del_1", "Jana Muster, geboren am");
    void backOffice.delegated("del_2", "Jana Muster, geboren am zwölften März");
    backOffice.heard("user", "Jana Muster, geboren am zwölften März");
    await finish();
    await finish();
    await backOffice.settled();
    expect(ran).toEqual(["Jana Muster, geboren am", "Jana Muster, geboren am zwölften März"]);
    expect(told).toEqual([
      { text: expect.stringContaining("Nothing to add"), delegationId: "del_1" },
      { text: "re: Jana Muster, geboren am zwölften März", delegationId: "del_2" },
    ]);
  });

  it("does not run a line again for a wordless delegation right after it was answered", async () => {
    const { backOffice, ran, told, finish } = office();
    backOffice.heard("user", "Yes. That's the right email.");
    void backOffice.delegated("del_1", "");
    await finish();
    void backOffice.delegated("del_2", "");
    await backOffice.settled();
    expect(ran).toEqual(["Yes. That's the right email."]);
    expect(told.at(-1)).toEqual({ text: expect.stringContaining("Nothing to add"), delegationId: "del_2" });
  });

  it("keeps a transcript that only repeats the delegation's words out of the conversation", async () => {
    const { backOffice, ran, recorded, finish } = office();
    void backOffice.delegated("del_1", "Ja, das stimmt.");
    backOffice.heard("user", "Ja, das stimmt.");
    await finish();
    await backOffice.settled();
    expect(ran).toEqual(["Ja, das stimmt."]);
    expect(recorded).toEqual([]);
  });

  it("takes a longer line later on as a turn of its own", async () => {
    const { backOffice, ran, finish } = office();
    const realNow = Date.now;
    void backOffice.delegated("del_1", "Hello");
    await finish();
    try {
      Date.now = () => realNow() + 10_000;
      backOffice.heard("user", "Hello again, it's me");
      await backOffice.settled();
    } finally {
      Date.now = realNow;
    }
    expect(ran).toEqual(["Hello"]);
  });
});
