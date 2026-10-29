import type { AgentSiteRuntime } from "../runtime.js";
import type { ToolCallOutcome, ToolDefinition, ToolResult } from "../types.js";
import type { AgentChatMessage, AgentRunRequest, AgentRunResponse, AgentToolCallRecord } from "./types.js";

/**
 * Actions that run only on the caller's yes (`<Tool confirm>`).
 *
 * The model's call of such a tool never runs it. The session says the tool's read-back and
 * then holds ONE pending action; once the caller heard the read-back, their next words are
 * checked against it by one small call on the agent's own LLM, and only a yes runs the
 * tool, in code, as a call of its own. Words said before the read-back was heard to its end
 * drop it. This module is the hold, that check, the lines the model reads and where a
 * transcript shows a held call; the session owns the pending action and the transcript.
 */

/** A call of a `confirm` tool that waits for the caller's answer. A session holds at most one. */
export type PendingConfirmation = {
  toolName: string;
  /** The model's input, validated when the call was held. */
  input: Record<string, unknown>;
  /** The question the caller heard, word for word. */
  readBack: string;
  /** The held call's id. The call the caller's yes makes is `<id>_yes`, so it is unique in
   * the conversation however many processes continue it. */
  toolCallId: string;
  /** The skill the held tool came from; none for a global tool. A yes runs the tool only
   * while that skill still owns its name. */
  skillPath?: string;
  /** The action this one replaced when it was held. It will not run. */
  replaces?: { toolName: string; readBack: string };
  /** How many of the session's inputs had arrived when the caller was asked. An input already
   * waiting then was said before the question, so it neither answers nor drops it. */
  heldAt: number;
  /** How many inputs had arrived when the caller had heard the read-back to its end: as it is
   * said on text, and on a voice host once it reports the reply played to its end. Unset until
   * then. Only a later input answers it; the caller's words before that drop it. */
  heardAt?: number;
};

/** A held call before the session asks the caller: everything but when. */
export type HeldCall = Omit<PendingConfirmation, "heldAt" | "heardAt">;

/** How the caller's words answer the read-back. Anything not clearly yes or no is unclear. */
export type ConfirmationVerdict = "yes" | "no" | "unclear";

const CHECK_TITLE = "confirmation";

const CHECK_INSTRUCTION = [
  "You judge one answer on a call. The agent read an action back to the caller as a question, and the caller answered.",
  "Reply with exactly one word, in English:",
  "yes: the caller clearly agrees to the action as it was read back.",
  "no: the caller declines, wants to stop, or corrects or changes any detail.",
  "unclear: anything else, such as a question, another topic, or a hesitant or partial answer.",
].join("\n");

/** The check of the caller's `answer` to `readBack`: a short instruction and the two texts,
 * with no tools and no transcript, so it stays small and fast. */
export function confirmationRequest(readBack: string, answer: string): AgentRunRequest {
  return {
    systemPrompt: CHECK_INSTRUCTION,
    skillTitle: CHECK_TITLE,
    stateSnapshot: [`question: ${readBack}`, `answer: ${answer}`],
    tools: [],
    messages: [],
  };
}

/** Whether `request` is the confirmation check, for a transport that answers it differently
 * (a smaller model, a test double). */
export function isConfirmationRequest(request: AgentRunRequest): boolean {
  return request.skillTitle === CHECK_TITLE && request.systemPrompt === CHECK_INSTRUCTION;
}

/** The verdict in the check's reply: its first word when that is yes or no, else unclear. */
export function readVerdict(reply: string): ConfirmationVerdict {
  const word = reply.toLowerCase().match(/[a-z]+/)?.[0];
  return word === "yes" || word === "no" ? word : "unclear";
}

/**
 * Ask the agent's own LLM client the check `request` ({@link confirmationRequest}). A check
 * that fails, or does not answer within `timeoutMs`, counts as unclear and `failed` says
 * why; one that `signal` cancels rejects, so a cancelled turn stays cancelled.
 */
