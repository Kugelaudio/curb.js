import { procedureBlock } from "./procedure/definition.js";
import type { BlockBlueprintExpander, BlockCompiler, BlockDefinition } from "./types.js";

/**
 * Every built-in block, exactly once. This is the server-safe half of block
 * registration (definitions carry no React-UI imports): the compiler resolves
 * `agent-block-*` tags here, the blueprint parser resolves JSX component
 * names here, and the agent registry derives "this skill is interactive"
 * from the same list. The browser-only half — pairing each definition with
 * its preview renderer — lives in `preview-registry.tsx`.
 */
export const blockDefinitions: readonly BlockDefinition[] = [procedureBlock];

const byTag = new Map(blockDefinitions.map((block) => [block.tag, block]));

const blueprintExpanders = new Map<string, BlockBlueprintExpander>();
for (const block of blockDefinitions) {
  for (const [componentName, expand] of Object.entries(block.blueprint ?? {})) {
    if (blueprintExpanders.has(componentName)) {
      throw new Error(
        `Two blocks declare a blueprint expander for <${componentName}> — component names must be unique across blocks.`,
      );
    }
    blueprintExpanders.set(componentName, expand);
  }
}

/** The compiler for one `agent-block-<id>` semantic tag. */
export function getBlockCompiler(tag: string): BlockCompiler | undefined {
  return byTag.get(tag)?.compile;
}

/** The branch-map expander for one JSX component name (e.g. "Procedure"). */
export function getBlockBlueprint(componentName: string): BlockBlueprintExpander | undefined {
  return blueprintExpanders.get(componentName);
}

/** Every JSX component name blocks claim ("Procedure", "Step", …) —
 * used to detect that a skill source renders interactive patterns. */
export function blockComponentNames(): string[] {
  return [...blueprintExpanders.keys()];
}
