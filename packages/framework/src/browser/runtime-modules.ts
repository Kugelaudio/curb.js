/**
 * The modules the browser runtime serves to project code (and the packages it installs), by
 * the specifier they import them by, and the runtime file each one is (`/runtime/<file>`).
 * Shared by the runtime build, which emits them, and the worker's project compile, which points
 * those imports at them: one instance of each in the worker, the one the framework's own code
 * uses. The Node built-ins here are the browser stand-ins the framework itself runs on
 * (`browser-build.ts`); an npm package of the same name (`buffer`, `events`) is that stand-in.
 */
const PACKAGES = ["curb", "curb/providers", "react", "react/jsx-runtime", "zod"];
const NODE_BUILTINS = ["events", "buffer", "path", "util", "stream", "string_decoder", "url", "crypto", "timers", "os"];

export const RUNTIME_MODULES: Readonly<Record<string, string>> = Object.fromEntries([
  ...PACKAGES.map((specifier) => [specifier, `${specifier.replace("/", "-")}.js`]),
  ...NODE_BUILTINS.map((name) => [name, `node-${name}.js`]),
]);

/** Where the dev server serves the runtime's files. */
export const RUNTIME_PATH = "/runtime/";
