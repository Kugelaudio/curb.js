/**
 * The `ws` client on the browser's own WebSocket, for the speech plugins (Kugel STT and TTS).
 *
 * Differences from `ws`, all forced by the browser: a browser socket sends no custom headers
 * (the dev relay adds the key), exposes no HTTP status on a refused upgrade (that is an
 * `error`, then a `close`), and has no pings (`ping()` answers `pong` while the socket is open;
 * the browser keeps the connection alive itself and reports a dead one as a `close`).
 * `WebSocketServer` accepts only what the worker's virtual HTTP server hands an `upgrade`
 * listener (`virtual-http.ts`): the page's WebSocket, carried on a `MessagePort`.
 */

import { EventEmitter } from "events";
import { Buffer } from "buffer/";
import { RoomPortSocket } from "../call-port.js";
import { BrowserUnavailableError } from "./unavailable.js";
import { UpgradeCarrier } from "./virtual-http.js";

type Data = string | ArrayBufferLike | ArrayBufferView;

class BrowserWs extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  private readonly socket: WebSocket;

  constructor(url: string | URL, protocols?: string | string[] | object, _options?: object) {
    super();
    const list = typeof protocols === "string" || Array.isArray(protocols) ? protocols : undefined;
    this.socket = new WebSocket(String(url), list);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => this.emit("open"));
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const binary = typeof event.data !== "string";
      this.emit("message", binary ? Buffer.from(event.data as ArrayBuffer) : Buffer.from(event.data as string), binary);
    });
    this.socket.addEventListener("error", () => {
      this.emit("error", new Error(`WebSocket ${String(url).replace(/api_key=[^&]*/, "api_key=***")} failed`));
    });
    this.socket.addEventListener("close", (event: CloseEvent) => this.emit("close", event.code, Buffer.from(event.reason)));
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: Data, options?: object | ((error?: Error) => void), callback?: (error?: Error) => void): void {
    const done = typeof options === "function" ? options : callback;
    try {
      this.socket.send(data as string | ArrayBuffer);
      done?.();
    } catch (error) {
      if (!done) throw error;
      done(error as Error);
    }
  }

  ping(): void {
    if (this.socket.readyState === WebSocket.OPEN) queueMicrotask(() => this.emit("pong"));
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.close();
  }
}

class WebSocketServer extends EventEmitter {
  readonly clients = new Set<RoomPortSocket>();

  constructor(options: { noServer?: boolean } = {}) {
    super();
    // A port to listen on: nothing in a page can.
    if (!options.noServer) throw new BrowserUnavailableError("ws.WebSocketServer({ port })");
  }

  handleUpgrade(_request: unknown, socket: unknown, _head: unknown, accepted: (socket: RoomPortSocket) => void): void {
    if (!(socket instanceof UpgradeCarrier)) throw new BrowserUnavailableError("ws.WebSocketServer.handleUpgrade on a network socket");
    const client = new RoomPortSocket(socket.port);
    this.clients.add(client);
    client.once("close", () => this.clients.delete(client));
    accepted(client);
  }

  close(done?: () => void): void {
    for (const client of this.clients) client.terminate();
    done?.();
  }
}

export default BrowserWs;
export { BrowserWs as WebSocket, WebSocketServer };
