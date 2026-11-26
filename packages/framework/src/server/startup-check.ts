import { formatAuthoringDiagnostic } from "../authoring.js";
import {
  DEFAULT_AZURE_SPEECH_REGION,
  hostKeyPendingFix,
  keyPageSentence,
  kugelaudioLlmBaseUrl,
  kugelaudioSpeechBase,
  LLM_KEYS,
  s2sKey,
  SPEECH_KEYS,
  type Env,
  type ProviderVariable,
} from "../provider-keys.js";
import {
  defaultKugelVoice,
  type LlmDescriptor,
  type S2sDescriptor,
  type SttDescriptor,
  type TtsDescriptor,
} from "../providers.js";

/**
 * The startup check: can this agent work at all, asked before it reports ready.
 *
 * An agent whose key is missing or refused, whose model or voice does not exist, or whose
 * provider cannot be reached starts, joins its call and stays silent: the caller hears nothing
 * and only a log says why. This check finds those before anyone calls. It names the setting
 * and its fix in one line per problem, and the host turns a problem into a non-zero exit.
 *
 * It asks each provider the cheapest request its key is scoped for (a model or voice lookup,
 * a list of one, Azure's token endpoint), with a short timeout, and never prints a key. It
 * asks no model to speak, so an agent whose caller speaks first is checked the same way as
 * one that greets.
 *
 * What it covers is the providers the conversation starts on (`<Agent llm stt tts s2s>`, as
 * the agent level renders them). A `<Skill>` that switches to another provider is refused at
 * the switch when its key is missing (`session-settings.ts`).
 */

/** How long one provider may take to answer. Several are asked at once. */
export const STARTUP_CHECK_TIMEOUT_MS = 5_000;

/** `off` skips the check where a worker starts (`curb start`, a built artifact's worker), for a
 * machine that must run without the provider keys, like `curb build`'s own start of the artifact.
 * The readiness probes ignore it: they run the check because they were asked to. */
export const STARTUP_CHECK_VAR = "CURB_STARTUP_CHECK";

export function startupCheckOff(env: Env = process.env): boolean {
  return env[STARTUP_CHECK_VAR]?.trim().toLowerCase() === "off";
}

/** Prefix of the one machine-readable line the check prints; the rest of the line is JSON. */
export const STARTUP_CHECK_MARKER = "curb-startup-check";

export type StartupProblemReason = "missing" | "rejected" | "not_found" | "unreachable" | "invalid_agent";

export type StartupProblem = {
  /** What to change: a variable name, or the prop as it is written. */
  setting: string;
  reason: StartupProblemReason;
  /** One line: what is wrong and how to fix it. Never carries a key. */
  message: string;
};

/** The providers a conversation starts on. */
export type StartupProviders = {
  llm: LlmDescriptor;
  stt?: SttDescriptor;
  tts?: TtsDescriptor;
  /** Set for an `<Agent s2s>`: the model hears and speaks, so no `stt` or `tts` is used. */
  s2s?: S2sDescriptor | null;
};

export type StartupFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export type StartupCheckOptions = {
  env?: Env;
  fetch?: StartupFetch;
  timeoutMs?: number;
  /**
   * `fail` (default): a missing key is a problem. `skip`: a missing key is left alone, for a
   * runner that is started before its keys (a managed runner booted for a snapshot); the
   * keys it does have are still asked.
   */
  missingKeys?: "fail" | "skip";
};

/** Thrown by {@link assertAgentStartup}; the host exits 78 (EX_CONFIG) on it. */
export class StartupCheckError extends Error {
  constructor(readonly problems: readonly StartupProblem[]) {
    super(problems.map((problem) => problem.message).join("\n"));
    this.name = "StartupCheckError";
  }
}

/** One request that proves a key works. */
type Probe = {
  /** The variable whose value the request carries, or null for an endpoint without a key. */
  key: ProviderVariable | null;
  /** Who answers, as the messages name it. */
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers: (key: string | undefined) => Record<string, string>;
  /** When a 404 means the thing the agent names does not exist. */
  notFound?: { setting: string; message: string };
  /** What to change when nothing answers. Default: the key's provider is down or blocked. */
  unreachableSetting?: string;
  /** A refusal that only says the key may not use this endpoint, not that the key is bad. */
  scopeRefusal?: (body: string) => boolean;
  /** Set when the endpoint can run without a key and refused because none was sent. */
  optionalKeyName?: string;
};

const bearer = (key: string | undefined): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

