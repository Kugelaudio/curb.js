import { useMemo } from "react";
import { AUTHORING_DIAGNOSTIC_CODES, AgentAuthoringError } from "./authoring.js";
import { callTraceOf, type CallTrace } from "./call-trace.js";
import type { AgentInfo, AgentInfoStore } from "./info-store.js";
import { useAgentInfoStore } from "./info-context.js";
import { HostTimeoutError, HostUnavailableError, useAppMessages, type AppMessages } from "./messages.js";
import {
  checkTransferEndedOption,
  trackTransfer,
  untrackTransfer,
  type TrackedTransfer,
  type TransferEndedOption,
} from "./transfer-ended.js";
import { ToolInputError, type ToolResult } from "./types.js";

/**
 * Call transfer: put the caller of a hosted phone call through to another number.
 *
 *   const transfer = useTransferCall();
 *   const { outcome } = await transfer({ to: "+493012345678" });
 *
 * Over the host channel: `call.transfer` asks the host to dial the target into the call's
 * room; the reply is `call.transfer.accepted` ({ transferId }) or `call.transfer.refused`
 * ({ code, message, feature? }); `call.transfer.result` ({ transferId, outcome, dialStatus })
 * follows once the target answered, did not, or the dial failed. Once the target is in the
 * room the voice host hands the call off (the agent stops listening and speaking) and takes
 * it back when the target leaves while the caller stays (`livekit-host/transfer-handoff.ts`),
 * or does what the request's `onEnded` decides instead (`transfer-ended.ts`).
 *
 * What the caller hears meanwhile comes from the voice host ({@link TransferAudio}, attached
 * per call by `livekit-host/host.ts`): the request's `announce`, played to its end before
 * anything is dialed, then a ringback tone until the outcome is known.
 *
 * Browser-safe: no Node imports, because `src/index.ts` exports the hook and the tool.
 */

/** The host channel message names of a transfer. */
export const CALL_TRANSFER_MESSAGE = "call.transfer";
export const CALL_TRANSFER_RESULT_MESSAGE = "call.transfer.result";

/** How long the platform may take to accept or refuse a transfer (one collector pass). */
export const TRANSFER_REPLY_TIMEOUT_MS = 20_000;
/** The ring time the platform uses when the request names none. */
export const DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS = 30;
/** How long after the ring time ends the result may take to arrive. */
const TRANSFER_RESULT_MARGIN_MS = 30_000;
const MIN_RING_TIMEOUT_SECONDS = 10;
const MAX_RING_TIMEOUT_SECONDS = 60;

/** What `transfer` is asked to do. */
export interface TransferCallRequest {
  /** The number to put the caller through to, international format: "+493012345678". */
  to: string;
  /** How long the target's phone rings before the transfer counts as not answered:
   * a whole number of seconds from 10 to 60. Default 30. */
  ringTimeoutSeconds?: number;
  /** One sentence said to the caller before anything is dialed, e.g. "One moment, I am
   * connecting you to our sales team." It cannot be interrupted, and the dial starts once it
   * finished playing. Default: no announcement. */
  announce?: string;
  /** What happens when the person the caller was put through to hangs up while the caller
   * stays: `{ action: "end_call", goodbye? }`, `{ action: "continue", instruction? }`, or a
   * function returning one. Default: the agent takes the call back. */
  onEnded?: TransferEndedOption;
}

/**
 * What the voice host of a live call lends a transfer, so the caller is never left in
 * silence. Attached per call with {@link attachTransferAudio}; absent on a call without a
 * voice host.
 */
export interface TransferAudio {
  /** Say `text` to the caller, not interruptible. Resolves once it finished playing. */
  announce(text: string): Promise<void>;
  /** Start the ringback tone. Returns its stop. */
  ringback(): () => void;
}

/** Keyed by the runtime's info store, whose identity is the runtime's. */
const transferAudioByRuntime = new WeakMap<AgentInfoStore, TransferAudio>();

