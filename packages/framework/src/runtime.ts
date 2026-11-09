import { createElement, type ReactNode } from "react";
import { mergeAuthoringDiagnostics, type AuthoringDiagnostic } from "./authoring.js";
import { AgentStateProvider } from "./agent-state.js";
import { compileSite, flattenContext } from "./compiler.js";
import { AgentInfoProvider } from "./info-context.js";
import { AppMessages, AppMessagesProvider } from "./messages.js";
import { RouterProvider, type AgentRouterApi } from "./route-context.js";
import { AgentInfoStore } from "./info-store.js";
import { createSemanticRoot, type SemanticRoot } from "./reconciler.js";
import { SessionProvider, type CallView } from "./session-context.js";
import { adjustableFromTree, providerPropsFromTree, SessionSettings } from "./session-settings.js";
import {
  END_CALL_TOOL_NAME,
  SKIP_TURN_TOOL_NAME,
  ToolInputError,
  isToolInputError,
} from "./types.js";
import type {
  AgentContextEntry,
  CompiledContext,
  ContextEvent,
  RuntimeSnapshot,
  SemanticNode,
  ToolCallOutcome,
  ToolDefinition,
  ToolRegistryEntry,
  ToolResult,
} from "./types.js";

/** What the voice host registers so the model's `end_call` tool has something
 * to hang up. Returns immediately: the actual disconnect waits for the reply
 * carrying the call to finish playing (see `server/voice/end-call.ts`). */
export type EndCallRequest = () => void;

/** The question a `confirm` tool reads back for an input, or the failed result that
 * stands instead when the input is wrong or the read-back failed. */
export type ReadBackOutcome = { readBack: string } | { result: ToolResult };

/** What a test runs in place of a tool's `onSubmit` (`scenario({ fakes })`, `curb say --fake`):
 * it gets the input `onSubmit` would get, and its result is the call's result. */
export type ToolFake = (input: Record<string, unknown>) => Promise<ToolResult>;

/** A `<Tool>` form's `onSubmit` (`submitTool` in components.tsx): it checks the input, then runs
 * `fake` where it would run the author's `onSubmit`. */
type FakeableSubmit = (input: Record<string, unknown>, fake: ToolFake) => Promise<ToolResult>;

export type SiteFactory = (state: {
  /** The active skill's path (most recently loaded); "" while no skill is loaded. */
  path: string;
  /** All loaded skill paths, least recently used first, active last; none at the agent
   * level, where every conversation starts. The site must render a page for every one
   * of them (`<Agent>` renders them). */
  loadedPaths: readonly string[];
}) => ReactNode;

export type AgentSiteRuntimeOptions = {
  /** How many skills stay loaded at once (instructions + tools). When the
   * agent loads one more, the least recently used skill is evicted. */
  maxLoadedSkills?: number;
  /** Static diagnostics discovered from the complete authored agent tree. */
  authoringDiagnostics?: readonly AuthoringDiagnostic[];
};

const DEFAULT_MAX_LOADED_SKILLS = 3;

export class AgentSiteRuntime {
  private readonly root: SemanticRoot;
  private readonly renderSite: SiteFactory;
  /** External session info (caller number, user id, …) readable from any
   * component via `useAgentInfo`. Populated from outside via `updateInfo`. */
  readonly info = new AgentInfoStore();
  /** This conversation's app messages (`useSend`, `useMessage`). The host and the
   * client each connect a transport here and deliver what they send. */
  readonly messages = new AppMessages({
    // A message may change what components render. Inside a tool call the refresh is
    // deferred to `callTool`, so the change lands in the tool result's context diff.
    onDelivered: () => {
      if (!this.toolCallInFlight) this.refresh("update");
    },
  });
  /** The providers this conversation runs on (`<Agent llm stt tts>`, the active `<Skill>`'s
   * overrides, outside changes gated by `<Agent adjustable>`). Re-read from the tree after
   * every render; the voice host subscribes. */
  readonly settings = new SessionSettings({
    // An outside change may change what components render (`useSession().settings`).
    onUpdated: () => {
      if (!this.toolCallInFlight) this.refresh("update");
    },
  });
  private readonly events: ContextEvent[] = [];
  private readonly agentContext: AgentContextEntry[] = [];
  private readonly toolErrors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly maxLoadedSkills: number;
  private readonly authoringDiagnostics: readonly AuthoringDiagnostic[];
  private registry = new Map<string, ToolRegistryEntry>();
  /** The rendered tools authored with `confirm`, by tool definition id (see `confirms`). */
  private confirming = new Map<string, SemanticNode>();
  private context: CompiledContext | null = null;
  /** Loaded skill paths, least recently used first, ACTIVE skill last. Empty at the agent
   * level: a conversation starts with no skill loaded and opens each one when needed. */
  private loadedPaths: string[] = [];
  /** True while a tool handler runs — `navigate` then defers its refresh to
   * `callTool`, so the navigation lands in the tool result's context diff. */
  private toolCallInFlight = false;
  /** Set while a live voice call is attached to this runtime; null otherwise
   * (see `setEndCallRequest`, and `installEndCallTool` for why the tool only
   * exists while it is set). */
  private endCallRequest: EndCallRequest | null = null;
  /** The hosted call this runtime serves (`useSession().call`); null until one is bound. */
  private call: CallView | null = null;
  /** Tools a test replaced, by name (see `fakeTools`); empty outside tests. */
  private toolFakes: ReadonlyMap<string, ToolFake> = new Map();
  /** Stable `useRouter()` value, provided around every render (see refresh). */
  private readonly routerApi: AgentRouterApi = {
    push: (path: string) => this.navigate(path),
  };

