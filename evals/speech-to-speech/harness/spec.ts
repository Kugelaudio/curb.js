/**
 * One eval case: a Curb scenario plus what the eval scores it on.
 *
 * `evalCase()` returns an ordinary `scenario()`, so `npx curb test` runs every case of an agent
 * as a regular Curb test (text, on the agent's `llm`). The eval's own runners (`text.ts`,
 * `voice.ts`) read the same files and score each conversation on what the case expects: the
 * skill the caller's request needs, the path through the skills, and the tool calls.
 */

import { scenario, type Scenario, type ScenarioCaller, type ScenarioCheck, type ScenarioFake } from "curb/testing";

/** What a case exercises; the report groups by it. */
export const CASE_KINDS = [
  "direct",
  "ambiguous",
  "topic_switch",
  "back",
  "multi_step",
  "interruption",
  "refusal",
  "faq",
  "escalation",
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** A value an argument must have: text compared ignoring case, spaces and punctuation, or a pattern. */
export type ArgMatcher = string | number | boolean | RegExp;

/** A tool call the agent should make, with the arguments that must hold (others may differ). */
export type ExpectedTool = { tool: string; args?: Readonly<Record<string, ArgMatcher>> };

/** One caller line. On the voice path, `interrupt` says it starts while the agent is still speaking. */
export type CallerLine = string | { line: string; interrupt?: boolean };

export type EvalCaseSpec = {
  /** Unique within the agent, e.g. "books a check-up". */
  name: string;
  kind: CaseKind;
  /** Scripted caller lines, the same every run. */
  turns?: readonly CallerLine[];
  /** Or a simulated caller (Curb's `simulatedCaller`). */
  caller?: ScenarioCaller;
  maxTurns?: number;
  /** The skill the caller's first request needs, as `read_skill` names it ("/orders"); null when
   * the agent level answers it (no skill should be read for it). */
  firstSkill: string | null;
  /** Skills the call must reach (cases that move between skills); no other skill may be read. */
  path?: readonly string[];
  /** Skills that must not be read in this call. */
  avoidSkills?: readonly string[];
  /** Business tool calls the call should make. */
  tools: readonly ExpectedTool[];
  /** Tools that must not run (refusals, unverified callers, a caller who changed their mind). */
  forbidden?: readonly string[];
  /** Tools the agent may call or not: neither expected nor counted against it. */
  allowed?: readonly string[];
  fakes?: Readonly<Record<string, ScenarioFake>>;
};

/** Tools of the framework itself: navigation and call control, never scored as business tools. */
export const FRAMEWORK_TOOLS = new Set(["read_skill", "end_call", "skip_turn", "complete_procedure_step"]);

const specs = new WeakMap<Scenario, EvalCaseSpec>();

/** The line of a caller entry. */
export const lineOf = (entry: CallerLine): string => (typeof entry === "string" ? entry : entry.line);

/** Normalized text for argument comparison: case, spacing and punctuation do not count. */
export const normalized = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether `input` has every argument `args` names. */
export function argsMatch(input: Readonly<Record<string, unknown>>, args: ExpectedTool["args"]): boolean {
  if (!args) return true;
  return Object.entries(args).every(([key, want]) => {
    const got = input[key];
    if (want instanceof RegExp) return want.test(String(got ?? ""));
    return normalized(got) === normalized(want);
  });
}

/** The arguments of `args` that `input` gets wrong, as `key: got (want)`. */
export function argErrors(input: Readonly<Record<string, unknown>>, args: ExpectedTool["args"]): string[] {
  if (!args) return [];
  return Object.entries(args).flatMap(([key, want]) =>
    argsMatch(input, { [key]: want }) ? [] : [`${key}: ${JSON.stringify(input[key] ?? null)} (want ${String(want)})`],
  );
}

/** A case as a Curb scenario. Its `expect` holds the eval's tool expectations, so `curb test` fails
 * a case whose tools are wrong; skills and navigation are scored by the eval's runners. */
export function evalCase(spec: EvalCaseSpec): Scenario {
  if ((spec.turns === undefined) === (spec.caller === undefined)) {
    throw new Error(`evalCase("${spec.name}"): give turns (scripted) or caller (simulated), not both.`);
  }
  const made = scenario({
    name: spec.name,
    ...(spec.turns ? { turns: spec.turns.map(lineOf) } : { caller: spec.caller! }),
    ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
    ...(spec.fakes ? { fakes: spec.fakes } : {}),
    expect: ({ called, notCalled, transcript, check }) => {
      const read = transcript.flatMap((turn) => turn.toolCalls.filter((call) => call.name === "read_skill").map((call) => String(call.input.skill ?? "")));
      const checks: ScenarioCheck[] = [
        ...spec.tools.map((expected) => called(expected.tool, expected.args as Record<string, unknown> | undefined)),
        ...(spec.forbidden ?? []).map((tool) => notCalled(tool)),
      ];
      if (spec.firstSkill !== null) checks.push(check(`reads ${spec.firstSkill}`, read.some((skill) => skill === spec.firstSkill), `read: ${read.join(", ") || "none"}`));
      return checks;
    },
  });
  specs.set(made, spec);
  return made;
}

/** The spec of a scenario `evalCase` made; null for any other scenario. */
export function specOf(value: unknown): EvalCaseSpec | null {
  return typeof value === "object" && value !== null ? (specs.get(value as Scenario) ?? null) : null;
}

/** Every case a module exports, in export order. */
export function casesIn(module: Record<string, unknown>): EvalCaseSpec[] {
  return Object.values(module).flatMap((value) => {
    const spec = specOf(value);
    return spec ? [spec] : [];
  });
}
