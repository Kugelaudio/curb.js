/**
 * Compiles a project's agent in the browser runtime's worker, with esbuild's WebAssembly build,
 * from the project's files as the page keeps them: the agent registry `curb build` would
 * generate (`agent-registry-code.ts`), bundled with the project's own modules and the packages
 * it installed in `node_modules/` (`npm-install.ts`), resolved as Node does (`exports`,
 * `browser`, `module`, `main`). The framework, react, zod and the Node built-ins the runtime
 * provides stay outside the result, imported from the runtime's files (`RUNTIME_MODULES`), so
 * the project binds to the instances the runtime itself runs on. A built-in the browser has no
 * stand-in for compiles, and throws naming itself when the package calls it.
 */

import * as esbuild from "esbuild-wasm";
import { AGENT_ENTRY_CANDIDATES, agentRegistryCode } from "../bundler/agent-registry-code.js";
import { missingAgentMessage } from "../project.node.js";
import { RUNTIME_MODULES, RUNTIME_PATH } from "./runtime-modules.js";

/** Project files by project-relative POSIX path (`src/agent/agent.tsx`), as text. */
export type ProjectFiles = Readonly<Record<string, string>>;

const AGENT_DIR = "src/agent/";
const CONTEXT_DIR = "context/";
/** The generated registry, the bundle's entry. */
const ENTRY = "/.curb/agent-registry.js";
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];
const LOADERS: Record<string, esbuild.Loader> = {
  ".tsx": "tsx",
  ".ts": "ts",
  ".jsx": "jsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
};

/** The project failed to compile; `message` lists esbuild's errors with their locations. */
export class ProjectCompileError extends Error {
  override readonly name = "ProjectCompileError";
}

let initialized: Promise<void> | null = null;

/** Loads esbuild's WebAssembly once per worker (in this thread: the worker is already off the page's). */
export function initializeCompiler(wasmURL: string): Promise<void> {
  initialized ??= esbuild.initialize({ wasmURL, worker: false });
  return initialized;
}

/** The `context/` markdown, keyed as `<Text src>` names it (relative to `context/`). */
export function contextMarkdown(files: ProjectFiles): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).flatMap(([path, text]) =>
      path.startsWith(CONTEXT_DIR) && path.endsWith(".md") ? [[path.slice(CONTEXT_DIR.length), text]] : [],
    ),
  );
}

