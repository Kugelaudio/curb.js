import { Children, Fragment, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import type { z } from "zod";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import type {
  AgentProps,
  ErrorMessageProps,
  FieldProps,
  ContextDocProps,
  GlobalToolsProps,
  InstructionProps,
  PageProps,
  SiteElementProps,
  SkillElementProps,
  SkillProps,
  SkillsProps,
  SystemPromptProps,
  TextProps,
  ToolActionProps,
  ToolProps,
  ToolPropsWithFields,
  ToolPropsWithSchema,
} from "./types.js";
import { HOME_SKILL_PATH } from "./home-skill-migration.js";
import { useSkillMeta } from "./route-context.js";
import { titleFromSkillPath, WithOpenedSkills } from "./routing.js";
import { validateSchemaInput, zodSchemaToFields, type ZodObjectSchema } from "./form-schema.js";
import { validateToolInput } from "./form-validation.js";
import { resolvePublicMarkdown } from "./public-context.js";
import { getMcpManager, resolveMcpServer } from "./mcp/manager.js";
import type { McpAuth } from "./mcp/config.js";
import { mcpToolToDefinition } from "./mcp/to-tool-definition.js";
import { isToolInputError, type ToolResult } from "./types.js";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "agent-site": AgentProps;
      "agent-system-prompt": SystemPromptProps;
      "agent-skills": SkillsProps;
      "agent-global-tools": GlobalToolsProps;
      "agent-page": PageProps;
      "agent-instruction": InstructionProps;
      "agent-text": TextProps;
      "agent-context-doc": ContextDocProps;
      "agent-skill": SkillElementProps;
      "agent-form": ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>>;
      "agent-field": FieldProps;
      "agent-tool": ToolActionProps;
      "agent-error": ErrorMessageProps;
    }
  }
}

/** The agent's root: its children are the agent level, and after them it renders every skill
 * the conversation has opened. `llm`, `stt` and `tts` pick its providers (see `curb/providers`);
 * `adjustable` names the settings the client app and the host may change mid-call. */
export function Agent({ children, llm, stt, tts, s2s, adjustable }: AgentProps) {
  return (
    <agent-site llm={llm} stt={stt} tts={tts} s2s={s2s} adjustable={adjustable}>
      <WithOpenedSkills>{children}</WithOpenedSkills>
    </agent-site>
  );
}

/**
 * The agent's system prompt, authored right in the tree instead of exported as
 * a string and passed to `defineAgent`. Place it once at the top of `<Agent>`.
 * Children are plain text (the same "JSX text is context" rule as `<Text>`);
 * the compiler flattens them into `context.systemPrompt`.
 */
export function SystemPrompt({ children }: SystemPromptProps) {
  return <agent-system-prompt>{children}</agent-system-prompt>;
}

/** Declares the skills an agent can load on demand via the `read_skill` tool. */
export function Skills({ children }: SkillsProps) {
  return <agent-skills>{children}</agent-skills>;
}

export function GlobalTools({ children }: GlobalToolsProps) {
  return <agent-global-tools>{children}</agent-global-tools>;
}

export function Instruction({ children }: InstructionProps) {
  return <agent-instruction>{children}</agent-instruction>;
}

/** Optional explicit factual-content boundary. Plain JSX text compiles to the
 * same content type; Text additionally supports markdown files via `src`. */
export function Text({ children, src }: TextProps) {
  if (src !== undefined && children !== undefined) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: "Text received both inline children and src; these are mutually exclusive content sources.",
      location: { component: "Text" },
      fix: "Keep the inline content and remove src, or keep src and remove the children.",
    });
  }
  if (src !== undefined) {
    const markdown = resolvePublicMarkdown(src);
    return <agent-context-doc src={src} content={markdown} />;
  }
  return <agent-text>{children}</agent-text>;
}

/** A loadable skill: its label + description become a `read_skill` option.
 * The description defaults to the TARGET skill's `meta.description` (see
 * `SkillMeta`); an explicit `description` prop on the link overrides it. */
