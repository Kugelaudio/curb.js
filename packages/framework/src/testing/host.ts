import type { AgentLlmClient, AgentSession } from "../agent-session.js";
import type { AgentFirstTurn } from "../config.js";
import { experimentDeclarations, type ExperimentDeclaration } from "../experiments.js";
import type { AgentModelUsage } from "../llm/ai-sdk.js";
import { anthropic, kugelaudio, openai, type KugelaudioLlmModel, type LlmDescriptor } from "../providers.js";
import type { AgentSiteRuntime } from "../runtime.js";
import { ANSWER_TIMEOUT_MS } from "./caller.js";
import { Throttle, withRetries, withStreamRetries } from "./resilience.js";
import type { TokenUsage } from "./usage.js";
import { TokenCounter } from "./usage.js";

/**
 * What every function of `curb/testing` runs on: the host. It builds the agent the way a call
 * builds it, and the models a test thinks with, and it holds the one throttle all their requests
 * share. `projectHost()` is the project's own agent on its LLM provider; a hermetic test passes
 * a host of its own (`startCall({ host })`, `testModel({ host })`), whose agent answers from a
 * script.
 */

/** Which part a model plays: the simulated caller, or the judge (and anything else a test asks). */
export type SimulatorRole = "caller" | "judge";

/** Which model played each part, as `provider:model`; null where the host did not say. */
export type TestModels = { agent: string | null; caller: string | null; judge: string | null };

/** One agent, as a call builds it: a fresh runtime and session. */
export type CallBundle = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
  /** `defineAgent({ firstTurn })`: with "agent", the agent opens the call with a greeting. The
   * session itself opens with the fixed line of `{ say }`. */
  firstTurn?: AgentFirstTurn;
  /** `defineAgent({ experiments })` as the bundle manifest carries them: a call gets one variant
   * of each. */
  experiments?: readonly ExperimentDeclaration[];
  /** The tokens the agent's LLM requests used on this bundle so far; null while its provider
   * reported none. */
  tokens?: () => TokenUsage | null;
  /** How many of the agent's LLM requests failed for good on this bundle so far (after the
   * retries). A turn that failed while this went up failed on the provider, not on the agent. */
  providerErrors?: () => number;
};

export type TestHost = {
  /** A fresh agent, built the way a call builds it. */
  createBundle(): Promise<CallBundle>;
  /** The client of a model to think with, for an agent whose LLM is `llm`: the one `model`
   * names (`<provider>:<id>`, or a model of the agent's provider), else a small model of the
   * agent's provider. `onUsage` hears the tokens of each of its requests. */
  simulator(llm: LlmDescriptor, role: SimulatorRole, onUsage: (usage: AgentModelUsage) => void, model?: string): AgentLlmClient;
  /** Which model plays each part, for reports, with `chosen` naming a model per part as
   * `simulator` takes it. Throws when one has no key in this process. */
  models?(llm: LlmDescriptor, chosen?: Partial<Record<SimulatorRole, string>>): TestModels;
  /** What every request of this host shares about its provider's rate limit. */
  throttle?: Throttle;
};

/**
 * The small, fast model of each provider that plays the caller and judges its goal. They run
 * on the agent's own provider, whose key the project already has.
 */
export const SIMULATION_MODELS = { anthropic: "claude-haiku-5-5", openai: "gpt-5.4-mini" } as const;

/** The model the simulated caller and the judge use for an agent on `llm`. KugelAudio and an
 * OpenAI-compatible endpoint serve only what they serve, so there it is the agent's own model. */
export function simulationLlm(llm: LlmDescriptor): LlmDescriptor {
  switch (llm.provider) {
    case "anthropic":
      return anthropic(SIMULATION_MODELS.anthropic);
    case "openai":
      return openai(SIMULATION_MODELS.openai);
    case "kugelaudio":
    case "openai-compatible":
      return llm;
  }
}

/**
 * The model `spec` names (`--caller-model`, `--judge-model`, `testModel({ model })`), for an
 * agent on `llm`: `<provider>:<model>` with openai, anthropic or kugelaudio, else a model of the
 * agent's own provider and endpoint. Without a spec, {@link simulationLlm}.
 */
