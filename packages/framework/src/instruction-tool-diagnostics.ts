/**
 * INSTRUCTION_UNKNOWN_TOOL: text the model reads tells it to use a tool the agent does not have.
 *
 * An instruction such as "Call lookup_order before you answer" is a promise to the model: when no
 * tool of that name exists, the model either invents a call that fails or tells the caller it
 * cannot help. A tool renamed in code and not in the prose is the usual cause.
 *
 * Scanned is what the model reads from the agent rendered with every skill loaded: the system
 * prompt, every instruction and text, and every `<Text src>` document. A name is reported only
 * when it looks like a tool and is used like one, so ordinary prose stays quiet:
 *
 * - it is written in snake_case (`lookup_order`), the form tool names take; and
 * - it follows a verb that asks for a tool ("call", "use", "run", "invoke", "trigger", "the tool",
 *   and the German "rufe", "nutze", "verwende", "benutze"), or is followed by "tool", "function"
 *   or "()".
 *
 * Not reported: a name of a tool anywhere in the agent, of the framework's own tools, of a field
 * of any tool's input, of a key a skill's `meta.info` declares, and an MCP tool's
 * `<server>__<tool>` name for a server the agent declares (its tools are known once it connects).
 * Like a literal date, a name is reported only where it is written: in the agent's file, the
 * file of the skill that shows it, or the document. A name code computes is in no file and is
 * never reported.
 */

import {
  AUTHORING_DIAGNOSTIC_CODES,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
  type AuthoringLocation,
} from "./authoring.js";
import { normalizePublicSrc } from "./public-context.shared.js";
import { optionalStringProp, textContent } from "./semantic-node.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME, type SemanticNode } from "./types.js";

/** The framework's own tools, which every agent has. */
const FRAMEWORK_TOOLS = ["read_skill", SKIP_TURN_TOOL_NAME, END_CALL_TOOL_NAME];

// A snake_case name; two underscores join an MCP server id to its tool's name.
const NAME = String.raw`[a-z][a-z0-9]*(?:_{1,2}[a-z0-9]+)+`;
const QUOTE = String.raw`[\`"'„“‘]?`;
const ASKS_FOR_TOOL = String.raw`\b(?:call|calls|calling|use|uses|using|run|runs|running|invoke|invokes|invoking|trigger|triggers|triggering|tool|function|rufe|ruf|nutze|nutzt|verwende|verwendet|benutze|benutzt|werkzeug)`;
const ARTICLE = String.raw`(?:the|a|das|dem|den|die|der)`;
/** The text right before a name, when it asks for a tool: "call ", "use the tool ", "rufe das Tool `". */
const CUE_BEFORE = new RegExp(
  String.raw`${ASKS_FOR_TOOL}\s+(?:${ARTICLE}\s+)?(?:(?:tool|function|werkzeug)\s+)?${QUOTE}$`,
  "i",
);
/** The text right after a name, when it names a tool: " tool", "-Tool", "()". */
const CUE_AFTER = new RegExp(String.raw`^${QUOTE}(?:\s+(?:tool|function|werkzeug)\b|-(?:tool|werkzeug)\b|\(\))`, "i");
/** The text right after a name that makes it part of something else: a file (`faq_list.md`), a
 * dotted key (`order_info.id`), a path. */
const PART_OF_MORE = /^[./][A-Za-z0-9]/;

export type InstructionToolOptions = {
  agentId: string;
  /** The agent rendered with every skill loaded. */
  tree: SemanticNode;
  /** The project-relative file `<Agent>` is written in, and its text. */
  agentFile: string;
  agentText?: string;
  /** Every skill: its route path, its module's project-relative file and text, and the info keys
   * its `meta.info` declares. */
  skills: readonly { path: string; file?: string; text?: string; infoKeys?: readonly string[] }[];
  /** Every tool name of the agent, in any skill. */
  tools: readonly string[];
  /** More names that are tools, though the render did not show them (a tool rendered only after
   * something happened in the call). Never reported, never suggested. */
  alsoKnown?: readonly string[];
  /** The MCP servers the agent declares or renders, by id. */
  mcpServers: readonly string[];
};

