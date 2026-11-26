import { describe, expect, it } from "vitest";
import { anthropic, azure, deepgram, kugelaudio, openai, openaiCompatible } from "../providers.js";
import {
  STARTUP_CHECK_MARKER,
  checkAgentStartup,
  checkProviders,
  formatStartupReport,
  type StartupFetch,
} from "./startup-check.js";

/**
 * The startup check against a stand-in network: an agent that cannot work says why before it
 * reports ready, and an agent whose caller speaks first needs no greeting to pass.
 */

const KEY = "sk-secret-value-that-must-never-print";

type Seen = { url: string; headers: Record<string, string>; method: string };

/** A fetch that answers each request with `status(url)`, or throws what it returns as an Error. */
function network(status: (url: string) => number | Error = () => 200): StartupFetch & { seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = (async (input: string, init?: { headers?: Record<string, string>; method?: string }) => {
    seen.push({ url: input, headers: init?.headers ?? {}, method: init?.method ?? "GET" });
    const answer = status(input);
    if (answer instanceof Error) throw answer;
    return new Response(answer === 204 ? null : "{}", { status: answer });
  }) as unknown as StartupFetch & { seen: Seen[] };
  fetch.seen = seen;
  return fetch;
}

const kugel = { llm: kugelaudio.llm(), stt: kugelaudio.stt({ language: "en" }), tts: kugelaudio.tts({ voice: 1072 }) };

describe("checkProviders", () => {
  it("passes a configuration whose keys every provider accepts", async () => {
    const fetch = network();
    const problems = await checkProviders({ providers: kugel, env: { KUGELAUDIO_API_KEY: KEY }, fetch });
    expect(problems).toEqual([]);
    // One key, asked once per endpoint it is used on, with the key as a bearer token.
    expect(fetch.seen.map((request) => request.url).sort()).toEqual([
      "https://api.eu.kugelaudio.com/v1/models",
      "https://api.kugelaudio.com/v1/voices/1072",
    ]);
    expect(fetch.seen.every((request) => request.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it("fails a missing key, naming the variable and how to set it, without asking the network", async () => {
    const fetch = network();
    const problems = await checkProviders({ providers: kugel, env: {}, fetch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ setting: "KUGELAUDIO_API_KEY", reason: "missing" });
    expect(problems[0]!.message).toMatch(/KUGELAUDIO_API_KEY is not set/);
    expect(problems[0]!.message).toMatch(/curb login|\.env/);
    expect(fetch.seen).toEqual([]);
  });

  it("skips a missing key when told to, for a runner that receives its keys later", async () => {
    const problems = await checkProviders({ providers: kugel, env: {}, fetch: network(), missingKeys: "skip" });
    expect(problems).toEqual([]);
  });

  it("fails a key the provider refuses, and never prints the key", async () => {
    const problems = await checkProviders({
      providers: kugel,
      env: { KUGELAUDIO_API_KEY: KEY },
      fetch: network(() => 401),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ setting: "KUGELAUDIO_API_KEY", reason: "rejected" });
    expect(problems[0]!.message).toMatch(/refused KUGELAUDIO_API_KEY \(HTTP 401\)/);
    expect(JSON.stringify(problems)).not.toContain(KEY);
    expect(formatStartupReport(problems).join("\n")).not.toContain(KEY);
  });

  it("fails a voice the speech service does not have", async () => {
    const problems = await checkProviders({
      providers: kugel,
      env: { KUGELAUDIO_API_KEY: KEY },
      fetch: network((url) => (url.includes("/voices/") ? 404 : 200)),
    });
    expect(problems).toEqual([
      expect.objectContaining({ setting: "kugelaudio.tts({ voice: 1072 })", reason: "not_found" }),
    ]);
    expect(problems[0]!.message).toMatch(/curb voices/);
  });

  it("fails a model the provider does not serve", async () => {
    const problems = await checkProviders({
      providers: { llm: anthropic("claude-nonexistent"), stt: deepgram.stt(), tts: kugelaudio.tts() },
      env: { ANTHROPIC_API_KEY: KEY, DEEPGRAM_API_KEY: KEY, KUGELAUDIO_API_KEY: KEY },
      fetch: network((url) => (url.includes("anthropic") ? 404 : 200)),
    });
    expect(problems).toEqual([
      expect.objectContaining({ setting: 'anthropic("claude-nonexistent")', reason: "not_found" }),
    ]);
  });

  it("fails a provider that does not answer in time, naming the host", async () => {
    const problems = await checkProviders({
      providers: { llm: openaiCompatible({ baseURL: "http://10.0.0.9:8000/v1", model: "local" }), stt: azure.stt(), tts: kugelaudio.tts() },
      env: { AZURE_SPEECH_KEY: KEY, KUGELAUDIO_API_KEY: KEY },
      fetch: network((url) => (url.startsWith("http://10.0.0.9") ? new Error("connect ECONNREFUSED") : 200)),
    });
    expect(problems).toEqual([expect.objectContaining({ reason: "unreachable", setting: "openaiCompatible baseURL" })]);
    expect(problems[0]!.message).toMatch(/10\.0\.0\.9:8000/);
  });

  it("checks Azure's key in the region it is used in", async () => {
    const fetch = network();
    await checkProviders({
      providers: { llm: openai("gpt-5-mini"), stt: azure.stt({ region: "westeurope" }), tts: openai.tts() },
      env: { AZURE_SPEECH_KEY: KEY, OPENAI_API_KEY: KEY },
      fetch,
    });
    const azureRequest = fetch.seen.find((request) => request.url.includes("westeurope"));
    expect(azureRequest).toMatchObject({ method: "POST", headers: { "Ocp-Apim-Subscription-Key": KEY } });
  });

  it("counts a provider's own outage as no reason to refuse the agent", async () => {
    const problems = await checkProviders({
      providers: kugel,
      env: { KUGELAUDIO_API_KEY: KEY },
      fetch: network(() => 503),
    });
    expect(problems).toEqual([]);
  });
});

describe("checkAgentStartup", () => {
  it("starts the fixture agent when its keys are set and accepted", async () => {
    const report = await checkAgentStartup({
      env: { KUGELAUDIO_API_KEY: KEY, AZURE_SPEECH_KEY: KEY },
      fetch: network(),
    });
    expect(report.problems).toEqual([]);
  });

  it("refuses the fixture agent with its key missing, naming it in one line", async () => {
    const report = await checkAgentStartup({ env: { AZURE_SPEECH_KEY: KEY }, fetch: network() });
    expect(report.problems.map((problem) => problem.setting)).toEqual(["KUGELAUDIO_API_KEY"]);
    const lines = formatStartupReport(report.problems);
    expect(lines[0]).toMatch(/^curb: startup check failed: KUGELAUDIO_API_KEY is not set/);
    expect(lines.at(-1)!.startsWith(`${STARTUP_CHECK_MARKER} `)).toBe(true);
    expect(JSON.parse(lines.at(-1)!.slice(STARTUP_CHECK_MARKER.length + 1))).toMatchObject({
      ok: false,
      problems: [{ setting: "KUGELAUDIO_API_KEY", reason: "missing" }],
    });
  });
});
