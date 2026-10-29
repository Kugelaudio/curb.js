// The browser builds of two polyfill packages, which ship no types of their own.

declare module "process/browser.js" {
  const process: {
    env: Record<string, string | undefined>;
    [key: string]: unknown;
  };
  export default process;
}

declare module "pino/browser.js" {
  import type pino from "pino";
  const browserPino: typeof pino;
  export default browserPino;
}
