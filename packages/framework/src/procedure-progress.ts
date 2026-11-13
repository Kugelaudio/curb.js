import type { ProcedurePayload } from "./blocks/procedure/definition.js";
import type { PageBlock } from "./types.js";

/**
 * How far each `<Procedure>` in the compiled context is, and what changed between two looks at
 * it. A procedure only moves when something re-renders the agent (a tool run, a skill opening),
 * so comparing the context before and after says which step was completed.
 */

/** One procedure in the context: `done` of its `steps` are completed. */
export type ProcedureProgress = { title: string; steps: number; done: number; stepTitles: string[] };

/**
 * What happened to a procedure. `started`: it entered the context, at `step`, with every step's
 * title in order (`stepTitles`). `step_completed`: `step` (1-based, titled `stepTitle`) was
 * completed. `completed`: its last step was. `left`: it left the context unfinished, with `step`
 * the one it was on.
 */
export type ProcedureChange = {
  action: "started" | "step_completed" | "completed" | "left";
  title: string;
  step: number;
  steps: number;
  stepTitle?: string;
  stepTitles?: string[];
};

/** The procedures in a compiled context, keyed by title: the first of two with one title counts. */
export function proceduresOf(blocks: readonly PageBlock[]): Map<string, ProcedureProgress> {
  const procedures = new Map<string, ProcedureProgress>();
  for (const block of blocks) {
    if (block.type !== "block" || block.name !== "procedure") continue;
    const { title, steps } = block.payload as ProcedurePayload;
    if (procedures.has(title) || steps.length === 0) continue;
    procedures.set(title, {
      title,
      steps: steps.length,
      done: steps.filter((step) => step.status === "completed").length,
      stepTitles: steps.map((step) => step.title),
    });
  }
  return procedures;
}

export function procedureChanges(
  before: ReadonlyMap<string, ProcedureProgress>,
  after: ReadonlyMap<string, ProcedureProgress>,
): ProcedureChange[] {
  const changes: ProcedureChange[] = [];
  for (const [title, was] of before) {
    // A finished procedure that leaves the context was already reported as completed.
    if (!after.has(title) && was.done < was.steps) {
      changes.push({ action: "left", title, step: was.done + 1, steps: was.steps });
    }
  }
  for (const [title, now] of after) {
    const was = before.get(title);
    // First seen already finished: nothing happened in this conversation.
    if (!was && now.done >= now.steps) continue;
    if (!was) changes.push({ action: "started", title, step: now.done + 1, steps: now.steps, stepTitles: now.stepTitles });
    for (let step = (was?.done ?? now.done) + 1; step <= now.done; step += 1) {
      changes.push({ action: "step_completed", title, step, steps: now.steps, stepTitle: now.stepTitles[step - 1] });
    }
    if (was && was.done < was.steps && now.done >= now.steps) {
      changes.push({ action: "completed", title, step: now.steps, steps: now.steps });
    }
  }
  return changes;
}
