import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { END_CALL_VOICE_STYLE, VOICE_STYLE } from "../voice-style.js";
import { NewBadge } from "./agent-view.js";
import { Prose } from "./prose.js";

/** The rules the framework adds to the instructions on every spoken turn of a call. */
const CALL_RULES = [...VOICE_STYLE, ...END_CALL_VOICE_STYLE];
/** The rules as markdown: their headings, each rule a list item. */
const CALL_RULES_MARKDOWN = CALL_RULES.map((line) => (line.startsWith("## ") ? `\n${line}` : `- ${line}`)).join("\n");

/**
 * The agent's instructions in full, formatted as the markdown they are, and what Curb adds
 * to them: the date and time every message carries, and the rules for phone calls.
 */
export function InstructionsDialog({
  open,
  onOpenChange,
  systemPrompt,
  agentId,
  dateLine,
  isNew,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  systemPrompt: string;
  agentId: string;
  /** The date and time line the newest model call carried; null before the first call. */
  dateLine: string | null;
  /** The instructions read differently than at the caller's last message. */
  isNew: boolean;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Instructions
            {isNew ? <NewBadge /> : null}
          </DialogTitle>
          <DialogDescription>
            Your agent reads this before every reply. It comes from <code>&lt;SystemPrompt&gt;</code> in{" "}
            {agentId === "agent" ? "src/agent/agent.tsx" : "your agent's code"}.
          </DialogDescription>
        </DialogHeader>
        {systemPrompt.trim() ? (
          <Prose text={systemPrompt} className="text-[0.9rem] leading-relaxed" />
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            Your agent has no instructions yet. Add a <code>&lt;SystemPrompt&gt;</code> to its agent module.
          </p>
        )}
        <section className="border-t border-border/70 pt-4">
          <h3 className="m-0 mb-1 text-[0.8125rem] font-medium text-muted-foreground">Curb adds</h3>
          <div className="flex flex-col">
            <div className="py-2">
              <div className="text-sm font-medium">Today's date and time</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {dateLine ?? "Added to every message."}
              </div>
            </div>
            <button
              type="button"
              aria-expanded={rulesOpen}
              className="-mx-2 flex items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-accent"
              onClick={() => setRulesOpen((value) => !value)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Rules for phone calls</span>
                <span className="text-[0.8125rem] text-muted-foreground">Added on calls.</span>
              </span>
              {rulesOpen ? (
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
            </button>
            {rulesOpen ? (
              <Prose text={CALL_RULES_MARKDOWN} className="mt-1 mb-1 text-[0.8125rem] leading-relaxed" />
            ) : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
