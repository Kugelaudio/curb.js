/**
 * A Node built-in the browser runtime cannot provide (`fs`, `child_process`, `net`, ...).
 *
 * Importing it works, so a module that only mentions it at load still loads; calling into it
 * throws, naming the call, so a code path that really needs it fails where it runs instead of
 * returning something empty.
 */

export class BrowserUnavailableError extends Error {
  readonly code = "CURB_BROWSER_UNAVAILABLE";
  constructor(what: string) {
    super(`${what} is not available in the browser runtime: this code path needs Node.`);
    this.name = "BrowserUnavailableError";
  }
}

/** Keys a bundler's interop or a thenable check reads on any module: never a Node API. */
const INTEROP_KEYS = new Set(["__esModule", "then", "default", "toJSON"]);

function unavailableValue(path: string): unknown {
  const fail = function () {
    throw new BrowserUnavailableError(path);
  };
  return new Proxy(fail, {
    get(target, key) {
      // A real prototype, so `class X extends http.Agent` loads; constructing one still throws.
      if (key === "prototype") return target.prototype;
      if (typeof key === "symbol" || INTEROP_KEYS.has(key)) return undefined;
      return unavailableValue(`${path}.${key}`);
    },
    apply() {
      throw new BrowserUnavailableError(`${path}()`);
    },
    construct() {
      throw new BrowserUnavailableError(`new ${path}()`);
    },
  });
}

export function unavailableModule(name: string): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (key === "__esModule") return false;
      if (typeof key === "symbol" || INTEROP_KEYS.has(key)) return undefined;
      return unavailableValue(`node:${name}.${key}`);
    },
  });
}