/** Segment by segment, as `curb build`'s depth-first walk orders a directory's entries. */
function bySegments(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = a[index]!.localeCompare(b[index]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

export function projectRegistryCode(files: ProjectFiles): string {
  const entry = AGENT_ENTRY_CANDIDATES.find((name) => `${AGENT_DIR}${name}` in files);
  if (!entry) throw new ProjectCompileError(missingAgentMessage("/"));
  const skills = Object.keys(files)
    .filter((path) => path.startsWith(AGENT_DIR) && (path === `${AGENT_DIR}skill.tsx` || path.endsWith("/skill.tsx")))
    .map((path) => path.slice(AGENT_DIR.length))
    .sort(bySegments);
  return agentRegistryCode(entry, skills, (relativePath) => `/${AGENT_DIR}${relativePath}`);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") out.pop();
    else if (segment && segment !== ".") out.push(segment);
  }
  return out.join("/");
}

/** The project file an import names, as `/<path>`, trying TypeScript's extension rules
 * (`./x.js` may be `x.ts`); null when the project has no such file. */
function resolveProjectFile(files: ProjectFiles, specifier: string, importer: string): string | null {
  const base = normalize(specifier.startsWith("/") ? specifier : `${importer.slice(0, importer.lastIndexOf("/"))}/${specifier}`);
  const stem = base.replace(/\.(m?js|cjs|jsx)$/, "");
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx"].map((extension) => `${stem}${extension}`),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  const found = candidates.find((candidate) => candidate in files);
  return found === undefined ? null : `/${found}`;
}

/** Node's built-in module names, from the runtime build (`browser-build.ts` defines it). */
declare const __CURB_NODE_BUILTINS__: readonly string[];
const NODE_BUILTINS = new Set(typeof __CURB_NODE_BUILTINS__ === "undefined" ? [] : __CURB_NODE_BUILTINS__);
/** The conditions a browser bundle matches in a package's `exports`; the first key the
 * package lists among them wins, as in Node and esbuild. */
const CONDITIONS = new Set(["browser", "import", "module", "default", "require"]);

type PackageJson = {
  exports?: unknown;
  browser?: string | Record<string, string | false>;
  module?: string;
  main?: string;
};

/** `name` and `./subpath` of a bare specifier (`@scope/name/sub` too). */
function splitBare(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const length = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(length).join("/");
  return { name: parts.slice(0, length).join("/"), subpath: rest ? `./${rest}` : "." };
}

/** A package's `exports` target for `subpath` under the browser conditions, or undefined. */
function exportTarget(exports: unknown, subpath: string): string | null | undefined {
  const pick = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pick(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      for (const [condition, target] of Object.entries(value)) {
        if (!CONDITIONS.has(condition)) continue;
        const found = pick(target);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const isSubpathMap = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."));
  if (!isSubpathMap) return subpath === "." ? pick(exports) : undefined;
  const map = exports as Record<string, unknown>;
  if (subpath in map) return pick(map[subpath]);
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const [before, after] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= pattern.length - 1) {
      const target = pick(value);
      // Node substitutes every `*` of the target, not only the first.
      return typeof target === "string" ? target.replaceAll("*", subpath.slice(before.length, subpath.length - after.length)) : target;
    }
  }
  return undefined;
}

type Resolved = { path: string } | { empty: true } | { missing: string };

/** The installed package `file` (`/node_modules/a/lib/x.js`) belongs to: its root and its
 * `browser` map; null for the project's own files. */
function owningPackage(files: ProjectFiles, file: string): { root: string; browserMap: Record<string, string | false> } | null {
  const match = /^\/?((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
  const manifestText = match ? files[`${match[1]}/package.json`] : undefined;
  if (!match || manifestText === undefined) return null;
  const { browser } = JSON.parse(manifestText) as PackageJson;
  return { root: match[1]!, browserMap: typeof browser === "object" ? browser : {} };
}

/** `file` after its package's `browser` map, which replaces one of the package's own files,
 * or empties it with false (axios's Node adapter, for one). */
function browserFile(files: ProjectFiles, file: string): Resolved {
  const owner = owningPackage(files, file);
  const replaced = owner?.browserMap[`./${file.slice(owner.root.length + 2)}`];
  if (replaced === false) return { empty: true };
  if (owner && typeof replaced === "string") {
    const swap = resolveProjectFile(files, `/${owner.root}/${replaced.replace(/^\.\//, "")}`, "/");
    if (swap) return { path: swap };
  }
  return { path: file };
}

/** A bare import from `importer`: the nearest `node_modules/<name>` up its directories, after
 * the importing package's `browser` map, which may name another package or false. */
function resolvePackage(files: ProjectFiles, specifier: string, importer: string): Resolved {
  const mapped = owningPackage(files, importer)?.browserMap[specifier];
  if (mapped === false) return { empty: true };
  if (typeof mapped === "string" && mapped !== specifier) {
    if (/^\.{0,2}\//.test(mapped)) {
      const owner = owningPackage(files, importer)!;
      const file = resolveProjectFile(files, `/${owner.root}/${mapped.replace(/^\.\//, "")}`, "/");
      return file ? { path: file } : { missing: `the browser map names "${mapped}", which is not in the package` };
    }
    return resolvePackage(files, mapped, importer);
  }
  const { name, subpath } = splitBare(specifier);
  let directory = importer.slice(0, importer.lastIndexOf("/"));
  for (;;) {
    const root = normalize(`${directory}/node_modules/${name}`);
    const manifestText = files[`${root}/package.json`];
    if (manifestText !== undefined) {
      const manifest = JSON.parse(manifestText) as PackageJson;
      let target: string | null | undefined;
      if (manifest.exports !== undefined) {
        target = exportTarget(manifest.exports, subpath);
        if (target === undefined) return { missing: `${name} does not export "${subpath}"` };
      } else if (subpath === ".") {
        target = (typeof manifest.browser === "string" ? manifest.browser : undefined) ?? manifest.module ?? manifest.main ?? "./index.js";
      } else {
        target = subpath;
      }
      if (target === null) return { empty: true };
      const file = resolveProjectFile(files, `/${root}/${target.replace(/^\.\//, "")}`, "/");
      if (!file) return { missing: `${name}: no file for "${target}"` };
      return browserFile(files, file);
    }
    if (directory === "" || directory === "/") return { missing: `"${name}" is not installed (no node_modules/${name}/package.json)` };
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
}

/** `name` is a dependency the importing package can do without: optional, or an optional peer. */
function optionalFor(files: ProjectFiles, importer: string, name: string): boolean {
  const owner = owningPackage(files, importer);
  if (!owner) return false;
  const manifest = JSON.parse(files[`${owner.root}/package.json`]!) as PackageJson & {
    optionalDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  return Boolean(manifest.optionalDependencies?.[name] ?? manifest.peerDependenciesMeta?.[name]?.optional);
}

/** A missing optional dependency: loading it throws as Node's require does, which the package
 * expects and catches (`npm-install.ts` records optional dependencies without unpacking them). */
function missingOptionalSource(name: string): string {
  return [
    `const error = new Error("Cannot find module '${name}': an optional dependency, not installed in the browser.");`,
    'error.code = "MODULE_NOT_FOUND";',
    "throw error;",
  ].join("\n");
}

/** A built-in with no browser stand-in: importing works, calling throws naming it. */
function unavailableBuiltinSource(name: string): string {
  return [
    "module.exports = new Proxy({}, {",
    "  get(_target, key) {",
    '    if (key === "__esModule" || typeof key === "symbol") return undefined;',
    "    return function unavailable() {",
    `      const error = new Error(\`${name}.\${String(key)} is not available in the browser runtime: a page has no ${name}.\`);`,
    '      error.code = "CURB_BROWSER_UNAVAILABLE";',
    "      throw error;",
    "    };",
    "  },",
    "});",
  ].join("\n");
}

function projectFilesPlugin(files: ProjectFiles, runtimeOrigin: string): esbuild.Plugin {
  const registry = projectRegistryCode(files);
  const notFound = (args: esbuild.OnResolveArgs) => ({
    errors: [{ text: `Could not resolve "${args.path}" from ${args.importer || "the agent registry"}: no such project file.` }],
  });
  return {
    name: "curb:project-files",
    setup(builder) {
      // The require() bridge's two halves (below); first, so the project resolvers never see them.
      builder.onResolve({ filter: /^curb-runtime-value:/ }, (args) => ({
        path: args.path.slice("curb-runtime-value:".length),
        namespace: "runtime-value",
      }));
      builder.onResolve({ filter: /.*/, namespace: "runtime-value" }, (args) => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /\?raw$/ }, (args) => {
        const path = resolveProjectFile(files, args.path.slice(0, -"?raw".length), args.importer);
        return path ? { path, namespace: "project-raw" } : notFound(args);
      });
      const located = (resolved: Resolved, args: esbuild.OnResolveArgs) =>
        "path" in resolved ? { path: resolved.path, namespace: "project" } : { path: args.path, namespace: "empty" };
      builder.onResolve({ filter: /^\.{0,2}\// }, (args) => {
        if (args.kind === "entry-point") return { path: ENTRY, namespace: "project" };
        const path = resolveProjectFile(files, args.path, args.importer);
        return path ? located(browserFile(files, path), args) : notFound(args);
      });
      builder.onResolve({ filter: /.*/ }, (args) => {
        const bare = args.path.startsWith("node:") ? args.path.slice("node:".length) : args.path;
        const file = RUNTIME_MODULES[bare];
        if (file) {
          const url = new URL(`${RUNTIME_PATH}${file}`, runtimeOrigin).href;
          // A runtime module is an ES module the page loads; CommonJS reaches it through a
          // bundled bridge, since a bundle cannot require() a URL.
          return args.kind === "require-call" ? { path: url, namespace: "runtime-require" } : { path: url, external: true };
        }
        if (NODE_BUILTINS.has(bare)) return { path: bare, namespace: "unavailable-builtin" };
        const resolved = resolvePackage(files, args.path, args.importer || ENTRY);
        if ("missing" in resolved) {
          const { name } = splitBare(args.path);
          if (args.importer && optionalFor(files, args.importer.replace(/^\//, ""), name)) return { path: name, namespace: "missing-optional" };
          return { errors: [{ text: `Could not resolve "${args.path}": ${resolved.missing}. Add it with agent_add_dependency, or curb.project.install("${splitBare(args.path).name}") in the page.` }] };
        }
        return located(resolved, args);
      });
      // What require() of a runtime module returns: its CommonJS value (a facade's default,
      // `require("events")` being EventEmitter itself), else its namespace.
      builder.onLoad({ filter: /.*/, namespace: "runtime-require" }, (args) => ({
        contents: `module.exports = require(${JSON.stringify(`curb-runtime-value:${args.path}`)}).value;`,
        loader: "js",
      }));
      builder.onLoad({ filter: /.*/, namespace: "runtime-value" }, (args) => ({
        contents: `import * as ns from ${JSON.stringify(args.path)};\nexport const value = "default" in ns ? ns.default : ns;`,
        loader: "js",
      }));
      builder.onLoad({ filter: /.*/, namespace: "unavailable-builtin" }, (args) => ({
        contents: unavailableBuiltinSource(args.path),
        loader: "js",
      }));
      builder.onLoad({ filter: /.*/, namespace: "missing-optional" }, (args) => ({
        contents: missingOptionalSource(args.path),
        loader: "js",
      }));
      builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));
      builder.onLoad({ filter: /.*/, namespace: "project" }, (args) => {
        if (args.path === ENTRY) return { contents: registry, loader: "js" };
        const extension = args.path.slice(args.path.lastIndexOf("."));
        return { contents: files[args.path.slice(1)], loader: LOADERS[extension] ?? "text" };
      });
      builder.onLoad({ filter: /.*/, namespace: "project-raw" }, (args) => ({
        contents: `export default ${JSON.stringify(files[args.path.slice(1)])};`,
        loader: "js",
      }));
    },
  };
}

/** The project's agent registry as one ES module's source. Throws `ProjectCompileError`. */
export async function compileProject(files: ProjectFiles, runtimeOrigin: string): Promise<string> {
  try {
    const result = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      sourcemap: "inline",
      logLevel: "silent",
      plugins: [projectFilesPlugin(files, runtimeOrigin)],
    });
    return result.outputFiles[0]!.text;
  } catch (error) {
    const failure = error as Partial<esbuild.BuildFailure>;
    if (!failure.errors) throw error;
    const lines = failure.errors.map((message) => {
      const at = message.location;
      return at ? `${at.file.replace(/^project(-raw)?:\//, "")}:${at.line}:${at.column}: ${message.text}` : message.text;
    });
    throw new ProjectCompileError(lines.join("\n"), { cause: error });
  }
}
