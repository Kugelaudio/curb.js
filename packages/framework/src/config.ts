import type { ComponentType } from "react";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { assertExperiments, type AgentExperiments } from "./experiments.js";
import { assertGoals, type AgentGoals } from "./goals.js";
import { assertHooks, type CallHook } from "./hooks.js";
import type { AgentInfo } from "./info-store.js";
import { isTimeZone } from "./llm/localized.js";
import type { McpServerConfig } from "./mcp/config.js";
import type { AgentRoute } from "./routing.js";
import type { VoicePipeline } from "./server/voice/livekit-host/pipeline.js";

/** Dev-dashboard hints. Purely cosmetic — never sent to the LLM. */
export type AgentPreviewHints = {
  /** Prompt chips shown in the empty chat. */
  suggestedPrompts?: string[];
  /** Placeholder text of the chat input. */
  chatPlaceholder?: string;
};

/**
 * The words of `firstTurn: { say }`: the line itself, or a function that writes it from the
 * session info when the conversation opens (`caller.*`, `client.*`), read-only.
 */
export type AgentOpeningLine = string | ((info: AgentInfo) => string);

/** Who opens a conversation: the caller (`"user"`), a greeting the model writes (`"agent"`), or
 * exactly the line given (`{ say }`). */
export type AgentFirstTurn = "user" | "agent" | { say: AgentOpeningLine };

/**
 * Everything a framework user can tune without touching agent code. Part of
 * {@link AgentDefinition}; hosts (the WS server, the preview, embedders) read
 * it when constructing the runtime and session.
 */
export type AgentConfig = {
  /** How many skills stay loaded at once (instructions + tools). The least
   * recently used skill is evicted past this. Default: 3. */
  maxLoadedSkills?: number;
  /** Max LLM steps (tool-call rounds) per turn. Default: 8. */
  maxSteps?: number;
  /** The IANA time zone the agent lives in, e.g. "Europe/Berlin". Every LLM request
   * carries today's date and time in it, in the agent's language. Default: "UTC". */
  timeZone?: string;
  /** Cap on transcript messages sent to the LLM per step (the full transcript
   * is kept for the UI). Default: 60. */
  maxTranscriptMessages?: number;
  /** Who speaks first. `"user"` waits for the caller. `"agent"` opens a voice call with a short
   * greeting the model writes. `{ say }` opens every conversation, typed ones too, with exactly
   * that line and no model call: wording that must not vary, such as a legal notice.
   * Default: `"user"`. */
  firstTurn?: AgentFirstTurn;
  /** Changes to the LiveKit pipeline: its session options, its agent class, its events.
   * Applies to voice calls only. A module this imports stays free of runtime imports from
   * `curb/orchestration`, because the agent also loads where those cannot. */
  pipeline?: VoicePipeline;
  preview?: AgentPreviewHints;
};

/**
 * What the host renders the agent app with. `<Agent>` renders the loaded skills from it, so an
 * app needs none of it (`export function App() { ... }`); the host still passes it as props.
 */
export type AgentAppProps = {
  /** The active skill's path (most recently loaded); "" while no skill is loaded. */
  path: string;
  /** All loaded skill paths, least recently used first, active last. None at the start of
   * a conversation: it starts at the agent level and opens each skill when needed. */
  loadedPaths?: readonly string[];
  /** The skill route registry (host-resolved: filesystem discovery, or the
   * registry a `curb build` artifact carries). */
  routes: readonly AgentRoute[];
};

/**
 * One complete agent: the React app plus its configuration. The agent's module
 * (`src/agent/agent.tsx`) exports one of these; every host — WS server, voice
 * host, preview — consumes it. It is also the agent level, where every
 * conversation starts: what `app` renders inside `<Agent>` (system prompt, skills
 * index, global tools, MCP servers) is in context on every turn, and each skill
 * joins it only once opened, rendered by `<Agent>` after it.
 */
export type AgentDefinition = AgentConfig & {
  /** The agent's React tree (Agent/SystemPrompt/Skills/GlobalTools). Needs no props. */
  app: ComponentType<AgentAppProps>;
  /** Remote MCP servers this agent uses (connect/log in via the preview). */
  mcpServers?: McpServerConfig[];
  /** What a call counts as a success, by goal name: `{ tool }` when the agent ran that tool,
   * `{ judge }` when a judge finds the criterion true of the conversation. `curb build` writes
   * them into the bundle manifest; a hosting platform reports which goals each call reached. */
  goals?: AgentGoals;
  /** A/B experiments, by name: each call gets one of each experiment's weighted variants, read
   * with `useVariant(name)`. A hosting platform assigns them; `curb dev` and `curb test` draw
   * them by the same rule. */
  experiments?: AgentExperiments;
  /** Runs after the call, once its transcript and call data are final: `call.ended`. Plain async
   * code, outside React and outside any call, on a runner of its own. At least once per event, so
   * use `event.id` to do its work once. `curb dev` and `curb say` never fire it. */
  afterCall?: CallHook;
  /** Runs after the call's goals are judged, once its `afterCall` has finished: `call.evaluated`,
   * the same call plus its goal results. */
  afterEvaluation?: CallHook;
};

