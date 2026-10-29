import type { ReactNode } from "react";
import type { z } from "zod";
import type { AuthoringDiagnostic } from "./authoring.js";
import type { ProviderProps } from "./providers.js";
import type { Adjustable } from "./settings-update.js";

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type JsonSchemaProperty =
  | { type: "string"; description?: string; enum?: string[]; format?: "email" }
  | { type: "number"; description?: string }
  | { type: "integer"; description?: string }
  | { type: "boolean"; description?: string };

/** One node of a JSON Schema: a tool's input property, an array's items, a branch of a union. */
export type JsonSchemaNode = { type?: string | string[]; description?: string } & Record<string, unknown>;

/**
 * Permissive object schema used for the tool wire format. `<Field>` tools produce
 * the flat `JsonSchema` above; a `<Tool schema>` carries zod's JSON Schema of its
 * input and an MCP tool its server's (nested objects, arrays, enums, `anyOf`, …),
 * both passed to the model as they are. Display helpers must therefore treat a
 * property's `type` as optional.
 */
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
} & Record<string, unknown>;

export type FieldType = JsonSchemaProperty["type"] | "email";

export type FieldDefinition = {
  name: string;
  /** The flat type; a list, an object or a union reads "string", and `jsonSchema` says what
   * it is. */
  type: FieldType;
  description?: string;
  required?: boolean;
  /** The only values a string field accepts (a zod `z.enum`, or a union of string
   * literals). The model gets them as the JSON Schema `enum`; a form can offer them. */
  enum?: string[];
  /** The field's JSON Schema as the model gets it, for a `<Tool schema>` field
   * (`zodSchemaToFields`). A `<Field>` has none: its flat `type` says it all. */
  jsonSchema?: JsonSchemaNode;
};

export type ToolResult = {
  ok: boolean;
  message?: string;
  data?: unknown;
};

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/** Result of a runtime tool call plus the context lines the call's re-render
 * added — attached to the transcript so the model sees cause and effect
 * side by side. */
export type ToolCallOutcome = {
  result: ToolResult;
  contextDiff: string[];
};

export class ToolInputError extends Error {
  readonly data?: unknown;

  constructor(message: string, options: { data?: unknown } = {}) {
    super(message);
    this.name = "ToolInputError";
    this.data = options.data;
  }

  toToolResult(): ToolResult {
    return {
      ok: false,
      message: this.message,
      data: this.data,
    };
  }
}

export function isToolInputError(error: unknown): error is ToolInputError {
  return error instanceof ToolInputError;
}

export type SiteElementProps = {
  children?: ReactNode;
};

/** `<Agent>`: the tree root, plus the providers the agent talks through (`curb/providers`).
 * A changed prop swaps that provider mid-call. Defaults: `kugelaudio.tts()`, `azure.stt()`,
 * `anthropic("claude-haiku-4-5")`. */
export type AgentProps = SiteElementProps &
  ProviderProps & {
    /**
     * Which settings the caller's app (`client`, `curb/client`'s `agent.update`) and the
     * host (`host`, `PATCH /v1/sessions/{id}`) may change during a call. Absent: nothing.
     * Paths: `"tts.voice"`, `"tts.model"`, `"stt.language"`, `"llm"`.
     */
    adjustable?: Adjustable;
  };

export type SkillsProps = SiteElementProps;

/** `<SystemPrompt>` children — the agent's system prompt as authored text.
 * The children ARE the prompt: nothing is prepended or appended at compile
 * time. (Voice sessions add the framework's spoken-reply rules at runtime.) */
export type SystemPromptProps = SiteElementProps;

export type GlobalToolsProps = SiteElementProps;

export type PageProps = SiteElementProps & {
  path?: string;
  title?: string;
};

export type InstructionProps = SiteElementProps;

export type TextProps = SiteElementProps & {
  /** Load text from a markdown file under `context/`. Plain JSX strings already
   * compile as factual content; use Text when an explicit boundary helps or a
   * file is needed. Exactly one of `src` / children may be given. */
  src?: string;
};

