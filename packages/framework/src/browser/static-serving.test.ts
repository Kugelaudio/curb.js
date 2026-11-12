import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { relayAllowed, relayTarget, staticFile } from "./static-serving.js";

const at = (target: string) => new URL(target, "http://localhost");

describe("relayTarget", () => {
  it("forwards a relay path and its query to the API", () => {
    expect(relayTarget(at("/kugel/v1/models?x=1"), "https")).toBe("https://api.eu.kugelaudio.com/v1/models?x=1");
    expect(relayTarget(at("/kugel/ws/tts?api_key=k"), "wss")).toBe("wss://api.eu.kugelaudio.com/ws/tts?api_key=k");
  });

  it.each(["/kugel//evil.example/x", "/kugel/@evil.example/x", "/kugel/%2F%2Fevil.example", "/kugel/..%2F..%2Fx"])(
    "keeps %s on the API's origin",
    (path) => {
      const target = relayTarget(at(path), "https");
      expect(target === null || new URL(target).origin === "https://api.eu.kugelaudio.com").toBe(true);
    },
  );

  it("is null for a path outside the relay", () => {
    expect(relayTarget(at("/index.html"), "https")).toBeNull();
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