const KUGELAUDIO = LLM_KEYS.kugelaudio.key;

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

function llmProbe(llm: LlmDescriptor, env: Env): Probe | null {
  const model = llm.options.model;
  switch (llm.provider) {
    case "kugelaudio":
      return {
        key: KUGELAUDIO,
        provider: "KugelAudio",
        url: `${kugelaudioLlmBaseUrl(env)}/models`,
        headers: bearer,
        unreachableSetting: "KUGELAUDIO_API_BASE",
      };
    case "openai":
      return {
        key: LLM_KEYS.openai.key,
        provider: "OpenAI",
        url: `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
        headers: bearer,
        notFound: {
          setting: `openai(${JSON.stringify(model)})`,
          message: `OpenAI serves no model ${JSON.stringify(model)} to this key. Use a model id from https://platform.openai.com/docs/models.`,
        },
      };
    case "anthropic":
      return {
        key: LLM_KEYS.anthropic.key,
        provider: "Anthropic",
        url: `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
        headers: (key) => ({ "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }),
        notFound: {
          setting: `anthropic(${JSON.stringify(model)})`,
          message: `Anthropic serves no model ${JSON.stringify(model)} to this key. Use a model id from https://docs.claude.com/en/docs/about-claude/models.`,
        },
      };
    case "openai-compatible": {
      const { key } = LLM_KEYS["openai-compatible"];
      return {
        key,
        provider: "The openaiCompatible endpoint",
        url: `${withoutTrailingSlashes(llm.options.baseURL)}/models`,
        headers: bearer,
        unreachableSetting: "openaiCompatible baseURL",
        optionalKeyName: key.name,
      };
    }
    default:
      return null;
  }
}