export function modelFor(spec: string | undefined, llm: LlmDescriptor): LlmDescriptor {
  const named = spec?.trim();
  if (!named) return simulationLlm(llm);
  const [, provider, model] = /^(openai|anthropic|kugelaudio):(.+)$/.exec(named) ?? [];
  const on = provider ?? llm.provider;
  const id = model ?? named;
  switch (on) {
    case "openai":
      return openai(id);
    case "anthropic":
      return anthropic(id);
    case "kugelaudio":
      return kugelaudio.llm({ model: id as KugelaudioLlmModel });
    default:
      return llm.provider === "openai-compatible" ? { ...llm, options: { ...llm.options, model: id } } : llm;
  }
}

/** A model as a result names it: `provider:model`. */
export function modelLabel(llm: LlmDescriptor): string {
  return `${llm.provider}:${llm.options.model}`;
}

/** How long a test session waits for one LLM request. Far beyond any single answer: the host's
 * retries hold each request, its retries included, to the real deadline, a provider that keeps
 * missing it is not sent more (`resilience.ts`), and a rate limit may take minutes to lift. */
const SESSION_PATIENCE_MS = 60 * 60_000;

/** The option of `curb test` that picks each part's model, as a refusal names it. */
const MODEL_OPTIONS = { caller: "--caller-model", judge: "--judge-model" } as const;

let project: TestHost | null = null;

/**
 * The project's own agent on the bundle path a call uses (`createVoiceAgentBundle`), which
 * refuses to start, naming the variable, when the agent's LLM key is missing: the host every
 * function of `curb/testing` runs on when it is given none. One per process, so every request
 * (the agent's, the caller's, the judge's) waits on one throttle, as a provider counts them
 * against one limit; each is sent again when the provider says to, and counts its tokens.
 *
 * Nothing happens until the first agent is built. Then the project is prepared when no `curb`
 * command did (its root from the working directory, its .env, the key `curb login` stored),
 * conversation recording is turned off (the store is for real conversations), the framework's
 * own log lines go to stderr, and the agent's authoring diagnostics, which loading it logs one
 * by one as a server boot does, become one note pointing at `curb check`.
 */
export function projectHost(): TestHost {
  project ??= createProjectHost();
  return project;
}

