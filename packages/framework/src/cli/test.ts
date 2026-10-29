import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentLlmClient } from "../agent-session.js";
import { experimentDeclarations } from "../experiments.js";
import { anthropic, openai, type LlmDescriptor } from "../providers.js";
import { confirmationLine, runScenario, toolCallLine, type ScenarioBundle, type ScenarioResult } from "../testing/run.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "../types.js";
import {
  diagnosticsNote,
  disableConversationRecording,
  dropDiagnosticLogs,
  routeConsoleToStderr,
} from "./headless-project.js";
import {
  isScenario,
  scenario as accepted,
  type Scenario,
  type ScenarioDefinition,
  type ScenarioTurn,
} from "../testing/scenario.js";

export const TEST_USAGE = `Usage: curb test [<filter>] [--json]

Runs the conversation scenarios in src/**/*.scenario.ts headlessly, one after another, each
through the same session, skills, tools and spoken-reply rules as a call, with the LLM keys
from the project's .env. A scenario's caller is scripted lines, or an LLM that plays a caller
with a goal. Prints each transcript, then every check with pass or fail.

Every scenario is checked for: no turn errors (provider error, step limit, a tool refused
3 times in one turn), no empty agent reply, no fallback line instead of a reply, no sentence
repeated within a turn, and a clean end (end_call, the last scripted line, or maxTurns). A
simulated caller is also judged on whether it reached its goal, with the judge's reason.
Tools run for real, except those a scenario fakes (fakes): a faked tool never runs, and the
transcript marks its calls [tool <name> faked].

  <filter>  run only the scenarios whose name or file contains it (ignoring case)
  --json    print one JSON object instead:
            { passed, scenarios: [{ name, file, mode, passed, endedBy, durationMs, turns, checks,
              notes }] }

Exit code 1 when a scenario fails, or no scenario was found or matched.`;

/** The file name ending that makes a module under src/ a scenario. */
export const SCENARIO_SUFFIX = ".scenario.ts";

const NO_SCENARIOS = `No scenarios found: curb test runs every src/**/*${SCENARIO_SUFFIX} file, and there is none.
Add one, for example src/agent/first-call.scenario.ts:

  import { scenario } from "curb/testing";

  export default scenario({
    caller: { goal: "Find out what this agent can help with" },
  });

Scenarios are described in node_modules/curb/docs/agent-guide/testing.md.`;

/**
 * The small, fast model of each provider that plays the caller and judges its goal. They run
 * on the agent's own provider, whose key the project already has.
 */
export const SIMULATION_MODELS = { anthropic: "claude-haiku-5-5", openai: "gpt-5.4-mini" } as const;

export type TestArgs = { filter: string; json: boolean };

/** `curb test` arguments: `--json` anywhere, every other argument is the filter. */
export function parseTestArgs(args: readonly string[]): TestArgs {
  const words: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw new Error(`curb test: unknown option ${arg}.\n\n${TEST_USAGE}`);
    else words.push(arg);
  }
  return { filter: words.join(" ").trim(), json };
}

/** What `curb test` runs scenarios on: the project's agent and LLM provider (fakes in tests). */
export type TestHost = {
  /** A fresh runtime + session for the project's agent, built the way a call builds them. */
  createBundle(): Promise<ScenarioBundle>;
  /** The LLM the simulated caller and the judge run on, for an agent whose LLM is `llm`. */
  simulator(llm: LlmDescriptor): AgentLlmClient;
};

/** The model the simulated caller and the judge use for an agent on `llm`. KugelAudio and an
 * OpenAI-compatible endpoint serve only what they serve, so there it is the agent's own model. */
export function simulationLlm(llm: LlmDescriptor): LlmDescriptor {
  switch (llm.provider) {
    case "anthropic":
      return anthropic(SIMULATION_MODELS.anthropic);
    case "openai":
      return openai(SIMULATION_MODELS.openai);
    case "kugelaudio":
    case "openai-compatible":
      return llm;
  }
}

