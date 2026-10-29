/**
 * `node:http`'s server in the worker: the agent server (`server/main.ts`) creates one and
 * listens as it does under `curb dev`, but nothing binds a port. The page forwards the
 * preview's requests and WebSockets to the worker (`page.ts`), and the worker hands them to
 * this server (`dispatchRequest`, `dispatchUpgrade`), which emits them as Node does.
 */

import { Buffer } from "buffer/";
import { EventEmitter } from "events";

type Handler = (request: VirtualRequest, response: VirtualResponse) => void;

/** A request as the page sent it. */
export type ForwardedRequest = { method: string; url: string; headers: Record<string, string>; body: ArrayBuffer | null };
/** The answer the page turns into a `Response`. */
export type ForwardedResponse = { status: number; headers: Record<string, string>; body: ArrayBuffer };

/** The port this worker's server reports as bound (the page names each worker by it). */
const PORT = (globalThis as { __CURB_PORT__?: number }).__CURB_PORT__ ?? 1;

class VirtualRequest extends EventEmitter {
  readonly httpVersion = "1.1";
  readonly rawHeaders: string[];
  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: Record<string, string>,
    private readonly body: ArrayBuffer | null,
  ) {
    super();
    this.rawHeaders = Object.entries(headers).flat();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    if (this.body && this.body.byteLength > 0) yield Buffer.from(this.body);
  }
}

class VirtualResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  private readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  constructor(private readonly reply: (response: ForwardedResponse) => void) {
    super();
  }
  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk as Uint8Array));
    return true;
  }
  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    const body = Buffer.concat(this.chunks);
    this.reply({
      status: this.statusCode,
      headers: this.headers,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    this.emit("finish");
    this.emit("close");
    return this;
  }
}

/** What an `upgrade` listener gets as its socket: the page's end of the WebSocket, as a port.
 * `ws.ts`'s `WebSocketServer.handleUpgrade` accepts it; `end` refuses it with Node's text. */
export class UpgradeCarrier extends EventEmitter {
  constructor(readonly port: MessagePort) {
    super();
  }
  end(text = ""): void {
    const status = /^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? "400";
    this.port.postMessage({ close: { code: 4000 + Number(status), reason: text.split("\r\n\r\n")[1]?.trim() ?? "" } });
    this.port.close();
    this.emit("close");
  }
  destroy(): void {
    this.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
  }
}

export class VirtualServer extends EventEmitter {
  listening = false;
  constructor(private readonly handler: Handler | undefined) {
    super();
    if (handler) this.on("request", handler);
  }
  listen(...args: unknown[]): this {
    const done = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    queueMicrotask(() => {
      this.listening = true;
      current = this;
      this.emit("listening");
      done?.();
    });
    return this;
  }
  address() {
    return { port: PORT, address: "127.0.0.1", family: "IPv4" };
  }
  close(done?: () => void): this {
    this.listening = false;
    if (current === this) current = null;
    queueMicrotask(() => {
      this.emit("close");
      done?.();
    });
    return this;
  }
  closeAllConnections(): void {}
}

let current: VirtualServer | null = null;

function listening(): VirtualServer {
  if (!current) throw new Error("No agent server is listening in this worker.");
  return current;
}

export function createServer(...args: unknown[]): VirtualServer {
  return new VirtualServer(args.find((arg) => typeof arg === "function") as Handler | undefined);
}

export function dispatchRequest(request: ForwardedRequest, reply: (response: ForwardedResponse) => void): void {
  const incoming = new VirtualRequest(request.method, request.url, request.headers, request.body);
  listening().emit("request", incoming, new VirtualResponse(reply));
}

export function dispatchUpgrade(url: string, headers: Record<string, string>, port: MessagePort): void {
  const request = new VirtualRequest("GET", url, { ...headers, upgrade: "websocket", connection: "Upgrade" }, null);
  listening().emit("upgrade", request, new UpgradeCarrier(port), Buffer.alloc(0));
}
