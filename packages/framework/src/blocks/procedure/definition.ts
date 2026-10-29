import { numberProp, optionalStringProp, stringProp, textContent } from "../../semantic-node.js";
import type { SemanticNode } from "../../types.js";
import { defineBlock } from "../types.js";
import type { BlockCompileApi, BlockCompileResult, BlueprintSection } from "../types.js";

/** One step of a compiled procedure, for the preview's stepper. Locked steps
 * carry an empty `text` — their content is hidden from the model AND the UI
 * until unlocked. */
export type ProcedureStepPayload = {
  order: number;
  title: string;
  text: string;
  status: "completed" | "current" | "locked";
};

export type ProcedurePayload = {
  title: string;
  steps: ProcedureStepPayload[];
  /** Present while the procedure can advance — the stepper's "Next step"
   * button calls this tool. */
  advanceToolName?: string;
};

/**
 * Serialize a procedure. The MODEL sees flat content lines
 * (`Procedure: <title>`, then one `Step N [status]: <title>. <body>` line per
 * non-locked step — locked steps stay invisible) plus the advance tool its
 * embedded `<Tool>` child registers. The PREVIEW gets the structured payload
 * and renders a stepper.
 */
function compileProcedureBlock(
  node: SemanticNode,
  api: BlockCompileApi,
): BlockCompileResult<ProcedurePayload> {
  const title = stringProp(node, "title");
  api.addContent(`Procedure: ${title}`);

  const { regions, rest } = api.regions(node);
  const steps: ProcedureStepPayload[] = [];
  let completedContent: SemanticNode[] | undefined;
  for (const region of regions) {
    if (region.name === "completed") {
      completedContent = region.children;
      continue;
    }
    if (region.name !== "step") continue;

    const status = stringProp(region.node, "status") as ProcedureStepPayload["status"];
    const order = numberProp(region.node, "order");
    const stepTitle = stringProp(region.node, "title");
    const text = textContent(region.node);
    steps.push({ order, title: stepTitle, text, status });

    if (status !== "locked") {
      const head = `Step ${order} [${status}]: ${stepTitle}.`;
      api.addContent(text ? `${head} ${text}` : head);
    }
  }

  // The `completed` outcome is ordinary page content — text, tools, links
  // render below the stepper once the procedure finished.
  if (completedContent) {
    api.compileChildren(completedContent, { render: true });
  }

  // The embedded advance <Tool> registers for the model here; the stepper's
  // "Next step" button is its preview representation.
  api.compileChildren(rest, { render: false });

  const advanceToolName = optionalStringProp(node, "advanceToolName");
  const payload: ProcedurePayload = { title, steps, advanceToolName };
  return { payload, claimedTools: advanceToolName ? [advanceToolName] : [] };
}

export const procedureBlock = defineBlock<ProcedurePayload>({
  id: "procedure",
  compile: compileProcedureBlock,
  blueprint: {
    // A <Procedure> is one block node whose sections are its steps, in
    // order — the branch map shows the whole sequence even while most steps
    // are still locked at runtime; `activeSection` marks the current one.
    Procedure(node, api) {
      const sections: BlueprintSection[] = [];
      for (const child of api.children(node)) {
        if (api.name(child) !== "Step") {
          api.walk(child);
          continue;
        }
        const section: BlueprintSection = {
          id: `step-${sections.length + 1}`,
          label: api.attr(child, "title") ?? `step ${sections.length + 1}`,
          children: [],
        };
        for (const inner of api.children(child)) {
          api.walk(inner, section.children);
        }
        sections.push(section);
      }
      // The `completed` outcome (JSX passed as a prop) is the sequence's
      // final section, visible in the branch map before it ever renders.
      const completed = api.attrNode(node, "completed");
      if (completed) {
        const section: BlueprintSection = { id: "completed", label: "completed", children: [] };
        api.walk(completed, section.children);
        sections.push(section);
      }
      api.emit({
        kind: "block",
        block: "procedure",
        label: api.attr(node, "title") ?? "procedure",
        relation: "sequence",
        sections,
        children: [],
      });
    },
  },
});
