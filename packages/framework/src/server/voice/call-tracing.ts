import { attachCallTrace, startCallTrace } from "../../call-trace.js";
import type { VoiceSessionHandle, VoiceSessionStartOptions } from "./orchestration.js";

/**
 * Run a voice session as one trace (`../../call-trace.ts`): the call's span starts before the
 * session does and ends when the session has closed, however it closed. The trace is attached
 * to the call's runtime while the call runs, and moves with it on a rewind.
 */
export async function traceCall<Options extends Pick<VoiceSessionStartOptions, "bundle" | "onClosed">>(
  options: Options,
  start: (options: Options) => Promise<VoiceSessionHandle>,
): Promise<VoiceSessionHandle> {
  let bundle = options.bundle;
  const info = bundle.runtime.info.snapshot();
  const direction = info["call.direction"];
  const phoneNumber = info["caller.phoneNumber"];
  const callTrace = startCallTrace(() => bundle.session.spanAttributes(), {
    // Whether the caller is on a phone line. Never the number: that is the caller's data.
    "curb.call.channel": typeof phoneNumber === "string" && phoneNumber.trim() !== "" ? "phone" : "web",
    ...(typeof direction === "string" ? { "curb.call.direction": direction } : {}),
  });
  attachCallTrace(bundle.runtime.info, callTrace);
  // A call that opens inside a skill is in it from its first moment.
  const { path, title } = bundle.runtime.snapshot().context;
  if (path) callTrace.skill({ action: "loaded", path, title });

  const end = () => {
    attachCallTrace(bundle.runtime.info, null);
    callTrace.end();
  };
  let handle: VoiceSessionHandle;
  try {
    handle = await callTrace.run(() =>
      start({
        ...options,
        onClosed: () => {
          end();
          options.onClosed?.();
        },
      }),
    );
  } catch (error) {
    end();
    throw error;
  }
  return {
    ...handle,
    setBundle: (next) => {
      attachCallTrace(bundle.runtime.info, null);
      bundle = next;
      attachCallTrace(bundle.runtime.info, callTrace);
      handle.setBundle(next);
    },
  };
}
