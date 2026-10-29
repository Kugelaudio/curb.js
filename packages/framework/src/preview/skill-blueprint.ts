import { parse } from "@babel/parser";
import { getBlockBlueprint } from "../blocks/registry.js";
import type {
  BlockBlueprintApi,
  BlockRelation,
  BlueprintAstNode,
  BlueprintKind,
  BlueprintNode,
  BlueprintSection,
  TextSegment,
} from "../blocks/types.js";

/**
 * Static "blueprint" of a skill: every affordance its JSX can render
 * (`<Tool>`, `<Text>`, `<Procedure>`, `<Skill>`, ...) and the condition
 * gating each — including branches that are NOT currently true.
 *
 * Why static AST and not the runtime render: a `{cond ? <Tool/> : <Text/>}`
 * ternary is plain JS that collapses to one branch before any React element
 * exists, so the reconciler/compiler can only ever see the taken branch (see
 * the framework README's "what the model sees" note). To show a builder the
 * branches that AREN'T active yet, we have to read the source, not the render.
 *
 * Branching has ONE representation: a `kind: "block"` node whose `sections`
 * are the states. `{cond ? a : b}` becomes a `block: "if"` node with `then`
 * and `else` sections, `items.map(...)` becomes a `block: "each"` node, and a
 * pattern block (`<Procedure>`) emits the same shape through its own
 * expander. Consumers therefore never special-case conditionals against
 * blocks: anything nested in a section is conditional, full stop.
 *
 * Preview-only and best-effort: conditions are shown as their source text (we
 * can't evaluate `procedureComplete`), and data-driven branches (`.map` over
 * fetched data) surface as a single repeated section rather than one section
 * per item. The runtime render remains the source of truth for actual output.
 */
// The node/section/segment types are part of the pattern-block contract
// (blocks ship their own blueprint expanders) and live in blocks/types.ts;
// re-export them so preview code keeps one import site for blueprint concepts.
export type { BlockRelation, BlueprintKind, BlueprintNode, BlueprintSection, TextSegment };

export type SkillBlueprint = {
  nodes: BlueprintNode[];
  /** Present when static source analysis could not parse the module. Runtime
   * rendering may still fail separately; authoring diagnostics surface this. */
  parseError?: string;
};

/**
 * Every skill link in a blueprint, split by reachability: `unconditional`
 * links always render; `conditional` links sit inside an area that only
 * exists in some state — behind a source condition or inside a block section
 * (e.g. a procedure's later step). A path is "gated" for the sidebar when
 * across ALL of an agent's skills it only ever appears conditionally.
 * Dynamic link targets (mapped lists) are skipped — no static path to mark.
 */
export function skillLinkAvailability(nodes: BlueprintNode[]): {
  conditional: Set<string>;
  unconditional: Set<string>;
} {
  const conditional = new Set<string>();
  const unconditional = new Set<string>();
  const collect = (candidates: BlueprintNode[], insideConditional: boolean) => {
    for (const node of candidates) {
      if (node.kind === "skill" && node.to) {
        (insideConditional ? conditional : unconditional).add(node.to);
      }
      collect(node.children, insideConditional);
      // Every section is a state the skill may or may not be in, so its
      // contents are conditional regardless of what produced the section.
      for (const section of node.sections ?? []) {
        collect(section.children, true);
      }
    }
  };
  collect(nodes, false);
  return { conditional, unconditional };
}

/**
 * Resolve the CURRENT values of a templated node's `{expr}` holes by matching
 * its literal segments against the rendered candidate strings (compiled
 * context text). Returns one value per dynamic segment, or null when no
 * candidate matches — e.g. when the node's branch isn't rendered right now,
 * in which case the values genuinely don't exist.
 *
 * Whitespace-tolerant on purpose: the compiler joins JSX text parts with
 * spaces, so "Signed in as {email}." renders as "Signed in as x ." — literal
 * anchors match across flexible whitespace. Text without words of its own
 * (`{summary}`, `{name}.`) would match any line, so it matches none.
 */