export function Skill({ path, description, children, llm, stt, tts }: SkillProps) {
  if (!path) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
      severity: "error",
      message: "Skill requires a non-empty path identifying its target skill module.",
      location: { component: "Skill" },
      fix: "Set path to a registered skill route, for example <Skill path=\"/claims\">Claims</Skill>.",
    });
  }
  const targetMeta = useSkillMeta(path);
  // "/" is where conversations started before the agent level, and no skill has it now: a
  // project that still links it keeps working, read_skill never offers it, and `curb check`
  // fails on the link (AGENT_HOME_SKILL_REMOVED) and says to delete it.
  if (path === HOME_SKILL_PATH) return null;

  return (
    <agent-skill
      to={path}
      title={targetMeta?.title ?? titleFromSkillPath(path)}
      description={description ?? targetMeta?.description}
      llm={llm}
      stt={stt}
      tts={tts}
    >
      {children}
    </agent-skill>
  );
}

/**
 * The question a tool reads back to the caller before it runs, built from the validated
 * input and written in the agent's language. Throw `ToolInputError` to send the model
 * back for better input.
 */
export type ToolConfirm<TInput> = (input: TInput) => string | Promise<string>;

/** The `confirm` prop of the `onSubmit` tool variants. */
export type ToolConfirmProps<TInput> = {
  /**
   * Run this tool only on the caller's yes. The model's call does not run `onSubmit`:
   * the caller hears this question word for word, and only a yes on their next turn runs
   * `onSubmit`, after which the model speaks from its result. A no or a correction drops
   * the call; calling the tool again replaces it.
   */
  confirm?: ToolConfirm<TInput>;
};

type InputToolProps =
  | (ToolPropsWithSchema<ZodObjectSchema> & ToolConfirmProps<z.infer<ZodObjectSchema>>)
  | (ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>>);

/**
 * Type-checks a tool defined as a standalone object (name, description, and
 * either `schema` + `onSubmit`, `onSubmit` alone, or `onCall`), returning it
 * unchanged with full autocomplete — the tool-side counterpart to
 * `defineAgent`. Pass the result to `<Tool def={...} />` (or spread it), so a
 * tool can live next to the code that backs it instead of inline in the tree.
 */
export function defineTool(config: ToolActionProps): ToolActionProps;
export function defineTool<TSchema extends ZodObjectSchema>(
  config: ToolPropsWithSchema<TSchema> & ToolConfirmProps<z.infer<TSchema>>,
): ToolPropsWithSchema<TSchema> & ToolConfirmProps<z.infer<TSchema>>;
export function defineTool(
  config: ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>>,
): ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>>;
export function defineTool(config: ToolProps): ToolProps {
  return config;
}

// Inline props (great for showcasing a tool right where it lives) OR a single
// `def` object built with `defineTool` — both compile to the same tool.
export function Tool(props: ToolActionProps): ReactNode;
export function Tool<TSchema extends ZodObjectSchema>(
  props: ToolPropsWithSchema<TSchema> & ToolConfirmProps<z.infer<TSchema>>,
): ReactNode;
export function Tool(props: ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>>): ReactNode;
export function Tool(props: ToolActionProps): ReactNode;
export function Tool<TSchema extends ZodObjectSchema>(props: {
  def: ToolPropsWithSchema<TSchema> & ToolConfirmProps<z.infer<TSchema>>;
}): ReactNode;
export function Tool(props: { def: ToolPropsWithFields & ToolConfirmProps<Record<string, unknown>> }): ReactNode;
export function Tool(props: { def: ToolActionProps }): ReactNode;
export function Tool(
  props: ToolActionProps | InputToolProps | { def: ToolActionProps } | { def: InputToolProps },
): ReactNode {
  const config: ToolActionProps | InputToolProps = "def" in props ? props.def : props;
  if ("onCall" in config) {
    // Ignoring it would run the action without the caller's yes.
    if ("confirm" in config && config.confirm !== undefined) {
      throw new AgentAuthoringError({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
        severity: "error",
        message: `Tool ${JSON.stringify(config.name)} has confirm and onCall, but confirm works only on a tool with onSubmit.`,
        location: { component: `Tool name=${JSON.stringify(config.name)}` },
        fix: "Give the tool a schema (or <Field> children) and onSubmit instead of onCall, and keep confirm.",
      });
    }
    return <ActionTool {...config} />;
  }

  return <InputTool {...config} />;
}

