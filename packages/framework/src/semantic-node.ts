import type { SemanticNode } from "./types.js";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";

/**
 * Prop/text accessors over semantic nodes. Dependency-free on purpose: block
 * definitions (definition.ts in each src/blocks folder) read their nodes
 * through these, and the compiler imports the block registry — helpers living
 * in the compiler would close that loop into an import cycle.
 *
 * Missing/mistyped props throw: a semantic element is produced by the block's
 * own component, so a bad prop is an authoring bug, never a runtime state.
 */

export function textContent(node: SemanticNode): string {
  const directText =
    node.type === "agent-text-node" && typeof node.props.value === "string"
      ? dedentProse(node.props.value)
      : "";
  return joinProse([directText, ...node.children.map(textContent)]);
}

/**
 * Multi-line prose, written as one template-literal child. JSX text never
 * gets here with its line breaks: the JSX transform folds it onto one line before
 * Curb sees it, so a string that still has them came from an expression.
 *
 * Removes the indentation every line shares, empties whitespace-only lines and
 * drops blank lines at both ends, so paragraphs, markdown headings, lists and
 * line breaks reach the model as written. The first line does not count towards
 * the shared indentation, because it starts right after the opening backtick.
 * A string without a line break is only trimmed, exactly as before.
 */
export function dedentProse(text: string): string {
  if (!text.includes("\n")) return text.trim();
  const [first = "", ...rest] = text.split("\n").map((line) => line.trimEnd());
  const indent = sharedIndent(rest);
  const lines = [first.trimStart(), ...rest.map((line) => line.slice(indent.length))];
  while (lines.length > 0 && !lines[0]) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

/** The leading whitespace every non-empty line starts with. */
function sharedIndent(lines: readonly string[]): string {
  let shared: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    const own = /^[ \t]*/.exec(line)![0];
    if (shared === null) {
      shared = own;
      continue;
    }
    let length = 0;
    while (length < shared.length && shared[length] === own[length]) length += 1;
    shared = shared.slice(0, length);
  }
  return shared ?? "";
}

/**
 * Child texts in order. One-line texts are joined with a space, as they always
 * were; a multi-line text is a block of its own, so it is set off from its
 * neighbours by a blank line rather than run into a heading or a list item.
 */
function joinProse(parts: readonly string[]): string {
  let joined = "";
  let previous = "";
  for (const part of parts) {
    if (!part) continue;
    if (joined) joined += previous.includes("\n") || part.includes("\n") ? "\n\n" : " ";
    joined += part;
    previous = part;
  }
  return joined.trim();
}

export function numberProp(node: SemanticNode, key: string): number {
  const value = node.props[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidProp(node, key, "a finite number");
  }
  return value;
}

export function stringProp(node: SemanticNode, key: string): string {
  const value = node.props[key];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidProp(node, key, "a non-empty string");
  }
  return value;
}

export function optionalStringProp(node: SemanticNode, key: string): string | undefined {
  const value = node.props[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalObjectProp(node: SemanticNode, key: string): Record<string, unknown> | undefined {
  const value = node.props[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProp(node, key, "an object");
  }
  return value as Record<string, unknown>;
}

function invalidProp(node: SemanticNode, key: string, expected: string): AgentAuthoringError {
  const value = node.props[key];
  return new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `${node.type} requires prop ${JSON.stringify(key)} to be ${expected}; received ${describeValue(value)}.`,
    location: { component: node.type },
    fix: `Set ${key} on <${node.type}> to ${expected}.`,
  });
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}
