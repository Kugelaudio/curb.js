import { vi } from "vitest";
import type { AgentLlmClient } from "../agent-session.js";
import { AgentSession } from "../agent-session.js";
import { Agent, AgentSiteRuntime, GlobalTools, Text, Tool, createAgentStore, z } from "../index.js";
import type { AgentRunResponse, AgentToolCall } from "../llm/types.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "../types.js";

/**
 * Test helpers for scenarios that read the agent's state: a one-level agent with a task list in
 * a `createAgentStore` store, a tool that only changes that store (`add_task`) and one that
 * reaches outside the call (`send_summary`), and LLMs that play it from a script.
 */

type Task = { title: string; done: boolean };

const useTasks = createAgentStore<{ tasks: Task[]; add: (title: string) => void }>("tasks", (set) => ({
  tasks: [],
  add: (title) => set((state) => ({ tasks: [...state.tasks, { title, done: false }] })),
}));

function TaskList({ send }: { send: (input: { to: string }) => Promise<ToolResult> }) {
  const tasks = useTasks((state) => state.tasks);
  const add = useTasks((state) => state.add);
  return (
    <>
      <Text>{tasks.length === 0 ? "No tasks yet." : `Open tasks: ${tasks.map((task) => task.title).join(", ")}.`}</Text>
      <GlobalTools>
        <Tool
          schema={z.object({ title: z.string().min(1).describe("The task.") })}
          name="add_task"
          description="Add a task to the list."
          onSubmit={(input) => {
            add(input.title);
            return { ok: true };
          }}
        />
        <Tool
          schema={z.object({ to: z.string().min(1).describe("Who gets the summary.") })}
          name="send_summary"
          description="Send the list to someone."
          onSubmit={send}
        />
      </GlobalTools>
    </>
  );
}

/** A fresh task agent on `llm`, and the handler behind its `send_summary`. */
export function tasksBundle(llm: AgentLlmClient, send = vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: "Sent." }))) {
  const runtime = new AgentSiteRuntime(
    <Agent>
      <TaskList send={send} />
    </Agent>,
  );
  return { runtime, session: new AgentSession(runtime, llm), send };
}

export const says = (text: string): AgentRunResponse => ({ text, toolCalls: [] });
export const calls = (...toolCalls: AgentToolCall[]): AgentRunResponse => ({ text: "", toolCalls });
export const addTask = (title: string): AgentToolCall => ({ name: "add_task", input: { title } });
export const sendSummary = (to: string): AgentToolCall => ({ name: "send_summary", input: { to } });
export const hangUp = (goodbye: string): AgentRunResponse => calls({ name: END_CALL_TOOL_NAME, input: { goodbye } });

/** An agent LLM that plays `steps` in order, one per request. */
export function steps(responses: AgentRunResponse[]): AgentLlmClient {
  const left = [...responses];
  return async () => left.shift() ?? says("(script ended)");
}
