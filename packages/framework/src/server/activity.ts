/** Live voice calls, running replies and MCP sign-ins in progress, counted across every
 * connection of one server. */
export type ServerActivityCounts = { calls: number; turns: number; signIns: number };

/**
 * What a `curb dev` reload waits for: a live call is never cut by a reload; a reply being
 * written gets up to 30 s; an MCP sign-in the user opened, until the provider calls back
 * (at most 5 minutes). The agent server reports every change of the counts to the
 * supervisor, which restarts it once they allow.
 */
export class ServerActivity {
  private readonly calls = new Set<string>();
  /** Calls that ended before their start was counted: a late start must not count them. */
  private readonly ended = new Set<string>();
  private readonly turns = new Set<object>();
  private signIns = 0;

  constructor(private readonly onChange: (counts: ServerActivityCounts) => void = () => {}) {}

  counts(): ServerActivityCounts {
    return { calls: this.calls.size, turns: this.turns.size, signIns: this.signIns };
  }

  /** How many MCP sign-ins are in progress now (`McpManager.signInsInProgress`). */
  signInsInProgress(count: number): void {
    if (count === this.signIns) return;
    this.signIns = count;
    this.report();
  }

  callStarted(room: string): void {
    if (this.ended.delete(room) || this.calls.has(room)) return;
    this.calls.add(room);
    this.report();
  }

  callEnded(room: string): void {
    if (!this.calls.delete(room)) {
      this.ended.add(room);
      return;
    }
    this.report();
  }

  /** `owner` (one connection) has a reply running, or not any more. */
  turnRunning(owner: object, running: boolean): void {
    const changed = running ? !this.turns.has(owner) : this.turns.has(owner);
    if (!changed) return;
    if (running) this.turns.add(owner);
    else this.turns.delete(owner);
    this.report();
  }

  private report(): void {
    this.onChange(this.counts());
  }
}
