/**
 * What `curb check` finds in the project's scenarios (`*.scenario.ts`) before any of them runs:
 *
 * - SCENARIO_UNKNOWN_SKILL: `start.skills`, `opened()` or `notOpened()` names no skill of the agent.
 * - SCENARIO_UNKNOWN_TOOL: a fake, `called()`, `notCalled()` or `calledInOrder()` names no tool of
 *   the agent.
 * - SCENARIO_INFO_MISSING: `start.info` lacks a key a skill of `start.skills` requires in its
 *   `meta.info` (or gives one that does not fit).
 *
 * A name is read in two ways. The scenario's values: `start`, `fakes`, and what `expect` asks
 * when it is called once with helpers that only note what they are given (no model, no
 * conversation; an `expect` that throws on the empty transcript keeps what it asked before). And
 * the file's text: every `called("...")`, `opened("...")`, `fake("...")` and the like written with
 * a literal name, so a check behind a condition, or in `expectRuns`, is read too.
 *
 * An MCP tool (`<server>__<tool>`) of a server the agent declares is checked against
 * `mcp.tools.json` when the file lists that server, and is otherwise taken as written: its tools
 * are known only once it connects.
 */

import { parse } from "@babel/parser";
import { HANDOFF_TOOL_NAMES } from "./blocks/handoff/trigger.js";
import { AUTHORING_DIAGNOSTIC_CODES, mergeAuthoringDiagnostics, type AuthoringDiagnostic } from "./authoring.js";
import { experimentInfo } from "./experiments.js";
import { closestName } from "./instruction-tool-diagnostics.js";
import type { AgentRoute } from "./routing.js";
import { clientInfo } from "./server/protocol.js";
import { skillInfoProblems } from "./skill-info.js";
import {
  fakesByName,
  skillPathOf,
  toolName,
  type Scenario,
  type ScenarioCheck,
  type ScenarioExpectContext,
  type ScenarioSkill,
  type ScenarioTool,
} from "./testing/scenario.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "./types.js";

const FRAMEWORK_TOOLS = ["read_skill", SKIP_TURN_TOOL_NAME, END_CALL_TOOL_NAME];

/** How long a scenario's `expect` may take when it is called to read what it asks. */
const EXPECT_PROBE_MS = 2_000;

export type CheckedScenario = {
  /** Its file, relative to the project root. */
  file: string;
  name: string;
  scenario: Scenario;
  /** The file's text. */
  source?: string;
};

export type ScenarioDiagnosticsOptions = {
  agentId: string;
  routes: readonly AgentRoute[];
  /** Every tool name of the agent, in any skill. */
  tools: readonly string[];
  /** The MCP servers the agent declares or renders, by id. */
  mcpServers: readonly string[];
  /** The tool names the project's source files write (`writtenToolNames`), for tools rendered
   * only once something happened in the call. */
  writtenTools?: readonly string[];
  /** The tools `mcp.tools.json` lists, by server id, or null when the project has no such file. */
  mcpTools: Readonly<Record<string, readonly string[]>> | null;
  scenarios: readonly CheckedScenario[];
};

type Reference = { kind: "tool" | "skill"; via: string; name: string; skill?: ScenarioSkill; line?: number };

const TOOL_HELPERS = new Set(["called", "notCalled", "calledInOrder", "fake"]);
const SKILL_HELPERS = new Set(["opened", "notOpened"]);

export async function diagnoseScenarios(options: ScenarioDiagnosticsOptions): Promise<AuthoringDiagnostic[]> {
  const diagnostics: AuthoringDiagnostic[] = [];
  for (const checked of options.scenarios) diagnostics.push(...(await diagnoseScenario(options, checked)));
  return mergeAuthoringDiagnostics(diagnostics);
}

