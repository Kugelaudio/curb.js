import { useState, type ReactNode } from "react";
import {
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HandIcon,
  LoaderIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import type { ToolCallStatus, ToolCallView } from "./conversation-turns.js";
import { argumentEntries, resultValue, ValueTree } from "./value-tree.js";

/** The framework's tool for opening a skill (`load_skill` in older transcripts). */
export function isSkillOpen(name: string): boolean {
  return name === "read_skill" || name === "load_skill";
}

const STATUS: Record<Exclude<ToolCallStatus, "pending">, { label: string; icon: ReactNode }> = {
  ok: { label: "Done", icon: <CheckIcon className="size-3.5 text-success" aria-hidden="true" /> },
  failed: { label: "Failed", icon: <XIcon className="size-3.5 text-destructive" aria-hidden="true" /> },
  held: { label: "Waiting for the caller's yes", icon: <HandIcon className="size-3.5" aria-hidden="true" /> },
};

function StatusIcon({ status, running }: { status: ToolCallStatus; running: boolean }) {
  if (status === "pending") {
    return running ? (
      <LoaderIcon className="size-3.5 animate-spin" aria-label="Running" />
    ) : null;
  }
  const { label, icon } = STATUS[status];
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" aria-label={label} />}>{icon}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One thing the agent did, inside its turn. A skill it opened reads "Open skill <name>"
 * and opens that skill; any other tool call shows its name, its first arguments and how it
 * went, and expands to its arguments and result. The same for every tool: nothing here
 * words one tool's call differently.
 */
export function ToolCallRow({
  tool,
  running,
  skillLabel,
  toolIcon,
  onOpenSkill,
}: {
  tool: ToolCallView;
  /** The turn is still running, so a call without a result is still going. */
  running: boolean;
  skillLabel: (path: string) => string;
  toolIcon: (name: string) => LucideIcon | undefined;
  onOpenSkill: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { call, result, status } = tool;

  if (isSkillOpen(call.name)) {
    const path = String(call.input.skill ?? call.input.path ?? "");
    return (
      <button
        type="button"
        className="-ml-2 flex w-fit max-w-full items-center gap-2 rounded-[10px] py-[5px] pr-2.5 pl-2 text-[0.8125rem] whitespace-nowrap text-muted-foreground hover:bg-accent"
        onClick={() => onOpenSkill(path)}
      >
        <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
        Open skill
        <span className="truncate font-medium text-foreground">{skillLabel(path)}</span>
        {status === "failed" ? <StatusIcon status={status} running={running} /> : null}
      </button>
    );
  }

  const Icon = toolIcon(call.name) ?? WrenchIcon;
  const args = argumentEntries(call.input);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="-ml-2 flex w-fit max-w-full items-center gap-2 rounded-[10px] py-[5px] pr-2.5 pl-2 text-[0.8125rem] whitespace-nowrap text-muted-foreground hover:bg-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground">{call.name}</span>
        {args.length > 0 ? (
          <span className="min-w-0 truncate">
            {args.map(([key, value]) => (
              <span key={key} className="mr-2.5 last:mr-0">
                {key} {value}
              </span>
            ))}
          </span>
        ) : null}
        <StatusIcon status={status} running={running} />
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <div className="mt-0.5 -ml-2 flex max-w-[520px] flex-col gap-3 rounded-[14px] border border-border/70 bg-card px-3.5 py-3">
          <Detail title="Arguments">
            {Object.keys(call.input).length > 0 ? (
              <ValueTree value={call.input} />
            ) : (
              <span className="text-[0.8125rem] text-muted-foreground">None</span>
            )}
          </Detail>
          {call.heldFor ? (
            <Detail title="Asked the caller first">
              <span className="text-[0.8125rem]">{call.heldFor}</span>
            </Detail>
          ) : null}
          {call.confirmedBy ? (
            <Detail title="The caller said yes">
              <span className="text-[0.8125rem]">{call.confirmedBy}</span>
            </Detail>
          ) : null}
          <Detail title="Result">
            <CallResult tool={tool} running={running} />
          </Detail>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

function CallResult({ tool, running }: { tool: ToolCallView; running: boolean }) {
  const { result, status } = tool;
  if (!result) {
    return (
      <span className="text-[0.8125rem] text-muted-foreground">
        {status === "held" ? "Not run: it waits for the caller's yes." : running ? "Running" : "No result was recorded."}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[0.8125rem] whitespace-pre-wrap text-destructive">
        {result.result.message ?? "The tool reported a failure without a message."}
      </span>
    );
  }
  const value = resultValue(result.result);
  if (status === "held" || value === undefined) {
    return (
      <span className="text-[0.8125rem] text-muted-foreground">
        {status === "held" ? "Not run: it waits for the caller's yes." : "Nothing returned."}
      </span>
    );
  }
  return <ValueTree value={value} />;
}
