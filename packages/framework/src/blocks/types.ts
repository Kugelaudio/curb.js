import type { SemanticNode } from "../types.js";

/**
 * Pattern blocks — the framework's opinionated layer above the primitives.
 *
 * A block packages one recurring interaction pattern (a step-by-step
 * procedure) so an author does not hand-roll machinery that is easy to get
 * wrong, and so the preview can render the pattern as familiar UI (a stepper)
 * instead of generic tool cards. For the model nothing changes: every block
 * compiles down to the same primitives — content lines and tools — so the LLM
 * contract stays flat and prompt-cache-stable.
 *
 * WHEN A BLOCK IS WARRANTED. Only when it owns mechanism the author cannot
 * reasonably write directly. `<Procedure>` qualifies: it tracks the step
 * cursor, derives each step's status, hides locked step bodies from the model,
 * and generates the advance tool. A credential gate did NOT: it was `useState`
 * plus a ternary plus a `<Tool>`, so it was removed in favour of authors
 * writing exactly that. Conditional rendering, local state, and showing a tool
 * only in one branch are all plain React and need no block. Prefer the
 * primitives; reach for a block when the mechanism is genuinely non-trivial.
 *
 * One block = one folder under `src/blocks/<id>/` with three parts:
 *
 *   index.tsx     — the authored component. Renders an `agent-block-<id>`
 *                   semantic element; owns its runtime state (hooks) and
 *                   composes primitives (e.g. a <Tool>) as children.
 *   definition.ts — ONE {@link defineBlock} call: the block's id, its
 *                   compiler (semantic node → model-facing lines/tools + a
 *                   JSON payload for the preview) and, when the block hides
 *                   control flow inside its component, its blueprint
 *                   expanders for the branch map. Must stay free of
 *                   React/UI imports — it runs wherever the compiler runs.
 *   preview.tsx   — the block's preview renderer: payload → familiar UI.
 *
 * Registration is two lines total: the definition goes into the list in
 * `registry.ts` (server-safe), the preview is paired with the definition in
 * `preview-registry.tsx` (browser-only — the split exists so server hosts
 * never import UI code). Those lists are the ONLY coupling points: the
 * compiler, the blueprint parser, and the inspector know no individual
 * block, and the block's id/tag/component names appear nowhere else.
 */

/** The one semantic tag blocks use to mark structured sub-content, rendered by
 * the `<Region>` component. A block that needs named parts (a procedure's
 * steps, its completed outcome) wraps them in regions instead of declaring its
 * own intrinsic elements. */
export const REGION_TAG = "agent-region";

/** One `<Region>` a block rendered, as seen by the block's compiler. */
export type BlockRegion = {
  /** The block-defined region name, e.g. "step" or "completed". */
  name: string;
  /** The region element itself, for `stringProp`/`numberProp`/`textContent`. */
  node: SemanticNode;
  children: SemanticNode[];
};

/** What a block's compiler may do at the block's position in the page. */
export type BlockCompileApi = {
  /** Emit one model-facing content line (never rendered as a preview block —
   * the block's own Preview is responsible for showing the pattern). */
  addContent: (text: string) => void;
  /**
   * Compile child semantic nodes as regular page content at this position —
   * e.g. a block's embedded <Tool> registers itself this way, and unlocked
   * children compile as normal content. With `render: false` the children
   * reach the model but produce no preview blocks (use this for tools the
   * block's Preview renders itself).
   */
  compileChildren: (nodes: SemanticNode[], options?: { render?: boolean }) => void;
  /**
   * Split the block's children into its `<Region>`s (in document order) and
   * everything else, so a block reads its named parts without matching tag
   * strings itself.
   */
  regions: (node: SemanticNode) => { regions: BlockRegion[]; rest: SemanticNode[] };
};

export type BlockCompileResult<TPayload = unknown> = {
  /** Preview payload. Must be JSON-serializable — it travels to the browser
   * over the WS protocol as part of the compiled context. */
  payload: TPayload;
  /** Tool names this block's Preview renders itself (e.g. a procedure's
   * advance tool, which the stepper draws as its "Next step" button). The
   * preview excludes them from the generic inline cards and the "Available
   * tools" fallback. */
  claimedTools?: string[];
};

/** Compiles one `agent-block-<id>` semantic node. Runs on every recompile. */
export type BlockCompiler<TPayload = unknown> = (
  node: SemanticNode,
  api: BlockCompileApi,
) => BlockCompileResult<TPayload>;

/**
 * Everything a block's Preview may use to render and act.
 *
 * Deliberately minimal: it carries what a block preview has actually needed,
 * not what one might need. Form drafts, field-change handlers, navigation and
 * tool lookup all lived here to serve a login card embedded in a block; that
 * block is gone, and speculative surface is what this contract has already
 * been trimmed of once. Add a member when a block needs it.
 */
export type BlockPreviewApi = {
  /** Last validation error per tool. */
  toolErrors: Record<string, string>;
  onToolSubmit: (name: string, input: Record<string, unknown>) => Promise<void>;
};

export type BlockPreviewProps<TPayload = unknown> = {
  payload: TPayload;
  api: BlockPreviewApi;
};

// ---------------------------------------------------------------------------
// Blueprint contract — how a block appears in the branch map.
//
// The branch map is parsed from skill SOURCE (see preview/skill-blueprint.ts):
// a block hides its control flow inside the framework component (a <Procedure>
// owns its steps), so the parser cannot see it. Instead of hardcoding blocks
// in the parser, a block ships its own expanders: pure functions from the
// block's JSX element to blueprint nodes, driven entirely through the api
// (no @babel import — definition.ts stays server-safe).
//
// A block does NOT flatten itself into pseudo-primitives here. It emits ONE
// `kind: "block"` node carrying named SECTIONS: the block's possible states
// (a procedure's steps, a condition's two sides) with the real primitives
// inside each. Source conditionals expand into the SAME shape (see
// `skill-blueprint.ts`), so consumers render branching generically and a new
// block never requires block-specific branch UI.
// ---------------------------------------------------------------------------