/** One warning per place the model reads and distinct unknown tool name written there. */
export function diagnoseInstructionTools(options: InstructionToolOptions): AuthoringDiagnostic[] {
  const { agentId, tree, agentFile, agentText } = options;
  const skills = new Map(options.skills.map((skill) => [skill.path, skill]));
  const known = new Set<string>([
    ...FRAMEWORK_TOOLS,
    ...options.tools,
    ...(options.alsoKnown ?? []),
    ...fieldNames(tree),
    ...options.skills.flatMap((skill) => skill.infoKeys ?? []),
  ]);
  const declaredTools = [...new Set(options.tools)].sort();
  const isMcpName = (name: string) => {
    const at = name.indexOf("__");
    return at > 0 && options.mcpServers.includes(name.slice(0, at));
  };
  const diagnostics: AuthoringDiagnostic[] = [];

  const scan = (where: string, location: AuthoringLocation, text: string, written: readonly (string | undefined)[]) => {
    for (const name of toolLikeNames(text)) {
      if (known.has(name) || isMcpName(name)) continue;
      const file = written.find((source) => source?.includes(name));
      if (file === undefined) continue;
      const line = location.source && file ? lineOf(file, name) : undefined;
      const closest = closestName(name, declaredTools);
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.instructionUnknownTool,
        severity: "warning",
        message: `${where} tells the model to use "${name}", but no tool of the agent is named that.`,
        location: { agentId, ...location, ...(line === undefined ? {} : { line }) },
        fix:
          (closest
            ? `Write "${closest}" if that is the tool it means, `
            : declaredTools.length > 0
              ? `Name one of the agent's tools (${declaredTools.map((tool) => `"${tool}"`).join(", ")}), `
              : "Add the tool it means, ") +
          "or reword the text. Writing the name as {tool.name} of the tool's defineTool value keeps it right when the tool is renamed." +
          (options.mcpServers.length > 0 ? ' An MCP tool is named "<server>__<tool>".' : ""),
      });
    }
  };

  const placeIn = (path: string | null) => {
    const skill = path === null ? undefined : skills.get(path);
    return {
      owner: path === null ? "The agent" : `Skill ${path}`,
      at: (component: string): AuthoringLocation =>
        path === null ? { source: agentFile, component } : { skillPath: path, source: skill?.file, component },
      written: path === null ? [agentText] : [skill?.text, agentText],
    };
  };

  const visit = (node: SemanticNode, current: string | null): void => {
    const path = node.type === "agent-page" && typeof node.props.path === "string" ? node.props.path : current;
    const { owner, at, written } = placeIn(path);
    switch (node.type) {
      case "agent-system-prompt":
        scan(path === null ? "The system prompt" : `${owner}'s text`, at("SystemPrompt"), textContent(node), written);
        return;
      case "agent-instruction":
        scan(`${owner}'s instruction`, at("Instruction"), textContent(node), written);
        return;
      case "agent-text":
      case "agent-text-node":
        scan(`${owner}'s text`, at("Text"), textContent(node), written);
        return;
      case "agent-context-doc": {
        const src = optionalStringProp(node, "src");
        if (!src) return;
        const file = `context/${normalizePublicSrc(src)}`;
        const content = optionalStringProp(node, "content") ?? "";
        scan(`${owner}'s document ${file}`, { ...at(`Text src=${JSON.stringify(src)}`), source: file }, content, [content]);
        return;
      }
      case "agent-tool":
      case "agent-form":
      case "agent-error":
        return;
    }
    for (const child of node.children) visit(child, path);
  };
  visit(tree, null);
  return mergeAuthoringDiagnostics(diagnostics);
}

/** The snake_case names in `text` that are asked for or named as a tool, each once. */
export function toolLikeNames(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9_./-])${NAME}(?![A-Za-z0-9_])`, "g"))) {
    const name = match[0];
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const after = text.slice(match.index + name.length, match.index + name.length + 12);
    if (PART_OF_MORE.test(after)) continue;
    if (CUE_BEFORE.test(before) || CUE_AFTER.test(after)) found.add(name);
  }
  return [...found];
}

/** Every field name of every tool's input, nested properties included: prose names fields in
 * snake_case as often as tools. */
function fieldNames(tree: SemanticNode): string[] {
  const names = new Set<string>();
  const schemaKeys = (schema: unknown): void => {
    if (Array.isArray(schema)) {
      for (const item of schema) schemaKeys(item);
      return;
    }
    if (!schema || typeof schema !== "object") return;
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const [name, property] of Object.entries(value)) {
          names.add(name);
          schemaKeys(property);
        }
      } else schemaKeys(value);
    }
  };
  const visit = (node: SemanticNode) => {
    if (node.type === "agent-field") {
      const name = optionalStringProp(node, "name");
      if (name) names.add(name);
      schemaKeys(node.props.jsonSchema);
    }
    if (node.type === "agent-tool" || node.type === "agent-form") schemaKeys(node.props.inputSchema);
    for (const child of node.children) visit(child);
  };
  visit(tree);
  return [...names];
}

/** The 1-based line of the first occurrence of `name` in `text` as a whole word. */
function lineOf(text: string, name: string): number | undefined {
  const pattern = new RegExp(String.raw`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
  const index = text.split("\n").findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : index + 1;
}

/** The tool whose name is closest to `name`, when one is close enough to be a misspelling. */
export function closestName(name: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance <= Math.max(2, Math.floor(name.length / 4)) && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}
