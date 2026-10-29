import type { AgentAssistantMessage, AgentChatMessage, LlmCallRecord } from "../llm/types.js";
import type { CompiledContext } from "../types.js";

/** Write text to the clipboard; resolves false (never throws) when the
 * Clipboard API is unavailable or denied, so callers can show a fallback. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A clean, coding-agent-optimized transcript export. The output is meant to be
 * pasted into a coding agent (Claude Code, Cursor, …) so it can improve the
 * agent's `src/agent/` code from a real run — routing descriptions, prompts,
 * tool schemas, gating. It is NOT the raw LLM payload (that's "Export trace");
 * it's the human-readable conversation plus what the agent actually did.
 */

export type TranscriptItem =
  | { role: "user"; text: string; at?: number }
  | { role: "assistant"; text: string; at?: number }
  | {
      role: "tool";
      at?: number;
      name: string;
      input?: Record<string, unknown>;
      ok: boolean;
      /** Held for the caller's yes to this read-back (`<Tool confirm>`), not run. */
      heldFor?: string;
      /** Context lines the tool changed (skill loaded, state, unlocked content). */
      contextChanged?: string[];
    };

/**
 * A snapshot of the agent's SURFACE at capture time — what it could route to
 * and call, not just what it did. Included so a coding agent sees the whole
 * picture even from a short run (e.g. "the agent had these skills + tools but
 * only routed and asked a question"). All fields optional; omitted sections
 * are skipped.
 */
export type AgentSurface = {
  /** The system prompt, and whether it is the one this conversation ran with or
   * only the one in the code now. */
  systemPrompt?: { text: string; source: "conversation" | "current code" };
  /** Active skill title at capture time (tools below are its context). */
  activeSkill?: string;
  /** Skills the agent can route to (`<Skill>` links), with routing descriptions. */
  skills?: { path: string; label?: string; description?: string }[];
  /** Tools available in the captured context. Excludes the built-in read_skill. */
  tools?: { name: string; description?: string }[];
};

const PREAMBLE = [
  "Below is a real conversation with an AI agent I built with a React-based agent framework.",
  "",
  "How the agent is authored (all under `src/agent/`):",
  "- `agent.tsx` holds the system prompt, the skills index, and global tools (via `defineAgent`).",
  "- Each `skill.tsx` is ONE routed context: `<Instruction>` (behavior), plain JSX text (facts), and `<Tool>`s (typed actions). Availability follows placement — an unrendered tool does not exist for the model.",
  "- `<Skill path description>` links carry the routing `description` the model reads to decide where to go; `read_skill` is the built-in tool that opens a skill's instructions/tools on demand.",
  "- Invariants are structural: tools are gated behind rendered state, not prompt text.",
  "",
  "Review the transcript and propose concrete edits to `src/agent/` that would make the next run better. Look for:",
  "- Misrouting / slow routing → tighten the target skill's `<Skill description>` (make it a rule, add negative cases).",
  "- Redundant questions or missing facts → adjust that skill's `<Instruction>` / text.",
  "- Wrong, failed, or awkward tool calls → fix tool names, Zod schemas, `.describe()` text, or validation messages.",
  "- Gated content revealed too early / rules routed around → strengthen the structural gate.",
  "- Verbose or off-persona replies → refine the system prompt (or voice style).",
  "",
  "Give specific file + change suggestions, then apply them if asked.",
].join("\n");

/** Compact one-line rendering of a tool's arguments. */
function formatArgs(input: Record<string, unknown> | undefined): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/** A code fence longer than any run of backticks in `text`, so a prompt that quotes
 * code cannot close it early. */
function fenced(text: string): string[] {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [fence, text, fence];
}

/** One turn. One-line text stays on the speaker's line, as it always has; multi-line
 * text is quoted beneath it, so its headings and lists stay inside the turn instead
 * of becoming headings and lists of the export. */
function turnLines(speaker: string, text: string): string[] {
  if (!text.trim().includes("\n")) return [`**${speaker}:** ${text}`];
  return [`**${speaker}:**`, ...text.trim().split("\n").map((line) => (line ? `> ${line}` : ">")), ""];
}

/** A context change under its tool call. A multi-line change (an instruction written
 * as prose) keeps its lines, indented so they stay inside the list item. */
function contextChangeLines(change: string): string[] {
  const [first, ...rest] = change.split("\n");
  return [`  - ↳ ${first}`, ...rest.map((line) => (line.trim() ? `    ${line}` : ""))];
}

/**
 * The system prompt an export shows: the one this conversation's model calls carried
 * when it made any here; for a conversation restored from the store before any new
 * turn, the one the store `recorded` for it; otherwise the one in the code now,
 * labelled as such because the conversation may have run with another (one recorded
 * before prompts were, or one that has not reached the model yet).
 */
export function exportedSystemPrompt(
  llmTrace: readonly LlmCallRecord[],
  currentCode: string | undefined,
  recorded?: string | null,
): AgentSurface["systemPrompt"] {
  const sent = llmTrace.at(-1)?.input.system;
  if (sent?.trim()) return { text: sent, source: "conversation" };
  if (recorded?.trim()) return { text: recorded, source: "conversation" };
  return currentCode?.trim() ? { text: currentCode, source: "current code" } : undefined;
}

