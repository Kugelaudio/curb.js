/**
 * The native half of `@livekit/rtc-ffi-bindings` (LiveKit's Rust FFI). A page call never joins
 * a LiveKit room, so nothing should reach it; anything that does throws, naming the call. The
 * package's protobuf JS, which `@livekit/rtc-node` reads at load, stays real.
 */
import { BrowserUnavailableError } from "./unavailable.js";

const unavailable = (name: string) => () => {
  throw new BrowserUnavailableError(`@livekit/rtc-ffi-bindings.${name}`);
};

export class FfiHandle {
  constructor() {
    throw new BrowserUnavailableError("new @livekit/rtc-ffi-bindings.FfiHandle()");
  }
}
export const livekitCopyBuffer = unavailable("livekitCopyBuffer");
export const livekitDispose = unavailable("livekitDispose");
export const livekitFfiRequest = unavailable("livekitFfiRequest");
export const livekitInitialize = unavailable("livekitInitialize");
export const livekitRetrievePtr = unavailable("livekitRetrievePtr");
