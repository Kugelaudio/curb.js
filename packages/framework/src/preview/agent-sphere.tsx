import { cn } from "@/lib/utils.js";

/** The agent's sphere: the one colour on the page, wherever the agent itself is meant. In a
 * call it carries rings, and they breathe while the agent speaks. */
export function AgentSphere({
  size,
  live,
  className,
}: {
  size: number;
  /** In a call: whether the agent is speaking right now. */
  live?: "speaking" | "quiet";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("agent-sphere", className)}
      data-size={size >= 64 ? "xl" : undefined}
      data-live={live}
      style={{ width: size, height: size }}
    />
  );
}

/** The agent's name as the page shows it. A project's single agent lives in `src/agent/`
 * and has the id "agent", which names nothing, so it is "Your agent"; agents of a
 * multi-agent host are named after their folder. */
export function agentName(id: string): string {
  if (id === "agent") return "Your agent";
  const words = id.replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