/** Attach (or detach, with `null`) the voice host's {@link TransferAudio} to the runtime that
 * owns `info`. The voice host calls it when a call starts, after a rewind, and at call end. */
export function attachTransferAudio(info: AgentInfoStore, audio: TransferAudio | null): void {
  if (audio) transferAudioByRuntime.set(info, audio);
  else transferAudioByRuntime.delete(info);
}

/**
 * What became of a transfer. `answered`: the target picked up and the call is handed off.
 * `no_answer`, `busy`, `failed`: the caller is still with the agent. `refused`: nothing was
 * dialed; `code` says why (`upgrade_required`, `transfer_unsupported_session`,
 * `transfer_unsupported_number`, `transfer_in_progress`, `callback_phone_invalid`,
 * `callback_destination_blocked`). A failed transfer with code `transfer_no_reply` got no
 * reply or no result from the host in time.
 */
export interface TransferOutcome {
  outcome: "answered" | "no_answer" | "busy" | "failed" | "refused";
  code?: string;
  message?: string;
  transferId?: string;
}

/** `useTransferCall()`. Never rejects for an outcome; throws `TypeError` for a bad request. */
export type TransferCall = (request: TransferCallRequest) => Promise<TransferOutcome>;

const DIAL_OUTCOMES = ["answered", "no_answer", "busy", "failed"] as const;

const PHONE_CALLS_ONLY =
  "Call transfer works on phone calls only: this session has no phone caller " +
  "(a browser session, an API session or the curb dev preview).";

/** What `transferCall` needs from its runtime. */
export interface TransferDeps {
  messages: AppMessages;
  info: () => AgentInfo;
  /** The call's audio, read when the transfer starts. */
  audio?: () => TransferAudio | undefined;
  /** The call's trace, read when the transfer starts: the transfer is a span in it. */
  trace?: () => CallTrace | undefined;
  error?: (line: string) => void;
  /** Where an accepted transfer is tracked until it ends unanswered, so the voice host applies
   * the request's `onEnded` once its target leaves (`transfer-ended.ts`). */
  tracking?: {
    track: (transfer: TrackedTransfer) => void;
    untrack: (transferId: string) => void;
  };
}

/** One transfer, start to outcome. `useTransferCall` binds it to the rendering runtime. */
export async function transferCall(deps: TransferDeps, request: TransferCallRequest): Promise<TransferOutcome> {
  // A span from the request on. An answered transfer stays open until the agent has the call
  // back or the call ends, which the voice host reports (`call-trace.ts`).
  const span = deps.trace?.()?.transfer(typeof request?.to === "string" ? request.to.trim() : "");
  try {
    const outcome = await dialTransfer(deps, request);
    span?.outcome(outcome.outcome);
    return outcome;
  } catch (error) {
    span?.outcome("failed");
    throw error;
  }
}

