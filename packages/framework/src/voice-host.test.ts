import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuthoringError } from "./authoring.js";
import { createPreviewAgentBundle, createVoiceAgentBundle } from "./voice-host.js";

/**
 * The fixture project's agent sets no `llm`, so it runs on the default, `kugelaudio.llm()`. Every
 * place a session starts (the dev server, a hosted runner, a direct join) builds it here.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createVoiceAgentBundle", () => {
  it("refuses to start a session whose LLM key is missing, naming the variable", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "");

    const started = createVoiceAgentBundle();

    await expect(started).rejects.toBeInstanceOf(AgentAuthoringError);
    await expect(started).rejects.toThrow(/KUGELAUDIO_API_KEY/);
  });

  it("builds curb dev's preview bundle without the key, naming the key it lacks", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "");

    const { runtime, missingLlmKey } = await createPreviewAgentBundle();

    // The context renders from source with no model: what the preview's Context column shows.
    expect(runtime.snapshot().context.systemPrompt).toBeTruthy();
    expect(missingLlmKey).toMatchObject({ code: "AGENT_INVALID_AUTHORING_PROP", severity: "error" });
    expect(missingLlmKey?.message).toMatch(/needs KUGELAUDIO_API_KEY/);
    expect(missingLlmKey?.fix).toMatch(/Run `npx curb login`.*restart `curb dev`.*Or set KUGELAUDIO_API_KEY.*A hosted agent gets it from the platform/);
  });

  it("names no missing key in the preview bundle when the key is there", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-kugel-key");

    expect((await createPreviewAgentBundle()).missingLlmKey).toBeNull();
  });

  it("starts when the key is there", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-kugel-key");

    const { session, agentId } = await createVoiceAgentBundle();

    expect(agentId).toBe("agent");
    expect(session.isRunning).toBe(false);
  });
});
