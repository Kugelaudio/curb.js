/**
 * Bundle the framework's runtime for the browser (development only). The project is not in it:
 * the worker compiles the project's files against these modules on every save.
 *
 * Node built-ins resolve to, in order: a browser polyfill package
 * (`events`, `buffer`, ...), the browser's own API under Node's name (`builtins/web.ts`), or
 * a module whose every call throws naming itself (`builtins/unavailable.ts`).
 */

import { mkdir } from "node:fs/promises";
import { createRequire, builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildResult, type Plugin } from "esbuild";
import { RUNTIME_MODULES } from "./runtime-modules.js";

const frameworkSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRequire = createRequire(join(frameworkSrc, "index.ts"));
const builtinsDir = join(frameworkSrc, "browser", "builtins");

/** Node built-in -> browser polyfill package. */
const POLYFILLS: Record<string, string> = {
  events: "events/",
  path: "path-browserify",
  buffer: "buffer/",
  util: "util/",
  stream: "readable-stream",
  string_decoder: "string_decoder/",
};

/** Node built-in -> the export of `builtins/web.ts` that stands in for it. */
const WEB: Record<string, string> = {
  "stream/web": "streamWeb",
  "timers/promises": "timersPromises",
  timers: "timers",
  perf_hooks: "perfHooks",
  async_hooks: "asyncHooks",
  crypto: "crypto",
  url: "url",
  os: "os",
  module: "module",
  tty: "tty",
};

const BUILTINS = new Set(builtinModules);

/** What `import.meta.url` reads in the bundle. */
const BUNDLE_URL = "file:///curb-browser/agent.js";

function builtinName(path: string): string | null {
  const name = path.startsWith("node:") ? path.slice("node:".length) : path;
  // Exact names only (`fs/promises` is listed itself): `buffer/` is the polyfill package.
  return BUILTINS.has(name) ? name : null;
}

/** Valid export names: an unavailable module still offers each of Node's own names, so a named
 * import binds (and throws when called) instead of reading `undefined`. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Built-ins the worker provides part of: these exports come from the file (the worker's
 * in-memory volume for the conversation journal, the server the agent server listens on);
 * the rest stay unavailable. */
const PARTIAL: Record<string, { file: string; exports: readonly string[] }> = {
  fs: {
    file: "memory-fs.ts",
    exports: ["existsSync", "mkdirSync", "statSync", "appendFileSync", "truncateSync", "readFileSync", "openSync", "readSync", "closeSync"],
  },
  http: { file: "virtual-http.ts", exports: ["createServer"] },
};

function unavailableModuleSource(name: string): string {
  const real = frameworkRequire(`node:${name}`) as Record<string, unknown>;
  const names = Object.keys(real).filter((key) => IDENTIFIER.test(key) && key !== "default");
  const partial = PARTIAL[name];
  const provided = new Set(partial?.exports ?? []);
  const lines = [
    `import { unavailableModule } from ${JSON.stringify(join(builtinsDir, "unavailable.ts"))};`,
    `const unavailable = unavailableModule(${JSON.stringify(name)});`,
  ];
  if (partial) lines.push(`import * as provided from ${JSON.stringify(join(builtinsDir, partial.file))};`);
  lines.push(...names.map((key) => `export const ${key} = ${provided.has(key) ? `provided.${key}` : `unavailable.${key}`};`));
  lines.push("export default unavailable;");
  return lines.join("\n");
}

function nodeBuiltinsPlugin(): Plugin {
  return {
    name: "curb:browser-builtins",
    setup(builder) {
      builder.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const name = builtinName(args.path);
        if (!name) return undefined;
        const polyfill = POLYFILLS[name];
        if (polyfill) return { path: frameworkRequire.resolve(polyfill) };
        if (name === "process") return { path: join(builtinsDir, "process.ts") };
        return { path: name, namespace: "curb-builtin" };
      });
      builder.onLoad({ filter: /.*/, namespace: "curb-builtin" }, (args) => {
        const web = WEB[args.path];
        if (web) {
          return {
            contents: `module.exports = require(${JSON.stringify(join(builtinsDir, "web.ts"))}).${web};`,
            loader: "js",
            resolveDir: builtinsDir,
          };
        }
        return { contents: unavailableModuleSource(args.path), loader: "js", resolveDir: builtinsDir };
      });
    },
  };
}

/** Packages with a browser stand-in in `builtins/`: their API on the browser's own, or (`sharp`,
 * image resizing for LLM attachments) one that throws when used. */
const PACKAGES: Record<string, string> = {
  ws: "ws.ts",
  "onnxruntime-node": "onnxruntime.ts",
  sharp: "sharp.ts",
  pino: "pino.ts",
};

