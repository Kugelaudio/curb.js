import type { AgentInfoStore } from "./info-store.js";

/**
 * What happens when the person a call was transferred to hangs up while the caller stays:
 * the transfer's `onEnded` (`transfer({ to, onEnded })`, `<TransferCallTool onEnded>`).
 *
 *   <TransferCallTool to="+493012345678" onEnded={{ action: "end_call", goodbye: "Goodbye!" }} />
 *
 * `useTransferCall` tracks each transfer with its `onEnded` from the moment the platform
 * accepts it (the target may join, and leave, before the answered result arrives) until it
 * ends unanswered. When the target leaves and the caller stays, the voice host asks
 * {@link decideTransferEnded} (`livekit-host/host.ts`) and applies the decision
 * (`applyTransferEnded`, `livekit-host/transfer-handoff.ts`). The agent stays handed off,
 * neither listening nor speaking, until then. Without `onEnded` the agent takes the call back
 * and tells the caller the other person left.
 *
 * Browser-safe: no Node imports, because `transfer.tsx`, which `src/index.ts` exports, uses it.
 */

/** The transfer whose target just left. */
export interface TransferEnded {
  /** The number the caller was put through to, as the transfer named it. */
  to: string;
  /** The platform's id of the transfer. */
  transferId: string;
}

/**
 * What the agent does once the transfer target left and the caller is still on the line.
 *
 * - `continue`: the agent listens and speaks again. `instruction` says what it does next,
 *   e.g. "Ask whether the colleague could solve the problem."; without it the agent tells
 *   the caller the other person left and asks whether it can help with anything else.
 * - `end_call`: the call ends. `goodbye` is said to the caller first, in the agent's voice and
 *   not interruptible; without it the call ends at once.
 */
export type TransferEndedDecision =
  | { action: "continue"; instruction?: string }
  | { action: "end_call"; goodbye?: string };

/** A transfer's `onEnded`: a decision, or a function deciding when the target left. The
 * function may be async; returning nothing is `continue`. */
export type TransferEndedOption =
  | TransferEndedDecision
  | ((ended: TransferEnded) => TransferEndedDecision | undefined | Promise<TransferEndedDecision | undefined>);

/** A transfer the platform accepted, as `useTransferCall` tracks it for its runtime. */
export interface TrackedTransfer extends TransferEnded {
  onEnded?: TransferEndedOption;
}

/** How long an `onEnded` function may take before the agent continues without it. The caller
 * hears nothing meanwhile, so this stays short. */
export const TRANSFER_ENDED_TIMEOUT_MS = 5_000;

const CONTINUE: TransferEndedDecision = { action: "continue" };
const TIMED_OUT = Symbol("timed out");

/** Keyed by the runtime's info store, whose identity is the runtime's (as in `transfer.tsx`).
 * The platform runs one transfer of a call at a time, so the tracked one is the one whose
 * target leaves. */
const trackedByRuntime = new WeakMap<AgentInfoStore, TrackedTransfer>();

/** The platform accepted `transfer`: its target may join from now on. */
export function trackTransfer(info: AgentInfoStore, transfer: TrackedTransfer): void {
  trackedByRuntime.set(info, transfer);
}

/** The transfer ended without its target answering: no target of it will leave. */
export function untrackTransfer(info: AgentInfoStore, transferId: string): void {
  if (trackedByRuntime.get(info)?.transferId === transferId) trackedByRuntime.delete(info);
}

/** A rewind rebuilt the runtime: the call, and its transfer, go on in `to`. */
export function moveTrackedTransfer(from: AgentInfoStore, to: AgentInfoStore): void {
  const tracked = trackedByRuntime.get(from);
  if (tracked === undefined) return;
  trackedByRuntime.delete(from);
  trackedByRuntime.set(to, tracked);
}

/** Throws a TypeError naming the fix when `value` is neither absent, a decision, nor a function. */
export function checkTransferEndedOption(value: unknown): void {
  if (value === undefined || typeof value === "function" || toDecision(value) !== null) return;
  throw new TypeError(
    `transfer() needs "onEnded" as { action: "continue", instruction? }, { action: "end_call", goodbye? } ` +
      `or a function returning one, with instruction and goodbye as non-blank text; got ${JSON.stringify(value)}.`,
  );
}

export interface DecideTransferEndedOptions {
  /** Where a failing `onEnded` function is reported. Default `console.error`. */
  error?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * What happens now that the target of the runtime's tracked transfer left. Applied once: the
 * transfer is no longer tracked afterwards. Never rejects: an `onEnded` function that throws,
 * returns no decision or does not answer in time is reported through `error` and reads as
 * `continue`, so the caller is never left alone. Text comes back trimmed.
 */
export async function decideTransferEnded(
  info: AgentInfoStore,
  options: DecideTransferEndedOptions = {},
): Promise<TransferEndedDecision> {
  const tracked = trackedByRuntime.get(info);
  trackedByRuntime.delete(info);
  const onEnded = tracked?.onEnded;
  if (tracked === undefined || onEnded === undefined) return CONTINUE;
  // A decision was checked when the transfer was asked for.
  if (typeof onEnded !== "function") return toDecision(onEnded) ?? CONTINUE;

  const logError = options.error ?? ((line: string) => console.error(line));
  const timeoutMs = options.timeoutMs ?? TRANSFER_ENDED_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let returned: unknown;
  try {
    returned = await Promise.race([onEnded({ to: tracked.to, transferId: tracked.transferId }), timedOut]);
  } catch (error) {
    // KEEP-JUSTIFIED: the author's code failed while the caller waits in silence; the cause is
    // reported and the agent takes the call back, as without onEnded.
    logError(`[curb] transfer onEnded failed, the agent continues: ${error instanceof Error ? error.message : String(error)}`);
    return CONTINUE;
  } finally {
    clearTimeout(timer);
  }
  if (returned === TIMED_OUT) {
    logError(`[curb] transfer onEnded did not answer within ${timeoutMs} ms, the agent continues`);
    return CONTINUE;
  }
  if (returned === undefined) return CONTINUE;
  const decision = toDecision(returned);
  if (decision === null) {
    logError(
      `[curb] transfer onEnded returned ${JSON.stringify(returned)}, which is not a decision, the agent continues. ` +
        'Return { action: "continue", instruction? }, { action: "end_call", goodbye? } or nothing.',
    );
    return CONTINUE;
  }
  return decision;
}

/** The decision `value` names, its text trimmed, or null when it names none. A key the action
 * does not take (`goodbye` on `continue`, a misspelled `goodby`) is no decision, so it fails
 * loudly instead of losing the text. */
function toDecision(value: unknown): TransferEndedDecision | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = record.action === "continue" ? "instruction" : "goodbye";
  if (Object.keys(record).some((key) => key !== "action" && key !== allowed)) return null;
  if (record.action === "continue") {
    const instruction = optionalText(record.instruction);
    if (instruction === null) return null;
    return instruction === undefined ? { action: "continue" } : { action: "continue", instruction };
  }
  if (record.action === "end_call") {
    const goodbye = optionalText(record.goodbye);
    if (goodbye === null) return null;
    return goodbye === undefined ? { action: "end_call" } : { action: "end_call", goodbye };
  }
  return null;
}

/** Trimmed text; undefined when absent, null when not text or blank. */
function optionalText(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  return text || null;
}
