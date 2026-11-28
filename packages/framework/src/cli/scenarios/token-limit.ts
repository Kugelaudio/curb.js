import type { AgentLlmClient, AgentLlmStreamStep } from "../../agent-session.js";
import type { TestHost } from "../../testing/index.js";

/**
 * A limit on the tokens `curb test` spends on models: `--max-tokens <n>`, and `--dry`, which is a
 * limit of none. Put under the reply store, it sees only the requests the store sends on, so it
 * counts live tokens alone. Once they reach the limit, no further request starts: each throws, and
 * counts as a failure of the provider, so its run ends as an error and says nothing about the
 * agent. A request already under way finishes.
 */

type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined };

const total = (usage: Usage | null | undefined): number =>
  usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0;

export type TokenLimit = {
  host: TestHost;
  /** The tokens the models used so far. */
  spent(): number;
  /** The requests refused so far. */
  refused(): number;
};

/** `host` whose models start no request once they used `max` tokens; a refused request throws
 * `reason()`. */
export function withTokenLimit(host: TestHost, max: number, reason: () => string): TokenLimit {
  const bundles: Array<() => number> = [];
  let simulators = 0;
  let refused = 0;
  const spent = () => simulators + bundles.reduce((sum, tokens) => sum + tokens(), 0);
  /** Throws when the limit is reached; counts the refusal for `onRefused` too. */
  const check = (onRefused?: () => void) => {
    if (spent() < max) return;
    refused += 1;
    onRefused?.();
    throw new Error(reason());
  };
  const limited: TestHost = {
    ...host,
    async createBundle() {
      const bundle = await host.createBundle();
      bundles.push(() => total(bundle.tokens?.()));
      let refusedHere = 0;
      const refuse = () => void (refusedHere += 1);
      const client = (inner: AgentLlmClient): AgentLlmClient => async (request) => {
        check(refuse);
        return inner(request);
      };
      const stream = (inner: AgentLlmStreamStep): AgentLlmStreamStep =>
        async function* (request) {
          check(refuse);
          return yield* inner(request);
        };
      bundle.session.wrapLlm({ llm: client, streamLlm: stream });
      // A refused request is no fault of the agent: its turn fails as on a provider error.
      return { ...bundle, providerErrors: () => (bundle.providerErrors?.() ?? 0) + refusedHere };
    },
    simulator(llm, role, onUsage, spec) {
      const inner = host.simulator(llm, role, (usage) => {
        simulators += total(usage);
        onUsage(usage);
      }, spec);
      return async (request) => {
        check();
        return inner(request);
      };
    },
  };
  return { host: limited, spent, refused: () => refused };
}
