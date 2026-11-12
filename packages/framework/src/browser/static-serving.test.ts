import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { relayAllowed, relayTarget, staticFile } from "./static-serving.js";

const at = (target: string) => new URL(target, "http://localhost");

describe("relayTarget", () => {
  it("forwards the chat route the browser runtime calls", () => {
    expect(relayTarget(at("/kugel/v1/chat/completions"), "http")).toBe("https://api.eu.kugelaudio.com/v1/chat/completions");
  });

  it("forwards the speech sockets with their query", () => {
    expect(relayTarget(at("/kugel/ws/tts/multi?api_key=k"), "socket")).toBe("wss://api.eu.kugelaudio.com/ws/tts/multi?api_key=k");
    expect(relayTarget(at("/kugel/v1/audio/transcriptions/stream"), "socket")).toBe(
      "wss://api.eu.kugelaudio.com/v1/audio/transcriptions/stream",
    );
  });

  it.each(["/kugel/v1/models", "/kugel//evil.example/x", "/kugel/@evil.example/x", "/kugel/%2F%2Fevil.example", "/kugel/v1/chat/completions/../../admin", "/index.html"])(
    "forwards nothing for %s",
    (path) => {
      expect(relayTarget(at(path), "http")).toBeNull();
      expect(relayTarget(at(path), "socket")).toBeNull();
    },
  );

  it("forwards a socket route only as a socket, and the chat route only over HTTP", () => {
    expect(relayTarget(at("/kugel/ws/tts/multi"), "http")).toBeNull();
    expect(relayTarget(at("/kugel/v1/chat/completions"), "socket")).toBeNull();
  });
});

describe("staticFile", () => {
  const root = resolve("/srv/built");

  it("names the file under the root", () => {
    expect(staticFile(root, "/runtime/page.js")).toBe(join(root, "runtime", "page.js"));
    expect(staticFile(root, "/")).toBe(root);
  });

  it.each(["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd", "/..%5c..%5cwindows", "/a/%00", "/%E0%A4%A"])(
    "names no file outside the root for %s",
    (path) => {
      const file = staticFile(root, path);
      expect(file === null || file === root || file.startsWith(root + (root.includes("\\") ? "\\" : "/"))).toBe(true);
    },
  );

  it("refuses an encoded parent directory instead of serving from the root's parent", () => {
    expect(staticFile(root, "/..%2fsecret")).toBeNull();
  });
});

describe("relayAllowed", () => {
  it("lets the page it serves use the relay", () => {
    expect(relayAllowed({ host: "127.0.0.1:4630" })).toBe(true);
    expect(relayAllowed({ host: "localhost:4630", origin: "http://localhost:4630", "sec-fetch-site": "same-origin" })).toBe(true);
  });

  it("refuses another site's request, which would spend the developer's key", () => {
    expect(relayAllowed({ host: "127.0.0.1:4630", origin: "https://evil.example" })).toBe(false);
    expect(relayAllowed({ host: "127.0.0.1:4630", "sec-fetch-site": "cross-site" })).toBe(false);
  });

  it("refuses a DNS-rebinding name pointed at the loopback", () => {
    expect(relayAllowed({ host: "rebind.evil.example:4630", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(relayAllowed({})).toBe(false);
  });
});
