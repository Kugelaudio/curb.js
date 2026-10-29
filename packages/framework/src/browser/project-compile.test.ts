import { describe, expect, it } from "vitest";
import { compileProject, ProjectCompileError, type ProjectFiles } from "./project-compile.js";

const ORIGIN = "http://127.0.0.1:4630";
const json = (value: unknown) => JSON.stringify(value);

/** A project whose agent imports `imports` and puts `uses` into its module scope. */
function project(imports: string, uses: string, packages: ProjectFiles = {}): ProjectFiles {
  return {
    "package.json": json({ name: "p", type: "module" }),
    "src/agent/agent.tsx": `${imports}\nexport const used = [${uses}];\nexport default function App() { return null; }\n`,
    ...packages,
  };
}

describe("compileProject: installed packages", () => {
  it("picks the first condition a package lists, as Node and esbuild do", async () => {
    const code = await compileProject(
      project('import value from "dual";', "value", {
        "node_modules/dual/package.json": json({ name: "dual", exports: { ".": { require: "./req.cjs", import: "./imp.js" } } }),
        "node_modules/dual/req.cjs": 'module.exports = "from-require";',
        "node_modules/dual/imp.js": 'export default "from-import";',
      }),
      ORIGIN,
    );
    expect(code).toContain("from-require");
    expect(code).not.toContain("from-import");
  });

  it("applies a package's browser map to its own relative imports and to bare names", async () => {
    const code = await compileProject(
      project('import adapter from "lib";', "adapter", {
        "node_modules/lib/package.json": json({
          name: "lib",
          main: "./index.js",
          browser: { "./node.js": "./web.js", "./proxy.js": false, "proxy-agent": false },
        }),
        "node_modules/lib/index.js": 'import a from "./node.js";\nimport "./proxy.js";\nimport "proxy-agent";\nexport default a;',
        "node_modules/lib/node.js": 'export default "node-adapter";',
        "node_modules/lib/web.js": 'export default "web-adapter";',
        "node_modules/lib/proxy.js": 'export default "proxy-file";',
      }),
      ORIGIN,
    );
    expect(code).toContain("web-adapter");
    expect(code).not.toContain("node-adapter");
    expect(code).not.toContain("proxy-file");
  });

  it("gives require() of a runtime module its value through a bundled bridge, not a URL require", async () => {
    const code = await compileProject(
      project('import emitter from "cjs-user";', "emitter", {
        "node_modules/cjs-user/package.json": json({ name: "cjs-user", main: "index.js" }),
        "node_modules/cjs-user/index.js": 'const EventEmitter = require("events");\nmodule.exports = new EventEmitter();',
      }),
      ORIGIN,
    );
    expect(code).toMatch(/import \* as \w+ from "http:\/\/127\.0\.0\.1:4630\/runtime\/node-events\.js"/);
    expect(code).toContain('"default" in ns');
    expect(code).not.toMatch(/require\("http/);
  });

  it("names the package to install when an import is missing", async () => {
    const failure = await compileProject(project('import pad from "left-pad";', "pad"), ORIGIN).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectCompileError);
    expect((failure as Error).message).toContain('agent_add_dependency, or curb.project.install("left-pad")');
  });

  it("compiles a missing optional dependency to a module that throws MODULE_NOT_FOUND, as Node's require does", async () => {
    const code = await compileProject(
      project('import lib from "lib";', "lib", {
        "node_modules/lib/package.json": json({ name: "lib", main: "./index.js", optionalDependencies: { "native-speedup": "^1.0.0" } }),
        "node_modules/lib/index.js": 'let fast = null;\ntry { fast = require("native-speedup"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }\nmodule.exports = { fast };',
      }),
      ORIGIN,
    );
    expect(code).toContain("MODULE_NOT_FOUND");
    expect(code).toContain("Cannot find module 'native-speedup'");
  });

  it("still refuses a missing dependency that is not optional", async () => {
    await expect(
      compileProject(
        project('import lib from "lib";', "lib", {
          "node_modules/lib/package.json": json({ name: "lib", main: "./index.js" }),
          "node_modules/lib/index.js": 'module.exports = require("needed");',
        }),
        ORIGIN,
      ),
    ).rejects.toThrow(/"needed" is not installed/);
  });
});
