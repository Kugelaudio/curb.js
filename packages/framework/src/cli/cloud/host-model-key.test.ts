import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_KEY_MARKER,
  HOST_KEY_REFRESH_MS,
  keepHostModelKeyFresh,
  readHostModelKey,
  runsOnHostKey,
  useHostModelKey,
} from "./host-model-key.js";
import { PLATFORM_TOKEN_FILE_ENV } from "./platform-token.js";

let dir: string;
let path: string;

function write(fields: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ token: "kws_a", expiresAt: "2026-10-27T19:00:00Z", ...fields }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curb-host-key-"));
  path = join(dir, "token.json");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("readHostModelKey", () => {
  it("is none without a host file, or when the host supplies no key", () => {
    expect(readHostModelKey({})).toEqual({ kind: "none" });
    write({});
    expect(readHostModelKey({ [PLATFORM_TOKEN_FILE_ENV]: path })).toEqual({ kind: "none" });
  });

  it("is pending while the host has not written the file", () => {
    expect(readHostModelKey({ [PLATFORM_TOKEN_FILE_ENV]: path })).toEqual({ kind: "pending", path });
  });

  it("refuses a file that is not JSON", () => {
    writeFileSync(path, "{");
    expect(() => readHostModelKey({ [PLATFORM_TOKEN_FILE_ENV]: path })).toThrow(/is not JSON/);
  });

  it("reads the key and the base", () => {
    write({ kugelaudioApiKey: "sk-kug-proj_a", kugelaudioApiBase: "https://models.example" });
    expect(readHostModelKey({ [PLATFORM_TOKEN_FILE_ENV]: path })).toEqual({
      kind: "key",
      apiKey: "sk-kug-proj_a",
      apiBase: "https://models.example",
    });
  });
});

describe("useHostModelKey", () => {
  it("sets the key and the base when the user set neither", () => {
    write({ kugelaudioApiKey: "sk-kug-proj_a", kugelaudioApiBase: "https://models.example" });
    const env: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path };
    useHostModelKey(env);
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_a");
    expect(env.KUGELAUDIO_API_BASE).toBe("https://models.example");
    expect(runsOnHostKey(env)).toBe(true);
  });

  it("never replaces a key or a base the user set", () => {
    write({ kugelaudioApiKey: "sk-kug-proj_a", kugelaudioApiBase: "https://models.example" });
    const env: NodeJS.ProcessEnv = {
      [PLATFORM_TOKEN_FILE_ENV]: path,
      KUGELAUDIO_API_KEY: "sk-kug-proj_mine",
      KUGELAUDIO_API_BASE: "https://mine.example",
    };
    expect(useHostModelKey(env)).toEqual({ kind: "none" });
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_mine");
    expect(env[HOST_KEY_MARKER]).toBeUndefined();

    const baseOnly: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path, KUGELAUDIO_API_BASE: "https://mine.example" };
    useHostModelKey(baseOnly);
    expect(baseOnly.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_a");
    expect(baseOnly.KUGELAUDIO_API_BASE).toBe("https://mine.example");
  });
});

describe("keepHostModelKeyFresh", () => {
  it("moves a running process onto the renewed key, and onto the first one once it arrives", () => {
    vi.useFakeTimers();
    const env: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path };
    expect(useHostModelKey(env).kind).toBe("pending");
    const stop = keepHostModelKeyFresh(env, () => {});

    write({ kugelaudioApiKey: "sk-kug-proj_first" });
    vi.advanceTimersByTime(HOST_KEY_REFRESH_MS);
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_first");

    write({ kugelaudioApiKey: "sk-kug-proj_renewed" });
    vi.advanceTimersByTime(HOST_KEY_REFRESH_MS);
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_renewed");
    stop();
  });

  it("reports an unusable file once and keeps the last key", () => {
    vi.useFakeTimers();
    write({ kugelaudioApiKey: "sk-kug-proj_first" });
    const env: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path };
    useHostModelKey(env);
    const warnings: string[] = [];
    const stop = keepHostModelKeyFresh(env, (message) => warnings.push(message));
    writeFileSync(path, "{");
    vi.advanceTimersByTime(3 * HOST_KEY_REFRESH_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/was not renewed/);
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_first");
    stop();
  });

  it("leaves a key the user set alone", () => {
    vi.useFakeTimers();
    write({ kugelaudioApiKey: "sk-kug-proj_host" });
    const env: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path, KUGELAUDIO_API_KEY: "sk-kug-proj_mine" };
    const stop = keepHostModelKeyFresh(env, () => {});
    vi.advanceTimersByTime(HOST_KEY_REFRESH_MS);
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-kug-proj_mine");
    stop();
  });
});

// The preview's voice call (curb dev's agent server) builds STT and TTS from the live
// environment per call and resolves the LLM per turn: both move onto a renewed key.
describe("the kugelaudio providers on the host's key", () => {
  it("read the renewed key and base for the LLM, STT and TTS", async () => {
    vi.useFakeTimers();
    const { resolveLlmProvider } = await import("../../llm/provider.js");
    const { SPEECH_KEYS } = await import("../../provider-keys.js");
    const { kugelaudio } = await import("../../providers.js");
    write({ kugelaudioApiKey: "sk-kug-proj_first", kugelaudioApiBase: "https://models.example" });
    const env: NodeJS.ProcessEnv = { [PLATFORM_TOKEN_FILE_ENV]: path };
    useHostModelKey(env);
    const stop = keepHostModelKeyFresh(env, () => {});
    expect(resolveLlmProvider(kugelaudio.llm(), env)).toMatchObject({
      kind: "kugelaudio",
      apiKey: "sk-kug-proj_first",
      baseUrl: "https://models.example/v1",
    });

    write({ kugelaudioApiKey: "sk-kug-proj_renewed", kugelaudioApiBase: "https://models.example" });
    vi.advanceTimersByTime(HOST_KEY_REFRESH_MS);
    expect(resolveLlmProvider(kugelaudio.llm(), env)).toMatchObject({ apiKey: "sk-kug-proj_renewed" });
    expect(SPEECH_KEYS.kugelaudio.key.read(env)).toBe("sk-kug-proj_renewed");
    stop();
  });
});
