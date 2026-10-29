import { CircleAlertIcon, CircleCheckIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import type { AuthoringDiagnostic } from "../authoring.js";
import { AgentSphere, agentName } from "./agent-sphere.js";

/** The page's top bar: whose preview this is, and whether `curb check` finds problems. */
export function TopBar({
  agents,
  activeAgentId,
  onSelectAgent,
  diagnostics,
  onOpenDiagnostics,
  contextOpen,
  onToggleContext,
}: {
  agents: readonly string[];
  activeAgentId: string;
  onSelectAgent: (id: string) => void;
  diagnostics: readonly AuthoringDiagnostic[];
  onOpenDiagnostics: () => void;
  /** The Context column shows; it hides to give a narrow window to the conversation. */
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  return (
    <header className="flex h-[60px] items-center gap-3 border-b border-border/70 bg-card px-6">
      <AgentSphere size={28} />
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
      <ChecksStatus diagnostics={diagnostics} onOpen={onOpenDiagnostics} />
      <Button
        variant="ghost"
        size="icon"
        aria-label={contextOpen ? "Hide context" : "Show context"}
        aria-pressed={contextOpen}
        title={contextOpen ? "Hide context" : "Show context"}
        onClick={onToggleContext}
      >
        {contextOpen ? <PanelRightCloseIcon aria-hidden="true" /> : <PanelRightOpenIcon aria-hidden="true" />}
      </Button>
    </header>
  );
}

/** "No problems", or how many `curb check` finds, which opens them. */
function ChecksStatus({
  diagnostics,
  onOpen,
}: {
  diagnostics: readonly AuthoringDiagnostic[];
  onOpen: () => void;
}) {
  const count = diagnostics.length;
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
