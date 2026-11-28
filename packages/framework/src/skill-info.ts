import type { z } from "zod";
import type { AgentInfo } from "./info-store.js";

/**
 * A skill's declared call info (`meta.info`, a zod object keyed by info key): reading the keys it
 * declares (`useAgentInfo(meta)`) and checking them when the skill opens (`SKILL_INFO_MISSING`).
 * Only the declared keys are looked at: the store is one per call and also holds `client.*`,
 * `experiment.*` and whatever the host set, none of which a skill's schema may reject.
 */

/** The declared keys whose values fit their schema, parsed; a key that is absent or does not fit
 * is left out. */
export function declaredInfo(schema: z.ZodObject, info: AgentInfo): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = (field as z.ZodType).safeParse(info[key]);
    if (parsed.success && parsed.data !== undefined) found[key] = parsed.data;
  }
  return found;
}

/** One declared key the call's info does not satisfy. */
export type SkillInfoProblem = { key: string; problem: string };

/** The required keys the call's info lacks, and the declared keys whose value does not fit. */
export function skillInfoProblems(schema: z.ZodObject, info: AgentInfo): SkillInfoProblem[] {
  return Object.entries(schema.shape).flatMap(([key, field]): SkillInfoProblem[] => {
    const value = info[key];
    const parsed = (field as z.ZodType).safeParse(value);
    if (parsed.success) return [];
    if (value === undefined) return [{ key, problem: "is missing" }];
    const issue = parsed.error.issues[0]?.message ?? "does not fit its schema";
    return [{ key, problem: `is ${preview(value)}, which does not fit: ${issue}` }];
  });
}

/** The line a skill that opened without its info is reported with. */
export function skillInfoMessage(path: string, problems: readonly SkillInfoProblem[]): string {
  const listed = problems.map(({ key, problem }) => `"${key}" ${problem}`).join("; ");
  return `The skill ${path} opened without the call info its meta.info requires: ${listed}.`;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
