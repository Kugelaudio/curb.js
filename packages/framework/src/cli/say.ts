import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "../agent-session.js";
import type { AgentFirstTurn } from "../config.js";
import {
  diagnosticsNote,
  disableConversationRecording,
  dropDiagnosticLogs,
  routeConsoleToStderr,
} from "./headless-project.js";
import type { AgentChatMessage, AgentTurnError } from "../llm/types.js";
import type { AgentSiteRuntime } from "../runtime.js";
import { conversationState, restoreConversation, type ConversationState } from "../server/conversation-restore.js";
import { clientInfo, clientInfoProblem } from "../server/protocol.js";
import {
  confirmationLine,
  installFakes,
  playOpening,
  playTurn,
  toolCallLine,
  toolCallsOf,
  type PlayedTurn,
} from "../testing/run.js";
import {
  fakedToolProblem,
  toolResultProblem,
  type ScenarioConfirmation,
  type ScenarioToolCall,
} from "../testing/scenario.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "../types.js";

export const SAY_USAGE = `Usage: curb say [--new] [--json] "<what the caller says>"
       curb say [--new] --client key=value [--client key=value ...] "<what the caller says>"
       curb say [--new] --fake <tool>[=<json result>] [--fake ...] "<what the caller says>"

Runs ONE caller turn through the agent, headlessly, as a call runs it: the same session,
skills, tools and spoken-reply rules, end_call included, with the LLM keys from the
project's .env. Prints the reply, one line per tool call ([tool name ok|refused|held|faked]
input), errors, and the context the turn added. When the caller's words answer an action
held for their yes (<Tool confirm>), one line says how they were taken and what became of
the action: [confirmation yes|no|unclear] "<words>": <tool> ran|did not run|still waits.

A new conversation opens as a call does, before the caller's words: with the agent's
greeting (firstTurn "agent") or its fixed line (firstTurn { say }, no model call), printed
first and marked (opening).

Successive calls continue one conversation, kept in .curb/say-session.json (transcript,
loaded skills, page info and createAgentStore state; component useState starts fresh each
call). Once the agent ends the call (end_call), curb say exits 1 until --new starts
another. Turns are not recorded to the conversation store.

  --new               start a new conversation with this turn; alone, just reset it
  --client key=value  set the page info client.<key> before the turn, as the page an agent
                      is embedded in sends it; kept for later turns, reset by --new.
                      Repeatable. A key is a letter, then up to 39 letters, digits or
                      underscores; a value is at most 256 characters.
  --fake <tool>[=<json result>]
                      never run <tool>'s onSubmit: its calls get this result instead, by
                      default {"ok":true,"message":"Done."}. The tool still checks the
                      input as on a real call, and a confirm tool still waits for the
                      caller's yes. Kept for later turns (a new result for a tool replaces
                      the old one), reset by --new. Repeatable.
  --json              print one JSON object instead:
                      { opening, reply, confirmation, toolCalls: [{ name, input, ok, result,
                        heldFor, faked }], errors, contextDiff, skillPath, turn, endedCall }

Exit code 1 when the turn errored: provider error, timeout, or the step limit (often a
tool the model keeps calling with input it refuses). An errored turn is not saved, unless
it ran a tool first: then it is, so the tool does not run twice.`;

/** Where the conversation lives, relative to the project root. */
export const SAY_SESSION_PATH = join(".curb", "say-session.json");

const SAY_SESSION_VERSION = 1;
/** Added to a step-limit error: a loop is the usual cause, more steps rarely the fix. */
const STEP_LIMIT_HINT = " Look first for a tool the model keeps calling, or one it is refused.";
/** Context-diff lines the text output shows; --json carries all of them. */
const PRINTED_CONTEXT_LINES = 30;
const CALL_ENDED =
  'The call has ended: the agent hung up (end_call). Start a new one with curb say --new "<what the caller says>".';
/** What the calls of a tool faked with `--fake <tool>` get, when no result follows the name. */
const DEFAULT_FAKE_RESULT: ToolResult = { ok: true, message: "Done." };

