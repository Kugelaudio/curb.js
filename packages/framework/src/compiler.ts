import { getBlockCompiler } from "./blocks/registry.js";
import { REGION_TAG } from "./blocks/types.js";
import type { BlockCompileApi, BlockRegion } from "./blocks/types.js";
import {
  AUTHORING_DIAGNOSTIC_CODES,
  AgentAuthoringError,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
} from "./authoring.js";
import { dedentProse, numberProp, optionalObjectProp, optionalStringProp, stringProp, textContent } from "./semantic-node.js";
import type {
  CompiledContext,
  FieldDefinition,
  ContextLink,
  InlineSegment,
  JsonSchema,
  JsonSchemaNode,
  JsonSchemaProperty,
  SemanticNode,
  ToolDefinition,
  ToolInputSchema,
  ToolRegistryEntry,
} from "./types.js";

export type CompileResult = {
  context: CompiledContext;
  registry: Map<string, ToolRegistryEntry>;
};

/** Soft per-skill tool budget. Skills above this still compile, but receive a
 * structured authoring diagnostic because large tool sets degrade selection. */
export const SKILL_TOOL_BUDGET = 10;
/** Soft size budget for one compiled context snapshot. Roughly 6k tokens for
 * English prose; large enough for useful context, small enough to flag a
 * skill that is likely hiding a document dump or an overly broad tool set. */
export const CONTEXT_CHARACTER_BUDGET = 24_000;

/**
 * Compile the site for a set of loaded skills. `paths` is oldest-first and the
 * LAST entry is the active skill: every loaded skill contributes instructions,
 * content, and tools, while renderable page blocks come from the active skill
 * only (the UI shows one page at a time). The active skill's contributions
 * lead the compiled context; on tool-name collisions the most recently loaded
 * skill wins and a structured error diagnostic identifies the ambiguity.
 * No paths is the agent level, where every conversation starts: `agent.tsx`
 * alone (system prompt, skills index, global tools), with path and title "".
 */
export function compileSite(root: SemanticNode | null, paths: string | string[]): CompileResult {
  if (!root) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
      severity: "error",
      message: "The agent rendered an empty semantic tree, so there is no context to compile.",
      location: { component: "Agent" },
      fix: "Return an <Agent> tree from the app component of src/agent/agent.tsx.",
    });
  }

  const loadedPaths = typeof paths === "string" ? [paths] : paths;
  const pages = loadedPaths.map((path) => {
    const page = findPage(root, path);
    if (!page) {
      throw new AgentAuthoringError({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
        severity: "error",
        message: `Loaded skill ${JSON.stringify(path)} has no rendered agent-page.`,
        location: { skillPath: path, component: "Agent" },
        fix: "Create the matching skill module or remove this path from <Skill> links and programmatic navigation calls.",
      });
    }
    return { path, page };
  });

  const active = pages.at(-1);
  const registry = new Map<string, ToolRegistryEntry>();
  const context: CompiledContext = {
    path: active?.path ?? "",
    title: active ? (optionalStringProp(active.page, "title") ?? active.path) : "",
    loadedSkills: pages.map(({ path, page }) => ({
      path,
      title: optionalStringProp(page, "title") ?? path,
      characterCount: 0,
    })),
    instructions: [],
    content: [],
    errors: [],
    toolErrors: {},
    links: [],
    blocks: [],
    tools: [],
    diagnostics: [],
  };

  collectGlobalAffordances(root, context, registry);
  // Walk the ACTIVE skill first, then the other loaded skills newest-first:
  // its instructions and tools lead the compiled context, which is what the
  // model should prioritize. On tool-name collisions the earlier-walked (more
  // recently used) skill wins the registry entry.
  for (const { path, page } of [...pages].reverse()) {
    const before = context.tools.length;
    const charactersBefore = contextContributionCharacters(context);
    walkPage(page, context, registry, { render: page === active?.page, skillPath: path });
    const loadedSkill = context.loadedSkills.find((skill) => skill.path === path);
    if (loadedSkill) {
      loadedSkill.characterCount = Math.max(
        1,
        contextContributionCharacters(context) - charactersBefore,
      );
    }
    diagnoseOversizedSkill(path, context.tools.length - before, context);
  }
  diagnoseOversizedContext(context);
  return { context, registry };
}

