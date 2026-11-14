import type { Attributes } from "@opentelemetry/api";

import { startCallTrace } from "../../call-spans.js";
import { attachCallTrace, type CallTrace } from "../../call-trace.js";
import type { AgentSessionBundle } from "../connection.js";
import type { VoiceSessionHandle, VoiceSessionStartOptions } from "./orchestration.js";

/**
 * Run a voice session as one trace (`../../call-spans.ts`): the call's span starts before the
 * session does and ends when the session has closed, however it closed. The trace is attached
 * to the call's runtime while the call runs, and moves with it on a rewind.
 */
export async function traceCall<Options extends Pick<VoiceSessionStartOptions, "bundle" | "onClosed" | "reporter">>(
  options: Options,
  start: (options: Options) => Promise<VoiceSessionHandle>,
): Promise<VoiceSessionHandle> {
  let bundle = options.bundle;
  const callTrace = startCallTrace(
    () => bundle.session.spanAttributes(),
    () => callAttributes(bundle),
    {
      // What a transfer came to is in the call's record too, with how long the caller waited
      // for it and the number it went to, so whoever reads the record can tell destinations
      // apart. That number is the author's own; it stays off the spans.
      transfer: (outcome, durationMs, to) =>
        options.reporter?.event("transfer", { outcome, ...(to ? { to } : {}) }, durationMs),
    },
  );
  attachCallTrace(bundle.runtime.info, callTrace);
  // A call that opens inside a skill is in it from its first moment.
  enterActiveSkill(callTrace, bundle);

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
    callTrace.fail(error);
    end();
    throw error;
  }
  return {
    ...handle,
    setBundle: (next) => {
      attachCallTrace(bundle.runtime.info, null);
      bundle = next;
      attachCallTrace(bundle.runtime.info, callTrace);
      // The rewound call is in the skill its new runtime is in, or in none.
      enterActiveSkill(callTrace, bundle);
      handle.setBundle(next);
    },
  };
}

/**
 * What the call's own span says about the call. The channel is known once the caller is: a
 * caller with a phone number is on a phone line. Never the number: that is the caller's data.
 */
function callAttributes(bundle: AgentSessionBundle): Attributes {
  const info = bundle.runtime.info.snapshot();
  const direction = info["call.direction"];
  const phoneNumber = info["caller.phoneNumber"];
  const onPhone = typeof phoneNumber === "string" && phoneNumber.trim() !== "";
  return {
    ...(typeof info["caller.identity"] === "string" ? { "curb.call.channel": onPhone ? "phone" : "web" } : {}),
    ...(typeof direction === "string" ? { "curb.call.direction": direction } : {}),
  };
}

/** Put the call's trace in the skill `bundle`'s runtime is in now, or in none. */
function enterActiveSkill(callTrace: CallTrace, bundle: AgentSessionBundle): void {
  const { path, title } = bundle.runtime.snapshot().context;
  callTrace.skill(path ? { action: "loaded", path, title } : { action: "exited", path: "", title: "" });
}