export function resolveSegmentValues(
  segments: TextSegment[],
  candidates: readonly string[],
): string[] | null {
  if (!segments.some((segment) => !segment.dynamic && /[\p{L}\p{N}]/u.test(segment.text))) return null;
  const pattern = segments
    .map((segment) =>
      segment.dynamic
        ? "(.*?)"
        : escapeRegExp(segment.text.replace(/\s+/g, " ").trim()).replace(/ /g, "\\s+"),
    )
    .join("\\s*");
  let regex: RegExp;
  try {
    regex = new RegExp(`^\\s*${pattern}\\s*$`);
  } catch {
    // KEEP-JUSTIFIED: a pathological literal that survives escaping is a
    // preview-only miss — fall back to showing expressions, never break.
    return null;
  }
  for (const candidate of candidates) {
    const match = regex.exec(candidate.replace(/\s+/g, " "));
    if (match) return match.slice(1).map((value) => value.trim());
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Blueprint kinds the PRIMITIVES produce. Pattern blocks (Procedure)
 * emit `kind: "block"` nodes through their own expanders, not this table. */
type PrimitiveKind = Exclude<BlueprintKind, "block">;

/** JSX component names of primitives that become blueprint nodes (everything
 * else — Agent, Page, Skills, GlobalTools, fragments — is a transparent
 * container we recurse through, and pattern blocks resolve through the block
 * registry). `Tool` covers both the action and form variants. */
const AFFORDANCE_KIND: Record<string, PrimitiveKind> = {
  Tool: "tool",
  Instruction: "instruction",
  Text: "text",
  Skill: "skill",
};

// Minimal structural view of the Babel AST — we treat nodes as opaque and
// walk by `type`, so no @babel/types dependency is needed.
interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/** Parse a skill module's source into its blueprint. Never throws on a syntax
 * quirk it can't model — returns whatever it could extract. */
export function parseSkillBlueprint(source: string): SkillBlueprint {
  let ast: AstNode;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    }) as unknown as AstNode;
  } catch (error) {
    // KEEP-JUSTIFIED: the branch preview remains available for the rest of the
    // agent; the structured parseError is surfaced by authoring diagnostics.
    return { nodes: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  const nodes: BlueprintNode[] = [];
  walk(ast, nodes, source);
  return { nodes };
}

/**
 * Recursive descent carrying the blueprint list to append to. Control flow
 * emits a `block` node whose sections hold each branch's affordances;
 * affordance JSX emits a leaf; everything else recurses generically so JSX is
 * found wherever it lives (returns, variables, fragments).
 */
function walk(node: AstNode, out: BlueprintNode[], source: string): void {
  switch (node.type) {
    case "JSXText": {
      const text = (node.value as string).replace(/\s+/g, " ").trim();
      if (text) {
        out.push({ kind: "text", label: truncate(text, 80), children: [] });
      }
      return;
    }
    case "ConditionalExpression": {
      // Both sides of a ternary belong to ONE decision. Sections are keyed by
      // the truthiness of the bare test, so `{!profile ? a : b}` and
      // `{profile ? b : a}` produce the same structure.
      const { test, negated } = normalizeTest(slice(node.test as AstNode, source));
      const whenTrue = negated ? (node.alternate as AstNode) : (node.consequent as AstNode);
      const whenFalse = negated ? (node.consequent as AstNode) : (node.alternate as AstNode);
      emitDecision(test, [collectSection(whenTrue, source), collectSection(whenFalse, source)], out);
      return;
    }
    case "LogicalExpression": {
      const { test, negated } = normalizeTest(slice(node.left as AstNode, source));
      // `a && x` renders x when a is truthy; `a || x` renders it when a is
      // falsy. A leading `!` on the left flips that again.
      const rendersWhenTrue = node.operator === "&&" ? !negated : negated;
      // The left side can itself contain JSX (rare): it is not part of the
      // branch, so it stays at the current level.
      walk(node.left as AstNode, out, source);
      const branch = collectSection(node.right as AstNode, source);
      emitDecision(test, rendersWhenTrue ? [branch, []] : [[], branch], out);
      return;
    }
    case "CallExpression": {
      const callee = node.callee as AstNode | undefined;
      const isMap =
        callee?.type === "MemberExpression" &&
        (callee.property as AstNode | undefined)?.type === "Identifier" &&
        ((callee.property as AstNode).name as string) === "map";
      if (!isMap) {
        recurseChildren(node, out, source);
        return;
      }
      const collection = itemsLabel(callee!, source);
      const children: BlueprintNode[] = [];
      recurseChildren(node, children, source);
      if (children.length === 0) return;
      // The collection is the block's label; the single section is one
      // iteration of it. `relation: "each"` already says it repeats.
      out.push({
        kind: "block",
        block: "each",
        label: collection,
        relation: "each",
        sections: [{ id: "item", label: "item", children }],
        children: [],
      });
      return;
    }
    case "JSXElement": {
      const name = jsxName(node);
      // Pattern blocks describe their own branch shape (a <Procedure> owns
      // its steps). The block registry hands us
      // the expander, so the parser stays block-agnostic.
      const expand = name ? getBlockBlueprint(name) : undefined;
      if (expand) {
        expand(node, blueprintApi(out, source));
        return;
      }
      let kind = name ? AFFORDANCE_KIND[name] : undefined;
      // <Text src="…"> is the file-sourced form of Text: a document row in
      // the preview, not an inline sentence.
      if (kind === "text" && attr(node, "src", source)) kind = "context";
      if (kind) {
        const blueprintNode: BlueprintNode = {
          kind,
          label: labelFor(kind, node, source),
          children: [],
        };
        if (kind === "skill") {
          const to = attr(node, "path", source);
          if (to) blueprintNode.to = to;
          const description = attr(node, "description", source);
          if (description) blueprintNode.description = description;
        }
        // Prose affordances carry their literal/`{expr}` structure so the
        // preview can highlight what is templated at runtime.
        if (kind === "text" || kind === "instruction" || kind === "skill") {
          const segments = textSegments(node, source);
          if (segments.some((segment) => segment.dynamic)) blueprintNode.segments = segments;
        }
        // Primitives are leaves: they ignore their JSX children (Field rows,
        // prose bodies handled via segments). Only blocks nest children.
        out.push(blueprintNode);
        return;
      }
      // Transparent container (Agent, Page, Skills, GlobalTools, ...).
      for (const child of childrenOf(node)) {
        walk(child, out, source);
      }
      return;
    }
    case "JSXFragment": {
      for (const child of childrenOf(node)) {
        walk(child, out, source);
      }
      return;
    }
    case "JSXExpressionContainer":
      walk(node.expression as AstNode, out, source);
      return;
    default:
      recurseChildren(node, out, source);
  }
}

/** Affordances one branch of a condition contributes, in isolation. */
function collectSection(node: AstNode | undefined, source: string): BlueprintNode[] {
  if (!node) return [];
  const children: BlueprintNode[] = [];
  walk(node, children, source);
  return children;
}

/**
 * Emit one `if` block for a condition, given the affordances of its truthy and
 * falsy branch. The condition lives on the block node; the sections are named
 * for the OUTCOME they represent, which for a boolean is exactly `true` and
 * `false`. No prose is invented here: a reader composes "procedureComplete" +
 * "false" itself, and generic code never has to parse a label.
 *
 * Empty branches are dropped (`{cond ? a : null}` has one section, not two),
 * and a condition with nothing in either branch emits nothing at all. A
 * constant test marks the impossible side `unreachable` so authoring
 * diagnostics can report dead code.
 */
function emitDecision(
  test: string,
  [whenTrue, whenFalse]: [BlueprintNode[], BlueprintNode[]],
  out: BlueprintNode[],
): void {
  if (whenTrue.length === 0 && whenFalse.length === 0) return;
  const sections: BlueprintSection[] = [];
  if (whenTrue.length > 0) {
    sections.push({
      id: "true",
      label: "true",
      polarity: "positive",
      ...(test === "false" ? { unreachable: true } : {}),
      children: whenTrue,
    });
  }
  if (whenFalse.length > 0) {
    sections.push({
      id: "false",
      label: "false",
      polarity: "negative",
      ...(test === "true" ? { unreachable: true } : {}),
      children: whenFalse,
    });
  }
  out.push({ kind: "block", block: "if", label: test, relation: "oneOf", sections, children: [] });
}

/**
 * The parser surface handed to a block's blueprint expander (see
 * BlockBlueprintApi in blocks/types.ts). The casts are safe: every node an
 * expander sees came out of this parser, so it IS an AstNode — the opaque
 * BlueprintAstNode type only keeps expanders from walking the AST themselves.
 */
function blueprintApi(out: BlueprintNode[], source: string): BlockBlueprintApi {
  return {
    name: (node) => (node.type === "JSXElement" ? jsxName(node as AstNode) : null),
    attr: (node, name) => attr(node as AstNode, name, source),
    attrNode: (node, name) => attrNodeOf(node as AstNode, name),
    children: (node) => childrenOf(node as AstNode),
    emit: (node) => out.push(node),
    walk: (node, into) => walk(node as AstNode, into ?? out, source),
  };
}

/** Generic recursion into every child node/array: reaches JSX anywhere. */
function recurseChildren(node: AstNode, out: BlueprintNode[], source: string): void {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (isNode(value)) {
      walk(value, out, source);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) walk(item, out, source);
      }
    }
  }
}

