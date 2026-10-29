import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { EXPERIMENT_INFO_PREFIX } from "./experiments.js";
import type { AgentInfo } from "./info-store.js";
import { AgentInfoStore } from "./info-store.js";

/**
 * The store travels through context with a STABLE identity (the runtime
 * creates it once), so the provider itself never causes re-renders. Updates
 * reach components only through `useSyncExternalStore` subscriptions.
 */
const AgentInfoContext = createContext<AgentInfoStore | null>(null);

export function AgentInfoProvider({
  store,
  children,
}: {
  store: AgentInfoStore;
  children: React.ReactNode;
}) {
  return <AgentInfoContext.Provider value={store}>{children}</AgentInfoContext.Provider>;
}

/** The info store of the runtime rendering this component; null outside one. Its identity is
 * the runtime's, which is how per-runtime state elsewhere (agent stores) is found from outside. */
export function useAgentInfoStore(): AgentInfoStore | null {
  return useContext(AgentInfoContext);
}

/**
 * Read external session info from any component in the agent tree.
 *
 * ```tsx
 * const phone = useAgentInfo((info) => info["caller.phoneNumber"] as string | undefined);
 * ```
 *
 * A component only re-renders when the value IT selects changes — setting
 * unrelated keys is free. Selected values are compared by content, so a
 * selector may build a new array or object (`info.tags ?? []`, `({ a, b })`).
 * Selecting the whole object (`useAgentInfo()`) re-renders on any change;
 * prefer a selector.
 */
export function useAgentInfo(): AgentInfo;
export function useAgentInfo<T>(selector: (info: AgentInfo) => T): T;
export function useAgentInfo<T>(selector?: (info: AgentInfo) => T): T | AgentInfo {
  return useInfoSelector<T | AgentInfo>("useAgentInfo", selector ?? ((info) => info));
}

/** The call's client context: its `client.<key>` info, keyed without the prefix. */
export type ClientInfo = Readonly<Record<string, string | undefined>>;

/**
 * What the caller's page said about this call (the web widget's `data-context`, a session's
 * `clientContext`), as a plain object without the `client.` prefix. A key the page did not
 * send reads `undefined`.
 *
 * ```tsx
 * // A logged-in user's page set the widget's context: widget.context = { email: user.email, name: user.name }
 * const { email, name } = useClient();
 * return email ? <Instruction>{`The caller's email address is "${email}". Do not ask for it.`}</Instruction> : null;
 * ```
 *
 * Set by the caller's page; good for prefilling, never proof of identity.
 *
 * Every value is text: a `client.*` value of any other type (only your own host's
 * `updateInfo` can set one) is left out. Read from the same store as `useAgentInfo` and
 * compared by content, so it is the same object until a `client.*` value changes.
 */
export function useClient(): ClientInfo {
  return useInfoSelector("useClient", clientInfo);
}

/**
 * The variant this call got in one of the agent's experiments (`defineAgent({ experiments })`), or
 * `undefined` when it got none: the agent declares no experiment of that name, or the host running
 * the conversation assigns no variants (`curb say`, `curb start`).
 *
 * ```tsx
 * // experiments: { greeting: { variants: { formal: 1, casual: 1 } } }
 * const greeting = useVariant("greeting");
 * return greeting === "casual"
 *   ? <Instruction>Greet the caller casually, by first name when you know it.</Instruction>
 *   : <Instruction>Greet the caller formally.</Instruction>;
 * ```
 *
 * A call keeps its variant from before its first turn to its end. A hosting platform assigns it
 * and reports the agent's goals per variant; `curb dev` and `curb test` draw one per conversation
 * by the same rule. The value is the session info `experiment.<name>`.
 */
export function useVariant(experiment: string): string | undefined {
  return useInfoSelector("useVariant", (info) => {
    const variant = info[`${EXPERIMENT_INFO_PREFIX}${experiment}`];
    return typeof variant === "string" ? variant : undefined;
  });
}

function clientInfo(info: AgentInfo): ClientInfo {
  // No prototype, so a key the page did not send reads undefined, `constructor` included.
  const client: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("client.") && typeof value === "string") client[key.slice("client.".length)] = value;
  }
  return client;
}

/** One selector over the runtime's info store, re-rendering only when its result's contents change. */
function useInfoSelector<T>(hook: string, selector: (info: AgentInfo) => T): T {
  const store = useContext(AgentInfoContext);
  if (!store) {
    throw new Error(`${hook} must be used inside an agent runtime render.`);
  }
  const select = useStableSelector(selector);
  return useSyncExternalStore(store.subscribe, () => select(store.snapshot()));
}

/**
 * Wrap a store selector so a result with the same contents as the previous one IS the previous
 * one. `useSyncExternalStore` (and zustand on top of it) compares snapshots with `Object.is`,
 * so a selector returning a fresh array or object (`state.items ?? []`, `({ a: state.a })`,
 * `state.tasks.filter(...)`) reads as a change on every call and re-renders forever
 * ("Maximum update depth exceeded"). Comparing by content makes any selector that is a
 * function of the state safe.
 */
export function useStableSelector<S, T>(selector: (state: S) => T): (state: S) => T {
  const previous = useRef<{ value: T } | null>(null);
  return (state: S) => {
    const next = selector(state);
    const kept = previous.current;
    if (kept && equalContents(kept.value, next)) return kept.value;
    previous.current = { value: next };
    return next;
  };
}

/** Deep enough for anything a selector builds; deeper (or cyclic) data counts as changed. */
const MAX_COMPARE_DEPTH = 8;

/** Structural equality over plain data: arrays, plain objects and dates by content, everything
 * else (functions, class instances, maps) by identity. */
export function equalContents(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (depth >= MAX_COMPARE_DEPTH) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equalContents(item, right[index], depth + 1));
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      equalContents(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        depth + 1,
      ),
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