async function diagnoseScenario(options: ScenarioDiagnosticsOptions, checked: CheckedScenario): Promise<AuthoringDiagnostic[]> {
  const { scenario, file, name, source } = checked;
  const paths = options.routes.map((route) => route.path);
  const tools = new Set([...FRAMEWORK_TOOLS, ...options.tools, ...(options.writtenTools ?? [])]);
  const declaredTools = [...new Set(options.tools)].sort();
  const diagnostics: AuthoringDiagnostic[] = [];
  const at = (line: number | undefined) => ({
    agentId: options.agentId,
    source: file,
    component: `scenario ${JSON.stringify(name)}`,
    ...(line === undefined ? {} : { line }),
  });

  const references: Reference[] = [];
  (scenario.start?.skills ?? []).forEach((skill, index) => {
    references.push({ kind: "skill", via: `start.skills[${index}]`, name: typeof skill === "string" ? skill : "", skill });
  });
  if (scenario.fakes !== undefined) {
    for (const tool of Object.keys(fakesByName(scenario.fakes))) references.push({ kind: "tool", via: "fakes", name: tool });
  }
  if (typeof scenario.expect === "function") references.push(...(await probeExpect(scenario.expect)));
  const literal = source ? literalReferences(source) : [];
  references.push(...literal);
  const keyOf = (reference: Reference) =>
    `${reference.kind}|${reference.via.replace(/\[\d+\]$/, "")}|${reference.name || reference.via}`;
  // A reference the probe recorded has no line; the same one written in the file has.
  const lines = new Map<string, number>();
  for (const reference of literal) if (reference.line !== undefined && !lines.has(keyOf(reference))) lines.set(keyOf(reference), reference.line);

  const reported = new Set<string>();
  for (const found of references) {
    const key = keyOf(found);
    const line = found.line ?? lines.get(key);
    const reference = line === undefined ? found : { ...found, line };
    if (reported.has(key)) continue;
    if (reference.kind === "tool") {
      if (tools.has(reference.name) || mcpUnchecked(reference.name, options)) continue;
      reported.add(key);
      const closest = closestName(reference.name, declaredTools);
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.scenarioUnknownTool,
        severity: "error",
        message:
          reference.via === "fakes"
            ? `Scenario "${name}" fakes "${reference.name}", but no tool of the agent is named that, so the fake never stands in for a call.`
            : `Scenario "${name}" checks ${reference.via} with "${reference.name}", but no tool of the agent is named that, so the check can never mean what it says.`,
        location: at(reference.line ?? lineOfName(source, reference.name)),
        fix:
          (closest
            ? `Write "${closest}" if that is the tool it means. `
            : declaredTools.length > 0
              ? `Name one of the agent's tools: ${declaredTools.map((tool) => `"${tool}"`).join(", ")}. `
              : "The agent has no tool of its own: add the tool, or remove the reference. ") +
          'Importing the tool\'s defineTool value (import { lookupOrder } from "./tools.js") and naming that lets TypeScript check it.',
      });
      continue;
    }
    const resolved = resolveSkill(reference, paths);
    if (resolved.path !== undefined && paths.includes(resolved.path)) continue;
    reported.add(key);
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.scenarioUnknownSkill,
      severity: "error",
      message: `Scenario "${name}" names ${resolved.label} in ${reference.via}, but ${resolved.problem}.`,
      location: at(reference.line ?? (reference.name ? lineOfName(source, reference.name) : undefined)),
      fix:
        (paths.length > 0
          ? `Name one of the agent's skills: ${paths.map((path) => `"${path}"`).join(", ")}. `
          : "The agent has no skill: add one under src/agent/, or remove the reference. ") +
        'Importing the skill module from the agent\'s own skill.tsx (import * as Billing from "./billing/skill.js") lets TypeScript check the path.',
    });
  }

  diagnostics.push(...infoDiagnostics(options, checked, at));
  return diagnostics;
}

/** SCENARIO_INFO_MISSING for each skill of `start.skills` whose `meta.info` the call's info at
 * the start does not satisfy: `start.info`, with `client.*` and `experiment.*` as the scenario
 * sets them. */
