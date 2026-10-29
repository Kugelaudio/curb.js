import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Tool } from "../../components.js";
import { Region } from "../region.js";
import type { SiteElementProps, ToolSpec } from "../../types.js";

/** Semantic element props of the compiled procedure block. */
type ProcedureBlockElementProps = SiteElementProps & {
  title: string;
  advanceToolName?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "agent-block-procedure": ProcedureBlockElementProps;
    }
  }
}

export type ProcedureProps = SiteElementProps & {
  title: string;
  initialStep?: number;
  currentStep?: number;
  /** The advance tool the model calls to finish the current step. Omitted
   * fields default (`complete_procedure_step`, a generated description, the
   * built-in advance behavior). */
  advanceTool?: ToolSpec;
  onComplete?: () => void;
  onStepChange?: (step: number) => void;
  /** Content that appears once every step is done — the procedure's outcome
   * (a summary line, the submission tool it unlocked). Rendered for the model
   * and the preview below the steps; the branch map shows it as the
   * sequence's final section. */
  completed?: ReactNode;
};

export type StepProps = SiteElementProps & {
  title: string;
};

/**
 * Pattern block: an ordered procedure the agent must walk step by step.
 * Compiles to flat "Step N [status]" content lines + an advance tool for the
 * model (see compile.ts); the preview renders a stepper whose "Next step"
 * button IS the advance tool (see preview.tsx).
 */
export function Procedure({
  title,
  initialStep = 1,
  currentStep,
  advanceTool,
  onComplete,
  onStepChange,
  completed,
  children,
}: ProcedureProps) {
  const steps = Children.toArray(children).filter(isStepElement);
  const [internalStep, setInternalStep] = useState(initialStep);
  const activeStep = currentStep ?? internalStep;
  const isControlled = currentStep !== undefined;
  const isComplete = activeStep > steps.length;
  const canAdvance = advanceTool?.onCall || !isControlled || onStepChange;
  const advanceName = advanceTool?.name ?? "complete_procedure_step";
  const advanceAvailable = Boolean(canAdvance) && !isComplete;

  async function advanceProcedure(input: Record<string, unknown>) {
    if (advanceTool?.onCall) return advanceTool.onCall(input);

    if (isComplete) {
      return { ok: true, message: "Procedure is already complete." };
    }

    const completedStep = activeStep;
    const nextStep = activeStep + 1;
    if (isControlled) {
      onStepChange?.(nextStep);
    } else {
      setInternalStep(nextStep);
    }

    if (nextStep > steps.length) {
      onComplete?.();
      return { ok: true, message: "Procedure is complete." };
    }

    return { ok: true, message: `Completed step ${completedStep}. Step ${nextStep} is now unlocked.` };
  }

  return (
    <agent-block-procedure
      title={title}
      advanceToolName={advanceAvailable ? advanceName : undefined}
    >
      {steps.map((step, index) => {
        const order = index + 1;
        const status = stepStatus(order, activeStep);
        return (
          <Fragment key={`${order}-${step.props.title}`}>
            <Region name="step" order={order} status={status} title={step.props.title}>
              {status === "locked" ? null : step.props.children}
            </Region>
          </Fragment>
        );
      })}
      {advanceAvailable ? (
        <Tool
          name={advanceName}
          description={
            advanceTool?.description ??
            `Mark the current step of "${title}" complete and unlock the next step.`
          }
          onCall={advanceProcedure}
        />
      ) : null}
      {isComplete && completed !== undefined ? (
        <Region name="completed">{completed}</Region>
      ) : null}
    </agent-block-procedure>
  );
}

export function Step(_props: StepProps) {
  return null;
}

function isStepElement(value: unknown): value is ReactElement<StepProps> {
  return isValidElement<StepProps>(value) && value.type === Step;
}

function stepStatus(order: number, currentStep: number) {
  if (order < currentStep) return "completed";
  if (order === currentStep) return "current";
  return "locked";
}
