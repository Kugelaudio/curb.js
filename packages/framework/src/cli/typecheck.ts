import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as TypeScript from "typescript";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "../authoring.js";
import { isRemovedOptionTypeError } from "../home-skill-migration.js";

type TypeScriptApi = typeof TypeScript;

/** Type errors listed per run; the rest are only counted. */
export const MAX_LISTED_TYPE_ERRORS = 50;

/** TypeScript's "Cannot find name '{0}'. Do you need to install type definitions for node?",
 * with and without the hint to add 'node' to the types field. */
const NODE_TYPES_CODES = new Set([2580, 2591]);

/** What a project without its own tsconfig.json is checked with: the scaffold's settings. */
const DEFAULT_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM"],
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src"],
};

/** Files under src/ the framework no longer loads (`AGENT_ORCHESTRATION_IGNORED` covers them). */
const IGNORED_SOURCE_DIRS = ["src/orchestration/"];

/** The agent folder's own skill file, no longer a skill (`AGENT_HOME_SKILL_REMOVED` covers it). */
const IGNORED_SOURCE_FILE = /^src\/agent\/skill\.(tsx|ts|jsx|js)$/;

export type TypeCheckResult = {
  /** Type errors (at most {@link MAX_LISTED_TYPE_ERRORS}) and the one warning for Node names
   * left untyped; or only the warning that TypeScript is not installed. */
  diagnostics: AuthoringDiagnostic[];
  /** Project files whose types were checked. */
  checkedFiles: number;
  /** Type errors found but not listed. */
  unlisted: number;
};

/**
 * Type-check the project's own files the way its editor does: with the project's
 * tsconfig.json (the scaffold's settings when it has none), reporting only errors in files
 * under src/. curb runs project code through tsx, which strips types without checking them,
 * so a misspelled name in a tool handler, or in a branch that is not rendered yet, otherwise
 * only fails when that line runs, in the middle of a call.
 *
 * The framework itself ships TypeScript source written against its own development typings
 * (node, vitest) and an `@/` alias, so a plain `tsc` in a project reports errors inside
 * node_modules/curb. Those are not the project's and are left out; diagnostics are only
 * computed for the project's files, which also keeps the run short.
 *
 * Agent code runs on Node, so Node's types are always in the program (`process.env` in a tool
 * is correct code): the project's @types/node, else the one curb depends on. Should neither
 * exist, the Node names a file uses become one warning, never an error.
 */
export async function typeCheckProject(
  projectRoot: string,
  agentId: string,
  options: {
    loadTypeScript?: (projectRoot: string) => Promise<TypeScriptApi | null>;
    resolveNodeTypes?: typeof resolveNodeTypes;
  } = {},
): Promise<TypeCheckResult> {
  const ts = await (options.loadTypeScript ?? loadTypeScript)(projectRoot);
  if (!ts) return { diagnostics: [typeScriptMissing(agentId)], checkedFiles: 0, unlisted: 0 };

  const root = realpathSync(projectRoot);
  const configPath = join(root, "tsconfig.json");
  const hasConfig = existsSync(configPath);
  const configSource = hasConfig ? "tsconfig.json" : undefined;
  const found: TypeScript.Diagnostic[] = [];

  let config: unknown = DEFAULT_TSCONFIG;
  if (hasConfig) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) {
      return {
        diagnostics: [toAuthoringDiagnostic(ts, read.error, root, agentId, configSource)],
        checkedFiles: 0,
        unlisted: 0,
      };
    }
    config = read.config;
  }
  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    root,
    { noEmit: true },
    hasConfig ? configPath : undefined,
  );
  found.push(...parsed.errors);

  const nodeTypes = (options.resolveNodeTypes ?? resolveNodeTypes)(ts, root, parsed.options);
  const program = ts.createProgram({
    rootNames: nodeTypes ? [...parsed.fileNames, nodeTypes] : parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const ownSource = `${toPosix(root)}/src/`;
  const ignored = IGNORED_SOURCE_DIRS.map((dir) => `${toPosix(root)}/${dir}`);
  const ownFiles = program
    .getSourceFiles()
    .filter((file) => {
      const name = toPosix(file.fileName);
      return (
        name.startsWith(ownSource) &&
        !name.includes("/node_modules/") &&
        !ignored.some((dir) => name.startsWith(dir)) &&
        !IGNORED_SOURCE_FILE.test(name.slice(toPosix(root).length + 1))
      );
    });
  found.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics());
  for (const file of ownFiles) {
    found.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
  }

  const relevant = found.filter(
    (diagnostic) =>
      (diagnostic.category === ts.DiagnosticCategory.Error ||
        diagnostic.category === ts.DiagnosticCategory.Warning) &&
      // AGENT_HOME_SKILL_REMOVED reports the removed option once, with what to do.
      !isRemovedOptionTypeError(diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  );
  const missingNodeTypes = relevant.filter((diagnostic) => NODE_TYPES_CODES.has(diagnostic.code));
  const reported = relevant.filter((diagnostic) => !NODE_TYPES_CODES.has(diagnostic.code));
  return {
    diagnostics: [
      ...reported
        .slice(0, MAX_LISTED_TYPE_ERRORS)
        .map((diagnostic) => toAuthoringDiagnostic(ts, diagnostic, root, agentId, configSource)),
      ...(missingNodeTypes.length > 0
        ? [nodeTypesMissing(ts, missingNodeTypes, root, agentId, configSource)]
        : []),
    ],
    checkedFiles: ownFiles.length,
    unlisted: Math.max(0, reported.length - MAX_LISTED_TYPE_ERRORS),
  };
}

/**
 * Node's type definitions for the program: the project's @types/node (what its editor would
 * use), else the one curb itself depends on. Resolved the way TypeScript resolves
 * `"types": ["node"]`, so the entry file matches the running TypeScript version. Null when
 * neither is installed.
 */
export function resolveNodeTypes(
  ts: TypeScriptApi,
  root: string,
  compilerOptions: TypeScript.CompilerOptions,
): string | null {
  for (const containingFile of [join(root, "tsconfig.json"), fileURLToPath(import.meta.url)]) {
    const { resolvedTypeReferenceDirective } = ts.resolveTypeReferenceDirective(
      "node",
      containingFile,
      compilerOptions,
      ts.sys,
    );
    if (resolvedTypeReferenceDirective?.resolvedFileName) {
      return resolvedTypeReferenceDirective.resolvedFileName;
    }
  }
  return null;
}

/** The one warning for every Node name the check could not type because Node's types are
 * missing: the code is correct and runs, only those lines go unchecked. */
function nodeTypesMissing(
  ts: TypeScriptApi,
  diagnostics: readonly TypeScript.Diagnostic[],
  root: string,
  agentId: string,
  configSource: string | undefined,
): AuthoringDiagnostic {
  const names = [
    ...new Set(
      diagnostics.flatMap((diagnostic) => {
        const name = /Cannot find name '([^']+)'/.exec(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        return name ? [`\`${name[1]}\``] : [];
      }),
    ),
  ];
  const first = toAuthoringDiagnostic(ts, diagnostics[0], root, agentId, configSource);
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.nodeTypesMissing,
    severity: "warning",
    message:
      `Node's type definitions are not installed, so the type check cannot see ${names.join(", ") || "Node's globals"} ` +
      `(${diagnostics.length} use(s) under src/). The code runs; only those lines go unchecked.`,
    location: first.location,
    fix: 'Run `npm install --save-dev @types/node`. For your editor, also add "types": ["node"] to compilerOptions in tsconfig.json.',
  };
}