  constructor(site: ReactNode | SiteFactory, options: AgentSiteRuntimeOptions = {}) {
    this.root = createSemanticRoot();
    this.renderSite = typeof site === "function" ? site : () => site;
    this.maxLoadedSkills = options.maxLoadedSkills ?? DEFAULT_MAX_LOADED_SKILLS;
    this.authoringDiagnostics = options.authoringDiagnostics ?? [];
    this.refresh("initial");
  }

  /** The active skill's path (the most recently loaded one); "" at the agent level. */
  private get path(): string {
    return this.loadedPaths.at(-1) ?? "";
  }

  /** Where the active skill is, for error messages. */
  private get where(): string {
    return this.path ? `in skill "${this.path}"` : "at the agent level";
  }

  /**
   * Subscribe to runtime changes. The listener fires after every `refresh`
   * (i.e. after each `callTool`/`loadSkill`). Returns an unsubscribe fn.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): RuntimeSnapshot {
    if (!this.context) {
      throw new Error("Runtime has not produced a context snapshot.");
    }

    return {
      context: this.context,
      stateSnapshot: flattenContext(this.context),
      agentContext: [...this.agentContext],
      events: [...this.events],
    };
  }

  /** Definition currently backing a callable tool name. Used by transcript
   * recording to preserve its owning skill at the moment it was called. */
  toolDefinition(name: string): ToolDefinition | undefined {
    return this.registry.get(name)?.definition;
  }

  tree() {
    return this.root.container.root;
  }

  async callTool(name: string, input: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
    const entry = this.registry.get(name);
    if (!entry) {
      throw new Error(`Tool "${name}" is not available ${this.where}.`);
    }

    this.events.push({ type: "tool_called", name, input });
    let result: ToolResult;
    this.toolCallInFlight = true;
    try {
      const fake = this.toolFakes.get(name);
      result = await (fake ? this.callFaked(name, fake, input) : entry.handler(input));
      if (result.ok) {
        this.toolErrors.delete(name);
      } else if (result.message) {
        this.toolErrors.set(name, result.message);
      }
    } catch (caughtError) {
      if (isToolInputError(caughtError)) {
        result = caughtError.toToolResult();
      } else {
        // A handler bug or a failing backend. The model gets a failed result it
        // can recover from; the raw error is for the developer only.
        console.error(`[curb] tool "${name}" threw:`, caughtError);
        result = { ok: false, message: unexpectedToolFailureMessage(name) };
      }
      this.toolErrors.set(name, result.message ?? "");
    } finally {
      this.toolCallInFlight = false;
    }

    this.events.push({ type: "tool_result", name, result });
    const contextDiff = this.refresh("update");
    return { result, contextDiff };
  }

  /**
   * Run `fakes` in place of the named tools from now on, for tests only (`scenario({ fakes })`,
   * `curb say --fake`). A `<Tool>` form runs a call as it always does, its input check (schema
   * rules and transforms included) and the success or error line after it, and runs the fake
   * where it would run `onSubmit`. A tool without a form (`onCall`, an MCP tool) has no input
   * check of the framework's: the fake stands in for its whole handler. Either way the call is
   * recorded, a `confirm` tool still runs only on the caller's yes, and the context refreshes.
   */
  fakeTools(fakes: Readonly<Record<string, ToolFake>>): void {
    this.toolFakes = new Map(Object.entries(fakes));
  }

