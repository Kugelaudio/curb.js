/**
 * `pino` for `@livekit/agents`' logger: pino's own browser build, which writes to the console,
 * plus `multistream`, which that build lacks. The destination streams are not written: in the
 * page the console is where every log line goes.
 */
import browserPino from "pino/browser.js";

export const pino = browserPino;
export const multistream = (streams: unknown) => ({ streams });
export default browserPino;