/** A scenario file that could not be loaded: reported as a failed scenario, never skipped. */
export type LoadFailure = { name: string; file: string; passed: false; error: string };

export type ScenarioReport = ScenarioResult | LoadFailure;

type LoadedScenario = { name: string; file: string; scenario: Scenario } | Omit<LoadFailure, "passed">;

/** Every `*.scenario.ts` under the project's src/, as sorted paths relative to the project. */
export function findScenarioFiles(projectRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(SCENARIO_SUFFIX)) {
        found.push(relative(projectRoot, path).split(sep).join("/"));
      }
    }
  };
  const source = join(projectRoot, "src");
  if (existsSync(source)) walk(source);
  return found.sort();
}

/**
 * Every scenario one file exports: its default export (named after the file unless it sets
 * `name`), then each other export `scenario()` made (named after the export).
 */
async function loadScenarios(projectRoot: string, file: string): Promise<LoadedScenario[]> {
  const fileName = basename(file, SCENARIO_SUFFIX);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(join(projectRoot, file)).href)) as Record<string, unknown>;
  } catch (error) {
    return [{ name: fileName, file, error: `${file} could not be loaded: ${describe(error)}` }];
  }
  const exported: Array<[string, unknown]> = Object.entries(module).filter(
    ([key, value]) => key !== "default" && isScenario(value),
  );
  if (module.default !== undefined) exported.unshift([fileName, module.default]);
  if (exported.length === 0) {
    return [{ name: fileName, file, error: `${file} exports no scenario. Fix: export default scenario({ ... }), with scenario from "curb/testing".` }];
  }
  return exported.map(([name, value]) => {
    try {
      const loaded = accepted(value as ScenarioDefinition);
      return { name: loaded.name ?? name, file, scenario: loaded };
    } catch (error) {
      return { name, file, error: `${file}: ${describe(error)}` };
    }
  });
}

/**
 * `curb test <args>` in the project at `projectRoot` (its .env already loaded). Writes the report
 * to `out` and returns the exit code. Framework logs go to stderr meanwhile, so stdout carries
 * only the report (one JSON object with --json).
 */
export async function testCommand(
  args: readonly string[],
  projectRoot: string,
  options: { host?: TestHost; out?: (text: string) => void } = {},
): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const { filter, json } = parseTestArgs(args);
  const files = findScenarioFiles(projectRoot);
  if (files.length === 0) {
    console.error(NO_SCENARIOS);
    return 1;
  }

  const started = performance.now();
  const restoreConsole = routeConsoleToStderr();
  try {
    const loaded: LoadedScenario[] = [];
    for (const file of files) loaded.push(...(await loadScenarios(projectRoot, file)));
    const wanted = filter.toLowerCase();
    const selected = loaded.filter(
      (entry) => !wanted || entry.name.toLowerCase().includes(wanted) || entry.file.toLowerCase().includes(wanted),
    );
    if (selected.length === 0) {
      console.error(
        `No scenario matches "${filter}". The scenarios are: ${loaded.map((entry) => `${entry.name} (${entry.file})`).join(", ")}.`,
      );
      return 1;
    }

    const host = options.host ?? (await projectHost());
    const reports: ScenarioReport[] = [];
    const header = (entry: LoadedScenario) => {
      if (!json) out(`\n--- ${entry.name} (${entry.file})\n`);
    };
    for (const entry of selected) {
      if ("error" in entry) {
        reports.push({ ...entry, passed: false });
        header(entry);
        if (!json) out(`FAIL ${entry.name}: ${entry.error}\n`);
        continue;
      }
      // Built before the header: the first build logs the agent's authoring diagnostics (stderr).
      const bundle = await host.createBundle();
      header(entry);
      const result = await runScenario({
        scenario: entry.scenario,
        name: entry.name,
        file: entry.file,
        bundle,
        simulator: host.simulator(bundle.runtime.settings.current().llm),
        ...(json ? {} : { onTurn: (turn: ScenarioTurn) => out(formatTurn(turn)) }),
      });
      reports.push(result);
      if (!json) out(formatChecks(result));
    }

    const passed = reports.every((report) => report.passed);
    out(json ? `${JSON.stringify({ passed, scenarios: reports })}\n` : formatSummary(reports, performance.now() - started));
    return passed ? 0 : 1;
  } finally {
    restoreConsole();
  }
}