/** An attribute's value as an AST node (the expression inside `{…}`) — for
 * walking JSX passed as a prop, e.g. a procedure's `completed` content. */
function attrNodeOf(element: AstNode, key: string): AstNode | null {
  const opening = element.openingElement as AstNode | undefined;
  const attributes = opening?.attributes;
  if (!Array.isArray(attributes)) return null;
  for (const attribute of attributes) {
    if (!isNode(attribute) || attribute.type !== "JSXAttribute") continue;
    const name = attribute.name as AstNode | undefined;
    if (name?.type !== "JSXIdentifier" || name.name !== key) continue;
    const value = attribute.value as AstNode | undefined;
    if (!value) return null;
    if (value.type === "JSXExpressionContainer") return (value.expression as AstNode) ?? null;
    return value;
  }
  return null;
}

/** JSX children as AST nodes, skipping whitespace-only text. */
function childrenOf(node: AstNode): AstNode[] {
  const children = node.children;
  if (!Array.isArray(children)) return [];
  return children.filter(isNode);
}

function jsxName(element: AstNode): string | null {
  const opening = element.openingElement as AstNode | undefined;
  const name = opening?.name as AstNode | undefined;
  return name?.type === "JSXIdentifier" ? ((name.name as string) ?? null) : null;
}

function labelFor(kind: PrimitiveKind, element: AstNode, source: string): string {
  switch (kind) {
    case "tool":
      return attr(element, "name", source) ?? "tool";
    case "context":
      return attr(element, "src", source) ?? "document";
    case "skill": {
      // A skill's label is its child (often literal text, sometimes `{expr}`
      // in a mapped list) — prefer the expression source over a "…" placeholder
      // so a dynamic label stays identifiable.
      const label = childLabel(element, source);
      const path = attr(element, "path", source);
      return label || path || "skill";
    }
    case "text":
    case "instruction": {
      const text = jsxText(element);
      return text || "(dynamic)";
    }
  }
}

