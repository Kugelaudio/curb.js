import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPublicMarkdown, resolvePublicMarkdown } from "../public-context.js";
import { generateContextRegistryCode, projectContextFiles } from "./context-registry.js";

/**
 * A `curb build` artifact runs from an arbitrary directory outside any curb project, so
 * the runtime's `<project>/context/` lookup finds nothing there. These cover what has to
 * travel WITH the bundle for `<Text src=…>` to resolve at all — the failure was an agent
 * that joined a room and had nothing to say, and it reported "Available files: (none)".
 */

const PUBLIC_CONTEXT_MODULE = resolve(import.meta.dirname, "..", "public-context.ts");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-context-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A project root holding only a context/ tree. */
function writeProject(files: Record<string, string>): string {
  const projectRoot = join(root, "project");
  for (const [path, contents] of Object.entries(files)) {
    const file = join(projectRoot, "context", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return projectRoot;
}

describe("generateContextRegistryCode", () => {
  it("inlines every markdown file under context/", () => {
    const projectRoot = writeProject({
      "policy/coverage-basics.md": "# Coverage basics\n\nProperty damage is covered.\n",
      "member/unlocked-context.md": "# Member briefing\n",
      "notes.txt": "not markdown",
    });

    const code = generateContextRegistryCode(projectRoot, PUBLIC_CONTEXT_MODULE);

    expect(code).toContain("setBundledPublicMarkdown");
    expect(code).toContain(JSON.stringify("policy/coverage-basics.md"));
    expect(code).toContain(JSON.stringify("member/unlocked-context.md"));
    expect(code).toContain(JSON.stringify("# Coverage basics\n\nProperty damage is covered.\n"));
    expect(code).not.toContain("notes.txt");
  });

  it("inlines files no component references, because src can be computed at render time", () => {
    // The whole directory, not a scan of static `<Text src="…">` literals: a skill loaded
    // mid-conversation can render `<Text src={`policy/${topic}.md`} />`, which no
    // build-time scan can enumerate.
    const projectRoot = writeProject({ "unreferenced/aside.md": "# Never mentioned in JSX\n" });

    expect(generateContextRegistryCode(projectRoot, PUBLIC_CONTEXT_MODULE)).toContain(
      JSON.stringify("unreferenced/aside.md"),
    );
  });

});

describe("the artifact's context load path", () => {
  it("resolves markdown that exists only in the bundle, not on disk", async () => {
    // The hosted case in miniature: the src is NOT under the project the process resolves
    // context/ against (the test fixture), so before the registry existed this threw
    // `Context markdown … was not found. Available files: …` — the exact message the
    // hosted agent logged.
    const src = "hosted-only/from-artifact.md";
    expect(listPublicMarkdown()).not.toContain(src);
    expect(() => resolvePublicMarkdown(src)).toThrowError(/was not found/);

    const projectRoot = writeProject({ [src]: "# Only inside the artifact\n" });
    const modulePath = join(root, "context-registry.mjs");
    writeFileSync(
      modulePath,
      generateContextRegistryCode(projectRoot, PUBLIC_CONTEXT_MODULE),
      "utf8",
    );

    // Importing the generated module IS installing the context, exactly as the generated
    // entries do.
    await import(pathToFileURL(modulePath).href);

    expect(resolvePublicMarkdown("hosted-only/from-artifact")).toBe("# Only inside the artifact\n");
    expect(listPublicMarkdown()).toContain(src);
  });
});
