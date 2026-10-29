import { vi } from "vitest";
import type { AgentLlmClient, AgentLlmStreamStep, AgentSession } from "../agent-session.js";
import { Agent, AgentSiteRuntime, Tool, ToolInputError, defineTool, z } from "../index.js";
import { isConfirmationRequest } from "../llm/confirmation.js";
import type {
  AgentChatMessage,
  AgentRunRequest,
  AgentRunResponse,
  AgentToolCall,
  AgentTurnStreamEvent,
} from "../llm/types.js";
import type { ToolResult } from "../types.js";

/**
 * Test helpers for `<Tool confirm>`: a one-page agent with a `book_meeting` tool that asks
 * the caller first, a scripted agent LLM that also answers the confirmation check, and a
 * scripted streaming transport.
 */

export const bookSchema = z.object({
  email: z.string().email("Email address is invalid. Ask the caller again.").describe("The caller's email."),
  start: z.string().describe("The chosen slot."),
});
export type Booking = z.infer<typeof bookSchema>;

export const LISA: Booking = { email: "lisa@example.com", start: "Tuesday 15:00" };
export const LENA: Booking = { email: "lena@example.com", start: "Tuesday 15:00" };
export const readBackOf = (input: Booking) => `${input.email}, ${input.start}: is that right?`;

export function booked(input: Booking): ToolResult {
  return { ok: true, message: `Booked ${input.start} for ${input.email}.` };
}

/** The default read-back: refuses Sundays the way an author's own check would. */
function askBooking(input: Booking): string {
  if (input.start === "Sunday") throw new ToolInputError("We are closed on Sundays. Offer a weekday.");
  return readBackOf(input);
}

/** The skill {@link bookingRuntime} has open. */
export const APPOINTMENTS = "/appointments";

/** One skill, open, with a `book_meeting` tool that asks the caller first (defined with
 * `defineTool`). */
export function bookingRuntime(
  onSubmit: (input: Booking) => Promise<ToolResult> = vi.fn(async (input: Booking) => booked(input)),
  confirm: (input: Booking) => string | Promise<string> = askBooking,
) {
  const bookMeeting = defineTool({
    schema: bookSchema,
    name: "book_meeting",
    description: "Book the chosen slot.",
    confirm,
    onSubmit,
  });
  const runtime = new AgentSiteRuntime(
    <Agent>
      <agent-page path={APPOINTMENTS} title="Appointments">
        <Tool def={bookMeeting} />
      </agent-page>
    </Agent>,
  );
  runtime.loadSkill(APPOINTMENTS);
  return { runtime, onSubmit };
}

/** The agent's LLM: one scripted response per step, and the check's answers in order. */
export function scripted(steps: AgentRunResponse[], verdicts: Array<string | Error> = []) {
  const requests: AgentRunRequest[] = [];
  const checks: AgentRunRequest[] = [];
  const llm: AgentLlmClient = async (request) => {
    if (isConfirmationRequest(request)) {
      checks.push(request);
      const verdict = verdicts[checks.length - 1] ?? "unclear";
      if (verdict instanceof Error) throw verdict;
      return { text: verdict, toolCalls: [] };
    }
    requests.push(request);
    return steps[requests.length - 1] ?? { text: "", toolCalls: [] };
  };
  return { llm, requests, checks };
}

/** A streaming transport playing one scripted step per call: the text word by word, then
 * a `tool-input-start` per tool call. */
export function scriptedStream(steps: AgentRunResponse[]): AgentLlmStreamStep {
  let step = 0;
  return async function* () {
    const { text, toolCalls } = steps[step++] ?? { text: "", toolCalls: [] };
    let sofar = "";
    for (const word of text.split(/(?<= )/).filter(Boolean)) {
      sofar += word;
      yield { delta: word, text: sofar };
    }
    for (const call of toolCalls) yield { type: "tool-input-start", toolName: call.name };
    return { text: text.trim(), toolCalls };
  };
}

export const bookCall = (input: Booking, id = "c1"): AgentToolCall => ({ id, name: "book_meeting", input });
export const callsBook = (input: Booking, id?: string): AgentRunResponse => ({
  text: "",
  toolCalls: [bookCall(input, id)],
});
export const says = (text: string): AgentRunResponse => ({ text, toolCalls: [] });

export const contextEvents = (messages: AgentChatMessage[]) =>
  messages.flatMap((message) => (message.role === "user" && message.kind === "context_event" ? [message.content] : []));
export const waitingLines = (request: AgentRunRequest) =>
  request.stateSnapshot.filter((line) => line.startsWith("Waiting for the caller to confirm"));

/** Drain one stream of turn events, sorted into what the caller heard and which tools ran. */
export async function drainTurn(stream: AsyncGenerator<AgentTurnStreamEvent>) {
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return {
    events,
    deltas: events.flatMap((event) => (event.type === "delta" ? [event.delta] : [])),
    tools: events.flatMap((event) => (event.type === "tool" ? [[event.toolCall.name, event.ok] as const] : [])),
  };
}

/** Run one spoken turn on `session` and drain it. */
export function streamTurn(session: AgentSession, input: string) {
  return drainTurn(session.runTurnStream(input, { spoken: true }));
}
