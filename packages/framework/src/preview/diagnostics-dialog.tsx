import { useEffect, useRef, useState } from "react";
import { CheckIcon, CircleAlertIcon, CircleCheckIcon, CircleXIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { formatAuthoringDiagnostic, formatAuthoringLocation, type AuthoringDiagnostic } from "../authoring.js";

/**
 * What `curb check` finds in the agent's code, each with where it is and the concrete fix:
 * written for a person scanning it and for a coding agent pasting it, the same text the
 * server log carries.
 */
export function DiagnosticsDialog({
  open,
  onOpenChange,
  diagnostics,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diagnostics: readonly AuthoringDiagnostic[];
}) {
  const count = diagnostics.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{count === 0 ? "No problems" : `${count} ${count === 1 ? "problem" : "problems"}`}</DialogTitle>
          <DialogDescription>
            What <code>curb check</code> finds in your agent's code, with the fix for each. The server log has the same.
          </DialogDescription>
        </DialogHeader>
        {count === 0 ? (
          <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
            Your agent's code has no authoring problems.
          </p>
        ) : (
          <DiagnosticsList diagnostics={diagnostics} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The problems, each with where it is, its fix and a copy button, and "Copy all" under them. */
export function DiagnosticsList({ diagnostics }: { diagnostics: readonly AuthoringDiagnostic[] }) {
  const [copied, setCopied] = useState<{ target: string; ok: boolean } | null>(null);
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);

  const copy = async (items: readonly AuthoringDiagnostic[], target: string) => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(items.map(formatAuthoringDiagnostic).join("\n\n"));
        ok = true;
      }
    } catch {
      ok = false;
    }
    setCopied({ target, ok });
    window.clearTimeout(reset.current);
    reset.current = window.setTimeout(() => setCopied(null), 1800);
  };

  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {diagnostics.map((diagnostic, index) => (
          <li
            key={`${diagnostic.code}-${index}`}
            className="flex gap-3 rounded-2xl border border-border/70 p-3.5"
            data-severity={diagnostic.severity}
          >
            {diagnostic.severity === "error" ? (
              <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Error" />
            ) : (
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Warning" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <p className="m-0 font-medium">{diagnostic.message}</p>
              <p className="m-0 text-[0.8125rem] text-muted-foreground">
                {formatAuthoringLocation(diagnostic.location) || "Agent context"} · {diagnostic.code}
              </p>
              <p className="m-0 text-[0.8125rem]">
                <span className="text-muted-foreground">Fix: </span>
                {diagnostic.fix}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={copied?.target === `one-${index}` && copied.ok ? "Copied" : "Copy this problem"}
              title="Copy for your coding agent"
              onClick={() => void copy([diagnostic], `one-${index}`)}
            >
              {copied?.target === `one-${index}` && copied.ok ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-3">
        {copied && !copied.ok ? (
          <span className="text-[0.8125rem] text-destructive" role="alert">
            Could not copy. Allow clipboard access and try again.
          </span>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => void copy(diagnostics, "all")}>
          {copied?.target === "all" && copied.ok ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied?.target === "all" && copied.ok ? "Copied" : "Copy all"}
        </Button>
      </div>
    </>
  );
}
