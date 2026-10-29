import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Credentials } from "./credentials.js";

/**
 * One local HTTP server standing in for the web app, the agent platform, Supabase Auth and
 * the object store, for the cloud-command tests. Routes are `"METHOD /path"` (query
 * stripped); every request is recorded with its headers and raw body.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: () => unknown;
}

export type Reply = { status?: number; body?: unknown };
export type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeCloud {
  url: string;
  requests: RecordedRequest[];
  route: (key: string, handler: Handler | Reply) => void;
  close: () => Promise<void>;
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const routes = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = Buffer.concat(chunks);
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json: () => JSON.parse(body.toString("utf8")),
      };
      requests.push(recorded);
      const handler = routes.get(`${recorded.method} ${recorded.path}`);
      const reply = handler ? await handler(recorded) : { status: 404, body: { code: "not_found", message: `no fake route ${recorded.method} ${recorded.path}` } };
      const status = reply.status ?? 200;
      if (reply.body === undefined) {
        res.writeHead(status).end();
      } else {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    route: (key, handler) => routes.set(key, typeof handler === "function" ? handler : () => handler),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Replies from a list in order, repeating the last one. */
export function sequence(...replies: Reply[]): Handler {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)];
}

export function fakeCredentials(url: string, overrides: Partial<Credentials> = {}): Credentials {
  return {
    webUrl: url,
    platformApiUrl: url,
    supabaseUrl: url,
    supabaseAnonKey: "anon-key",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "user-1", email: "dev@example.com" },
    ...overrides,
  };
}