/** Refuse a time zone `Intl` does not know: a typo would otherwise fail the first turn of
 * every call, when the request's date line is built. */
function assertTimeZone(definition: AgentDefinition): void {
  const { timeZone } = definition;
  if (timeZone === undefined || isTimeZone(timeZone)) return;
  throw new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `defineAgent({ timeZone: ${JSON.stringify(timeZone)} }) is not an IANA time zone, so the agent cannot tell the date.`,
    location: { source: "src/agent/agent.tsx", component: "defineAgent" },
    fix: 'Use an IANA name such as "Europe/Berlin" or "America/New_York", or leave timeZone out for UTC.',
  });
}

/** An `AgentFirstTurn` that names the opening line itself. */
function isOpeningLine(firstTurn: unknown): firstTurn is { say: AgentOpeningLine } {
  return typeof firstTurn === "object" && firstTurn !== null;
}

function firstTurnError(message: string, fix: string): AgentAuthoringError {
  return new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message,
    location: { source: "src/agent/agent.tsx", component: "defineAgent" },
    fix,
  });
}

const SAY_FIX =
  'Give the exact words, e.g. firstTurn: { say: "Hello, I am Clara, the digital assistant of Example Ltd." }, ' +
  "or a function of the session info that returns them.";

/** Refuse a `firstTurn` no conversation can open with. A function's line is checked when it
 * runs, in {@link openingLine}. */
function assertFirstTurn(definition: AgentDefinition): void {
  const firstTurn: unknown = definition.firstTurn;
  if (firstTurn === undefined || firstTurn === "user" || firstTurn === "agent") return;
  if (!isOpeningLine(firstTurn)) {
    throw firstTurnError(
      `defineAgent({ firstTurn: ${JSON.stringify(firstTurn)} }) is not a way to open a conversation.`,
      'Use "user" (the caller speaks first), "agent" (the model writes a greeting) or { say: "<the exact opening line>" }.',
    );
  }
  const extra = Object.keys(firstTurn).filter((key) => key !== "say");
  if (extra.length > 0) {
    throw firstTurnError(
      `defineAgent({ firstTurn: { ${extra.join(", ")} } }) is not a firstTurn option: it takes only say.`,
      SAY_FIX,
    );
  }
  const { say } = firstTurn;
  if (typeof say === "function" || (typeof say === "string" && say.trim())) return;
  throw firstTurnError(
    `defineAgent({ firstTurn: { say: ${JSON.stringify(say) ?? String(say)} } }) has no words, so the conversation would open with silence.`,
    SAY_FIX,
  );
}

/**
 * The line a conversation opens with on `firstTurn: { say }`, for the session info when it opens;
 * undefined for any other `firstTurn`. The session calls the result once per conversation.
 * Throws when a `say` function returns anything but words.
 */
export function openingLineOf(firstTurn: AgentFirstTurn | undefined): ((info: AgentInfo) => string) | undefined {
  if (!isOpeningLine(firstTurn)) return undefined;
  const { say } = firstTurn;
  return (info) => openingLine(say, info);
}

function openingLine(say: AgentOpeningLine, info: AgentInfo): string {
  const line: unknown = typeof say === "function" ? say(Object.freeze({ ...info })) : say;
  if (typeof line === "string" && line.trim()) return line;
  throw firstTurnError(
    `defineAgent({ firstTurn: { say } }) returned ${JSON.stringify(line) ?? String(line)} instead of the opening line.`,
    "Return the exact words for every session, also one without the info the function reads " +
      "(a page that sent no client.* info, a call with no caller.phoneNumber).",
  );
}

/** Identity helper that gives the definition full type checking and
 * autocomplete at the definition site. Also catches a time zone that does
 * not exist, a `firstTurn` no conversation can open with, goals or experiments
 * no platform could evaluate or assign, and a hook that is not a function. */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  assertTimeZone(definition);
  assertFirstTurn(definition);
  assertGoals(definition.goals);
  assertExperiments(definition.experiments);
  assertHooks(definition);
  return definition;
}
