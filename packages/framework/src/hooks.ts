import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import type { CallEvent as CallEventBody } from "./hosted/protocol.js";

/**
 * Code that runs after a call: `defineAgent({ afterCall, afterEvaluation })`. The agent declares
 * them in code, `curb build` writes their names into the bundle manifest (`curb.bundle.json`), and
 * a hosting platform runs each one on a runner started for it. They are plain async functions:
 * no React, no conversation, and nothing that takes part in a call. `curb dev` and `curb say` never
 * fire them; `curb hook` and `runHook` from `curb/testing` do, when asked.
 */

/** One moment of a call: the same JSON a webhook receives, field for field. */
export type CallEvent = CallEventBody;

/** The call an event describes, the event's `data.object`. */
export type CallRecord = CallEvent["data"]["object"];

/** Runs at least once per event, so `event.id` is the idempotency key. A throw or a rejection
 * fails the run, and a host may run it again. */
export type CallHook = (call: CallRecord, event: CallEvent) => void | Promise<void>;

/** Every hook there is, sorted: the order the manifest writes them in. */
export const HOOK_NAMES = ["afterCall", "afterEvaluation"] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/** The event each hook receives. */
export const HOOK_EVENT_TYPES: Readonly<Record<HookName, CallEvent["type"]>> = {
  afterCall: "call.ended",
  afterEvaluation: "call.evaluated",
};

/** How long a run may take when nothing asks for less. */
export const HOOK_LIMIT_MS = 120_000;

/** The hooks an agent declares, by name. */
export type AgentHooks = { readonly [Name in HookName]?: CallHook };

/** Whether `name` names a hook at all, declared or not. */
export function isHookName(name: string): name is HookName {
  return (HOOK_NAMES as readonly string[]).includes(name);
}

/** Refuse a hook that is not a function: nothing could run it, and it would fail only after a
 * real call has ended. */
export function assertHooks(hooks: { readonly [Name in HookName]?: unknown }): void {
  for (const name of HOOK_NAMES) {
    const hook = hooks[name];
    if (hook === undefined || typeof hook === "function") continue;
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.hookNotAFunction,
      severity: "error",
      message: `defineAgent({ ${name} }) is ${JSON.stringify(hook) ?? String(hook)}, not a function, so it could never run after a call.`,
      location: { source: "src/agent/agent.tsx", component: "defineAgent" },
      fix: `Pass an async function of the call, e.g. ${name}: async (call, event) => { await save(call); }, or leave ${name} out.`,
    });
  }
}

/** The hooks of `definition`, without the rest of it. */
export function agentHooks(definition: { readonly [Name in HookName]?: CallHook }): AgentHooks {
  assertHooks(definition);
  return Object.fromEntries(HOOK_NAMES.flatMap((name) => (definition[name] ? [[name, definition[name]]] : [])));
}

/** The hook `name` of `definition`. Throws when it declares none, naming what to add. */
export function declaredHook(definition: { readonly [Name in HookName]?: CallHook }, name: string): CallHook {
  const hook = isHookName(name) ? agentHooks(definition)[name] : undefined;
  if (hook !== undefined) return hook;
  throw new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.hookNotDeclared,
    severity: "error",
    message: isHookName(name)
      ? `The agent declares no ${name}, so there is nothing to run.`
      : `${JSON.stringify(name)} is not a hook: the hooks are ${HOOK_NAMES.join(" and ")}.`,
    location: { source: "src/agent/agent.tsx", component: "defineAgent" },
    fix: "Add it to defineAgent, e.g. afterCall: async (call, event) => { await save(call); }, or run a hook the agent declares.",
  });
}

/** The hooks as the bundle manifest carries them: their names, sorted. */
export function hookDeclarations(definition: { readonly [Name in HookName]?: CallHook }): HookName[] {
  const hooks = agentHooks(definition);
  return HOOK_NAMES.filter((name) => hooks[name] !== undefined);
}
