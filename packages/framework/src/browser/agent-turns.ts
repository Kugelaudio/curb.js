/**
 * `say` and `check` against the agent that runs in the page, for the coding agent's tools
 * (`tools.ts`). A turn goes over a socket of its own to the agent server, as the preview's
 * does (`server/protocol.ts`), so it runs exactly as a person's typed turn; it records a
 * conversation like any other. `check` answers the authoring diagnostics the agent's worker
 * computed when it loaded the project, which are `curb check`'s, without its type check and
 * configuration block.
 */

import type { AuthoringDiagnostic } from "../authoring.js";
import { formatAuthoringLocation } from "../authoring.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { ServerMessage } from "../server/protocol.js";
import { ToolError, type ToolDiagnostic } from "./tools.js";

/** A turn waits this long for the reply: under the platform's 40 s call wait. */
const TURN_TIMEOUT_MS = 35_000;

/** The socket the turn uses: the browser's `WebSocket` surface the page's forwarder offers. */
export type AgentSocket = Pick<WebSocket, "send" | "close" | "addEventListener">;

export interface TurnHost {
  /** A WebSocket to the agent server at `path` (`/` is the preview's). */
  openAgentSocket(path: string): AgentSocket;
  /** The authoring diagnostics of the agent that serves now, or why none serves. */
  diagnostics(): Promise<{ serving: true; diagnostics: AuthoringDiagnostic[] } | { serving: false; message: string; diagnostics: AuthoringDiagnostic[] }>;
  /** The newest conversation recorded with this user text, after `afterId`. */
  recordedConversation(text: string, afterId: number): Promise<number | null>;
  /** The newest recorded conversation id, 0 before any. */
  lastConversationId(): number;
}

export function toolDiagnostic(diagnostic: AuthoringDiagnostic): ToolDiagnostic {
  const location = formatAuthoringLocation(diagnostic.location);
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(location ? { location } : {}),
    ...(diagnostic.fix ? { fix: diagnostic.fix } : {}),
  };
}

export type SayResult = {
  reply: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  conversationId: number | null;
  errors: string[];
};

/** The reply and tool calls of the turn that started with `text`, from the transcript. */
export function turnOf(messages: readonly AgentChatMessage[], text: string): Omit<SayResult, "conversationId" | "errors"> {
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && message.content === text) {
      start = index + 1;
      break;
    }
  }
  const turn = messages.slice(start);
  const inputs = new Map<string, Record<string, unknown>>();
  for (const message of turn) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) inputs.set(call.id, call.input);
  }
  return {
    reply: turn
      .filter((message) => message.role === "assistant" && message.content.trim() !== "")
      .map((message) => message.content)
      .join("\n"),
    toolCalls: turn.flatMap((message) =>
      message.role === "tool" ? [{ name: message.toolName, input: inputs.get(message.toolCallId) ?? {}, output: message.result }] : [],
    ),
  };
}

export class AgentTurns {
  /** The conversation `say` continues unless asked for a new one. */
  private conversation: number | null = null;

  constructor(private readonly host: TurnHost) {}

  async check(): Promise<{ passed: boolean; diagnostics: ToolDiagnostic[]; output: string }> {
    const answer = await this.host.diagnostics();
    const diagnostics = answer.diagnostics.map(toolDiagnostic);
    const lines = diagnostics.map((d) => `${d.severity} ${d.code}${d.location ? ` (${d.location})` : ""}: ${d.message}${d.fix ? `\n  fix: ${d.fix}` : ""}`);
    if (!answer.serving) lines.unshift(`The agent does not load: ${answer.message}`);
    const passed = answer.serving && diagnostics.every((d) => d.severity !== "error");
    return { passed, diagnostics, output: lines.join("\n") || "No authoring diagnostics." };
  }

  async say(text: string, fresh: boolean): Promise<SayResult> {
    const resume = fresh ? null : this.conversation;
    const before = this.host.lastConversationId();
    const socket = this.host.openAgentSocket(resume === null ? "/" : `/?resume=${resume}`);
    const errors: string[] = [];
    let messages: AgentChatMessage[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        let sent = false;
        let started = false;
        const timer = setTimeout(
          () => reject(new ToolError("turn_timeout", `The agent had not finished its reply after ${TURN_TIMEOUT_MS / 1000} s.`)),
          TURN_TIMEOUT_MS,
        );
        const done = (error?: ToolError) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        socket.addEventListener("message", (event) => {
          // The page's own agent server: its frames are `ServerMessage`s (binary frames are voice audio).
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data) as ServerMessage;
          switch (frame.type) {
            case "agent_unavailable":
              return done(new ToolError("agent_unavailable", `The agent is not running: ${frame.message}`));
            case "conversations":
              // The connection is set up (agent, conversation): the turn can go.
              if (!sent) {
                sent = true;
                socket.send(JSON.stringify({ type: "user_text", text }));
              }
              return;
            case "messages":
              messages = frame.messages;
              return;
            case "running":
              if (frame.value) started = true;
              // The final `messages` frame comes before the turn reports it stopped.
              else if (started) done();
              return;
            case "missing_keys":
              errors.push(...frame.diagnostics.map((diagnostic) => diagnostic.message));
              return;
            case "error":
              errors.push(frame.message);
              return;
            default:
              return;
          }
        });
        socket.addEventListener("close", (event) => {
          done(new ToolError("agent_reloading", `The agent's connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""}); call again once it has reloaded.`));
        });
      });
    } finally {
      socket.close(1000, "turn done");
    }
    const conversationId = resume ?? (await this.host.recordedConversation(text, before));
    this.conversation = conversationId;
    return { ...turnOf(messages, text), conversationId, errors };
  }
}
