import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as curb from "../index.js";
import { blockPreviewIds, getBlockPreview } from "./preview-registry.js";
import { blockDefinitions, getBlockBlueprint, getBlockCompiler } from "./registry.js";

const here = fileURLToPath(new URL("./", import.meta.url));
/** Every block: a folder under `src/blocks/`. */
const folders = readdirSync(here, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * Conformance test for the block folder recipe (see blocks/types.ts): a new block is a folder
 * with an `index.tsx` whose components `curb` exports. Fails the moment a block is added
 * halfway: a folder nobody can import, or a component that is not public.
 */
describe("block folders", () => {
  it("there are blocks, each in a kebab-case folder with an index.tsx", () => {
    expect(folders).toEqual(expect.arrayContaining(["handoff", "procedure", "transfer-call"]));
    for (const folder of folders) {
      expect(folder).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(existsSync(`${here}${folder}/index.tsx`), `src/blocks/${folder}/ has no index.tsx`).toBe(true);
    }
  });

  it.each(folders)("%s exports at least one component, and curb exports every one of them", async (folder) => {
    const block = (await import(`./${folder}/index.tsx`)) as Record<string, unknown>;
    const components = Object.keys(block).filter((name) => /^[A-Z][a-z]/.test(name) && typeof block[name] === "function");
    expect(components.length, `src/blocks/${folder}/index.tsx exports no component`).toBeGreaterThan(0);
    for (const name of components) {
      expect((curb as Record<string, unknown>)[name], `src/index.ts does not export <${name}>`).toBe(block[name]);
    }
  });

  it("a definition and a preview come together, and every definition is registered under its folder's name", () => {
    const withDefinition = folders.filter((folder) => existsSync(`${here}${folder}/definition.ts`));
    const withPreview = folders.filter((folder) => existsSync(`${here}${folder}/preview.tsx`));
    expect(withPreview).toEqual(withDefinition);
    expect(blockDefinitions.map((block) => block.id).sort()).toEqual(withDefinition.sort());
  });
});

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
