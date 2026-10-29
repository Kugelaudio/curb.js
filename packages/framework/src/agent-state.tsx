import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore as useZustandStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useAgentInfoStore, useStableSelector } from "./info-context.js";
import type { AgentInfoStore } from "./info-store.js";

/**
 * Shared agent state, powered by `zustand/vanilla`: define an object AND the
 * functions that change it once, get a typed hook, use it in any skill — no
 * provider, no string keys at call sites.
 *
 *   // agent.tsx — the agent's store, next to defineAgent
 *   export const useStore = createAgentStore("my-agent", (set) => ({
 *     procedureComplete: false,
 *     completeProcedure: () => set({ procedureComplete: true }),
 *   }));
 *
 *   // any skill
 *   const { procedureComplete, completeProcedure } = useStore();
 *   const done = useStore((state) => state.procedureComplete); // selector
 *   const open = useStore((state) => state.tasks.filter((task) => !task.done));
 *
 * Selected values are compared by content, so a selector may build a new
 * array or object; it re-renders only when the contents change.
 *
 * Unlike Zustand's usual module-level `create()`, the store INSTANCES live
 * per runtime: several runtimes share one process (live session, inspector
 * shadow, voice), and a module-global store would leak state between them.
 * The definition is module-level; each runtime lazily materializes its own
 * vanilla store through the always-mounted provider below.
 */

type StoreMap = Map<string, StoreApi<unknown>>;

const AgentStateContext = createContext<StoreMap | null>(null);

/** Each runtime's stores, found through the runtime's info store: the provider renders inside
 * `AgentInfoProvider`, whose store is the runtime's own `info`. */
const storesByRuntime = new WeakMap<AgentInfoStore, StoreMap>();
/** Every defined store's initializer by key, so a store no component has used yet can still
 * be restored. */
const initializers = new Map<string, StoreInitializer<object>>();

/** Mounted automatically by `AgentSiteRuntime` — authors never render this. */
export function AgentStateProvider({ children }: { children?: ReactNode }) {
  const info = useAgentInfoStore();
  const storesRef = useRef<StoreMap | null>(null);
  if (!storesRef.current) storesRef.current = new Map();
  if (info) storesByRuntime.set(info, storesRef.current);
  return (
    <AgentStateContext.Provider value={storesRef.current}>{children}</AgentStateContext.Provider>
  );
}

/** This runtime's store under `key`, created on first use — idempotent, so double renders are
 * safe. Actions close over the store's own set/get. */
function materialize<T>(stores: StoreMap, key: string, initializer: StoreInitializer<T>): StoreApi<T> {
  let api = stores.get(key) as StoreApi<T> | undefined;
  if (!api) {
    api = createStore<T>((set, get) => initializer(set, get));
    stores.set(key, api as StoreApi<unknown>);
  }
  return api;
}

/** Zustand's setState/getState: `set` merges partials (or takes
 * `(state) => partial`), `get` reads the current state inside actions. */
export type SetState<T> = StoreApi<T>["setState"];
export type GetState<T> = StoreApi<T>["getState"];

/** Builds the store's initial state, with `set`/`get` for its actions.
 * `NoInfer` makes TypeScript derive the store type from the RETURNED object
 * alone where possible; stores whose actions READ state (functional `set`,
 * `get()`) still need the explicit generic — `createAgentStore<MyStore>(…)`
 * — same rule as Zustand itself. */
export type StoreInitializer<T> = (set: SetState<NoInfer<T>>, get: GetState<NoInfer<T>>) => T;

export type UseAgentStore<T> = {
  (): T;
  <S>(selector: (state: T) => S): S;
};

/**
 * Define a shared store (module level, once) and get its hook. The `key`
 * names the slot in the runtime's store map — it appears exactly here, never
 * at call sites. State and actions are one object; changes re-render
 * consumers via zustand's subscription and recompile the context, so gating
 * skills/tools on store fields is how workflows become structural.
 */
export function createAgentStore<T extends object>(
  key: string,
  initializer: StoreInitializer<T>,
): UseAgentStore<T> {
  initializers.set(key, initializer as unknown as StoreInitializer<object>);

  function useAgentStore<S>(selector?: (state: T) => S): T | S {
    const stores = useContext(AgentStateContext);
    if (!stores) {
      throw new Error(
        "Agent stores must be used inside an agent runtime (AgentStateProvider is mounted automatically by AgentSiteRuntime).",
      );
    }
    const api = materialize(stores, key, initializer);
    // zustand compares selections with Object.is; compare by content instead, so a selector
    // that builds a new array or object does not re-render forever.
    const select = useStableSelector((selector ?? ((state: T) => state)) as (state: T) => S);
    return useZustandStore(api, select);
  }

  return useAgentStore as UseAgentStore<T>;
}

/** Saved state of one store: its data fields, and the fields that were `undefined`. */
export type SavedAgentStore = { values: Record<string, unknown>; unset?: string[] };

/**
 * The data of every store a runtime has created, by key, as JSON-safe values: what `curb say`
 * keeps between invocations. Actions (functions) are left out. A field holding anything else
 * JSON cannot carry (a Date, a Map, a class instance) is left out too and named in `skipped`
 * as `key.field`, so the caller can say so instead of restoring it wrong.
 */
export function snapshotAgentStores(runtime: { readonly info: AgentInfoStore }): {
  stores: Record<string, SavedAgentStore>;
  skipped: string[];
} {
  const stores: Record<string, SavedAgentStore> = {};
  const skipped: string[] = [];
  for (const [key, api] of storesByRuntime.get(runtime.info) ?? []) {
    const values: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [field, value] of Object.entries(api.getState() as Record<string, unknown>)) {
      if (typeof value === "function") continue;
      if (value === undefined) unset.push(field);
      else if (isJsonData(value)) values[field] = value;
      else skipped.push(`${key}.${field}`);
    }
    stores[key] = unset.length > 0 ? { values, unset } : { values };
  }
  return { stores, skipped };
}

/**
 * Put saved store data back into a runtime, creating any store its components have not used
 * yet from its definition. Returns the keys no `createAgentStore` defines any more (renamed or
 * removed). The runtime is not re-rendered here; refresh it afterwards.
 */
export function restoreAgentStores(
  runtime: { readonly info: AgentInfoStore },
  saved: Readonly<Record<string, SavedAgentStore>>,
): string[] {
  const stores = storesByRuntime.get(runtime.info);
  if (!stores) {
    throw new Error("curb: restoreAgentStores needs a runtime that has rendered once.");
  }
  const unknown: string[] = [];
  for (const [key, { values, unset = [] }] of Object.entries(saved)) {
    const initializer = initializers.get(key);
    if (!initializer) {
      unknown.push(key);
      continue;
    }
    const api = materialize(stores, key, initializer);
    api.setState({ ...values, ...Object.fromEntries(unset.map((field) => [field, undefined])) });
  }
  return unknown;
}

/** Plain data that survives a JSON round trip unchanged (an `undefined` property comes back
 * absent, which reads the same). Cyclic or absurdly deep data does not count. */
function isJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonData(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => item === undefined || isJsonData(item, depth + 1));
}
