/**
 * What a call on a speech-to-speech model puts in its record: one turn per caller turn and one per
 * line of the model's, as a cascaded call reports one per final transcript and one per reply.
 *
 * The model sends the caller's line in parts, cut at their pauses, and may send the whole line
 * again each time it grows. So a caller's turn is reported once it is over, when the model speaks
 * or the call ends, as the line those parts make (`heard-line.ts`). Tool calls are reported by the
 * back office, through the same path as a cascaded call's (`../turn-report.ts`).
 */

import type { CallReporter } from "../../../hosted/call-reporter.js";
import { joinHeardLine } from "../../../heard-line.js";

export type S2sCallRecord = {
  /** A part of the caller's line, as the model transcribed it. */
  callerSaid(text: string): void;
  /** A line the model said, or the opening line it is asked to say: the caller's turn is over. */
  agentSaid(text: string): void;
  /** The call ended: a caller's turn still open is reported. */
  close(): void;
};

export function createS2sCallRecord(reporter: CallReporter | undefined): S2sCallRecord {
  let callerLine: string | null = null;
  const endCallerTurn = () => {
    if (callerLine !== null) reporter?.turn({ speaker: "caller", text: callerLine, final: true });
    callerLine = null;
  };
  return {
    callerSaid(text) {
      callerLine = callerLine === null ? text : joinHeardLine(callerLine, text);
    },
    agentSaid(text) {
      endCallerTurn();
      reporter?.turn({ speaker: "agent", text, final: true });
    },
    close: endCallerTurn,
  };
}
