import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuthoringDiagnostic } from "../authoring.js";
import { serializeServerMessage, type ServerMessage } from "../server/protocol.js";

/** Why no agent server is serving, as the preview shows it. */
export type AgentUnavailable = { message: string; diagnostics: AuthoringDiagnostic[] };

/** Where the preview's port sends the agent's traffic. */
export type AgentTarget =
  /** An agent server is starting, or stopping for a reload: wait for the next one. */
  | { kind: "hold" }
  | { kind: "forward"; port: number }
  /** None is serving: pages are told why, and reconnect once one is. */
  | { kind: "unavailable"; unavailable: AgentUnavailable };

type HeldUpgrade = { request: IncomingMessage; socket: Duplex; head: Buffer };
type HeldRequest = { request: IncomingMessage; response: ServerResponse };

/**
 * The agent's side of `curb dev`'s preview port: every WebSocket but Vite's HMR, and the
 * agent's HTTP paths. They go to the agent server's own port while one serves, wait while
 * one starts, and get the reason while none can run. Restarting the agent server therefore
 * never closes the preview's port, so the page and its Vite connection stay up across a
 * reload and only the agent's WebSocket reconnects.
 */
export class AgentForwarder {
  private target: AgentTarget = { kind: "hold" };
  private readonly heldUpgrades = new Set<HeldUpgrade>();
  private readonly heldRequests = new Set<HeldRequest>();
  /** Answers the pages while no agent server can run. */
  private readonly fallback = new WebSocketServer({ noServer: true });

  constructor() {
    this.fallback.on("connection", (socket: WebSocket) => this.explainUnavailable(socket));
  }

  /**
   * Send the agent's traffic to `target` from now on. Leaving `unavailable`, the pages that
   * were shown why are told a reload is coming (`files`: what it is for) and reconnect.
   */
  setTarget(target: AgentTarget, files: readonly string[] = []): void {
    const previous = this.target;
    this.target = target;
    if (previous.kind === "unavailable" && target.kind !== "unavailable") {
      const frame = serializeServerMessage({ type: "dev_reload", state: "reloading", files: [...files] });
      for (const socket of this.fallback.clients) {
        socket.send(frame);
        socket.close(1012, "The agent is reloading.");
      }
    }
    if (target.kind === "unavailable") {
      const frame = serializeServerMessage({ type: "agent_unavailable", ...target.unavailable });
      for (const socket of this.fallback.clients) socket.send(frame);
    }
    if (target.kind === "hold") return;
    for (const held of [...this.heldUpgrades]) {
      this.heldUpgrades.delete(held);
      this.upgrade(held.request, held.socket, held.head);
    }
    for (const held of [...this.heldRequests]) {
      this.heldRequests.delete(held);
      this.request(held.request, held.response);
    }
  }

  /** A WebSocket upgrade for the agent: a page's chat and voice socket. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.target;
    if (target.kind === "forward") {
      forwardUpgrade(request, socket, head, target.port);
      return;
    }
    if (target.kind === "unavailable") {
      this.fallback.handleUpgrade(request, socket, head, (ws) => this.fallback.emit("connection", ws, request));
      return;
    }
    const held: HeldUpgrade = { request, socket, head };
    this.heldUpgrades.add(held);
    // A page that gives up waiting is not answered later.
    socket.once("close", () => this.heldUpgrades.delete(held));
  }

  /** An HTTP request on one of the agent's paths. */
  request(request: IncomingMessage, response: ServerResponse): void {
    const target = this.target;
    if (target.kind === "forward") {
      forwardRequest(request, response, target.port);
      return;
    }
    if (target.kind === "unavailable") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(`The agent is not running: ${target.unavailable.message}`);
      return;
    }
    const held: HeldRequest = { request, response };
    this.heldRequests.add(held);
    response.once("close", () => this.heldRequests.delete(held));
  }

  private explainUnavailable(socket: WebSocket): void {
    const target = this.target;
    if (target.kind !== "unavailable") {
      // Became available between the upgrade and now: reconnect to it.
      socket.close(1012, "The agent is reloading.");
      return;
    }
    const send = (message: ServerMessage) => socket.send(serializeServerMessage(message));
    send({ type: "agent_unavailable", ...target.unavailable });
    socket.on("message", () => {
      const current = this.target;
      const reason = current.kind === "unavailable" ? current.unavailable.message : "it is reloading";
      send({ type: "error", scope: "protocol", message: `The agent is not running: ${reason}` });
    });
  }
}

/**
 * Pipe an upgrade to the agent server at `port` as raw bytes: the request line and headers
 * as they came, then both directions. A WebSocket the agent server closes (a reload) closes
 * the page's, which reconnects.
 */
function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  const upstream = connect(port, "127.0.0.1");
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.once("connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", destroyBoth);
  upstream.on("close", destroyBoth);
  socket.on("error", destroyBoth);
  socket.on("close", destroyBoth);
}

function forwardRequest(request: IncomingMessage, response: ServerResponse, port: number): void {
  const upstream = httpRequest(
    { host: "127.0.0.1", port, method: request.method, path: request.url, headers: request.headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`The agent server did not answer: ${error.message}`);
  });
  request.pipe(upstream);
}