export type SayArgs = {
  text: string;
  fresh: boolean;
  json: boolean;
  /** `--client key=value`: page info by key, without `client.`. */
  client: Record<string, string>;
  /** `--fake <tool>[=<json result>]`: the result each faked tool's calls get, by tool name. */
  fakes: Record<string, ToolResult>;
};

/** `curb say` arguments: flags anywhere, every other argument is the caller's words. */
export function parseSayArgs(args: readonly string[]): SayArgs {
  const words: string[] = [];
  let fresh = false;
  let json = false;
  const client: Record<string, string> = {};
  const fakes: Record<string, ToolResult> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--new") fresh = true;
    else if (arg === "--json") json = true;
    else if (arg === "--client") {
      index += 1;
      const [key, value] = clientArg(args[index]);
      client[key] = value;
    } else if (arg === "--fake") {
      index += 1;
      const [tool, result] = fakeArg(args[index]);
      fakes[tool] = result;
    } else if (arg.startsWith("--")) throw new Error(`curb say: unknown option ${arg}.\n\n${SAY_USAGE}`);
    else words.push(arg);
  }
  return { text: words.join(" ").trim(), fresh, json, client, fakes };
}

/** The `<tool>[=<json result>]` after `--fake`, held to what a scenario's fakes must be. */
function fakeArg(arg: string | undefined): [string, ToolResult] {
  if (arg === undefined || arg.startsWith("--")) {
    throw new Error(
      `curb say: --fake takes the tool to fake, e.g. --fake create_claim, optionally with the result its calls get: ` +
        `--fake 'create_claim={"ok":false,"message":"The CRM is down."}'.\n\n${SAY_USAGE}`,
    );
  }
  const at = arg.indexOf("=");
  const tool = at < 0 ? arg : arg.slice(0, at);
  const toolProblem = fakedToolProblem(tool);
  if (toolProblem) throw new Error(`curb say: --fake ${arg}: ${toolProblem}.`);
  if (at < 0) return [tool, { ...DEFAULT_FAKE_RESULT }];
  let result: unknown;
  try {
    result = JSON.parse(arg.slice(at + 1));
  } catch (error) {
    throw new Error(
      `curb say: --fake ${arg}: the result is not JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `Quote it for the shell, e.g. --fake '${tool}={"ok":true,"message":"Done."}'.`,
    );
  }
  const problem = toolResultProblem(result);
  if (problem) throw new Error(`curb say: --fake ${arg}: ${problem}.`);
  return [tool, result as ToolResult];
}

/** The `key=value` after `--client`, held to the limits every route applies to page info. */
function clientArg(arg: string | undefined): [string, string] {
  const at = arg?.indexOf("=") ?? -1;
  if (arg === undefined || at < 0) {
    throw new Error(`curb say: --client takes key=value, e.g. --client event=webinar-11-04.\n\n${SAY_USAGE}`);
  }
  const key = arg.slice(0, at);
  const value = arg.slice(at + 1);
  const problem = clientInfoProblem(key, value);
  if (problem) throw new Error(`curb say: --client ${arg}: ${problem}`);
  return [key, value];
}

/** One conversation between `curb say` calls: its transcript and its state (loaded skills, store
 * data, page info from `--client`, an action held for the caller's yes), as every route that
 * continues a conversation keeps it (`ConversationState`), and the tools `--fake` replaced. */
export type SaySession = ConversationState & {
  version: typeof SAY_SESSION_VERSION;
  agentId: string;
  /** Caller turns so far. */
  turns: number;
  messages: AgentChatMessage[];
  /** The agent ended the call (end_call): only a new conversation (`--new`) goes on. */
  ended?: boolean;
  /** `--fake` of this and earlier turns: the result each faked tool's calls get, by tool name. */
  fakes?: Record<string, ToolResult>;
};

/** What a call would build for the project: a fresh runtime and session, plus anything the
 * host noticed while building it that the caller should know. */
export type SayBundle = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
  agentId: string;
  /** `defineAgent({ firstTurn })`: with "agent", a new conversation opens with the model's greeting.
   * The session itself opens with the fixed line of `{ say }`. */
  firstTurn?: AgentFirstTurn;
  notes?: string[];
};

export type SayHost = {
  /** A fresh runtime + session for the project's agent, on the path a call uses. */
  createBundle(): Promise<SayBundle>;
  /** Every skill route the agent defines. */
  skillPaths(agentId: string): Promise<readonly string[]>;
};

/** One tool call of the turn, as `curb test` reports it: held for the caller's yes, faked, ok
 * or refused. */
export type SayToolCall = ScenarioToolCall;

export type SayError = { kind: AgentTurnError["kind"]; message: string };

/** What the agent said before the caller's words, on the turn that started the conversation. */
export type SayOpening = { reply: string; toolCalls: SayToolCall[]; errors: SayError[] };

export type SayResult = {
  /** The call's opening (`firstTurn` "agent" or `{ say }`) when this turn started the conversation;
   * null otherwise. */
  opening: SayOpening | null;
  reply: string;
  /** How the caller's words answered an action waiting for their yes (`<Tool confirm>`); null
   * when none waited. */
  confirmation: ScenarioConfirmation | null;
  toolCalls: SayToolCall[];
  errors: SayError[];
  /** Context lines the turn's tool calls (and the opening's) added. */
  contextDiff: string[];
  /** The active skill after the turn; "" while the agent has read none (the agent level). */
  skillPath: string;
  /** This turn's number in the conversation, from 1. */
  turn: number;
  /** The agent ended the call (end_call) in this turn. */
  endedCall: boolean;
};

/**
 * Run one caller turn: rebuild the saved conversation on a fresh session (or start one, which
 * opens as a call does), run the text as a spoken turn, save the conversation again and report
 * what happened. A turn that failed (provider error, timeout) is not saved, so the same `curb say`
 * can be run again once the cause is fixed, unless it ran a tool before it failed: running that
 * turn again would run the tool twice, so it is saved. `notes` are things the caller should
 * know about the saved state. The saved conversation's fakes and this turn's stand in for their
 * tools, as a scenario's do in `curb test`.
 */
export async function runSayTurn(params: {
  text: string;
  statePath: string;
  fresh: boolean;
  /** `--client` for this turn, by key without `client.`. */
  client?: Readonly<Record<string, string>>;
  /** `--fake` for this turn: the result each faked tool's calls get, by tool name. */
  fakes?: Readonly<Record<string, ToolResult>>;
  host: SayHost;
}): Promise<{ result: SayResult; notes: string[] }> {
  const saved = params.fresh ? null : readSaySession(params.statePath);
  if (saved?.ended) throw new Error(CALL_ENDED);
  const bundle = await params.host.createBundle();
  const notes = [...(bundle.notes ?? [])];
  const { runtime, session } = bundle;
  // A call: the model may hang up, as it may on a voice call and in curb test.
  let endedCall = false;
  runtime.setEndCallRequest(() => {
    endedCall = true;
  });
  const fakes = { ...saved?.fakes, ...params.fakes };
  const faked = Object.keys(fakes).length > 0 ? installFakes(runtime, fakes).gave : undefined;

  let opening: PlayedTurn | null = null;
  if (saved) {
    notes.push(...(await continueSaved(bundle, saved, params.host)));
    // Page info given now that differs from the saved: the model learns of the change.
    session.updateInfo(clientInfo(params.client ?? {}));
  } else {
    // A new call: the page's info is on it before the agent opens, and the opening reads it.
    session.updateInfo(clientInfo(params.client ?? {}));
    opening = await playOpening(session, bundle.firstTurn);
  }
  let played: PlayedTurn = { reply: "", errors: [], messages: [], confirmation: null };
  if (endedCall) notes.push('The agent hung up in its opening, so your words were not said. Start over with curb say --new "...".');
  else played = await playTurn(session, params.text);

  const turnMessages = [...(opening?.messages ?? []), ...played.messages];
  const turn = (saved?.turns ?? 0) + (played.messages.length > 0 ? 1 : 0);
  const errors = [...hinted(opening?.errors ?? []), ...hinted(played.errors)];
  const failed = errors.some((error) => error.kind !== "step_limit");
  // A tool that ran before the failure (a booking, a yes the caller gave) must not run twice.
  const ran = ranTools(turnMessages);
  if (failed && ran.length === 0) {
    notes.push(
      "This turn failed, so it was not added to the conversation: fix the cause and run the same curb say again.",
    );
  } else {
    if (failed) {
      notes.push(
        `This turn failed after running tools (${ran.join(", ")}), so it was saved anyway: running it again ` +
          "would run them twice. Continue with the next caller line, or start over with curb say --new.",
      );
    }
    writeSaySession(params.statePath, {
      version: SAY_SESSION_VERSION,
      agentId: bundle.agentId,
      turns: turn,
      messages: session.messages,
      ...conversationState(runtime, session),
      ...(endedCall ? { ended: true } : {}),
      ...(faked ? { fakes } : {}),
    });
  }

  const skillPath = runtime.snapshot().context.path;
  return {
    result: {
      opening: opening && {
        reply: opening.reply,
        toolCalls: toolCallsOf(opening.messages, faked),
        errors: hinted(opening.errors),
      },
      reply: played.reply,
      confirmation: played.confirmation,
      toolCalls: toolCallsOf(played.messages, faked),
      errors: hinted(played.errors),
      contextDiff: turnMessages.flatMap((message) => (message.role === "tool" ? message.contextDiff : [])),
      skillPath,
      turn,
      endedCall,
    },
    notes,
  };
}

/** The errors as `curb say` reports them: a step-limit error says where to look first. */
function hinted(errors: readonly SayError[]): SayError[] {
  return errors.map((error) => (error.kind === "step_limit" ? { ...error, message: `${error.message}${STEP_LIMIT_HINT}` } : error));
}

/**
 * Continue the saved conversation on a fresh bundle (`restoreConversation`: no tool call runs
 * again, so a booking or an email does not repeat on every call). Returns notes about what could
 * not be restored.
 */
async function continueSaved(bundle: SayBundle, saved: SaySession, host: SayHost): Promise<string[]> {
  const skillPaths = await host.skillPaths(bundle.agentId);
  try {
    return restoreConversation(bundle, { messages: saved.messages, state: saved }, { skillPaths });
  } catch (error) {
    throw new Error(
      `curb say could not continue the saved conversation: ${error instanceof Error ? error.message : String(error)}\n` +
        'Fix: start a new one with curb say --new "<what the caller says>".',
      { cause: error },
    );
  }
}

/** The tools a turn's messages ran, each once, in order: every call not refused or held. */
function ranTools(turnMessages: readonly AgentChatMessage[]): string[] {
  const names = turnMessages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []).filter((call) => !call.invalid).map((call) => call.name) : [],
  );
  return [...new Set(names)];
}

/** The result as `curb say` prints it without --json: the opening first, each of its lines marked. */
export function formatSayResult(result: SayResult): string {
  const lines: string[] = [];
  if (result.opening) {
    const { reply, toolCalls, errors } = result.opening;
    lines.push(
      ...[reply || "(no reply)", ...toolLines(toolCalls), ...errorLines(errors)].map((line) => `(opening) ${line}`),
    );
  }
  lines.push(
    result.reply || "(no reply)",
    ...(result.confirmation ? [confirmationLine(result.confirmation)] : []),
    ...toolLines(result.toolCalls),
    ...errorLines(result.errors),
  );
  if (result.contextDiff.length > 0) {
    lines.push("[context added]");
    lines.push(...result.contextDiff.slice(0, PRINTED_CONTEXT_LINES).map((line) => `+ ${line}`));
    const more = result.contextDiff.length - PRINTED_CONTEXT_LINES;
    if (more > 0) lines.push(`+ ... ${more} more line(s); curb say --json has all of them`);
  }
  if (result.endedCall) lines.push("[the agent ended the call]");
  lines.push(`[turn ${result.turn}, ${result.skillPath ? `skill ${result.skillPath}` : "no skill read"}]`);
  return lines.join("\n");
}

/** One line per tool call. The hang-up shows as its marker, not as its tool call. */
function toolLines(toolCalls: readonly SayToolCall[]): string[] {
  return toolCalls.flatMap((call) => (call.name === END_CALL_TOOL_NAME && call.ok ? [] : [toolCallLine(call)]));
}

function errorLines(errors: readonly SayError[]): string[] {
  return errors.map((error) => `[error ${error.kind}] ${error.message}`);
}

export function readSaySession(path: string): SaySession | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).\n` +
        'Fix: start a new conversation with curb say --new "<what the caller says>".',
    );
  }
  const session = parsed as Partial<SaySession> | null;
  if (
    session?.version !== SAY_SESSION_VERSION ||
    typeof session.agentId !== "string" ||
    typeof session.turns !== "number" ||
    !Array.isArray(session.messages) ||
    !Array.isArray(session.loadedSkills) ||
    typeof session.stores !== "object" ||
    session.stores === null ||
    (session.client !== undefined && (typeof session.client !== "object" || session.client === null)) ||
    (session.ended !== undefined && typeof session.ended !== "boolean") ||
    (session.fakes !== undefined && (typeof session.fakes !== "object" || session.fakes === null))
  ) {
    throw new Error(
      `${path} is not a curb say conversation this version can continue.\n` +
        'Fix: start a new conversation with curb say --new "<what the caller says>".',
    );
  }
  return session as SaySession;
}

