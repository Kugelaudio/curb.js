import { describe, expect, it } from "vitest";
import { sessionOf, sessionSettings, signedIn, signInFor } from "./session.js";

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

function metas(values: Record<string, string>): Pick<Document, "querySelector"> {
  return {
    querySelector: ((selector: string) => {
      const name = /name="([^"]+)"/.exec(selector)?.[1] ?? "";
      return name in values ? { content: values[name] } : null;
    }) as Document["querySelector"],
  };
}

describe("session pages", () => {
  it("reads the build's settings, none without a sessions prefix", () => {
    expect(sessionSettings(metas({}))).toBeNull();
    expect(sessionSettings(metas({ "curb-sessions": "/agents/session/" }))).toEqual({ prefix: "/agents/session/", signIn: null });
    expect(sessionSettings(metas({ "curb-sessions": "/s/", "curb-sign-in": "https://www.example.com{session}" }))).toEqual({
      prefix: "/s/",
      signIn: "https://www.example.com{session}",
    });
  });

  it("finds the session a path is in", () => {
    expect(sessionOf("/agents/session/a1", "/agents/session/")).toBe("/agents/session/a1");
    expect(sessionOf("/agents/session/a1/skill/claims", "/agents/session/")).toBe("/agents/session/a1");
    expect(sessionOf("/agents/session/", "/agents/session/")).toBeNull();
    expect(sessionOf("/", "/agents/session/")).toBeNull();
    expect(sessionOf("/graph", "/agents/session/")).toBeNull();
  });

  it("signs in once a minute at most, again at once after the platform took a link", () => {
    const storage = memoryStorage();
    const settings = { prefix: "/agents/session/", signIn: "https://www.example.com{session}" };
    const session = "/agents/session/a1";
    expect(signInFor(settings, session, storage, 1_000)).toBe("https://www.example.com/agents/session/a1");
    expect(signInFor(settings, session, storage, 30_000)).toBeNull();
    expect(signInFor(settings, "/agents/session/a2", storage, 30_000)).toBe("https://www.example.com/agents/session/a2");
    expect(signInFor(settings, session, storage, 62_000)).toBe("https://www.example.com/agents/session/a1");
    signedIn(session, storage);
    expect(signInFor(settings, session, storage, 63_000)).toBe("https://www.example.com/agents/session/a1");
    expect(signInFor({ ...settings, signIn: null }, "/agents/session/a3", storage)).toBeNull();
  });
});
