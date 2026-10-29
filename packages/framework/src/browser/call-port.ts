/**
 * The two ends of a WebSocket over a `MessagePort` between the dev page and the agent's
 * worker, for every socket the preview opens to the agent (its conversation and a local
 * call's audio): the worker's end is what the agent server reads off a `ws` socket, the
 * page's what the preview reads off a browser WebSocket. Binary frames cross as transferred
 * `ArrayBuffer`s, text frames as strings.
 */

import { Buffer } from "buffer/";
import { EventEmitter } from "events";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type PortMessage = { data: string | ArrayBuffer } | { close: { code: number; reason: string } };

function post(port: MessagePort, data: string | ArrayBufferLike | ArrayBufferView): void {
  if (typeof data === "string") return port.postMessage({ data } satisfies PortMessage);
  const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
  const copy = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
  port.postMessage({ data: copy } satisfies PortMessage, [copy]);
}

/** The worker's end, `ws`-shaped. */
export class RoomPortSocket extends EventEmitter {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readyState = OPEN;

  constructor(private readonly port: MessagePort) {
    super();
    // Accepted: the page's end opens.
    port.postMessage({ accepted: true });
    port.onmessage = (event: MessageEvent<PortMessage>) => {
      const message = event.data;
      if ("close" in message) return this.closed(message.close.code, message.close.reason);
      const binary = typeof message.data !== "string";
      this.emit("message", binary ? Buffer.from(message.data as ArrayBuffer) : Buffer.from(message.data as string), binary);
    };
  }

  send(data: Buffer | string, _options?: { binary?: boolean }): void {
    if (this.readyState === OPEN) post(this.port, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED) return;
    this.port.postMessage({ close: { code, reason } } satisfies PortMessage);
    this.closed(code, reason);
  }

  /** `ws`'s abrupt close: 1006, as the page sees a dropped connection. */
  terminate(): void {
    this.close(1006, "");
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", code, Buffer.from(reason));
    this.port.close();
  }
}

type Listener = ((event: Event) => void) | null;

/** The page's end, browser-WebSocket-shaped, `on*` handlers included. It opens once the
 * worker's server accepted it (its first message), or closes with the refusal. */
export class PagePortSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readyState = CONNECTING;
  binaryType: BinaryType = "blob";
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;

  constructor(
    private readonly port: MessagePort,
    readonly url: string,
  ) {
    super();
    port.onmessage = (event: MessageEvent<PortMessage | { accepted: true }>) => {
      const message = event.data;
      if ("accepted" in message) {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        return this.fire(new Event("open"));
      }
      if ("close" in message) return this.closed(message.close.code, message.close.reason);
      if (this.readyState === OPEN) this.fire(new MessageEvent("message", { data: message.data }));
    };
  }

  /**
   * The worker is gone. After a clean exit (a reload) the socket closes as the agent server
   * closes its sockets, 1012, which can reach the page after the exit does; after a crash or
   * a kill the connection dropped.
   */
  workerGone(clean: boolean): void {
    if (this.readyState === CLOSED) return;
    if (clean) return this.closed(1012, "The agent is reloading.");
    this.fire(new Event("error"));
    this.closed(1006, "");
  }

  private fire(event: Event): void {
    this.dispatchEvent(event);
    const handler = (this as unknown as Record<string, Listener>)[`on${event.type}`];
    handler?.call(this, event);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState === OPEN) post(this.port, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED) return;
    this.port.postMessage({ close: { code, reason } } satisfies PortMessage);
    this.closed(code, reason);
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.fire(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
    this.port.close();
  }
}
