import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioResult } from "./scenarios/run.js";
import { createTestProject } from "./test-project.js";
import { testCommand, type TestReport } from "./test.js";

/**
 * `curb test` on the project's real host: the fixture project's agent (AGENT_PROJECT_DIR in
 * vitest.config.ts) on KugelAudio's LLM, whose endpoint is a server in this process. Nothing
 * leaves the machine.
 */

type ChatRequest = { stream?: boolean; stream_options?: { include_usage?: boolean }; model: string; messages: Array<{ role: string; content: unknown }> };

/** An OpenAI-compatible endpoint that answers every request "Hello there." and reports its
 * usage, except the requests `refuse` gives a status: those get it, with a pause of 30 ms. */
async function chatEndpoint(refuse: (request: number) => number | null) {
  const bodies: ChatRequest[] = [];
  const answered: number[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as ChatRequest;
      bodies.push(body);
      const refused = refuse(bodies.length);
      answered.push(refused ?? 200);
      if (refused !== null) {
        res.writeHead(refused, { "content-type": "application/json", "retry-after-ms": "30" });
        res.end(JSON.stringify({ error: { message: "Too many LLM requests for this organization. key=sk-live-0123456789abcdef" } }));
        return;
      }
      const head = { id: "c1", created: 0, model: body.model };
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 40 } };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...head, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello there." }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hello there." }, finish_reason: null }] },
        { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ...(body.stream_options?.include_usage ? [{ ...head, object: "chat.completion.chunk", choices: [], usage }] : []),
      ];
      res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, bodies, answered, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const HELLO = `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], expect: ({ said }) => [said("hello there")] });
`;

describe("curb test on the project's own host", () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** `curb test <args>` on the real host, whose LLM is `endpoint`. */
  async function run(args: string[], files: Record<string, string>, endpoint: { origin: string }) {
    vi.stubEnv("KUGELAUDIO_API_KEY", "ka_test_0123456789");
    vi.stubEnv("KUGELAUDIO_API_BASE", endpoint.origin);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createTestProject(files);
    projects.push(root);
    const out: string[] = [];
    const code = await testCommand(args, root, { out: (text) => void out.push(text), env: {} });
    const everything = `${out.join("")}\n${logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n")}`;
    return { code, printed: out.join(""), everything };
  }

  it("slows down for a rate limit instead of failing: it waits, sends again, and says so in the report", async () => {
    // Both scenarios start at once, and the provider refuses the two requests of that burst.
    const endpoint = await chatEndpoint((request) => (request <= 2 ? 429 : null));
    try {
      const { code, printed } = await run(["--concurrency", "2", "--json"], { "src/agent/a.scenario.ts": HELLO, "src/agent/b.scenario.ts": HELLO }, endpoint);

      expect(code).toBe(0);
      const report = JSON.parse(printed) as TestReport;
      // Refused twice, then answered twice: no run is an error, and nothing was retried behind the run's back.
      expect(endpoint.answered).toEqual([429, 429, 200, 200]);
      expect((report.scenarios as ScenarioResult[]).map((result) => [result.name, result.outcome, result.stats.errors])).toEqual([
        ["a", "pass", 0],
        ["b", "pass", 0],
      ]);
      // One burst, one wait of about the pause the provider asked for, and half the conversations at a time from then on.
      expect(report.throttled).toMatchObject({ waits: 1, concurrency: 1 });
      expect(report.throttled!.waitedMs).toBeGreaterThanOrEqual(25);
      expect(report.throttled!.waitedMs).toBeLessThan(1000);
      expect(report.models).toEqual({ agent: "kugelaudio:qwen3.8-27b", caller: "kugelaudio:qwen3.8-27b", judge: "kugelaudio:qwen3.8-27b" });
      // The agent's turn is streamed, and only here is the endpoint asked for the usage.
      expect(endpoint.bodies.at(-1)).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "qwen3.8-27b" });
      expect(report.usage).toEqual({
        agent: { inputTokens: 120, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 },
        caller: null,
        judge: null,
        totalTokens: 210,
      });
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("prints why a throttled run took longer", async () => {
    const endpoint = await chatEndpoint((request) => (request === 1 ? 503 : null));
    try {
      const { code, printed } = await run([], { "src/agent/hello.scenario.ts": HELLO }, endpoint);
      expect(code).toBe(0);
      expect(printed).toMatch(/\nSlowed down by the provider's rate limit: 1 wait\(s\), 0 s, then 2 conversation\(s\) at a time\.\n/);
      expect(printed).toMatch(/\n1 of 1 scenario\(s\) passed in \d+\.\ds\.\n$/);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("reports a provider that keeps failing as an error of the run, without the response body or a key", async () => {
    const endpoint = await chatEndpoint(() => 500);
    try {
      const { code, printed, everything } = await run(["--json"], { "src/agent/hello.scenario.ts": HELLO }, endpoint);

      expect(code).toBe(2);
      // A server error is tried four times, then it is the run's error; it is no rate limit.
      expect(endpoint.answered).toEqual([500, 500, 500, 500]);
      const report = JSON.parse(printed) as TestReport;
      const [result] = report.scenarios as ScenarioResult[];
      expect(result.runs[0]).toMatchObject({
        outcome: "error",
        error: {
          kind: "provider",
          message: "the agent's LLM provider failed, after the retries: failed: HTTP 500: Too many LLM requests for this organization. key=[redacted]",
        },
      });
      expect(report.throttled).toBeUndefined();
      expect(everything).not.toContain("sk-live-0123456789abcdef");
      expect(everything).not.toContain("ka_test_0123456789");
    } finally {
      await endpoint.close();
    }
  }, 60_000);
});
