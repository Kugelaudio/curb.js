import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The preview page never imports the project's agent. Agent code runs on the server, under
 * Node, where a skill may import `node:crypto` or read `process.env` at module scope; in the
 * browser either one leaves the page blank, and `curb check`, `curb say` and `curb test` all
 * run under Node, so none of them would notice. The page gets the agent as data over its
 * WebSocket instead (the `agents` frame).
 *
 * An installed framework file can reach a project's files only through a Vite virtual module
 * (`import.meta.glob` cannot leave the package), so the page's graph must hold framework
 * source and packages, and no `virtual:` module.
 */

const src = fileURLToPath(new URL("..", import.meta.url));

describe("preview page module graph", () => {
  it("holds framework source and packages only, never the project's agent modules", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./main.tsx", import.meta.url))],
      absWorkingDir: src,
      bundle: true,
      platform: "browser",
      format: "esm",
      // main.tsx awaits the context markdown at the top level.
      target: "esnext",
      write: false,
      metafile: true,
      logLevel: "silent",
      // Which packages the page uses is not the question here, and leaving them out keeps the
      // graph to the framework's own files.
      packages: "external",
      loader: { ".css": "empty" },
    });

    const inputs = Object.keys(result.metafile.inputs);
    const outsideFrameworkSource = inputs.filter(
      (input) => isAbsolute(input) || input.startsWith("..") || relative(src, input).startsWith("test-fixtures"),
    );
    expect(outsideFrameworkSource).toEqual([]);

    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((entry) => entry.path),
    );
    expect([...new Set(imports)].filter((path) => path.startsWith("virtual:"))).toEqual([]);
  });
});
