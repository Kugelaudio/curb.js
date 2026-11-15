import { useState } from "react";
import { AUTHORING_DIAGNOSTIC_CODES, AgentAuthoringError } from "./authoring.js";
import { callTraceOf, type HandoffRecord } from "./call-trace.js";
import { checkHandoffHours, isWithinHours, type HandoffHours } from "./handoff-hours.js";
import { useAgentInfoStore } from "./info-context.js";
import {
  DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS,
  isPhoneNumber,
  transferAnnouncement,
  transferPayload,
  transferToolResult,
  useTransferCall,
  type TransferCallRequest,
  type TransferOutcome,
} from "./transfer.js";
import type { TransferEndedOption } from "./transfer-ended.js";
import { ToolInputError, type ToolResult } from "./types.js";

/**
 * `<Handoff>`: one way for an agent to hand its caller to a person.
 *
 * The model calls the handoff tool when the caller asks for a person or it cannot help, with a
 * reason and a summary for whoever takes over. The session calls it on its own, with the reason
 * `agent_failure`, after `afterFailures` tool calls failed in a row or as many turns failed in a
 * row (`agent-session.ts`). Within the hours the caller is put through to `to` (`transfer.tsx`);
 * outside them, or when nobody answers, the agent offers a callback and records the request. Each
 * handoff is `curb.handoff` in the call's record, each callback request `curb.callback_request`
 * (`call-trace.ts`).
 *
 * Browser-safe: no Node imports, because `src/index.ts` exports it.
 */

