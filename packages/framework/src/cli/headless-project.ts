import type { AuthoringDiagnostic } from "../authoring.js";

/**
 * What `curb say` and `curb test` share to run the project's agent headlessly, on the bundle
 * path a call uses: recording off, the boot's diagnostic lines condensed into one note, and
 * the agent's own logs kept off stdout (which carries the result).
 */

/**
 * Turn conversation recording off for this process. A headless run keeps its own record
 * (`.curb/say-session.json`, the test report), and recording it would store a new partial
 * copy of the conversation on every turn.
 */
export async function disableConversationRecording(): Promise<void> {
  const { CONVERSATION_SINK_MODULE_ENV } = await import("../server/conversation-store.js");
  process.env.KUGEL_CONVERSATIONS_DB = "off";
  delete process.env[CONVERSATION_SINK_MODULE_ENV];
}

/** One line for the agent's authoring diagnostics, which a server boot logs one by one; null
 * when there are none. */
export function diagnosticsNote(diagnostics: readonly AuthoringDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return `The agent has ${errors} authoring error(s) and ${diagnostics.length - errors} warning(s); curb check lists them.`;
}

/** Drop the "[agent:<id>] <diagnostic>" lines a host logs when it loads the agent, until the
 * returned function is called; everything else still reaches the console. */
export function dropDiagnosticLogs(): () => void {
  const { warn, error } = console;
  const filtered =
    (log: (...values: unknown[]) => void) =>
    (...values: unknown[]) => {
      if (typeof values[0] === "string" && values[0].startsWith("[agent:")) return;
      log(...values);
    };
  console.warn = filtered(warn);
  console.error = filtered(error);
  return () => {
    console.warn = warn;
    console.error = error;
  };
}

/** Send console.log/info/debug to stderr until the returned function is called. */
export function routeConsoleToStderr(): () => void {
  const { log, info, debug } = console;
  const toStderr = (...values: unknown[]) => console.error(...values);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = log;
    console.info = info;
    console.debug = debug;
  };
}
