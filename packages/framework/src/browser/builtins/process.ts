/**
 * `process` in the browser runtime: the `process` package, with `env` taken from what the page
 * set on `globalThis.__CURB_ENV__` before loading the bundle (keys stay with the page; nothing
 * is baked into the bundle). esbuild injects this wherever code names `process`.
 */
import polyfill from "process/browser.js";

const env = (globalThis as { __CURB_ENV__?: Record<string, string> }).__CURB_ENV__ ?? {};
Object.assign(polyfill.env, env);

/** stdout/stderr write to the console: what a host logs there is the page's log. */
function consoleStream(log: (text: string) => void) {
  return {
    isTTY: false,
    columns: 120,
    write(chunk: unknown) {
      log(String(chunk).replace(/\n$/, ""));
      return true;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
  };
}
/** `process.hrtime` in nanoseconds, from the page's monotonic clock (microsecond resolution). */
const hrtime = Object.assign(
  (previous?: [number, number]) => {
    const ns = Math.round(performance.now() * 1e6);
    const now: [number, number] = [Math.floor(ns / 1e9), ns % 1e9];
    if (!previous) return now;
    const delta = (now[0] - previous[0]) * 1e9 + (now[1] - previous[1]);
    return [Math.floor(delta / 1e9), delta % 1e9];
  },
  { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
);

Object.assign(polyfill, {
  hrtime,
  stdout: consoleStream((text) => console.log(text)),
  stderr: consoleStream((text) => console.warn(text)),
  exitCode: undefined,
});
(globalThis as { process?: unknown }).process ??= polyfill;

export { polyfill as process };
