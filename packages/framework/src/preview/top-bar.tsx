import { CircleAlertIcon, CircleCheckIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { agentName } from "./agent-sphere.js";
import { contextShortcutLabel } from "./context-column-state.js";
import { CurbLogo } from "./curb-logo.js";

/** The page's top bar: whose preview this is, and whether the agent has problems. */
export function TopBar({
  agents,
  activeAgentId,
  onSelectAgent,
  problems,
  onOpenDiagnostics,
  contextOpen,
  onToggleContext,
}: {
  agents: readonly string[];
  activeAgentId: string;
  onSelectAgent: (id: string) => void;
  /** How many problems the agent has: what stops it, and what `curb check` finds. */
  problems: number;
  onOpenDiagnostics: () => void;
  /** The Context column shows; it hides to give a narrow window to the conversation. */
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  return (
    <header className="flex h-[60px] items-center gap-3 border-b border-border/70 bg-card px-6">
      <CurbLogo size={26} className="shrink-0" />
      {agents.length > 1 ? (
        <Select
          value={activeAgentId}
          onValueChange={(id) => {
            if (typeof id === "string" && id !== activeAgentId) onSelectAgent(id);
          }}
        >
          <SelectTrigger
            aria-label="Agent"
            className="-ml-2 h-9 border-transparent bg-transparent pr-2 pl-2 text-base font-semibold tracking-[-0.01em] hover:bg-accent"
          >
            <SelectValue>{(id: string) => agentName(id)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {agents.map((id) => (
              <SelectItem key={id} value={id}>
                {agentName(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <h1 className="m-0 text-base font-semibold tracking-[-0.01em]">{agentName(activeAgentId)}</h1>
      )}
      <span className="text-[0.8125rem] text-muted-foreground">Local preview</span>
      <span className="flex-1" />
      <ChecksStatus count={problems} onOpen={onOpenDiagnostics} />
      <Button
        variant="ghost"
        size="icon"
        aria-label={contextOpen ? "Hide context" : "Show context"}
        aria-pressed={contextOpen}
        aria-keyshortcuts={"Meta+\\ Control+\\"}
        title={`${contextOpen ? "Hide context" : "Show context"} (${contextShortcutLabel()})`}
        onClick={onToggleContext}
      >
        {contextOpen ? <PanelRightCloseIcon aria-hidden="true" /> : <PanelRightOpenIcon aria-hidden="true" />}
      </Button>
    </header>
  );
}

/** "No problems", or how many there are, which opens them. */
function ChecksStatus({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={count === 0 ? "font-normal text-muted-foreground" : "font-medium text-destructive"}
      onClick={onOpen}
    >
      {count === 0 ? (
        <CircleCheckIcon className="text-success" aria-hidden="true" />
      ) : (
        <CircleAlertIcon aria-hidden="true" />
      )}
      {count === 0 ? "No problems" : `${count} ${count === 1 ? "problem" : "problems"}`}
    </Button>
  );
}
