import type { AgentModelUsage } from "../llm/ai-sdk.js";

/**
 * Token counts of a test run, as the providers report them. Nothing here knows a price: a
 * report shows tokens, and `curb test --max-tokens` stops on them.
 */

/** Tokens one role used. Input is the uncached part; cache reads and writes have their own counters. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Who used the tokens: the agent under test, the simulated caller, or the judge. */
export type UsageRole = "agent" | "caller" | "judge";

/** Tokens per role (null where the provider reported none), and their sum. */
export type RunUsage = Record<UsageRole, TokenUsage | null> & { totalTokens: number };

const ROLES: readonly UsageRole[] = ["agent", "caller", "judge"];

function tokensOf(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Adds up what a provider reports for the requests of one role. A request the provider reported
 * nothing for counts nothing; `total()` is null while no request reported anything. */
export class TokenCounter {
  private sum: TokenUsage | null = null;

  readonly add = (usage: AgentModelUsage): void => {
    const reported = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
    if (reported.every((count) => count === undefined)) return;
    const sofar = this.sum ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.sum = {
      inputTokens: sofar.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: sofar.outputTokens + (usage.outputTokens ?? 0),
      cacheReadTokens: sofar.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: sofar.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    };
  };

  total(): TokenUsage | null {
    return this.sum;
  }
}

/** The usage of one run from what each role used; null when no provider reported anything. */
export function runUsage(byRole: Record<UsageRole, TokenUsage | null>): RunUsage | null {
  if (ROLES.every((role) => byRole[role] === null)) return null;
  const totalTokens = ROLES.reduce((sum, role) => sum + (byRole[role] ? tokensOf(byRole[role]) : 0), 0);
  return { ...byRole, totalTokens };
}

/** The usage of several runs together; null when none of them has any. */
export function sumUsage(runs: ReadonlyArray<RunUsage | null>): RunUsage | null {
  const counters: Record<UsageRole, TokenCounter> = {
    agent: new TokenCounter(),
    caller: new TokenCounter(),
    judge: new TokenCounter(),
  };
  for (const run of runs) {
    for (const role of ROLES) {
      const usage = run?.[role];
      if (usage) counters[role].add(usage);
    }
  }
  return runUsage({ agent: counters.agent.total(), caller: counters.caller.total(), judge: counters.judge.total() });
}

/** The tokens a whole `curb test` may use (`--max-tokens`). Runs report what they used when they
 * end; once the limit is reached no further run starts. Without a limit it is never spent. */
export class TokenBudget {
  readonly limit: number | null;
  private used = 0;
  private heard = false;

  constructor(limit: number | null = null) {
    this.limit = limit;
  }

  spend(usage: RunUsage | null): void {
    if (!usage) return;
    this.heard = true;
    this.used += usage.totalTokens;
  }

  get spent(): number {
    return this.used;
  }

  /** Whether any run reported usage: without it a limit cannot be held. */
  get reported(): boolean {
    return this.heard;
  }

  get exhausted(): boolean {
    return this.limit !== null && this.used >= this.limit;
  }
}
