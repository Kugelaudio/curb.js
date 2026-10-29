import {
  byName,
  declarationError,
  declaredNameProblem,
  descriptionProblem,
  isRecord,
  unknownFieldsProblem,
} from "./goals.js";

/**
 * A/B experiments: `defineAgent({ experiments })`. Each names its variants with relative weights;
 * every call gets one variant of each, and the agent reads it with `useVariant(name)`. `curb build`
 * writes them into the bundle manifest, where a hosting platform reads them to assign each call
 * its variants (the rule is `experiments.node.ts`) and to report goals per variant.
 */

export type AgentExperiment = {
  /** What the experiment compares, for the people reading the results. At most 200 characters. */
  description?: string;
  /** Variant name to relative weight, a whole number from 1 to 100: `{ formal: 1, casual: 1 }`
   * gives each half the calls, `{ formal: 1, casual: 3 }` gives casual three in four. 2 to 6. */
  variants: Readonly<Record<string, number>>;
  /** A client-context key (`client.<key>`, what the caller's page sent) whose value, when it names
   * a variant, picks that variant for the call instead of the draw. */
  fromClient?: string;
};

/** Experiment name (a lowercase letter, then up to 39 lowercase letters, digits or underscores)
 * to experiment. */
export type AgentExperiments = Readonly<Record<string, AgentExperiment>>;

/** One experiment as the bundle manifest carries it: variants sorted by name, which is the order
 * the assignment walks them in. */
export type ExperimentDeclaration = {
  name: string;
  description?: string;
  variants: ReadonlyArray<{ name: string; weight: number }>;
  fromClient?: string;
};

export const MAX_EXPERIMENTS = 5;
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 6;
export const MAX_WEIGHT = 100;
/** The rule page info keys follow (`clientInfoProblem` in `server/protocol.ts`): the key a
 * `fromClient` names is one of them. */
const CLIENT_CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const EXPERIMENT_FIELDS = ["description", "variants", "fromClient"];

/** Where a call's variant lives in the agent's session info: `experiment.<name>`. */
export const EXPERIMENT_INFO_PREFIX = "experiment.";

const EXPERIMENTS_FIX =
  'Declare each experiment by name with 2 to 6 weighted variants, e.g. experiments: { greeting: { description: "Formal vs casual opening", ' +
  'variants: { formal: 1, casual: 1 }, fromClient: "greeting" } }.';

/** Every problem with `experiments` as `defineAgent` takes them; empty when there is none. */
export function experimentsProblems(experiments: unknown): string[] {
  if (experiments === undefined) return [];
  if (!isRecord(experiments)) return ["experiments must be an object of experiment name to experiment."];
  const entries = Object.entries(experiments);
  const problems: string[] = [];
  if (entries.length > MAX_EXPERIMENTS) {
    problems.push(`An agent declares at most ${MAX_EXPERIMENTS} experiments; this one declares ${entries.length}.`);
  }
  for (const [name, experiment] of entries) {
    const where = `experiments.${name}`;
    const nameProblem = declaredNameProblem(name, "an experiment");
    if (nameProblem) problems.push(nameProblem);
    if (!isRecord(experiment)) {
      problems.push(`${where} must be an object with variants.`);
      continue;
    }
    const unknown = unknownFieldsProblem(experiment, EXPERIMENT_FIELDS, where);
    if (unknown) problems.push(unknown);
    const description = descriptionProblem(experiment.description, where);
    if (description) problems.push(description);
    problems.push(...variantsProblems(experiment.variants, where));
    const { fromClient } = experiment;
    if (fromClient !== undefined && (typeof fromClient !== "string" || !CLIENT_CONTEXT_KEY.test(fromClient))) {
      problems.push(
        `${where}.fromClient must be a client-context key: a letter, then up to 39 letters, digits or underscores; got ${JSON.stringify(fromClient) ?? String(fromClient)}.`,
      );
    }
  }
  return problems;
}

function variantsProblems(variants: unknown, where: string): string[] {
  if (!isRecord(variants)) return [`${where}.variants must be an object of variant name to weight, e.g. { formal: 1, casual: 1 }.`];
  const entries = Object.entries(variants);
  const problems: string[] = [];
  if (entries.length < MIN_VARIANTS || entries.length > MAX_VARIANTS) {
    problems.push(`${where} has ${entries.length} variant${entries.length === 1 ? "" : "s"}; an experiment has ${MIN_VARIANTS} to ${MAX_VARIANTS}.`);
  }
  for (const [name, weight] of entries) {
    const nameProblem = declaredNameProblem(name, "a variant");
    if (nameProblem) problems.push(`${where}.variants: ${nameProblem}`);
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
      problems.push(
        `${where}.variants.${name} must be a whole-number weight from 1 to ${MAX_WEIGHT}; got ${JSON.stringify(weight) ?? String(weight)}.`,
      );
    }
  }
  return problems;
}

/** Refuse `experiments` no call could be assigned by, naming every problem. */
export function assertExperiments(experiments: unknown): void {
  const problems = experimentsProblems(experiments);
  if (problems.length > 0) throw declarationError("experiments", problems, EXPERIMENTS_FIX);
}

/** The experiments as the bundle manifest carries them: experiments and each one's variants sorted
 * by name, `description` and `fromClient` only when given. */
export function experimentDeclarations(experiments: AgentExperiments | undefined): ExperimentDeclaration[] {
  return Object.entries(experiments ?? {})
    .map(([name, experiment]): ExperimentDeclaration => ({
      name,
      ...(experiment.description === undefined ? {} : { description: experiment.description }),
      variants: Object.entries(experiment.variants)
        .map(([variant, weight]) => ({ name: variant, weight }))
        .sort(byName),
      ...(experiment.fromClient === undefined ? {} : { fromClient: experiment.fromClient }),
    }))
    .sort(byName);
}

/** A call's assignments as session info: `{ greeting: "casual" }` becomes
 * `{ "experiment.greeting": "casual" }`. */
export function experimentInfo(assignments: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const info: Record<string, string> = {};
  for (const [name, variant] of Object.entries(assignments ?? {})) info[`${EXPERIMENT_INFO_PREFIX}${name}`] = variant;
  return info;
}

/** The assignments in session info, by experiment name: the inverse of {@link experimentInfo}. */
export function experimentAssignmentsOf(info: Readonly<Record<string, unknown>>): Record<string, string> {
  const assignments: Record<string, string> = {};
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith(EXPERIMENT_INFO_PREFIX) && typeof value === "string") {
      assignments[key.slice(EXPERIMENT_INFO_PREFIX.length)] = value;
    }
  }
  return assignments;
}
