import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerMessage } from "../server/protocol.js";
import { AgentForwarder } from "./dev-proxy.js";

/** Everything runs on 127.0.0.1 ports the OS picks: no network, nothing fixed. */
const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** A stand-in agent server: echoes WebSocket frames with the URL it was reached on, answers HTTP. */
async function agentServer(): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`agent answered ${req.method} ${req.url}`);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    socket.on("message", (data) => {
      // What a reloading agent server does to every page.
      if (String(data) === "reload") socket.close(1012, "The agent is reloading.");
      else socket.send(`echo ${request.url} ${String(data)}`);
    });
  });
  server.on("close", () => wss.close());
  return listen(server);
}

/** The preview's port: agent paths and every upgrade to the forwarder. */
async function previewPort(forwarder: AgentForwarder): Promise<number> {
  const server = createServer((req, res) => forwarder.request(req, res));
  server.on("upgrade", (request, socket, head) => forwarder.upgrade(request, socket, head));
  return listen(server);
}

function connect(port: number, path = "/"): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  sockets.push(socket);
  return socket;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(String(data))));
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

describe("AgentForwarder", () => {
  it("holds a page's socket while the agent server starts, then pipes it through, query and all", async () => {
    const forwarder = new AgentForwarder();
    const port = await previewPort(forwarder);
    const agentPort = await agentServer();

    const socket = connect(port, "/?resume=12");
    let opened = false;
    socket.once("open", () => {
      opened = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toBe(false);

    forwarder.setTarget({ kind: "forward", port: agentPort });
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send("hello");
    expect(await nextMessage(socket)).toBe("echo /?resume=12 hello");
  });

  it("closes the page's socket when the agent server's side closes, so the page reconnects", async () => {
    const forwarder = new AgentForwarder();
    const port = await previewPort(forwarder);
    const agentPort = await agentServer();
    forwarder.setTarget({ kind: "forward", port: agentPort });
    const socket = connect(port);
    await new Promise((resolve) => socket.once("open", resolve));

    const ended = closed(socket);
    socket.send("reload");
    expect(await ended).toBe(1012);
  });

  it("tells pages why the agent is not running, and to reconnect once a reload starts", async () => {
    const forwarder = new AgentForwarder();
    const port = await previewPort(forwarder);
    const unavailable = { message: "The agent did not load.", diagnostics: [] };
    forwarder.setTarget({ kind: "unavailable", unavailable });

    const socket = connect(port);
    const first = JSON.parse(await nextMessage(socket)) as ServerMessage;
    expect(first).toEqual({ type: "agent_unavailable", ...unavailable });

    socket.send(JSON.stringify({ type: "user_text", text: "hi" }));
    expect(JSON.parse(await nextMessage(socket))).toEqual({
      type: "error",
      scope: "protocol",
      message: "The agent is not running: The agent did not load.",
    });

    const reloading = nextMessage(socket);
    const ended = closed(socket);
    forwarder.setTarget({ kind: "hold" }, ["src/lib/helper.ts"]);
    expect(JSON.parse(await reloading)).toEqual({ type: "dev_reload", state: "reloading", files: ["src/lib/helper.ts"] });
    expect(await ended).toBe(1012);
  });

  it("forwards the agent's HTTP paths, holds them while it starts, and answers 503 while it cannot run", async () => {
    const forwarder = new AgentForwarder();
    const port = await previewPort(forwarder);
    const agentPort = await agentServer();

    const held = fetch(`http://127.0.0.1:${port}/voice/clip?room=r`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    forwarder.setTarget({ kind: "forward", port: agentPort });
    expect(await (await held).text()).toBe("agent answered GET /voice/clip?room=r");

    const posted = await fetch(`http://127.0.0.1:${port}/tts`, { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(await posted.text()).toBe("agent answered POST /tts");

    forwarder.setTarget({ kind: "unavailable", unavailable: { message: "It crashed.", diagnostics: [] } });
    const refused = await fetch(`http://127.0.0.1:${port}/tts`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("The agent is not running: It crashed.");
  });
});
