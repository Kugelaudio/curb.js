import type { AuthoringDiagnostic } from "../authoring.js";
import { AgentSphere } from "./agent-sphere.js";
import { DiagnosticsList } from "./diagnostics-dialog.js";
import type { DemoClientState } from "./ws-client.js";

/** The one line above the composer while `curb dev` reloads the agent after a save; null
 * when no reload is pending. */
export function reloadNotice(reload: DemoClientState["reload"]): string | null {
  if (reload === null) return null;
  if (reload.state === "reloading") return "Reloading your agent with the saved changes…";
  return reload.until === "call_ends"
    ? "Your saved changes apply when this call ends."
    : "Your saved changes apply after this reply.";
}

/**
 * The preview while the agent cannot run: its modules did not load, it does not render, or a
 * conversation could not start. The page shows nothing older than the files on disk, only
 * why and where to fix it; `curb dev` reloads on the next save and the page reconnects.
 */
export function AgentUnavailable({ message, diagnostics }: { message: string; diagnostics: AuthoringDiagnostic[] }) {
  return (
    <div className="grid h-screen grid-rows-[60px_minmax(0,1fr)] overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border/70 bg-card px-6">
        <AgentSphere size={28} />
        <span className="text-[0.8125rem] text-muted-foreground">Local preview</span>
      </header>
      <main className="overflow-y-auto">
        <section className="mx-auto flex max-w-[640px] flex-col gap-4 px-6 pt-16 pb-12" aria-live="polite">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.015em]">Your agent is not running</h1>
          <p className="m-0 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
          {diagnostics.length > 0 ? <DiagnosticsList diagnostics={diagnostics} /> : null}
          <p className="m-0 text-sm text-muted-foreground">Save a fix and the preview reloads it.</p>
        </section>
      </main>
    </div>
  );
}
