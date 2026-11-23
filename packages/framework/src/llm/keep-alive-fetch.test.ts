import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Agent, type Dispatcher, getGlobalDispatcher, Pool, ProxyAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeepAliveFetch, keepAliveFetch, usesDefaultTransport } from "./keep-alive-fetch.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const servers: Server[] = [];
const NODE_DEFAULT_DISPATCHER = Symbol.for("curb.nodeDefaultDispatcher");
const recorded = globalThis as Record<symbol, unknown>;

// What bin/dispatcher-snapshot.js does as the CLI starts: this process's dispatcher is Node's.
beforeEach(() => {
  recorded[NODE_DEFAULT_DISPATCHER] = getGlobalDispatcher();
});

afterEach(async () => {
  delete recorded[NODE_DEFAULT_DISPATCHER];
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** An HTTP server that answers every request and records the client port and request target.
 * `keepAliveTimeout` is also the `Keep-Alive: timeout` hint it sends; 0 sends none. */
async function listen(keepAliveTimeout: number) {
  const ports: (number | undefined)[] = [];
  const targets: string[] = [];
  const server = createServer((req, res) => {
    ports.push(req.socket.remotePort);
    targets.push(req.url ?? "");
    res.end("ok");
  });
  server.keepAliveTimeout = keepAliveTimeout;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ports, targets };
}

async function get(fetch: typeof globalThis.fetch, url: string) {
  const response = await fetch(url);
  await response.text();
  return response.status;
}

describe("createKeepAliveFetch", () => {
  it("closes an idle connection when the server's hint is shorter than its own window", async () => {
    const server = await listen(3_000); // hint 3 s, which undici reads as 1 s
    const fetch = createKeepAliveFetch(30_000);
    await get(fetch, server.url);
    await sleep(1_500);
    await get(fetch, server.url);
    expect(server.ports[1]).not.toBe(server.ports[0]);
  });

  it("cuts a longer server hint to its own window", async () => {
    const server = await listen(120_000);
    const fetch = createKeepAliveFetch(1_000);
    await get(fetch, server.url);
    await sleep(300);
    await get(fetch, server.url);
    await sleep(1_500);
    await get(fetch, server.url);
    expect(server.ports[1]).toBe(server.ports[0]);
    expect(server.ports[2]).not.toBe(server.ports[1]);
  });

  it("sends requests through a proxy the application installed", async () => {
    const proxy = await listen(0);
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(new ProxyAgent({ uri: proxy.url, proxyTunnel: false }));
    try {
      expect(await get(keepAliveFetch, "http://model.test/v1/chat/completions")).toBe(200);
    } finally {
      setGlobalDispatcher(previous);
    }
    expect(proxy.targets).toEqual(["http://model.test/v1/chat/completions"]);
  });

  it("sends requests through the factory of an agent the application installed", async () => {
    const server = await listen(0);
    const origins: string[] = [];
    // Named like undici's own, which the dispatcher's identity tells apart.
    function defaultFactory(origin: string | URL, options: object): Dispatcher {
      origins.push(String(origin));
      return new Pool(origin, options);
    }
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ factory: defaultFactory }));
    try {
      expect(await get(keepAliveFetch, server.url)).toBe(200);
    } finally {
      setGlobalDispatcher(previous);
    }
    expect(origins).toEqual([server.url]);
  });
});

describe("usesDefaultTransport", () => {
  it("is true only while the global dispatcher is the one recorded as Node's", () => {
    const nodeDefault = getGlobalDispatcher();
    expect(usesDefaultTransport()).toBe(true);
    setGlobalDispatcher(new Agent());
    try {
      expect(usesDefaultTransport()).toBe(false);
    } finally {
      setGlobalDispatcher(nodeDefault);
    }
    expect(usesDefaultTransport()).toBe(true);
    delete recorded[NODE_DEFAULT_DISPATCHER];
    expect(usesDefaultTransport()).toBe(false);
  });
});

describe("bin/dispatcher-snapshot.js", () => {
  const snapshot = fileURLToPath(new URL("../../bin/dispatcher-snapshot.js", import.meta.url));
  const check = [
    `const node = globalThis[Symbol.for("curb.nodeDefaultDispatcher")];`,
    `process.stdout.write(String(node !== undefined && node === globalThis[Symbol.for("undici.globalDispatcher.1")]));`,
  ].join("\n");
  const run = (preloads: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, [...preloads.flatMap((url) => ["--import", url]), "--input-type=module", "-e", check], {
      encoding: "utf8",
      env: { ...process.env, NODE_USE_ENV_PROXY: undefined, ...env },
    });

  it("records Node's default dispatcher when nothing installed one first", () => {
    expect(run([snapshot])).toBe("true");
  });

  it("records nothing when a preload installed a dispatcher first", () => {
    const preload = `data:text/javascript,globalThis[Symbol.for("undici.globalDispatcher.1")] = { dispatch() {} };`;
    expect(run([preload, snapshot])).toBe("false");
  });

  it("records nothing when Node installed a proxy from the environment", () => {
    expect(run([snapshot], { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9" })).toBe("false");
  });
});
