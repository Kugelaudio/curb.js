/**
 * The LiveKit wire format between a client app and the agent participant.
 *
 * Plain LiveKit, so raw `livekit-client` and the native SDKs can speak it:
 *
 *   agent -> client   text stream on topic `curb.message`, body `{ key, id, payload }`
 *   client -> agent   RPC method `curb.message`, request `{ key, id, payload }`,
 *                     response `{ reply? }`
 *   client -> agent   RPC method `curb.update`, request a `SessionUpdate`, response the
 *                     `EffectiveSettings`
 *
 * A refusal is an RpcError whose `code` is one of {@link CLIENT_MESSAGE_RPC_ERRORS}, whose
 * `message` is the refusal name, and whose `data` (when present) is JSON:
 * `{ issues }` for `invalid_payload` / `invalid_settings`, `{ path }` for `not_adjustable`.
 *
 * Browser-safe and dependency-free: both the server bridge and `curb/client` import it.
 */

/** The text-stream topic of agent-to-client messages. */
export const CURB_MESSAGE_TOPIC = "curb.message";

/** The RPC method a client calls on the agent participant to send an app message. */
export const CURB_MESSAGE_RPC_METHOD = "curb.message";

/** The RPC method a client calls on the agent participant to change live settings. */
export const CURB_UPDATE_RPC_METHOD = "curb.update";

/** LiveKit's RPC request cap. A larger request is refused `payload_too_large`. */
export const MAX_CLIENT_MESSAGE_BYTES = 15 * 1024;

/**
 * The RpcError `code` for each refusal; its `message` is the refusal name. Application
 * range: LiveKit reserves 1001-1999 for its built-in errors.
 */
export const CLIENT_MESSAGE_RPC_ERRORS = {
  no_handler: 2001,
  invalid_payload: 2002,
  handler_failed: 2003,
  payload_too_large: 2004,
  not_adjustable: 2005,
  invalid_settings: 2006,
} as const;

export type ClientRefusalCode = keyof typeof CLIENT_MESSAGE_RPC_ERRORS;
