import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REPLY_IDLE } from "../llm/spoken-split.js";
import type { AgentChatMessage } from "../llm/types.js";
import { ConversationThread } from "./conversation-thread.js";
import { applyCallerSegment, type CallerSpeech } from "./voice/caller-transcript.js";

function thread(messages: AgentChatMessage[], options: { callerSpeech?: CallerSpeech; running?: boolean } = {}) {
  return renderToStaticMarkup(
    <ConversationThread
      messages={messages}
      streamingText={null}
      running={options.running ?? false}
      callLive
      playback={REPLY_IDLE}
      callerSpeech={options.callerSpeech ?? []}
      replay={{ active: false, timeMs: 0, windows: [] }}
      agentName="Agent"
      suggestedPrompts={[]}
      onPrompt={() => undefined}
      skillLabel={(path) => path}
      toolIcon={() => undefined}
      onOpenSkill={() => undefined}
      onShowModelInput={() => undefined}
    />,
  );
}

/** The class list of the bubble holding `text`. */
function bubbleClasses(html: string, text: string): string[] {
  const match = new RegExp(`<div class="([^"]*)"[^>]*>${text}</div>`).exec(html);
  if (!match) throw new Error(`no bubble holds ${text}: ${html}`);
  return match[1].split(" ");
}

describe("ConversationThread in a call", () => {
  it("shows what the caller is saying in the bubble its committed message gets, only muted", () => {
    const speech = applyCallerSegment([], { id: "s1", text: "I would like to file a claim", final: false, opened: 1 });
    const live = thread([{ role: "user", content: "Hi there" }], { callerSpeech: speech });

    const committed = bubbleClasses(live, "Hi there");
    const saying = bubbleClasses(live, "I would like to file a claim");
    expect(saying.filter((name) => name !== "text-muted-foreground")).toEqual(committed);
    expect(saying).toContain("text-muted-foreground");
    // Rewrapping earlier lines as words arrive reads as the words jumping.
    expect(committed).not.toContain("[text-wrap:pretty]");
    expect(live.indexOf("Hi there")).toBeLessThan(live.indexOf("I would like to file a claim"));
  });

  it("keeps the newest reply's actions in their row while the next turn runs", () => {
    const messages: AgentChatMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello, how can I help?" },
    ];
    const idle = thread(messages);
    const running = thread(messages, { running: true });
    expect(idle).toContain('aria-label="Copy"');
    // Hidden, not taken out of the flow: the conversation keeps its height.
    expect(running).toMatch(/class="[^"]*\binvisible\b[^"]*"/);
    expect(running).not.toMatch(/class="[^"]*\babsolute top-full\b[^"]*"[^>]*>\s*<button[^>]*aria-label="Play/);
  });
});