  /** A call of `name`, which a test faked with `fake` (see `fakeTools`). */
  private callFaked(name: string, fake: ToolFake, input: Record<string, unknown>): Promise<ToolResult> {
    const id = this.registry.get(name)?.definition.id;
    const submit = id === undefined ? undefined : toolForm(this.root.container.root, id)?.props.onSubmit;
    return typeof submit === "function" ? (submit as FakeableSubmit)(input, fake) : fake(input);
  }

  /** Whether `name` asks the caller before it runs (`<Tool confirm>`). The session then
   * holds the model's call instead of running it; `callTool` itself always runs the tool. */
  confirms(name: string): boolean {
    const id = this.registry.get(name)?.definition.id;
    return id !== undefined && this.confirming.has(id);
  }

  /**
   * The question `name` reads back to the caller for `input` (`<Tool confirm>`). The input
   * is validated as for a call, and the tool does not run. A wrong input or a
   * `ToolInputError` from `confirm` comes back as the failed result the model corrects
   * from; any other error as the internal-failure result, with the error logged.
   */
  async readBack(name: string, input: Record<string, unknown>): Promise<ReadBackOutcome> {
    const id = this.registry.get(name)?.definition.id;
    const confirm = id === undefined ? undefined : this.confirming.get(id)?.props.confirm;
    if (typeof confirm !== "function") {
      throw new Error(`Tool "${name}" ${this.where} has no confirm to read back.`);
    }
    try {
      // The form's own read-back (components.tsx): validates, then asks the author's `confirm`.
      const readBack: string = await (confirm as (input: Record<string, unknown>) => Promise<string>)(input);
      return { readBack };
    } catch (caughtError) {
      if (isToolInputError(caughtError)) return { result: caughtError.toToolResult() };
      console.error(`[curb] confirm of tool "${name}" threw:`, caughtError);
      return { result: { ok: false, message: unexpectedToolFailureMessage(name) } };
    }
  }

  /**
   * Compile a VIEW of one loaded skill against the CURRENT tree state,
   * without touching the loaded window or the tool registry. The preview
   * inspector uses this to show one skill at a time (no cross-skill tool
   * stacking) while component state persists across navigation — a gate
   * stays unlocked when the user browses away and back. `""` is the agent
   * level: `agent.tsx` alone, with no skill.
   */
  isolatedContext(path: string): CompiledContext {
    if (path !== "" && !this.loadedPaths.includes(path)) {
      throw new Error(`Skill "${path}" is not loaded — call loadSkill first.`);
    }
    const { context } = compileSite(this.root.container.root, path === "" ? [] : [path]);
    context.diagnostics = mergeAuthoringDiagnostics(this.authoringDiagnostics, context.diagnostics);
    this.addToolErrorsToContext(context);
    return context;
  }

  /**
   * Load a skill (make it the active one). Already-loaded skills are bumped to
   * most-recently-used; past `maxLoadedSkills` the least recently used skill is
   * evicted, so its instructions and tools leave the context.
   */
  loadSkill(path: string): ToolCallOutcome {
    this.markSkillLoaded(path);
    const contextDiff = this.refresh("update");
    return { result: { ok: true }, contextDiff };
  }

  /**
   * Programmatic navigation (`useRouter().push`). Same loading semantics as
   * `loadSkill`, but inside a tool call the refresh is deferred to `callTool`
   * so the navigation shows up in the tool result's context diff — the model
   * sees the new skill as the outcome of its call, not a separate event.
   */
  navigate(path: string): void {
    this.markSkillLoaded(path);
    if (!this.toolCallInFlight) this.refresh("update");
  }

  /**
   * Push external info (e.g. `{ "caller.phoneNumber": "+49…" }`) into the
   * session. Components reading the changed keys via `useAgentInfo` re-render,
   * and the context is recompiled once. Returns the context lines the change
   * added — empty when nothing in the compiled context depends on the value —
   * so the caller can decide whether the LLM needs a context event.
   */
  updateInfo(values: Record<string, unknown>): string[] {
    if (!this.info.set(values)) return [];
    return this.refresh("update");
  }

  /**
   * Re-render + recompile after something OUTSIDE the tree changed what
   * components resolve during render (e.g. an MCP server connected and its
   * tools became available). Returns the context lines the change added.
   */
  refreshExternal(): string[] {
    return this.refresh("update");
  }

