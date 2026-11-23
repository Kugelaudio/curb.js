import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, getGlobalDispatcher, MockAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createKeepAliveFetch, keepAliveFetch, usesDefaultTransport } from "./keep-alive-fetch.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const servers: Server[] = [];

afterEach(async () => {
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
});

describe("usesDefaultTransport", () => {
  it("is true only for an agent nobody configured", () => {
    expect(usesDefaultTransport(undefined)).toBe(true);
    expect(usesDefaultTransport(new Agent())).toBe(true);
    expect(usesDefaultTransport(new Agent({ connect: { rejectUnauthorized: false } }))).toBe(false);
    expect(usesDefaultTransport(new Agent({ keepAliveTimeout: 1_000 }))).toBe(false);
    expect(usesDefaultTransport(new ProxyAgent("http://127.0.0.1:9"))).toBe(false);
    expect(usesDefaultTransport(new MockAgent())).toBe(false);
    expect(usesDefaultTransport({ dispatch() {} })).toBe(false);
  });

  it("is true for Node's own default dispatcher", async () => {
    await globalThis.fetch("http://127.0.0.1:9").catch(() => undefined);
    expect(usesDefaultTransport()).toBe(true);
  });
});
