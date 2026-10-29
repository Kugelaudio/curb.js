import { afterEach, describe, expect, it, vi } from "vitest";
import { pageInfoFromQuery, refusedPageInfoNotice } from "./page-info.js";
import { DemoWsClient } from "./ws-client.js";

describe("pageInfoFromQuery", () => {
  it("takes client.* from the preview's URL and leaves every other parameter alone", () => {
    expect(pageInfoFromQuery("?client.event=webinar-11-04&client.utm_source=newsletter&debug=1")).toEqual({
      info: { "client.event": "webinar-11-04", "client.utm_source": "newsletter" },
      refused: [],
    });
    expect(pageInfoFromQuery("")).toEqual({ info: {}, refused: [] });
  });

  it("refuses entries outside the limits, each with its reason, and sends the rest", () => {
    const { info, refused } = pageInfoFromQuery(`?client.event=ok&client.bad-key=x&client.long=${"y".repeat(257)}`);
    expect(info).toEqual({ "client.event": "ok" });
    expect(refused).toEqual([
      '"bad-key" cannot name page info (client.<key>): use a letter, then up to 39 letters, digits or underscores.',
      "client.long is 257 characters long; page info values hold at most 256.",
    ]);
    expect(refusedPageInfoNotice(refused)).toBe(`Not sent from the page URL: ${refused.join(" ")}`);
    expect(refusedPageInfoNotice([])).toBeNull();
  });
});

/** A WebSocket stand-in that opens at once and keeps what was sent. */
class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  send(frame: string) {
    this.sent.push(JSON.parse(frame));
  }
  close() {
    this.onclose?.();
  }
}

describe("DemoWsClient with page info", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.sockets = [];
  });

  it("sends the page's info as set_info on every connection, before anything else", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new DemoWsClient("ws://127.0.0.1:4000", { "client.event": "webinar-11-04" });
    client.connect();
    const socket = FakeSocket.sockets[0]!;
    socket.open();

    expect(socket.sent).toEqual([{ type: "set_info", values: { "client.event": "webinar-11-04" } }]);
    client.dispose();
  });

  it("sends nothing when the page has no info", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new DemoWsClient("ws://127.0.0.1:4000");
    client.connect();
    FakeSocket.sockets[0]!.open();

    expect(FakeSocket.sockets[0]!.sent).toEqual([]);
    client.dispose();
  });
});
