import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InvalidToolInputError, NoSuchToolError, type TextStreamPart, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuthoringError } from "../authoring.js";
import { kugelaudio, openai, openaiCompatible } from "../providers.js";
import { assertLlmCredential, mapToolCalls, readAgentStream, runAiSdkAgent, streamAiSdkAgent } from "./ai-sdk.js";
import type { AgentRunRequest, AgentRunResponse, AgentStreamPart } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function readAll(parts: unknown[]) {
  async function* source() {
    for (const part of parts) yield part as TextStreamPart<ToolSet>;
  }
  const stream = readAgentStream(source());
  const yielded: AgentStreamPart[] = [];
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return { yielded, response: next.value as AgentRunResponse };
    yielded.push(next.value);
  }
}

describe("readAgentStream", () => {
  it("passes text on as it streams and announces each tool call as soon as it opens", async () => {
    const { yielded, response } = await readAll([
      { type: "text-delta", id: "t1", text: "Let me check! " },
      { type: "tool-input-start", id: "c1", toolName: "lookup_order" },
      { type: "tool-input-delta", id: "c1", delta: '{"id":"7"}' },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup_order", input: { id: "7" } },
    ]);

    expect(yielded).toEqual([
      { delta: "Let me check. ", text: "Let me check. " },
      { type: "tool-input-start", toolName: "lookup_order" },
    ]);
    expect(response).toEqual({
      text: "Let me check.",
      toolCalls: [{ id: "c1", name: "lookup_order", input: { id: "7" } }],
    });
  });

  it("fails the step on a provider error part instead of ending it empty", async () => {
    await expect(readAll([{ type: "error", error: new Error("overloaded_error") }])).rejects.toThrow("overloaded_error");
  });
});