export type BlueprintKind = "tool" | "text" | "instruction" | "context" | "skill" | "block";

/** A run of a prose affordance's content: literal text, or a `{expr}` hole
 * whose value is filled at runtime. Powers the templating highlight. */
export type TextSegment = { text: string; dynamic: boolean };

/**
 * How a block's sections relate to each other:
 *
 * - `oneOf`    exactly one section is live at a time (a condition's two sides).
 * - `sequence` ordered, entered front to back (a procedure's steps).
 * - `each`     one section repeated per item of a collection (a `.map()`).
 */
export type BlockRelation = "oneOf" | "sequence" | "each";

/**
 * One named state of a block: a ternary's `true` side, a procedure's step.
 * Holds the affordances that exist in that state, and NOTHING that exists
 * outside it.
 *
 * Sections are the framework's ONE representation of branching. Source-level
 * control flow (`{cond ? a : b}`, `{cond && a}`, `items.map(...)`) expands
 * into exactly the same shape a pattern block emits, so every consumer (the
 * graph, authoring diagnostics, the inspector) handles one structure instead
 * of special-casing conditionals against blocks.
 */
export type BlueprintSection = {
  /** Stable id within the block; `activeSection` returns one of these. */
  id: string;
  /** Author-facing heading: "locked", "unlocked", a step title, a condition. */
  label: string;
  /**
   * Whether this section is the satisfied or unsatisfied side of a genuine
   * boolean. Set ONLY where that is true (a source `if`); a procedure's steps
   * and a `.map()` have no polarity and omit it.
   *
   * This is framework vocabulary, unlike `label`, which is opaque display text.
   * That distinction is the point: a renderer may branch on `polarity` because
   * the framework defines it, but must never branch on a label a block chose.
   */
  polarity?: "positive" | "negative";
  /**
   * The section can never be entered because its condition is a constant
   * (`{false && <Tool/>}`). Authoring diagnostics report these as dead code.
   */
  unreachable?: boolean;
  children: BlueprintNode[];
};

export type BlueprintNode = {
  kind: BlueprintKind;
  /** Tool name / skill label / block title / condition source / truncated text. */
  label: string;
  /** For skill links: the target path, so the preview can navigate to it. */
  to?: string;
  /** Explicit description on a source-level skill link, when statically known. */
  description?: string;
  /** For prose affordances (text/instruction/skill): the literal vs `{expr}`
   * structure of the content, so the preview can mark what is templated.
   * Undefined for non-prose kinds. */
  segments?: TextSegment[];
  children: BlueprintNode[];
  /** kind === "block" only: which block produced this node. Pattern blocks use
   * their id ("procedure"); source control flow uses the built-in
   * ids `if` and `each`. */
  block?: string;
  /** kind === "block" only: the block's states and how they relate. */
  sections?: BlueprintSection[];
  relation?: BlockRelation;
};

/** An opaque JSX AST node handed to a blueprint expander. Expanders never
 * walk it themselves — they go through the {@link BlockBlueprintApi}. */
export type BlueprintAstNode = { type: string };

/** What a blueprint expander may do at the block's position in the source. */
export type BlockBlueprintApi = {
  /** A JSX element's component name ("Step"), null for non-elements. */
  name: (node: BlueprintAstNode) => string | null;
  /** A string-literal or expression attribute's value as source text. */
  attr: (node: BlueprintAstNode, name: string) => string | null;
  /** An attribute's value as an AST node — for JSX passed as a prop (e.g. a
   * procedure's `completed` content), walkable via `walk`. */
  attrNode: (node: BlueprintAstNode, name: string) => BlueprintAstNode | null;
  /** The element's JSX children (whitespace-only text skipped). */
  children: (node: BlueprintAstNode) => BlueprintAstNode[];
  /** Append a blueprint node at the block's position. */
  emit: (node: BlueprintNode) => void;
  /** Recurse the parser into a child. `into` redirects output so a block can
   * collect a section's affordances into that section's children. */
  walk: (node: BlueprintAstNode, into?: BlueprintNode[]) => void;
};

/** Expands one JSX element of the block into blueprint nodes. */
export type BlockBlueprintExpander = (node: BlueprintAstNode, api: BlockBlueprintApi) => void;

// ---------------------------------------------------------------------------
// The block definition — everything the framework needs to know about one
// block, defined exactly once per folder.
// ---------------------------------------------------------------------------

export type BlockDefinition<TPayload = unknown> = {
  /** Folder name and preview key, e.g. "procedure". */
  id: string;
  /** The semantic tag the component renders — always `agent-block-<id>`,
   * derived by {@link defineBlock} so the two can never drift. */
  tag: string;
  /** The block's compiler (see {@link BlockCompiler}). */
  compile: BlockCompiler<TPayload>;
  /** Branch-map expanders, keyed by the JSX component name they handle
   * (`{ Procedure: … }`). Each emits ONE `kind: "block"`
   * node with the block's sections. */
  blueprint?: Record<string, BlockBlueprintExpander>;
};

/** The one way to declare a block. Call it in `src/blocks/<id>/definition.ts`
 * and add the result to the list in `registry.ts`. */
export function defineBlock<TPayload>(spec: {
  id: string;
  compile: BlockCompiler<TPayload>;
  blueprint?: Record<string, BlockBlueprintExpander>;
}): BlockDefinition<TPayload> {
  return { ...spec, tag: `agent-block-${spec.id}` };
}
