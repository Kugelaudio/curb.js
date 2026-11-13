import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kugelaudio } from "../providers.js";
import { checkProject } from "./check.js";
import { createTestProject } from "./test-project.js";
import { startFakeCloud, type FakeCloud } from "./cloud/fake-cloud.test-support.js";
import { diagnoseVoices, findVoice, formatVoices, listVoices, voicesCommand, type Voice } from "./voices.js";

const voice = (id: number, overrides: Partial<Voice> = {}): Voice => ({
  id,
  name: `Voice ${id}`,
  sex: "male",
  age: "young",
  category: "conversational",
  supported_languages: ["en-US"],
  description: "Calm and clear.",
  ...overrides,
});

describe("the KugelAudio voice list, against a stub speech API", () => {
  let cloud: FakeCloud;
  let api: { apiBase: string; apiKey: string };

  beforeEach(async () => {
    cloud = await startFakeCloud();
    api = { apiBase: cloud.url, apiKey: "sk-test" };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cloud.close();
  });

  it("reads every page at the largest size the API accepts, with the language and the project's key", async () => {
    const all = Array.from({ length: 130 }, (_, index) => voice(index + 1));
    cloud.route("GET /v1/voices", (request) => {
      const offset = Number(request.query.get("offset"));
      const limit = Number(request.query.get("limit"));
      return { body: { voices: all.slice(offset, offset + limit), total: all.length, limit, offset } };
    });

    const voices = await listVoices(api, "en");

    expect(voices.map((v) => v.id)).toEqual(all.map((v) => v.id));
    expect(cloud.requests.map((request) => request.query.toString())).toEqual([
      "limit=100&offset=0&language=en",
      "limit=100&offset=100&language=en",
    ]);
    expect(cloud.requests[0]!.headers.authorization).toBe("Bearer sk-test");
  });

  it("finds a voice by id, and answers null for one the API does not have", async () => {
    cloud.route("GET /v1/voices/2352", { body: voice(2352) });
    cloud.route("GET /v1/voices/999999", { status: 404, body: { error: "Voice not found", error_code: "NOT_FOUND", code: 404 } });

    expect((await findVoice(api, 2352))?.name).toBe("Voice 2352");
    expect(await findVoice(api, 999999)).toBeNull();
  });

  it("says how to fix a refused key instead of a bare 401", async () => {
    cloud.route("GET /v1/voices", { status: 401, body: { error: "Invalid API key", code: 401 } });

    await expect(listVoices(api)).rejects.toThrow(/Run `npx curb login` again, or replace KUGELAUDIO_API_KEY/);
  });

  it("curb voices prints one line per voice and how to use one", async () => {
    cloud.route("GET /v1/voices", { body: { voices: [voice(7, { name: "Mike" })], total: 1 } });
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));

    const code = await voicesCommand(["--language", "en"], { KUGELAUDIO_API_KEY: "sk-test", KUGELAUDIO_API_BASE: cloud.url });

    expect(code).toBe(0);
    expect(printed).toEqual([
      "7  Mike  (male, young, conversational, en-US)  Calm and clear.",
      '1 voice(s). Use one with tts={kugelaudio.tts({ voice: <id>, language: "<code>" })}.',
    ]);
  });

  it("curb voices --json prints the list as one JSON array", async () => {
    cloud.route("GET /v1/voices", { body: { voices: [voice(7)], total: 1 } });
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));

    await voicesCommand(["--json"], { KUGELAUDIO_API_KEY: "sk-test", KUGELAUDIO_API_BASE: cloud.url });

    expect(JSON.parse(printed.join(""))).toEqual([voice(7)]);
  });

  it("curb voices without KugelAudio access says how to sign in, and calls nothing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));

    const code = await voicesCommand([], { KUGELAUDIO_API_BASE: cloud.url });

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Run `npx curb login`/);
    expect(cloud.requests).toEqual([]);
  });

  it("curb voices refuses an option it does not take", async () => {
    await expect(voicesCommand(["--lang", "en"], { KUGELAUDIO_API_KEY: "sk-test" })).rejects.toThrow(
      /curb voices has no option "--lang"/,
    );
  });

  it("formats an empty list as a line, not as nothing", () => {
    expect(formatVoices([])).toEqual(["No voices found."]);
  });
});

