import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  clientInfo,
  clientInfoProblem,
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";

describe("parseClientMessage", () => {
  it("round-trips every client message shape", () => {
    const messages: ClientMessage[] = [
      { type: "user_text", text: "hello" },
      { type: "read_skill", skill: "/property-damage" },
      { type: "call_tool", name: "request_callback", input: { name: "Ada" } },
      { type: "set_info", values: { "caller.phoneNumber": "+49 89 555 0000" } },
      { type: "mcp_connect", id: "linear-remote" },
      { type: "mcp_disconnect", id: "linear-remote" },
      { type: "mcp_add", id: "notion", url: "https://mcp.notion.com/mcp" },
      { type: "mcp_remove", id: "notion" },
      { type: "select_agent", id: "ops" },
      { type: "reset" },
      { type: "select_conversation", id: "conversation-2" },
      { type: "voice_start" },
      { type: "voice_stop" },
    ];

    for (const message of messages) {
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it("throws ProtocolError on invalid JSON", () => {
    expect(() => parseClientMessage("not json")).toThrow(ProtocolError);
  });

  it("throws ProtocolError on unknown type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "bogus" }))).toThrow(/Unknown client message type/);
  });

});

describe("page info (client.*)", () => {
  const setInfo = (values: Record<string, unknown>) => JSON.stringify({ type: "set_info", values });

  it("takes keys of a letter then letters, digits or underscores, and strings up to 256 characters", () => {
    expect(clientInfoProblem("event", "webinar-11-04")).toBeNull();
    expect(clientInfoProblem("utm_campaign2", "x".repeat(256))).toBeNull();
    expect(clientInfoProblem(`a${"b".repeat(39)}`, "")).toBeNull();
    expect(clientInfoProblem("1event", "x")).toContain('"1event" cannot name page info');
    expect(clientInfoProblem("event-name", "x")).toContain("a letter, then up to 39 letters, digits or underscores");
    expect(clientInfoProblem(`a${"b".repeat(40)}`, "x")).not.toBeNull();
    expect(clientInfoProblem("event", 7)).toBe("client.event must be a string, got number.");
    expect(clientInfoProblem("event", "x".repeat(257))).toBe(
      "client.event is 257 characters long; page info values hold at most 256.",
    );
    expect(clientInfo({ event: "webinar-11-04" })).toEqual({ "client.event": "webinar-11-04" });
  });

  it("refuses a set_info whose page info breaks the limits, and leaves other info alone", () => {
    expect(parseClientMessage(setInfo({ "client.event": "webinar-11-04", "caller.tags": ["vip"] }))).toEqual({
      type: "set_info",
      values: { "client.event": "webinar-11-04", "caller.tags": ["vip"] },
    });
    expect(() => parseClientMessage(setInfo({ "client.event": null, "client.a-b": "x" }))).toThrow(
      'Page info refused: client.event must be a string, got null. "a-b" cannot name page info',
    );
  });
});

describe("serializeServerMessage", () => {
  it("serializes to JSON the client can parse back", () => {
    const message: ServerMessage = { type: "error", scope: "llm", message: "unavailable" };
    expect(JSON.parse(serializeServerMessage(message))).toEqual(message);
  });
});
