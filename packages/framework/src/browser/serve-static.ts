/**
 * Serves the browser dev environment `static-build.ts` wrote, as any static host would, plus a
 * relay to the KugelAudio API: the only part that is not a file. Nothing here runs the agent,
 * compiles or keeps a project; the page does all of that.
 *
 * The relay exists because the API answers no CORS and a browser WebSocket cannot send an
 * Authorization header (HTTP and WebSocket both go to `/kugel/*`). It adds
 * `KUGELAUDIO_API_KEY` from this process's environment on the way out, so the key never
 * reaches the page. Development only.
 *
 * Usage: tsx src/browser/serve-static.ts <built dir> [port]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const UPSTREAM = "https://api.eu.kugelaudio.com";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4630);
const apiKey = process.env.KUGELAUDIO_API_KEY;
if (!apiKey) throw new Error("serve-static: KUGELAUDIO_API_KEY is not set; the relay has no key to add.");

function send(res: ServerResponse, file: string): void {
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.end(readFileSync(file));
}

async function relay(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  for (const name of ["content-type", "accept"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const target = UPSTREAM + url.pathname.slice("/kugel".length) + url.search;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    console.log(`[relay] ${req.method} ${url.pathname} -> ${upstream.status}`);
    res.statusCode = upstream.status;
    const type = upstream.headers.get("content-type");
    if (type) res.setHeader("Content-Type", type);
    if (!upstream.body) return void res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    console.error(`[relay] ${req.method} ${url.pathname} failed: ${(error as Error).message}`);
    res.statusCode = 502;
    res.end((error as Error).message);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/kugel/")) return void relay(req, res, url);
  const file = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
  // The preview routes skills by path (`/claim-procedure`): a path with no file is the app.
  if (!extname(url.pathname) && !existsSync(file)) return send(res, join(root, "index.html"));
  return send(res, statSync(file, { throwIfNoEntry: false })?.isDirectory() ? join(file, "index.html") : file);
});

/** Close codes a browser may send; the rest become 1011. */
const closable = (code: number) => (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011);
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/kugel/")) return void socket.destroy();
  const path = url.pathname.slice("/kugel".length);
  // The TTS socket names its key in the query: the page's is a placeholder.
  if (url.searchParams.has("api_key")) url.searchParams.set("api_key", apiKey);
  sockets.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(`wss://api.eu.kugelaudio.com${path}${url.search}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const queue: Array<[Buffer, boolean]> = [];
    upstream.on("open", () => {
      console.log(`[relay] ws ${path} open`);
      for (const [data, binary] of queue.splice(0)) upstream.send(data, { binary });
    });
    client.on("message", (data: Buffer, binary) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary }) : queue.push([data, binary]),
    );
    upstream.on("message", (data: Buffer, binary) => client.readyState === WebSocket.OPEN && client.send(data, { binary }));
    upstream.on("close", (code) => client.readyState === WebSocket.OPEN && client.close(closable(code)));
    client.on("close", () => upstream.readyState <= WebSocket.OPEN && upstream.close());
    upstream.on("unexpected-response", (_request, response) => {
      console.error(`[relay] ws ${path} refused: HTTP ${response.statusCode}`);
      client.close(1011, `upstream HTTP ${response.statusCode}`);
    });
    upstream.on("error", (error) => {
      console.error(`[relay] ws ${path} failed: ${error.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011);
    });
  });
});

if (!existsSync(join(root, "runtime", "page.js"))) {
  throw new Error(`serve-static: ${root} is not a built browser dev environment (run static-build.ts first).`);
}
server.listen(port, "127.0.0.1", () => console.log(`curb in the browser: http://127.0.0.1:${port}/ (static files from ${root})`));
