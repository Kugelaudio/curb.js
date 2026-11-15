import type { AuthoringDiagnostic } from "../authoring.js";
import { CurbLogo } from "./curb-logo.js";
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

/** The preview before the agent is on the page: Curb's mark, and what the page waits for. */
export function PreviewLoading({ connected }: { connected: boolean }) {
  return (
    <main className="grid h-screen place-items-center">
      <div className="flex flex-col items-center gap-5 pb-[8vh]" role="status">
        <CurbLogo size={48} />
        <p className="m-0 text-sm">
          <span className="agent-thinking">{connected ? "Loading the agent…" : "Connecting to the agent server…"}</span>
        </p>
      </div>
    </main>
  );
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
        <CurbLogo size={26} className="shrink-0" />
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
