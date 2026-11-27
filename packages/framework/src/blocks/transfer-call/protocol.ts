/**
 * What a transfer says over the host channel, shared by the cold transfer (`index.tsx`) and the
 * warm one (`warm.ts`). See `docs/agent-guide/host-protocol.md`, "Call transfer".
 */

/** Agent to host: dial the target into the call's room. */
export const CALL_TRANSFER_MESSAGE = "call.transfer";
/** Agent to host: dial the target into a consultation room first. Answered like `call.transfer`,
 * with the consultation room's ticket in the acceptance. */
export const CALL_TRANSFER_WARM_MESSAGE = "call.transfer.warm";
/** Agent to host: what the consultation decided. */
export const CALL_TRANSFER_DECIDE_MESSAGE = "call.transfer.decide";
/** Host to agent: what became of the dial. */
export const CALL_TRANSFER_RESULT_MESSAGE = "call.transfer.result";

/** How long the platform may take to accept or refuse a transfer (one collector pass). */
export const TRANSFER_REPLY_TIMEOUT_MS = 20_000;
/** The ring time the platform uses when the request names none. */
export const DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS = 30;
/** How long after the ring time ends the result may take to arrive. */
export const TRANSFER_RESULT_MARGIN_MS = 30_000;

export const PHONE_CALLS_ONLY =
  "Call transfer works on phone calls only: this session has no phone caller " +
  "(a browser session, an API session or the curb dev preview).";

/** The refusal in a host's reply, with a message a developer can act on; null when it accepted. */
export function readRefusal(reply: Record<string, unknown>): { code: string; message: string } | null {
  if (typeof reply.code !== "string") return null;
  const platformMessage = typeof reply.message === "string" ? reply.message : "";
  if (reply.code === "upgrade_required") {
    const feature = typeof reply.feature === "string" ? reply.feature : "outbound-calls";
    return {
      code: reply.code,
      message: `Call transfer needs a paid plan (plan feature ${feature}).${platformMessage ? ` ${platformMessage}` : ""}`,
    };
  }
  if (reply.code === "transfer_unsupported_session") {
    return {
      code: reply.code,
      message: platformMessage ? `${PHONE_CALLS_ONLY} ${platformMessage}` : PHONE_CALLS_ONLY,
    };
  }
  return {
    code: reply.code,
    message: platformMessage || `the host refused the transfer with ${reply.code}.`,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