/** Why a call is handed to a person. The model gives the first two; the framework the third. */
export const HANDOFF_REASONS = ["caller_requested", "agent_stuck", "agent_failure"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** The reason the framework gives when it hands off on its own. */
export const AGENT_FAILURE_REASON: HandoffReason = "agent_failure";

/** How many failures in a row hand the call off when `afterFailures` is not set. */
export const DEFAULT_HANDOFF_AFTER_FAILURES = 3;
const MAX_AFTER_FAILURES = 10;

/** A callback the caller asked for when nobody could take the call. */
export interface CallbackRequest {
  /** The caller's name, as they gave it. */
  name: string;
  /** The number to call back on: the one they gave, or on a phone call the one they call from. */
  phone: string;
  /** Why the call was handed off. */
  reason: HandoffReason;
  /** What the person calling back should know. */
  summary: string;
}

export interface HandoffProps {
  /** The number a person answers, international format: "+493012345678". */
  to: string;
  /** When someone is there to take the call: opening hours in a time zone, or a function of
   * the time. Outside them the agent takes a callback request instead. Default: always. */
  hours?: HandoffHours;
  /** Hand off on its own after this many tool calls failed in a row, or this many turns got no
   * reply in a row (1 to 10), or never with `false`. Default 3. */
  afterFailures?: number | false;
  /** How long the person's phone rings, 10 to 60 seconds. Default 30. */
  ringTimeoutSeconds?: number;
  /** What happens when the person hangs up while the caller stays; see `<TransferCallTool>`.
   * Default: the agent takes the call back. */
  onEnded?: TransferEndedOption;
  /** Where a callback request goes: your ticket system, CRM or inbox. It is in the call's
   * record either way. */
  onCallbackRequest?: (request: CallbackRequest) => void | Promise<void>;
  /** The handoff tool's name. Default "handoff". */
  name?: string;
  /** The callback tool's name. Default "request_callback". */
  callbackName?: string;
}

/**
 * Hand the caller to a person: put through within the hours, a callback request otherwise.
 *
 * ```tsx
 * <Handoff
 *   to="+493012345678"
 *   hours={{ timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00" } }}
 *   onCallbackRequest={(request) => tickets.create(request)}
 * />
 * ```
 */
export function Handoff({
  to,
  hours,
  afterFailures = DEFAULT_HANDOFF_AFTER_FAILURES,
  ringTimeoutSeconds,
  onEnded,
  onCallbackRequest,
  name = "handoff",
  callbackName = "request_callback",
}: HandoffProps) {
  const transfer = useTransferCall();
  const info = useAgentInfoStore();
  if (info === null) throw new Error("<Handoff> must be rendered inside an agent runtime.");
  // The handoff a callback is offered for, until the caller left one.
  const [open, setOpen] = useState<{ reason: HandoffReason; summary: string } | null>(null);

  const request: TransferCallRequest = {
    to,
    ...(ringTimeoutSeconds === undefined ? {} : { ringTimeoutSeconds }),
    ...(onEnded === undefined ? {} : { onEnded }),
  };
  checkProps(request, hours, afterFailures);
  const ring = request.ringTimeoutSeconds ?? DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS;

  const report = (record: HandoffRecord) => callTraceOf(info)?.handoff(record);

  const handOff = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const reason = HANDOFF_REASONS.find((known) => known === input.reason);
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    const announce = transferAnnouncement(input);
    if (!reason || !summary || !announce) {
      throw new ToolInputError(
        `${name} needs reason (caller_requested or agent_stuck), summary (what the person taking over should know) ` +
          `and announce (the one sentence you say to the caller before connecting them, in their language). ` +
          `Nobody was called; call ${name} again with all three.`,
      );
    }
    let staffed: boolean;
    try {
      staffed = await isWithinHours(hours, new Date());
    } catch (error) {
      // KEEP-JUSTIFIED: an hours check that fails must not strand the caller: they are offered a
      // callback, and the cause is logged.
      console.error(`[curb] <Handoff> hours check failed, so the caller is offered a callback:`, error);
      staffed = false;
    }
    if (!staffed) {
      report({ reason, summary, outcome: "closed" });
      setOpen({ reason, summary });
      return offerCallback("Nobody is there to take the call right now (outside the hours).");
    }
    const outcome = await transfer({ ...request, announce });
    report({ reason, summary, outcome: outcome.outcome, ...(outcome.code ? { code: outcome.code } : {}) });
    if (outcome.outcome === "answered") return transferToolResult(outcome);
    setOpen({ reason, summary });
    return offerCallback(unreached(outcome));
  };

  const offerCallback = (why: string): ToolResult => {
    const onPhone = typeof info.snapshot()["caller.phoneNumber"] === "string";
    return {
      ok: true,
      message:
        `${why} The caller is still on the line with you. Offer them a callback: ask for their name and ` +
        (onPhone ? "whether they want to be called back on the number they are calling from or another one, " : "the number to call them back on, ") +
        `then call ${callbackName}.`,
    };
  };

  const requestCallback = async (input: Record<string, unknown>): Promise<ToolResult> => {
    if (open === null) throw new ToolInputError(`No callback is offered now; call ${name} first.`);
    const caller = typeof input.name === "string" ? input.name.trim() : "";
    const given = typeof input.phone === "string" ? input.phone.trim() : "";
    const callingFrom = info.snapshot()["caller.phoneNumber"];
    const phone = given || (typeof callingFrom === "string" ? callingFrom.trim() : "");
    if (!caller || !phone || !isPhoneNumber(phone)) {
      throw new ToolInputError(
        `${callbackName} needs name and phone (the number to call back on, digits with an optional leading +). ` +
          `Nothing was recorded; ask the caller and call ${callbackName} again.`,
      );
    }
    const callback: CallbackRequest = { name: caller, phone, ...open };
    callTraceOf(info)?.callbackRequest(callback);
    await onCallbackRequest?.(callback);
    setOpen(null);
    return {
      ok: true,
      message: `The callback request is recorded: someone will call ${caller} back on ${phone}. Tell the caller, and ask whether there is anything else.`,
    };
  };

  return (
    <>
      <agent-tool
        name={name}
        handoff={{ kind: "handoff", afterFailures: afterFailures === false ? null : afterFailures }}
        description={
          "Hand the caller to a person. Call it when the caller asks to speak to a person (reason caller_requested), " +
          "or when you cannot help them: they keep repeating themselves, you cannot answer, or what they need is " +
          `not something you can do (reason agent_stuck). When someone is there, the caller hears your announcement, ` +
          `then a ringback while the phone rings (up to ${ring} seconds), and the person takes over. Otherwise you ` +
          "are told to offer a callback."
        }
        inputSchema={{
          type: "object",
          properties: {
            reason: { type: "string", enum: ["caller_requested", "agent_stuck"] },
            summary: {
              type: "string",
              description:
                "For the person taking over: who the caller is and what they want, what you already collected, and why you hand over. Two or three sentences.",
            },
            announce: {
              type: "string",
              description:
                'The one sentence you say to the caller before connecting them, in their language, for example "One moment, I am connecting you to a colleague."',
            },
          },
          required: ["reason", "summary", "announce"],
          additionalProperties: false,
        }}
        onCall={handOff}
      />
      {open === null ? null : (
        <agent-tool
          name={callbackName}
          handoff={{ kind: "callback" }}
          description="Record the caller's callback request, once they gave their name and agreed on the number to call back on."
          inputSchema={{
            type: "object",
            properties: {
              name: { type: "string", description: "The caller's name, as they gave it." },
              phone: {
                type: "string",
                description: "The number to call back on, international format. Leave it out on a phone call to use the number they call from.",
              },
            },
            required: ["name"],
            additionalProperties: false,
          }}
          onCall={requestCallback}
        />
      )}
    </>
  );
}

/** Why a transfer did not reach anyone, in words the model can pass on. */
function unreached(outcome: TransferOutcome): string {
  switch (outcome.outcome) {
    case "no_answer":
      return "Nobody answered.";
    case "busy":
      return "The line was busy.";
    case "refused":
      return outcome.code === "transfer_unsupported_session"
        ? "This is not a phone call, so it cannot be put through."
        : "The call could not be put through.";
    default:
      return "The call could not be put through.";
  }
}

/** A wrong prop is the author's to fix, before the model can ever call the tool. */
function checkProps(request: TransferCallRequest, hours: HandoffHours | undefined, afterFailures: number | false): void {
  try {
    transferPayload(request);
    checkHandoffHours(hours);
    if (afterFailures !== false && (!Number.isInteger(afterFailures) || afterFailures < 1 || afterFailures > MAX_AFTER_FAILURES)) {
      throw new TypeError(`afterFailures needs a whole number from 1 to ${MAX_AFTER_FAILURES}, or false; got ${JSON.stringify(afterFailures)}.`);
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: error.message,
      location: { component: "Handoff" },
      fix:
        'Pass to="+493012345678" (international format), hours={{ timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00" } }} ' +
        "or a function of the time, afterFailures from 1 to 10 or false, and ringTimeoutSeconds from 10 to 60.",
    });
  }
}
