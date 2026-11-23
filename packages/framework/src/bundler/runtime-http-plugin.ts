import type { Plugin } from "esbuild";

const RUNTIME_HTTP = "curb-runtime-http";

/**
 * Loads `node:http` when the bundled module that needs it runs, not when Node links the bundle.
 *
 * Node 22 installs its default HTTP dispatcher while it links a static import of `node:http`,
 * before the first module of the bundle runs, the dispatcher snapshot included
 * (`dispatcherSnapshotImport`). The snapshot would then find a dispatcher already set, record
 * nothing, and the model client would open a new connection every turn. Through `require`,
 * Node loads the module without installing one.
 */
export function runtimeHttpPlugin(): Plugin {
  return {
    name: "curb:runtime-http",
    setup(build) {
      build.onResolve({ filter: /^(node:)?http$/ }, (args) =>
        args.namespace === RUNTIME_HTTP || args.kind === "require-call"
          ? { path: "node:http", external: true }
          : { path: "node:http", namespace: RUNTIME_HTTP },
      );
      build.onLoad({ filter: /.*/, namespace: RUNTIME_HTTP }, () => ({
        contents: `module.exports = require("node:http");`,
        loader: "js",
      }));
    },
  };
}
