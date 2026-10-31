import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic, type AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  NoSuchToolError,
  generateText,
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "../authoring.js";
import type { AgentRunRequest, AgentRunResponse, AgentStreamPart } from "./types.js";
import { normalizeLlmPunctuation } from "./punctuation.js";
import { hostKeyPendingFix, LLM_KEYS, PLATFORM_PROVIDED } from "../provider-keys.js";
import type { LlmDescriptor } from "../providers.js";
import { resolveLlmProvider, type LlmProviderConfig } from "./provider.js";
import { quietSdkWarnings } from "./sdk-warnings.js";
import { serializeLlmInput } from "./serialize-input.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type AiSdkAgentOptions = {
  /** The conversation's effective llm, read per turn (`runtime.settings.current().llm`). */
  llm: LlmDescriptor;
};

/** The model fields of an AI SDK call: the model, its sampling and its provider options. */
type ModelCall = Pick<Parameters<typeof streamText>[0], "model" | "providerOptions" | "temperature" | "topP">;

/** The chat model the llm descriptor names, plus the call options that only apply to that
 * provider. */
function buildModel(options: AiSdkAgentOptions): ModelCall {
  const config = resolveLlmProvider(options.llm);
  const modelName = config.model;
  switch (config.kind) {
    case "kugelaudio":
      // OpenAI Chat Completions at KugelAudio's ingress; thinking is off on its side, so no
      // request option is sent.
      return {
        model: createOpenAICompatible({ name: "kugelaudio", baseURL: config.baseUrl, apiKey: config.apiKey })(modelName),
        providerOptions: undefined,
      };
    case "anthropic":
      return {
        model: createAnthropic({ apiKey: getAnthropicApiKey() })(modelName),
        providerOptions: {
          anthropic: {
            thinking: { type: "disabled" },
            sendReasoning: false,
          } satisfies AnthropicProviderOptions,
        },
      };
    case "openai":
      return { model: createOpenAI({ apiKey: config.apiKey })(modelName), providerOptions: undefined };
    case "openai-compatible":
      return {
        model: createOpenAICompatible({
          name: "openai-compatible",
          baseURL: config.baseUrl,
          apiKey: config.apiKey,
        })(modelName),
        temperature: config.temperature,
        topP: config.topP,
        providerOptions: openaiCompatibleProviderOptions(config),
      };
  }
}

/**
 * `reasoningEffort` and the extra `body` fields, under the key `@ai-sdk/openai-compatible`
 * reads (`openaiCompatible`): it sends `reasoningEffort` as `reasoning_effort` and every other
 * field as written. `openaiCompatible()` has refused the fields it would not send as written.
 */
function openaiCompatibleProviderOptions(
  config: Extract<LlmProviderConfig, { kind: "openai-compatible" }>,
): ModelCall["providerOptions"] {
  const fields = {
    ...config.body,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  };
  return Object.keys(fields).length > 0 ? { openaiCompatible: fields } : undefined;
}

function buildAgentCallParams(request: AgentRunRequest, options: AiSdkAgentOptions) {
  quietSdkWarnings();
  const { model, providerOptions, temperature, topP } = buildModel(options);
  const input = serializeLlmInput(request);

  return {
    model,
    temperature,
    topP,
    instructions: input.system,
    // LlmMessage is a structural subset of the AI SDK's ModelMessage.
    messages: input.messages as ModelMessage[],
    tools: Object.fromEntries(
      request.tools.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
        }),
      ]),
    ),
    providerOptions,
  };
}

/** The fields of an AI SDK tool call this module reads (static, dynamic or
 * invalid alike). */
type SdkToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
};

/** Longest validation detail fed back to the model for an invalid call. */
const MAX_INVALID_INPUT_DETAIL = 600;

/** Map provider tool calls, KEEPING the ones the SDK marked invalid: dropping
 * them ends a turn with nothing when the model's only action was a bad call.
 * They carry an `error` the session returns to the model as the failed result,
 * so it can correct the call within the same turn. */
