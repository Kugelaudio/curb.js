import { describe, expect, it } from "vitest";
import { blockPreviewIds, getBlockPreview } from "./preview-registry.js";
import { blockDefinitions, getBlockBlueprint, getBlockCompiler } from "./registry.js";

/**
 * Conformance test for the pattern-block contract: every registered block
 * follows the standardized folder recipe (see blocks/types.ts). Fails the
 * moment a new block is wired up halfway — e.g. a definition without a
 * preview, or an id that drifted between the two registries.
 */
describe("block registry conformance", () => {
  it("ids are unique and kebab-case; tags derive from the id", () => {
    const ids = blockDefinitions.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of blockDefinitions) {
      expect(block.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(block.tag).toBe(`agent-block-${block.id}`);
      expect(getBlockCompiler(block.tag)).toBe(block.compile);
    }
  });

  it("definitions and previews pair up 1:1", () => {
    for (const block of blockDefinitions) {
      expect(getBlockPreview(block.id), `block "${block.id}" has no preview`).toBeDefined();
    }
    const ids = new Set(blockDefinitions.map((block) => block.id));
    for (const previewId of blockPreviewIds()) {
      expect(ids.has(previewId), `preview "${previewId}" has no definition`).toBe(true);
    }
  });

  it("every block declares its JSX component names via blueprint expanders", () => {
    // The expander keys are also how the framework knows which component
    // names belong to blocks (branch map + interactivity detection) — a
    // block without them would be invisible to both.
    for (const block of blockDefinitions) {
      const componentNames = Object.keys(block.blueprint ?? {});
      expect(componentNames.length, `block "${block.id}" declares no components`).toBeGreaterThan(
        0,
      );
      for (const name of componentNames) {
        expect(name).toMatch(/^[A-Z]/);
        expect(getBlockBlueprint(name)).toBe(block.blueprint?.[name]);
      }
    }
  });
});
