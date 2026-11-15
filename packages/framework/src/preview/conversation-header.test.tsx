import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../server/protocol.js";
import { ConversationHeader } from "./conversation-header.js";

const startedAt = new Date(2026, 10, 15, 13, 38).getTime();

function header(conversations: readonly ConversationSummary[], activeId: string, options: { running?: boolean } = {}) {
  const active = conversations.find((conversation) => conversation.id === activeId);
  return renderToStaticMarkup(
    <ConversationHeader
      conversations={conversations}
      activeId={activeId}
      running={options.running ?? false}
      hasMessages={(active?.messageCount ?? 0) > 0}
      onSelect={() => undefined}
      onNew={() => undefined}
      onCopyForCodingAgent={() => Promise.resolve(true)}
    />,
  );
}

describe("the conversation header", () => {
  it("offers history and New conversation above a conversation nobody has said anything in", () => {
    const html = header([{ id: "a", agentId: null, startedAt, title: "Untitled", messageCount: 0 }], "a");
    expect(html).toContain('aria-label="Conversation history"');
    expect(html).toContain(">History<");
    // Always there, so a person sees where a new one starts before they need it.
    expect(html).toContain("New conversation");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*New conversation/s);
    // Nothing to hand to a coding agent yet.
    expect(html).not.toContain("Copy for coding agent");
  });

  it("names the conversation on screen and puts New conversation right beside it", () => {
    const html = header([{ id: "a", agentId: null, startedAt, title: "My car was hit", messageCount: 4 }], "a");
    expect(html).toContain("My car was hit");
    expect(html).not.toContain(">History<");
    const history = html.indexOf('aria-label="Conversation history"');
    const fresh = html.indexOf("New conversation");
    const copy = html.indexOf("Copy for coding agent");
    expect(history).toBeGreaterThan(-1);
    expect(fresh).toBeGreaterThan(history);
    expect(copy).toBeGreaterThan(fresh);
  });

  it("holds New conversation back while the agent is replying", () => {
    const html = header([{ id: "a", agentId: null, startedAt, title: "My car was hit", messageCount: 1 }], "a", {
      running: true,
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*New conversation/s);
  });
});
