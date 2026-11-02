import { WebSocketServer, type WebSocket } from "ws";

/**
 * A scripted server on the OpenAI Live client-delegation protocol: no model, no key. The model owns the call, so a test plays it: `callerSays` is what it heard (and
 * whether it delegated), `say` what it speaks. It says every commentary, as a report.
 */
export async function startFakeLiveModel(options: { greeting?: string; drops?: boolean } = {}) {
  const received: Array<Record<string, any>> = [];
  const authorization: Array<string | undefined> = [];
  let socket: WebSocket | null = null;
  let appendedBytes = 0;
  let counter = 0;
  let clockMs = 0;
  const id = (prefix: string) => `${prefix}_${(counter += 1)}`;
  const send = (event: Record<string, unknown>) => {
    if (socket?.readyState === socket?.OPEN) socket?.send(JSON.stringify({ event_id: id("evt"), ...event }));
  };
  const resource = (session: Record<string, any>) => ({
    id: "sess_1",
    expires_at: 4102444800,
    model: "gpt-live-1",
    status: "active",
    audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: session.audio?.output?.voice ?? "marin" } },
    delegation: { type: "client" },
    instructions: session.instructions,
    store: false,
    input: [],
  });

  const transcript = (type: string, delta: string, ms: number) => {
    send({ type, delta, start_ms: clockMs, end_ms: clockMs + ms });
    clockMs += ms;
  };
  const say = async (text: string, wordMs = 30) => {
    // A pause longer than LiveKit's 800 ms: this is a new line, not the last one going on.
    clockMs += 1000;
    for (const word of text.split(" ")) {
      transcript("session.output_transcript.delta", `${word} `, wordMs);
      const samples = new Int16Array(24 * wordMs);
      samples.fill(4000);
      send({ type: "session.output_audio.delta", delta: Buffer.from(samples.buffer).toString("base64") });
      await new Promise((resolve) => setTimeout(resolve, wordMs));
    }
  };

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (client, request) => {
    socket = client;
    authorization.push(request.headers.authorization);
    client.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Record<string, any>;
      if (event.type === "session.input_audio.append") {
        appendedBytes += Buffer.from(event.audio as string, "base64").length;
        return;
      }
      received.push(event);
      if (event.type === "session.start") {
        send({ type: "session.started", session: resource(event.session), client_event_id: event.event_id });
        if (options.greeting) void say(options.greeting);
        if (options.drops) {
          send({ type: "error", error: { code: "connection_lost", message: "lost", type: "server_error" } });
          send({ type: "session.closed", reason: "connection_lost", session: resource({}), usage: { seconds: 0 } });
        }
      }
      if (event.type === "session.commentary.append") {
        send({ type: "session.commentary.appended", start_ms: clockMs, end_ms: clockMs, client_event_id: event.event_id });
        void say(event.content as string);
      }
      if (event.type === "session.close") {
        send({ type: "session.closed", reason: "close_requested", session: resource({}), usage: { seconds: 1 } });
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    received,
    authorization,
    appendedBytes: () => appendedBytes,
    say,
    /** The caller's words reached the model; `delegate` hands the turn to the client. */
    callerSays(text: string, { delegate = false } = {}) {
      clockMs += 1000;
      transcript("session.input_transcript.delta", text, 500);
      if (delegate) send({ type: "session.delegation.created", offset_ms: clockMs, delegation: { id: id("del"), target: "client", type: "delegation" } });
    },
    start: () => received.find((event) => event.type === "session.start")?.session as Record<string, any>,
    commentary: () => received.filter((event) => event.type === "session.commentary.append") as Array<{ content: string; delegation_id: string | null }>,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
