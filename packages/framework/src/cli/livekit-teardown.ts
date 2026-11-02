/**
 * How many teardown faults `curb dev` will absorb before giving up. A handful
 * per session is the known LiveKit disconnect race; a stream of them is a real
 * fault wearing its costume, and swallowing those forever would be worse than
 * crashing.
 */
const MAX_SURVIVED_TEARDOWN_FAULTS = 20;

/**
 * Is this the LiveKit room-teardown race, and nothing else?
 *
 * When a call ends, `rtc-node`'s `Room.cleanupOnDisconnect` aborts its pending
 * work; the AbortError surfaces from an FFI event handler, so it belongs to no
 * await chain any of our code owns and reaches the process as an uncaught
 * fault. Matching on the name ALONE would swallow every legitimate abort in the
 * process, so the stack must implicate LiveKit too.
 */
export function isLivekitTeardownFault(error: unknown): boolean {
  const fault = error as { name?: unknown; message?: unknown; stack?: unknown };
  const name = typeof fault?.name === "string" ? fault.name : "";
  const message = typeof fault?.message === "string" ? fault.message : "";
  const stack = typeof fault?.stack === "string" ? fault.stack : "";
  if (name !== "AbortError" && !message.includes("engine is closed")) return false;
  return /rtc-node|@livekit\/agents/.test(stack);
}

/**
 * Keep the dev server up across call teardown.
 *
 * A preview server that dies when a call ends is worse than useless: the crash
 * lands AFTER the conversation is over, so the thing you were testing looks
 * fine and the next click hits a dead port. Only the teardown race above is
 * absorbed, it is counted and logged every time, and anything else still exits
 * non-zero exactly as before — this buys uptime, not silence.
 *
 * `dev` only. `check` and `build` are gates: a gate that survives a fault it
 * cannot explain is a gate that passes broken code.
 */
export function surviveLivekitTeardown(): void {
  let survived = 0;
  const absorb = (source: string, error: unknown): void => {
    if (!isLivekitTeardownFault(error) || survived >= MAX_SURVIVED_TEARDOWN_FAULTS) {
      console.error(
        survived >= MAX_SURVIVED_TEARDOWN_FAULTS
          ? `curb dev: ${survived} LiveKit teardown faults absorbed: this is not a race any more.`
          : error,
      );
      process.exit(1);
    }
    survived += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `curb dev: absorbed a LiveKit teardown fault from ${source} (${survived}/${MAX_SURVIVED_TEARDOWN_FAULTS}): ${detail}`,
    );
  };
  process.on("uncaughtException", (error) => absorb("uncaughtException", error));
  process.on("unhandledRejection", (reason) => absorb("unhandledRejection", reason));
}