describe("assertLlmCredential", () => {
  it("refuses an LLM whose key this process lacks, naming the variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    let thrown: unknown;
    try {
      assertLlmCredential(openai("gpt-5"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const { diagnostic } = thrown as AgentAuthoringError;
    expect(diagnostic.message).toContain('openai("gpt-5")');
    expect(diagnostic.message).toContain("OPENAI_API_KEY");
    expect(diagnostic.fix).toContain("OPENAI_API_KEY");
  });

  it("passes when the key is set", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(() => assertLlmCredential(openai("gpt-5"))).not.toThrow();
  });
});

describe("mapToolCalls", () => {
  it("keeps valid calls as they are", () => {
    expect(mapToolCalls([{ toolCallId: "c1", toolName: "ping", input: { a: 1 } }])).toEqual([
      { id: "c1", name: "ping", input: { a: 1 } },
    ]);
  });

  it("keeps an unknown-tool call and says what went wrong, so the model can correct it", () => {
    const [call] = mapToolCalls([
      {
        toolCallId: "c2",
        toolName: "book_flight",
        input: { to: "BER" },
        invalid: true,
        error: new NoSuchToolError({ toolName: "book_flight", availableTools: ["ping"] }),
      },
    ]);
    expect(call).toEqual({
      id: "c2",
      name: "book_flight",
      input: { to: "BER" },
      error: 'Unknown tool "book_flight". Call only the tools you currently have.',
    });
  });

  it("feeds back the validation detail of an invalid input, with unparsable input as {}", () => {
    const [call] = mapToolCalls([
      {
        toolCallId: "c3",
        toolName: "ping",
        input: "{not json",
        invalid: true,
        error: new InvalidToolInputError({
          toolName: "ping",
          toolInput: "{not json",
          cause: new Error("Unexpected token n"),
          message: "Invalid input for tool ping: Unexpected token n",
        }),
      },
    ]);
    expect(call?.input).toEqual({});
    expect(call?.error).toContain('Invalid input for "ping": Invalid input for tool ping: Unexpected token n');
    expect(call?.error).toContain("matches its schema");
  });
});

/** A local OpenAI-compatible chat endpoint that records each request body and answers
 * "Hallo." (as SSE when the request streams). */
async function fakeChatEndpoint() {
  const bodies: Record<string, unknown>[] = [];
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const head = { id: "c1", created: 0, model: body.model };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = [
          { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hallo." }, finish_reason: null }] },
          { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...head,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hallo." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const turn: AgentRunRequest = {
  systemPrompt: "You answer the phone.",
  skillTitle: "",
  stateSnapshot: [],
  tools: [
    {
      id: "lookup",
      name: "lookup_customer",
      description: "Find a customer.",
      inputSchema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
      scope: "global",
    },
  ],
  messages: [{ role: "user", content: "Hallo, wer bist du?" }],
};

async function drain(stream: AsyncGenerator<AgentStreamPart, AgentRunResponse>): Promise<AgentRunResponse> {
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return next.value;
  }
}

describe("openaiCompatible request body", () => {
  it("sends reasoning_effort, the sampling fields and the extra body fields beside Curb's own", async () => {
    vi.stubEnv("AGENT_LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const endpoint = await fakeChatEndpoint();
    try {
      const llm = openaiCompatible({
        baseURL: endpoint.baseURL,
        model: "qwen3.8-27b",
        reasoningEffort: "none",
        temperature: 0.7,
        topP: 0.8,
        body: { top_k: 20, chat_template_kwargs: { enable_thinking: false } },
      });
      const streamed = await drain(streamAiSdkAgent(turn, { llm }));
      const generated = await runAiSdkAgent(turn, { llm });

      expect(streamed.text).toBe("Hallo.");
      expect(generated.text).toBe("Hallo.");
      expect(endpoint.bodies).toHaveLength(2);
      for (const body of endpoint.bodies) {
        expect(body).toMatchObject({
          model: "qwen3.8-27b",
          reasoning_effort: "none",
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          chat_template_kwargs: { enable_thinking: false },
        });
        expect(body).not.toHaveProperty("reasoningEffort");
        expect(body.messages).toContainEqual({ role: "user", content: "Hallo, wer bist du?" });
        expect((body.tools as { function: { name: string } }[]).map((tool) => tool.function.name)).toEqual([
          "lookup_customer",
        ]);
      }
      expect(endpoint.bodies[0]).toMatchObject({ stream: true });
      expect(endpoint.bodies[1]).not.toHaveProperty("stream");
    } finally {
      await endpoint.close();
    }
  });

  it("sends none of them when the descriptor sets none, leaving the endpoint's defaults", async () => {
    vi.stubEnv("AGENT_LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const endpoint = await fakeChatEndpoint();
    try {
      await runAiSdkAgent(turn, { llm: openaiCompatible({ baseURL: endpoint.baseURL, model: "qwen3.8-27b" }) });
      const [body] = endpoint.bodies;
      for (const field of ["reasoning_effort", "temperature", "top_p", "top_k", "chat_template_kwargs"]) {
        expect(body).not.toHaveProperty(field);
      }
    } finally {
      await endpoint.close();
    }
  });
});

describe("kugelaudio.llm request", () => {
  it("posts the conversation to KUGELAUDIO_API_BASE/v1 with the KugelAudio key, and no thinking or sampling field", async () => {
    const endpoint = await fakeChatEndpoint();
    vi.stubEnv("KUGELAUDIO_API_BASE", `${endpoint.origin}/`);
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-kugel-key");
    try {
      const streamed = await drain(streamAiSdkAgent(turn, { llm: kugelaudio.llm() }));
      const generated = await runAiSdkAgent(turn, { llm: kugelaudio.llm({ model: "mistral-medium-3.5-128b" }) });

      expect(streamed.text).toBe("Hallo.");
      expect(generated.text).toBe("Hallo.");
      expect(endpoint.requests).toEqual([
        { path: "/v1/chat/completions", authorization: "Bearer test-kugel-key" },
        { path: "/v1/chat/completions", authorization: "Bearer test-kugel-key" },
      ]);
      expect(endpoint.bodies.map((body) => body.model)).toEqual(["qwen3.8-27b", "mistral-medium-3.5-128b"]);
      for (const body of endpoint.bodies) {
        expect(Object.keys(body).sort()).toEqual(
          body.stream
            ? ["messages", "model", "stream", "tool_choice", "tools"]
            : ["messages", "model", "tool_choice", "tools"],
        );
        expect(body.messages).toContainEqual({ role: "user", content: "Hallo, wer bist du?" });
      }
    } finally {
      await endpoint.close();
    }
  });

  it("refuses a session without KUGELAUDIO_API_KEY, saying a hosted agent gets it from the platform", () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "");
    vi.stubEnv("AGENT_PROJECT_DIR", "/tmp/my-agent");

    let thrown: unknown;
    try {
      assertLlmCredential(kugelaudio.llm());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const { message, fix } = (thrown as AgentAuthoringError).diagnostic;
    expect(message).toBe(
      'The agent\'s llm is kugelaudio.llm({ model: "qwen3.8-27b" }), which needs KUGELAUDIO_API_KEY, and this process does not have it. No session can start without it.',
    );
    expect(fix).toContain("Run `npx curb login` in the project");
    expect(fix).not.toContain("Set KUGELAUDIO_API_KEY");
    expect(fix).toContain("A hosted agent gets it from the platform.");
    expect(fix).not.toContain("secrets push");
  });
});
