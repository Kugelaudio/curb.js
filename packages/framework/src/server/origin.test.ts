import { describe, expect, it } from "vitest";
import { isAllowedOrigin, LOCAL_ORIGIN_HOSTS } from "./origin.js";

describe("isAllowedOrigin", () => {
  it("allows a client that sent no Origin header (a native client)", () => {
    expect(isAllowedOrigin(undefined, LOCAL_ORIGIN_HOSTS)).toBe(true);
  });

  it("allows every loopback host on any port", () => {
    for (const origin of [
      "http://localhost:4000",
      "https://localhost:4000",
      "http://127.0.0.1:4000",
      "http://[::1]:4000",
    ]) {
      expect(isAllowedOrigin(origin, LOCAL_ORIGIN_HOSTS), origin).toBe(true);
    }
  });

  it("allows an extra host the server was told to serve", () => {
    const allowed = new Set([...LOCAL_ORIGIN_HOSTS, "mybox.local"]);
    expect(isAllowedOrigin("http://mybox.local:4000", allowed)).toBe(true);
  });

  it("refuses a foreign origin", () => {
    for (const origin of [
      "https://evil.example",
      "http://evil.example:4000",
      "http://127.0.0.1.evil.example",
      "file://localhost",
      "ftp://localhost",
      "http://localhost/path",
      "http://user@localhost",
    ]) {
      expect(isAllowedOrigin(origin, LOCAL_ORIGIN_HOSTS), origin).toBe(false);
    }
  });

  it("refuses a null origin, which is what a sandboxed page sends", () => {
    expect(isAllowedOrigin("null", LOCAL_ORIGIN_HOSTS)).toBe(false);
  });
});
