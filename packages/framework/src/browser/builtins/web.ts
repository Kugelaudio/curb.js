/**
 * Node built-ins the browser has its own version of, re-exported under Node's names.
 * One export per module; `browser-build.ts` maps `node:<name>` to the matching one.
 */

import { BrowserUnavailableError } from "./unavailable.js";

export const streamWeb = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
  TextEncoderStream: globalThis.TextEncoderStream,
  TextDecoderStream: globalThis.TextDecoderStream,
  ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
  WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
  ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
  CountQueuingStrategy: globalThis.CountQueuingStrategy,
};

export const timersPromises = {
  setTimeout: <T>(ms?: number, value?: T, options?: { signal?: AbortSignal }) =>
    new Promise<T | undefined>((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const timer = globalThis.setTimeout(() => resolve(value), ms ?? 0);
      signal?.addEventListener("abort", () => {
        globalThis.clearTimeout(timer);
        reject(signal.reason);
      });
    }),
  setImmediate: <T>(value?: T) => new Promise<T | undefined>((resolve) => globalThis.setTimeout(() => resolve(value), 0)),
};

export const timers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => globalThis.setTimeout(fn, 0, ...args),
  clearImmediate: (id: number) => globalThis.clearTimeout(id),
  promises: timersPromises,
};

export const perfHooks = { performance: globalThis.performance };

/**
 * `AsyncLocalStorage` holds its store for the synchronous part of `run` only: the browser has
 * no async context propagation (the TC39 proposal is not shipped). Enough for code that reads
 * the store where it set it; a read after an `await` gets the outer store.
 */
class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore(): T | undefined {
    return this.store;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = store;
    try {
      return fn(...args);
    } finally {
      this.store = previous;
    }
  }
  enterWith(store: T): void {
    this.store = store;
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return this.run(undefined as T, fn, ...args);
  }
  disable(): void {
    this.store = undefined;
  }
}

export const asyncHooks = {
  AsyncLocalStorage,
  AsyncResource: class {
    static bind<F>(fn: F): F {
      return fn;
    }
    runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
      return fn.apply(thisArg, args);
    }
  },
  createHook: () => ({ enable() {}, disable() {} }),
  executionAsyncId: () => 0,
  triggerAsyncId: () => 0,
};

export const crypto = {
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto.subtle,
  randomUUID: () => globalThis.crypto.randomUUID(),
  getRandomValues: <T extends ArrayBufferView>(array: T) => globalThis.crypto.getRandomValues(array as never) as T,
  randomBytes: (size: number) => {
    const bytes = new Uint8Array(size);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
  randomInt: (min: number, max?: number) => {
    const [low, high] = max === undefined ? [0, min] : [min, max];
    return low + Math.floor(Math.random() * (high - low));
  },
  createHash: () => {
    throw new BrowserUnavailableError("node:crypto.createHash");
  },
  createHmac: () => {
    throw new BrowserUnavailableError("node:crypto.createHmac");
  },
};

export const url = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath: (value: string | URL) => {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "file:") throw new TypeError(`The URL must be of scheme file: ${String(value)}`);
    return decodeURIComponent(parsed.pathname);
  },
  pathToFileURL: (path: string) => new URL(`file://${encodeURI(path)}`),
};

export const os = {
  EOL: "\n",
  platform: () => "browser",
  type: () => "Browser",
  arch: () => "wasm",
  release: () => "",
  hostname: () => "browser",
  homedir: () => "/",
  tmpdir: () => "/tmp",
  cpus: () => [],
  totalmem: () => 0,
  freemem: () => 0,
  networkInterfaces: () => ({}),
  userInfo: () => ({ username: "browser", homedir: "/", shell: null, uid: -1, gid: -1 }),
};

/** `createRequire` hands back a `require` that throws when called: modules build one at load
 * (to resolve a package path, a native binding) and only fail if a code path really uses it. */
export const module = {
  builtinModules: [] as string[],
  createRequire: (from: string | URL) => {
    const require = (id: string) => {
      throw new BrowserUnavailableError(`require(${JSON.stringify(id)}) from ${String(from)}`);
    };
    require.resolve = (id: string) => {
      throw new BrowserUnavailableError(`require.resolve(${JSON.stringify(id)}) from ${String(from)}`);
    };
    return require;
  },
  register: () => {
    throw new BrowserUnavailableError("node:module.register");
  },
};

/** The page has no terminal. */
export const tty = {
  isatty: () => false,
  ReadStream: class {
    constructor() {
      throw new BrowserUnavailableError("new node:tty.ReadStream()");
    }
  },
  WriteStream: class {
    constructor() {
      throw new BrowserUnavailableError("new node:tty.WriteStream()");
    }
  },
};
