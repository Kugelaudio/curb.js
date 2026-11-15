import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/lib/utils.js";
import { formatAuthoringDiagnostic, formatAuthoringLocation, type AuthoringDiagnostic } from "../authoring.js";
import { InlineText, inlineParts } from "./inline-code.js";
import { copyToClipboard } from "./transcript-export.js";

/**
 * Everything wrong with the agent goes through one window, one problem at a time: a key it
 * needs and does not have (it cannot answer until that is fixed), then what `curb check`
 * finds in its code, errors before warnings. Each shows what is wrong, the fix, and the whole
 * of it as text for a coding agent.
 */
export type Problem = { kind: "missing-key" | "error" | "warning"; diagnostic: AuthoringDiagnostic };

export function previewProblems(
  missingKeys: readonly AuthoringDiagnostic[],
  diagnostics: readonly AuthoringDiagnostic[],
): Problem[] {
  return [
    ...missingKeys.map((diagnostic): Problem => ({ kind: "missing-key", diagnostic })),
    ...diagnostics.filter((d) => d.severity === "error").map((diagnostic): Problem => ({ kind: "error", diagnostic })),
    ...diagnostics.filter((d) => d.severity !== "error").map((diagnostic): Problem => ({ kind: "warning", diagnostic })),
  ];
}

const KIND_LABEL: Record<Problem["kind"], string> = { "missing-key": "Missing key", error: "Error", warning: "Warning" };

/** The one line to paste: a command for the terminal, or a line of the project's .env. */
export type ProblemStep = { where: "terminal" | "env"; line: string };

/** The sign-in that stands in for a key; a fix that names it gets it as the line to run. */
const LOGIN_COMMAND = "npx curb login";

/**
 * A problem as the window shows it. A missing key gets a headline that names the variable its
 * message names first, and the first thing its fix asks for as a line to paste; a fix that
 * asks for nothing to be set (a workspace that issues the key itself) gets no line. Any other
 * problem is headed by its own message.
 */
export function problemView(problem: Problem): { label: string; headline: string | null; step: ProblemStep | null } {
  const label = KIND_LABEL[problem.kind];
  if (problem.kind !== "missing-key") return { label, headline: null, step: null };
  const { message, fix } = problem.diagnostic;
  const variable = inlineParts(message.replaceAll("`", "")).find((part) => part.code)?.text ?? null;
  const step: ProblemStep | null = fix.includes(`\`${LOGIN_COMMAND}\``)
    ? { where: "terminal", line: LOGIN_COMMAND }
    : variable && new RegExp(`\\b[Ss]et ${variable}\\b`).test(fix)
      ? { where: "env", line: `${variable}=` }
      : null;
  return { label, headline: variable ? `${variable} is not set` : null, step };
}

/** Where the blocking problem the person already closed is kept, for this tab. */
export const PROBLEMS_SEEN_KEY = "curb.preview.problemsSeen";

/** What tells one blocking problem from another; empty when nothing blocks the agent. */
export function blockingSignature(missingKeys: readonly AuthoringDiagnostic[]): string {
  return missingKeys.map((diagnostic) => diagnostic.message).join("\n");
}

/** The window opens by itself for a problem that stops the agent, once: closing it is
 * remembered for the tab, so a save that reloads the page does not put it back in the way. */
export function opensByItself(signature: string, seen: string | null): boolean {
  return signature !== "" && signature !== seen;
}

export function readProblemsSeen(): string | null {
  try {
    return window.sessionStorage.getItem(PROBLEMS_SEEN_KEY);
  } catch {
    // KEEP-JUSTIFIED: storage can be off (a private window, a locked-down frame); the window
    // then opens on every load, which only repeats what is still true.
    return null;
  }
}

export function writeProblemsSeen(signature: string): void {
  try {
    window.sessionStorage.setItem(PROBLEMS_SEEN_KEY, signature);
  } catch {
    // KEEP-JUSTIFIED: without storage the window opens again on the next load; nothing to report.
  }
}

