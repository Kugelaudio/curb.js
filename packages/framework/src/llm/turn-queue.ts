/**
 * Whose turn it is in a conversation. One turn runs at a time; input that arrives meanwhile
 * waits for it, oldest first, and at most `maxWaiting` inputs wait.
 */
export class TurnQueue {
  /** How many inputs may wait behind the running turn. */
  readonly maxWaiting: number;
  private readonly onLeave: () => void;
  private busy = false;
  /** Inputs waiting for the running turn to finish, oldest first. Each is called when the
   * conversation is handed to it. */
  private readonly waiting: Array<() => void> = [];

  /** `onLeave` runs each time a turn is over, whether another input takes over or none does. */
  constructor(maxWaiting: number, onLeave: () => void) {
    this.maxWaiting = maxWaiting;
    this.onLeave = onLeave;
  }

  /** A turn is running: it owns the transcript until it leaves. */
  get running(): boolean {
    return this.busy;
  }

  /** Resolves "run" once this input owns the conversation, "busy" when the queue is full,
   * "cancelled" when `cancelled` aborts first (it leaves the queue). Whoever gets "run" calls
   * {@link leave} when its turn is over. */
  async enter(cancelled: AbortSignal): Promise<"run" | "busy" | "cancelled"> {
    if (!this.busy) {
      this.busy = true;
      return "run";
    }
    if (this.waiting.length >= this.maxWaiting) return "busy";
    const admitted = await new Promise<boolean>((resolve) => {
      const admit = () => {
        cancelled.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const at = this.waiting.indexOf(admit);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(false);
      };
      this.waiting.push(admit);
      cancelled.addEventListener("abort", leave, { once: true });
    });
    if (!admitted) return "cancelled";
    // Cancelled between the hand-over and this continuation: pass it on.
    if (cancelled.aborted) {
      this.leave();
      return "cancelled";
    }
    return "run";
  }

  /** The running turn is over: hand the conversation to the next waiting input, or go idle. */
  leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.busy = false;
    this.onLeave();
  }
}