function ActionTool({ name, description, icon, onCall, children }: ToolActionProps) {
  const [error, setError] = useState<string | null>(null);

  async function callTool(input: Record<string, unknown>) {
    try {
      const result = await onCall(input);
      setError(result.ok ? null : (result.message ?? null));
      return result;
    } catch (caughtError) {
      if (!isToolInputError(caughtError)) throw caughtError;

      setError(caughtError.message);
      return caughtError.toToolResult();
    }
  }

  return (
    <>
      {error ? <ErrorMessage source={name}>{error}</ErrorMessage> : null}
      <agent-tool name={name} description={description} icon={icon} onCall={callTool}>
        {children}
      </agent-tool>
    </>
  );
}

function InputTool(props: InputToolProps) {
  const [result, setResult] = useState<ToolResult | null>(null);
  const fields = props.schema ? zodSchemaToFields(props.schema) : toolFields(props.children);
  const validate = (input: Record<string, unknown>) =>
    props.schema ? validateSchemaInput(props.name, props.schema, input) : validateToolInput(props.name, fields, input);

  /** `fake`: what a test runs in place of exactly `onSubmit` (`AgentSiteRuntime.fakeTools`); the
   * input check before it and the feedback after it are the same as on a real call. */
  async function submitTool(
    input: Record<string, unknown>,
    fake?: (input: Record<string, unknown>) => Promise<ToolResult>,
  ) {
    try {
      const nextResult = await (fake ?? props.onSubmit)(validate(input) as never);
      setResult(nextResult);
      return nextResult;
    } catch (caughtError) {
      if (!isToolInputError(caughtError)) throw caughtError;

      const nextResult = caughtError.toToolResult();
      setResult(nextResult);
      return nextResult;
    }
  }

  /** `confirm`'s question for the model's input. Runs nothing: the session holds the call
   * until the caller answers it (see `AgentSiteRuntime.readBack`). */
  async function readBack(input: Record<string, unknown>): Promise<string> {
    const question: unknown = await props.confirm!(validate(input) as never);
    if (typeof question !== "string" || !question.trim()) {
      throw new AgentAuthoringError({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
        severity: "error",
        message: `Tool ${JSON.stringify(props.name)} got ${JSON.stringify(question) ?? "undefined"} from confirm, not a question to read back.`,
        location: { component: `Tool name=${JSON.stringify(props.name)}` },
        fix: 'Return the sentence the caller answers yes to, built from the input, e.g. "lisa@example.com, is that right?".',
      });
    }
    return question.trim();
  }

  return (
    <>
      <ToolFeedback
        toolName={props.name}
        result={result}
        successMessage={props.success ?? null}
        fallbackErrorMessage={props.error ?? null}
      />
      <agent-form
        name={props.name}
        description={props.description}
        icon={props.icon}
        tryWith={props.tryWith}
        onSubmit={submitTool}
        confirm={props.confirm ? readBack : undefined}
      >
        {fields.map((field) => (
          <Field key={field.name} {...field} />
        ))}
      </agent-form>
    </>
  );
}

export function Field(props: FieldProps) {
  return <agent-field {...props} />;
}

export function ErrorMessage({ source, children }: ErrorMessageProps) {
  return <agent-error source={source}>{children}</agent-error>;
}