/** Semantic element props of a file-sourced text block (`agent-context-doc`),
 * produced by `<Text src="…">`. */
export type ContextDocProps = {
  src: string;
  content?: string;
};

/**
 * The spec of a tool a pattern block embeds — one typed object instead of
 * prefixed scalar props (`advanceToolName`, `advanceToolDescription`, …).
 * Blocks provide sensible defaults for anything omitted.
 */
export type ToolSpec = {
  /** Model-facing tool name, e.g. "complete_claim_procedure_stage". */
  name: string;
  /** Tool description for the model; blocks default it when omitted. */
  description?: string;
  /** Replace the block's built-in behavior when the tool is called. */
  onCall?: ToolHandler;
};

/** A `<Skill>` link. Its provider props override the `<Agent>`'s while that skill is the
 * active one. */
export type SkillProps = SiteElementProps &
  ProviderProps & {
    /** Skill path the agent can load via the `read_skill` tool. */
    path: string;
    description?: string;
  };

/** Compiled form of `<Skill>` — the semantic tree keeps the target as `to`. */
export type SkillElementProps = SiteElementProps &
  ProviderProps & {
    to: string;
    description?: string;
  };

export type ToolPropsBase = SiteElementProps & {
  name: string;
  description: string;
  /** Optional lucide icon name for the preview's card ("lock", "shield-check").
   * Presentation only: it never reaches the model. */
  icon?: string;
};

export type ToolActionProps = ToolPropsBase & {
  onCall: ToolHandler;
  /** Optional pass-through JSON Schema (used by MCP tools). Authored `<Tool>`s
   * leave this unset and expose no arguments. */
  inputSchema?: ToolInputSchema;
  /** Optional stable id override (MCP tools use `mcp:<server>:<tool>`). Defaults
   * to the reconciler node id. */
  id?: string;
};

/** Feedback lines shared by the input-tool variants: shown to the model (and
 * the preview) after the tool ran. */
export type ToolFeedbackProps = {
  /** Confirmation after a successful run, e.g. "Claim intake was accepted."
   * Falls back to the handler result's `message`. */
  success?: string;
  /** Fallback error when a failed result carries no `message` of its own. */
  error?: string;
};

export type ToolPropsWithSchema<TSchema extends z.ZodObject> = ToolPropsBase &
  ToolFeedbackProps & {
    schema: TSchema;
    onSubmit: (input: z.infer<TSchema>) => Promise<ToolResult> | ToolResult;
    /** Input the preview's Try form opens with, e.g. a customer your demo data knows.
     * Preview only: it never reaches the model. */
    tryWith?: Partial<z.input<TSchema>>;
  };

export type ToolPropsWithFields = ToolPropsBase &
  ToolFeedbackProps & {
    schema?: undefined;
    onSubmit: ToolHandler;
    /** Input the preview's Try form opens with. Preview only: it never reaches the model. */
    tryWith?: Record<string, unknown>;
  };

export type ToolProps<TSchema extends z.ZodObject = z.ZodObject> =
  | ToolActionProps
  | ToolPropsWithSchema<TSchema>
  | ToolPropsWithFields;

export type FieldProps = {
  name: string;
  type: FieldType;
  description?: string;
  required?: boolean;
};

export type ErrorMessageProps = SiteElementProps & {
  source?: string;
};

export type SemanticNode = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: SemanticNode[];
};

export type HostContainer = {
  root: SemanticNode | null;
  version: number;
};

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  scope: "runtime" | "global" | "page";
  /** Owning skill for page-scoped tools. Runtime/global tools have no skill. */
  skillPath?: string;
  /** Authored lucide icon name for the preview. Deliberately absent from
   * `toolSignature`, so it never enters the model's context. */
  icon?: string;
  /** Authored input the preview's Try form opens with (`<Tool tryWith>`). Preview only,
   * like `icon`. */
  tryWith?: Record<string, unknown>;
};