export function mapToolCalls(toolCalls: readonly SdkToolCall[]): AgentRunResponse["toolCalls"] {
  return toolCalls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    input: isRecord(call.input) ? call.input : {},
    ...(call.invalid ? { error: describeInvalidToolCall(call) } : {}),
  }));
}

function describeInvalidToolCall(call: SdkToolCall): string {
  if (NoSuchToolError.isInstance(call.error)) {
    return `Unknown tool "${call.toolName}". Call only the tools you currently have.`;
  }
  const detail = call.error instanceof Error ? call.error.message : "the input does not match the tool's schema";
  const capped =
    detail.length > MAX_INVALID_INPUT_DETAIL ? `${detail.slice(0, MAX_INVALID_INPUT_DETAIL)}…` : detail;
  return `Invalid input for "${call.toolName}": ${capped} Call it again with input that matches its schema.`;
}

export async function runAiSdkAgent(
  request: AgentRunRequest,
  options: AiSdkAgentOptions,
): Promise<AgentRunResponse> {
  const result = await generateText({ ...buildAgentCallParams(request, options), abortSignal: request.signal });
  return {
    text: normalizeLlmPunctuation(result.text),
    toolCalls: mapToolCalls(result.toolCalls),
  };
}

/** Stream LLM tokens for lower voice TTFA; returns the final step response. */
export async function* streamAiSdkAgent(
  request: AgentRunRequest,
  options: AiSdkAgentOptions,
): AsyncGenerator<AgentStreamPart, AgentRunResponse> {
  const result = streamText({
    ...buildAgentCallParams(request, options),
    abortSignal: request.signal,
    // Rethrown from the error part by readAgentStream; the default would log it a second time.
    onError: () => {},
  });
  return yield* readAgentStream(result.stream, request.signal);
}

/**
 * One step's AI SDK full stream as the session reads it: text deltas, and the moment each
 * tool call starts (Anthropic and OpenAI name the tool as soon as its block opens, before
 * its input streams; the session silences the step there). Reads the full stream rather
 * than `textStream`, which drops error parts: a provider error must fail the step, not end
 * it looking like an empty reply.
 */
