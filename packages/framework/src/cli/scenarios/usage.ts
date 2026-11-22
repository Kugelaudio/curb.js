import type { RunUsage, TokenUsage, UsageRole } from "./types.js";

/**
 * Token counts of `curb test` and `curb review`, per part (the agent, the simulated caller, the
 * judge) and summed. Nothing here knows a price: a report shows tokens.
 */

const ROLES: readonly UsageRole[] = ["agent", "caller", "judge"];

/** What each part used, summed over `parts` (null where none reported anything), and the total;
 * null when nothing reported anything. */
export function sumUsage(parts: ReadonlyArray<Partial<Record<UsageRole, TokenUsage | null>> | null>): RunUsage | null {
  const sums: Record<UsageRole, TokenUsage | null> = { agent: null, caller: null, judge: null };
  for (const part of parts) {
    for (const role of ROLES) {
      const used = part?.[role];
      if (!used) continue;
      const sofar = sums[role] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      sums[role] = {
        inputTokens: sofar.inputTokens + used.inputTokens,
        outputTokens: sofar.outputTokens + used.outputTokens,
        cacheReadTokens: sofar.cacheReadTokens + used.cacheReadTokens,
        cacheWriteTokens: sofar.cacheWriteTokens + used.cacheWriteTokens,
      };
    }
  }
  if (ROLES.every((role) => sums[role] === null)) return null;
  const total = (used: TokenUsage | null) => (used ? used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheWriteTokens : 0);
  return { ...sums, totalTokens: ROLES.reduce((sum, role) => sum + total(sums[role]), 0) };
}

/** The usage of one run from what each part used; null when nothing reported anything. */
export function runUsage(byRole: Record<UsageRole, TokenUsage | null>): RunUsage | null {
  return sumUsage([byRole]);
}
