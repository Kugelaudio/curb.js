import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experimentDeclarations } from "../experiments.js";
import { goalDeclarations } from "../goals.js";
import { hookDeclarations } from "../hooks.js";

/**
 * The child process `curb build` reads the agent's goals, experiments and hooks in (`declarations.ts`).
 *
 * It runs as `curb build-declarations <projectRoot>`, through the CLI's own shim, so the agent is
 * imported the way `curb check` imports it (tsx, the project's spanning tsconfig). A child rather
 * than the build's own process for two reasons:
 *
 *   - An agent module may open a handle at import (a `setInterval`, a database client at module
 *     scope). In the build's process that kept `curb build` from ever exiting. The child prints
 *     its one line and calls `process.exit`, whatever the agent left running.
 *   - A dependency-layer build resolves against a node_modules pruned to esbuild's recorded
 *     inputs, which never hold the externals the bundle leaves to runtime (`sharp`,
 *     `onnxruntime-node`, `@livekit/rtc-ffi-bindings` behind `curb/orchestration`). Here a bare
 *     specifier Node cannot find loads as a stub ({@link registerMissingModuleStubs}), so the
 *     declarations, which are plain values, are read without them. An error in the agent's own
 *     code is still an error.
 *
 * Not a command a person runs; `curb build` starts it.
 */

/** The argv command that runs this child. */
export const DECLARATIONS_COMMAND = "build-declarations";

/** Prefix of the one line the child prints on stdout. The JSON payload is the rest. */
export const DECLARATIONS_MARKER = "curb-declarations";

/**
 * What the child reports: the manifest's three fields, or why the agent could not be loaded.
 * `standIns` names every package that loaded as a stub before the failure: with any, the failure
 * may be the stub's (a name it does not export, a value it is not), not the project's.
 */
export type DeclarationsReport =
  | {
      ok: true;
      goals: ReturnType<typeof goalDeclarations>;
      experiments: ReturnType<typeof experimentDeclarations>;
      hooks: ReturnType<typeof hookDeclarations>;
    }
  | { ok: false; message: string; code?: string; standIns?: string[] };

/** Every bare specifier this process loaded as a stub, in the order it was first needed. */
const standIns = new Set<string>();

/** The URL scheme of a stub module. Never a real file. */
const STUB_SCHEME = "curb-stub:";

/**
 * One value that stands in for every export of a missing package: any property is itself, a
 * call or `new` returns itself, it converts to "" and it is not a thenable (an `await` of it
 * must not wait forever).
 */
const STUB_VALUE = [
  "const stub = new Proxy(function stub() {}, {",
  '  get: (_target, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : stub,',
  "  apply: () => stub,",
  "  construct: () => stub,",
  "});",
].join("\n");

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Whether `specifier` names a package (`sharp`, `@livekit/rtc-ffi-bindings`), not a file, a URL,
 * a builtin or a package's own `#imports` entry. */
export function isBareSpecifier(specifier: string): boolean {
  return !/^[./#]/.test(specifier) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier);
}

/**
 * The names `source` imports from `specifier` by name: `import { a, b as c } from "x"` and
 * `export { a } from "x"` give `a` and `b`. An ES module stub has to export each one, or the
 * importer fails to link. Reading too many is harmless; a name this misses (a string-named
 * import, a comment inside the braces) is a link error, which a dependency-layer build turns
 * into an escape to a full build, never a wrong manifest.
 */
export function namedImportsOf(source: string, specifier: string): string[] {
  const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statement = new RegExp(`(?:import|export)\\s*(?:type\\s+)?([\\w$*\\s{},]*?)\\s*from\\s*(["'])${quoted}\\2`, "g");
  const names = new Set<string>();
  for (const match of source.matchAll(statement)) {
    const braces = /\{([^}]*)\}/.exec(match[1] ?? "");
    for (const entry of braces?.[1]?.split(",") ?? []) {
      const trimmed = entry.trim();
      // `import { type Options } from "x"` is erased: nothing to export for it.
      if (/^type\s/.test(trimmed)) continue;
      const name = trimmed.split(/\s+as\s+/)[0]?.trim() ?? "";
      if (IDENTIFIER.test(name) && name !== "default") names.add(name);
    }
  }
  return [...names].sort();
}