export type ContextLink = {
  to: string;
  label: string;
  description?: string;
  scope: "global" | "page";
};

/** A run of a text block: either literal prose or a `<Skill>` written INLINE
 * inside the text, which the preview renders as a clickable link in the flow.
 * The block's `text` is the flattened prose (what the model sees); `segments`
 * only drives preview rendering. */
export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; to: string; label: string; description?: string };

export type PageBlock =
  | { type: "instruction"; text: string }
  /** `segments` present when the prose contains inline `<Skill>` links; absent
   * for plain text (unchanged rendering). `text` is always the flattened prose. */
  | { type: "text"; text: string; segments?: InlineSegment[] }
  | { type: "doc"; src: string; text: string }
  | { type: "error"; text: string; source?: string }
  | { type: "link"; to: string; label: string; description?: string }
  /** A tool at its authored position in the page flow, so the preview renders
   * it next to the content it belongs to (e.g. the login form right under the
   * "content is locked" text) instead of in a detached tools section. */
  | { type: "tool"; name: string }
  /** A pattern block (src/blocks/): `name` selects the preview renderer via
   * the block preview registry, `payload` is whatever its compiler returned.
   * The model never sees blocks — block compilers emit plain content lines
   * and tools instead. `claimedTools` are rendered by the block's own
   * preview, so the generic tool cards/fallback must skip them. */
  | { type: "block"; name: string; payload: unknown; claimedTools?: string[] };

export type LoadedSkill = {
  path: string;
  title: string;
  /** Approximate authored characters this skill contributes to the current
   * compiled context. Used for directional sizing in the preview diagram. */
  characterCount: number;
};

export type CompiledContext = {
  /** Path of the ACTIVE skill (the most recently loaded one); "" at the agent level, where
   * no skill is loaded and the context is `agent.tsx` alone. */
  path: string;
  /** Title of the active skill; "" at the agent level. */
  title: string;
  /** The agent's system prompt, authored via `<SystemPrompt>` in the tree.
   * Undefined when the agent declares none. */
  systemPrompt?: string;
  /** Every currently loaded skill, oldest first, active last; empty at the agent level. */
  loadedSkills: LoadedSkill[];
  instructions: string[];
  content: string[];
  errors: string[];
  toolErrors: Record<string, string>;
  links: ContextLink[];
  blocks: PageBlock[];
  tools: ToolDefinition[];
  /** Framework authoring problems. Never sent to the LLM context snapshot. */
  diagnostics: AuthoringDiagnostic[];
};

export type ContextEvent =
  | { type: "page_loaded"; path: string; context: CompiledContext }
  | { type: "context_changed"; path: string; added: string[]; removed: string[] }
  | { type: "tool_called"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: ToolResult };

export type RuntimeSnapshot = {
  context: CompiledContext;
  /** Flattened render of the CURRENT compiled context — what the LLM sees as
   * its trailing state snapshot. Not a history log. */
  stateSnapshot: string[];
  agentContext: AgentContextEntry[];
  events: ContextEvent[];
};

export type AgentContextEntry = {
  title: string;
  lines: string[];
};

export type ToolRegistryEntry = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

/** Framework-provided tool name (installed by `AgentSiteRuntime`, always
 * available, every agent) that ends the current turn with no reply at all —
 * see `runtime.ts` (installation) and `agent-session.ts` (turn handling). */
export const SKIP_TURN_TOOL_NAME = "skip_turn";

/** Framework-provided tool name that HANGS UP the live voice call once the
 * goodbye it carries has finished playing. Installed by `AgentSiteRuntime`
 * only while a call is attached (`setEndCallRequest`), so a typed session
 * never sees it; the wait-for-playout half lives in
 * `server/voice/end-call.ts` and the hosts that wire it. */
export const END_CALL_TOOL_NAME = "end_call";
