import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";

/**
 * What a call counts as a success: `defineAgent({ goals })`. The agent declares them in code and
 * `curb build` writes them into the bundle manifest (`curb.bundle.json`), where a hosting platform
 * reads them to report, per conversation, which goals it reached. Nothing in the running agent
 * reads them.
 */

/** Reached when the agent ran `tool` in the conversation and the tool succeeded. */
export type AgentToolGoal = {
  /** What reaching it means, for the people reading the results. At most 200 characters. */
  description?: string;
  /** The name of one of the agent's `<Tool>`s. */
  tool: string;
  judge?: never;
};

/** Reached when a judge model, reading the conversation, finds `judge` true of it. */
export type AgentJudgeGoal = {
  /** What reaching it means, for the people reading the results. At most 200 characters. */
  description?: string;
  /** The criterion, as text: "The caller says booking with the assistant was easy." 1 to 1000
   * characters. */
  judge: string;
  tool?: never;
};

export type AgentGoal = AgentToolGoal | AgentJudgeGoal;

/** Goal name (a lowercase letter, then up to 39 lowercase letters, digits or underscores) to goal. */
export type AgentGoals = Readonly<Record<string, AgentGoal>>;

/** One goal as the bundle manifest carries it. */
export type GoalDeclaration =
  | { name: string; description?: string; kind: "tool"; tool: string }
  | { name: string; description?: string; kind: "judge"; criterion: string };

/** The rule every goal, experiment and variant name follows, here and on the hosting platform. */
export const DECLARED_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_GOALS = 20;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_CRITERION_CHARS = 1000;
/** A tool name a model provider accepts. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const GOAL_FIELDS = ["description", "tool", "judge"];

/** Characters as a person counts them (code points), not UTF-16 units: "ü" is one. */
export function characters(text: string): number {
  return [...text].length;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `name` cannot name a goal, an experiment or a variant, or null when it can. */
export function declaredNameProblem(name: string, what: string): string | null {
  if (DECLARED_NAME.test(name)) return null;
  return `${JSON.stringify(name)} cannot name ${what}: use a lowercase letter, then up to 39 lowercase letters, digits or underscores.`;
}

/** Why `description` is not a description, or null when it is (or is absent). */
export function descriptionProblem(description: unknown, where: string): string | null {
  if (description === undefined) return null;
  if (typeof description !== "string") return `${where}.description must be text.`;
  const length = characters(description);
  if (length > MAX_DESCRIPTION_CHARS) {
    return `${where}.description is ${length} characters long; a description holds at most ${MAX_DESCRIPTION_CHARS}.`;
  }
  return null;
}

/** The fields of `value` outside `known`, as one problem, or null when there are none. */
export function unknownFieldsProblem(value: Record<string, unknown>, known: readonly string[], where: string): string | null {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  return `${where} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => JSON.stringify(key)).join(", ")}; it takes ${known.join(", ")}.`;
}

/** One `defineAgent` error naming every problem, so a single fix pass clears them all. */
export function declarationError(field: string, problems: readonly string[], fix: string): AgentAuthoringError {
  return new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `defineAgent({ ${field} }) cannot be used: ${problems.join(" ")}`,
    location: { source: "src/agent/agent.tsx", component: "defineAgent" },
    fix,
  });
}

const GOALS_FIX =
  'Declare each goal by name with exactly one of tool or judge, e.g. goals: { booked: { description: "The caller booked a slot", tool: "book_slot" }, ' +
  'felt_easy: { judge: "The caller says booking was easy." } }.';

/** Every problem with `goals` as `defineAgent` takes them; empty when there is none. */
export function goalsProblems(goals: unknown): string[] {
  if (goals === undefined) return [];
  if (!isRecord(goals)) return ["goals must be an object of goal name to goal."];
  const entries = Object.entries(goals);
  const problems: string[] = [];
  if (entries.length > MAX_GOALS) problems.push(`An agent declares at most ${MAX_GOALS} goals; this one declares ${entries.length}.`);
  for (const [name, goal] of entries) {
    const where = `goals.${name}`;
    const nameProblem = declaredNameProblem(name, "a goal");
    if (nameProblem) problems.push(nameProblem);
    if (!isRecord(goal)) {
      problems.push(`${where} must be an object with tool or judge.`);
      continue;
    }
    const unknown = unknownFieldsProblem(goal, GOAL_FIELDS, where);
    if (unknown) problems.push(unknown);
    const description = descriptionProblem(goal.description, where);
    if (description) problems.push(description);
    const { tool, judge } = goal;
    if ((tool === undefined) === (judge === undefined)) {
      problems.push(`${where} needs exactly one of tool (a tool the agent runs) or judge (the criterion a judge reads).`);
      continue;
    }
    if (tool !== undefined && (typeof tool !== "string" || !TOOL_NAME.test(tool))) {
      problems.push(`${where}.tool must name a tool: 1 to 64 letters, digits, underscores or hyphens; got ${JSON.stringify(tool) ?? String(tool)}.`);
    }
    if (judge !== undefined) {
      if (typeof judge !== "string" || !judge.trim()) {
        problems.push(`${where}.judge must be the criterion, as text.`);
      } else if (characters(judge) > MAX_CRITERION_CHARS) {
        problems.push(`${where}.judge is ${characters(judge)} characters long; a criterion holds at most ${MAX_CRITERION_CHARS}.`);
      }
    }
  }
  return problems;
}

/** Refuse `goals` no platform could evaluate, naming every problem. */
export function assertGoals(goals: unknown): void {
  const problems = goalsProblems(goals);
  if (problems.length > 0) throw declarationError("goals", problems, GOALS_FIX);
}

/** Order by the UTF-16 code units of `name`, which for the names {@link DECLARED_NAME} allows is
 * their byte order: the order Go's `sort.Strings` gives, so both sides walk the same list. */
export function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** The goals as the bundle manifest carries them: sorted by name, `description` only when given. */
export function goalDeclarations(goals: AgentGoals | undefined): GoalDeclaration[] {
  return Object.entries(goals ?? {})
    .map(([name, goal]): GoalDeclaration => {
      const description = goal.description === undefined ? {} : { description: goal.description };
      return goal.tool !== undefined
        ? { name, ...description, kind: "tool", tool: goal.tool }
        : { name, ...description, kind: "judge", criterion: goal.judge };
    })
    .sort(byName);
}
