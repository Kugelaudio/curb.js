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
    return [{ key, problem: `is ${kindOf(value)}, which does not fit its schema (${reason(parsed.error.issues[0])})` }];
  });
}

/** The line a skill that opened without its info is reported with. */
export function skillInfoMessage(path: string, problems: readonly SkillInfoProblem[]): string {
  const listed = problems.map(({ key, problem }) => `"${key}" ${problem}`).join("; ");
  return `The skill ${path} opened without the call info its meta.info requires: ${listed}.`;
}

/** The kind of a value, never the value: a real call logs this message, and call info may hold
 * what a caller said or a host's credentials. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  const type = typeof value;
  if (type === "object") return "an object";
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/** Why a value failed, from the issue's code and expected type alone: an issue's message can
 * repeat the value it rejected. */
function reason(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "invalid";
  if (issue.code === "invalid_type") return `expected ${issue.expected}`;
  return issue.code.replace(/_/g, " ");
}