/** The stub's URL: the missing specifier, the names its ES importer needs, and its format. */
function stubUrl(specifier: string, names: readonly string[], format: "module" | "commonjs"): string {
  const query = new URLSearchParams({ format, names: names.join(",") });
  return `${STUB_SCHEME}${encodeURIComponent(specifier)}?${query}`;
}

function stubSource(url: string): { format: "module" | "commonjs"; source: string } {
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  if (query.get("format") === "commonjs") return { format: "commonjs", source: `${STUB_VALUE}\nmodule.exports = stub;\n` };
  const names = (query.get("names") ?? "").split(",").filter(Boolean);
  const exported = ["stub as default", ...names.map((name) => `stub as ${name}`)].join(", ");
  return { format: "module", source: `${STUB_VALUE}\nexport { ${exported} };\n` };
}

function sourceOf(parentUrl: string | undefined): string {
  if (!parentUrl?.startsWith("file:")) return "";
  try {
    return readFileSync(fileURLToPath(parentUrl), "utf8");
  } catch {
    // KEEP-JUSTIFIED: an importer that cannot be read only means no named exports are known;
    // a name it needs then fails to link, loudly, naming the export.
    return "";
  }
}

/**
 * Load a package Node cannot find as a stub module, for `import` and `require` alike. Synchronous
 * hooks (`module.registerHooks`) because only they see a `require()` inside a dependency, which is
 * how `@livekit/rtc-node` loads its native binding. Registered after tsx's, so they run first and
 * see what tsx could not resolve. On a Node without `registerHooks` (before 22.15) nothing is
 * stubbed: a dependency-layer build then escapes to a full build, as before stubs existed.
 */
export function registerMissingModuleStubs(): boolean {
  // Read off the namespace: the API is newer than the oldest Node curb supports (22.12).
  const registerHooks = (nodeModule as unknown as { registerHooks?: (hooks: object) => unknown }).registerHooks;
  if (typeof registerHooks !== "function") return false;
  registerHooks({
    resolve(
      specifier: string,
      context: { parentURL?: string; conditions?: readonly string[] },
      nextResolve: (specifier: string, context: object) => unknown,
    ) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if ((code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") || !isBareSpecifier(specifier)) throw error;
        standIns.add(specifier);
        const required = context.conditions?.includes("require") ?? false;
        const names = required ? [] : namedImportsOf(sourceOf(context.parentURL), specifier);
        return { url: stubUrl(specifier, names, required ? "commonjs" : "module"), shortCircuit: true };
      }
    },
    load(url: string, context: object, nextLoad: (url: string, context: object) => unknown) {
      if (!url.startsWith(STUB_SCHEME)) return nextLoad(url, context);
      return { ...stubSource(url), shortCircuit: true };
    },
  });
  return true;
}

/** Print the one report line, then exit once it is flushed, whatever the agent left running. */
function report(payload: DeclarationsReport): void {
  process.stdout.write(`${DECLARATIONS_MARKER} ${JSON.stringify(payload)}\n`, () => process.exit(payload.ok ? 0 : 1));
}

/** The child's body: `curb build-declarations <projectRoot>`. */
export async function runDeclarationsChild(projectRoot: string | undefined): Promise<void> {
  try {
    if (!projectRoot) throw new Error(`curb ${DECLARATIONS_COMMAND} needs the project root.`);
    registerMissingModuleStubs();
    const { loadAgentDefinition } = await import("../agent.node.js");
    const definition = await loadAgentDefinition(join(resolve(projectRoot), "src", "agent"));
    report({
      ok: true,
      goals: goalDeclarations(definition.goals),
      experiments: experimentDeclarations(definition.experiments),
      hooks: hookDeclarations(definition),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    report({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === "string" ? { code } : {}),
      ...(standIns.size > 0 ? { standIns: [...standIns] } : {}),
    });
  }
  // The exit happens in report's write callback; nothing after it runs.
  await new Promise(() => {});
}
