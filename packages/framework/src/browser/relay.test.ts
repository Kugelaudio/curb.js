import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLink, forgetLink, linkFromFragment, Relay, type RelayState } from "./relay.js";
import { ToolError } from "./tools.js";

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("relay link", () => {
  it("reads the platform's fragment and keeps it for its place, out of the address bar", () => {
    const storage = memoryStorage();
    const replaced: string[] = [];
    const session = "/agents/session/a1";
    const link = currentLink(
      { hash: "#project=p1&token=t1&api=https://api.example.com/x", pathname: session, search: "?a=1" },
      storage,
      session,
      { replaceState: (_s, _t, url) => void replaced.push(String(url)) },
    );
    expect(link).toEqual({ project: "p1", token: "t1", api: "https://api.example.com" });
    expect(replaced).toEqual([`${session}?a=1`]);
    const later = { hash: "", pathname: session, search: "" };
    expect(currentLink(later, storage, session)).toEqual(link);
    expect(currentLink({ hash: "", pathname: "/", search: "" }, storage, "/")).toBeNull();
    expect(currentLink({ hash: "", pathname: "/agents/session/a2", search: "" }, storage, "/agents/session/a2")).toBeNull();
    forgetLink(session, storage);
    expect(currentLink(later, storage, session)).toBeNull();
    expect(linkFromFragment("#project=p1")).toBeNull();
  });
});

describe("relay socket", () => {
  const link = { project: "p1", token: "t1", api: "https://api.example.com" };

  it("says hello, then answers calls with the tool's result or its error", async () => {
    const states: RelayState[] = [];
    const relay = new Relay(
      link,
      {
        read_file: async (input) => ({ path: input.path, content: "x" }),
        write_file: async () => {
          throw new ToolError("path_refused", "no");
        },
      },
      { WebSocket: FakeSocket as unknown as typeof WebSocket, onState: (state) => void states.push(state) },
    );
    relay.agentStatus("serving");
    relay.start();
    const socket = FakeSocket.last!;
    expect(socket.url).toBe("wss://api.example.com/v1/agents/browser/socket");
    socket.open();
    expect(socket.sent).toEqual([{ type: "hello", project: "p1", token: "t1" }]);
    socket.receive({ type: "ready", project: null });
    expect(socket.sent.at(-1)).toEqual({ type: "status", agent: { state: "serving" } });
    socket.receive({ type: "call", id: "c1", tool: "read_file", input: { path: "a.ts" } });
    socket.receive({ type: "call", id: "c2", tool: "write_file", input: {} });
    socket.receive({ type: "call", id: "c3", tool: "run_command", input: {} });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect(socket.sent.slice(2)).toEqual(
      expect.arrayContaining([
        { type: "reply", id: "c1", ok: true, result: { path: "a.ts", content: "x" } },
        { type: "reply", id: "c2", ok: false, error: { code: "path_refused", message: "no" } },
        { type: "reply", id: "c3", ok: false, error: { code: "tool_unknown", message: 'This tab has no tool "run_command".' } },
      ]),
    );
    expect(states.map((state) => state.kind)).toEqual(["connecting", "connected"]);
  });

  it("loads the platform's project before it answers a call", async () => {
    let loaded!: () => void;
    const projects: unknown[] = [];
    const relay = new Relay(
      link,
      { read_file: async () => ({ content: "x" }) },
      {
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        onProject: (files) => {
          projects.push(files);
          return new Promise<void>((resolve) => (loaded = resolve));
        },
      },
    );
    relay.start();
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "ready", project: { files: [{ path: "a.ts", text: "x" }, { path: "vendor/curb.tgz", size: 3 }] } });
    socket.receive({ type: "call", id: "c1", tool: "read_file", input: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(projects).toEqual([[{ path: "a.ts", text: "x" }, { path: "vendor/curb.tgz", size: 3 }]]);
    expect(socket.sent.filter((frame) => frame.type === "reply")).toEqual([]);
    loaded();
    await vi.waitFor(() => expect(socket.sent.at(-1)).toEqual({ type: "reply", id: "c1", ok: true, result: { content: "x" } }));
  });

  it("refuses a ready frame without a project", () => {
    const closed: number[] = [];
    const relay = new Relay(link, {}, { WebSocket: FakeSocket as unknown as typeof WebSocket });
    relay.start();
    const socket = FakeSocket.last!;
    socket.close = (code?: number) => void closed.push(code ?? 0);
    socket.open();
    socket.receive({ type: "ready" });
    expect(closed).toEqual([1002]);
  });

  it("saves a change and settles on the platform's answer", async () => {
    const relay = new Relay(link, {}, { WebSocket: FakeSocket as unknown as typeof WebSocket, onProject: async () => {} });
    await expect(relay.save({ writes: [], deletes: ["a.ts"] })).rejects.toMatchObject({ code: "not_connected" });
    relay.start();
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "ready", project: null });

    const first = relay.save({ writes: [{ path: "a.ts", text: "x" }], deletes: [] });
    expect(socket.sent.at(-1)).toEqual({ type: "save", id: "s1", writes: [{ path: "a.ts", text: "x" }], deletes: [] });
    socket.receive({ type: "saved", id: "s1" });
    await expect(first).resolves.toBeUndefined();

    const second = relay.save({ writes: [], deletes: ["a.ts"] });
    socket.receive({ type: "save_failed", id: "s2", error: { code: "browser_project_too_large", message: "too big" } });
    await expect(second).rejects.toMatchObject({ code: "browser_project_too_large" });

    const third = relay.save({ writes: [], deletes: ["b.ts"] });
    socket.onclose?.({ code: 1006 });
    await expect(third).rejects.toMatchObject({ code: "not_connected" });
    relay.stop();
  });

  it("stops on a refused or replaced link and reconnects after anything else", () => {
    vi.useFakeTimers();
    const states: RelayState[] = [];
    const relay = new Relay(link, {}, { WebSocket: FakeSocket as unknown as typeof WebSocket, onState: (state) => void states.push(state) });
    relay.start();
    const first = FakeSocket.last!;
    first.onclose?.({ code: 1006 });
    expect(states.at(-1)).toEqual({ kind: "retrying", inMs: 500 });
    vi.advanceTimersByTime(500);
    const second = FakeSocket.last!;
    expect(second).not.toBe(first);
    second.onclose?.({ code: 4401 });
    expect(states.at(-1)).toEqual({ kind: "refused" });
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.last).toBe(second);
  });
});