function browserPackagesPlugin(): Plugin {
  return {
    name: "curb:browser-packages",
    setup(builder) {
      // An optional peer of `@livekit/agents`, imported dynamically and only by LiveKit's own MCP
      // client, which Curb does not use. A project does not install it, so it stays unresolved.
      builder.onResolve({ filter: /^@modelcontextprotocol\/client(\/.*)?$/ }, (args) => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^(ws|onnxruntime-node|sharp|pino)$/ }, (args) => ({ path: join(builtinsDir, PACKAGES[args.path]!) }));
      builder.onResolve({ filter: /^\.\/native\.js$/ }, (args) =>
        args.importer.includes("/@livekit/rtc-ffi-bindings/") ? { path: join(builtinsDir, "rtc-ffi-native.ts") } : undefined,
      );
      // `local-host/synchronizer.ts` imports LiveKit's (unexported) transcription synchronizer by
      // file URL at run time, which a bundle cannot follow; here it is a static import of the
      // same file, so the bundle holds one instance of it, as the package's entry uses.
      builder.onResolve({ filter: /^\.\/synchronizer\.js$/ }, (args) =>
        args.importer.endsWith(join("local-host", "local-call-room.ts")) ? { path: "synchronizer", namespace: "curb-synchronizer" } : undefined,
      );
      builder.onLoad({ filter: /.*/, namespace: "curb-synchronizer" }, () => {
        const agentsDist = dirname(frameworkRequire.resolve("@livekit/agents"));
        const file = join(agentsDist, "voice", "transcription", "synchronizer.js");
        return {
          contents: [
            `import { TranscriptionSynchronizer, defaultTextSyncOptions } from ${JSON.stringify(file)};`,
            "export async function createSynchronizer(audio, text) {",
            "  return new TranscriptionSynchronizer(audio, text, defaultTextSyncOptions);",
            "}",
          ].join("\n"),
          loader: "js",
          resolveDir: agentsDist,
        };
      });
    },
  };
}

/** `curb` and its subpaths resolve to the framework's own source, as in a workspace. */
function curbSourcePlugin(): Plugin {
  const entries: Record<string, string> = {
    curb: "index.ts",
    "curb/providers": "providers.ts",
    "curb/orchestration": "orchestration.ts",
  };
  return {
    name: "curb:source",
    setup(builder) {
      builder.onResolve({ filter: /^curb(\/[a-z]+)?$/ }, (args) => {
        const file = entries[args.path];
        return file ? { path: join(frameworkSrc, file) } : undefined;
      });
    },
  };
}

/** Every runtime module but curb's own entries is a facade: an ES module with named exports
 * over the package or built-in stand-in (a CommonJS entry, react, would otherwise export only
 * `default`). */
function facadePlugin(): Plugin {
  return {
    name: "curb:facade",
    setup(builder) {
      builder.onResolve({ filter: /^curb-facade:/ }, (args) => ({ path: args.path.slice("curb-facade:".length), namespace: "curb-facade" }));
      builder.onLoad({ filter: /.*/, namespace: "curb-facade" }, (args) => {
        const names = Object.keys(frameworkRequire(args.path) as object).filter((key) => IDENTIFIER.test(key) && key !== "default");
        return {
          contents: [
            `import * as module from ${JSON.stringify(args.path)};`,
            "export default module.default ?? module;",
            `export const { ${names.join(", ")} } = module;`,
          ].join("\n"),
          loader: "js",
          resolveDir: frameworkSrc,
        };
      });
    },
  };
}

const CURB_ENTRIES: Record<string, string> = {
  curb: join(frameworkSrc, "index.ts"),
  "curb/providers": join(frameworkSrc, "providers.ts"),
};

const ENTRIES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(RUNTIME_MODULES).map(([specifier, file]) => [
      file.replace(/\.js$/, ""),
      CURB_ENTRIES[specifier] ?? `curb-facade:${specifier}`,
    ]),
  ),
  // The worker that runs the agent server, and the page's side (`page.ts`).
  worker: join(frameworkSrc, "browser", "worker.ts"),
  page: join(frameworkSrc, "browser", "page.ts"),
};

/** Writes the browser runtime to `outDir`: one ES module per `RUNTIME_MODULES` entry, the worker
 * and the page module, sharing chunks, so the worker holds one instance of every module. No
 * project code: the worker compiles that itself (`project-compile.ts`). */
export async function buildBrowserRuntime(outDir: string): Promise<BuildResult> {
  await mkdir(outDir, { recursive: true });
  return build({
    entryPoints: ENTRIES,
    outdir: outDir,
    bundle: true,
    splitting: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    sourcemap: "linked",
    logLevel: "warning",
    metafile: true,
    loader: { ".node": "empty" },
    // Framework modules compute paths from their own URL at load (createRequire, a repo root).
    // A file: URL keeps that arithmetic working; reading anything there still throws.
    define: {
      "process.env.NODE_ENV": '"development"',
      global: "globalThis",
      "import.meta.url": JSON.stringify(BUNDLE_URL),
      // The names the worker's project compile treats as Node built-ins (`project-compile.ts`).
      __CURB_NODE_BUILTINS__: JSON.stringify(builtinModules),
    },
    inject: [join(builtinsDir, "globals.ts")],
    plugins: [facadePlugin(), curbSourcePlugin(), browserPackagesPlugin(), nodeBuiltinsPlugin()],
  });
}
