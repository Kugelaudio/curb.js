import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewAgent, ServerMessage } from "../server/protocol.js";
import { reloadNotice } from "./dev-reload.js";
import { DemoWsClient, missingKeysOf } from "./ws-client.js";

/** A browser WebSocket stand-in: the test opens it, feeds it frames, closes it. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const AGENT: PreviewAgent = { id: "agent", source: "", preview: {}, skills: [{ path: "/claims", source: "" }] };
const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

/** The frames a connection starts with, on stored conversation `stored` when it resumed one. */
function serve(socket: FakeSocket, stored?: number) {
  socket.open();
  socket.receive({ type: "agents", agents: ["agent"], active: AGENT });
  socket.receive({
    type: "conversations",
    active: stored === undefined ? "conversation-1" : `stored-${stored}`,
    conversations: [],
  });
}

describe("DemoWsClient across a curb dev reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reconnects at once and asks to stay on the recorded conversation", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest());
    expect(client.getState().connection).toBe(1);

    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/agent/agent.tsx"], resume: 5 });
    expect(client.getState().reload).toEqual({ state: "reloading" });
    latest().close();
    vi.advanceTimersByTime(50);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(latest().url).toBe("ws://127.0.0.1:4000/?resume=5");
    serve(latest(), 5);
    expect(client.getState()).toMatchObject({ reload: null, connection: 2, activeConversation: "stored-5" });

    // Any later reconnect that no reload asked for starts where the server says.
    latest().close();
    vi.advanceTimersByTime(500);
    expect(latest().url).toBe("ws://127.0.0.1:4000");
    client.dispose();
  });

  it("backs off again when nothing answers after the reload (curb dev itself stopped)", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest());
    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/agent/agent.tsx"] });
    latest().close();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        vi.advanceTimersByTime(10);
        waited += 10;
      }
      delays.push(waited);
      latest().close();
    }
    expect(delays).toEqual([50, 100, 200, 400]);
    client.dispose();
  });

  it("reconnects without a resume when the conversation was never recorded", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest());
    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/agent/agent.tsx"] });
    latest().close();
    vi.advanceTimersByTime(50);
    expect(latest().url).toBe("ws://127.0.0.1:4000");
    client.dispose();
  });

  it("shows why the agent is not running until it runs again, and resumes through it", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest(), 9);
    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/lib/helper.ts"], resume: 9 });
    latest().close();
    vi.advanceTimersByTime(50);
    expect(latest().url).toBe("ws://127.0.0.1:4000/?resume=9");

    const unavailable = { message: "The agent did not load.", diagnostics: [] };
    latest().open();
    latest().receive({ type: "agent_unavailable", ...unavailable });
    expect(client.getState().unavailable).toEqual(unavailable);

    // The fix is saved: the page is told to reconnect, and lands on its conversation.
    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/lib/helper.ts"] });
    latest().close();
    vi.advanceTimersByTime(50);
    expect(latest().url).toBe("ws://127.0.0.1:4000/?resume=9");
    serve(latest(), 9);
    expect(client.getState().unavailable).toBeNull();
    client.dispose();
  });

  // Onboarding sweep 2026-10-25: with no ANTHROPIC_API_KEY the preview showed only "Your agent
  // is not running", so a customer without keys could not see what was built.
  it("shows an agent whose key is missing, sends it nothing, and lets it answer once a reload has the key", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    const missing = {
      code: "AGENT_INVALID_AUTHORING_PROP" as const,
      severity: "error" as const,
      message: "The agent's llm is anthropic(\"claude-haiku-4-5\"), which needs ANTHROPIC_API_KEY, and this process does not have it.",
      location: { source: "src/agent/agent.tsx", component: "Agent" },
      fix: "Set ANTHROPIC_API_KEY in /project/.env (see .env.example).",
    };
    // The server's order: the missing key before the agent it belongs to.
    const serveWith = (diagnostics: (typeof missing)[]) => {
      latest().open();
      latest().receive({ type: "missing_keys", agentId: "agent", diagnostics });
      latest().receive({ type: "agents", agents: ["agent"], active: AGENT });
    };
    serveWith([missing]);

    expect(client.getState().unavailable).toBeNull();
    expect(client.getState().activeAgent).toEqual(AGENT);
    expect(missingKeysOf(client.getState())).toEqual([missing]);
    client.sendUserText("Hallo");
    client.voiceStart();
    expect(latest().sent).toEqual([]);
    expect(client.getState().voice.connecting).toBe(false);

    // .env saved with the key: the reloaded server says the agent has every key it needs.
    latest().receive({ type: "dev_reload", state: "reloading", files: [".env"] });
    latest().close();
    vi.advanceTimersByTime(50);
    serveWith([]);
    expect(missingKeysOf(client.getState())).toEqual([]);
    client.sendUserText("Hallo");
    expect(latest().sent).toContainEqual({ type: "user_text", text: "Hallo" });
    client.dispose();
  });

  it("lets Start call work again after a call pressed while the socket reconnected", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest());
    latest().receive({ type: "dev_reload", state: "reloading", files: ["src/agent/agent.tsx"], resume: 3 });
    latest().close();

    // Pressed while no socket is open: nothing answers this one.
    client.voiceStart();
    expect(client.getState().voice.connecting).toBe(true);

    vi.advanceTimersByTime(50);
    serve(latest(), 3);
    expect(client.getState().voice).toEqual({ live: false, connecting: false, transport: null, url: null, token: null, room: null });
    client.voiceStart();
    expect(latest().sent).toContainEqual({ type: "voice_start" });
    client.dispose();
  });

  it("keeps what a restored conversation could not bring back until another conversation is active", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest(), 4);
    latest().receive({ type: "notice", message: "Skill(s) /old no longer exist and were not reloaded." });
    expect(client.getState()).toMatchObject({
      notice: "Skill(s) /old no longer exist and were not reloaded.",
      lastError: null,
    });

    // The same conversation again (a frame after a turn) keeps it; another one clears it.
    latest().receive({ type: "conversations", active: "stored-4", conversations: [] });
    expect(client.getState().notice).not.toBeNull();
    latest().receive({ type: "conversations", active: "conversation-2", conversations: [] });
    expect(client.getState().notice).toBeNull();
    client.dispose();
  });

  it("says what a waiting reload waits for", () => {
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    serve(latest());
    latest().receive({ type: "dev_reload", state: "waiting", until: "call_ends", files: ["src/agent/agent.tsx"] });
    expect(client.getState().reload).toEqual({ state: "waiting", until: "call_ends" });
    expect(reloadNotice(client.getState().reload)).toBe("Your saved changes apply when this call ends.");
    expect(reloadNotice({ state: "waiting", until: "reply_ends" })).toBe("Your saved changes apply after this reply.");
    expect(reloadNotice({ state: "reloading" })).toBe("Reloading your agent with the saved changes…");
    expect(reloadNotice(null)).toBeNull();
    client.dispose();
  });
});