  /**
   * Attach (or detach, with `null`) the live call's hang-up. The voice host
   * calls this when a call starts, again with the rebuilt runtime after a
   * rewind, and with `null` when the call is over. Recompiles, so `end_call`
   * appears and disappears with the call.
   */
  setEndCallRequest(request: EndCallRequest | null): void {
    if (this.endCallRequest === request) return;
    this.endCallRequest = request;
    if (!request) this.toolErrors.delete(END_CALL_TOOL_NAME);
    this.refresh("update");
  }

  /**
   * The host kept the call up after an `end_call` that ran: the caller talked over its
   * goodbye. The tool already answered ok, so the model believes the call is over; this
   * line in the context says it is not, on every step until an `end_call` runs again.
   */
  endCallCancelled(): void {
    this.toolErrors.set(
      END_CALL_TOOL_NAME,
      "end_call did not hang up: the caller talked over your goodbye, so the call is still on. " +
        "Reply to what they said. When nothing is left, or the other side is a machine (a voicemail, a menu, " +
        "an announcement), call end_call again: this time the call ends after your goodbye even if it is talked over.",
    );
    this.refresh("update");
  }

  /**
   * Bind the hosted call this runtime serves, so `useSession().call` reads its identity and
   * scratch directory. Once: a runtime is one conversation, and a second binding would hand
   * one call's identity to another. Recompiles, so a component that renders it is current.
   */
  bindCall(call: CallView): void {
    if (this.call !== null) {
      throw new Error(
        `curb: this runtime already serves call ${this.call.sessionId}; ` +
          `call ${call.sessionId} needs a runtime of its own.`,
      );
    }
    this.call = Object.freeze({ ...call });
    this.refresh("update");
  }

  private markSkillLoaded(path: string) {
    this.loadedPaths = this.loadedPaths.filter((loaded) => loaded !== path);
    this.loadedPaths.push(path);
    if (this.loadedPaths.length > this.maxLoadedSkills) {
      this.loadedPaths = this.loadedPaths.slice(-this.maxLoadedSkills);
    }
  }

  /** Re-render, recompile, and record the context change. Returns the lines
   * added by this render (the context diff) for the caller to attach to the
   * transcript. */
  private refresh(reason: "initial" | "update"): string[] {
    this.renderTree();
    // The settings follow the tree's props, and components read them (`useSession`): when
    // this render moved them, render once more so the compiled context sees the new value.
    if (this.readSettingsFromTree().length > 0) {
      this.renderTree();
      this.readSettingsFromTree();
    }
    const previousContext = this.context;
    const { context, registry } = compileSite(this.root.container.root, this.loadedPaths);
    context.diagnostics = mergeAuthoringDiagnostics(this.authoringDiagnostics, context.diagnostics);

    this.registry = registry;
    this.confirming = confirmingTools(this.root.container.root);
    this.installLoadSkillTool(context);
    if (this.settings.s2s()) context.instructions.push(HANDED_OVER_RULE);
    else this.installStaySilentTool(context);
    this.installEndCallTool(context);
    this.addToolErrorsToContext(context);
    this.context = context;

    let addedLines: string[];
    // The agent level has no skill, so no title of its own.
    const of = context.title ? `: ${context.title}` : "";
    if (reason === "initial" || !previousContext) {
      this.events.push({ type: "page_loaded", path: this.path, context });
      addedLines = flattenContext(context);
      this.agentContext.push({
        title: `Context${of}`,
        lines: addedLines,
      });
    } else {
      const { added, removed } = diffContext(previousContext, context);
      addedLines = added;
      if (added.length > 0 || removed.length > 0) {
        this.events.push({ type: "context_changed", path: this.path, added, removed });
        if (added.length > 0) {
          this.agentContext.push({
            title: `Updated${of}`,
            lines: added,
          });
        }
      }
    }

    this.notifyListeners();
    return addedLines;
  }

  /** Render the site with every framework provider around it. */
  private renderTree(): void {
    this.root.render(
      createElement(AgentInfoProvider, {
        store: this.info,
        // The shared agent state store (`createAgentStore`) and the router
        // (`useRouter`) wrap every site — no author-mounted providers.
        children: createElement(AgentStateProvider, {
          children: createElement(RouterProvider, {
            router: this.routerApi,
            children: createElement(AppMessagesProvider, {
              messages: this.messages,
              children: createElement(SessionProvider, {
                value: {
                  settings: this.settings.current(),
                  ...(this.call === null ? {} : { call: this.call }),
                },
                children: this.renderSite({ path: this.path, loadedPaths: [...this.loadedPaths] }),
              }),
            }),
          }),
        }),
      }),
    );
  }