/** One turn as the report prints it: the caller's line, how it answered an action waiting for
 * the caller's yes, the agent's tool calls and errors, and what the caller heard. A hang-up or a
 * skipped turn shows as a marker, not as its tool call. */
export function formatTurn(turn: ScenarioTurn): string {
  const lines: string[] = [];
  if (turn.caller !== null) lines.push(`caller: ${turn.caller}`);
  if (turn.confirmation) lines.push(`  ${confirmationLine(turn.confirmation)}`);
  for (const call of turn.toolCalls) {
    if (call.ok && (call.name === END_CALL_TOOL_NAME || call.name === SKIP_TURN_TOOL_NAME)) continue;
    lines.push(`  ${toolCallLine(call)}`);
  }
  for (const error of turn.errors) lines.push(`  [error ${error.kind}] ${error.message}`);
  lines.push(`agent:  ${turn.reply || (turn.skipped ? "(silent: skip_turn)" : "(no reply)")}`);
  if (turn.endedCall) lines.push("  [the agent ended the call]");
  return `${lines.join("\n")}\n`;
}

/** Every check (a detail's further lines indented under it), the notes, then the scenario's verdict. */
export function formatChecks(result: ScenarioResult): string {
  const lines = result.checks.flatMap((check) => {
    const [first = "", ...more] = (check.detail ?? "").split("\n");
    return [
      `  ${check.pass ? "pass" : "FAIL"}  ${check.name}${first ? `: ${first}` : ""}`,
      ...more.map((line) => `        ${line}`),
    ];
  });
  lines.push(...result.notes.map((note) => `  note  ${note}`));
  const callerTurns = result.turns.filter((turn) => turn.caller !== null).length;
  lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${callerTurns} caller turn(s), ${seconds(result.durationMs)})`);
  return `${lines.join("\n")}\n`;
}

function formatSummary(reports: readonly ScenarioReport[], durationMs: number): string {
  const failed = reports.filter((report) => !report.passed);
  const head = `\n${reports.length - failed.length} of ${reports.length} scenario(s) passed in ${seconds(durationMs)}.`;
  if (failed.length === 0) return `${head}\n`;
  return `${head} Failed: ${failed.map((report) => `${report.name} (${report.file})`).join(", ")}\n`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The project's agent on the bundle path a call uses (`createVoiceAgentBundle`), which refuses
 * to start, naming the variable, when the agent's LLM key is missing. Conversation recording is
 * turned off first: the store is for real conversations, and every scenario would add one.
 *
 * Loading the agent logs every authoring diagnostic, as a server boot does. That is curb
 * check's report and would bury the transcripts, so it becomes one note pointing there.
 */
async function projectHost(): Promise<TestHost> {
  await disableConversationRecording();
  const { getHostedAgent } = await import("../server/bootstrap.js");
  const restoreConsole = dropDiagnosticLogs();
  let diagnostics: Awaited<ReturnType<typeof getHostedAgent>>["diagnostics"];
  try {
    ({ diagnostics } = await getHostedAgent());
  } finally {
    restoreConsole();
  }
  const note = diagnosticsNote(diagnostics);
  if (note) console.error(`note: ${note}`);
  const { createVoiceAgentBundle } = await import("../voice-host.js");
  const { runAiSdkAgent } = await import("../llm/ai-sdk.js");
  return {
    async createBundle() {
      const { runtime, session, definition } = await createVoiceAgentBundle();
      return {
        runtime,
        session,
        firstTurn: definition.firstTurn,
        experiments: experimentDeclarations(definition.experiments),
      };
    },
    simulator(llm) {
      const model = simulationLlm(llm);
      return (request) => runAiSdkAgent(request, { llm: model });
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