async function dialTransfer(deps: TransferDeps, request: TransferCallRequest): Promise<TransferOutcome> {
  const payload = transferPayload(request);
  const announcement = announceLine(request);
  const logError = deps.error ?? ((line: string) => console.error(line));
  const refused = (code: string, message: string): TransferOutcome => {
    logError(`[curb] call transfer refused (${code}): ${message}`);
    return { outcome: "refused", code, message };
  };
  const noReply = (message: string, transferId?: string): TransferOutcome => {
    logError(`[curb] call transfer failed (transfer_no_reply): ${message}`);
    return { outcome: "failed", code: "transfer_no_reply", message, ...(transferId ? { transferId } : {}) };
  };

  const phoneNumber = deps.info()["caller.phoneNumber"];
  if (!deps.messages.hostConnected || typeof phoneNumber !== "string" || phoneNumber.trim() === "") {
    return refused("transfer_unsupported_session", PHONE_CALLS_ONLY);
  }

  // Listening BEFORE asking: the result of a quick failure may arrive in the same pass as
  // the acceptance, and a result nobody listens for is refused no_handler.
  const results = new Map<string, Record<string, unknown>>();
  let waiting: { transferId: string; settle: (result: Record<string, unknown>) => void } | null = null;
  const unsubscribe = deps.messages.subscribe("host", CALL_TRANSFER_RESULT_MESSAGE, {
    onMessage: (result) => {
      if (!isRecord(result) || typeof result.transferId !== "string") return;
      if (waiting !== null && waiting.transferId === result.transferId) waiting.settle(result);
      else results.set(result.transferId, result);
    },
  });
  const audio = deps.audio?.();
  let stopRingback = () => {};
  // Tracked from the acceptance on: the target may join, and leave, before its answered
  // result arrives. Untracked on every other ending.
  let tracked: string | null = null;
  let answered = false;
  try {
    if (announcement !== undefined) {
      if (!audio) logError("[curb] call transfer: this call has no voice output, so the announcement was not said");
      else {
        try {
          await audio.announce(announcement);
        } catch (error) {
          // KEEP-JUSTIFIED: an announcement that failed to play must not keep the caller from
          // the person they asked for. The cause is logged; the transfer goes on.
          logError(`[curb] call transfer: the announcement could not be played: ${errorText(error)}`);
        }
      }
    }
    // From here until the outcome the caller hears a ringback, never silence.
    if (audio) stopRingback = audio.ringback();
    let reply: Record<string, unknown>;
    try {
      reply = await deps.messages.send.askHost(CALL_TRANSFER_MESSAGE, payload, {
        timeoutMs: TRANSFER_REPLY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof HostTimeoutError || error instanceof HostUnavailableError) {
        return noReply(`the host did not accept or refuse the transfer: ${error.message}`);
      }
      throw error;
    }

    if (typeof reply.code === "string") {
      const platformMessage = typeof reply.message === "string" ? reply.message : "";
      if (reply.code === "upgrade_required") {
        const feature = typeof reply.feature === "string" ? reply.feature : "outbound-calls";
        return refused(
          reply.code,
          `Call transfer needs a paid plan (plan feature ${feature}).${platformMessage ? ` ${platformMessage}` : ""}`,
        );
      }
      if (reply.code === "transfer_unsupported_session") {
        return refused(reply.code, platformMessage ? `${PHONE_CALLS_ONLY} ${platformMessage}` : PHONE_CALLS_ONLY);
      }
      return refused(reply.code, platformMessage || `the host refused the transfer with ${reply.code}.`);
    }
    if (typeof reply.transferId !== "string" || reply.transferId === "") {
      logError(`[curb] call transfer failed (transfer_invalid_reply): the host's reply names no transferId or code`);
      return {
        outcome: "failed",
        code: "transfer_invalid_reply",
        message: "The host's reply to call.transfer names no transferId or code.",
      };
    }

    const transferId = reply.transferId;
    deps.tracking?.track({ to: payload.to, transferId, onEnded: request.onEnded });
    tracked = transferId;
    const ringSeconds = request.ringTimeoutSeconds ?? DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS;
    const waitMs = ringSeconds * 1000 + TRANSFER_RESULT_MARGIN_MS;
    const result =
      results.get(transferId) ??
      (await new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => {
          waiting = null;
          resolve(null);
        }, waitMs);
        waiting = {
          transferId,
          settle: (value) => {
            clearTimeout(timer);
            waiting = null;
            resolve(value);
          },
        };
      }));
    if (result === null) {
      return noReply(`no ${CALL_TRANSFER_RESULT_MESSAGE} for transfer ${transferId} within ${waitMs} ms`, transferId);
    }
    const outcome = DIAL_OUTCOMES.find((known) => known === result.outcome);
    const dialStatus = typeof result.dialStatus === "string" ? result.dialStatus : undefined;
    if (outcome === undefined) {
      logError(`[curb] call transfer ${transferId}: unknown outcome ${JSON.stringify(result.outcome)}, read as failed`);
      return { outcome: "failed", transferId, message: `Unknown transfer outcome ${JSON.stringify(result.outcome)}.` };
    }
    answered = outcome === "answered";
    return {
      outcome,
      transferId,
      ...(outcome === "failed" && dialStatus ? { message: `The transfer call failed (dial status ${dialStatus}).` } : {}),
    };
  } finally {
    stopRingback();
    unsubscribe();
    if (tracked !== null && !answered) deps.tracking?.untrack(tracked);
  }
}