/**
 * TypeScript as the project's editor sees it: the project's own install first (a scaffold
 * lists it in devDependencies), else the one the framework resolves. Null when neither exists.
 */
async function loadTypeScript(projectRoot: string): Promise<TypeScriptApi | null> {
  for (const base of [join(projectRoot, "package.json"), import.meta.url]) {
    let resolved: string;
    try {
      resolved = createRequire(base).resolve("typescript");
    } catch {
      // KEEP-JUSTIFIED: not installed from this base; the next one is tried, and none at all
      // is reported as AGENT_TYPECHECK_UNAVAILABLE.
      continue;
    }
    const module = (await import(pathToFileURL(resolved).href)) as { default?: TypeScriptApi };
    return module.default ?? (module as unknown as TypeScriptApi);
  }
  return null;
}

function typeScriptMissing(agentId: string): AuthoringDiagnostic {
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.typeCheckUnavailable,
    severity: "warning",
    message:
      "TypeScript is not installed, so check did not type-check src/. A misspelled name in a tool handler or in a branch that is not rendered yet will only fail when that code runs.",
    location: { agentId, source: "package.json" },
    fix: "Run `npm install --save-dev typescript`, then run check again.",
  };
}

function toAuthoringDiagnostic(
  ts: TypeScriptApi,
  diagnostic: TypeScript.Diagnostic,
  root: string,
  agentId: string,
  configSource: string | undefined,
): AuthoringDiagnostic {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  let at: AuthoringDiagnostic["location"] = { agentId, ...(configSource ? { source: configSource } : {}) };
  if (diagnostic.file) {
    const name = toPosix(diagnostic.file.fileName);
    const prefix = `${toPosix(root)}/`;
    at = { agentId, source: name.startsWith(prefix) ? name.slice(prefix.length) : name };
    if (diagnostic.start !== undefined) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      at = { ...at, line: position.line + 1, column: position.character + 1 };
    }
  }
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.typeError,
    severity: diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
    message: `${text} (TS${diagnostic.code})`,
    location: at,
    fix: typeErrorFix(diagnostic.code),
  };
}

function typeErrorFix(code: number): string {
  if (code === 2304 || code === 2552) {
    return "Declare or import this name, or correct its spelling. Agent code runs without a type check, so this would fail only when the line runs, mid-call: in a tool handler, or in a branch that renders later.";
  }
  if (code === 2307) return "Install the package, or correct the import path.";
  if (code === 2339) return "Use a property this type has, or add it where the type is declared.";
  if (code === 2322 || code === 2345) {
    return "Pass a value of the type the message names, or change the declared type.";
  }
  return "Fix the type error at this line: it is what `tsc --noEmit` reports for this file with the project's tsconfig.json.";
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}
