import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOAuthProvider } from "./oauth-store.js";

const CALLBACK = "http://127.0.0.1:8787/oauth/callback";

describe("FileOAuthProvider", () => {
  let dir: string;

  function makeProvider(onAuthUrl: (url: URL) => void = () => undefined) {
    dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
    return new FileOAuthProvider("linear-remote", dir, CALLBACK, onAuthUrl);
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists tokens and client info across provider instances", () => {
    const provider = makeProvider();
    expect(provider.tokens()).toBeUndefined();

    provider.saveClientInformation({ client_id: "abc123" });
    provider.saveTokens({ access_token: "tok", token_type: "Bearer", refresh_token: "ref" });
    provider.saveCodeVerifier("verifier-xyz");

    const reloaded = new FileOAuthProvider("linear-remote", dir, CALLBACK, () => undefined);
    expect(reloaded.clientInformation()).toEqual({ client_id: "abc123" });
    expect(reloaded.tokens()).toMatchObject({ access_token: "tok", refresh_token: "ref" });
    expect(reloaded.codeVerifier()).toBe("verifier-xyz");
    // Stored as plain JSON in the auth dir, one file per server.
    expect(readFileSync(join(dir, "linear-remote.json"), "utf8")).toContain("abc123");
  });

  it("routes the authorization URL to the host callback instead of opening a browser", () => {
    const urls: string[] = [];
    const provider = makeProvider((url) => urls.push(url.toString()));

    provider.redirectToAuthorization(new URL("https://linear.app/oauth/authorize?x=1"));
    expect(urls).toEqual(["https://linear.app/oauth/authorize?x=1"]);
  });

  it("embeds the server id in the OAuth state and validates it single-use", () => {
    const provider = makeProvider();
    const state = provider.state();
    expect(state.startsWith("linear-remote.")).toBe(true);

    // Forged or replayed states are rejected; the real one works exactly once.
    expect(provider.consumeState("linear-remote.forged-nonce")).toBe(false);
    expect(provider.consumeState(state)).toBe(true);
    expect(provider.consumeState(state)).toBe(false);
  });

  it("invalidates credentials by scope", () => {
    const provider = makeProvider();
    provider.saveClientInformation({ client_id: "abc123" });
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" });

    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "abc123" });

    provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
    expect(new FileOAuthProvider("linear-remote", dir, CALLBACK, () => undefined).tokens()).toBeUndefined();
  });

  it("throws when asked for a code verifier that was never stored", () => {
    const provider = makeProvider();
    expect(() => provider.codeVerifier()).toThrow(/No PKCE code verifier/);
  });
});
