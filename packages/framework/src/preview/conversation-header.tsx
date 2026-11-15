import { useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, HistoryIcon, SquarePenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import type { ConversationSummary } from "../server/protocol.js";

/** "today, 13:38", "yesterday, 09:12" or "Oct 21, 16:40". */
export function conversationTime(startedAt: number, now = new Date()): string {
  const date = new Date(startedAt);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday, ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * Above the conversation: its history (the picker names the conversation on screen and
 * restores earlier ones), the button that starts a new one right beside it, and the hand-off
 * to a coding agent, which is how the agent gets changed. An empty conversation is the new
 * one already, so it shows no button for it.
 */
export function ConversationHeader({
  conversations,
  activeId,
  running,
  hasMessages,
  onSelect,
  onNew,
  onCopyForCodingAgent,
}: {
  conversations: readonly ConversationSummary[];
  activeId: string | null;
  running: boolean;
  hasMessages: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Copies the coding-agent transcript; resolves true when it is on the clipboard. */
  onCopyForCodingAgent: () => Promise<boolean>;
}) {
  const active = conversations.find((conversation) => conversation.id === activeId);
  // Earlier ones: the conversation on screen is listed only once it has something in it.
  const listed = conversations.filter((conversation) => conversation.messageCount > 0 || conversation.id !== activeId);
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 px-6">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Conversation history"
              className="-ml-2 inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full pr-2.5 pl-2.5 text-sm font-medium hover:bg-accent aria-expanded:bg-accent"
            />
          }
        >
          <HistoryIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-[260px] truncate">{hasMessages ? (active?.title ?? "Conversation") : "History"}</span>
          {hasMessages && active ? (
            <span className="shrink-0 font-normal text-muted-foreground">{conversationTime(active.startedAt)}</span>
          ) : null}
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          {listed.length > 0 ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Recent</DropdownMenuLabel>
              {listed.map((conversation) => {
                const selected = conversation.id === activeId;
                return (
                  <DropdownMenuItem
                    key={conversation.id}
                    disabled={running && !selected}
                    onClick={() => onSelect(conversation.id)}
                    className="items-start pr-8"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{conversation.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {conversationTime(conversation.startedAt)}
                        {conversation.messageCount > 0
                          ? ` · ${conversation.messageCount} ${conversation.messageCount === 1 ? "message" : "messages"}`
                          : ""}
                      </span>
                    </span>
                    {selected ? <CheckIcon className="absolute top-2 right-2" aria-hidden="true" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          ) : (
            <p className="m-0 px-3 py-2.5 text-[0.8125rem] text-muted-foreground">
              No earlier conversations yet. They show here once you have talked to your agent.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {hasMessages ? (
        <Button variant="ghost" size="sm" disabled={running} onClick={onNew}>
          <SquarePenIcon aria-hidden="true" />
          New conversation
        </Button>
      ) : null}
      <span className="flex-1" />
      {hasMessages ? <CopyForCodingAgent onCopy={onCopyForCodingAgent} /> : null}
    </div>
  );
}

/** The conversation, the prompt it ran with and the agent's skills and tools, ready to
 * paste into a coding agent. */
function CopyForCodingAgent({ onCopy }: { onCopy: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    const ok = await onCopy();
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className={state === "failed" ? "text-destructive" : undefined}
      title="Copy this conversation, with the agent's prompt, skills and tools, to paste into your coding agent"
      onClick={() => void copy()}
    >
      {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy for coding agent"}
    </Button>
  );
}
