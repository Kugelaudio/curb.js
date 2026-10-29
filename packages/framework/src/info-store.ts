/**
 * External session info — data that exists OUTSIDE the React tree (caller
 * phone number from SIP, authenticated user id, A/B flags, …) but that
 * components want to read. A minimal external store in the zustand mold:
 * subscribe + immutable snapshots, consumed via `useSyncExternalStore` with
 * per-hook selectors (see `useAgentInfo`), so a change only re-renders the
 * components whose selected value actually changed.
 */

export type AgentInfo = Readonly<Record<string, unknown>>;

export class AgentInfoStore {
  private values: AgentInfo = {};
  private readonly listeners = new Set<() => void>();

  /** Stable-identity snapshot: the object is replaced only when a value
   * actually changes, which is what makes `useSyncExternalStore` cheap. */
  snapshot = (): AgentInfo => this.values;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Merge values into the store. Keys set to `undefined` are removed.
   * Returns true when anything actually changed (callers use this to skip
   * pointless runtime refreshes).
   */
  set(update: Record<string, unknown>): boolean {
    let changed = false;
    const next: Record<string, unknown> = { ...this.values };
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) {
        if (key in next) {
          delete next[key];
          changed = true;
        }
        continue;
      }
      if (!Object.is(next[key], value)) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) return false;

    this.values = next;
    for (const listener of this.listeners) listener();
    return true;
  }
}