/** Concatenated JSX text of an element, with `{expr}` children shown as "…"
 * (for prose bodies where the expression source would be noise). */
function jsxText(element: AstNode): string {
  const parts: string[] = [];
  for (const child of childrenOf(element)) {
    if (child.type === "JSXText") {
      const value = (child.value as string).replace(/\s+/g, " ").trim();
      if (value) parts.push(value);
    } else if (child.type === "JSXExpressionContainer") {
      parts.push("…");
    }
  }
  return truncate(parts.join(" ").replace(/\s*…\s*/g, "…").trim(), 80);
}

/** Literal-vs-`{expr}` segments of a prose element's content. Adjacent
 * literals are merged; each expression becomes a dynamic segment holding its
 * source text. */
function textSegments(element: AstNode, source: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pushLiteral = (value: string) => {
    const text = value.replace(/\s+/g, " ");
    if (!text.trim() && segments.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && !last.dynamic) last.text += text;
    else segments.push({ text, dynamic: false });
  };
  const pushExpression = (expression: AstNode) => {
    // A literal-valued expression like `{" "}` (the JSX idiom for a space
    // across a line break) is not templated data — fold it into the literal
    // run instead of chipping it as a dynamic hole.
    const literal = literalValue(expression);
    if (literal !== null) {
      pushLiteral(literal);
    } else if (expression.type === "TemplateLiteral") {
      // Prose written as {`...`}: its text is literal, only its `${expr}` parts are holes.
      const holes = expression.expressions as AstNode[];
      (expression.quasis as AstNode[]).forEach((quasi, index) => {
        pushLiteral((quasi.value as { cooked?: string | null }).cooked ?? "");
        if (holes[index]) pushExpression(holes[index]);
      });
    } else {
      segments.push({ text: slice(expression, source), dynamic: true });
    }
  };
  for (const child of childrenOf(element)) {
    if (child.type === "JSXText") pushLiteral(child.value as string);
    else if (child.type === "JSXExpressionContainer") pushExpression(child.expression as AstNode);
  }
  // Trim leading/trailing whitespace on the outer literals.
  if (segments[0] && !segments[0].dynamic) segments[0].text = segments[0].text.replace(/^\s+/, "");
  const tail = segments[segments.length - 1];
  if (tail && !tail.dynamic) tail.text = tail.text.replace(/\s+$/, "");
  return segments.filter((segment) => segment.dynamic || segment.text.length > 0);
}

