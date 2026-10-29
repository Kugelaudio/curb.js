import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { Agent, AgentSiteRuntime, Text, useAgentInfo } from "./index.js";
import { openingLineOf, type AgentOpeningLine } from "./config.js";
import type { AgentChatMessage } from "./llm/types.js";

/**
 * `defineAgent({ firstTurn: { say } })`: the session opens every conversation with exactly that
 * line, once, with no model call, whichever route runs the conversation.
 */

const LINE = "Ich bin Clara, die digitale Assistentin von Beispiel GmbH.";
const NOTE = "(The conversation has just started.)";

function EventBanner() {
  const event = useAgentInfo((info) => info["client.event"] as string | undefined);
  return event ? <Text>The caller came from the page about {event}.</Text> : null;
}

function site() {
  return (
    <Agent>
      <Text>Welcome.</Text>
      <EventBanner />
    </Agent>
  );
}

function makeSession(say: AgentOpeningLine | (() => never)) {
  const runtime = new AgentSiteRuntime(site);
  const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Gern, worum geht es?", toolCalls: [] }));
  const session = new AgentSession(runtime, llm, { opening: openingLineOf({ say }) });
  return { runtime, session, llm };
}

const said = (messages: readonly AgentChatMessage[]) =>
  messages.map((message) => [message.role, message.role === "user" ? (message.kind ?? null) : null, message.content]);

describe("AgentSession.open", () => {
  it("records the line as the agent's first message, after a synthetic note, with no model call", () => {
    const { session, llm } = makeSession(LINE);

    expect(session.open()).toBe(LINE);
    expect(said(session.messages)).toEqual([
      ["user", "synthetic", NOTE],
      ["assistant", null, LINE],
    ]);
    // Once: the conversation has begun.
    expect(session.open()).toBeNull();
    expect(session.messages).toHaveLength(2);
    expect(llm).not.toHaveBeenCalled();
  });

  it("opens before the first turn, so the model sees it greeted, and never twice", async () => {
    const { session, llm } = makeSession(LINE);

    await session.runTurn("Hallo, ich habe eine Frage.");
    await session.runTurn("Zu meiner Bestellung.");

    expect(llm).toHaveBeenCalledTimes(2);
    // The transcript starts on the caller's side, as every provider requires, then the line.
    const [first] = llm.mock.calls[0]!;
    expect(first.messages.slice(0, 3).map((message) => [message.role, message.content])).toEqual([
      ["user", NOTE],
      ["assistant", LINE],
      ["user", "Hallo, ich habe eine Frage."],
    ]);
    expect(session.messages.filter((message) => message.content === LINE)).toHaveLength(1);
  });

  it("writes the line from the info the conversation has when it opens, after the context it changed", () => {
    const { session } = makeSession((info) => `Willkommen zum ${String(info["client.event"] ?? "Gespräch")}.`);

    session.updateInfo({ "client.event": "Webinar am 11.04." });

    expect(session.open()).toBe("Willkommen zum Webinar am 11.04..");
    expect(said(session.messages).map(([role, kind]) => [role, kind])).toEqual([
      ["user", "context_event"],
      ["user", "synthetic"],
      ["assistant", null],
    ]);
  });

  it("does not open a conversation that has begun: a restored or rewound one", async () => {
    const { session } = makeSession(LINE);
    session.restoreTranscript([
      { role: "user", content: "Hallo." },
      { role: "assistant", content: "Hallo, wie kann ich helfen?" },
    ]);

    expect(session.open()).toBeNull();
    await session.runTurn("Noch eine Frage.");
    expect(session.messages.map((message) => message.content)).not.toContain(LINE);
  });

  it("reports a failing opening once; the conversation goes on without the line", async () => {
    const { session, llm } = makeSession(() => {
      throw new Error("no event on this page");
    });

    expect(() => session.open()).toThrow("no event on this page");
    expect(session.open()).toBeNull();
    await session.runTurn("Hallo?");

    expect(llm).toHaveBeenCalledTimes(1);
    expect(said(session.messages)).toEqual([
      ["user", "synthetic", NOTE],
      ["user", null, "Hallo?"],
      ["assistant", null, "Gern, worum geht es?"],
    ]);
  });

  it("opens a new conversation again", () => {
    const { session } = makeSession(LINE);
    session.open();
    session.reset();

    expect(session.open()).toBe(LINE);
    expect(session.messages).toHaveLength(2);
  });

  it("has nothing to open with when the agent has no fixed line", async () => {
    const runtime = new AgentSiteRuntime(site);
    const session = new AgentSession(runtime, async () => ({ text: "Hallo.", toolCalls: [] }));

    expect(session.open()).toBeNull();
    await session.runTurn("Hi");
    expect(said(session.messages)).toEqual([
      ["user", null, "Hi"],
      ["assistant", null, "Hallo."],
    ]);
  });
});