export async function checkAnswer(
  llm: (request: AgentRunRequest) => Promise<AgentRunResponse>,
  request: AgentRunRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ verdict: ConfirmationVerdict; failed?: { error: unknown } }> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`The confirmation check did not answer within ${timeoutMs} ms.`)),
    timeoutMs,
  );
  const check = AbortSignal.any([signal, deadline.signal]);
  let onAbort = () => {};
  try {
    const response = await new Promise<AgentRunResponse>((resolve, reject) => {
      onAbort = () => reject(check.reason);
      check.addEventListener("abort", onAbort, { once: true });
      llm({ ...request, signal: check }).then(resolve, reject);
    });
    return { verdict: readVerdict(response.text) };
  } catch (error) {
    signal.throwIfAborted();
    return { verdict: "unclear", failed: { error } };
  } finally {
    clearTimeout(timer);
    check.removeEventListener("abort", onAbort);
  }
}

/**
 * Why the model's call of a `confirm` tool did not run, on its record. The step is published
 * with it before the tool reads the call back, so no stored copy shows the call as one that
 * ran; the read-back is added once the tool said it.
 */
export function heldMark(readBack?: string): string {
  return readBack === undefined
    ? "Not run: held for the caller's yes."
    : `Not run: held for the caller's yes to "${readBack}".`;
}

/**
 * Hold the model's call of a `confirm` tool instead of running it: the tool reads the
 * input back, and that is the action to ask the caller about (`held`), in place of
 * `current`. Wrong input comes back as the failed result the model corrects from. The
 * record is marked as not run either way, so rewind never replays it into a run. The skill
 * is the one whose tool reads the call back now: an earlier call of the same step may have
 * loaded another one.
 */
export async function holdCall(
  runtime: Pick<AgentSiteRuntime, "readBack" | "toolDefinition">,
  toolCall: AgentToolCallRecord,
  current: PendingConfirmation | null,
): Promise<{ toolCall: AgentToolCallRecord; outcome: ToolCallOutcome; held?: HeldCall }> {
  const skillPath = runtime.toolDefinition(toolCall.name)?.skillPath;
  const asked = await runtime.readBack(toolCall.name, toolCall.input);
  const record: AgentToolCallRecord = {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    ...(skillPath ? { skillPath } : {}),
  };
  if ("result" in asked) {
    const invalid = asked.result.message ?? `Invalid input for "${toolCall.name}".`;
    return { toolCall: { ...record, invalid }, outcome: { result: asked.result, contextDiff: [] } };
  }
  const held: HeldCall = {
    toolName: toolCall.name,
    input: toolCall.input,
    readBack: asked.readBack,
    toolCallId: toolCall.id,
    ...(skillPath ? { skillPath } : {}),
    // Another tool's open question goes unanswered: say so. The same tool again is a correction.
    ...(current && current.toolName !== toolCall.name
      ? { replaces: { toolName: current.toolName, readBack: current.readBack } }
      : {}),
  };
  return {
    toolCall: { ...record, invalid: heldMark(held.readBack), heldFor: held.readBack },
    outcome: { result: heldResult(held), contextDiff: [] },
    held,
  };
}

/**
 * The record of the call the caller's yes makes: the held input, confirmed by `words`, with
 * an id derived from the held call's (provider ids keep to `[a-zA-Z0-9_-]`). Marked as not
 * run when the tool left the context after it was held, or its name now belongs to another
 * skill than the one the caller was asked about.
 */
export function confirmedCall(
  runtime: Pick<AgentSiteRuntime, "toolDefinition">,
  pending: PendingConfirmation,
  words: string,
): AgentToolCallRecord {
  const definition = runtime.toolDefinition(pending.toolName);
  const owner = (path: string | undefined) => (path ? `skill "${path}"` : "the global tools");
  const invalid = !definition
    ? `${pending.toolName} is not available anymore, so nothing was done.`
    : definition.skillPath !== pending.skillPath
      ? `The ${pending.toolName} the caller said yes to belonged to ${owner(pending.skillPath)}; that name now belongs to ` +
        `${owner(definition.skillPath)}, so nothing was done. Call it again if the caller still wants it.`
      : undefined;
  return {
    id: `${pending.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_")}_yes`,
    name: pending.toolName,
    input: pending.input,
    ...(pending.skillPath ? { skillPath: pending.skillPath } : {}),
    ...(invalid ? { invalid } : {}),
    confirmedBy: words,
  };
}

