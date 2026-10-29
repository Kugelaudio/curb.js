import { useState } from "react";
import { FlaskConicalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { CompiledContext, LoadedSkill } from "../types.js";

/**
 * What the agent has in view, and what entered it since the caller's last message: the
 * Context tab marks those skills, tools and instructions "New" until the next message.
 * People meeting the preview first took the context for settings to edit, so the skill
 * sheet also says which copy of a skill it shows.
 */

/** What the model has in view: the skills in its context, the tools it can call and the
 * instructions it reads. */
export type AgentViewSnapshot = {
  skills: readonly string[];
  tools: readonly string[];
  instructions: string;
};

/** What entered the agent's view since the caller's last message. */
export type NewSinceLastMessage = {
  /** Skills the agent read since then, oldest first. */
  skills: readonly LoadedSkill[];
  /** Tools it can call now that it could not call then. */
  tools: readonly string[];
  /** Its instructions read differently now. */
  instructions: boolean;
};

/** The framework's own tools (read_skill, skip_turn, end_call) are plumbing, not
 * something the author wrote, so they never count as new. */
function authoredToolNames(context: CompiledContext): string[] {
  return [...new Set(context.tools.filter((tool) => tool.scope !== "runtime").map((tool) => tool.name))];
}

export function agentViewSnapshot(context: CompiledContext | null): AgentViewSnapshot {
  if (!context) return { skills: [], tools: [], instructions: "" };
  return {
    skills: context.loadedSkills.map((skill) => skill.path),
    tools: authoredToolNames(context),
    instructions: context.systemPrompt ?? "",
  };
}

export function newSince(before: AgentViewSnapshot, context: CompiledContext): NewSinceLastMessage {
  const skills = new Set(before.skills);
  const tools = new Set(before.tools);
  return {
    skills: context.loadedSkills.filter((skill) => !skills.has(skill.path)),
    tools: authoredToolNames(context).filter((name) => !tools.has(name)),
    instructions: (context.systemPrompt ?? "") !== before.instructions,
  };
}

/** Messages the caller typed or said: not tool results, context events or framework input. */
export function callerMessageCount(messages: readonly AgentChatMessage[]): number {
  return messages.filter((message) => message.role === "user" && !message.kind).length;
}

/** The agent's view as it was when the caller's last message arrived. */
export type BeforePicture = { count: number; conversationId: string | null; view: AgentViewSnapshot };

/**
 * Kept while the caller's message count and the conversation stay the same, so what
 * the turn loads shows as new; retaken when either changes. It is taken in the render
 * that first shows the message, and the server publishes the caller's message before
 * the model runs, so everything the turn loads arrives after it.
 */
export function beforePicture(
  previous: BeforePicture | null,
  messages: readonly AgentChatMessage[],
  context: CompiledContext | null,
  conversationId: string | null,
): BeforePicture {
  const count = callerMessageCount(messages);
  if (previous && previous.count === count && previous.conversationId === conversationId) return previous;
  return { count, conversationId, view: agentViewSnapshot(context) };
}

/** What entered the agent's view since the caller's last message, or null while the
 * caller has said nothing in this conversation. */
export function useNewSinceLastMessage(
  messages: readonly AgentChatMessage[],
  context: CompiledContext | null,
  conversationId: string | null,
): NewSinceLastMessage | null {
  const [before, setBefore] = useState(() => beforePicture(null, messages, context, conversationId));
  const current = beforePicture(before, messages, context, conversationId);
  // Adjusting state while rendering, React's pattern for state that resets when an
  // input changes: this render already compares against the new picture.
  if (current !== before) setBefore(current);
  if (current.count === 0 || !context) return null;
  return newSince(current.view, context);
}

/** The skill page the sheet shows, and whether it is the conversation's own. */
export type SkillPage = {
  context: CompiledContext;
  /** The page IS what the model gets: the conversation's compile of its current skill. */
  showsLive: boolean;
  /** Tools on the live page that test runs cannot reach: the conversation unlocked
   * them, and test runs go to the preview's copy, where they are still locked. */
  untryable: ReadonlySet<string>;
};

/**
 * Which compile a skill page shows. The skill the agent is on comes from the
 * conversation itself (`live`), so a page that says "this is what the model gets" is
 * exactly that. Every other skill, and the agent's skill once the viewer tried a tool
 * on it, comes from the preview's copy (`copy`), the runtime that browsing and test
 * runs use so they never touch the conversation. Its store and component state can
 * differ from the conversation's: the conversation may have finished a procedure the
 * copy never started.
 */
export function skillPage(
  live: CompiledContext,
  copy: CompiledContext | null,
  selectedPath: string,
  testedPaths: ReadonlySet<string>,
): SkillPage {
  if (selectedPath !== live.path || testedPaths.has(live.path)) {
    // Before the copy's first page arrives, the conversation's page is all there is.
    return { context: copy ?? live, showsLive: copy === null, untryable: new Set() };
  }
  const copyTools = copy?.path === live.path ? new Set(copy.tools.map((tool) => tool.name)) : null;
  return {
    context: live,
    showsLive: true,
    untryable: new Set(
      copyTools ? live.tools.filter((tool) => !copyTools.has(tool.name)).map((tool) => tool.name) : [],
    ),
  };
}

/** What a skill page can honestly say about itself. */
export type SkillPageStatus =
  /** The conversation's own page of the skill the agent is on. */
  | "live"
  /** The agent's skill, shown from the copy because the viewer tried a tool on it. */
  | "tested"
  /** In the model's context from earlier, shown from the copy. */
  | "earlier"
  /** Not in the model's context. */
  | "unused";

export function skillPageStatus(page: { showsLive: boolean; current: boolean; inUse: boolean }): SkillPageStatus {
  if (page.showsLive) return "live";
  if (!page.inUse) return "unused";
  return page.current ? "tested" : "earlier";
}

export function NewBadge() {
  return (
    <Badge variant="secondary" className="h-5 px-2 text-[0.72rem]" title="New since your last message">
      New
    </Badge>
  );
}

const STATUS_TEXT: Record<SkillPageStatus, string> = {
  live: "In use right now: this is what the model gets.",
  tested: "In use right now, but this page shows your test runs, not what the model gets.",
  earlier: "In use from earlier. Shown as written, without the conversation's changes.",
  unused: "Not in use right now: the agent reads this skill when the conversation needs it.",
};

/** What the page on screen is: the model's own view of the skill, or the preview's
 * copy. When the copy carries the viewer's test runs, it says so: they never reach
 * the agent in the conversation, but a page saying "Signed in" can read as if they did. */
export function SkillLiveStatus({
  status,
  isNew,
  tried,
}: {
  status: SkillPageStatus;
  isNew: boolean;
  tried: boolean;
}) {
  const showsNew = isNew && status === "live";
  return (
    <div className="flex flex-col gap-1.5 text-[0.8125rem] text-muted-foreground">
      <p className="m-0 flex items-center gap-2 [text-wrap:pretty]" data-in-use={status === "unused" ? "false" : "true"}>
        {showsNew ? (
          <NewBadge />
        ) : status === "unused" ? null : (
          <span className="size-[7px] shrink-0 rounded-full bg-success" aria-hidden="true" />
        )}
        {showsNew
          ? "The agent read this after your last message. This is what the model gets now."
          : STATUS_TEXT[status]}
      </p>
      {tried && (status === "earlier" || status === "unused") ? (
        <p className="m-0 flex items-center gap-2">
          <FlaskConicalIcon className="size-3.5" aria-hidden="true" />
          Your test runs changed this preview, not the agent in the conversation.
        </p>
      ) : null}
    </div>
  );
}