function speechProbes(stt: SttDescriptor | undefined, tts: TtsDescriptor | undefined, env: Env): Probe[] {
  const probes: Probe[] = [];
  const speechBase = kugelaudioSpeechBase(env);
  if (tts?.provider === "kugelaudio") {
    const voice = tts.options.voice ?? defaultKugelVoice(tts.options.language);
    const written = tts.options.voice === undefined ? `kugelaudio.tts() (voice ${voice})` : `kugelaudio.tts({ voice: ${voice} })`;
    probes.push({
      key: KUGELAUDIO,
      provider: "KugelAudio",
      url: `${speechBase}/v1/voices/${voice}`,
      headers: bearer,
      unreachableSetting: "KUGELAUDIO_API_BASE",
      notFound: {
        setting: written,
        message: `${written} names a voice KugelAudio does not have for this key. Run \`npx curb voices\` to list the voices it can use.`,
      },
    });
  } else if (stt?.provider === "kugelaudio") {
    probes.push({
      key: KUGELAUDIO,
      provider: "KugelAudio",
      url: `${speechBase}/v1/voices?limit=1`,
      headers: bearer,
      unreachableSetting: "KUGELAUDIO_API_BASE",
    });
  }
  for (const descriptor of [stt, tts]) {
    if (!descriptor) continue;
    switch (descriptor.provider) {
      case "azure": {
        const region =
          descriptor.options.region?.trim() || env.AZURE_SPEECH_REGION?.trim() || DEFAULT_AZURE_SPEECH_REGION;
        probes.push({
          key: SPEECH_KEYS.azure.key,
          provider: `Azure Speech in region ${region}`,
          url: `https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
          method: "POST",
          headers: (key) => ({ "Ocp-Apim-Subscription-Key": key ?? "", "Content-Length": "0" }),
          unreachableSetting: "AZURE_SPEECH_REGION",
        });
        break;
      }
      case "deepgram":
        probes.push({
          key: SPEECH_KEYS.deepgram.key,
          provider: "Deepgram",
          url: "https://api.deepgram.com/v1/projects",
          headers: (key): Record<string, string> => ({ Authorization: `Token ${key ?? ""}` }),
        });
        break;
      case "elevenlabs":
        probes.push({
          key: SPEECH_KEYS.elevenlabs.key,
          provider: "ElevenLabs",
          url: "https://api.elevenlabs.io/v1/models",
          headers: (key): Record<string, string> => ({ "xi-api-key": key ?? "" }),
          // A key restricted to speech may not list models; ElevenLabs says so in the body.
          scopeRefusal: (body) => body.includes("missing_permissions"),
        });
        break;
      case "cartesia":
        probes.push({
          key: SPEECH_KEYS.cartesia.key,
          provider: "Cartesia",
          url: "https://api.cartesia.ai/voices?limit=1",
          headers: (key): Record<string, string> => ({ "X-API-Key": key ?? "", "Cartesia-Version": "2024-06-10" }),
        });
        break;
      case "openai":
        probes.push({
          key: SPEECH_KEYS.openai.key,
          provider: "OpenAI",
          url: "https://api.openai.com/v1/models",
          headers: bearer,
        });
        break;
    }
  }
  return probes;
}

function s2sProbe(s2s: S2sDescriptor): Probe | null {
  // Another endpoint on the same protocol is asked by the call; its key is only required here.
  if (s2s.options.baseURL) return null;
  return { key: s2sKey(s2s), provider: "OpenAI", url: "https://api.openai.com/v1/models", headers: bearer };
}

function missingFix(key: ProviderVariable, env: Env): string {
  if (key.name === KUGELAUDIO.name) {
    return (
      hostKeyPendingFix(env) ??
      "Run `npx curb login` in the project, or set KUGELAUDIO_API_KEY to an API key from the dashboard. A hosted agent gets it from the platform."
    );
  }
  return `Set it in the project's .env or in the deployment's secrets. ${keyPageSentence(key)}`.trim();
}

function rejectedFix(key: ProviderVariable): string {
  if (key.name === KUGELAUDIO.name) {
    return "Run `npx curb login` again, or replace KUGELAUDIO_API_KEY with a current API key from the dashboard.";
  }
  return `Replace ${key.name} with a current key. ${keyPageSentence(key)}`.trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Why a request got no answer, in words that carry nothing from the request. */
function unreachableCause(error: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `no answer within ${Math.round(timeoutMs / 100) / 10} s`;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

async function runProbe(
  probe: Probe,
  key: string | undefined,
  fetch: StartupFetch,
  timeoutMs: number,
): Promise<StartupProblem | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetch(probe.url, {
      method: probe.method ?? "GET",
      headers: probe.headers(key),
      signal: controller.signal,
    });
  } catch (error) {
    const setting = probe.unreachableSetting ?? probe.key?.name ?? probe.provider;
    return {
      setting,
      reason: "unreachable",
      message:
        `${probe.provider} at ${hostOf(probe.url)} could not be reached (${unreachableCause(error, timedOut, timeoutMs)}). ` +
        `Check ${setting} and that this machine can reach that host.`,
    };
  } finally {
    clearTimeout(timer);
  }
  const { status } = response;
  if (status === 401 || status === 403) {
    const body = probe.scopeRefusal ? await response.text().catch(() => "") : "";
    if (probe.scopeRefusal?.(body)) return null;
    if (!key && probe.optionalKeyName) {
      return {
        setting: probe.optionalKeyName,
        reason: "missing",
        message: `${probe.provider} at ${hostOf(probe.url)} needs a key (HTTP ${status}), and ${probe.optionalKeyName} is not set. Set it in the project's .env or in the deployment's secrets.`,
      };
    }
    const name = probe.key?.name ?? probe.optionalKeyName ?? "the key";
    return {
      setting: name,
      reason: "rejected",
      message: `${probe.provider} refused ${name} (HTTP ${status}). ${probe.key ? rejectedFix(probe.key) : ""}`.trim(),
    };
  }
  await response.body?.cancel().catch(() => {
    // KEEP-JUSTIFIED: the status is the answer; an unread body that fails to close changes nothing.
  });
  if (status === 404 && probe.notFound) {
    return { setting: probe.notFound.setting, reason: "not_found", message: probe.notFound.message };
  }
  // Any other answer means the host is there and took the key: a provider's own outage (5xx)
  // or rate limit (429) is no reason to refuse the agent it will serve once it recovers.
  return null;
}

async function readKey(key: ProviderVariable, env: Env): Promise<string | undefined> {
  const value = key.read(env);
  if (value || key.name !== LLM_KEYS.anthropic.key.name || env !== process.env) return value;
  // The transport also finds Anthropic's key in a local secrets file.
  const { anthropicApiKeyOrNull } = await import("../llm/ai-sdk.js");
  return anthropicApiKeyOrNull() ?? undefined;
}

/** Every problem with these providers in this environment; empty when the agent can work. */
export async function checkProviders(
  input: { providers: StartupProviders } & StartupCheckOptions,
): Promise<StartupProblem[]> {
  const env = input.env ?? process.env;
  const fetch = input.fetch ?? (globalThis.fetch as StartupFetch);
  const timeoutMs = input.timeoutMs ?? STARTUP_CHECK_TIMEOUT_MS;
  const { llm, stt, tts, s2s } = input.providers;

  const probes: Probe[] = [];
  const add = (probe: Probe | null) => {
    if (probe && !probes.some((known) => known.url === probe.url && known.key?.name === probe.key?.name)) probes.push(probe);
  };
  add(llmProbe(llm, env));
  if (s2s) add(s2sProbe(s2s));
  else for (const probe of speechProbes(stt, tts, env)) add(probe);
  // A key an `<Agent s2s>` reads but no probe asks (another endpoint) is still required.
  const required: ProviderVariable[] = s2s && !s2sProbe(s2s) ? [s2sKey(s2s)] : [];

  const problems: StartupProblem[] = [];
  const missing = new Map<string, ProviderVariable>();
  const runs: Promise<StartupProblem | null>[] = [];
  for (const variable of required) if (!(await readKey(variable, env))) missing.set(variable.name, variable);
  for (const probe of probes) {
    const key = probe.key ? await readKey(probe.key, env) : undefined;
    if (probe.key?.required && !key) {
      missing.set(probe.key.name, probe.key);
      continue;
    }
    runs.push(runProbe(probe, key, fetch, timeoutMs));
  }
  if (input.missingKeys !== "skip") {
    for (const variable of missing.values()) {
      problems.push({
        setting: variable.name,
        reason: "missing",
        message: `${variable.name} is not set, and the agent's providers need it. ${missingFix(variable, env)}`,
      });
    }
  }
  const answered = await Promise.all(runs);
  // One problem per setting: a refused key reads the same on every endpoint it is sent to.
  for (const problem of answered) {
    if (problem && !problems.some((known) => known.setting === problem.setting)) problems.push(problem);
  }
  return problems;
}

/**
 * The startup check of a project's agent: its authoring errors, then its providers.
 * `agentId` defaults to the agent a call would get.
 */
export async function checkAgentStartup(
  options: StartupCheckOptions & { agentId?: string } = {},
): Promise<{ problems: StartupProblem[] }> {
  const { createAgentRuntime, getHostedAgent } = await import("./bootstrap.js");
  const hosted = await getHostedAgent(options.agentId);
  const errors = hosted.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    return {
      problems: errors.map((diagnostic) => ({
        setting: diagnostic.location?.source ?? "src/agent",
        reason: "invalid_agent" as const,
        message: formatAuthoringDiagnostic(diagnostic).replace(/\s*\n\s*/g, " "),
      })),
    };
  }
  let providers: StartupProviders;
  try {
    const { runtime } = await createAgentRuntime(hosted.id);
    const { llm, stt, tts } = runtime.settings.current();
    providers = { llm, stt, tts, s2s: runtime.settings.s2s() ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { problems: [{ setting: "src/agent", reason: "invalid_agent", message: message.replace(/\s*\n\s*/g, " ") }] };
  }
  return { problems: await checkProviders({ ...options, providers }) };
}

/**
 * What the check prints: one `curb: startup check ...` line per problem (or one that it
 * passed), then {@link STARTUP_CHECK_MARKER} and the result as JSON, for a host to read.
 */
export function formatStartupReport(problems: readonly StartupProblem[]): string[] {
  const lines =
    problems.length === 0
      ? ["curb: startup check passed; the agent renders and every provider it starts with accepted its key"]
      : problems.map((problem) => `curb: startup check failed: ${problem.message}`);
  lines.push(`${STARTUP_CHECK_MARKER} ${JSON.stringify({ ok: problems.length === 0, problems })}`);
  return lines;
}

/** Prints the report: problems on stderr, the pass and the JSON line on stdout. */
export function printStartupReport(problems: readonly StartupProblem[]): void {
  for (const line of formatStartupReport(problems)) {
    if (line.startsWith("curb: startup check failed")) console.error(line);
    else console.log(line);
  }
}

/** The check of the agent this process serves, printed; rejects with the problems. */
export async function assertAgentStartup(options: StartupCheckOptions = {}): Promise<void> {
  const { problems } = await checkAgentStartup(options);
  printStartupReport(problems);
  if (problems.length > 0) throw new StartupCheckError(problems);
}

/** The startup check for the generated entry: prints the report and returns the problems. */
export async function runHostedStartupCheck(): Promise<StartupProblem[]> {
  const { problems } = await checkAgentStartup();
  printStartupReport(problems);
  return problems;
}