function createProjectHost(): TestHost {
  // The provider SDK's own retries are off, so each rate limit is seen here, where the whole
  // run can slow down for it.
  const throttle = new Throttle();
  type Modules = {
    createVoiceAgentBundle: typeof import("../voice-host.js").createVoiceAgentBundle;
    runAiSdkAgent: typeof import("../llm/ai-sdk.js").runAiSdkAgent;
    missingLlmCredential: typeof import("../llm/ai-sdk.js").missingLlmCredential;
    agentTimeoutMs: number;
  };
  let loaded: Modules | null = null;
  let ready: Promise<Modules> | null = null;
  const load = (): Promise<Modules> =>
    (ready ??= (async () => {
      const { ensureProjectPrepared } = await import("../cli/prepare-project.js");
      ensureProjectPrepared();
      const { diagnosticsNote, disableConversationRecording, dropDiagnosticLogs } = await import("../cli/headless-project.js");
      await disableConversationRecording();
      const { routeInfoLogsToStderr } = await import("../server/log.js");
      routeInfoLogsToStderr();
      const { getHostedAgent } = await import("../server/bootstrap.js");
      const restoreConsole = dropDiagnosticLogs();
      let diagnostics: Awaited<ReturnType<typeof getHostedAgent>>["diagnostics"];
      try {
        ({ diagnostics } = await getHostedAgent());
      } finally {
        restoreConsole();
      }
      const note = diagnosticsNote(diagnostics);
      if (note) console.error(`note: ${note}`);
      const { createVoiceAgentBundle } = await import("../voice-host.js");
      const { missingLlmCredential, runAiSdkAgent } = await import("../llm/ai-sdk.js");
      const { llmTimeoutFromEnv } = await import("../llm/deadline.js");
      loaded = { createVoiceAgentBundle, runAiSdkAgent, missingLlmCredential, agentTimeoutMs: llmTimeoutFromEnv() };
      return loaded;
    })());
  const modules = (): Modules => {
    if (!loaded) throw new Error("curb: the project host has built no agent yet, so it does not know the agent's LLM.");
    return loaded;
  };
  /** The model of a part, refused when this process has no key for it. */
  const modelOf = (role: SimulatorRole, llm: LlmDescriptor, spec: string | undefined): LlmDescriptor => {
    const model = modelFor(spec, llm);
    const missing = modules().missingLlmCredential(model);
    if (missing) {
      throw new Error(
        `[CURB_TEST_MODEL_KEY_MISSING] The ${role}'s model ${modelLabel(model)} needs ${missing}, and this process does not have it.\n` +
          `Fix: set ${missing} in the project's .env, or pick a model of the agent's own provider with ${MODEL_OPTIONS[role]} <model>.`,
      );
    }
    return model;
  };
  return {
    async createBundle() {
      const { createVoiceAgentBundle, agentTimeoutMs } = await load();
      const tokens = new TokenCounter();
      let failed = 0;
      const retry = { throttle, timeoutMs: agentTimeoutMs, onGiveUp: () => void (failed += 1) };
      const { runtime, session, definition } = await createVoiceAgentBundle(undefined, (transports) => {
        const { llm, streamLlm } = transports({ onUsage: tokens.add, maxRetries: 0 });
        // Each request has the session's deadline, its retries included; the session itself
        // waits as long as a rate limit takes, which the retries bound.
        return { llm: withRetries(llm, retry), streamLlm: withStreamRetries(streamLlm, retry), llmTimeoutMs: SESSION_PATIENCE_MS };
      });
      return {
        runtime,
        session,
        firstTurn: definition.firstTurn,
        experiments: experimentDeclarations(definition.experiments),
        tokens: () => tokens.total(),
        providerErrors: () => failed,
      };
    },
    simulator(llm, role, onUsage, spec) {
      const model = modelOf(role, llm, spec);
      const { runAiSdkAgent } = modules();
      return withRetries((request) => runAiSdkAgent(request, { llm: model, onUsage, maxRetries: 0 }), { throttle, timeoutMs: ANSWER_TIMEOUT_MS });
    },
    // Each part's label is worked out when it is read: a call asks for the agent's alone, and
    // a model without a key is refused only where it is asked for.
    models: (llm, chosen = {}) => ({
      agent: modelLabel(llm),
      get caller() {
        return modelLabel(modelOf("caller", llm, chosen.caller));
      },
      get judge() {
        return modelLabel(modelOf("judge", llm, chosen.judge));
      },
    }),
    throttle,
  };
}

/** What this process knows of a host: its agent's LLM, and an agent built to learn it that the
 * next call takes, so learning it costs no extra agent. */
type HostState = { llm?: LlmDescriptor; spare?: CallBundle | null };
const states = new WeakMap<TestHost, HostState>();
const stateOf = (host: TestHost): HostState => {
  let state = states.get(host);
  if (!state) states.set(host, (state = {}));
  return state;
};

/** A fresh agent of `host` for a call: the one {@link agentLlmOf} built, else a new one. */
export async function takeBundle(host: TestHost): Promise<CallBundle> {
  const state = stateOf(host);
  const spare = state.spare;
  state.spare = null;
  const bundle = spare ?? (await host.createBundle());
  state.llm ??= bundle.runtime.settings.current().llm;
  return bundle;
}

/** The LLM of the host's agent, which a model to think with runs beside. Learned from the first
 * agent the host builds; when no call has built one yet, one is built and kept for the next call. */
export async function agentLlmOf(host: TestHost): Promise<LlmDescriptor> {
  const state = stateOf(host);
  if (!state.llm) {
    const bundle = await host.createBundle();
    state.llm ??= bundle.runtime.settings.current().llm;
    state.spare ??= bundle;
  }
  return state.llm;
}
