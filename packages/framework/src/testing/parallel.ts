import { projectHost, type TestHost } from "./host.js";

/**
 * How many things may be in flight at once, first come first served. `inParallel` holds one for
 * each list it works through, and lowers it when the provider says to slow down.
 */
export class RunSlots {
  private slots: number;
  private taken = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.slots = limit;
  }

  /** How many may be in flight now. */
  get limit(): number {
    return this.slots;
  }

  /** Halve the slots, down to one, from now on: the provider said to slow down. What is in
   * flight goes on; the next ones wait until there is room under the new limit. */
  lower(): number {
    this.slots = Math.max(1, Math.floor(this.slots / 2));
    return this.slots;
  }

  /** Run `task` once a slot is free, and free the slot when it settles. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    // Behind whoever waits already; a waiting task is handed its slot by the one that frees it.
    if (this.taken < this.slots && this.waiting.length === 0) this.taken += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      this.taken -= 1;
      // Not while more are in flight than the limit, lowered meanwhile, allows.
      while (this.taken < this.slots && this.waiting.length > 0) {
        this.taken += 1;
        this.waiting.shift()!();
      }
    }
  }
}

export type InParallelOptions = {
  /** How many items are worked on at once, at first: a whole number, 1 or more. */
  concurrency: number;
  /** The host whose throttle tells when to slow down. Default: `projectHost()`. */
  host?: TestHost;
  /** Called with the new number at a time each time the provider's rate limit halves it. */
  onSlowDown?: (concurrency: number) => void;
};

/**
 * `fn` on every item, `concurrency` at a time, the results in the items' order. A rate limit of
 * the host's provider is no failure: every request waits it out on the host's one throttle, and
 * from then on half as many items are worked on at once (down to one). Rejects with the first
 * error `fn` throws; catch inside `fn` to keep going.
 */
export async function inParallel<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => R | Promise<R>,
  options: InParallelOptions,
): Promise<R[]> {
  const { concurrency } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`inParallel: concurrency must be a whole number of items at a time, 1 or more; got ${JSON.stringify(concurrency)}.`);
  }
  const slots = new RunSlots(concurrency);
  const throttle = (options.host ?? projectHost()).throttle;
  const stop = throttle?.onSlowDown(() => options.onSlowDown?.(slots.lower()));
  try {
    return await Promise.all([...items].map((item, index) => slots.run(async () => fn(item, index))));
  } finally {
    stop?.();
  }
}
