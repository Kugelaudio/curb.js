import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../agent-session.js";
import { createBackOffice, type VoiceBackChannel } from "./back-office.js";

describe("the back office and a held action", () => {
  it("tells a tool call that comes after the outcome was reported that it was", async () => {
    const session = {
      pendingConfirmation: { id: "held" } as unknown,
      isRunning: false,
      recordHeard: () => undefined,
      runTurn: async () => {
        session.pendingConfirmation = null;
        return "You are booked.";
      },
    };
    const told: string[] = [];
    const voice = { appendCommentary: (text: string) => void told.push(text) } as unknown as VoiceBackChannel;
    const office = createBackOffice({ session: () => session as unknown as AgentSession, voice: () => voice });

    office.heard("assistant", "Book Tuesday, is that right?");
    office.callerStarted();
    office.heard("user", "Yes.");
    await office.settled();

    expect(told).toEqual(["You are booked."]);
    await expect(office.asked("The caller confirmed")).resolves.toContain("reported this already");
  });
});