/**
 * The held call whose read-back is `messages[index]`: the assistant's words right after the
 * tool results of the step that held the call. Null for any other message.
 */
export function heldCallOf(messages: readonly AgentChatMessage[], index: number): AgentToolCallRecord | null {
  const readBack = messages[index];
  if (readBack?.role !== "assistant" || readBack.toolCalls?.length) return null;
  let at = index - 1;
  while (messages[at]?.role === "tool") at -= 1;
  const step = messages[at];
  if (at === index - 1 || step?.role !== "assistant") return null;
  return step.toolCalls?.find((call) => call.heldFor !== undefined) ?? null;
}

/** Whether the newest reply in `messages` is the read-back of `pending`. */
export function newestReplyAsks(messages: readonly AgentChatMessage[], pending: HeldCall): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content) return heldCallOf(messages, index)?.id === pending.toolCallId;
  }
  return false;
}

/**
 * The action a transcript ends asking about: its last message is the read-back of a held
 * call that no voice host reported cut off. A session rebuilt from the transcript (rewind,
 * reopening a stored conversation) asks it again, so the caller's next words answer it.
 */
export function heldAtEnd(messages: readonly AgentChatMessage[]): HeldCall | null {
  const call = heldCallOf(messages, messages.length - 1);
  const readBack = messages.at(-1);
  if (!call?.heldFor || readBack?.role !== "assistant" || readBack.interruption) return null;
  return {
    toolName: call.name,
    input: call.input,
    readBack: call.heldFor,
    toolCallId: call.id,
    ...(call.skillPath ? { skillPath: call.skillPath } : {}),
  };
}

/** The result the model gets for its own call of a `confirm` tool: nothing happened yet. */
export function heldResult(held: HeldCall): ToolResult {
  return {
    ok: false,
    message:
      `Held, not run: nothing has happened yet. The caller is now asked "${held.readBack}". ` +
      `If they say yes, ${held.toolName} runs and you get its result; until then never say or imply that it is done.` +
      replacedNote(held),
  };
}

/** Names the open question a hold replaced, which now goes unanswered. */
function replacedNote({ replaces }: HeldCall): string {
  return replaces ? ` This replaces the held ${replaces.toolName} ("${replaces.readBack}"); it will not run.` : "";
}

/** The answer to end_call in a step that asks the caller: their answer is still to come. */
export const CALL_STAYS_OPEN = "Not run: the call stays open while the caller is asked to confirm.";

/** The answer to a second `confirm` call in a step that already asks the caller. */
export function oneQuestionAtATime(held: HeldCall): string {
  return `Not run: this turn already asks the caller about ${held.toolName}. One question at a time; call it again after they answered.`;
}

/** The line in the model's current context while an action waits for the caller. */
export function pendingLine(pending: PendingConfirmation): string {
  return (
    `Waiting for the caller to confirm: "${pending.readBack}" (${pending.toolName}). ` +
    `It runs only when the caller says yes; it has not run yet.${replacedNote(pending)}`
  );
}

/** What the model learns when the caller spoke before the read-back played to its end: the
 * question was not asked. */
export function cutReadBackNote(pending: PendingConfirmation): string {
  return (
    `The caller cut off the question "${pending.readBack}" before its end, so it was not asked and nothing was done. ` +
    `Call ${pending.toolName} again so the whole question is read back.`
  );
}

/** What the model learns when the caller's answer was no. */
export function declinedNote(pending: PendingConfirmation, words: string): string {
  return `The caller did not confirm: "${words}". Nothing was done; ${pending.toolName} did not run.`;
}

/** What the model learns when the caller's answer was neither a clear yes nor a no. */
export function unclearNote(pending: PendingConfirmation, words: string): string {
  return `The caller's answer was not a clear yes: "${words}". Nothing was done yet; ${pending.toolName} still waits for their yes. Ask once more, briefly.`;
}

/** A `confirm` tool as the model sees it: its description says that a call asks the caller
 * first, so the model neither asks for the confirmation itself nor reports a held call as done. */
export function withConfirmNote(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    description:
      `${tool.description} Calling this tool does not run it yet: the caller first hears its details read back and must say yes. ` +
      "Call it as soon as you have the details, without asking for that confirmation yourself, and never say it is done before you see its result.",
  };
}