/** The request's announcement, trimmed; undefined when it has none. TypeError for a blank one. */
function announceLine(request: TransferCallRequest): string | undefined {
  if (request.announce === undefined) return undefined;
  const line = typeof request.announce === "string" ? request.announce.trim() : "";
  if (!line) {
    throw new TypeError(
      `transfer() needs "announce", when given, as the sentence said to the caller before dialing, for example "One moment, I am connecting you to our sales team."; got ${JSON.stringify(request.announce)}.`,
    );
  }
  return line;
}

/** The announcement a `transfer_call` input carries, trimmed; undefined when it has none. */
export function transferAnnouncement(input: Record<string, unknown>): string | undefined {
  const line = typeof input.announce === "string" ? input.announce.trim() : "";
  return line || undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `call.transfer` payload, or a TypeError naming what is wrong with the request. */
function transferPayload(request: TransferCallRequest): { to: string; ringTimeoutSeconds?: number } {
  if (!isRecord(request)) {
    throw new TypeError(
      'transfer() takes { to, ringTimeoutSeconds?, announce?, onEnded? }, for example transfer({ to: "+493012345678" }).',
    );
  }
  const to = typeof request.to === "string" ? request.to.trim() : "";
  if (!/^\+?[\d\s()./-]+$/.test(to) || !/\d/.test(to)) {
    throw new TypeError(
      `transfer() needs "to" as a phone number in international format, for example "+493012345678"; got ${JSON.stringify(request.to)}.`,
    );
  }
  const ring = request.ringTimeoutSeconds;
  if (
    ring !== undefined &&
    (!Number.isInteger(ring) || ring < MIN_RING_TIMEOUT_SECONDS || ring > MAX_RING_TIMEOUT_SECONDS)
  ) {
    throw new TypeError(
      `transfer() needs ringTimeoutSeconds as a whole number from ${MIN_RING_TIMEOUT_SECONDS} to ${MAX_RING_TIMEOUT_SECONDS}; got ${JSON.stringify(ring)}.`,
    );
  }
  checkTransferEndedOption(request.onEnded);
  return { to, ...(ring === undefined ? {} : { ringTimeoutSeconds: ring }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Transfer the live phone call to another number. Stable across renders; safe in tool
 * handlers. See {@link TransferOutcome} for what it resolves with.
 *
 * ```tsx
 * const transfer = useTransferCall();
 * const { outcome } = await transfer({
 *   to: "+493012345678",
 *   ringTimeoutSeconds: 25,
 *   announce: "One moment, I am connecting you to our sales team.",
 * });
 * ```
 */
export function useTransferCall(): TransferCall {
  const messages = useAppMessages("useTransferCall");
  const info = useAgentInfoStore();
  if (info === null) throw new Error("useTransferCall must be used inside an agent runtime render.");
  return useMemo(
    () => (request: TransferCallRequest) =>
      transferCall(
        {
          messages,
          info: info.snapshot,
          audio: () => transferAudioByRuntime.get(info),
          trace: () => callTraceOf(info),
          tracking: {
            track: (transfer) => trackTransfer(info, transfer),
            untrack: (transferId) => untrackTransfer(info, transferId),
          },
        },
        request,
      ),
    [messages, info],
  );
}

/** What the model reads after a transfer, so it can tell the caller in plain words. */
export function transferToolResult(outcome: TransferOutcome): ToolResult {
  const stayWithCaller = " The caller is still on the line with you: tell them, and offer another way to help.";
  switch (outcome.outcome) {
    case "answered":
      return {
        ok: true,
        message:
          "The call was put through: the person at the transfer number answered and is now talking with the caller. " +
          "You are handed off: say nothing more and call skip_turn. If they leave while the caller stays, you will be told.",
      };
    case "no_answer":
      return { ok: true, message: `Nobody answered at the transfer number.${stayWithCaller}` };
    case "busy":
      return { ok: true, message: `The line at the transfer number was busy.${stayWithCaller}` };
    case "failed":
      return { ok: false, message: `The transfer call could not be connected.${stayWithCaller}` };
    case "refused": {
      const why =
        outcome.code === "transfer_unsupported_session"
          ? "Calls can only be transferred on a phone call, and this is not one."
          : outcome.code === "transfer_in_progress"
            ? "Another transfer of this call is already under way."
            : outcome.code === "upgrade_required"
              ? "Transferring calls is not available on this agent's plan."
              : "The transfer was refused.";
      return { ok: false, message: `${why} Nobody was called.${stayWithCaller}` };
    }
  }
}

/** `<TransferCallTool>`: a ready tool the model calls to put the caller through to `to`. */
export interface TransferCallToolProps {
  /** The number the caller is put through to, international format: "+493012345678". */
  to: string;
  /** The tool's name. Default "transfer_call". */
  name?: string;
  /** When the model should call it. The default says what it does and how long it waits. */
  description?: string;
  /** How long the target's phone rings, 10 to 60 seconds. Default 30. */
  ringTimeoutSeconds?: number;
  /** What happens when the person hangs up while the caller stays; see
   * {@link TransferCallRequest.onEnded}. Default: the agent takes the call back. */
  onEnded?: TransferEndedOption;
}

/**
 * A ready tool that transfers the phone call to `to` and tells the model what happened
 * (answered, nobody answered, busy, failed, refused), so it can tell the caller.
 *
 * ```tsx
 * <TransferCallTool to="+493012345678" description="Put the caller through to the claims team when they ask for a person." />
 * <TransferCallTool to="+493012345678" onEnded={{ action: "end_call", goodbye: "Thank you for calling. Goodbye!" }} />
 * ```
 */
export function TransferCallTool({ to, name, description, ringTimeoutSeconds, onEnded }: TransferCallToolProps) {
  const transfer = useTransferCall();
  const request: TransferCallRequest = {
    to,
    ...(ringTimeoutSeconds === undefined ? {} : { ringTimeoutSeconds }),
    ...(onEnded === undefined ? {} : { onEnded }),
  };
  try {
    transferPayload(request);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // A wrong prop is the author's to fix, before the model can ever call the tool.
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: error.message,
      location: { component: "TransferCallTool" },
      fix:
        'Pass to="+493012345678" (international format) and, if at all, ringTimeoutSeconds from 10 to 60 and ' +
        'onEnded={{ action: "end_call", goodbye: "Goodbye!" }} or { action: "continue", instruction }.',
    });
  }
  const ring = ringTimeoutSeconds ?? DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS;
  const toolName = name ?? "transfer_call";
  // The JSON Schema is written out, as end_call's is, so a missing or blank announcement gets
  // a refusal that says what to send instead of a generic missing-field line.
  return (
    <agent-tool
      name={toolName}
      description={
        description ??
        "Put the caller through to a person. The caller first hears your announcement, then a ringback " +
          `while the transfer number rings (up to ${ring} seconds); when someone answers they take over the ` +
          "call and you stop speaking. Call it only when the caller wants to speak to a person."
      }
      inputSchema={{
        type: "object",
        properties: {
          announce: {
            type: "string",
            description:
              "The one sentence you say to the caller before connecting them, in their language, " +
              'for example "One moment, I am connecting you to our sales team." The caller hears it in full before the dial starts.',
          },
        },
        required: ["announce"],
        additionalProperties: false,
      }}
      onCall={async (input) => {
        const announce = transferAnnouncement(input);
        if (!announce) {
          throw new ToolInputError(
            `${toolName} needs announce: the one sentence you say to the caller before connecting them, in their language, ` +
              `for example "One moment, I am connecting you to our sales team." Nobody was called; call ${toolName} again with it.`,
          );
        }
        return transferToolResult(await transfer({ ...request, announce }));
      }}
    />
  );
}
