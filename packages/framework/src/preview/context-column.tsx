import type { ReactNode } from "react";
import { NetworkIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

/**
 * The right-hand column, "Agent context": the tree of what the agent has, the button that
 * opens the graph of its skills large (an agent without skills has no graph to show), and a
 * dot that says the view is live.
 */
export function ContextColumn({
  connected,
  onOpenGraph,
  children,
}: {
  /** Connected to the agent server, so what shows is the conversation's own state. */
  connected: boolean;
  /** Opens the graph; absent when the agent has no skills. */
  onOpenGraph?: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-border/70 bg-card" aria-label="Agent context">
      <div className="flex h-14 shrink-0 items-center gap-2 px-6">
        <h2 className="m-0 text-sm font-medium">Context</h2>
        <span className="flex-1" />
        {onOpenGraph ? (
          <Button variant="ghost" size="sm" onClick={onOpenGraph}>
            <NetworkIcon aria-hidden="true" />
            Graph
          </Button>
        ) : null}
        <span
          className="inline-flex items-center gap-1.5 text-[0.78rem] text-muted-foreground"
          title={connected ? "Shows what your agent has right now" : "Not connected to the agent server"}
        >
          <span className={cn("size-[7px] rounded-full", connected ? "bg-success" : "bg-border")} aria-hidden="true" />
          {connected ? "Live" : "Offline"}
        </span>
      </div>
      {children}
    </aside>
  );
}