  /** Feed the rendered props to the settings. Returns the slots whose effective value moved. */
  private readSettingsFromTree() {
    const root = this.root.container.root;
    this.settings.setAdjustable(adjustableFromTree(root));
    return this.settings.setProps(providerPropsFromTree(root, this.path));
  }

  private notifyListeners() {
    // Listeners must not throw — a throwing listener propagates loudly rather
    // than silently leaving other subscribers un-notified or runtime state
    // half-updated. (The set is empty during the constructor's initial refresh.)
    for (const listener of this.listeners) {
      listener();
    }
  }

  private installLoadSkillTool(context: CompiledContext) {
    if (context.links.length === 0) return;

    const allowedPaths = new Set(context.links.map((link) => link.to));
    const loadSkillDefinition: ToolDefinition = {
      id: "runtime:read_skill",
      name: "read_skill",
      description:
        "Silently read a skill's instructions and tools when the user's need requires them. " +
        "Recently read skills stay available; the least recently used one is dropped when too many are open.",
      scope: "runtime",
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: formatSkillOptions(context.links),
          },
        },
        required: ["skill"],
        additionalProperties: false,
      },
    };
    context.tools.unshift(loadSkillDefinition);

    this.registry.set("read_skill", {
      definition: loadSkillDefinition,
      handler: async (input) => {
        const skill = input.skill;
        if (typeof skill !== "string" || !allowedPaths.has(skill)) {
          // The valid paths belong IN the message. This error is read by a
          // model mid-turn, and one that cannot see what a correct value looks
          // like repeats the same wrong call until the turn runs out of steps.
          const byTitle = context.links.find(
            (link) => link.label.toLowerCase() === String(skill).trim().toLowerCase(),
          );
          throw new ToolInputError(
            `Unknown skill ${JSON.stringify(String(skill))}.` +
              (byTitle ? ` That is a skill's title; its path is ${JSON.stringify(byTitle.to)}.` : "") +
              ` Pass one of: ${[...allowedPaths].map((path) => JSON.stringify(path)).join(", ")}.`,
          );
        }

        this.markSkillLoaded(skill);
        return { ok: true };
      },
    });
  }

  /**
   * Framework-provided tool (unlike read_skill, not gated on links existing)
   * that lets the model end its turn with no reply — for when the user says
   * something like "wait", "hold on", or "don't say anything". The session
   * (agent-session.ts) special-cases this call: it drops any text from that
   * step and stops the turn immediately — the whole point is zero
   * spoken/written output.
   *
   * An agent with `s2s` does not get it: there `llm` hears only what is handed
   * over, so a job it skipped has no next line to pick it up again.
   */
  private installStaySilentTool(context: CompiledContext) {
    const staySilentDefinition: ToolDefinition = {
      id: "runtime:skip_turn",
      name: SKIP_TURN_TOOL_NAME,
      description:
        "Call this INSTEAD OF replying when the user wants you to say nothing right now — " +
        "e.g. \"wait\", \"hold on\", \"one sec\", \"never mind\", \"don't say anything\". " +
        "Ends your turn immediately with no spoken or written reply. Call it alone, with no " +
        "other text or tool calls in the same turn.",
      scope: "runtime",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    context.tools.unshift(staySilentDefinition);

    this.registry.set(SKIP_TURN_TOOL_NAME, {
      definition: staySilentDefinition,
      handler: async () => ({ ok: true }),
    });
  }

  /**
   * Framework-provided tool that ends the live voice call. Its one input is the
   * goodbye: a step that calls a tool says none of its own words, so the session
   * says the `goodbye` of an end_call that ran, at the end of its step, and only
   * once that has finished playing does the call disconnect (the host owns that
   * wait; see `server/voice/end-call.ts`). An empty goodbye is invalid input,
   * refused like any other: the call stays up and the model calls it again.
   *
   * Installed ONLY while a call is attached. A typed chat session has no call
   * to hang up, and offering the tool there would leave two bad options: hang
   * up nothing and report success (a silent failure), or report a failure the
   * model then has to reason about. A tool that is not rendered does not exist
   * — the same gating every authored capability uses — so a typed session
   * simply never sees it, and a call that ends takes it back out of context.
   */
  private installEndCallTool(context: CompiledContext) {
    const endCall = this.endCallRequest;
    if (!endCall) return;

    const endCallDefinition: ToolDefinition = {
      id: "runtime:end_call",
      name: END_CALL_TOOL_NAME,
      description:
        "Hang up: end the voice call you are on. Call this ONLY when the conversation is genuinely over — " +
        "the user said goodbye, or their request is fully handled and they need nothing else. " +
        "Your closing line is its goodbye: the caller hears it in full, then the call disconnects. " +
        "Never call it to avoid a difficult question, and never while anything is still open.",
      scope: "runtime",
      inputSchema: {
        type: "object",
        properties: {
          goodbye: {
            type: "string",
            description:
              "Your closing line, spoken to the caller before the call ends: one short, warm sentence in the caller's language.",
          },
        },
        required: ["goodbye"],
        additionalProperties: false,
      },
    };
    context.tools.unshift(endCallDefinition);

    this.registry.set(END_CALL_TOOL_NAME, {
      definition: endCallDefinition,
      // Returns as soon as the hang-up is REQUESTED — waiting for playout here
      // would deadlock: the goodbye cannot play until the turn (and so this
      // handler) has returned.
      handler: async (input) => {
        if (!endCallGoodbye(input)) {
          throw new ToolInputError(
            "end_call needs your closing line as goodbye: one short sentence to the caller, in their language. The call is still on; call end_call again with it.",
          );
        }
        endCall();
        return { ok: true };
      },
    });
  }

  private addToolErrorsToContext(context: CompiledContext) {
    context.toolErrors = Object.fromEntries(this.toolErrors.entries());

    for (const message of this.toolErrors.values()) {
      if (!context.errors.includes(message)) {
        context.errors.push(message);
      }
    }
  }
}