export type McpProps = {
  /** Server id — also the tool namespace (`<id>__<tool>`) and the credential
   * key (OAuth tokens live at `.mcp-auth/<id>.json`; a bearer token can come
   * from `MCP_<ID>_TOKEN`). Omit BOTH `id` and `url` to surface EVERY
   * registered server (connected ones contribute tools as they come online). */
  id?: string;
  /** @deprecated Use `id`. */
  server?: string;
  /** The server's MCP endpoint, e.g. "https://mcp.linear.app/mcp". Providing it
   * declares the server INLINE — it registers and connects on render, so no
   * separate `defineAgent({ mcpServers })` entry is needed. */
  url?: string;
  /** Auth override. Default (when omitted): a bearer token from
   * `MCP_<ID>_TOKEN` if set, else OAuth (log in once via the MCP menu). */
  auth?: McpAuth;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Optional allowlist of raw MCP tool names to expose. */
  only?: string[];
};

/**
 * Surfaces an MCP server's tools as framework tools. Place inside
 * `<GlobalTools>` to expose them everywhere, or on a skill page to scope them
 * to that skill — availability follows placement, exactly like text.
 *
 * With a `url`, the server is declared INLINE (`<Mcp id="linear"
 * url="https://mcp.linear.app/mcp" />`): it registers and connects on render,
 * credentials resolved implicitly (bearer from `MCP_<ID>_TOKEN`, else OAuth),
 * so no `defineAgent({ mcpServers })` entry is needed. Without a `url` it
 * surfaces a server already registered there or via the dashboard.
 *
 * Reads the prefetched cache synchronously (never awaits in render); a failed
 * connection renders the error rather than silently exposing nothing. Servers
 * that are disconnected or mid-authorization contribute nothing yet — the tools
 * appear on a later render once the server is ready.
 */
export function Mcp({ id, server, url, auth, headers, only }: McpProps) {
  const serverId = id ?? server;
  // Inline declaration: register + connect on first render (idempotent).
  if (serverId && url) {
    getMcpManager().ensureServer({ id: serverId, url, auth, headers });
  }
  const serverIds = serverId ? [serverId] : getMcpManager().serverIds();
  return (
    <>
      {serverIds.map((serverId) => (
        <Fragment key={serverId}>
          <McpServerTools server={serverId} only={only} />
        </Fragment>
      ))}
    </>
  );
}

function McpServerTools({ server, only }: { server: string; only?: string[] }) {
  const state = resolveMcpServer(server);
  if (state.status === "error") {
    return <ErrorMessage source={`mcp:${server}`}>{state.message}</ErrorMessage>;
  }
  if (state.status !== "ready") {
    return null;
  }

  const manager = getMcpManager();
  const tools = only ? state.tools.filter((tool) => only.includes(tool.name)) : state.tools;

  return (
    <>
      {tools.map((tool) => {
        const definition = mcpToolToDefinition(server, tool);
        return (
          <Fragment key={definition.id}>
            <agent-tool
              id={definition.id}
              name={definition.name}
              description={definition.description}
              inputSchema={definition.inputSchema}
              onCall={(input) => manager.callTool(server, tool.name, input)}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function ToolFeedback({
  toolName,
  result,
  successMessage,
  fallbackErrorMessage,
}: {
  toolName: string;
  result: ToolResult | null;
  successMessage: string | null;
  fallbackErrorMessage: string | null;
}) {
  if (!result) return null;

  if (result.ok) {
    const message = successMessage ?? result.message;
    return message ? <Text>{message}</Text> : null;
  }

  const message = result.message ?? fallbackErrorMessage;
  return message ? <ErrorMessage source={toolName}>{message}</ErrorMessage> : null;
}

/** Field definitions from the fields variant's `<Field>` children. */
function toolFields(children: ReactNode) {
  return Children.toArray(children)
    .filter(isFieldElement)
    .map((field) => ({
      name: field.props.name,
      type: field.props.type,
      description: field.props.description,
      required: field.props.required,
    }));
}

function isFieldElement(value: unknown): value is ReactElement<FieldProps> {
  return isValidElement<FieldProps>(value) && value.type === Field;
}
