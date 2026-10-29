import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `curb/client` runs in the caller's browser, so its bundle graph may hold only itself, the
 * dependency-free wire constants, and `livekit-client`. A runtime import of anything else
 * (zod, React, the server, a Node builtin) would ship it to every app that talks to an agent,
 * or break the bundle outright.
 */

const src = fileURLToPath(new URL("..", import.meta.url));

describe("curb/client bundle graph", () => {
  it("bundles for the browser from its own files, the wire constants and livekit-client only", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: ["livekit-client"],
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => relative(src, input).replaceAll("\\", "/"));
    expect(inputs.sort()).toEqual(["client/index.ts", "wire.ts"]);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    expect([...new Set(imports)]).toEqual(["livekit-client"]);
  });
});