/** For `llm` behind a speech-to-speech model, which words no turn of its own: a turn left empty
 * would end the job with the caller still waiting. */
const HANDED_OVER_RULE =
  "You hear only what the voice model hands over, and nothing runs again until the next hand-over. End every turn with a tool call or a short reply for the caller, never with nothing. If what you were handed does not let you act yet, reply with one short question for what you still need.";

/** What the model reads when a tool handler throws something other than a
 * `ToolInputError`: it failed, the input was not the cause, and what to do
 * next. Never the raw error, which is an internal detail. */
export function unexpectedToolFailureMessage(name: string): string {
  return (
    `${name} failed because of an internal error, not because of the input. ` +
    "Do not retry it with the same input. Tell the user it did not work right now and offer another way forward."
  );
}

/** The closing line an `end_call` input carries, trimmed; undefined when it has none, which the
 * tool refuses. The session says it once the call ran. */
export function endCallGoodbye(input: Record<string, unknown>): string | undefined {
  const goodbye = typeof input.goodbye === "string" ? input.goodbye.trim() : "";
  return goodbye || undefined;
}

/** The rendered `<Tool confirm>` forms by node id, which is their tool definition id. Its
 * `confirm` prop is read when a call is held, like `onSubmit` when one runs. */
function confirmingTools(root: SemanticNode | null): Map<string, SemanticNode> {
  const forms = new Map<string, SemanticNode>();
  const visit = (node: SemanticNode) => {
    if (node.type === "agent-form" && typeof node.props.confirm === "function") forms.set(node.id, node);
    for (const child of node.children) visit(child);
  };
  if (root) visit(root);
  return forms;
}

/** The rendered `<Tool>` form with node id `id` (its tool definition id); none for other tools. */
function toolForm(node: SemanticNode | null, id: string): SemanticNode | undefined {
  if (!node) return undefined;
  if (node.type === "agent-form" && node.id === id) return node;
  for (const child of node.children) {
    const found = toolForm(child, id);
    if (found) return found;
  }
  return undefined;
}

function diffContext(previous: CompiledContext, next: CompiledContext) {
  const previousLines = new Set(flattenContext(previous));
  const nextLines = new Set(flattenContext(next));

  return {
    added: [...nextLines].filter((line) => !previousLines.has(line)),
    removed: [...previousLines].filter((line) => !nextLines.has(line)),
  };
}

function formatSkillOptions(links: CompiledContext["links"]) {
  // Path FIRST and quoted, title in parentheses. Written the other way round
  // ("Karriere (/karriere)") a model reasonably reads the title as the value
  // and the path as a gloss, then calls read_skill("Karriere") — which fails,
  // and fails identically on every retry until the step limit ends the turn.
  const options = links.map((link) => `"${link.to}" (${link.label})`);
  return `The skill's path, passed exactly as written here. One of: ${options.join(", ")}`;
}