function writeSaySession(path: string, session: SaySession): void {
  mkdirSync(dirname(path), { recursive: true });
  // Written whole, then renamed: an interrupted write never leaves half a conversation.
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(session, null, 2)}\n`);
  renameSync(partial, path);
}

/**
 * `curb say <args>` in the project at `projectRoot` (its .env already loaded). Writes the
 * result to `out` and returns the exit code. Framework logs go to stderr meanwhile, so stdout
 * carries only the result (one JSON object with --json).
 */
export async function sayCommand(
  args: readonly string[],
  projectRoot: string,
  options: { host?: SayHost; out?: (text: string) => void } = {},
): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const { text, fresh, json, client, fakes } = parseSayArgs(args);
  const statePath = join(projectRoot, SAY_SESSION_PATH);
  if (!text) {
    if (!fresh) {
      console.error(SAY_USAGE);
      return 1;
    }
    rmSync(statePath, { force: true });
    out(json ? `${JSON.stringify({ reset: true })}\n` : "Started a new conversation: the next curb say opens it.\n");
    return 0;
  }

  const restoreConsole = routeConsoleToStderr();
  let outcome: Awaited<ReturnType<typeof runSayTurn>>;
  try {
    outcome = await runSayTurn({ text, statePath, fresh, client, fakes, host: options.host ?? (await projectHost()) });
  } finally {
    restoreConsole();
  }
  for (const note of outcome.notes) console.error(`note: ${note}`);
  out(`${json ? JSON.stringify(outcome.result) : formatSayResult(outcome.result)}\n`);
  const { errors, opening } = outcome.result;
  return errors.length > 0 || (opening?.errors.length ?? 0) > 0 ? 1 : 0;
}

/**
 * The project's agent on the bundle path a call uses (`createVoiceAgentBundle`). Conversation
 * recording is turned off first: this conversation lives in .curb/say-session.json, and
 * recording it would store a new partial copy of it on every call.
 *
 * Building the bundle logs every authoring diagnostic, as a server boot does. Repeated on
 * every turn they would bury the reply, so they become one note pointing at `curb check`.
 */
async function projectHost(): Promise<SayHost> {
  await disableConversationRecording();
  const { createVoiceAgentBundle } = await import("../voice-host.js");
  const { getHostedAgent } = await import("../server/bootstrap.js");
  return {
    async createBundle() {
      const restoreConsole = dropDiagnosticLogs();
      let bundle: Awaited<ReturnType<typeof createVoiceAgentBundle>>;
      try {
        bundle = await createVoiceAgentBundle();
      } finally {
        restoreConsole();
      }
      const note = diagnosticsNote((await getHostedAgent(bundle.agentId)).diagnostics);
      return { ...bundle, firstTurn: bundle.definition.firstTurn, notes: note ? [note] : [] };
    },
    skillPaths: async (agentId) => (await getHostedAgent(agentId)).routes.map((route) => route.path),
  };
}