/** The constant text of a literal expression (`{" "}`, `{42}`, `{true}`), or
 * null when the expression is dynamic (a member access, call, etc.). */
function literalValue(expression: AstNode | undefined): string | null {
  if (!expression) return null;
  switch (expression.type) {
    case "StringLiteral":
      return expression.value as string;
    case "NumericLiteral":
    case "BooleanLiteral":
      return String(expression.value);
    default:
      return null;
  }
}

/** Child text of an element, keeping expression SOURCE (for skill labels). */
function childLabel(element: AstNode, source: string): string {
  const parts: string[] = [];
  for (const child of childrenOf(element)) {
    if (child.type === "JSXText") {
      const value = (child.value as string).replace(/\s+/g, " ").trim();
      if (value) parts.push(value);
    } else if (child.type === "JSXExpressionContainer") {
      parts.push(slice(child.expression as AstNode, source));
    }
  }
  return truncate(parts.join(" ").trim(), 80);
}

/** A string-literal or expression attribute's value as source text. */
function attr(element: AstNode, key: string, source: string): string | null {
  const opening = element.openingElement as AstNode | undefined;
  const attributes = opening?.attributes;
  if (!Array.isArray(attributes)) return null;
  for (const attribute of attributes) {
    if (!isNode(attribute) || attribute.type !== "JSXAttribute") continue;
    const name = attribute.name as AstNode | undefined;
    if (name?.type !== "JSXIdentifier" || name.name !== key) continue;
    const value = attribute.value as AstNode | undefined;
    if (!value) return null;
    if (value.type === "StringLiteral") return value.value as string;
    if (value.type === "JSXExpressionContainer") {
      return slice(value.expression as AstNode, source);
    }
    return slice(value, source);
  }
  return null;
}

function slice(node: AstNode | undefined, source: string): string {
  if (!node || node.start == null || node.end == null) return "condition";
  return truncate(source.slice(node.start, node.end).replace(/\s+/g, " ").trim(), 80);
}

/** Normalize a condition's source: leading `!`s fold into the negated flag, so
 * `!profile` and `profile` pair up as one decision with the same sections. */
function normalizeTest(test: string): { test: string; negated: boolean } {
  let negated = false;
  let bare = test;
  while (bare.startsWith("!")) {
    negated = !negated;
    bare = bare.slice(1).trim();
  }
  return { test: bare, negated };
}

/** "items" for `items.map(...)` — the collection a repeated branch runs over. */
function itemsLabel(callee: AstNode, source: string): string {
  return slice(callee.object as AstNode | undefined, source);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
