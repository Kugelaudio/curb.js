import type { Metafile } from "esbuild";
import { describe, expect, it } from "vitest";
import { analyzeMetafile, type BuildInputs } from "./layers.js";
import {
  findLayerEscape,
  LAYER_ESCAPE_EXIT_CODE,
  layerEscapeLine,
  missingModuleEscape,
  unresolvedImportEscape,
} from "./layer-escape.js";

/**
 * The escape rules of a dependency-layer build, over synthetic metafiles.
 *
 * A hit-mode build runs esbuild against a node_modules that holds only the recorded build
 * inputs. Anything the bundle reaches outside that record could make its output differ from
 * the full build's, so each rule here is a way the bundle can step outside it -- and each
 * one must be reported rather than built past. The integration half, against a real
 * project and a real esbuild, is layered-build.test.ts.
 */

const where = { absWorkingDir: "/work", projectRoot: "/work/app" };

type Inputs = Metafile["inputs"];
const input = (imports: Inputs[string]["imports"] = []): Inputs[string] => ({ bytes: 1, imports });
const metafile = (inputs: Inputs): Metafile => ({ inputs, outputs: {} });

/** The metafile of the full build a layer was recorded from. */
function recordedInputs(): Inputs {
  return {
    "app/.curb/build/hosted-worker.mjs": input([
      { path: "@livekit/agents", kind: "import-statement", external: true },
      { path: "node:url", kind: "import-statement", external: true },
    ]),
    "app/src/agent/agent.tsx": input([
      { path: "app/node_modules/foo/index.js", kind: "import-statement", original: "foo" },
      { path: "app/src/agent/local.ts", kind: "import-statement", original: "./local.ts" },
      { path: "fs", kind: "require-call", external: true },
    ]),
    "app/src/agent/local.ts": input(),
    "curb-raw:app/src/agent/agent.tsx": input(),
    "app/node_modules/foo/index.js": input([
      { path: "app/node_modules/bar/index.js", kind: "require-call", original: "bar" },
    ]),
    "app/node_modules/bar/index.js": input([
      {
        path: "app/node_modules/bar/node_modules/foo/index.js",
        kind: "require-call",
        original: "foo",
      },
    ]),
    "app/node_modules/bar/node_modules/foo/index.js": input(),
    "node_modules/react/index.js": input(),
  };
}

function record(inputs: Inputs): BuildInputs {
  const analysis = analyzeMetafile(metafile(inputs), where);
  return {
    format: 1,
    inputs: analysis.nodeModulesReads,
    edges: analysis.edges,
    recordedExternals: analysis.externals,
  };
}

const escapeOf = (inputs: Inputs) =>
  findLayerEscape(analyzeMetafile(metafile(inputs), where), record(recordedInputs()));

describe("analyzeMetafile", () => {
  const analysis = analyzeMetafile(metafile(recordedInputs()), where);

  it("lists node_modules reads project-root-relative, byte-sorted, including hoisted ones above the project", () => {
    expect(analysis.nodeModulesReads).toEqual([
      "../node_modules/react/index.js",
      "node_modules/bar/index.js",
      "node_modules/bar/node_modules/foo/index.js",
      "node_modules/foo/index.js",
    ]);
  });

  it("records bare edges only from project and generated files, never builtins or relative imports", () => {
    expect(analysis.edges).toEqual([
      {
        importer: ".curb/build/hosted-worker.mjs",
        specifier: "@livekit/agents",
        kind: "import-statement",
        resolved: "@livekit/agents",
      },
      {
        importer: "src/agent/agent.tsx",
        specifier: "foo",
        kind: "import-statement",
        resolved: "node_modules/foo/index.js",
      },
    ]);
  });

  it("records bare externals from every input, without Node builtins", () => {
    expect(analysis.externals).toEqual(["@livekit/agents"]);
    expect(analysis.sourceNodeModules).toEqual([]);
  });
});

describe("findLayerEscape", () => {
  it("finds nothing when the bundle reads exactly what was recorded", () => {
    expect(escapeOf(recordedInputs())).toBeUndefined();
  });

  it("does not escape over a new Node builtin import", () => {
    const inputs = recordedInputs();
    inputs["app/src/agent/agent.tsx"].imports.push(
      { path: "node:crypto", kind: "import-statement", external: true },
      { path: "crypto", kind: "import-statement", external: true },
    );
    expect(escapeOf(inputs)).toBeUndefined();
  });

});

describe("unresolvedImportEscape", () => {
  it("turns esbuild's Could not resolve into an escape naming the specifier", () => {
    const failure = Object.assign(new Error("Build failed with 1 error"), {
      errors: [{ text: 'Could not resolve "left-pad"', location: { file: "src/agent/agent.tsx" } }],
    });
    expect(unresolvedImportEscape(failure)).toMatchObject({
      code: "layer_escape",
      reason: "unresolved_import",
      path: "left-pad",
    });
  });

  it("leaves every other build failure alone", () => {
    const failure = Object.assign(new Error("Build failed with 1 error"), {
      errors: [{ text: 'Expected ";" but found "x"' }],
    });
    expect(unresolvedImportEscape(failure)).toBeUndefined();
    expect(unresolvedImportEscape(new Error("disk full"))).toBeUndefined();
  });
});

describe("missingModuleEscape", () => {
  const notFound = (message: string, code = "ERR_MODULE_NOT_FOUND") => Object.assign(new Error(message), { code });

  it("turns a module Node cannot find while the build imports the agent into an unresolved_import escape", () => {
    expect(
      missingModuleEscape(notFound("Cannot find package 'layer-unused' imported from /p/src/agent/agent.tsx"), "/p"),
    ).toMatchObject({ code: "layer_escape", reason: "unresolved_import", path: "layer-unused" });
    expect(
      missingModuleEscape(notFound("Cannot find module '/p/node_modules/zod/v4/index.js' imported from /p/x.js"), "/p"),
    ).toMatchObject({ path: "node_modules/zod/v4/index.js" });
    expect(
      missingModuleEscape(notFound("Cannot find module 'undici'\nRequire stack:\n- /p/x.js", "MODULE_NOT_FOUND"), "/p"),
    ).toMatchObject({ path: "undici" });
  });

  it("leaves every other failure to be reported as itself", () => {
    expect(missingModuleEscape(new Error("goals need a database"), "/p")).toBeUndefined();
    expect(missingModuleEscape("not even an error", "/p")).toBeUndefined();
  });
});
