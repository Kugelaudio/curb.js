import type { ComponentType } from "react";
import { procedureBlock } from "./procedure/definition.js";
import { ProcedureBlockPreview } from "./procedure/preview.js";
import type { BlockDefinition, BlockPreviewProps } from "./types.js";

/**
 * The browser-only half of block registration: each definition paired with
 * its preview renderer. Imported ONLY by the browser preview — everything
 * else about a block resolves through `registry.ts`, which server hosts can
 * import without pulling UI code.
 */
const previews = new Map<string, ComponentType<BlockPreviewProps>>([
  pair(procedureBlock, ProcedureBlockPreview),
]);

/** Pair a definition with its preview. The generic ties the preview's props
 * to the payload the definition's compiler produces — a mismatch is a type
 * error here, at the one place the payload type is erased. */
function pair<TPayload>(
  block: BlockDefinition<TPayload>,
  component: ComponentType<BlockPreviewProps<TPayload>>,
): [string, ComponentType<BlockPreviewProps>] {
  return [block.id, component as ComponentType<BlockPreviewProps>];
}

export function getBlockPreview(name: string): ComponentType<BlockPreviewProps> | undefined {
  return previews.get(name);
}

/** Block ids with a registered preview — for the conformance test. */
export function blockPreviewIds(): string[] {
  return [...previews.keys()];
}
