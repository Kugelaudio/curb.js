import { describe, expect, it } from "vitest";
import { kugelAgentHeaders, PLATFORM_PROVIDED } from "./provider-keys.js";

describe("kugelAgentHeaders", () => {
  it("names the agent when the platform gave it a token", () => {
    expect(kugelAgentHeaders({ KUGELAUDIO_AGENT_TOKEN: " agent-token " })).toEqual({ "X-Kugel-Agent": "agent-token" });
  });

  it("adds no header without a token", () => {
    expect(kugelAgentHeaders({})).toEqual({});
    expect(kugelAgentHeaders({ KUGELAUDIO_AGENT_TOKEN: "  " })).toEqual({});
  });

  it("reads the environment at each call, so a token set later counts", () => {
    const env: Record<string, string> = {};
    expect(kugelAgentHeaders(env)).toEqual({});
    env.KUGELAUDIO_AGENT_TOKEN = "agent-token";
    expect(kugelAgentHeaders(env)).toEqual({ "X-Kugel-Agent": "agent-token" });
  });

  it("is the platform's to set, so it is never pushed as a secret", () => {
    expect(PLATFORM_PROVIDED.has("KUGELAUDIO_AGENT_TOKEN")).toBe(true);
  });
});
