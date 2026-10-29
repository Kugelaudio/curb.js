/**
 * Builds the browser dev environment as static files: everything a page needs to develop a
 * Curb project with no server doing any work. Run once (when Curb is published, in the end);
 * any static host then serves the result (`serve-static.ts` locally, with the API relay).
 *
 *   index.html, assets/      the framework's preview app (Vite build), `page.js` loaded first
 *   runtime/                 the browser runtime (`browser-build.ts`)
 *   curb-browser/worker.js   the agent worker's boot file
 *   curb-browser/template.json  the project a new page starts with (path -> text)
 *   curb-browser/vendor/curb.tgz  the template's vendored Curb, packed with the project on deploy
 *   esbuild/esbuild.wasm     the compiler the worker runs on every save
 *   ort/, curb-assets/       ONNX Runtime Web and the Silero model, for calls
 *
 * Usage: tsx src/browser/static-build.ts <template project> <out dir> [--sessions <prefix>] [--sign-in <url>]
 *
 * `--sessions /agents/session/` makes every `<prefix><id>` a session page (`session.ts`), which
 * the host serves `index.html` at; `--sign-in https://www.example.com{session}` is where such a
 * page goes for a fresh link, `{session}` standing for its path. Both end up as meta tags.
 *
 * The template project is the starter a hosted project starts from (the KugelAudio platform
 * generates it with its vendored Curb and a package-lock.json), so a page's project deploys
 * through the ordinary build.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build as viteBuild, type Plugin } from "vite";
import { createPreviewConfig } from "../vite/preview-config.js";
import { buildBrowserRuntime } from "./browser-build.js";

const frameworkRequire = createRequire(import.meta.url);
const pageDir = fileURLToPath(new URL("./page/", import.meta.url));

/** Not part of the project a page keeps: installed, generated, or secret. */
const SKIPPED = new Set(["node_modules", ".git", ".curb", ".data", "dist"]);
/** The project's binary files: shipped beside the page (`curb-browser/<path>`) and packed from there. */
const ASSETS = ["vendor/curb.tgz"];
const MAX_TEMPLATE_FILE = 4 * 1024 * 1024;

/**
 * The project a new page starts with, path -> text: every text file of the template project
 * (the platform's starter: sources, context, package.json and package-lock.json, the files a
 * coding agent reads), so that a page's project deploys and pushes as the starter would.
 */
function templateFiles(projectRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relativePath = relative(projectRoot, path).split(sep).join("/");
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const name = entry.name;
      // Secrets stay out, and the preview's context index is the page's to answer (`page.ts`).
      if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") continue;
      if (name === "context.index.json" || ASSETS.includes(relativePath)) continue;
      const bytes = readFileSync(path);
      if (bytes.length > MAX_TEMPLATE_FILE || bytes.includes(0)) {
        throw new Error(`static-build: ${relativePath} is not a text file the page can keep (${bytes.length} bytes).`);
      }
      files[relativePath] = bytes.toString("utf8");
    }
  };
  walk(projectRoot);
  if (!files["package.json"]) throw new Error(`static-build: ${projectRoot} has no package.json.`);
  if (!files["package-lock.json"]) throw new Error(`static-build: ${projectRoot} has no package-lock.json; deploying needs one.`);
  return files;
}

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: { sessions: { type: "string" }, "sign-in": { type: "string" } },
});
if (options.sessions !== undefined && !/^\/(?:[^/]+\/)*$/.test(options.sessions)) {
  throw new Error("static-build: --sessions is a path that starts and ends with /, e.g. /agents/session/.");
}
if (options["sign-in"] !== undefined && (!options.sessions || !options["sign-in"].includes("{session}"))) {
  throw new Error("static-build: --sign-in needs --sessions and a {session} in the URL.");
}
const metas = Object.entries({ "curb-sessions": options.sessions, "curb-sign-in": options["sign-in"] })
  .filter((entry): entry is [string, string] => entry[1] !== undefined)
  .map(([name, content]) => ({ tag: "meta", attrs: { name, content }, injectTo: "head-prepend" as const }));

/**
 * `page.js` before the preview app: it routes the preview's sockets and requests to the worker.
 * The session settings come before it, and the page's own files are absolute paths, so the
 * same `index.html` serves every session path.
 */
const runtimeFirst: Plugin = {
  name: "curb:browser-runtime",
  transformIndexHtml: () => [...metas, { tag: "script", attrs: { type: "module", src: "/runtime/page.js" }, injectTo: "head-prepend" }],
};

function copyInto(directory: string, files: readonly string[]): void {
  mkdirSync(directory, { recursive: true });
  for (const file of files) copyFileSync(file, join(directory, file.split(sep).at(-1)!));
}

const [templateArg, outArg] = positionals;
if (!templateArg || !outArg) throw new Error("Usage: tsx src/browser/static-build.ts <template project> <out dir> [--sessions <prefix>] [--sign-in <url>]");
const templateRoot = resolve(templateArg);
const outDir = resolve(outArg);
const started = performance.now();

const previewConfig = createPreviewConfig({ projectRoot: templateRoot, attachTo: createServer() });
await viteBuild({
  ...previewConfig,
  server: undefined,
  // The context markdown is the project's, which the page keeps.
  publicDir: false,
  logLevel: "warn",
  plugins: [...(previewConfig.plugins ?? []).filter((plugin) => (plugin as Plugin).name !== "framework:context-index"), runtimeFirst],
  build: {
    outDir,
    emptyOutDir: true,
    // Node-only modules the preview reaches behind a runtime guard (`public-context.ts` imports
    // `public-context.node.js` only under Node) import names Vite's browser stub lacks. Vite's
    // dev server, which `curb dev` serves the preview with, leaves those undefined; so does this.
    rollupOptions: { shimMissingExports: true },
  },
});
await buildBrowserRuntime(join(outDir, "runtime"));

copyInto(join(outDir, "curb-browser"), [join(pageDir, "worker.js")]);
writeFileSync(join(outDir, "curb-browser", "template.json"), JSON.stringify(templateFiles(templateRoot)));
for (const asset of ASSETS) {
  if (existsSync(join(templateRoot, asset))) copyInto(join(outDir, "curb-browser", dirname(asset)), [join(templateRoot, asset)]);
}
copyInto(join(outDir, "esbuild"), [join(dirname(frameworkRequire.resolve("esbuild-wasm/package.json")), "esbuild.wasm")]);
const ortDir = dirname(frameworkRequire.resolve("onnxruntime-web/wasm"));
copyInto(
  join(outDir, "ort"),
  readdirSync(ortDir).filter((name) => /^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(name)).map((name) => join(ortDir, name)),
);
copyInto(join(outDir, "curb-assets"), [join(dirname(frameworkRequire.resolve("@livekit/agents-plugin-silero")), "silero_vad.onnx")]);

console.log(`browser dev environment built in ${Math.round(performance.now() - started)} ms: ${outDir}`);
