import { serializeLlmInput } from "./serialize-input.js";
import type { AgentRunRequest, LlmCallRecord } from "./types.js";

/**
 * What a conversation sent to the LLM: one record per request, in order, with the error of a
 * request that failed. The list is replaced, never changed in place, so a reader holding it
 * keeps a stable one.
 */
export class LlmTrace {
  private calls: LlmCallRecord[] = [];
  private readonly onChange: () => void;

  /** `onChange` runs each time a record is added or gets its error. */
  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** The records so far. Treat as read-only. */
  get records(): LlmCallRecord[] {
    return this.calls;
  }

  /** Start again, for a new conversation. `onChange` does not run: the caller says so itself. */
  clear(): void {
    this.calls = [];
  }

  /** Record `request` as sent. Returns the record's index, for {@link failed}. */
  sent(request: AgentRunRequest): number {
    const index = this.calls.length;
    this.calls = [...this.calls, { index, at: new Date().toISOString(), input: serializeLlmInput(request) }];
    this.onChange();
    return index;
  }

  /** The request recorded at `index` failed with `error`. */
  failed(index: number, error: string): void {
    const call = this.calls[index];
    // The trace was cleared during the turn; nothing left to annotate.
    if (!call) return;
    this.calls = this.calls.map((entry) => (entry === call ? { ...entry, error } : entry));
    this.onChange();
  }
}
