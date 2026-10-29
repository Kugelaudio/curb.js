import { describe, expect, it } from "vitest";
import { embeddedBrowserName, microphoneDenied, microphoneWarning } from "./microphone-access.js";

describe("microphone access before a call", () => {
  it("knows the Claude app and other Electron browsers, and no regular browser", () => {
    expect(embeddedBrowserName("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Claude/1.0.85 Chrome/138 Electron/37.2.0 Safari/537.36")).toBe("the Claude app");
    expect(embeddedBrowserName("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/138 Electron/37.2.0 Safari/537.36")).toBe("this app");
    expect(embeddedBrowserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toBeNull();
  });

  it("reads a blocked microphone from the Permissions API, and treats no answer as not blocked", async () => {
    const answering = (state: string) => ({ query: async () => ({ state }) }) as unknown as Permissions;
    expect(await microphoneDenied(answering("denied"))).toBe(true);
    expect(await microphoneDenied(answering("prompt"))).toBe(false);
    expect(await microphoneDenied({ query: async () => { throw new TypeError("microphone"); } } as unknown as Permissions)).toBe(false);
    expect(await microphoneDenied(undefined)).toBe(false);
  });

  it("warns with the page to open elsewhere in an app's browser, and how to allow it when blocked", () => {
    expect(microphoneWarning({ embedded: "the Claude app", denied: true, pageUrl: "http://127.0.0.1:4000" })).toBe(
      "The browser in the Claude app cannot use your microphone. To call your agent, open http://127.0.0.1:4000 in Chrome or Safari; typing works here.",
    );
    expect(microphoneWarning({ embedded: null, denied: true, pageUrl: "x" })).toMatch(/^This browser blocked the microphone/);
    expect(microphoneWarning({ embedded: null, denied: false, pageUrl: "x" })).toBeNull();
  });
});
