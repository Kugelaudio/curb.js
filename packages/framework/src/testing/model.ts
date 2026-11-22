import type { AgentLlmClient } from "../agent-session.js";
import { request } from "./caller.js";
import { agentLlmOf, projectHost, type SimulatorRole, type TestHost } from "./host.js";
import { describeProviderError } from "./resilience.js";
import { TokenCounter, type TokenUsage } from "./usage.js";

/**
 * A model to think with: a plain function from a system prompt and an input to the model's
 * text. The simulated caller, the judge and the grouping of findings are calls to one; so is
 * whatever a test of its own asks.
 */
export type TestModel = ((system: string, input: string) => Promise<string>) & {
  /** The model as `provider:model`; null when the host does not say. */
  readonly model: string | null;
  /** The tokens its requests used so far; null while the provider reported none. */
  usage(): TokenUsage | null;
};

/** The client behind each model {@link testModel} made, so Curb's own blocks send their requests
 * to it whole, as they always have. */
const clients = new WeakMap<object, AgentLlmClient>();

/** A model on `client`. `usage` reports its tokens. */
export function modelOn(client: AgentLlmClient, label: string | null = null, usage: () => TokenUsage | null = () => null): TestModel {
  const model = async (system: string, input: string): Promise<string> => {
    try {
      return (await client(request("", system, [input]))).text;
    } catch (error) {
      throw new Error(describeProviderError(error));
    }
  };
  const made = Object.assign(model, { model: label, usage });
  clients.set(made, client);
  return made;
}

/** The client a request of Curb's own (the caller's, the judge's) is sent to: the model's own
 * when {@link testModel} made it, else one that hands the model its system prompt and its input
 * as one text. */
export function clientOf(model: (system: string, input: string) => Promise<string>): AgentLlmClient {
  return clients.get(model) ?? (async (sent) => ({ text: await model(sent.systemPrompt, sent.stateSnapshot.join("\n")), toolCalls: [] }));
}

/**
 * A model to think with, on the host's provider: the one `model` names (`<provider>:<id>`, or a
 * model of the agent's provider), else the small model of the agent's provider that `curb test`
 * plays the caller and judges with. Every request shares the host's retries and throttle, and
 * its tokens are counted (`usage()`). Throws, naming the variable, when the model has no key.
 */
export async function testModel(options: { model?: string; role?: SimulatorRole; host?: TestHost } = {}): Promise<TestModel> {
  const host = options.host ?? projectHost();
  const role = options.role ?? "judge";
  const llm = await agentLlmOf(host);
  const label = host.models?.(llm, options.model === undefined ? {} : { [role]: options.model })[role] ?? null;
  const counter = new TokenCounter();
  // Made on the first request: a model that is never asked costs the host nothing.
  let client: AgentLlmClient | null = null;
  const send: AgentLlmClient = (sent) => (client ??= host.simulator(llm, role, counter.add, options.model))(sent);
  return modelOn(send, label, () => counter.total());
}