export function buildCodingAgentTranscript(
  agentId: string,
  items: TranscriptItem[],
  surface?: AgentSurface,
): string {
  const lines: string[] = [PREAMBLE, "", `Agent: \`${agentId}\``];

  const prompt = surface?.systemPrompt;
  if (prompt?.text.trim()) {
    if (prompt.source === "conversation") {
      lines.push("", "## System prompt (sent in this conversation)", "");
    } else {
      lines.push(
        "",
        "## System prompt (current code)",
        "",
        "The prompt this conversation ran with was not recorded, so this is the one in the code now.",
        "",
      );
    }
    lines.push(...fenced(prompt.text.trim()));
  }

  if (surface?.skills && surface.skills.length > 0) {
    lines.push("", "## Skills the agent can route to");
    for (const skill of surface.skills) {
      const label = skill.label ? ` — ${skill.label}` : "";
      const description = skill.description ? ` — ${skill.description}` : " — (no routing description)";
      lines.push(`- \`${skill.path}\`${label}${description}`);
    }
  }

  if (surface?.tools) {
    const active = surface.activeSkill ? ` (in skill "${surface.activeSkill}")` : "";
    lines.push("", `## Tools available${active}`);
    if (surface.tools.length === 0) {
      lines.push("- _(no tools in this context — a routing/informational skill)_");
    } else {
      for (const tool of surface.tools) {
        lines.push(`- \`${tool.name}\`${tool.description ? ` — ${tool.description}` : ""}`);
      }
    }
  }

  lines.push("", "## Transcript", "");

  if (items.length === 0) {
    lines.push("_(no messages yet)_");
    return lines.join("\n");
  }

  // Timestamps (when the source carries them) make latency issues visible in
  // pasted transcripts — e.g. a slow follow-up or tool call.
  const clock = (at?: number) =>
    at === undefined ? "" : ` (${new Date(at).toLocaleTimeString("en-GB", { hour12: false })})`;

  for (const item of items) {
    if (item.role === "user") {
      lines.push(...turnLines(`User${clock(item.at)}`, item.text));
    } else if (item.role === "assistant") {
      if (item.text.trim()) lines.push(...turnLines(`Agent${clock(item.at)}`, item.text));
    } else {
      const args = formatArgs(item.input);
      const status = item.heldFor
        ? ` — held, runs on the caller's yes to "${item.heldFor}"`
        : item.ok
          ? ""
          : " — FAILED";
      lines.push(`- _tool_ \`${item.name}\`${args ? `(${args})` : ""}${clock(item.at)}${status}`);
      for (const change of item.contextChanged ?? []) {
        lines.push(...contextChangeLines(change));
      }
    }
  }

  return lines.join("\n");
}

/**
 * Agent surface from the live compiled context (chat): the routable skills
 * (`links`) and the tools available right now (`tools`, minus the framework
 * built-ins read_skill/skip_turn/end_call, which are `runtime`-scoped). Global tools
 * like `request_callback` show here even when the current skill is a router.
 */
export function contextToSurface(
  context: CompiledContext | null,
  systemPrompt?: AgentSurface["systemPrompt"],
): AgentSurface {
  if (!context) return { systemPrompt };
  const seen = new Set<string>();
  const skills = context.links
    .filter((link) => (seen.has(link.to) ? false : (seen.add(link.to), true)))
    .map((link) => ({ path: link.to, label: link.label, description: link.description }));
  const tools = context.tools
    .filter((tool) => tool.scope !== "runtime")
    .map((tool) => ({ name: tool.name, description: tool.description }));
  return { systemPrompt, activeSkill: context.title, skills, tools };
}

/** A reply as the export shows it: what the caller heard, and what they did not when they
 * talked over it. */
function replyText(message: AgentAssistantMessage): string {
  const cut = message.interruption;
  if (!cut) return message.content;
  return cut.spokenText
    ? `${cut.spokenText} … [the caller talked over the agent here and never heard: "${cut.unspokenText}"]`
    : `[the caller talked over this reply before any of it played and never heard: "${cut.fullText}"]`;
}

/** Chat transcript → normalized items. Pairs each assistant tool call with its
 * result message (ok + the context it changed) by tool-call id. */
export function chatMessagesToTranscript(messages: readonly AgentChatMessage[]): TranscriptItem[] {
  const results = new Map<string, { ok: boolean; contextChanged: string[] }>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, {
        ok: message.result?.ok !== false,
        contextChanged: message.contextDiff ?? [],
      });
    }
  }

  const items: TranscriptItem[] = [];
  for (const message of messages) {
    // Framework plumbing (context events, the synthetic silence follow-up)
    // stays out of the export — only the real exchange matters here.
    if (message.role === "user" && !message.kind) {
      items.push({ role: "user", text: message.content, at: message.at });
    } else if (message.role === "assistant") {
      const text = replyText(message);
      if (text.trim()) items.push({ role: "assistant", text, at: message.at });
      for (const toolCall of message.toolCalls ?? []) {
        const result = results.get(toolCall.id);
        items.push({
          role: "tool",
          at: message.at,
          name: toolCall.name,
          input: toolCall.input,
          ok: result?.ok ?? true,
          ...(toolCall.heldFor ? { heldFor: toolCall.heldFor } : {}),
          contextChanged: result?.contextChanged,
        });
      }
    }
    // tool result messages themselves are folded into the tool items above.
  }
  return items;
}