export async function* readAgentStream(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamPart, AgentRunResponse> {
  let raw = "";
  const toolCalls: SdkToolCall[] = [];
  for await (const part of parts) {
    switch (part.type) {
      case "text-delta":
        raw += part.text;
        yield {
          delta: normalizeLlmPunctuation(part.text),
          text: normalizeLlmPunctuation(raw),
        };
        break;
      case "tool-input-start":
        yield { type: "tool-input-start", toolName: part.toolName };
        break;
      case "tool-call":
        toolCalls.push(part);
        break;
      case "error":
        throw part.error;
      case "abort":
        throw signal?.reason ?? new Error("The LLM stream was aborted.");
    }
  }
  return {
    text: normalizeLlmPunctuation(raw.trim()),
    toolCalls: mapToolCalls(toolCalls),
  };
}

/**
 * The environment variable an LLM provider needs and this process does not have, or null.
 * Live settings refuse a switch to such a provider rather than failing every later turn.
 */
export function missingLlmCredential(descriptor: LlmDescriptor): string | null {
  // An unknown provider is refused by resolveLlmProvider, which names the factories to use.
  const key = LLM_KEYS[descriptor.provider]?.key;
  // openaiCompatible: a local endpoint needs no key, so its AGENT_LLM_API_KEY is optional.
  if (!key?.required) return null;
  // Anthropic's key may also come from a local secrets file.
  if (descriptor.provider === "anthropic") {
    try {
      getAnthropicApiKey();
      return null;
    } catch {
      return key.name;
    }
  }
  return key.read(process.env) ? null : key.name;
}

/**
 * Why a session on this LLM cannot run in this process, naming the variable it needs, or null
 * when it can. `curb dev`'s preview shows it as a banner over the agent it still renders.
 */
export function llmCredentialDiagnostic(descriptor: LlmDescriptor): AuthoringDiagnostic | null {
  const variable = missingLlmCredential(descriptor);
  if (variable === null) return null;
  const quoted = JSON.stringify(descriptor.options.model);
  const model =
    descriptor.provider === "openai-compatible"
      ? `openaiCompatible({ model: ${quoted} })`
      : descriptor.provider === "kugelaudio"
        ? `kugelaudio.llm({ model: ${quoted} })`
        : `${descriptor.provider}(${quoted})`;
  const hostedFix = hostKeyPendingFix(process.env);
  const projectDir = process.env.AGENT_PROJECT_DIR;
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `The agent's llm is ${model}, which needs ${variable}, and this process does not have it. No session can start without it.`,
    location: { source: "src/agent/agent.tsx", component: "Agent" },
    fix:
      variable === "KUGELAUDIO_API_KEY" && hostedFix
        ? hostedFix
        : variable === "KUGELAUDIO_API_KEY"
        ? "Run `npx curb login` in the project to sign in in the browser, then restart `curb dev`: Curb uses that login, and " +
          "there is no key to copy. Or set KUGELAUDIO_API_KEY (an API key from the dashboard). A hosted agent gets it from the platform."
        : `Set ${variable} in ${projectDir ? `${projectDir}/.env` : "the project's .env"} (see .env.example): ` +
          "`curb dev` reloads when you save it, and every other command reads it when it starts. " +
          (PLATFORM_PROVIDED.has(variable)
            ? "A hosted agent gets it from the platform. "
            : "A hosted agent gets it from `npx curb secrets push`. ") +
          "An empty value counts as unset.",
  };
}

/**
 * Refuse a session whose LLM cannot run in this process, naming the variable it needs.
 *
 * Called when a session starts. Without it a missing key surfaced on the caller's first
 * turn, as the fixed apology, and only the developer log said why.
 */
export function assertLlmCredential(descriptor: LlmDescriptor): void {
  const diagnostic = llmCredentialDiagnostic(descriptor);
  if (diagnostic) throw new AgentAuthoringError(diagnostic);
}

function getAnthropicApiKey(): string {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;

  const localKey = readLocalEnvFiles();
  if (localKey) return localKey;

  // Lead with the project's own .env, because that is where `curb dev` loads
  // from (cli/main.ts calls process.loadEnvFile on it) and therefore where a
  // framework USER should put the key. The framework/* paths below are a
  // fallback for work on the framework itself. Naming them first sent people to
  // edit the wrong file while their project .env sat there with a blank value.
  const projectDir = process.env.AGENT_PROJECT_DIR;
  throw new Error(
    [
      "ANTHROPIC_API_KEY is required to run the agent.",
      projectDir
        ? `Set it in ${projectDir}/.env (copy .env.example) and restart \`npm run dev\`.`
        : "Set it in your project's .env (copy .env.example); a running `curb dev` picks it up when you save.",
      "An empty value counts as unset.",
      "Alternatives: export it in the server environment, put it in",
      "framework/.env.local / framework/.env / framework/secrets.env when working on",
      "the framework itself.",
    ].join(" "),
  );
}

function readLocalEnvFiles(): string | null {
  const candidates = [
    resolve(REPO_ROOT, "framework/.env.local"),
    resolve(REPO_ROOT, "framework/.env"),
    resolve(REPO_ROOT, "framework/secrets.env"),
    resolve(REPO_ROOT, ".env.local"),
    resolve(REPO_ROOT, "secrets.env"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    const value = parseEnvValue(readFileSync(filePath, "utf8"), "ANTHROPIC_API_KEY");
    if (value) return value;
  }

  return null;
}

function parseEnvValue(contents: string, name: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`));
    if (!match) continue;

    return match[1].replace(/^['"]|['"]$/g, "").trim() || null;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