function infoDiagnostics(
  options: ScenarioDiagnosticsOptions,
  { scenario, name, source }: CheckedScenario,
  at: (line: number | undefined) => AuthoringDiagnostic["location"],
): AuthoringDiagnostic[] {
  const skills = scenario.start?.skills ?? [];
  if (skills.length === 0) return [];
  const info: Record<string, unknown> = {
    ...clientInfo(scenario.client ?? {}),
    ...(typeof scenario.experiments === "object" ? experimentInfo(scenario.experiments) : {}),
    ...(scenario.start?.info ?? {}),
  };
  const diagnostics: AuthoringDiagnostic[] = [];
  for (const skill of skills) {
    const path = resolveSkill({ kind: "skill", via: "start.skills", name: typeof skill === "string" ? skill : "", skill }, []).path;
    const schema = options.routes.find((route) => route.path === path)?.meta?.info;
    if (!path || !schema) continue;
    const problems = skillInfoProblems(schema, info);
    if (problems.length === 0) continue;
    const listed = problems.map(({ key, problem }) => `"${key}" ${problem}`).join("; ");
    const missing = problems.filter((problem) => problem.problem === "is missing").map((problem) => `"${problem.key}"`);
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.scenarioInfoMissing,
      severity: "error",
      message: `Scenario "${name}" starts in skill ${path}, whose meta.info requires call info that start.info does not give: ${listed}. The run fails before turn 1.`,
      location: at(lineOfName(source, "info") ?? lineOfName(source, "start")),
      fix:
        missing.length > 0
          ? `Add ${missing.join(", ")} to start.info, e.g. start: { skills: [...], info: { ${missing.map((key) => `${key}: ...`).join(", ")} } }, with values that fit the skill's meta.info.`
          : "Give each key a value that fits the skill's meta.info.",
    });
  }
  return diagnostics;
}

/** Whether `tool` is an MCP tool this check cannot know: of a server the agent has, which
 * `mcp.tools.json` does not list. */
function mcpUnchecked(tool: string, options: ScenarioDiagnosticsOptions): boolean {
  const at = tool.indexOf("__");
  if (at <= 0) return false;
  const server = tool.slice(0, at);
  if (!options.mcpServers.includes(server) && !(options.mcpTools && Object.hasOwn(options.mcpTools, server))) return false;
  const listed = options.mcpTools?.[server];
  return listed === undefined ? true : listed.includes(tool.slice(at + 2));
}

/** The route path a skill reference means, or why it means none. */
function resolveSkill(
  reference: Reference,
  paths: readonly string[],
): { path?: string; label: string; problem: string } {
  const skill = reference.skill ?? reference.name;
  if (typeof skill === "string") {
    return { path: skill, label: `the skill "${skill}"`, problem: paths.length > 0 ? "the agent has no skill at that path" : "the agent has no skill" };
  }
  const title = typeof skill === "object" && skill?.meta?.title ? ` "${skill.meta.title}"` : "";
  try {
    return { path: skillPathOf(skill), label: `the skill module${title}`, problem: "the agent has no skill at its path" };
  } catch {
    return { label: `the skill module${title}`, problem: "no skill.tsx under src/agent/ exports its component" };
  }
}

/**
 * Call `expect` once with helpers that note the tools and skills they are given and pass. The
 * conversation is empty: an `expect` that reads it may throw or ask less, and keeps what it
 * asked so far.
 */
async function probeExpect(expect: NonNullable<Scenario["expect"]>): Promise<Reference[]> {
  const found: Reference[] = [];
  const pass = (name: string): ScenarioCheck => ({ name, pass: true });
  const tool = (via: string) => (value: unknown) => {
    const name = typeof value === "string" ? value : isTool(value) ? toolName(value) : undefined;
    if (name !== undefined) found.push({ kind: "tool", via, name });
  };
  const skill = (via: string) => (value: unknown) => {
    if (typeof value === "string") found.push({ kind: "skill", via, name: value, skill: value });
    else if (value && typeof value === "object" && typeof (value as { default?: unknown }).default === "function") {
      found.push({ kind: "skill", via, name: "", skill: value as ScenarioSkill });
    }
  };
  const context: ScenarioExpectContext = {
    transcript: [],
    context: [],
    transcriptText: "",
    called: (value) => (tool("called()")(value), pass("called")),
    notCalled: (value) => (tool("notCalled()")(value), pass("notCalled")),
    calledInOrder: (...calls) => {
      for (const call of calls) tool("calledInOrder()")(Array.isArray(call) ? call[0] : call);
      return pass("calledInOrder");
    },
    opened: (value) => (skill("opened()")(value), pass("opened")),
    notOpened: (value) => (value === undefined ? undefined : skill("notOpened()")(value), pass("notOpened")),
    state: <T,>() => ({}) as T,
    stateMatches: () => pass("stateMatches"),
    said: () => pass("said"),
    endedCall: () => pass("endedCall"),
    check: (name) => pass(name),
    note: (check) => check,
    ask: async (question) => pass(question),
    model: async () => "",
  };
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve().then(() => expect(context)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, EXPECT_PROBE_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    // KEEP-JUSTIFIED: an expect written for a real conversation may throw on an empty one; what
    // it asked before it threw is still read, and the rest comes from the file's text.
  }
  return found;
}

