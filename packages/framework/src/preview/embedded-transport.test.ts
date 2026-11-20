import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedPreviewTransport } from "./embedded-transport.js";
import { DemoWsClient } from "./ws-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("embedded preview client", () => {
  it("updates through the parent, filters privileged frames, and detaches without opening a socket", () => {
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const parent = { postMessage: vi.fn() };
    const listeners = new Set<(event: MessageEvent) => void>();
    const page = {
      parent, location: { origin: "https://example.test" },
      document: { documentElement: { dataset: { curbTransport: "parent" } } },
      addEventListener: (_: string, callback: (event: MessageEvent) => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: (event: MessageEvent) => void) => listeners.delete(callback),
    } as unknown as Window;
    const receive = (frame: object, origin = "https://example.test", source: object = parent) => {
      for (const listener of listeners) listener({ origin, source, data: { type: "curb_preview_frame", frame } } as MessageEvent);
    };
    const client = new DemoWsClient("ws://example.test", {}, embeddedPreviewTransport(page));
    const changed = vi.fn();
    const unsubscribe = client.subscribe(changed);
    client.connect();
    expect(client.getState().connected).toBe(true);
    receive({ type: "running", value: true }, "https://other.test");
    receive({ type: "running", value: true }, "https://example.test", {});
    expect(client.getState().running).toBe(false);
    receive({ type: "running", value: true });
    const messages = [{ role: "user", content: "Hello" }];
    receive({ type: "messages", messages });
    expect(client.getState()).toMatchObject({ running: true, messages });
    expect(changed).toHaveBeenCalled();

    receive({ type: "voice_session", live: true, transport: "livekit", url: "wss://example.test", token: "fixture", room: "fixture" });
    receive({ type: "mcp_servers", servers: [{ id: "one", status: "auth_required", authUrl: "https://example.test/authorize" }] });
    receive({ type: "dev_reload", state: "waiting", until: "reply_ends", files: [] });
    const agent = { id: "agent", source: "", preview: {}, skills: [] };
    receive({ type: "agents", agents: [agent.id], active: agent });
    expect(client.getState()).toMatchObject({
      activeAgent: agent, reload: null, mcpServers: [],
      voice: { live: false, connecting: false, token: null, url: null, room: null },
    });

    client.inspectSkill("/billing");
    client.voiceStart();
    client.voiceStop();
    client.mcpConnect("one");
    expect(client.getState().voice.connecting).toBe(false);
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: "curb_preview_ready" }, "https://example.test"],
      [{ type: "curb_preview_action", frame: { type: "inspect_skill", skill: "/billing" } }, "https://example.test"],
    ]);

    client.dispose();
    expect(listeners.size).toBe(0);
    expect(client.getState().connected).toBe(false);
    receive({ type: "running", value: false });
    expect(client.getState().running).toBe(true);
    expect(socket).not.toHaveBeenCalled();
    unsubscribe();
    delete page.document.documentElement.dataset.curbTransport;
    expect(embeddedPreviewTransport(page)).toBeUndefined();
  });
});
