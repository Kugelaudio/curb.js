import { isAbsolute, relative, sep } from "node:path";
import { edgeKey, type BuildInputs, type MetafileAnalysis } from "./layers.js";

/**
 * Escape detection for `curb build --dependency-layer` (layer contract L1).
 *
 * A hit-mode build compiles against a node_modules holding only the build inputs recorded
 * by an earlier `--emit-layers` build. It is correct exactly when this build's bundle
 * reaches nothing that record lacks; then esbuild read the same bytes and resolved the same
 * edges. Every rule below is one way to reach past it. Any of them is an ESCAPE, never an
 * error to build past: the CLI exits 75 having written nothing, and the builder falls back
 * to a full install and `--emit-layers` in the same attempt.
 */

/** EX_TEMPFAIL: the build is not wrong, it just cannot be done from this layer. */
export const LAYER_ESCAPE_EXIT_CODE = 75;

export type LayerEscapeReason =
  | "unresolved_import"
  | "node_modules_in_source"
  | "unrecorded_input"
  | "unrecorded_external"
  | "unrecorded_edge";

export class LayerEscapeError extends Error {
  readonly code = "layer_escape" as const;
  readonly reason: LayerEscapeReason;
  /** The specifier or project-root-relative path that escaped. */
  readonly path: string;

  constructor(reason: LayerEscapeReason, path: string, detail: string) {
    super(`the build reached outside its recorded dependency layer (${reason}: ${path}). ${detail}`);
    this.name = "LayerEscapeError";
    this.reason = reason;
    this.path = path;
  }
}

/** Duck-typed, so it holds across module instances (the CLI and a re-imported bundler). */
export function isLayerEscapeError(error: unknown): error is LayerEscapeError {
  return error instanceof Error && (error as { code?: unknown }).code === "layer_escape";
}

/** The single stderr line the builder parses: `{"code":"layer_escape","reason":…,"path":…}`. */
export function layerEscapeLine(error: LayerEscapeError): string {
  return JSON.stringify({ code: error.code, reason: error.reason, path: error.path });
}

/**
 * An esbuild failure that is an escape: a specifier it could not resolve. A full install
 * may well resolve it, so this is the builder's cue to fall back, not the project's bug.
 * Any other build failure is returned as undefined and must be reported as itself.
 */
export function unresolvedImportEscape(error: unknown): LayerEscapeError | undefined {
  const messages = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const text = (message as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    const unresolved = /^Could not resolve "(.*)"$/.exec(text);
    if (!unresolved) continue;
    const file = (message as { location?: { file?: unknown } }).location?.file;
    return new LayerEscapeError(
      "unresolved_import",
      unresolved[1],
      `esbuild could not resolve it${typeof file === "string" ? ` from ${file}` : ""} in the build inputs.`,
    );
  }
  return undefined;
}

/**
 * A failure to load the agent that is an escape: Node could not find a module the agent's imports
 * reach. esbuild resolved them from the build inputs a moment before, but Node may pick another
 * file of a package (other export conditions), and a full install has it. Any other failure is
 * the project's own and returned as undefined.
 */
export function missingModuleEscape(error: unknown, projectRoot: string): LayerEscapeError | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const named = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1] ?? "(unnamed module)";
  const path = isAbsolute(named) ? relative(projectRoot, named).split(sep).join("/") : named;
  return new LayerEscapeError(
    "unresolved_import",
    path,
    "Node could not resolve it in the build inputs while loading the agent to read its goals and experiments.",
  );
}

/**
 * The first way this bundle reached past the recorded build inputs, or undefined when it
 * stayed inside them. The order puts the most specific cause first: a node_modules inside
 * source also shows up as an unrecorded read, and a new external as a new edge.
 */
export function findLayerEscape(
  analysis: MetafileAnalysis,
  recorded: BuildInputs,
): LayerEscapeError | undefined {
  const inSource = analysis.sourceNodeModules[0];
  if (inSource !== undefined) {
    return new LayerEscapeError(
      "node_modules_in_source",
      inSource,
      "A node_modules directory inside project source changes how the project's imports resolve.",
    );
  }

  const inputs = new Set(recorded.inputs);
  const read = analysis.nodeModulesReads.find((path) => !inputs.has(path));
  if (read !== undefined) {
    return new LayerEscapeError("unrecorded_input", read, "esbuild read a node_modules file the layer did not record.");
  }

  const externals = new Set(recorded.recordedExternals);
  const external = analysis.externals.find((specifier) => !externals.has(specifier));
  if (external !== undefined) {
    return new LayerEscapeError(
      "unrecorded_external",
      external,
      "The bundle leaves an external to runtime resolution that the layer was not built with.",
    );
  }

  const edges = new Set(recorded.edges.map(edgeKey));
  const edge = analysis.edges.find((candidate) => !edges.has(edgeKey(candidate)));
  if (edge !== undefined) {
    return new LayerEscapeError(
      "unrecorded_edge",
      edge.specifier,
      `${edge.importer} imports it (${edge.kind}) resolving to ${edge.resolved}, an edge the layer did not record.`,
    );
  }
  return undefined;
}
