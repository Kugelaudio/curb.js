import { existsSync, realpathSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { searchForWorkspaceRoot, type InlineConfig } from "vite";
import { resolveContextDir } from "../project.node.js";
import { VITE_HMR_PATH } from "../server/hmr-path.js";
import { contextIndexPlugin } from "./context-index-plugin.js";

/** The installed framework package — the preview app (index.html +
 * src/preview/) is served from here, like Next.js owning its dev server. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Vite config for hosting the framework preview app against a consuming
 * project: the app shell and framework source come from the package, and the
 * public context markdown from the project. The project's agent modules never
 * enter the page: they run in the agent server, which sends the page what it
 * shows over the WebSocket.
 *
 * Vite runs in middleware mode mounted on the agent server (`attachTo`) — the
 * preview, chat/voice WS, and HMR all share that server's single port. The
 * HMR websocket rides the same server too; the agent host's upgrade
 * dispatcher leaves `vite-hmr`-subprotocol upgrades to Vite's own listener.
 */
export function createPreviewConfig(options: {
  projectRoot: string;
  attachTo: HttpServer;
}): InlineConfig {
  const { projectRoot, attachTo } = options;
  return {
    configFile: false,
    root: packageRoot,
    cacheDir: join(projectRoot, ".curb", "vite"),
    publicDir: resolveContextDir(projectRoot),
    resolve: {
      alias: {
        "@": join(packageRoot, "src"),
      },
      // The project and the package both depend on react; make sure a single
      // copy wins even if the install ever stops hoisting.
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      // The framework is served as source. When the package is truly
      // installed (not workspace-linked), its files live under node_modules,
      // and Vite late-registers no dependency an import from them reaches, so
      // a CJS package the scan does not find is served raw and breaks named
      // imports. Force-prebundle the CJS/dual entries the scan misses. The
      // agent runtime's own (react-reconciler, zustand, zod, the MCP SDK) are
      // not among them: the page never loads the agent.
      include: [
        "react",
        "react-dom/client",
        "use-sync-external-store/shim",
        "use-sync-external-store/shim/with-selector",
        "use-sync-external-store/shim/with-selector.js",
      ],
      // The scan follows the preview's own `@/` imports into the framework source, so
      // what its components import is found and pre-bundled when the server starts.
      esbuildOptions: { plugins: [scanAliasPlugin(join(packageRoot, "src"))] },
    },
    plugins: [
      // Exclude the prebundled deps cache from the Babel pass: it lives in
      // .curb/vite (not node_modules), so plugin-react's default vendor
      // exclude misses it and noisily transforms 500KB+ bundles on boot.
      react({ exclude: [/node_modules/, /[\\/]\.curb[\\/]vite[\\/]/] }),
      tailwindcss(),
      contextIndexPlugin(projectRoot),
    ],
    server: {
      middlewareMode: true,
      // Transform the preview's module graph when the server starts, not when the
      // first page asks for it: in a hosted workspace every request crosses the
      // network, and a cold page otherwise waits on hundreds of transforms.
      warmup: { clientFiles: ["./src/preview/main.tsx"] },
      // Scope HMR to its own path so the agent server's single-port upgrade
      // dispatcher can hand HMR to Vite and keep chat/voice for itself.
      hmr: { server: attachTo, path: VITE_HMR_PATH },
      fs: {
        // Explicit allow-list replaces Vite's default; include the workspace
        // root so hoisted node_modules stay servable next to both roots.
        //
        // TWO WORKSPACE ROOTS, because the project and the framework are not always
        // in the same one. A project inside the framework workspace shares it, so one lookup
        // covered both and the second looked redundant. A project that links curb
        // from elsewhere -- `file:` at a checkout, which is how a standalone demo
        // tracks unreleased framework work -- has its own root, and the framework's
        // hoisted dependencies then sit outside every allowed path. The symptom is
        // narrow and confusing: the preview loads, and only assets the framework
        // pulls from its own node_modules are refused, so the UI renders in a
        // fallback font with a wall of "outside of Vite serving allow list".
        //
        // The same happens when the project's node_modules is a link to an install
        // elsewhere (a hosted workspace starts on its image's read-only copy): the
        // framework resolves to that install's real path, outside both roots, so the
        // install itself is allowed too.
        allow: [
          ...new Set([
            searchForWorkspaceRoot(projectRoot),
            searchForWorkspaceRoot(packageRoot),
            packageRoot,
            projectRoot,
            ...installedDependencies(projectRoot),
          ]),
        ],
      },
    },
  };
}

/** The project's node_modules at its real path, when it has one. */
function installedDependencies(projectRoot: string): string[] {
  const nodeModules = join(projectRoot, "node_modules");
  return existsSync(nodeModules) ? [realpathSync(nodeModules)] : [];
}

/**
 * Lets Vite's dependency scan follow the preview's `@/` imports. Installed (not
 * workspace-linked), the framework source sits under node_modules, and the scan takes a
 * specifier that looks like a package and resolves under node_modules for a dependency:
 * it recorded `@/components/ui/button.js` as one and read no further, so what the
 * components import (@base-ui/react, clsx, tailwind-merge) was never pre-bundled and the
 * page fetched it as hundreds of single files. Resolved here, the scan reads those files.
 */
export function scanAliasPlugin(srcDir: string): EsbuildPlugin {
  // The scan resolves a relative path against its importer, so the importer is a file at
  // the root of `src`; a `.js` import then maps to its `.ts`/`.tsx` source as anywhere else.
  const importer = join(srcDir, "index.ts");
  return {
    name: "curb-scan-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) =>
        build.resolve(`./${args.path.slice(2)}`, { resolveDir: srcDir, kind: args.kind, importer }),
      );
    },
  };
}
