import { CheckIcon } from "lucide-react";
import type { BlockPreviewProps } from "../types.js";
import type { ProcedurePayload } from "./definition.js";

/**
 * Vertical stepper: numbered markers with a connector line, check marks on
 * completed steps, the current step's body text visible, locked steps shown
 * as muted upcoming titles (their body is hidden — the model can't see it yet
 * either). The advance tool renders as the current step's own "Next step"
 * button. Styles: `.ctx-procedure*` in the preview stylesheet.
 */
export function ProcedureBlockPreview({ payload, api }: BlockPreviewProps<ProcedurePayload>) {
  const advanceError = payload.advanceToolName
    ? api.toolErrors[payload.advanceToolName]
    : undefined;
  return (
    <section className="ctx-procedure" aria-label={payload.title}>
      <p className="ctx-procedure-title">{payload.title}</p>
      <ol className="ctx-procedure-steps">
        {payload.steps.map((step) => (
          <li key={step.order} className="ctx-procedure-step" data-status={step.status}>
            <span className="ctx-procedure-marker" aria-hidden="true">
              {step.status === "completed" ? <CheckIcon /> : step.order}
            </span>
            <div className="ctx-procedure-step-body">
              <p className="ctx-procedure-step-title">{step.title}</p>
              {step.status === "current" && step.text ? (
                <p className="ctx-procedure-step-text">{step.text}</p>
              ) : null}
              {step.status === "current" && payload.advanceToolName ? (
                <>
                  <button
                    type="button"
                    className="ctx-procedure-next"
                    onClick={() => void api.onToolSubmit(payload.advanceToolName!, {})}
                  >
                    Next step
                  </button>
                  {advanceError ? <p className="ctx-text-error">{advanceError}</p> : null}
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
