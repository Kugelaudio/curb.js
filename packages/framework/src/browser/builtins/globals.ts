/**
 * Node's globals in the browser bundle. esbuild injects this module wherever code names one of
 * these exports without importing it.
 */
import { Buffer } from "buffer/";
import { process } from "./process.js";

const setImmediate = (fn: (...args: unknown[]) => void, ...args: unknown[]) => globalThis.setTimeout(fn, 0, ...args);
const clearImmediate = (id: number) => globalThis.clearTimeout(id);

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

export { Buffer, process, setImmediate, clearImmediate };