describe("curb check's voice lookup", () => {
  const env = { KUGELAUDIO_API_KEY: "sk-test" };
  const base = { agentId: "agent", agentSource: "src/agent/agent.tsx" };

  it("is an AGENT_VOICE_NOT_FOUND error, naming curb voices, at each <Agent> or <Skill> link that sets an unknown id", async () => {
    const find = vi.fn(async (_api: unknown, id: number) => (id === 2352 ? voice(2352) : null));

    const { diagnostics, notes } = await diagnoseVoices({
      ...base,
      env,
      find,
      uses: [
        { where: "", tts: kugelaudio.tts({ voice: 999999 }) },
        // No tts of its own: it speaks with the agent's voice, reported once at the agent.
        { where: "/faq", tts: kugelaudio.tts({ voice: 999999 }) },
        { where: "/orders", tts: kugelaudio.tts({ voice: 888 }) },
        { where: "/returns", tts: kugelaudio.tts({ voice: 888 }) },
        { where: "/billing", tts: kugelaudio.tts({ voice: 2352 }) },
      ],
    });

    // One lookup per voice id, however many places use it.
    expect(find.mock.calls.map(([, id]) => id)).toEqual([999999, 888, 2352]);
    expect(notes).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.location)).toEqual([
      { agentId: "agent", source: "src/agent/agent.tsx", component: "Agent" },
      { agentId: "agent", skillPath: "/orders", component: 'Skill path="/orders"' },
      { agentId: "agent", skillPath: "/returns", component: 'Skill path="/returns"' },
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.code === "AGENT_VOICE_NOT_FOUND" && diagnostic.severity === "error")).toBe(true);
    expect(diagnostics[0]!.message).toMatch(/voice: 999999 \}\) \(the agent\)/);
    expect(diagnostics[1]!.message).toMatch(/voice: 888 \}\) \(skill \/orders\)/);
    expect(diagnostics[0]!.fix).toMatch(/npx curb voices --language <code>/);
  });

  it("asks all ids at once, so the slowest lookup bounds the wait", async () => {
    let inFlight = 0;
    let most = 0;
    const find = vi.fn(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return voice(1);
    });

    await diagnoseVoices({
      ...base,
      env,
      find,
      uses: [
        { where: "", tts: kugelaudio.tts({ voice: 1 }) },
        { where: "/a", tts: kugelaudio.tts({ voice: 2 }) },
        { where: "/b", tts: kugelaudio.tts({ voice: 3 }) },
      ],
    });

    expect(most).toBe(3);
  });

  it("looks nothing up for the default voice, another provider, or without KugelAudio access", async () => {
    const find = vi.fn(async () => null);

    const withDefaults = await diagnoseVoices({
      ...base,
      env,
      find,
      uses: [{ where: "", tts: kugelaudio.tts({ language: "de" }) }, { where: "/x", tts: { provider: "elevenlabs" } }],
    });
    const signedOut = await diagnoseVoices({ ...base, env: {}, find, uses: [{ where: "", tts: kugelaudio.tts({ voice: 1 }) }] });

    expect(withDefaults).toEqual({ diagnostics: [], notes: [] });
    expect(signedOut).toEqual({ diagnostics: [], notes: [] });
    expect(find).not.toHaveBeenCalled();
  });

  it("is a note, never an error, when the lookup gets no answer", async () => {
    const find = vi.fn(async () => {
      throw new Error("Could not reach https://api.kugelaudio.com: getaddrinfo ENOTFOUND");
    });

    const result = await diagnoseVoices({ ...base, env, find, uses: [{ where: "", tts: kugelaudio.tts({ voice: 5 }) }] });

    expect(result.diagnostics).toEqual([]);
    expect(result.notes).toEqual(["Voice 5 not checked: Could not reach https://api.kugelaudio.com: getaddrinfo ENOTFOUND"]);
  });
});

describe("curb check on a project whose voice id does not exist", () => {
  it("fails with AGENT_VOICE_NOT_FOUND, looked up on the key the project runs on", async () => {
    const project = createTestProject({
      "src/agent/agent.tsx": [
        'import { Agent, SystemPrompt, defineAgent } from "curb";',
        'import { kugelaudio } from "curb/providers";',
        "",
        "export function App() {",
        "  return (",
        "    <Agent stt={kugelaudio.stt()} tts={kugelaudio.tts({ voice: 999999 })}>",
        "      <SystemPrompt>{`You help.`}</SystemPrompt>",
        "    </Agent>",
        "  );",
        "}",
        "",
        "export const agent = defineAgent({ app: App });",
        "",
      ].join("\n"),
      ".env.example": "# KUGELAUDIO_API_KEY=\n",
    });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    const findVoice = vi.fn(async () => null);
    try {
      const report = await checkProject(project, {
        env: { KUGELAUDIO_API_KEY: "sk-test" },
        typeCheck: async () => ({ diagnostics: [], checkedFiles: 0, unlisted: 0 }),
        findVoice,
      });

      expect(findVoice).toHaveBeenCalledWith({ apiBase: "https://api.kugelaudio.com", apiKey: "sk-test" }, 999999);
      expect(report.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity])).toEqual([
        ["AGENT_VOICE_NOT_FOUND", "error"],
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