const isTool = (value: unknown): value is ScenarioTool =>
  typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";

/** Each tool or skill a helper of the file is given as a literal name: `called("book_slot")`,
 * `run.opened("/billing")`, `calledInOrder("a", ["b", { ... }])`, `fake("book_slot", ...)`. */
function literalReferences(source: string): Reference[] {
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  } catch {
    // KEEP-JUSTIFIED: a file that does not parse did not load either; curb test reports it.
    return [];
  }
  const found: Reference[] = [];
  const literal = (node: AstNode | undefined): string | undefined => {
    if (node?.type === "StringLiteral" && typeof node.value === "string") return node.value;
    if (node?.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
      const quasis = node.quasis as AstNode[];
      return (quasis[0]?.value as { cooked?: string } | undefined)?.cooked ?? undefined;
    }
    return undefined;
  };
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AstNode;
    const helper =
      callee.type === "Identifier" ? (callee.name as string) : callee.type === "MemberExpression" && (callee.property as AstNode).type === "Identifier" ? ((callee.property as AstNode).name as string) : undefined;
    if (!helper) return;
    const args = (node.arguments as AstNode[]) ?? [];
    const line = (arg: AstNode) => (arg.loc as { start: { line: number } } | undefined)?.start.line;
    if (SKILL_HELPERS.has(helper)) {
      const name = literal(args[0]);
      if (name !== undefined && name.startsWith("/")) found.push({ kind: "skill", via: `${helper}()`, name, skill: name, line: line(args[0]!) });
      return;
    }
    if (!TOOL_HELPERS.has(helper)) return;
    const via = helper === "fake" ? "fakes" : `${helper}()`;
    const names = helper === "calledInOrder" ? args.map((arg) => (arg.type === "ArrayExpression" ? (arg.elements as AstNode[])[0] : arg)) : [args[0]];
    for (const arg of names) {
      const name = literal(arg);
      if (name !== undefined && name.trim() !== "") found.push({ kind: "tool", via, name, line: line(arg!) });
    }
  });
  return found;
}

/**
 * The tool names written in one of the project's own source files: each string given to a `name`
 * or `...Name` prop or key (`<Tool name="x">`, `defineTool({ name: "x" })`, `callbackName="x"`),
 * and the default names of a `<Handoff>` that does not set them. A tool that is rendered only
 * after something happened in the call is missing from the render `curb check` makes, and named
 * here. The list is generous on purpose: a name in it is never reported.
 */
export function writtenToolNames(source: string): string[] {
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  } catch {
    // KEEP-JUSTIFIED: a file that does not parse names nothing; the type check reports it.
    return [];
  }
  const names = new Set<string>();
  const isNameKey = (key: string | undefined) => key !== undefined && (key === "name" || /^[a-z][A-Za-z]*Name$/.test(key));
  const keyOf = (node: AstNode | undefined): string | undefined =>
    node?.type === "Identifier" || node?.type === "JSXIdentifier" ? (node.name as string) : node?.type === "StringLiteral" ? (node.value as string) : undefined;
  const stringOf = (node: AstNode | undefined): string | undefined => {
    const value = node?.type === "JSXExpressionContainer" ? (node.expression as AstNode) : node;
    return value?.type === "StringLiteral" ? (value.value as string) : undefined;
  };
  walk(ast, (node) => {
    if (node.type === "JSXAttribute" || node.type === "ObjectProperty") {
      const key = keyOf((node.type === "JSXAttribute" ? node.name : node.key) as AstNode);
      const value = stringOf(node.value as AstNode);
      if (isNameKey(key) && value) names.add(value);
    }
    if (node.type === "JSXOpeningElement" && keyOf(node.name as AstNode) === "Handoff") {
      const given = new Set(((node.attributes as AstNode[]) ?? []).map((attribute) => keyOf(attribute.name as AstNode)));
      for (const [prop, name] of Object.entries(HANDOFF_TOOL_NAMES)) if (!given.has(prop)) names.add(name);
    }
  });
  return [...names];
}

type AstNode = { type: string; [key: string]: unknown };

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== "object" || typeof (node as AstNode).type !== "string") return;
  visit(node as AstNode);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

/** The 1-based line of the first whole-word occurrence of `name` in `source`. */
function lineOfName(source: string | undefined, name: string): number | undefined {
  if (!source || !name) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
  const index = source.split("\n").findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : index + 1;
}
