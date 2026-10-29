import { heldAtEnd } from "../llm/confirmation.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { AgentSiteRuntime } from "../runtime.js";
import type { ToolResult } from "../types.js";
import type { AgentSessionBundle } from "./connection.js";

/**
 * Rebuild an agent session at an earlier point in its transcript — the shared
 * core of both chat rewind (ConnectionController) and voice rewind
 * (VoiceSession). Everything from `index` on is dropped; the environment is
 * reverted by replaying the EARLIER turns' tool calls onto a fresh runtime, so
 * loaded skills, gate/login state, and procedure progress match that point.
 *
 * MCP tools are NOT re-executed during replay (their side effects are external;
 * the transcript keeps their original results) — their names are returned in
 * `skipped` so the caller can surface, never silently drop, the divergence.
 * So are calls that cannot be replayed: the tool is gone, it fails now where
 * the recorded call succeeded, or it read a skill that is no skill any more.
 *
 * A call refused before it ran (`invalid`: unknown tool or invalid input) had no
 * effect the first time either; there is nothing to replay and nothing diverges.
 * So had a call held for the caller's yes (`<Tool confirm>`). The call their yes made
 * is never run again: it is listed in `skipped`, and its effects are not rebuilt. When
 * the kept prefix ends on the read-back of a held call, the rebuilt session holds it
 * again, so the next words answer it.
 */
export async function rebuildSessionAt(params: {
  /** Build a fresh runtime+session bundle for the agent. */
  create: (agentId: string) => Promise<AgentSessionBundle>;
  agentId: string;
  /** The live session's full transcript. */
  sourceMessages: readonly AgentChatMessage[];
  /** Cut point — messages[index..] are dropped; messages[0..index) are kept. */
  index: number;
  /** External session info (caller id, etc.) copied to the fresh runtime
   * before replay, since replayed tools may depend on info-gated state. */
  liveInfo: Record<string, unknown>;
}): Promise<{ bundle: AgentSessionBundle; kept: AgentChatMessage[]; skipped: string[] }> {
  const { create, agentId, sourceMessages, index, liveInfo } = params;
  const bundle = await create(agentId);

  if (Object.keys(liveInfo).length > 0) bundle.runtime.updateInfo({ ...liveInfo });

  const kept = sourceMessages.slice(0, index);
  const originalResults = new Map<string, ToolResult>();
  for (const message of kept) {
    if (message.role === "tool") originalResults.set(message.toolCallId, message.result);
  }
  const skipped: string[] = [];
  for (const message of kept) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.invalid) continue;
      // The caller said yes to it once; opening the conversation again must not book twice.
      if (toolCall.confirmedBy !== undefined) {
        skipped.push(toolCall.name);
        continue;
      }
      // A skill the stored conversation read that is no skill now: "/", where conversations
      // started before the agent level, or a skill since deleted. Stored conversations are kept
      // data, so it restores without that skill rather than failing or carrying a refusal of
      // read_skill into the model's context.
      if (toolCall.name === "read_skill" && !offersSkill(bundle.runtime, toolCall.input.skill)) {
        skipped.push(toolCall.name);
        continue;
      }
      const definition = bundle.runtime
        .snapshot()
        .context.tools.find((tool) => tool.name === toolCall.name);
      if (definition?.id.startsWith("mcp:")) {
        skipped.push(toolCall.name);
        continue;
      }
      let replayed: ToolResult;
      try {
        ({ result: replayed } = await bundle.runtime.callTool(toolCall.name, toolCall.input));
      } catch {
        // The tool no longer exists on the rebuilt runtime.
        skipped.push(toolCall.name);
        continue;
      }
      // Failed now but not back then: the rebuilt state lacks its effect.
      if (replayed.ok === false && originalResults.get(toolCall.id)?.ok !== false) {
        skipped.push(toolCall.name);
      }
    }
  }

  // Kept up to a read-back the caller heard: the question is still open, and their next
  // words answer it. Anywhere else nothing is held; the model asks again if it must.
  bundle.session.restoreTranscript(kept, heldAtEnd(kept));
  return { bundle, kept, skipped };
}

/** Whether read_skill on `runtime` accepts `skill` right now: a `<Skill>` link in its context
 * names it. */
function offersSkill(runtime: AgentSiteRuntime, skill: unknown): boolean {
  return runtime.snapshot().context.links.some((link) => link.to === skill);
}