function contextContributionCharacters(context: CompiledContext): number {
  const lines = [
    ...context.instructions.map((value) => contextEntry("instruction", value)),
    ...context.content.map((value) => contextEntry("content", value)),
    ...context.errors.map((value) => contextEntry("error", value)),
    ...context.links.map((link) => formatAvailableSkill(link)),
    ...context.tools.map((tool) => `tool: ${toolSignature(tool)}`),
  ];
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

function diagnoseOversizedSkill(
  path: string,
  toolCount: number,
  context: CompiledContext,
): void {
  if (toolCount <= SKILL_TOOL_BUDGET) return;
  addDiagnostic(context, {
    code: AUTHORING_DIAGNOSTIC_CODES.oversizedContext,
    severity: "warning",
    message: `Skill ${JSON.stringify(path)} exposes ${toolCount} tools; the recommended maximum is ${SKILL_TOOL_BUDGET}.`,
    location: { skillPath: path, component: "Tool" },
    fix: "Split the skill into narrower routes so the model chooses from a smaller tool set.",
  });
}

function diagnoseOversizedContext(context: CompiledContext): void {
  const characters = flattenContext(context).join("\n").length;
  if (characters <= CONTEXT_CHARACTER_BUDGET) return;
  const subject = context.path ? `Compiled context for ${JSON.stringify(context.path)}` : "The agent level's context";
  addDiagnostic(context, {
    code: AUTHORING_DIAGNOSTIC_CODES.oversizedContext,
    severity: "warning",
    message: `${subject} is ${characters.toLocaleString()} characters; the recommended maximum is ${CONTEXT_CHARACTER_BUDGET.toLocaleString()}.`,
    location: context.path ? { skillPath: context.path } : { component: "Agent" },
    fix: "Move long reference material into a narrower skill or split this skill into focused sub-skills.",
  });
}

function addDiagnostic(context: CompiledContext, diagnostic: AuthoringDiagnostic): void {
  context.diagnostics = mergeAuthoringDiagnostics(context.diagnostics, [diagnostic]);
}

export function flattenContext(context: CompiledContext): string[] {
  const skillLines =
    context.loadedSkills.length > 1
      ? [`loaded_skills: ${context.loadedSkills.map((skill) => skill.title).join(", ")}`]
      : [];

  return [
    // At the agent level no skill is loaded, so none is active.
    ...(context.loadedSkills.length > 0 ? [`active_skill: ${context.title}`] : []),
    ...skillLines,
    ...context.instructions.map((value) => contextEntry("instruction", value)),
    ...context.content.map((value) => contextEntry("content", value)),
    ...context.errors.map((value) => contextEntry("error", value)),
    ...context.links.map((link) => formatAvailableSkill(link)),
    ...context.tools.map((tool) => `tool: ${toolSignature(tool)}`),
  ];
}

/**
 * One `label: value` entry of the snapshot. A multi-line value (prose written as a
 * template literal, a `<Text src>` document) keeps its lines, and every
 * continuation is indented under its entry, so a heading or a list item inside it
 * reads as part of that entry rather than as a new line of the snapshot. A
 * one-line value renders exactly as it always has.
 */
function contextEntry(label: string, value: string): string {
  const [first, ...rest] = value.split("\n");
  return [`${label}: ${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ""))].join("\n");
}

/** Exported for the preview's skills-index dialog, so what the agent builder
 * sees is byte-for-byte what the model reads in its context snapshot. */
export function formatAvailableSkill(link: ContextLink): string {
  if (link.description) {
    return `available_skill: ${link.label} — ${link.description}`;
  }

  return `available_skill: ${link.label}`;
}

function findPage(root: SemanticNode, path: string): SemanticNode | null {
  if (root.type === "agent-page" && root.props.path === path) return root;

  for (const child of root.children) {
    const match = findPage(child, path);
    if (match) return match;
  }

  return null;
}

function collectGlobalAffordances(
  node: SemanticNode,
  context: CompiledContext,
  registry: Map<string, ToolRegistryEntry>,
) {
  if (node.type === "agent-page") return;

  switch (node.type) {
    case "agent-system-prompt":
      // Authored once at the tree root; the last one wins if repeated.
      context.systemPrompt =
        textContent(node);
      return;
    case "agent-text-node":
      addText(context, "text", textContent(node));
      return;
    case "agent-instruction":
      addText(context, "instruction", textContent(node));
      return;
    case "agent-text":
      addText(context, "text", textContent(node));
      return;
    case "agent-context-doc":
      // Global context docs join the model context like page docs; blocks are
      // only rendered for the active page, so render stays false here.
      addDoc(context, stringProp(node, "src"), stringProp(node, "content"), { render: false });
      return;
    case "agent-error":
      addError(context, textContent(node), optionalStringProp(node, "source"));
      return;
    case "agent-skill":
      addLink(node, context, "global");
      return;
    case "agent-tool":
      registerAction(node, context, registry, "global");
      return;
    case "agent-form":
      registerForm(node, context, registry, "global");
      return;
  }

  for (const child of node.children) {
    collectGlobalAffordances(child, context, registry);
  }
}

function walkPage(
  node: SemanticNode,
  context: CompiledContext,
  registry: Map<string, ToolRegistryEntry>,
  options: { render: boolean; skillPath: string },
) {
  switch (node.type) {
    case "agent-text-node":
      addText(context, "text", textContent(node), { render: options.render });
      return;
    case "agent-instruction":
      addText(context, "instruction", textContent(node), { render: options.render });
      return;
    case "agent-text": {
      // A `<Skill>` written inline in the prose becomes a clickable link in the
      // flow. Only take the segment path when one is actually present, so plain
      // text compiles exactly as before.
      if (node.children.some((child) => child.type === "agent-skill")) {
        addInlineText(context, node, { render: options.render });
      } else {
        addText(context, "text", textContent(node), { render: options.render });
      }
      return;
    }
    case "agent-context-doc":
      addDoc(context, stringProp(node, "src"), stringProp(node, "content"), options);
      return;
    case "agent-error":
      addError(context, textContent(node), optionalStringProp(node, "source"), {
        render: options.render,
      });
      return;
    case "agent-skill": {
      const link = addLink(node, context, "page");
      if (options.render) context.blocks.push(toLinkBlock(link));
      return;
    }
    case "agent-tool": {
      const definition = registerAction(node, context, registry, "page", options.skillPath);
      if (options.render) context.blocks.push({ type: "tool", name: definition.name });
      return;
    }
    case "agent-form": {
      const definition = registerForm(node, context, registry, "page", options.skillPath);
      if (options.render) context.blocks.push({ type: "tool", name: definition.name });
      return;
    }
  }

  // Pattern blocks (src/blocks/): compiled via the registry — the compiler
  // knows no individual block. The block consumes its own children.
  if (node.type.startsWith("agent-block-")) {
    compileBlockNode(node, context, registry, options);
    return;
  }

  for (const child of node.children) {
    walkPage(child, context, registry, options);
  }
}

/**
 * Compile one pattern-block node via the block registry. The block's
 * compiler emits model-facing lines/tools through the api and returns the
 * preview payload; the preview renders it via the matching preview registry
 * entry. Unknown tags are an authoring error and fail loudly.
 */
function compileBlockNode(
  node: SemanticNode,
  context: CompiledContext,
  registry: Map<string, ToolRegistryEntry>,
  options: { render: boolean; skillPath: string },
) {
  const compileBlock = getBlockCompiler(node.type);
  if (!compileBlock) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: `Pattern block ${JSON.stringify(node.type)} has no registered compiler.`,
      location: { component: node.type },
      fix: "Add the block definition to src/blocks/registry.ts before using the component.",
    });
  }

  const api: BlockCompileApi = {
    addContent: (text) => addText(context, "text", text),
    compileChildren: (nodes, childOptions) => {
      const render = options.render && (childOptions?.render ?? true);
      for (const child of nodes) {
        walkPage(child, context, registry, { render, skillPath: options.skillPath });
      }
    },
    regions: (blockNode) => {
      const regions: BlockRegion[] = [];
      const rest: SemanticNode[] = [];
      for (const child of blockNode.children) {
        if (child.type !== REGION_TAG) {
          rest.push(child);
          continue;
        }
        regions.push({ name: stringProp(child, "name"), node: child, children: child.children });
      }
      return { regions, rest };
    },
  };

  // Reserve the block's slot BEFORE compiling: compileChildren may render
  // child blocks (a gate's unlocked content), and the block itself — the
  // banner, the card — must appear at its authored position ABOVE them.
  const insertAt = context.blocks.length;
  const result = compileBlock(node, api);
  if (options.render) {
    context.blocks.splice(insertAt, 0, {
      type: "block",
      name: node.type.replace(/^agent-block-/, ""),
      payload: result.payload,
      claimedTools: result.claimedTools,
    });
  }
}

function addLink(
  node: SemanticNode,
  context: CompiledContext,
  scope: ContextLink["scope"],
): ContextLink {
  const to = stringProp(node, "to");
  const existing = context.links.find((link) => link.to === to && link.scope === scope);
  if (existing) return existing;

  const link: ContextLink = {
    to,
    label: textContent(node),
    description: optionalStringProp(node, "description"),
    scope,
  };
  context.links.push(link);
  return link;
}

function addError(
  context: CompiledContext,
  text: string,
  source: string | undefined,
  options: { render?: boolean } = {},
) {
  if (!text) return;

  context.errors.push(text);

  if (options.render) {
    context.blocks.push({ type: "error", text, source });
  }
}

function addText(
  context: CompiledContext,
  type: "instruction" | "text" | "error",
  text: string,
  options: { render?: boolean } = {},
) {
  if (!text) return;

  switch (type) {
    case "instruction":
      context.instructions.push(text);
      break;
    case "text":
      context.content.push(text);
      break;
    case "error":
      context.errors.push(text);
      break;
  }

  if (options.render) {
    context.blocks.push({ type, text });
  }
}

/**
 * A `<Text>` whose prose contains inline `<Skill>` links. Walks the children in
 * order into segments (literal runs + link runs), registering each inline skill
 * as a page link exactly like a standalone `<Skill>` (so it routes and joins the
 * `available_skill:` index). The flattened prose is the model-facing content;
 * `segments` only drive the preview's inline rendering.
 */
function addInlineText(
  context: CompiledContext,
  node: SemanticNode,
  options: { render?: boolean },
) {
  const segments: InlineSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    // Merge consecutive literal runs (JSX splits "reach for" and the `{" "}`
    // spacer into separate nodes) so a segment boundary only ever means a link.
    if (last?.kind === "text") last.text += text;
    else segments.push({ kind: "text", text });
  };
  for (const child of node.children) {
    if (child.type === "agent-skill") {
      const link = addLink(child, context, "page");
      segments.push({ kind: "link", to: link.to, label: link.label, description: link.description });
      continue;
    }
    // Literal prose keeps its exact spacing so "reach for <link> when" reads
    // naturally; any other nested element degrades to its flattened text.
    pushText(child.type === "agent-text-node" ? String(child.props.value ?? "") : textContent(child));
  }

  // Prose with line breaks came from a template literal: it keeps its lines,
  // dedented as one run with the links in place. One-line prose collapses its
  // whitespace exactly as before.
  const multiline = segments.some((segment) => segment.kind === "text" && segment.text.includes("\n"));
  const flowed = multiline ? dedentSegments(segments) : segments;
  const joined = flowed
    .map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
  const text = multiline ? joined : joined.replace(/\s+/g, " ").trim();
  if (!text) return;

  context.content.push(text);
  if (options.render) context.blocks.push({ type: "text", text, segments: flowed });
}

/** Stands in for a link while its prose is dedented: not whitespace, never authored. */
const LINK_MARK = "\u{E000}";

/** Dedent prose that has inline links as one text, so a line that starts with a
 * link loses its indentation like any other line. */
function dedentSegments(segments: readonly InlineSegment[]): InlineSegment[] {
  const links = segments.filter((segment) => segment.kind === "link");
  const pieces = dedentProse(
    segments.map((segment) => (segment.kind === "text" ? segment.text : LINK_MARK)).join(""),
  ).split(LINK_MARK);
  const flowed: InlineSegment[] = [];
  pieces.forEach((piece, index) => {
    if (piece) flowed.push({ kind: "text", text: piece });
    const link = links[index];
    if (link) flowed.push(link);
  });
  return flowed;
}

function addDoc(
  context: CompiledContext,
  src: string,
  text: string,
  options: { render: boolean },
) {
  if (!text) return;

  context.content.push(text);
  if (options.render) context.blocks.push({ type: "doc", src, text });
}

function toLinkBlock(link: ContextLink) {
  return {
    type: "link" as const,
    to: link.to,
    label: link.label,
    description: link.description,
  };
}

function registerAction(
  node: SemanticNode,
  context: CompiledContext,
  registry: Map<string, ToolRegistryEntry>,
  scope: ToolDefinition["scope"],
  skillPath?: string,
): ToolDefinition {
  const name = stringProp(node, "name");
  const providedSchema = node.props.inputSchema as ToolInputSchema | undefined;
  const providedId = typeof node.props.id === "string" ? node.props.id : undefined;
  const definition: ToolDefinition = {
    id: providedId ?? node.id,
    name,
    description: stringProp(node, "description"),
    inputSchema: providedSchema ?? emptyObjectSchema(),
    scope,
    ...iconProp(node),
    ...(skillPath ? { skillPath } : {}),
  };

  addTool(context, definition);
  if (registry.has(name)) return definition;
  registry.set(name, {
    definition,
    handler: async (input) => {
      const handler = node.props.onCall;
      if (typeof handler !== "function") {
        throw new Error(`Action "${name}" is missing an onCall handler.`);
      }
      return handler(providedSchema ? input : {});
    },
  });
  return definition;
}

function registerForm(
  node: SemanticNode,
  context: CompiledContext,
  registry: Map<string, ToolRegistryEntry>,
  scope: ToolDefinition["scope"],
  skillPath?: string,
): ToolDefinition {
  const name = stringProp(node, "name");
  const fields = node.children.filter((child) => child.type === "agent-field").map(fieldDefinition);
  const definition: ToolDefinition = {
    id: node.id,
    name,
    description: stringProp(node, "description"),
    inputSchema: fieldsToSchema(fields),
    scope,
    ...iconProp(node),
    ...tryWithProp(node),
    ...(skillPath ? { skillPath } : {}),
  };

  addTool(context, definition);
  if (registry.has(name)) return definition;
  registry.set(name, {
    definition,
    handler: async (input) => {
      const handler = node.props.onSubmit;
      if (typeof handler !== "function") {
        throw new Error(`Tool "${name}" is missing an onSubmit handler.`);
      }
      return handler(input);
    },
  });
  return definition;
}

/** With several skills loaded, two skills can define the same tool name.
 * Skills are walked most-recently-used first, so the FIRST definition seen is
 * the most relevant one and wins; the collision is an authoring smell, so warn
 * once. */
function addTool(context: CompiledContext, definition: ToolDefinition) {
  const existing = context.tools.find((tool) => tool.name === definition.name);
  if (!existing) {
    context.tools.push(definition);
    return;
  }

  if (existing.id !== definition.id) {
    addDiagnostic(context, {
      code: AUTHORING_DIAGNOSTIC_CODES.duplicateTool,
      severity: "error",
      message: `Tool name ${JSON.stringify(definition.name)} is defined more than once in the loaded context; the most recently loaded definition currently wins.`,
      location: {
        ...(context.path ? { skillPath: context.path } : {}),
        component: `Tool name=${JSON.stringify(definition.name)}`,
      },
      fix: "Give every tool a unique, intention-revealing name across all skills that can be loaded together.",
    });
  }
}

function fieldDefinition(node: SemanticNode): FieldDefinition {
  return {
    name: stringProp(node, "name"),
    type: stringProp(node, "type") as FieldDefinition["type"],
    description: optionalStringProp(node, "description"),
    required: node.props.required === true,
    // Only a `<Tool schema>` sets it (`zodSchemaToFields`); `<Field>` has no `jsonSchema` prop.
    jsonSchema: node.props.jsonSchema as JsonSchemaNode | undefined,
  };
}

/** A `<Tool schema>` field is zod's JSON Schema of it; a `<Field>` is its flat type. */
function fieldsToSchema(fields: FieldDefinition[]): ToolInputSchema {
  const required = fields.filter((field) => field.required).map((field) => field.name);

  return {
    type: "object",
    properties: Object.fromEntries(
      fields.map((field) => [field.name, field.jsonSchema ?? fieldToSchemaProperty(field)]),
    ),
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function fieldToSchemaProperty(field: FieldDefinition): JsonSchemaProperty {
  const property = {
    type: jsonSchemaFieldType(field),
    description: field.description,
  };

  return field.type === "email" ? { ...property, format: "email" } : property;
}

function jsonSchemaFieldType(field: FieldDefinition): JsonSchema["properties"][string]["type"] {
  return field.type === "email" ? "string" : field.type;
}

function toolSignature(tool: ToolDefinition): string {
  const required = new Set(tool.inputSchema.required ?? []);
  const fields = Object.keys(tool.inputSchema.properties).map((name) =>
    required.has(name) ? `${name}*` : name,
  );

  return `${tool.name}(${fields.join(", ")}) [${tool.scope}]`;
}

/** The authored `icon` name, when present. Preview-only presentation data:
 * `toolSignature` ignores it, so it never reaches the model's context. */
function iconProp(node: SemanticNode): { icon?: string } {
  const icon = optionalStringProp(node, "icon");
  return icon ? { icon } : {};
}

/** The authored `tryWith` input of the preview's Try form, when present. Preview-only
 * like `icon`: the model gets a tool's description and input schema, nothing else. */
function tryWithProp(node: SemanticNode): { tryWith?: Record<string, unknown> } {
  const tryWith = optionalObjectProp(node, "tryWith");
  return tryWith ? { tryWith } : {};
}

function emptyObjectSchema(): JsonSchema {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}