/** Over the conversation while the agent cannot answer: says so, and opens the window. */
export function CannotAnswerPill({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex justify-center px-6 pt-1 pb-2">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-2 rounded-full border border-border/70 bg-card px-3 text-[0.8125rem] outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <span className="size-[7px] rounded-full bg-destructive" aria-hidden="true" />
        <span className="font-medium">Your agent cannot answer yet</span>
        <span className="text-muted-foreground">How to fix</span>
        <ChevronRightIcon className="-mr-1 -ml-1 size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The window: one problem at a time, with arrows (and the arrow keys) to the others. */
export function ProblemsDialog({
  open,
  onOpenChange,
  problems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  problems: readonly Problem[];
}) {
  const [index, setIndex] = useState(0);
  // Adjusting state while rendering: every opening starts at the first, most pressing problem.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setIndex(0);
  }
  const count = problems.length;
  const at = Math.min(index, Math.max(0, count - 1));
  const problem = problems[at];
  const step = (by: number) => setIndex(Math.min(count - 1, Math.max(0, at + by)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="error-popup gap-4 rounded-2xl sm:max-w-[540px]"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") step(-1);
          else if (event.key === "ArrowRight") step(1);
        }}
      >
        <DialogTitle className="sr-only">{count === 0 ? "No problems" : "Problems"}</DialogTitle>
        <DialogDescription className="sr-only">
          What stops your agent or is wrong in its code, with the fix for each.
        </DialogDescription>
        {problem ? (
          <>
            <ProblemBody
              problem={problem}
              pager={
                count > 1 ? (
                  <span className="flex items-center gap-0.5 text-[0.75rem] text-muted-foreground tabular-nums">
                    <Button variant="ghost" size="icon-xs" aria-label="Previous problem" disabled={at === 0} onClick={() => step(-1)}>
                      <ChevronLeftIcon aria-hidden="true" />
                    </Button>
                    {at + 1} / {count}
                    <Button variant="ghost" size="icon-xs" aria-label="Next problem" disabled={at === count - 1} onClick={() => step(1)}>
                      <ChevronRightIcon aria-hidden="true" />
                    </Button>
                  </span>
                ) : null
              }
            />
            <div className="flex items-center justify-end gap-2">
              {count > 1 ? (
                <CopyButton
                  variant="ghost"
                  text={problems.map((each) => formatAuthoringDiagnostic(each.diagnostic)).join("\n\n")}
                  label={`Copy all ${count}`}
                />
              ) : null}
              <CopyButton text={formatAuthoringDiagnostic(problem.diagnostic)} label="Copy for your coding agent" />
            </div>
          </>
        ) : (
          <p className="m-0 flex items-center gap-2 pr-10 text-sm">
            <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
            No problems: your agent can answer, and <InlineText text="`curb check`" /> finds nothing in its code.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One problem: what kind it is, what is wrong, the line to paste when there is one, the fix,
 * and where in the code it comes from. */
export function ProblemBody({ problem, pager }: { problem: Problem; pager?: React.ReactNode }) {
  const { label, headline, step } = problemView(problem);
  const { diagnostic } = problem;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-6 items-center gap-2 pr-9 text-[0.75rem] font-medium text-destructive">
        <span className="size-[7px] rounded-full bg-destructive" aria-hidden="true" />
        <span className="flex-1">{label}</span>
        {pager}
      </div>
      {headline ? (
        <h3 className="code-font m-0 text-base font-semibold">{headline}</h3>
      ) : (
        <h3 className="m-0 text-[0.9375rem] leading-snug font-medium [text-wrap:pretty]">
          <InlineText text={diagnostic.message} />
        </h3>
      )}
      {step ? (
        <div className="flex h-10 items-center gap-2 rounded-xl bg-muted/70 pr-1.5 pl-3.5">
          <pre className="code-font m-0 min-w-0 flex-1 overflow-x-auto text-[0.8125rem]">
            {step.where === "terminal" ? <span className="text-muted-foreground select-none">$ </span> : null}
            {step.line}
          </pre>
          {step.where === "env" ? <span className="text-[0.75rem] text-muted-foreground">.env</span> : null}
          <CopyButton
            variant="ghost"
            className="text-muted-foreground"
            text={step.line}
            label={step.where === "terminal" ? "Copy command" : "Copy line"}
            iconOnly
          />
        </div>
      ) : null}
      <p className="m-0 text-[0.8125rem] leading-relaxed text-muted-foreground [text-wrap:pretty]">
        <InlineText text={diagnostic.fix} />
      </p>
      {problem.kind === "missing-key" ? null : (
        <p className="code-font m-0 text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere]">
          {formatAuthoringLocation(diagnostic.location) || "Agent context"} · {diagnostic.code}
        </p>
      )}
    </div>
  );
}

function CopyButton({
  text,
  label,
  variant = "default",
  iconOnly = false,
  className,
}: {
  text: string;
  label: string;
  variant?: "default" | "ghost";
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);

  const copy = async () => {
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    window.clearTimeout(reset.current);
    reset.current = window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <Button
      variant={variant}
      size={iconOnly ? "icon-sm" : "sm"}
      className={cn("shrink-0", className)}
      aria-label={iconOnly ? (copied ? "Copied" : label) : undefined}
      title={iconOnly ? label : undefined}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {iconOnly ? null : copied ? "Copied" : label}
    </Button>
  );
}
