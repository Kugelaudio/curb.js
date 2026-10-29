import { describe, expect, it, vi } from "vitest";
import { embedderOrigin, OPEN_SIGN_IN, openSignIn, SIGN_IN_ANSWER_MS, SIGN_IN_SHOWN } from "./open-sign-in.js";

const AUTH = "https://mcp.example.com/authorize?state=s";
const EDITOR = "https://www.kugelaudio.com";

/** A window that is framed (or not), with a parent that records what it was sent. */
function fakeWindow({ framed = true, hash = `#curb-embedder=${encodeURIComponent(EDITOR)}` } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const timers: (() => void)[] = [];
  const parent = { postMessage: vi.fn() };
  const win = {
    open: vi.fn(),
    location: { hash },
    addEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
    setTimeout: (run: () => void, ms: number) => {
      expect(ms).toBe(SIGN_IN_ANSWER_MS);
      timers.push(run);
      return 0;
    },
  } as unknown as Parameters<typeof openSignIn>[1] & { open: ReturnType<typeof vi.fn> };
  (win as { parent: unknown }).parent = framed ? parent : win;
  return {
    win,
    parent,
    deliver: (event: Partial<MessageEvent>) => listeners.forEach((listener) => listener(event as MessageEvent)),
    elapse: () => timers.splice(0).forEach((run) => run()),
  };
}

describe("openSignIn", () => {
  it("opens the window itself when the preview is not framed", () => {
    const { win, parent } = fakeWindow({ framed: false });
    openSignIn(AUTH, win);
    expect(win.open).toHaveBeenCalledWith(AUTH, "_blank", "noopener,width=560,height=720");
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("asks only the origin the framing page named, and opens nothing when it answers", () => {
    const { win, parent, deliver, elapse } = fakeWindow();
    openSignIn(AUTH, win);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: OPEN_SIGN_IN, url: AUTH }, EDITOR);
    deliver({ source: parent as unknown as Window, origin: EDITOR, data: { type: SIGN_IN_SHOWN, url: AUTH } });
    elapse();
    expect(win.open).not.toHaveBeenCalled();
  });

  it("opens the window itself when the parent does not answer, or another origin does", () => {
    const { win, parent, deliver, elapse } = fakeWindow();
    openSignIn(AUTH, win);
    deliver({ source: parent as unknown as Window, origin: "https://evil.example", data: { type: SIGN_IN_SHOWN, url: AUTH } });
    deliver({ source: parent as unknown as Window, origin: EDITOR, data: { type: SIGN_IN_SHOWN, url: "https://other" } });
    elapse();
    expect(win.open).toHaveBeenCalledWith(AUTH, "_blank", "noopener,width=560,height=720");
  });
});

describe("embedderOrigin", () => {
  it.each([
    ["", null],
    ["#curb-embedder=", null],
    [`#curb-embedder=${encodeURIComponent(`${EDITOR}/path`)}`, null],
    ["#curb-embedder=javascript%3Aalert(1)", null],
    ["#curb-embedder=*", null],
    [`#curb-embedder=${encodeURIComponent(EDITOR)}`, EDITOR],
    ["#curb-embedder=http%3A%2F%2Flocalhost%3A3000", "http://localhost:3000"],
  ])("reads %j as %j", (hash, origin) => {
    expect(embedderOrigin(fakeWindow({ hash }).win)).toBe(origin);
  });

  it("is null for a page that is not framed, whatever its fragment says", () => {
    expect(embedderOrigin(fakeWindow({ framed: false }).win)).toBeNull();
  });
});
